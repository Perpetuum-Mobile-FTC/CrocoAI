// Persistent access log for sensitive personal data (cleanup F1, GDPR). Today: medical sheets opened by someone
// other than their owner (Art. 41.4). Content-free; listed only for the Team Leader (Art. 41.2, audit_log.view).
const db = require("../db");
const { assertCan } = require("../domain/policy");

// `detail`: short content-free note (e.g. "count=2").
function record({ actor, action, member_id, object_type, object_id, detail }) {
  db.prepare("INSERT INTO audit_log (actor_id, actor_role, action, member_id, object_type, object_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(actor ? actor.id : null, actor ? actor.role : null, action, member_id || null, object_type || null, object_id || null, detail || null);
}

// Newest first, with names resolved for display.
function list(actor, { limit } = {}) {
  assertCan(actor, "audit_log.view", null, "Doar Team Leader-ul vede jurnalul de acces la date (Art. 41.2).");
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  return db.prepare(`
    SELECT l.*, a.full_name AS actor_name, m.full_name AS member_name
    FROM audit_log l LEFT JOIN members a ON a.id = l.actor_id LEFT JOIN members m ON m.id = l.member_id
    ORDER BY l.id DESC LIMIT ?
  `).all(n);
}

module.exports = { record, list };
