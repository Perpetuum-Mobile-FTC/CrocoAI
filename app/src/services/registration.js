// Self-registration (docs/design-inregistrare.md), confirmed with a WhatsApp code since security
// package A3 (docs/design-securitate-2026-10.md): start() validates and stores a pending registration +
// sends a 6-digit code, verify() creates the account. No actor (public endpoints); leadership roles are
// only requested here and confirmed by members.manage holders.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, ROLES, PRIVILEGED_ROLES } = require("../domain/policy");
const profile = require("../domain/profile");
const onboardingSvc = require("./onboarding");
const notifications = require("./notifications");
const audience = require("./audience");
const assignmentsSvc = require("./assignments");
const waGateway = require("./wa-gateway");
const { ipKey } = require("../domain/ip");
const rules = require("../domain/rules");
const documentsSvc = require("./documents");
const regulament = require("./regulament");

function hashIp(ip) {
  return crypto.createHash("sha256").update(ipKey(ip)).digest("hex"); // IPv6 grouped by /64
}

function roleLabel(role) {
  return ROLES[role] ? ROLES[role].label : role;
}

// Form validation + uniqueness (step 1, and again at step 2 in case someone took the data meanwhile).
function validateNew(input) {
  const result = profile.validateProfile(input, { mode: "register" });
  const errors = { ...result.errors };
  const v = result.value;
  checkUnique(v, errors);
  return { v, errors };
}

function checkUnique(v, errors) {
  if (v.username && db.prepare("SELECT 1 FROM members WHERE LOWER(username) = ?").get(v.username)) {
    errors.username = "Username-ul e deja folosit, alege altul.";
  }
  if (v.phone && db.prepare("SELECT 1 FROM members WHERE phone = ?").get(v.phone)) {
    errors.phone = "Există deja un cont cu acest telefon - intră în platformă.";
  }
  if (v.email && db.prepare("SELECT 1 FROM members WHERE LOWER(email) = LOWER(?)").get(v.email)) {
    errors.email = "Există deja un cont cu această adresă de email.";
  }
}

const FORM_ERROR = "Completează corect câmpurile marcate.";
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const codeHash = (pendingId, code) => crypto.createHash("sha256").update(`${pendingId}:${code}`).digest("hex");
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");

function cleanupExpired(nowMs) {
  db.prepare("DELETE FROM pending_registrations WHERE expires_at <= ?").run(iso(nowMs));
  db.prepare("DELETE FROM otp_sends WHERE sent_at <= ?").run(iso(nowMs - 24 * 60 * MIN));
}

// Limits (rules.js): per phone / hour and / day, per IP / hour, all codes / hour. Every check is followed,
// in the same synchronous block (no await in between), by the otp_sends reservation - so parallel requests
// can't all pass the check before any of them is recorded. A failed send deletes its reservation.
function assertSendLimits(phone, ipHash, nowMs) {
  const hour = iso(nowMs - 60 * MIN);
  const count = (where, ...args) => db.prepare(`SELECT COUNT(*) c FROM otp_sends WHERE ${where}`).get(...args).c;
  if (count("phone = ? AND sent_at > ?", phone, hour) >= rules.OTP_MAX_PER_PHONE_HOUR ||
      count("phone = ? AND sent_at > ?", phone, iso(nowMs - 24 * 60 * MIN)) >= rules.OTP_MAX_PER_PHONE_DAY ||
      count("ip_hash = ? AND sent_at > ?", ipHash, hour) >= rules.otpMaxPerIpHour()) {
    throw new DomainError("LIMIT", "Prea multe coduri cerute. Încearcă din nou mai târziu sau scrie-i unui lider.");
  }
  if (count("sent_at > ?", hour) >= rules.otpMaxGlobalHour()) {
    alertGlobalCap(nowMs);
    throw new DomainError("LIMIT", "Prea multe înregistrări în acest moment. Încearcă din nou peste o oră sau scrie-i unui lider.");
  }
}

