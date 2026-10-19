const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initEnv, makeMembers } = require("./_assign-env");
const env = initEnv("assign_rem");
const db = require("../src/db");
const assignments = require("../src/services/assignments");
const subs = require("../src/services/submissions");
const notify = require("../src/services/assignment-notify");

let M;
const count = (memberId, title) => db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND title = ?").get(memberId, title).c;

before(() => {
  M = makeMembers(db, [
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "a", role: "member", department: "tehnic" },
    { key: "b", role: "member", department: "tehnic" },
  ]);
});
after(() => { db.close(); env.cleanup(); });

test("24h reminder only to those who have not submitted, once", () => {
  const now = new Date("2030-05-01T10:00:00Z");
  const a = assignments.create(M.ht, { title: "Soon", mode: "individual", target_type: "departament", target_dept: "tehnic", due_at: "2030-05-02T08:00:00Z" });
  const sA = db.prepare("SELECT id FROM submissions WHERE assignment_id = ? AND member_id = ?").get(a.id, M.a.id);
  subs.addFiles(M.a, sA.id, [{ originalname: "x.txt", buffer: Buffer.from("x"), size: 1 }]);
  subs.submit(M.a, sA.id);
  notify.runDue(now);
  notify.runDue(now);
  assert.equal(count(M.b.id, "Termen în mai puțin de 24h"), 1);
  assert.equal(count(M.a.id, "Termen în mai puțin de 24h"), 0);
});

test("after the due date the creator gets one summary", () => {
  const a = assignments.create(M.ht, { title: "Past", mode: "individual", target_type: "departament", target_dept: "tehnic", due_at: "2030-06-01T08:00:00Z" });
  notify.runDue(new Date("2030-06-01T09:00:00Z"));
  notify.runDue(new Date("2030-06-01T09:01:00Z"));
  const rows = db.prepare("SELECT body FROM notifications WHERE member_id = ? AND title = 'Termen depășit' AND link = ?").all(M.ht.id, `/teme/${a.id}`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /2 din 2 n-au predat/);
  assert.equal(db.prepare("SELECT summarized_due FROM assignments WHERE id = ?").get(a.id).summarized_due, 1);
});

test("closed assignments and assignments without due date are ignored", () => {
  const a1 = assignments.create(M.ht, { title: "Closed", mode: "individual", target_type: "departament", target_dept: "tehnic", due_at: "2030-07-01T08:00:00Z" });
  assignments.close(M.ht, a1.id);
  const a2 = assignments.create(M.ht, { title: "NoDue", mode: "individual", target_type: "departament", target_dept: "tehnic" });
  const before = db.prepare("SELECT COUNT(*) c FROM notifications WHERE link IN (?, ?)").get(`/teme/${a1.id}`, `/teme/${a2.id}`).c;
  notify.runDue(new Date("2030-07-01T09:00:00Z"));
  const after = db.prepare("SELECT COUNT(*) c FROM notifications WHERE link IN (?, ?)").get(`/teme/${a1.id}`, `/teme/${a2.id}`).c;
  assert.equal(after, before);
});

test("full flow: 24h reminder then overdue summary for same assignment", () => {
  const dueAt = new Date("2030-08-15T14:00:00Z").toISOString();
  const a = assignments.create(M.ht, { title: "Full flow", mode: "individual", target_type: "departament", target_dept: "tehnic", due_at: dueAt });
  const sA = db.prepare("SELECT id FROM submissions WHERE assignment_id = ? AND member_id = ?").get(a.id, M.a.id);
  subs.addFiles(M.a, sA.id, [{ originalname: "x.txt", buffer: Buffer.from("x"), size: 1 }]);
  subs.submit(M.a, sA.id);

  // 3 hours before due: 24h reminder to M.b (who hasn't submitted)
  notify.runDue(new Date("2030-08-15T11:00:00Z"));
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND title = 'Termen în mai puțin de 24h' AND link = ?").get(M.b.id, `/teme/${a.id}`).c,
    1
  );

  // 1 hour after due: overdue summary to creator (M.ht), only 1 notification
  notify.runDue(new Date("2030-08-15T15:00:00Z"));
  const summaries = db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND title = 'Termen depășit' AND link = ?").get(M.ht.id, `/teme/${a.id}`).c;
  assert.equal(summaries, 1);

  // 2 hours after due: no new overdue summary (already sent)
  notify.runDue(new Date("2030-08-15T16:00:00Z"));
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND title = 'Termen depășit' AND link = ?").get(M.ht.id, `/teme/${a.id}`).c,
    1
  );

  // M.b should not get a new 24h reminder
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND title = 'Termen în mai puțin de 24h' AND link = ?").get(M.b.id, `/teme/${a.id}`).c,
    1
  );
});

test("runDue: a failing send is logged, flagged once, and does not block other assignments", () => {
  const mk = (title) => assignments.create(M.ht, { title, mode: "individual", target_type: "departament", target_dept: "tehnic", due_at: "2031-05-02T08:00:00Z" });
  const bad = mk("Bad"), good = mk("Good");
  const realErr = console.error;
  const errs = [];
  console.error = (m) => errs.push(m);
  // Force a failure for one assignment through a DB trigger on notifications.
  db.exec("CREATE TRIGGER fail_bad BEFORE INSERT ON notifications WHEN NEW.link = '/teme/" + bad.id + "' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  try {
    notify.runDue(new Date("2031-05-01T10:00:00Z"));
    notify.runDue(new Date("2031-05-01T10:01:00Z"));
  } finally { console.error = realErr; db.exec("DROP TRIGGER fail_bad"); }
  assert.equal(errs.filter((m) => m === `[REMINDERS] assignment ${bad.id}: boom`).length, 1);
  assert.equal(db.prepare("SELECT reminded_due FROM assignments WHERE id = ?").get(bad.id).reminded_due, 1);
  assert.equal(count(M.a.id, "Termen în mai puțin de 24h") >= 1, true);
  assert.equal(db.prepare("SELECT reminded_due FROM assignments WHERE id = ?").get(good.id).reminded_due, 1);
});
