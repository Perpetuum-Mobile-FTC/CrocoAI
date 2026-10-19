const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers } = require("./_assign-env");
const env = initEnv("assignments");
const db = require("../src/db");
const groups = require("../src/services/groups");
const assignments = require("../src/services/assignments");
const files = require("../src/services/assignment-files");

let M, grp;
const file = (name, size = 10) => ({ originalname: name, buffer: Buffer.alloc(size, 1), size, mimetype: "application/pdf" });

before(() => {
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "mentor", role: "mentor" },
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "t1", role: "member", department: "tehnic" },
    { key: "t2", role: "member", department: "ambele" },
    { key: "nt", role: "member", department: "non-tehnic" },
    { key: "paused", role: "member", department: "tehnic", status: "pauza" },
    { key: "gl", role: "member", department: "tehnic" },
  ]);
  grp = groups.create(M.ht, { name: "Programare", department: "tehnic" });
  groups.setMembers(M.ht, grp.id, [{ member_id: M.gl.id, role: "leader" }, { member_id: M.t1.id, role: "member" }]);
});
after(() => { db.close(); env.cleanup(); });

test("individual department assignment: recipients = active tehnic + ambele members, without creator/leaders/mentor/paused", () => {
  const a = assignments.create(M.ht, { title: "CAD intake", mode: "individual", target_type: "departament", target_dept: "tehnic", todos: ["Schiță", "Model"] }, [file("brief.pdf")]);
  const memberIds = a.submissions.map((s) => s.member_id).sort();
  assert.deepEqual(memberIds, [M.t1.id, M.t2.id, M.gl.id].sort());
  assert.equal(a.target_label, "Departament Tehnic");
  assert.equal(a.materials.length, 1);
  assert.equal(a.submissions[0].todos.length, 2);
  assert.equal(a.progress.total, 3);
});

test("group mode creates exactly one submission and is visible to group members only", () => {
  const a = assignments.create(M.gl, { title: "Autonomie", mode: "grup", target_type: "grup", target_team_id: grp.id, todos: JSON.stringify(["Traiectorie"]) });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM submissions WHERE assignment_id = ?").get(a.id).c, 1);
  assert.ok(assignments.get(M.t1, a.id).my_submission);
  assert.throws(() => assignments.get(M.nt, a.id), /acces/);
});

test("validation: group mode needs a group, head cannot target the other department, member cannot create", () => {
  assert.throws(() => assignments.create(M.tl, { title: "x", mode: "grup", target_type: "departament", target_dept: "tehnic" }), /grup/);
  assert.throws(() => assignments.create(M.ht, { title: "x", mode: "individual", target_type: "departament", target_dept: "non-tehnic" }), /destinații/);
  assert.throws(() => assignments.create(M.t1, { title: "x", mode: "individual", target_type: "grup", target_team_id: grp.id }), /destinații/);
  assert.throws(() => assignments.create(M.tl, { title: " ", mode: "individual", target_type: "departament", target_dept: "tehnic" }), /Titlul/);
  assert.throws(() => assignments.create(M.tl, { title: "x", mode: "individual", target_type: "departament", target_dept: "tehnic", due_at: "nu e dată" }), /Termen invalid/);
});

test("mentor gives assignments anywhere but cannot manage someone else's", () => {
  const a = assignments.create(M.mentor, { title: "Outreach", mode: "individual", target_type: "departament", target_dept: "non-tehnic" });
  assert.deepEqual(a.submissions.map((s) => s.member_id).sort(), [M.nt.id, M.t2.id].sort(), "non-tehnic + ambele");
  const other = assignments.list(M.tl, { scope: "given" })[0] || assignments.create(M.tl, { title: "TL", mode: "individual", target_type: "departament", target_dept: "tehnic" });
  assert.throws(() => assignments.close(M.mentor, other.id), /permisiunea|cine a dat/);
});

test("list scopes: mine / given / all", () => {
  const mine = assignments.list(M.t1, { scope: "mine", status: "activa" });
  assert.ok(mine.every((x) => x.my_submission));
  assert.ok(mine.length >= 2);
  assert.ok(assignments.list(M.ht, { scope: "given" }).every((x) => x.created_by === M.ht.id));
  assert.throws(() => assignments.list(M.t1, { scope: "all" }), /liderii/);
  assert.ok(assignments.list(M.mentor, { scope: "all" }).length >= 3);
});

