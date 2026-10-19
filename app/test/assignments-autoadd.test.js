// Self-registration auto-adds the member to open department-wide individual assignments.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initEnv, makeMembers } = require("./_assign-env");
const env = initEnv("assignments_autoadd");
const db = require("../src/db");
const assignments = require("../src/services/assignments");
const groups = require("../src/services/groups");
const registration = require("../src/services/registration");

let M, seq = 0, open, closed, groupMode, groupTarget, tehnicA;

// Two steps since security package A3: start() sends the WhatsApp code (mocked gateway), verify() creates the account.
async function reg(over = {}) {
  seq++;
  const ip = `10.1.1.${seq}`;
  const { pending_id } = await registration.start({
    role_choice: "membru", full_name: "Ana Popescu", phone: `4074${String(1000000 + seq)}`,
    username: `auto.user${seq}`, password: "parola1234", password_confirm: "parola1234",
    email: `auto${seq}@eminescusm.ro`, school: "CN Mihai Eminescu", class: "a XI-a B",
    birthdate: "2008-01-01", department: "non-tehnic", gdpr_ack: true, ...over,
  }, ip);
  const code = env.waSent[env.waSent.length - 1].text.match(/\b(\d{6})\b/)[1];
  return registration.verify(pending_id, code, ip);
}
const subs = (aid, mid) => db.prepare("SELECT * FROM submissions WHERE assignment_id = ? AND member_id = ?").all(aid, mid);
const notifs = (mid) => db.prepare("SELECT * FROM notifications WHERE member_id = ? AND title = 'Temă nouă'").all(mid);

before(() => {
  M = makeMembers(db, [{ key: "tl", role: "team_leader" }]);
  const dept = (title, dept) => assignments.create(M.tl, { title, mode: "individual", target_type: "departament", target_dept: dept });
  open = dept("Deschisă NT", "non-tehnic");
  tehnicA = dept("Deschisă T", "tehnic");
  closed = dept("Închisă NT", "non-tehnic");
  assignments.close(M.tl, closed.id);
  const team = groups.create(M.tl, { name: "Grup auto", department: "non-tehnic" }).id;
  groupMode = assignments.create(M.tl, { title: "Grup mod", mode: "grup", target_type: "grup", target_team_id: team });
  groupTarget = assignments.create(M.tl, { title: "Individual pe grup", mode: "individual", target_type: "grup", target_team_id: team });
});
after(() => { db.close(); env.cleanup(); });

test("non-tehnic registrant gets open dept assignment + 'Temă nouă' notification", async () => {
  const m = await reg();
  assert.equal(subs(open.id, m.id).length, 1);
  assert.equal(notifs(m.id).length, 1);
  assert.equal(subs(tehnicA.id, m.id).length, 0);
});

test("tehnic registrant does not get the non-tehnic assignment", async () => {
  const m = await reg({ department: "tehnic" });
  assert.equal(subs(open.id, m.id).length, 0);
  assert.equal(subs(tehnicA.id, m.id).length, 1);
});

test("leadership choice (role member + requested_role) does NOT get it", async () => {
  const m = await reg({ role_choice: "head_nontech", department: "non-tehnic" });
  assert.equal(m.role, "member");
  assert.ok(m.requested_role);
  assert.equal(subs(open.id, m.id).length, 0);
  assert.equal(notifs(m.id).length, 0);
});

test("rejected role request: member is then added to open assignments", async () => {
  const m = await reg({ role_choice: "head_nontech", department: "non-tehnic" });
  assert.equal(subs(open.id, m.id).length, 0);
  registration.decideRoleRequest(M.tl, m.id, false);
  assert.equal(subs(open.id, m.id).length, 1);
  assert.equal(notifs(m.id).length, 1);
});

test("creation time: member with requested_role is not a recipient", async () => {
  const m = await reg({ role_choice: "head_nontech", department: "non-tehnic" });
  const a = assignments.create(M.tl, { title: "Nou NT", mode: "individual", target_type: "departament", target_dept: "non-tehnic" });
  assert.equal(subs(a.id, m.id).length, 0);
  const plain = await reg();
  assert.equal(subs(a.id, plain.id).length, 1);
});

test("closed and group assignments are not auto-added", async () => {
  const m = await reg();
  assert.equal(subs(closed.id, m.id).length, 0);
  assert.equal(subs(groupMode.id, m.id).length, 0);
  assert.equal(subs(groupTarget.id, m.id).length, 0);
});

test("registration succeeds even if addMemberToOpenAssignments throws", async () => {
  const orig = assignments.addMemberToOpenAssignments;
  const err = console.error; const logged = [];
  assignments.addMemberToOpenAssignments = () => { throw new Error("boom"); };
  console.error = (...a) => logged.push(a.join(" "));
  try {
    const m = await reg();
    assert.ok(m.id);
    assert.ok(logged.some((l) => l.includes("[REGISTER] assignments: boom")));
  } finally { assignments.addMemberToOpenAssignments = orig; console.error = err; }
});
