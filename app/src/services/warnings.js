// Warnings / sanctions (Art. 29-30). Recorded by LEADERS (TL + Co-Leader decide per Art. 30.1),
// never automatic - rules.js only produces *signals* that a human then acts on here.
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan } = require("../domain/policy");

const LEVELS = ["verbal", "scris", "suspendare", "excludere"];

function record(actor, data) {
  assertCan(actor, "warnings.record");
  const { member_id, level, reason, article } = data || {};
  if (!member_id) throw new DomainError("INVALID", "member_id este obligatoriu.");
  if (!LEVELS.includes(level)) throw new DomainError("INVALID", "Nivel de sancțiune invalid.");
  const info = db.prepare(`
    INSERT INTO warnings (member_id, level, article, reason, recorded_by) VALUES (?, ?, ?, ?, ?)
  `).run(member_id, level, article || "Art. 30.1", reason || null, actor.id);
  db.prepare("INSERT INTO notifications (member_id, type, title, body, link) VALUES (?, 'warning', ?, ?, ?)")
    .run(member_id, "Sancțiune înregistrată", reason || null, `/membri/${member_id}`);
  return db.prepare("SELECT * FROM warnings WHERE id = ?").get(info.lastInsertRowid);
}

function listFor(actor, memberId) {
  const member = db.prepare("SELECT id FROM members WHERE id = ?").get(memberId);
  if (!member) throw new DomainError("NOT_FOUND", "Membru negăsit.");
  assertCan(actor, "warnings.view", { member_id: memberId });
  return db.prepare("SELECT * FROM warnings WHERE member_id = ? ORDER BY created_at DESC").all(memberId);
}

module.exports = { LEVELS, record, listFor };
