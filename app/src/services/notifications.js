// In-app notifications. Every member only sees their own.
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { can } = require("../domain/policy");

function list(actor) {
  const notifications = db.prepare("SELECT * FROM notifications WHERE member_id = ? ORDER BY created_at DESC LIMIT 50").all(actor.id)
    .map((n) => ({ ...n, read: !!n.read }));
  const unread_count = db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND read = 0").get(actor.id).c;
  return { unread_count, notifications };
}

function markRead(actor, id) {
  const info = db.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND member_id = ?").run(id, actor.id);
  if (info.changes === 0) throw new DomainError("NOT_FOUND", "Notificare negăsită.");
}

function markAllRead(actor) {
  db.prepare("UPDATE notifications SET read = 1 WHERE member_id = ?").run(actor.id);
}

function create(memberId, type, title, body, link) {
  db.prepare("INSERT INTO notifications (member_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)")
    .run(memberId, type, title, body || null, link || null);
}

// Crisis signal from the AI (design-ai-hardening.md §1/§5): discreet, NO message content — only
// that a crisis tag fired, for whom, when. Goes to team_leader + active mentors, never the chat text.
function notifyCrisisSignal(member) {
  const recipients = db.prepare("SELECT * FROM members WHERE id != ?").all(member.id).filter((m) => can(m, "ai.crisis_notify"));
  const title = "Semnal de siguranță AI";
  const body = `Asistentul AI a detectat un posibil semnal de criză în conversația cu ${member.full_name}. ` +
    `Conținutul NU e păstrat — verifică direct cu persoana.`;
  for (const r of recipients) create(r.id, "ai_crisis", title, body, null);
  // Also on WhatsApp (verified phones only, A3): an in-app notification can sit unread for days. No content.
  const { sendWhatsApp } = require("./wa-gateway");
  const { whatsappPhone } = require("./members");
  for (const r of recipients) {
    const phone = whatsappPhone(r);
    if (phone) sendWhatsApp(phone, `⚠️ ${title}: ${body}`).catch(() => {});
  }
}

module.exports = { list, markRead, markAllRead, create, notifyCrisisSignal };
