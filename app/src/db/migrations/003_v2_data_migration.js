// Data migration for CrocoAI v2 (design-v2.md §2, §6, §9). Runs once inside the migration
// transaction (see db/index.js runMigrations, which supports .js migrations via exports.up(db)).
const { normalizePhone } = require("../../domain/phone");

const ROLE_MAP = { team_leader: "team_leader", mentor: "mentor", member: "member" };

function up(db) {
  seedDocumentTypes(db); // always, even on a fresh install

  // Fresh install (no members yet, e.g. first-ever boot): nothing else to migrate. Skip so the
  // seed script can create the initial admin normally - the rest of this migration only matters
  // when upgrading an existing v1 database.
  const existingCount = db.prepare("SELECT COUNT(*) c FROM members").get().c;
  if (existingCount === 0) return;

  // 1. Normalize every existing phone number (Art. 9 §9 bug: 07... vs 407...).
  const members = db.prepare("SELECT id, phone, auth_role, active, department FROM members").all();
  const updatePhone = db.prepare("UPDATE members SET phone = ? WHERE id = ?");
  for (const m of members) {
    const normalized = normalizePhone(m.phone);
    if (normalized && normalized !== m.phone) updatePhone.run(normalized, m.id);
  }

  // 2. auth_role -> role, status derived from active.
  const setRoleStatus = db.prepare("UPDATE members SET role = ?, status = ? WHERE id = ?");
  for (const m of members) {
    const role = ROLE_MAP[m.auth_role] || "member";
    const status = m.active ? "activ" : "iesit";
    setRoleStatus.run(role, status, m.id);
  }

  // 3-4. (Team-specific one-off role/name fixes of the original v1 database - already applied in
  // production and removed from the public release; they don't affect the schema.)

  // 5. Attendance: P/A/M -> prezent/absent/motivat; mirror attendance_sessions.date into start_time
  // when missing so the new UNIQUE index (date, start_time, type, team_id) matches the old rows.
  db.prepare("UPDATE attendance_records SET status = 'prezent' WHERE status = 'P'").run();
  db.prepare("UPDATE attendance_records SET status = 'absent' WHERE status = 'A'").run();
  db.prepare("UPDATE attendance_records SET status = 'motivat' WHERE status = 'M'").run();
  db.prepare("UPDATE attendance_sessions SET start_time = '' WHERE start_time IS NULL").run();

  // 6. tasks.assigned_phone -> assigned_member_id (match by normalized phone).
  const tasks = db.prepare("SELECT id, assigned_phone FROM tasks WHERE assigned_phone IS NOT NULL").all();
  const findByPhone = db.prepare("SELECT id FROM members WHERE phone = ?");
  const setTaskMember = db.prepare("UPDATE tasks SET assigned_member_id = ? WHERE id = ?");
  for (const t of tasks) {
    const phone = normalizePhone(t.assigned_phone);
    const member = phone && findByPhone.get(phone);
    if (member) setTaskMember.run(member.id, t.id);
  }

  // 7. reminders.target_phone -> target_member_id.
  const reminders = db.prepare("SELECT id, target_phone FROM reminders WHERE target_phone IS NOT NULL").all();
  const setReminderMember = db.prepare("UPDATE reminders SET target_member_id = ? WHERE id = ?");
  for (const r of reminders) {
    const phone = normalizePhone(r.target_phone);
    const member = phone && findByPhone.get(phone);
    if (member) setReminderMember.run(member.id, r.id);
  }

  // 8. wa_groups: design wants tracked default 0 going forward. Existing rows are left as-is
  // (teams already relying on them); new inserts must pass tracked explicitly in wa-groups service.

}

// Seed document_types (design v2 §7). Called unconditionally - needed on fresh installs too.
function seedDocumentTypes(db) {
  const docTypes = [
    ["anexa5_confidentialitate", "Acord de confidențialitate (Anexa 5)", "toti", "Art. 14.2", "html-anexa"],
    ["anexa6_regulament", "Formular acceptare regulament (Anexa 6)", "toti", "Art. 14.2", "html-anexa"],
    ["anexa13_foto_video", "Acord consimțământ foto/video (Anexa 13)", "toti", "Art. 63, 49.4", "html-anexa"],
    ["fisa_medicala", "Fișă medicală sumară", "toti", "Art. 62.3", "html-form"],
    ["first_policies", "Declarație FIRST Policies (minor și major)", "toti", "program FTC România", "pdf"],
    ["consimtamant_participanti_majori", "Consimțământ participanți (majori)", "majori", "program FTC", "pdf"],
    ["consimtamant_imagine_majori", "Consimțământ prelucrare imagine (majori)", "majori", "program FTC", "pdf"],
    ["acord_parental_deplasare", "Acord parental deplasare", "deplasare_minori", "Art. 54.3", "html-form"],
  ];
  const insertType = db.prepare(`
    INSERT INTO document_types (key, title, required_for, article, source) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  for (const row of docTypes) insertType.run(...row);
}

module.exports = { up };
