const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "._attendance_test.db");
process.env.DB_PATH = DB_FILE;
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const db = require("../src/db");
const attendance = require("../src/services/attendance");
const { DomainError } = require("../src/domain/errors");

let tl, member1, member2;

before(() => {
  const insert = db.prepare("INSERT INTO members (full_name, phone, role, auth_role, status) VALUES (?, ?, ?, ?, 'activ')");
  tl = { id: insert.run("Team Leader", "40700000001", "team_leader", "team_leader").lastInsertRowid, role: "team_leader", status: "activ" };
  member1 = { id: insert.run("Ana Popescu", "40700000002", "member", "member").lastInsertRowid, role: "member", status: "activ" };
  member2 = { id: insert.run("Ion Ionescu", "40700000003", "member", "member").lastInsertRowid, role: "member", status: "activ" };
});

after(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  delete process.env.DB_PATH;
});

test("attendance.mark is MANAGERS only - a member cannot create a session", () => {
  assert.throws(() => attendance.createSession(member1, { date: "2026-09-10", type: "sedinta" }), DomainError);
});

test("MANAGERS can create a session and mark records", () => {
  const session = attendance.createSession(tl, { date: "2026-09-10", start_time: "18:00", type: "sedinta" });
  assert.ok(session.id);
  const records = attendance.markRecords(tl, session.id, [
    { member_id: member1.id, status: "prezent" },
    { member_id: member2.id, status: "absent" },
  ]);
  assert.equal(records.length, 2);
});

test("duplicate session (same date/start_time/type/team) is rejected", () => {
  assert.throws(() => attendance.createSession(tl, { date: "2026-09-10", start_time: "18:00", type: "sedinta" }), DomainError);
});

test("statsFor: member sees own stats, motivated absences don't reduce pct", () => {
  const s2 = attendance.createSession(tl, { date: "2026-09-17", start_time: "18:00", type: "sedinta" });
  attendance.markRecords(tl, s2.id, [{ member_id: member1.id, status: "motivat" }]);

  const stats = attendance.statsFor(member1, member1.id, { from: "2026-09-01", to: "2026-09-30" });
  assert.equal(stats.present, 1);
  assert.equal(stats.motivat, 1);
  assert.equal(stats.pct, 100); // 1 prezent / (1 prezent + 0 absent), motivat excluded
});

test("statsFor: a member cannot view another member's stats", () => {
  assert.throws(() => attendance.statsFor(member1, member2.id), DomainError);
});

test("statsFor: MANAGERS/OVERSIGHT can view anyone's stats", () => {
  const stats = attendance.statsFor(tl, member2.id, { from: "2026-09-01", to: "2026-09-30" });
  assert.equal(stats.absent, 1);
});

test("non-counting session types (antrenament) don't affect the percentage", () => {
  const s3 = attendance.createSession(tl, { date: "2026-09-20", start_time: "10:00", type: "antrenament" });
  attendance.markRecords(tl, s3.id, [{ member_id: member2.id, status: "absent" }]);
  const stats = attendance.statsFor(tl, member2.id, { from: "2026-09-01", to: "2026-09-30" });
  assert.equal(stats.sessions_counted, 1); // still only the 'sedinta' session from before
});
