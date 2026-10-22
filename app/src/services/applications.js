// Public team applications (Art. 14.1/14.2, design-formular-date.md §2). `create()` has no actor
// (public endpoint) - everything else is LEADERS only (reuses onboarding.start permission).
const { TEAM } = require("../domain/team");
const crypto = require("crypto");
const { ipKey } = require("../domain/ip");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan } = require("../domain/policy");
const profile = require("../domain/profile");
const membersSvc = require("./members");
const onboardingSvc = require("./onboarding");
const documentsSvc = require("./documents");
const regulament = require("./regulament");
const notifications = require("./notifications");
const audience = require("./audience");
const waGateway = require("./wa-gateway");

function hashIp(ip) {
  return crypto.createHash("sha256").update(ipKey(ip)).digest("hex");
}

function requireRaw(id) {
  const row = db.prepare("SELECT * FROM applications WHERE id = ?").get(id);
  if (!row) throw new DomainError("NOT_FOUND", "Cerere negăsită.");
  return row;
}

// Public: rate limiting + honeypot are handled in the route (shared shape with other public
// endpoints) - the validation and duplicate checks here never trust the client either way.
function create(input, ip) {
  const result = profile.validateProfile(input, { mode: "public" });
  if (!result.ok) throw new DomainError("INVALID", "Completează corect câmpurile marcate.", null, result.errors);
  const v = result.value;

  if (db.prepare("SELECT 1 FROM members WHERE phone = ?").get(v.phone)) {
    throw new DomainError("INVALID", "Ai deja un cont în platformă - intră cu numărul tău de telefon.", null, { phone: "Ai deja un cont - intră în platformă." });
  }
  if (db.prepare("SELECT 1 FROM applications WHERE phone = ? AND status = 'in_asteptare'").get(v.phone)) {
    throw new DomainError("INVALID", "Există deja o cerere în așteptare cu acest număr de telefon.", null, { phone: "Există deja o cerere în așteptare cu acest telefon." });
  }

  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO applications (full_name, first_name, last_name, phone, email, birthdate, class, school, department,
      guardian_name, guardian_relation, guardian_phone, guardian_email, motivation, source,
      gdpr_ack_at, guardian_ack_at, regulament_ack_at, regulament_version, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    v.full_name, v.first_name || null, v.last_name || null, v.phone, v.email, v.birthdate, v.class, v.school, v.department,
    v.guardian_name || null, v.guardian_relation || null, v.guardian_phone || null, v.guardian_email || null,
    v.motivation, v.source || null, now, v.is_minor ? now : null, now, regulament.version(), hashIp(ip)
  );

  for (const l of audience.activeLeaders()) {
    notifications.create(l.id, "application_new", "Cerere nouă de înscriere", `${v.full_name} a trimis o cerere de înscriere în echipă.`, "/echipa?tab=cereri");
  }

  return { id: info.lastInsertRowid };
}

function list(actor, status) {
  assertCan(actor, "onboarding.start");
  return status
    ? db.prepare("SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC").all(status)
    : db.prepare("SELECT * FROM applications ORDER BY created_at DESC").all();
}

function detail(actor, id) {
  assertCan(actor, "onboarding.start");
  return requireRaw(id);
}

function pendingCount(actor) {
  assertCan(actor, "onboarding.start");
  return db.prepare("SELECT COUNT(*) c FROM applications WHERE status = 'in_asteptare'").get().c;
}

// Accept: creates the member (+ guardian) with the submitted data, a temporary password, sends
// credentials over WhatsApp if the number resolves there, and starts the Art. 43.2 checklist
// WITHOUT the WhatsApp data-collection dialog (data already exists) - design-formular-date.md §2.
async function accept(actor, id, { buddy_id, note } = {}) {
  assertCan(actor, "onboarding.start");
  const app = requireRaw(id);
  if (app.status !== "in_asteptare") throw new DomainError("INVALID", "Cererea a fost deja procesată.");
  if (db.prepare("SELECT 1 FROM members WHERE phone = ?").get(app.phone)) {
    throw new DomainError("INVALID", "Există deja un membru cu acest telefon.");
  }

  // Applications stored before the name parts (migration 029) only have full_name.
  const names = app.first_name && app.last_name ? { first_name: app.first_name, last_name: app.last_name } : { name: app.full_name };
  const created = membersSvc.create(actor, {
    ...names, phone: app.phone, email: app.email, department: app.department,
    class: app.class, school: app.school, birthdate: app.birthdate, role: "volunteer",
  });
  const { password } = membersSvc.resetPassword(actor, created.id);
  if (app.guardian_name) {
    membersSvc.addGuardian(actor, created.id, { name: app.guardian_name, relation: app.guardian_relation, phone: app.guardian_phone, email: app.guardian_email });
  }

  db.prepare(`
    UPDATE applications SET status='acceptata', decided_by=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note=?, created_member_id=?
    WHERE id=?
  `).run(actor.id, note || null, created.id, id);

  // Art. 72.3: accepted on the application form (older applications have no box and still sign Anexa 6).
  if (app.regulament_ack_at) {
    documentsSvc.recordRegulamentAcceptance(created.id, { at: app.regulament_ack_at, version: app.regulament_version, guardian: !!app.guardian_ack_at });
  }

  const fresh = membersSvc.getRaw(created.id);
  const requiredDocs = documentsSvc.requiredFor(fresh);
  const docsList = requiredDocs.length ? requiredDocs.map((d) => `- ${d.title}`).join("\n") : "Niciun document necesar momentan.";
  const credMsg = [
    `Bine ai venit în echipa ${TEAM.name} #${TEAM.number}! 🎉 Cererea ta de înscriere a fost acceptată.`,
    `Username: ${fresh.username}`,
    `Parolă temporară: ${password} (ți se va cere s-o schimbi la prima autentificare)`,
    `Platformă: ${require("../domain/team").baseUrl()}`,
    "",
    "Documente de semnat:",
    docsList,
  ].join("\n");

  // Check the number is actually on WhatsApp before sending - if not, the leader gets the
  // credentials back in the response and has to deliver them another way (design §2).
  const reach = await waGateway.resolve(app.phone);
  let sentWhatsApp = false;
  if (reach.wid) sentWhatsApp = await waGateway.sendWhatsApp(app.phone, credMsg);

  onboardingSvc.startChecklistOnly(actor, created.id, { buddy_id });

  for (const head of audience.headsFor(fresh.department)) {
    notifications.create(head.id, "onboarding_completed", "Voluntar nou acceptat", `${fresh.full_name} a fost acceptat în echipă (Art. 43.1).`, `/membri/${fresh.id}`);
  }

  return { member: fresh, password, sent_whatsapp: sentWhatsApp, whatsapp_unavailable: !sentWhatsApp && !reach.notOnWhatsApp, credentials_message: credMsg };
}

function reject(actor, id, { note, notify } = {}) {
  assertCan(actor, "onboarding.start");
  const app = requireRaw(id);
  if (app.status !== "in_asteptare") throw new DomainError("INVALID", "Cererea a fost deja procesată.");
  db.prepare(`
    UPDATE applications SET status='respinsa', decided_by=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note=?
    WHERE id=?
  `).run(actor.id, note || null, id);
  if (notify) {
    waGateway.sendWhatsApp(app.phone, `Bună, ${app.full_name.split(" ")[0]}! Îți mulțumim pentru interesul arătat echipei ${TEAM.name}. Din păcate nu putem da curs cererii tale în acest moment.${note ? ` ${note}` : ""}`);
  }
  return requireRaw(id);
}

module.exports = { create, list, detail, pendingCount, accept, reject };
