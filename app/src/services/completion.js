// Profile-completion links for existing members (design-formular-date.md §3). The token itself
// is the only credential - a valid token is enough for GET/POST, no login cookie required.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan } = require("../domain/policy");
const profile = require("../domain/profile");
const nameDomain = require("../domain/name");
const membersSvc = require("./members");
const documentsSvc = require("./documents");
const regulament = require("./regulament");
const { randomPassword } = require("./username");
const waGateway = require("./wa-gateway");
const waQueue = require("./wa-queue");

const TOKEN_TTL_DAYS = 14;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function baseUrl() {
  return require("../domain/team").baseUrl();
}

// LEADERS: one link for one member - used (link rendered, usable until then) or expired after 14 days.
function createLink(actor, memberId) {
  assertCan(actor, "onboarding.start");
  const member = membersSvc.requireRaw(memberId);
  membersSvc.assertCanEditAccount(actor, member); // the public form can change the phone (A6)
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO completion_tokens (member_id, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?)")
    .run(memberId, hashToken(token), actor.id, expiresAt);
  return { url: `${baseUrl()}/completare/${token}`, member, has_phone: membersSvc.hasPhone(member) };
}

// LEADERS: "trimite link de completare, toți cu date lipsă" - queued with >= 20s spacing
// (design §3, shared WhatsApp number). Members with no phone get the link back so a leader can
// send it manually.
function createBulkLinks(actor, memberIds) {
  assertCan(actor, "onboarding.start");
  if (!Array.isArray(memberIds) || !memberIds.length) throw new DomainError("INVALID", "Nicio țintă selectată.");
  return memberIds.map((id) => {
    let link;
    try { link = createLink(actor, id); } catch (err) {
      if (err instanceof DomainError && err.code === "FORBIDDEN") return { member_id: id, queued: false, error: err.message };
      throw err;
    }
    const { url, member, has_phone } = link;
    if (has_phone) {
      waQueue.enqueue(member.phone, `Salut ${member.full_name.split(" ")[0]}! Te rugăm să completezi/confirmi datele tale în platforma CrocoAI, aici: ${url} (link valabil 14 zile).`);
      return { member_id: id, name: member.full_name, queued: true };
    }
    return { member_id: id, name: member.full_name, queued: false, url };
  });
}

function findValidByToken(token) {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM completion_tokens WHERE token_hash = ?").get(hashToken(token));
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

// Public (token = auth). Never reveals more than the prefilled form needs.
function getByToken(token) {
  const row = findValidByToken(token);
  if (!row) throw new DomainError("NOT_FOUND", "Link invalid sau expirat.");
  const member = membersSvc.getRaw(row.member_id);
  if (!member) throw new DomainError("NOT_FOUND", "Link invalid sau expirat.");
  const guardian = db.prepare("SELECT * FROM guardians WHERE member_id = ? ORDER BY id LIMIT 1").get(member.id);
  const parts = member.first_name && member.last_name
    ? { first_name: member.first_name, last_name: member.last_name }
    : nameDomain.splitForPrefill(member.full_name); // a guess the member checks on the form, never stored as such
  return {
    full_name: member.full_name,
    ...parts,
    phone: membersSvc.hasPhone(member) ? member.phone : "",
    email: member.email,
    birthdate: member.birthdate,
    class: member.class,
    school: member.school,
    department: member.department,
    guardian: guardian || null,
  };
}

// Public: updates the member's profile (+ guardian) via the same validation as everywhere else.
// Credentials (new temp password) are only (re)sent if the member never logged in - otherwise
// nothing about their password changes.
async function submit(token, input) {
  const row = findValidByToken(token);
  if (!row) throw new DomainError("NOT_FOUND", "Link invalid sau expirat.");
  const member = membersSvc.getRaw(row.member_id);
  if (!member) throw new DomainError("NOT_FOUND", "Link invalid sau expirat.");

  const result = profile.validateProfile(input, { mode: "completion" });
  if (!result.ok) throw new DomainError("INVALID", "Completează corect câmpurile marcate.", null, result.errors);
  const v = result.value;

  const other = db.prepare("SELECT id FROM members WHERE phone = ? AND id != ?").get(v.phone, member.id);
  if (other) throw new DomainError("INVALID", "Alt membru folosește deja acest telefon.", null, { phone: "Alt membru folosește deja acest telefon." });

  // Parts from the form; an old cached page sends only full_name (capitalization only, parts kept if same name).
  const names = v.first_name ? v : nameDomain.legacyNameColumns(v.full_name, member);
  // A3: a phone typed on a public link is not verified - WhatsApp reminders stop until a leader sets it.
  db.prepare(`
    UPDATE members SET full_name=?, first_name=?, last_name=?, phone=?, email=?, birthdate=?, class=?, school=?, department=?,
      phone_verified_at = CASE WHEN phone = ? THEN phone_verified_at END
    WHERE id=?
  `).run(names.full_name, names.first_name, names.last_name, v.phone, v.email, v.birthdate, v.class, v.school, v.department, v.phone, member.id);

  const selfActor = { id: member.id, role: member.role };
  if (v.is_minor) {
    const existing = db.prepare("SELECT id FROM guardians WHERE member_id = ? ORDER BY id LIMIT 1").get(member.id);
    const gdata = { name: v.guardian_name, relation: v.guardian_relation, phone: v.guardian_phone, email: v.guardian_email };
    if (existing) membersSvc.updateGuardian(selfActor, existing.id, gdata);
    else membersSvc.addGuardian(selfActor, member.id, gdata);
  }

  documentsSvc.recordRegulamentAcceptance(member.id, { at: new Date().toISOString(), version: regulament.version(), guardian: v.is_minor });

  db.prepare("UPDATE completion_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.id);

  let credentialsSent = false;
  let password = null;
  if (member.must_change_password && !member.last_login) {
    password = randomPassword();
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("UPDATE members SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(hash, member.id);
    membersSvc.bumpTokenVersion(member.id);
    credentialsSent = true;
  }

  const fresh = membersSvc.getRaw(member.id);
  if (credentialsSent && membersSvc.hasPhone(fresh)) {
    const text = [
      "Datele tale au fost actualizate.",
      `Username: ${fresh.username}`,
      `Parolă temporară: ${password} (ți se va cere s-o schimbi la prima autentificare)`,
      `Platformă: ${baseUrl()}`,
    ].join("\n");
    await waGateway.sendWhatsApp(fresh.phone, text);
  }

  return { ok: true, credentials_sent: credentialsSent, username: credentialsSent ? fresh.username : undefined, password: credentialsSent ? password : undefined };
}

module.exports = { createLink, createBulkLinks, getByToken, submit };
