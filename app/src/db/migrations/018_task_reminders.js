// Tasks with reminder (docs/design-meniu-v2.md §2): a task may carry remind_at (ISO UTC); the scheduler
// sends "Reminder: <titlu>" to the assignee once (reminded=1), with attempts/failed like reminders.
// Unsent reminders that target a member become tasks (title = message, assignee = target) and are marked
// with migrated_task_id so the scheduler doesn't send them twice. Phone-only reminders (no member, pre-v2)
// stay in `reminders` and keep going through the old path; sent/failed ones stay there as history.
// Old remind_at values without an offset were read in the container's TZ (Europe/Bucharest) -> same here.
// Only domain/time (pure, no db) is required - never services (CLAUDE.md: circular require with src/db).
const { toUtcIso } = require("../../domain/time");

function up(db) {
  db.exec(`
    ALTER TABLE tasks ADD COLUMN remind_at TEXT;
    ALTER TABLE tasks ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN remind_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN remind_failed INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN created_by INTEGER;
    ALTER TABLE reminders ADD COLUMN migrated_task_id INTEGER;
    CREATE INDEX idx_tasks_remind ON tasks(reminded, remind_at);
  `);

  const insertTask = db.prepare("INSERT INTO tasks (title, assigned_member_id, assigned_name, remind_at) VALUES (?, ?, ?, ?)");
  const markMigrated = db.prepare("UPDATE reminders SET migrated_task_id = ? WHERE id = ?");
  const rows = db.prepare(`
    SELECT r.*, m.full_name AS member_name FROM reminders r JOIN members m ON m.id = r.target_member_id
    WHERE r.sent = 0 AND (r.failed IS NULL OR r.failed = 0)
  `).all();
  for (const r of rows) {
    const remindAt = toUtcIso(r.remind_at);
    if (!remindAt) { console.warn(`[DB] 018: reminder ${r.id} has an unreadable remind_at "${r.remind_at}" - left in reminders`); continue; }
    const taskId = insertTask.run(r.message, r.target_member_id, r.member_name || r.target_name, remindAt).lastInsertRowid;
    markMigrated.run(taskId, r.id);
  }
}

module.exports = { up };