// The global cap blocks every new registration: tell the active Team Leader, once per hour (in-app + WhatsApp
// to a verified phone), so a recruitment day isn't silently stuck.
function alertGlobalCap(nowMs) {
  if (db.prepare("SELECT 1 FROM notifications WHERE type = 'otp_global_cap' AND created_at > ?").get(iso(nowMs - 60 * MIN))) return;
  const { whatsappPhone } = require("./members");
  const title = "Înregistrări blocate temporar";
  const body = `S-a atins limita de ${rules.otpMaxGlobalHour()} coduri de înregistrare pe oră, așa că înscrierile noi sunt oprite până la ora ` +
    "următoare. Dacă e o zi de recrutare, ridică OTP_MAX_GLOBAL_HOUR în app/.env (apoi repornește containerul) sau creează conturile manual din Admin → Membri.";
  for (const m of audience.membersWhoCan("registration.limit_alert")) {
    notifications.create(m.id, "otp_global_cap", title, body, "/admin");
    const phone = whatsappPhone(m);
    if (phone) waGateway.sendWhatsApp(phone, `⚠️ ${title}: ${body}`).catch(() => {});
  }
}
const reserveSend = (phone, ipHash, nowMs) =>
  db.prepare("INSERT INTO otp_sends (phone, ip_hash, sent_at) VALUES (?, ?, ?)").run(phone, ipHash, iso(nowMs)).lastInsertRowid;
const releaseSend = (sendId) => db.prepare("DELETE FROM otp_sends WHERE id = ?").run(sendId);

// Sends the code immediately (gateway, not the paced queue).
function sendCode(phone, code) {
  return waGateway.sendWhatsApp(phone, `Codul tău CrocoAI: ${code} (valabil ${rules.OTP_CODE_TTL_MIN} minute)`);
}

const WA_CHECK_UNAVAILABLE = "Verificarea prin WhatsApp nu este disponibilă acum. Încearcă din nou mai târziu sau scrie-i unui lider.";
const SEND_FAILED = "Nu am putut trimite codul pe WhatsApp. Încearcă din nou în câteva minute.";

