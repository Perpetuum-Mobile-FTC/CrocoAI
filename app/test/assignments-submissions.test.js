const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initEnv, makeMembers } = require("./_assign-env");
const env = initEnv("assign_subs");
const db = require("../src/db");
const groups = require("../src/services/groups");
const assignments = require("../src/services/assignments");
const subs = require("../src/services/submissions");

let M, grp, indiv, group;
const file = (name) => ({ originalname: name, buffer: Buffer.from("data"), size: 4, mimetype: "text/plain" });
const subOf = (a, memberId) => db.prepare("SELECT * FROM submissions WHERE assignment_id = ? AND member_id IS ?").get(a.id, memberId);

before(() => {
  M = makeMembers(db, [
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "tl", role: "team_leader" },
    { key: "a", role: "member", department: "tehnic" },
    { key: "b", role: "member", department: "tehnic" },
    { key: "nt", role: "member", department: "non-tehnic" },
  ]);
  grp = groups.create(M.ht, { name: "G", department: "tehnic" });
  groups.setMembers(M.ht, grp.id, [{ member_id: M.a.id }, { member_id: M.b.id }]);
  indiv = assignments.create(M.ht, { title: "Indiv", mode: "individual", target_type: "departament", target_dept: "tehnic", todos: ["Pas 1", "Pas 2"], due_at: "2020-01-01T00:00:00Z" });
  group = assignments.create(M.ht, { title: "Grup", mode: "grup", target_type: "grup", target_team_id: grp.id, todos: ["Pas comun"] });
});
after(() => { db.close(); env.cleanup(); });

test("submit requires at least one file or all to-dos done", () => {
  const s = subOf(indiv, M.a.id);
  assert.throws(() => subs.submit(M.a, s.id), /cel puțin un fișier/);
  subs.toggleTodo(M.a, s.id, indiv.todos[0].id, { done: true });
  assert.throws(() => subs.submit(M.a, s.id), /cel puțin un fișier/);
  const d = subs.addFiles(M.a, s.id, [file("v1.txt")]);
  assert.equal(d.files[0].version, 1);
  const done = subs.submit(M.a, s.id);
  assert.equal(done.status, "predat");
  assert.equal(done.current_version, 1);
  assert.equal(done.late, true, "due date 2020 -> late");
});

test("nobody else can work on or read an individual submission", () => {
  const s = subOf(indiv, M.a.id);
  assert.throws(() => subs.addFiles(M.b, s.id, [file("x.txt")]), /Nu lucrezi/);
  const f = db.prepare("SELECT id FROM submission_files WHERE submission_id = ?").get(s.id);
  assert.throws(() => subs.submissionFile(M.b, s.id, f.id), /acces/);
  assert.ok(subs.submissionFile(M.ht, s.id, f.id).absPath);
});

test("submitted work is frozen until reviewed; redo -> v2 keeps history -> accept", () => {
  const s = subOf(indiv, M.a.id);
  assert.throws(() => subs.toggleTodo(M.a, s.id, indiv.todos[1].id, { done: true }), /predată/);
  assert.throws(() => subs.review(M.ht, s.id, { decision: "de_refacut", comment: " " }), /Scrie ce/);
  assert.throws(() => subs.review(M.a, s.id, { decision: "acceptat" }), /cine a dat tema/);
  assert.equal(subs.review(M.ht, s.id, { decision: "de_refacut", comment: "Lipsește cota" }).status, "de_refacut");
  const v1 = db.prepare("SELECT id FROM submission_files WHERE submission_id = ? AND version = 1").get(s.id);
  assert.throws(() => subs.removeFile(M.a, s.id, v1.id), /predate/);
  subs.addFiles(M.a, s.id, [file("v2.txt")]);
  const again = subs.submit(M.a, s.id);
  assert.equal(again.current_version, 2);
  assert.deepEqual(again.files.map((f) => f.version), [1, 2]);
  assert.equal(subs.review(M.tl, s.id, { decision: "acceptat" }).status, "acceptat");
  assert.throws(() => subs.review(M.ht, s.id, { decision: "acceptat" }), /predate/);
});

