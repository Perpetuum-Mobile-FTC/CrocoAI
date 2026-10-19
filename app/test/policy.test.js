// Full permission matrix (design v2 §4, §11): every role x every action.
const { test } = require("node:test");
const assert = require("node:assert");
const { can, ROLES } = require("../src/domain/policy");

const ALL_ROLES = Object.keys(ROLES);
const LEADERS = ["team_leader", "co_leader"];
const MANAGERS = [...LEADERS, "head_tech", "head_nontech"];
const OVERSIGHT = [...MANAGERS, "mentor"];

function actor(role, extra) {
  return { id: 1, role, status: "activ", ...extra };
}

function expectGroup(action, allowedRoles) {
  for (const role of ALL_ROLES) {
    const expected = allowedRoles.includes(role);
    assert.equal(can(actor(role), action), expected, `${action} / ${role} should be ${expected}`);
  }
}

test("members.manage -> LEADERS only", () => expectGroup("members.manage", LEADERS));
test("attendance.mark -> MANAGERS", () => expectGroup("attendance.mark", MANAGERS));
test("attendance.view_all -> OVERSIGHT", () => expectGroup("attendance.view_all", OVERSIGHT));
test("absence.decide -> MANAGERS", () => expectGroup("absence.decide", MANAGERS));
test("warnings.record -> LEADERS", () => expectGroup("warnings.record", LEADERS));
test("tasks.assign -> MANAGERS", () => expectGroup("tasks.assign", MANAGERS));
test("events.manage -> MANAGERS", () => expectGroup("events.manage", MANAGERS));
test("reminders.create_other -> MANAGERS", () => expectGroup("reminders.create_other", MANAGERS));
test("whatsapp.send -> LEADERS", () => expectGroup("whatsapp.send", LEADERS));
test("messages.view -> LEADERS", () => expectGroup("messages.view", LEADERS));
test("wa_groups.manage -> LEADERS", () => expectGroup("wa_groups.manage", LEADERS));
test("documents.review -> LEADERS", () => expectGroup("documents.review", LEADERS));
test("ai_usage.view -> LEADERS", () => expectGroup("ai_usage.view", LEADERS));
test("members.view_contacts -> OVERSIGHT (of others)", () => expectGroup("members.view_contacts", OVERSIGHT));

test("events.manage_urgenta -> LEADERS + mentor (Art. 51.1), not department heads", () => expectGroup("events.manage_urgenta", [...LEADERS, "mentor"]));
test("events.manage_urgenta -> inactive mentor refused (Art. 51.1: mentor activ)", () => {
  assert.equal(can(actor("mentor", { status: "inactiv" }), "events.manage_urgenta"), false);
  assert.equal(can(actor("mentor", { status: "activ" }), "events.manage_urgenta"), true);
});

test("documents.medical_other -> team_leader + mentor (Art. 41.4)", () => expectGroup("documents.medical_other", ["team_leader", "mentor"]));
test("documents.medical_other -> inactive mentor refused", () => assert.equal(can(actor("mentor", { status: "iesit" }), "documents.medical_other"), false));
test("documents.medical_upload_other -> only team_leader (unchanged)", () => expectGroup("documents.medical_upload_other", ["team_leader"]));
test("documents.review stays LEADERS only (unchanged by Art. 41.4)", () => expectGroup("documents.review", LEADERS));

test("members.view_directory -> any authenticated member", () => {
  for (const role of ALL_ROLES) assert.equal(can(actor(role), "members.view_directory"), true);
});

test("regulament.read -> any authenticated member", () => {
  for (const role of ALL_ROLES) assert.equal(can(actor(role), "regulament.read"), true);
});

test("absence.request -> only active members", () => {
  assert.equal(can(actor("member", { status: "activ" }), "absence.request"), true);
  assert.equal(can(actor("member", { status: "pauza" }), "absence.request"), false);
  assert.equal(can(actor("member", { status: "iesit" }), "absence.request"), false);
});

// tasks.create_self was never checked by any service (anyone may create a task for themselves) - removed in F1.
test("reminders.create_self -> anyone authenticated", () => {
  for (const role of ALL_ROLES) assert.equal(can(actor(role), "reminders.create_self"), true);
});

test("can() throws on unknown action", () => {
  assert.throws(() => can(actor("member"), "not.a.real.action"));
});

test("tasks.edit_own -> only the creator of a task assigned to themselves", () => {
  const me = actor("member", { id: 7 });
  assert.equal(can(me, "tasks.edit_own", { created_by: 7, assigned_member_id: 7 }), true);
  assert.equal(can(me, "tasks.edit_own", { created_by: 1, assigned_member_id: 7 }), false, "assigned by a manager");
  assert.equal(can(me, "tasks.edit_own", { created_by: 7, assigned_member_id: 8 }), false);
  assert.equal(can(me, "tasks.edit_own", { created_by: null, assigned_member_id: 7 }), false, "migrated/legacy task");
});