// Step 1: validate, check limits + that the number is on WhatsApp, store the pending registration
// (validated data, password hash, code hash) and send the code. No account yet.
async function start(input, ip, now = new Date()) {
  const nowMs = now.getTime();
  const { v, errors } = validateNew(input);
  if (Object.keys(errors).length) throw new DomainError("INVALID", FORM_ERROR, null, errors);
  cleanupExpired(nowMs);
  const ipHash = hashIp(ip);
  const ownPendingId = typeof (input || {}).pending_id === "string" ? input.pending_id : null;

  // Synchronous from here to the reservation (no await): check, then write the pending row + the send.
  // One pending registration per phone; only its owner (who holds pending_id) may replace it before it
  // expires - a third party can't wipe someone's registration in progress.
  const existing = db.prepare("SELECT id FROM pending_registrations WHERE phone = ?").get(v.phone);
  if (existing && existing.id !== ownPendingId) {
    throw new DomainError("CONFLICT", `Există deja o înregistrare în curs pentru acest număr. Dacă ai închis pagina, încearcă din nou peste ${rules.PENDING_REGISTRATION_TTL_MIN} de minute sau scrie-i unui lider.`);
  }
  assertSendLimits(v.phone, ipHash, nowMs);
  const id = crypto.randomBytes(24).toString("hex");
  const code = newCode();
  const { password, ...data } = v;
  const hash = bcrypt.hashSync(password, 10);
  const sendId = db.transaction(() => {
    if (ownPendingId) db.prepare("DELETE FROM pending_registrations WHERE id = ?").run(ownPendingId);
    db.prepare(`
      INSERT INTO pending_registrations (id, phone, data, password_hash, code_hash, code_expires_at, attempts, last_sent_at, expires_at, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, v.phone, JSON.stringify(data), hash, codeHash(id, code),
      iso(nowMs + rules.OTP_CODE_TTL_MIN * MIN), iso(nowMs), iso(nowMs + rules.PENDING_REGISTRATION_TTL_MIN * MIN), ipHash);
    return reserveSend(v.phone, ipHash, nowMs);
  })();
  const undo = () => { db.prepare("DELETE FROM pending_registrations WHERE id = ?").run(id); releaseSend(sendId); };

  // Gateway down = not the user's fault: a different message, and undo() gives the send quota back.
  const reach = await waGateway.resolve(v.phone);
  if (reach.unavailable) {
    undo();
    throw new DomainError("UNAVAILABLE", WA_CHECK_UNAVAILABLE);
  }
  if (!reach.wid) {
    undo();
    const msg = "Numărul nu are WhatsApp — scrie-i unui lider.";
    throw new DomainError("INVALID", msg, null, { phone: msg });
  }
  if (!(await sendCode(v.phone, code))) {
    undo();
    throw new DomainError("UNAVAILABLE", SEND_FAILED);
  }
  return { pending_id: id, phone_hint: `…${v.phone.slice(-3)}`, resend_after_sec: rules.OTP_RESEND_AFTER_SEC, code_ttl_min: rules.OTP_CODE_TTL_MIN };
}

function requirePending(id, nowMs) {
  const row = typeof id === "string" && id ? db.prepare("SELECT * FROM pending_registrations WHERE id = ?").get(id) : null;
  if (!row || Date.parse(row.expires_at) <= nowMs) {
    throw new DomainError("NOT_FOUND", "Înregistrarea a expirat sau nu există — completează formularul din nou.");
  }
  return row;
}

// New code (the old one stops working), attempts reset. Only after 60 s, within the same limits.
async function resend(pendingId, ip, now = new Date()) {
  const nowMs = now.getTime();
  const row = requirePending(pendingId, nowMs);
  const wait = Math.ceil((Date.parse(row.last_sent_at) + rules.OTP_RESEND_AFTER_SEC * 1000 - nowMs) / 1000);
  if (wait > 0) throw new DomainError("LIMIT", `Poți cere un cod nou peste ${wait} secunde.`);
  const ipHash = hashIp(ip);
  assertSendLimits(row.phone, ipHash, nowMs);
  // Same synchronous check-then-reserve: the new last_sent_at blocks parallel resends at once.
  const code = newCode();
  const update = db.prepare("UPDATE pending_registrations SET code_hash = ?, code_expires_at = ?, attempts = ?, last_sent_at = ? WHERE id = ?");
  const sendId = db.transaction(() => {
    update.run(codeHash(row.id, code), iso(nowMs + rules.OTP_CODE_TTL_MIN * MIN), 0, iso(nowMs), row.id);
    return reserveSend(row.phone, ipHash, nowMs);
  })();
  if (!(await sendCode(row.phone, code))) {
    update.run(row.code_hash, row.code_expires_at, row.attempts, row.last_sent_at, row.id); // old code stays valid
    releaseSend(sendId);
    throw new DomainError("UNAVAILABLE", SEND_FAILED);
  }
  return { ok: true, resend_after_sec: rules.OTP_RESEND_AFTER_SEC };
}

// Step 2: the right code creates the account exactly as the direct registration did (active, role
// requests, onboarding, audit row) with the phone marked verified. Max 5 attempts per code.
function verify(pendingId, code, ip, now = new Date()) {
  const nowMs = now.getTime();
  const row = requirePending(pendingId, nowMs);
  if (row.attempts >= rules.OTP_MAX_ATTEMPTS) throw new DomainError("LIMIT", "Prea multe încercări greșite. Cere un cod nou.");
  if (Date.parse(row.code_expires_at) <= nowMs) throw new DomainError("INVALID", "Codul a expirat. Cere un cod nou.");
  const given = Buffer.from(codeHash(row.id, String(code || "").trim()), "hex");
  if (!crypto.timingSafeEqual(given, Buffer.from(row.code_hash, "hex"))) {
    const attempts = row.attempts + 1;
    db.prepare("UPDATE pending_registrations SET attempts = ? WHERE id = ?").run(attempts, row.id);
    const left = rules.OTP_MAX_ATTEMPTS - attempts;
    throw new DomainError("INVALID", left > 0 ? `Cod greșit. Mai ai ${left} ${left === 1 ? "încercare" : "încercări"}.` : "Cod greșit. Cere un cod nou.");
  }
  const v = JSON.parse(row.data);
  const errors = {};
  checkUnique(v, errors);
  if (Object.keys(errors).length) {
    db.prepare("DELETE FROM pending_registrations WHERE id = ?").run(row.id);
    throw new DomainError("INVALID", "Între timp, unele date au fost folosite de alt cont. Completează formularul din nou.", null, errors);
  }
  const member = createMember(v, row.password_hash, ip, iso(nowMs));
  db.prepare("DELETE FROM pending_registrations WHERE id = ?").run(row.id);
  return member;
}

function createMember(v, hash, ip, verifiedAt) {
  const now = new Date().toISOString();

  const memberId = db.transaction(() => {
    const id = db.prepare(`
      INSERT INTO members (full_name, first_name, last_name, username, phone, email, department, class, school, birthdate, role, auth_role,
        requested_role, status, must_change_password, password_hash, joined_at, phone_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activ', 0, ?, ?, ?)
    `).run(v.full_name, v.first_name || null, v.last_name || null, v.username, v.phone, v.email, v.department, v.class || null, v.school || null, v.birthdate || null,
      v.role, v.role, v.requested_role, hash, now, verifiedAt).lastInsertRowid;

    if (v.guardian_name) {
      db.prepare("INSERT INTO guardians (member_id, name, relation, phone, email) VALUES (?, ?, ?, ?, ?)")
        .run(id, v.guardian_name, v.guardian_relation, v.guardian_phone, v.guardian_email || null);
    }

    // Audit trail (consents + hashed IP). applications has NOT NULL columns from the old flow,
    // so fields that don't apply (mentors) are stored as ''.
    db.prepare(`
      INSERT INTO applications (full_name, first_name, last_name, phone, email, birthdate, class, school, department,
        guardian_name, guardian_relation, guardian_phone, guardian_email, motivation,
        gdpr_ack_at, guardian_ack_at, regulament_ack_at, regulament_version, status, created_member_id, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inregistrat', ?, ?)
    `).run(v.full_name, v.first_name || null, v.last_name || null, v.phone, v.email, v.birthdate || "", v.class || "", v.school || "", v.department,
      v.guardian_name || null, v.guardian_relation || null, v.guardian_phone || null, v.guardian_email || null,
      v.motivation || "", now, v.is_minor ? now : null, v.regulament_ack ? now : null, v.regulament_ack ? regulament.version() : null, id, hashIp(ip));
    // A registration started before Art. 72.3 (no box in its stored data) still signs Anexa 6.
    if (v.regulament_ack) documentsSvc.recordRegulamentAcceptance(id, { at: now, version: regulament.version(), guardian: v.is_minor });
    return id;
  })();

  const member = db.prepare("SELECT * FROM members WHERE id = ?").get(memberId);
  afterRegister(member);
  try { assignmentsSvc.addMemberToOpenAssignments(member.id); } catch (e) { console.error(`[REGISTER] assignments: ${e.message}`); }
  return member;
}

// Notifications + onboarding never block the registration itself.
function afterRegister(member) {
  try {
    if (member.requested_role) {
      for (const l of audience.activeLeaders()) {
        notifications.create(l.id, "role_request", "Cerere de rol", `${member.full_name} cere rolul ${roleLabel(member.requested_role)}.`, "/admin?tab=cereri-rol");
      }
    }
    if (member.role === "volunteer") {
      const starter = audience.activeTeamLeaders()[0];
      if (starter) onboardingSvc.startChecklistOnly(starter, member.id);
      for (const h of audience.headsFor(member.department)) {
        notifications.create(h.id, "onboarding_completed", "Voluntar nou înregistrat", `${member.full_name} s-a înregistrat în echipă (Art. 43.1).`, `/membri/${member.id}`);
      }
    }
  } catch (e) {
    console.error("[registration] post-register step failed:", e.message);
  }
}

function listRoleRequests(actor) {
  assertCan(actor, "members.manage");
  return db.prepare(`
    SELECT id, full_name AS name, role, requested_role, department, joined_at
    FROM members WHERE requested_role IS NOT NULL AND status = 'activ' ORDER BY joined_at
  `).all().map((r) => ({ ...r, role_label: roleLabel(r.role), requested_role_label: roleLabel(r.requested_role) }));
}

function decideRoleRequest(actor, memberId, approve) {
  assertCan(actor, "members.manage");
  const m = db.prepare("SELECT * FROM members WHERE id = ?").get(memberId);
  if (!m) throw new DomainError("NOT_FOUND", "Membru negăsit.");
  if (m.status !== "activ") throw new DomainError("INVALID", "Membrul nu mai este activ.");
  if (!m.requested_role) throw new DomainError("INVALID", "Nu există o cerere de rol pentru acest membru.");
  if (PRIVILEGED_ROLES.includes(m.requested_role)) {
    assertCan(actor, "members.manage_privileged", null, "Doar Team Leader-ul decide cererile pentru rolurile Team Leader, Co-Leader și Mentor.");
  }
  if (approve) {
    db.prepare("UPDATE members SET role = ?, auth_role = ?, requested_role = NULL WHERE id = ?").run(m.requested_role, m.requested_role, m.id);
    notifications.create(m.id, "role_decision", "Rol confirmat", `Rolul tău este acum: ${roleLabel(m.requested_role)}.`, "/");
  } else {
    db.prepare("UPDATE members SET requested_role = NULL WHERE id = ?").run(m.id);
    notifications.create(m.id, "role_decision", "Cerere de rol respinsă", `Cererea pentru rolul ${roleLabel(m.requested_role)} nu a fost aprobată; rămâi Membru.`, "/");
    // Stays a plain member: now eligible for the open department-wide assignments.
    try { assignmentsSvc.addMemberToOpenAssignments(m.id); } catch (e) { console.error(`[REGISTER] assignments: ${e.message}`); }
  }
  return db.prepare("SELECT id, full_name AS name, role, requested_role FROM members WHERE id = ?").get(m.id);
}

// Called by the reminder scheduler tick too, so expired pending data (minors' details) doesn't linger.
function cleanup(now = new Date()) { cleanupExpired(now.getTime()); }

module.exports = { start, resend, verify, cleanup, listRoleRequests, decideRoleRequest };