test("files added after submitting join the submitted version; unsubmit reopens it as a draft", () => {
  const extra = assignments.create(M.ht, { title: "Extra", mode: "individual", target_type: "departament", target_dept: "tehnic" });
  const s = subOf(extra, M.b.id);
  subs.addFiles(M.b, s.id, [file("a.txt")]);
  subs.submit(M.b, s.id);
  const added = subs.addFiles(M.b, s.id, [file("forgot.txt")]);
  assert.deepEqual(added.files.map((f) => f.version), [1, 1]);
  assert.equal(added.status, "predat");
  assert.throws(() => subs.unsubmit(M.a, s.id), /Nu lucrezi/);
  const back = subs.unsubmit(M.b, s.id);
  assert.equal(back.status, "de_facut");
  assert.equal(back.current_version, 0);
  assert.equal(back.submitted_at, null);
  subs.removeFile(M.b, s.id, back.files[1].id);
  assert.throws(() => subs.unsubmit(M.b, s.id), /neverificată/);
  assert.equal(subs.submit(M.b, s.id).current_version, 1);
  subs.review(M.ht, s.id, { decision: "acceptat" });
  assert.throws(() => subs.unsubmit(M.b, s.id), /neverificată/);
  assert.throws(() => subs.addFiles(M.b, s.id, [file("late.txt")]), /acceptată/);
});

test("unsubmit after a redo request returns to de_refacut", () => {
  const redo = assignments.create(M.ht, { title: "Redo", mode: "individual", target_type: "departament", target_dept: "tehnic" });
  const s = subOf(redo, M.b.id);
  subs.addFiles(M.b, s.id, [file("v1.txt")]);
  subs.submit(M.b, s.id);
  subs.review(M.ht, s.id, { decision: "de_refacut", comment: "Mai mult" });
  subs.addFiles(M.b, s.id, [file("v2.txt")]);
  subs.submit(M.b, s.id);
  const back = subs.unsubmit(M.b, s.id);
  assert.equal(back.status, "de_refacut");
  assert.equal(back.current_version, 1);
});

test("draft files can be deleted before submitting", () => {
  const s = subOf(indiv, M.b.id);
  const d = subs.addFiles(M.b, s.id, [file("oops.txt")]);
  assert.equal(subs.removeFile(M.b, s.id, d.files[0].id).files.length, 0);
});

test("group: any member works, to-do assignment notifies, outsiders blocked", () => {
  const s = subOf(group, null);
  const todoId = group.todos[0].id;
  const d = subs.toggleTodo(M.a, s.id, todoId, { assignee_member_id: M.b.id });
  assert.equal(d.todos[0].assignee_name, M.b.full_name);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE member_id = ? AND title LIKE 'Ai primit%'").get(M.b.id));
  assert.throws(() => subs.toggleTodo(M.a, s.id, todoId, { assignee_member_id: M.nt.id }), /grupului/);
  assert.deepEqual(subs.myTodos(M.b).map((t) => t.text), ["Pas comun"]);
  subs.toggleTodo(M.b, s.id, todoId, { done: true });
  assert.deepEqual(subs.myTodos(M.b), []);
  assert.equal(subs.submit(M.b, s.id).submitted_by_name, M.b.full_name);
  assert.throws(() => subs.toggleTodo(M.nt, s.id, todoId, { done: false }), /Nu lucrezi/);
});

test("closed assignment blocks work", () => {
  const a = assignments.create(M.ht, { title: "Closed", mode: "individual", target_type: "departament", target_dept: "tehnic" });
  assignments.close(M.ht, a.id);
  const s = subOf(a, M.a.id);
  assert.throws(() => subs.addFiles(M.a, s.id, [file("x.txt")]), /închisă/);
});

test("review notifies the member", () => {
  const n = db.prepare("SELECT title FROM notifications WHERE member_id = ? AND type = 'assignment' ORDER BY id").all(M.a.id).map((r) => r.title);
  assert.ok(n.includes("Temă de refăcut"));
  assert.ok(n.includes("Temă acceptată"));
});

test("myTodos hides points of members who left the group or whose work was submitted", () => {
  const g2 = groups.create(M.ht, { name: "G2", department: "tehnic" });
  groups.setMembers(M.ht, g2.id, [{ member_id: M.a.id }, { member_id: M.b.id }]);
  const a2 = assignments.create(M.ht, { title: "Grup2", mode: "grup", target_type: "grup", target_team_id: g2.id, todos: ["Punct"] });
  const s = subOf(a2, null);
  subs.toggleTodo(M.a, s.id, a2.todos[0].id, { assignee_member_id: M.b.id });
  assert.deepEqual(subs.myTodos(M.b).map((t) => t.text), ["Punct"]);
  groups.removeMember(M.ht, g2.id, M.b.id);
  assert.deepEqual(subs.myTodos(M.b), []);
  groups.addMember(M.ht, g2.id, M.b.id, "member");
  assert.equal(subs.myTodos(M.b).length, 1);
  subs.addFiles(M.a, s.id, [file("w.txt")]);
  subs.submit(M.a, s.id);
  assert.deepEqual(subs.myTodos(M.b), []);
});
