const { test, after } = require("node:test");
const assert = require("node:assert");
const { initEnv } = require("./_assign-env");
const env = initEnv("assign_schema");
const db = require("../src/db");

after(() => { db.close(); env.cleanup(); });

test("migration 011 adds department/created_by to teams", () => {
  const cols = db.prepare("PRAGMA table_info(teams)").all().map((c) => c.name);
  assert.ok(cols.includes("department"));
  assert.ok(cols.includes("created_by"));
  const id = db.prepare("INSERT INTO teams (name) VALUES ('x')").run().lastInsertRowid;
  assert.equal(db.prepare("SELECT department FROM teams WHERE id = ?").get(id).department, "mixt");
});

test("migration 011 creates the assignment tables", () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  for (const t of ["assignments", "assignment_materials", "assignment_todos", "submissions", "submission_todos", "submission_files"]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test("deleting a team keeps its assignments (target_team_id -> NULL)", () => {
  const m = db.prepare("SELECT id FROM members LIMIT 1").get()
    || { id: db.prepare("INSERT INTO members (full_name, phone, role, auth_role, status) VALUES ('A', '40700990000', 'team_leader', 'team_leader', 'activ')").run().lastInsertRowid };
  const team = db.prepare("INSERT INTO teams (name) VALUES ('g')").run().lastInsertRowid;
  const a = db.prepare(`INSERT INTO assignments (title, mode, target_type, target_team_id, target_label, created_by)
    VALUES ('t', 'grup', 'grup', ?, 'g', ?)`).run(team, m.id).lastInsertRowid;
  db.prepare("DELETE FROM teams WHERE id = ?").run(team);
  const row = db.prepare("SELECT * FROM assignments WHERE id = ?").get(a);
  assert.equal(row.target_team_id, null);
  assert.equal(row.target_label, "g");
});
