// Anunțuri (docs/design-pachet-b.md B1/B2, Art. 23.1): replaces the old chat "Anunțuri" channel.
// Who publishes / who sees: policy.js (announcements.*). Publishing notifies every recipient in the platform
// and, only for the whole team and only when asked, posts once on the team's WhatsApp group (TEAM_GROUP_ID).
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");
const notifications = require("./notifications");
const waGateway = require("./wa-gateway"); // namespace import so tests can mock sendWhatsApp

const AUDIENCES = { echipa: "Toată echipa", tehnic: "Departamentul tehnic", "non-tehnic": "Departamentul non-tehnic" };
const TITLE_MAX = 200;
const BODY_MAX = 4000;
const LINK = "/anunturi";

function decorate(row) {
  const author = row.author_id ? db.prepare("SELECT full_name FROM members WHERE id = ?").get(row.author_id) : null;
  return { ...row, audience_label: AUDIENCES[row.audience] || row.audience, author_name: author ? author.full_name : "CrocoAI" };
}

// Every account (active or paused) that may see the announcement (the author excluded by the caller if needed).
function recipientIds(a) {
  return db.prepare("SELECT * FROM members WHERE status IN ('activ', 'pauza')").all().filter((m) => can(m, "announcements.view", a)).map((m) => m.id);
}

function whatsappText(a) {
  return `📢 ${a.title}${a.body ? `\n${a.body}` : ""}`;
}

async function sendToTeamGroup(id) {
  const a = db.prepare("SELECT * FROM announcements WHERE id = ?").get(id);
  if (!process.env.TEAM_GROUP_ID) return false;
  const ok = await waGateway.sendWhatsApp(process.env.TEAM_GROUP_ID, whatsappText(a));
  if (ok) db.prepare("UPDATE announcements SET sent_whatsapp_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
  return !!ok;
}

function insert(authorId, { title, body, audience }) {
  const info = db.prepare("INSERT INTO announcements (title, body, audience, author_id) VALUES (?, ?, ?, ?)").run(title, body, audience, authorId);
  const a = db.prepare("SELECT * FROM announcements WHERE id = ?").get(info.lastInsertRowid);
  for (const id of recipientIds(a)) {
    if (id !== authorId) notifications.create(id, "announcement", `Anunț: ${title}`, body ? body.slice(0, 300) : null, LINK);
  }
  return a;
}

// data: { title, body, audience = "echipa", send_whatsapp }. Returns the announcement + { whatsapp: "sent"|"failed"|"not_configured"|null }.
async function publish(actor, data) {
  const d = data || {};
  const audience = d.audience || "echipa";
  if (!AUDIENCES[audience]) throw new DomainError("INVALID", "Destinatari invalizi (echipa, tehnic sau non-tehnic).");
  assertCan(actor, "announcements.publish", { audience }, "Poți publica anunțuri doar pentru departamentul tău (Art. 23.1).");
  const title = String(d.title || "").trim();
  const body = String(d.body || "").trim();
  if (!title) throw new DomainError("INVALID", "Titlul anunțului e obligatoriu.");
  if (title.length > TITLE_MAX) throw new DomainError("INVALID", `Titlul are maximum ${TITLE_MAX} de caractere.`);
  if (body.length > BODY_MAX) throw new DomainError("INVALID", `Textul are maximum ${BODY_MAX} de caractere.`);
  const sendWhatsApp = d.send_whatsapp === true; // strictly the checkbox, never a truthy string
  if (sendWhatsApp && audience !== "echipa") throw new DomainError("INVALID", "Pe grupul de WhatsApp se trimit doar anunțurile pentru toată echipa.");

  const a = db.transaction(() => insert(actor.id, { title, body, audience }))();
  let whatsapp = null;
  if (sendWhatsApp) {
    if (!process.env.TEAM_GROUP_ID) whatsapp = "not_configured";
    else whatsapp = (await sendToTeamGroup(a.id)) ? "sent" : "failed";
  }
  return { ...get(actor, a.id), whatsapp };
}

// Automated announcement for the whole team (FTC manual update). No permission check (system, not a person);
// WhatsApp delivery stays with the caller (ftc-manual-updater has its own fallback to the Team Leader).
function publishSystem(title, body) {
  const t = String(title || "").trim().slice(0, TITLE_MAX);
  if (!t) return null;
  return db.transaction(() => insert(null, { title: t, body: String(body || "").trim().slice(0, BODY_MAX), audience: "echipa" }))();
}

function get(actor, id) {
  const a = db.prepare("SELECT * FROM announcements WHERE id = ?").get(id);
  if (!a || !can(actor, "announcements.view", a)) throw new DomainError("NOT_FOUND", "Anunț negăsit.");
  return { ...decorate(a), can_delete: can(actor, "announcements.delete", a) };
}

// Newest first, only what the actor may see.
function list(actor, { limit = 50 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const out = [];
  for (const a of db.prepare("SELECT * FROM announcements ORDER BY created_at DESC, id DESC").all()) {
    if (!can(actor, "announcements.view", a)) continue;
    out.push({ ...decorate(a), can_delete: can(actor, "announcements.delete", a) });
    if (out.length >= n) break;
  }
  return out;
}

function remove(actor, id) {
  const a = db.prepare("SELECT * FROM announcements WHERE id = ?").get(id);
  if (!a || !can(actor, "announcements.view", a)) throw new DomainError("NOT_FOUND", "Anunț negăsit.");
  assertCan(actor, "announcements.delete", a, "Doar autorul sau Team Leader-ul / Co-Leader-ul pot șterge anunțul.");
  db.prepare("DELETE FROM announcements WHERE id = ?").run(id);
  return { ok: true };
}

// The audiences the actor may publish to (form options).
function allowedAudiences(actor) {
  return Object.keys(AUDIENCES).filter((audience) => can(actor, "announcements.publish", { audience }))
    .map((key) => ({ key, label: AUDIENCES[key] }));
}

module.exports = { AUDIENCES, publish, publishSystem, list, get, remove, allowedAudiences, recipientIds };
