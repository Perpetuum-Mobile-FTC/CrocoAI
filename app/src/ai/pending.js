// Pending WhatsApp-send confirmations (`whatsapp.send`, design v2 §4/§8). The AI tool
// `trimite_whatsapp` never sends directly — it only creates a row here. The actual send
// happens deterministically (no LLM call) when the same member replies "DA" in the same
// chat within 10 minutes; anything else, or expiry, cancels it.
const db = require("../db");
const { sendWhatsApp } = require("../services/wa-gateway");

const TTL_MS = 10 * 60 * 1000;

function create(actor, chatId, action) {
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const info = db.prepare(`
    INSERT INTO wa_pending_actions (member_id, chat_id, action, expires_at) VALUES (?, ?, ?, ?)
  `).run(actor.id, chatId, JSON.stringify(action), expiresAt);
  return db.prepare("SELECT * FROM wa_pending_actions WHERE id = ?").get(info.lastInsertRowid);
}

// Most recent non-expired pending action for this member in this chat, or null.
function findActive(memberId, chatId) {
  const row = db.prepare(`
    SELECT * FROM wa_pending_actions WHERE member_id = ? AND chat_id = ? ORDER BY id DESC LIMIT 1
  `).get(memberId, chatId);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM wa_pending_actions WHERE id = ?").run(row.id);
    return null;
  }
  return row;
}

function remove(id) {
  db.prepare("DELETE FROM wa_pending_actions WHERE id = ?").run(id);
}

// Structured { summary, expires_at } for a pending action, or null - used by the web chat
// response (and GET /api/ai/pending for page reloads) so the frontend shows the DA/Anulează
// buttons from actual state instead of guessing from the reply text.
function toPublic(row) {
  if (!row) return null;
  const action = JSON.parse(row.action);
  return {
    summary: `Trimite WhatsApp către ${action.to}: "${action.message}"`,
    expires_at: row.expires_at,
  };
}

function getPublic(memberId, chatId) {
  return toPublic(findActive(memberId, chatId));
}

// Checks if `text` is a confirmation ("da"/"DA", accents/diacritics-insensitive, whole message).
function isConfirmation(text) {
  return /^da[.!]?$/i.test((text || "").trim());
}

// Executes a pending action and removes it. Returns the confirmation text, or null if none ran.
async function confirmIfAny(memberId, chatId, text) {
  const pending = findActive(memberId, chatId);
  if (!pending) return null;
  remove(pending.id);
  if (!isConfirmation(text)) {
    return "Am anulat trimiterea (nu ai confirmat cu DA).";
  }
  const action = JSON.parse(pending.action);
  const sent = await sendWhatsApp(action.to, action.message);
  return sent
    ? "Am trimis mesajul."
    : "Nu am reușit să trimit mesajul (gateway indisponibil). Încearcă din nou.";
}

module.exports = { create, findActive, remove, isConfirmation, confirmIfAny, getPublic, TTL_MS };
