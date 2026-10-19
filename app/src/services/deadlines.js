// Termene (docs/design-pachet-b.md B1): team deadlines with a countdown on Acasă. Managed in Admin → Termene
// by deadlines.manage (policy.js). A deadline has a date (Europe/Bucharest calendar day) or, while the date is
// not announced yet, a free text ("ianuarie–februarie 2027"). Past dates disappear from the list.
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");
const time = require("../domain/time");

const TITLE_MAX = 200;

function todayLocal(nowMs = Date.now()) {
  return time.utcToBucharest(nowMs).date;
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

// "Mai sunt N zile" / "Mai este o zi" / "azi" / "dată neanunțată" - the same text everywhere (Acasă, Admin).
function countdownLabel(daysLeft) {
  if (daysLeft == null) return "dată neanunțată";
  if (daysLeft === 0) return "azi";
  if (daysLeft === 1) return "Mai este o zi";
  return `Mai sunt ${daysLeft} zile`;
}

function decorate(row, today) {
  const days_left = row.date ? daysBetween(today, row.date) : null;
  return { ...row, days_left, countdown: countdownLabel(days_left) };
}

// Upcoming deadlines (today included), dated ones first by date, then the not-yet-announced ones.
function list(actor, { nowMs = Date.now(), all = false } = {}) {
  if (!actor) throw new DomainError("FORBIDDEN", "Neautentificat.");
  const today = todayLocal(nowMs);
  const rows = db.prepare("SELECT * FROM deadlines ORDER BY date IS NULL, date, id").all()
    .filter((d) => all || !d.date || d.date >= today);
  return rows.map((d) => ({ ...decorate(d, today), can_manage: can(actor, "deadlines.manage") }));
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

function validate(data, current) {
  const title = String(data.title !== undefined ? data.title : (current && current.title) || "").trim();
  if (!title) throw new DomainError("INVALID", "Titlul termenului e obligatoriu.");
  if (title.length > TITLE_MAX) throw new DomainError("INVALID", `Titlul are maximum ${TITLE_MAX} de caractere.`);
  const rawDate = data.date !== undefined ? data.date : current && current.date;
  const date = rawDate ? String(rawDate).trim() : null;
  if (date && !validDate(date)) throw new DomainError("INVALID", "Data invalidă (AAAA-LL-ZZ).");
  const rawText = data.date_text !== undefined ? data.date_text : current && current.date_text;
  const dateText = date ? null : (rawText ? String(rawText).trim().slice(0, 100) : null);
  return { title, date, date_text: dateText };
}

function create(actor, data) {
  assertCan(actor, "deadlines.manage", null, "Doar Team Leader-ul, Co-Leader-ul și șefii de departament gestionează termenele.");
  const d = validate(data || {}, null);
  const info = db.prepare("INSERT INTO deadlines (title, date, date_text, created_by) VALUES (?, ?, ?, ?)").run(d.title, d.date, d.date_text, actor.id);
  return decorate(db.prepare("SELECT * FROM deadlines WHERE id = ?").get(info.lastInsertRowid), todayLocal());
}

function update(actor, id, data) {
  assertCan(actor, "deadlines.manage", null, "Doar Team Leader-ul, Co-Leader-ul și șefii de departament gestionează termenele.");
  const cur = db.prepare("SELECT * FROM deadlines WHERE id = ?").get(id);
  if (!cur) throw new DomainError("NOT_FOUND", "Termen negăsit.");
  const d = validate(data || {}, cur);
  db.prepare("UPDATE deadlines SET title = ?, date = ?, date_text = ? WHERE id = ?").run(d.title, d.date, d.date_text, id);
  return decorate(db.prepare("SELECT * FROM deadlines WHERE id = ?").get(id), todayLocal());
}

function remove(actor, id) {
  assertCan(actor, "deadlines.manage", null, "Doar Team Leader-ul, Co-Leader-ul și șefii de departament gestionează termenele.");
  const info = db.prepare("DELETE FROM deadlines WHERE id = ?").run(id);
  if (!info.changes) throw new DomainError("NOT_FOUND", "Termen negăsit.");
  return { ok: true };
}

module.exports = { list, create, update, remove, countdownLabel };
