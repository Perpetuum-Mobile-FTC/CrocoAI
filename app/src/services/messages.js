// WhatsApp message log: LEADERS only, and only tracked groups + DMs are ever logged
// (see wa-ingress route, which calls wa-groups.isTracked before inserting). Audit B-HIGH-1.
const db = require("../db");
const { assertCan } = require("../domain/policy");

function list(actor, { limit = 100, chat_id } = {}) {
  assertCan(actor, "messages.view");
  const cap = Math.min(parseInt(limit) || 100, 2000);
  if (chat_id) {
    return db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?").all(chat_id, cap);
  }
  return db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT ?").all(cap);
}

module.exports = { list };
