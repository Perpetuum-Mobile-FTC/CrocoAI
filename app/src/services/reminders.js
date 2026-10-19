// Reminders = tasks with remind_at (docs/design-meniu-v2.md §2). This is the compatibility layer behind
// /api/reminders and the AI tool creeaza_reminder: same validation/permissions as before (always a member,
// never a raw phone - audit fix B-HIGH-2), but the reminder is stored and sent as a task.
// The `reminders` table is history only (+ legacy phone-only rows the scheduler still sends, migration 018).
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan } = require("../domain/policy");
const tasks = require("./tasks");

// Task row -> the reminder shape the old API returned (id = task id).
function toReminder(t) {
  return {
    id: t.id, task_id: t.id, message: t.title, remind_at: t.remind_at,
    target_member_id: t.assigned_member_id, target_name: t.assigned_name,
    sent: t.reminded, attempts: t.remind_attempts, failed: t.remind_failed, created_at: t.created_at,
  };
}

function create(actor, data) {
  const { target_member_id, message, remind_at } = data || {};
  if (!message || !remind_at) throw new DomainError("INVALID", "Mesajul și data sunt obligatorii.");
  const targetId = target_member_id || actor.id;
  if (targetId !== actor.id) {
    assertCan(actor, "reminders.create_other");
  } else {
    assertCan(actor, "reminders.create_self");
  }
  const target = db.prepare("SELECT * FROM members WHERE id = ?").get(targetId);
  if (!target) throw new DomainError("NOT_FOUND", "Membru negăsit.");
  if (target.status !== "activ" && targetId !== actor.id) {
    throw new DomainError("INVALID", "Remindere pot fi create doar pentru membri activi.");
  }
  return toReminder(tasks.create(actor, { title: message, assigned_member_id: targetId, remind_at }));
}

function list(actor, { sent } = {}) {
  return tasks.list(actor, { withReminder: true, reminded: sent }).map(toReminder);
}

function remove(actor, id) {
  const t = db.prepare("SELECT * FROM tasks WHERE id = ? AND remind_at IS NOT NULL").get(id);
  if (!t) throw new DomainError("NOT_FOUND", "Reminder negăsit.");
  if (t.assigned_member_id !== actor.id) assertCan(actor, "reminders.create_other");
  tasks.remove(actor, id);
}

module.exports = { create, list, remove, toReminder };
