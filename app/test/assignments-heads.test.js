// Heads of department see/review only their department's assignments (decision 2026-10-13);
// since the "TL rights per department" decision (same day) they also manage them (test/sefi-tl-dept.test.js).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initEnv, makeMembers } = require("./_assign-env");
const env = initEnv("assign_heads");
const db = require("../src/db");
const groups = require("../src/services/groups");
const assignments = require("../src/services/assignments");
const subs = require("../src/services/submissions");
const tools = require("../src/ai/tools-assignments");

let M, deptNT, grpNT, deptT;
const subOf = (a, memberId) => db.prepare("SELECT * FROM submissions WHERE assignment_id = ? AND member_id IS ?").get(a.id, memberId);

before(() => {
  M = makeMembers(db, [
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "hn", role: "head_nontech", department: "non-tehnic" },
    { key: "tl", role: "team_leader" },
    { key: "mt", role: "mentor" },
    { key: "n1", role: "member", department: "non-tehnic" },
    { key: "n2", role: "member", department: "non-tehnic" },
    { key: "t1", role: "member", department: "tehnic" },
  ]);
  const g = groups.create(M.hn, { name: "GNT", department: "non-tehnic" });
  grpNT = g;
  groups.setMembers(M.hn, g.id, [{ member_id: M.n1.id }, { member_id: M.n2.id }]);
  deptNT = assignments.create(M.tl, { title: "DeptNT", mode: "individual", target_type: "departament", target_dept: "non-tehnic" });
  deptT = assignments.create(M.tl, { title: "DeptT", mode: "individual", target_type: "departament", target_dept: "tehnic" });
});
after(() => { db.close(); env.cleanup(); });

let groupNT;
test("setup group assignment (created by TL)", () => {
  groupNT = assignments.create(M.tl, { title: "GrupNT", mode: "grup", target_type: "grup", target_team_id: grpNT.id });
});

test("head_nontech sees department + group assignment of own department, with progress and submissions", () => {
  for (const a of [deptNT, groupNT]) {
    const d = assignments.get(M.hn, a.id);
    assert.ok(d.progress && d.submissions, a.title);
    assert.equal(d.can_review, true);
    assert.equal(d.can_manage, true);
  }
});

test("head_tech cannot get the non-tehnic assignments; head_nontech cannot get the tehnic one", () => {
  for (const a of [deptNT, groupNT]) assert.throws(() => assignments.get(M.ht, a.id), /acces/);
  assert.throws(() => assignments.get(M.hn, deptT.id), /acces/);
});

test("list scope all: head gets only own department; TL/mentor all; member 403", () => {
  const titles = (u) => assignments.list(u, { scope: "all" }).map((a) => a.title).sort();
  assert.deepEqual(titles(M.hn), ["DeptNT", "GrupNT"]);
  assert.deepEqual(titles(M.ht), ["DeptT"]);
  assert.equal(titles(M.tl).length, 3);
  assert.equal(titles(M.mt).length, 3);
  assert.throws(() => assignments.list(M.n1, { scope: "all" }), /Doar/);
  const row = assignments.list(M.hn, { scope: "all" })[0];
  assert.equal(row.can_review, true);
  assert.ok(row.progress);
});

test("head_nontech reviews department and group submissions; head_tech cannot", () => {
  const s = subOf(deptNT, M.n1.id);
  db.prepare("UPDATE submissions SET status='predat', current_version=1 WHERE id = ?").run(s.id);
  assert.throws(() => subs.review(M.ht, s.id, { decision: "acceptat" }), /șeful departamentului/);
  assert.equal(subs.review(M.hn, s.id, { decision: "acceptat" }).status, "acceptat");

  const gs = db.prepare("SELECT * FROM submissions WHERE assignment_id = ?").get(groupNT.id);
  db.prepare("UPDATE submissions SET status='predat', current_version=1 WHERE id = ?").run(gs.id);
  assert.throws(() => subs.review(M.ht, gs.id, { decision: "acceptat" }), /șeful departamentului/);
  assert.throws(() => subs.review(M.mt, gs.id, { decision: "acceptat" }), /șeful departamentului/);
  assert.equal(subs.review(M.hn, gs.id, { decision: "de_refacut", comment: "mai bine" }).status, "de_refacut");
});

test("other head cannot edit/close/delete/add members; submission files hidden from other head", () => {
  assert.throws(() => assignments.update(M.ht, deptNT.id, { title: "x" }), /Doar/);
  assert.throws(() => assignments.close(M.ht, deptNT.id), /Doar/);
  assert.throws(() => assignments.remove(M.ht, deptNT.id), /Doar/);
  assert.throws(() => assignments.addNewMembers(M.ht, deptNT.id), /Doar/);
  const s = subOf(deptNT, M.n1.id);
  const a = assignments.requireAssignment(deptNT.id);
  assert.equal(assignments.canSeeSubmission(M.hn, s, a), true);
  assert.equal(assignments.canSeeSubmission(M.ht, s, a), false);
});

test("TL and mentor still see everything; TL reviews; member unchanged", () => {
  for (const a of [deptNT, deptT, groupNT]) {
    assert.ok(assignments.get(M.tl, a.id).submissions);
    const m = assignments.get(M.mt, a.id);
    assert.ok(m.submissions);
    assert.equal(m.can_review, false);
    assert.equal(assignments.get(M.tl, a.id).can_review, true);
  }
  assert.throws(() => assignments.get(M.t1, deptNT.id), /acces/);
  const mine = assignments.get(M.n1, deptNT.id);
  assert.equal(mine.submissions, undefined);
  assert.equal(mine.can_review, false);
});

test("AI tool status_predari_tema: head gets only own department", async () => {
  const run = (actor, id) => {
    let handler;
    const list = tools.build({ tool: (n, d, s, h) => ({ n, h }), z: { number: () => ({ int: () => null }) }, safe: (f) => f, actor });
    handler = list.find((t) => t.n === "status_predari_tema").h;
    return handler({ tema_id: id });
  };
  assert.match(String(run(M.hn, deptNT.id)), /DeptNT/);
  assert.throws(() => run(M.ht, deptNT.id), /acces/);
});
