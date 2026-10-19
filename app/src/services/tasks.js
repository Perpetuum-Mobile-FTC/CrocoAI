// Tasks. Create-for-self: anyone. Assign to others / edit-delete any: MANAGERS.
// A task created for oneself: edited by its creator (tasks.edit_own); delete/status change by the assignee.
// Optional reminder (docs/design-meniu-v2.md §2): remind_at = ISO UTC, sent once by reminder-scheduler.
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");
const { toUtcIso } = require("../domain/time");
const { TASK_TITLE_MAX, MAX_ACTIVE_REMINDERS_PER_MEMBER } = require("../domain/rules");

// A3: caps on what one account can make the bot send (title length, active reminders per assignee).
function checkTitle(title) {
  if (String(title).trim().length > TASK_TITLE_MAX) throw new DomainError("INVALID", `Titlul poate avea cel mult ${TASK_TITLE_MAX} de caractere.`);
}
function assertReminderSlot(memberId, exceptTaskId) {
  const n = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE assigned_member_id = ? AND id != ? AND remind_at IS NOT NULL
    AND reminded = 0 AND remind_failed = 0 AND status = 'pending'`).get(memberId, exceptTaskId || 0).c;
  if (n >= MAX_ACTIVE_REMINDERS_PER_MEMBER) {
    throw new DomainError("LIMIT", `S-a atins limita de ${MAX_ACTIVE_REMINDERS_PER_MEMBER} de taskuri cu reminder active pentru acest membru. Finalizează sau șterge câteva întâi.`);
  }
}

function requireTask(id) {
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!t) throw new DomainError("NOT_FOUND", "Task negăsit.");
  return t;
}

// "" / null -> no reminder; "YYYY-MM-DDTHH:MM" = Europe/Bucharest; ISO with Z/offset accepted as is.
function parseRemindAt(value) {
  if (value === undefined || value === null || value === "") return null;
  const iso = toUtcIso(value);
  if (!iso) throw new DomainError("INVALID", "Ora reminderului nu e validă (format: AAAA-LL-ZZ HH:MM).");
  return iso;
}

function create(actor, data) {
  const { title, assigned_member_id, due_date, remind_at } = data || {};
  if (!title || !title.trim()) throw new DomainError("INVALID", "Titlul e obligatoriu.");
  checkTitle(title);
  const remindAt = parseRemindAt(remind_at);
  const assignee = assigned_member_id && assigned_member_id !== actor.id ? assigned_member_id : null;
  if (assignee) assertCan(actor, "tasks.assign");
  let assignedName = null;
  const targetId = assignee || actor.id;
  if (remindAt) assertReminderSlot(targetId);
  const m = db.prepare("SELECT full_name FROM members WHERE id = ?").get(targetId);
  assignedName = m ? m.full_name : null;
  const info = db.prepare(`
    INSERT INTO tasks (title, assigned_member_id, assigned_name, due_date, remind_at, created_by) VALUES (?, ?, ?, ?, ?, ?)
  `).run(title.trim(), targetId, assignedName, due_date || null, remindAt, actor.id);
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(info.lastInsertRowid);
}

// withReminder: only tasks that have a remind_at (the /api/reminders view); reminded: 0/1 filter on those.
function list(actor, { status, mine, withReminder, reminded } = {}) {
  let sql = "SELECT * FROM tasks WHERE 1=1";
  const params = [];
  if (!can(actor, "tasks.view_all")) { sql += " AND (assigned_member_id = ? OR created_by = ?)"; params.push(actor.id, actor.id); }
  if (status) { sql += " AND status = ?"; params.push(status); }
  if (mine) { sql += " AND assigned_member_id = ?"; params.push(actor.id); }
  if (withReminder) sql += " AND remind_at IS NOT NULL";
  if (reminded !== undefined) { sql += " AND reminded = ?"; params.push(reminded ? 1 : 0); }
  sql += withReminder ? " ORDER BY remind_at" : " ORDER BY due_date IS NULL, due_date, id DESC";
  // Per-row rights for the UI (policy tasks.edit / tasks.delete) - the SPA never recomputes them.
  return db.prepare(sql).all(...params).map((t) => ({ ...t, can_edit: can(actor, "tasks.edit", t), can_delete: can(actor, "tasks.delete", t) }));
}

function updateStatus(actor, id, status) {
  const t = requireTask(id);
  assertCan(actor, "tasks.update_status", t);
  if (!["pending", "done"].includes(status)) throw new DomainError("INVALID", "Status invalid.");
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

function update(actor, id, data) {
  const t = requireTask(id);
  assertCan(actor, "tasks.edit", t);
  const { title, due_date, assigned_member_id, remind_at } = data || {};
  // Validate everything before writing: a rejected edit changes nothing.
  if (title) checkTitle(title);
  const remindAt = remind_at !== undefined ? parseRemindAt(remind_at) : t.remind_at;
  let assignedName = t.assigned_name;
  let assignee = t.assigned_member_id;
  if (assigned_member_id !== undefined && assigned_member_id !== t.assigned_member_id) {
    assertCan(actor, "tasks.assign");
    assignee = assigned_member_id;
    const m = db.prepare("SELECT full_name FROM members WHERE id = ?").get(assignee);
    assignedName = m ? m.full_name : null;
  }
  // A different instant re-arms the reminder (sent again once at the new time); the same one re-saved doesn't.
  const sameInstant = (remindAt === null && t.remind_at === null) || (remindAt !== null && t.remind_at !== null && Date.parse(remindAt) === Date.parse(t.remind_at));
  if (remindAt && t.status === "pending" && (!sameInstant || assignee !== t.assigned_member_id)) assertReminderSlot(assignee, t.id);
  db.prepare(`UPDATE tasks SET title=COALESCE(?,title), due_date=?, assigned_member_id=?, assigned_name=?, remind_at=?,
      reminded=?, remind_attempts=?, remind_failed=? WHERE id = ?`)
    .run(title || null, due_date !== undefined ? due_date : t.due_date, assignee, assignedName, remindAt,
      sameInstant ? t.reminded : 0, sameInstant ? t.remind_attempts : 0, sameInstant ? t.remind_failed : 0, id);
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

function remove(actor, id) {
  const t = requireTask(id);
  assertCan(actor, "tasks.delete", t);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

module.exports = { create, list, updateStatus, update, remove, requireTask };
