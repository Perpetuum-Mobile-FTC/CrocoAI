// Curățenie F2 item 6: every migration applies cleanly on an empty DB and on an "old" (001..010) snapshot
// with representative rows; integrity + foreign keys hold and the rows survive. Plus a lint rule: .js
// migrations require only pure modules (never services / src/db - circular require, CLAUDE.md).
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { builtinModules } = require("module");
const Database = require("better-sqlite3");
const { migrate, migrationFiles, MIGRATIONS_DIR } = require("../src/db/migrate");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crocoai-migr-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const quiet = { log: () => {} };

function open(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
function assertHealthy(db) {
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(db.pragma("foreign_key_check"), []);
}
const count = (db, t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

test("all migrations on an empty DB: healthy, recorded, idempotent", () => {
  const db = open(path.join(dir, "empty.db"));
  const applied = migrate(db, quiet);
  assert.deepEqual(applied, migrationFiles());
  assertHealthy(db);
  assert.equal(count(db, "_migrations"), migrationFiles().length);
  assert.deepEqual(migrate(db, quiet), [], "second run applies nothing");
  db.close();
});

const OLD_UNTIL = "010_ftc_manual_versions.sql";

// Representative rows written against the 001..010 schema (as an old production DB would hold them).
function seedOld(db) {
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  run(`INSERT INTO members (id, full_name, username, phone, role, auth_role, status, department, joined_at) VALUES
    (1, 'Lider Vechi', 'lider', '40700000001', 'team_leader', 'team_leader', 'activ', 'ambele', '2025-09-01'),
    (2, 'Membru Vechi', 'membru', '40700000002', 'member', 'member', 'activ', 'tehnic', '2025-09-01'),
    (3, 'Sef Vechi', 'sef', '40700000003', 'head_nontech', 'member', 'activ', 'non-tehnic', '2025-09-01'),
    (4, 'Mentor Vechi', 'mentor', '40700000004', 'mentor', 'mentor', 'activ', NULL, '2025-09-01'),
    (5, 'In Pauza', 'pauza', '40700000005', 'member', 'member', 'pauza', 'non-tehnic', '2025-09-01')`);
  run("INSERT INTO member_status_history (member_id, from_status, to_status, changed_by) VALUES (5, 'activ', 'pauza', 1)");
  run("INSERT INTO guardians (member_id, name, relation, phone) VALUES (2, 'Parinte', 'mama', '40700000099')");
  run("INSERT INTO teams (id, name) VALUES (1, 'Mecanica'), (2, 'Marketing')");
  run("INSERT INTO team_members (team_id, member_id, role) VALUES (1, 2, 'leader'), (1, 4, 'member'), (2, 5, 'member')");
  run(`INSERT INTO events (id, title, location, start_time, end_time, type, recurrence, recurrence_until, created_by) VALUES
    (1, 'Sedinta saptamanala', 'Sala', '2026-09-03T15:00:00.000Z', '2026-09-03T17:00:00.000Z', 'sedinta', 'weekly', '2026-09-24', 1),
    (2, 'Concurs', 'Bucuresti', '2026-11-20T08:00:00.000Z', NULL, 'competitie', NULL, NULL, 1)`);
  run(`INSERT INTO attendance_sessions (id, date, start_time, title, type, team_id, event_id, created_by) VALUES
    (1, '2026-09-03', '15:00', 'Sedinta saptamanala', 'sedinta', NULL, 1, 1),
    (2, '2026-09-10', '15:00', 'Sedinta saptamanala', 'sedinta', NULL, 1, 1),
    (3, '2026-09-12', '10:00', 'Antrenament', 'antrenament', 1, NULL, 1)`);
  run(`INSERT INTO attendance_records (session_id, member_id, status, marked_by) VALUES
    (1, 2, 'prezent', 1), (1, 3, 'absent', 1), (2, 2, 'motivat', 1), (3, 2, 'prezent', 1)`);
  run("INSERT INTO absence_requests (member_id, session_id, date, reason, status) VALUES (2, 2, '2026-09-10', 'scoala', 'aprobata'), (3, NULL, '2026-10-01', 'boala', 'in_asteptare')");
  run("INSERT INTO tasks (title, assigned_member_id, due_date, status) VALUES ('Task vechi', 2, '2026-10-30', 'pending')");
  run(`INSERT INTO reminders (target_phone, target_name, message, remind_at, sent, target_member_id) VALUES
    ('40700000002', 'Membru Vechi', 'Adu bateriile', '2030-01-10T18:00', 0, 2),
    ('40700000002', 'Membru Vechi', 'Deja trimis', '2026-01-10T18:00', 1, 2)`);
  run("INSERT INTO member_documents (member_id, type_key, file_path, original_name, mime, size, status) VALUES (2, 'fisa_medicala', '2/x.pdf', 'x.pdf', 'application/pdf', 10, 'aprobat')");
  run("INSERT INTO warnings (member_id, level, article, reason, recorded_by) VALUES (3, 'verbal', 'Art. 30.1', 'intarzieri', 1)");
  run(`INSERT INTO meetings (id, session_id, agenda, draft, status, created_by) VALUES
    (1, 1, '["Robot"]', '{"discussions":[{"point":"Robot","decision":"OK"}]}', 'draft', 1)`);
  run("INSERT INTO albums (id, title, created_by) VALUES (1, 'Septembrie', 1)");
  run("INSERT INTO photos (id, album_id, file_path, mime, media_type, size, uploaded_by) VALUES (1, 1, '1/a.jpg', 'image/jpeg', 'image', 100, 2)");
  run("INSERT INTO photo_tags (photo_id, member_id, tagged_by) VALUES (1, 2, 1)");
  run("INSERT INTO notifications (member_id, type, title) VALUES (1, 'x', 'Salut'), (2, 'y', 'Buna')");
  run("INSERT INTO messages (chat_id, sender_phone, body, from_me) VALUES ('40700000002', '40700000002', 'buna', 0), ('40700000002', NULL, 'salut', 1)");
  run("INSERT INTO web_chat_messages (member_id, message_type, body) VALUES (2, 'web-user', 'intrebare'), (2, 'web-ai', 'raspuns')");
  const announce = db.prepare("SELECT id FROM chat_conversations WHERE type = 'announce'").get();
  const general = run("INSERT INTO chat_conversations (type, name, created_by) VALUES ('group', 'General', 1)").lastInsertRowid;
  run("INSERT INTO chat_messages (conversation_id, sender_id, body) VALUES (?, 1, 'Anunt important\nDetalii aici'), (?, 2, 'hei')", announce.id, general);
  run("INSERT INTO onboarding (id, member_id, buddy_id, started_by, status) VALUES (1, 5, 2, 1, 'activ')");
  run("INSERT INTO onboarding_checklist (onboarding_id, step_key, done) VALUES (1, 'documente', 0), (1, 'grup_whatsapp', 1)");
  run(`INSERT INTO applications (full_name, phone, email, birthdate, class, school, department, motivation, gdpr_ack_at, ip_hash)
    VALUES ('Candidat', '40700000050', 'c@x.ro', '2010-01-01', '9A', 'Liceu', 'tehnic', 'robotica', '2026-09-01', 'h')`);
  run(`INSERT INTO completion_tokens (member_id, token_hash, created_by, expires_at) VALUES
    (1, 'tl-unused', 1, '2030-01-01'), (2, 'member-unused', 1, '2030-01-01')`);
  run("INSERT INTO wa_groups (group_id, name, tracked) VALUES ('g1@g.us', 'Echipa', 1)");
  run("INSERT INTO ai_usage (member_id, channel, model, cost_usd) VALUES (2, 'wa', 'm', 0.01)");
  run("INSERT INTO ftc_manual_versions (version, sha256) VALUES ('1.0', 'abc')");
}

test("old (001..010) snapshot with data: the rest applies, healthy, rows preserved", () => {
  const file = path.join(dir, "old.db");
  let db = open(file);
  migrate(db, { ...quiet, until: OLD_UNTIL });
  seedOld(db);
  assertHealthy(db);
  const tables = ["members", "member_status_history", "guardians", "teams", "team_members", "events", "attendance_sessions",
    "attendance_records", "absence_requests", "reminders", "member_documents", "warnings", "meetings", "albums", "photos",
    "photo_tags", "notifications", "messages", "web_chat_messages", "chat_messages", "onboarding", "onboarding_checklist",
    "applications", "wa_groups", "ai_usage", "ftc_manual_versions"];
  const before = Object.fromEntries(tables.map((t) => [t, count(db, t)]));
  const tasksBefore = count(db, "tasks");
  db.close(); // the snapshot as it would sit on disk

  db = open(file);
  const applied = migrate(db, quiet);
  assert.deepEqual(applied, migrationFiles().filter((f) => f > OLD_UNTIL));
  assertHealthy(db);
  for (const t of tables) assert.equal(count(db, t), before[t], `${t} row count preserved`);

  // documented data moves
  assert.equal(count(db, "tasks"), tasksBefore + 1, "018: the unsent member reminder became a task");
  assert.equal(db.prepare("SELECT title FROM tasks WHERE remind_at IS NOT NULL").get().title, "Adu bateriile");
  assert.deepEqual(db.prepare("SELECT token_hash FROM completion_tokens").all().map((r) => r.token_hash), ["member-unused"], "023: unused privileged links removed");
  const ann = db.prepare("SELECT title, body, author_id FROM announcements").all();
  assert.deepEqual(ann, [{ title: "Anunt important", body: "Detalii aici", author_id: 1 }], "024: announce channel copied");
  assert.equal(count(db, "deadlines"), 2);

  // values survive
  assert.equal(db.prepare("SELECT phone FROM members WHERE id = 2").get().phone, "40700000002");
  assert.equal(JSON.parse(db.prepare("SELECT draft FROM meetings WHERE id = 1").get().draft).discussions[0].decision, "OK");
  assert.equal(db.prepare("SELECT status FROM attendance_records WHERE session_id = 2 AND member_id = 2").get().status, "motivat");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attendance_sessions WHERE target_dept IS NULL").get().c, 3);
  db.close();
});

test("lint: .js migrations require only node builtins and pure domain modules (never services / src/db)", () => {
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    for (const [, mod] of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      const ok = builtinModules.includes(mod.replace(/^node:/, "")) || /^\.\.\/\.\.\/domain\/[\w-]+$/.test(mod);
      assert.ok(ok, `${f} requires "${mod}" - migrations may only use src/domain/* (pure) modules`);
      assert.doesNotMatch(mod, /services|\/db(\/|$)|^\.\.\/index|^\.\/index/, f);
    }
  }
});