test("allowedTargets reflects the policy", () => {
  assert.deepEqual(assignments.allowedTargets(M.ht).departments, ["tehnic"]);
  assert.deepEqual(assignments.allowedTargets(M.gl).departments, []);
  assert.deepEqual(assignments.allowedTargets(M.gl).groups.map((g) => g.id), [grp.id]);
  assert.deepEqual(assignments.allowedTargets(M.t2), { departments: [], groups: [] });
});

test("addNewMembers creates submissions for members who joined later", () => {
  const a = assignments.create(M.ht, { title: "Late join", mode: "individual", target_type: "grup", target_team_id: grp.id });
  assert.equal(a.submissions.length, 2);
  groups.setMembers(M.ht, grp.id, [{ member_id: M.gl.id, role: "leader" }, { member_id: M.t1.id }, { member_id: M.t2.id }]);
  assert.deepEqual(assignments.addNewMembers(M.ht, a.id), { added: 1 });
  assert.deepEqual(assignments.addNewMembers(M.ht, a.id), { added: 0 });
});

test("update resets reminder flags when due date changes; close blocks nothing for reading", () => {
  const a = assignments.create(M.tl, { title: "Due", mode: "individual", target_type: "departament", target_dept: "tehnic", due_at: "2030-01-01T10:00:00Z" });
  db.prepare("UPDATE assignments SET reminded_due = 1 WHERE id = ?").run(a.id);
  const u = assignments.update(M.tl, a.id, { due_at: "2030-02-01T10:00:00Z" });
  assert.equal(u.due_at, "2030-02-01T10:00:00.000Z");
  assert.equal(db.prepare("SELECT reminded_due FROM assignments WHERE id = ?").get(a.id).reminded_due, 0);
  assert.equal(assignments.close(M.tl, a.id).status, "inchisa");
  assert.equal(assignments.get(M.t1, a.id).status, "inchisa");
});

test("remove deletes rows and files while nothing is submitted", () => {
  const a = assignments.create(M.tl, { title: "Del", mode: "individual", target_type: "departament", target_dept: "tehnic" }, [file("x.pdf")]);
  const dir = path.join(process.env.ASSIGNMENTS_DIR, String(a.id));
  assert.ok(fs.existsSync(dir));
  assignments.remove(M.tl, a.id);
  assert.ok(!fs.existsSync(dir));
  assert.throws(() => assignments.get(M.tl, a.id), /negăsită/);
});

test("new assignment notifies recipients in-app (creator excluded)", () => {
  const a = assignments.create(M.tl, { title: "Notif", mode: "individual", target_type: "departament", target_dept: "non-tehnic" });
  const n = db.prepare("SELECT member_id FROM notifications WHERE type = 'assignment' AND link = ?").all(`/teme/${a.id}`).map((r) => r.member_id);
  assert.deepEqual(n.sort(), [M.nt.id, M.t2.id].sort());
});

test("files: absPath refuses traversal, originalName repairs latin1-decoded UTF-8, size limit", () => {
  assert.throws(() => files.absPath("../../crocoai.db"), /negăsit/);
  const latin1 = Buffer.from("Temă.pdf", "utf8").toString("latin1");
  assert.equal(files.originalName({ originalname: latin1 }), "Temă.pdf");
  assert.equal(files.originalName({ originalname: "plain.pdf" }), "plain.pdf");
  assert.equal(files.originalName({ originalname: "Temă.pdf" }), "Temă.pdf");
  assert.equal(files.originalName({ originalname: "Ștefan schiță.docx" }), "Ștefan schiță.docx");
  assert.throws(() => files.check({ buffer: Buffer.alloc(1), size: files.MAX_SIZE + 1 }), /max 25 MB/);
});

test("remove does not throw when deleting the files directory fails", () => {
  const a = assignments.create(M.tl, { title: "DelErr", mode: "individual", target_type: "departament", target_dept: "tehnic" });
  const real = files.removeAssignmentDir, realErr = console.error;
  files.removeAssignmentDir = () => { throw new Error("disk"); };
  console.error = () => {};
  try { assert.doesNotThrow(() => assignments.remove(M.tl, a.id)); }
  finally { files.removeAssignmentDir = real; console.error = realErr; }
  assert.throws(() => assignments.get(M.tl, a.id), /negăsită/);
});
