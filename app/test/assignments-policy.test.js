// Permission matrix for Teme & Grupuri (design-teme-grupuri.md §2).
const { test } = require("node:test");
const assert = require("node:assert");
const { can, ROLES } = require("../src/domain/policy");

const a = (role, extra) => ({ id: 7, role, status: "activ", ...extra });
const ALL = Object.keys(ROLES);

test("groups.view_all -> LEADERS, mentor, heads", () => {
  for (const r of ALL) assert.equal(can(a(r), "groups.view_all"), ["team_leader", "co_leader", "mentor", "head_tech", "head_nontech"].includes(r), r);
});

test("groups.manage: global roles any department, heads only their own", () => {
  for (const r of ["team_leader", "co_leader", "mentor"]) assert.ok(can(a(r), "groups.manage", { department: "mixt", member_departments: ["tehnic", "non-tehnic"] }), r);
  assert.ok(can(a("head_tech"), "groups.manage", { department: "tehnic", member_departments: ["tehnic", "ambele"] }));
  assert.equal(can(a("head_tech"), "groups.manage", { department: "non-tehnic" }), false);
  assert.equal(can(a("head_tech"), "groups.manage", { department: "mixt" }), false);
  assert.equal(can(a("head_tech"), "groups.manage", { department: "tehnic", member_departments: ["non-tehnic"] }), false);
  assert.ok(can(a("head_nontech"), "groups.manage", { department: "non-tehnic" }));
  assert.equal(can(a("member"), "groups.manage", { department: "tehnic" }), false);
  assert.equal(can(a("member"), "groups.manage"), false);
});

test("assignments.create: departments", () => {
  const dept = (d) => ({ target_type: "departament", target_dept: d });
  for (const r of ["team_leader", "co_leader", "mentor"]) {
    assert.ok(can(a(r), "assignments.create", dept("tehnic")), r);
    assert.ok(can(a(r), "assignments.create", dept("non-tehnic")), r);
  }
  assert.ok(can(a("head_tech"), "assignments.create", dept("tehnic")));
  assert.equal(can(a("head_tech"), "assignments.create", dept("non-tehnic")), false);
  assert.ok(can(a("head_nontech"), "assignments.create", dept("non-tehnic")));
  assert.equal(can(a("member"), "assignments.create", dept("tehnic")), false);
});

test("assignments.create: groups and group leaders", () => {
  const grp = (department, leader_ids = []) => ({ target_type: "grup", team: { department, leader_ids } });
  assert.ok(can(a("head_tech"), "assignments.create", grp("tehnic")));
  assert.equal(can(a("head_tech"), "assignments.create", grp("mixt")), false);
  assert.ok(can(a("member", { id: 7 }), "assignments.create", grp("mixt", [7])));
  assert.equal(can(a("member", { id: 7 }), "assignments.create", grp("mixt", [8])), false);
  assert.equal(can(a("member", { id: 7, status: "pauza" }), "assignments.create", grp("mixt", [7])), false);
});

test("assignments.manage: creator or LEADERS", () => {
  const row = { created_by: 7 };
  assert.ok(can(a("member", { id: 7 }), "assignments.manage", row));
  assert.ok(can(a("team_leader", { id: 1 }), "assignments.manage", row));
  assert.ok(can(a("co_leader", { id: 1 }), "assignments.manage", row));
  assert.equal(can(a("mentor", { id: 1 }), "assignments.manage", row), false);
  assert.equal(can(a("head_tech", { id: 1 }), "assignments.manage", row), false);
});

test("assignments.view_all -> LEADERS + mentor (heads only via view_dept)", () => {
  for (const r of ALL) assert.equal(can(a(r), "assignments.view_all"), ["team_leader", "co_leader", "mentor"].includes(r), r);
});

test("assignments.view_dept: head of the matching department only", () => {
  assert.ok(can(a("head_nontech"), "assignments.view_dept", { dept: "non-tehnic" }));
  assert.equal(can(a("head_nontech"), "assignments.view_dept", { dept: "tehnic" }), false);
  assert.equal(can(a("head_nontech"), "assignments.view_dept", { dept: null }), false);
  assert.ok(can(a("head_tech"), "assignments.view_dept", { dept: "tehnic" }));
  assert.equal(can(a("head_tech"), "assignments.view_dept", { dept: "non-tehnic" }), false);
  for (const r of ["team_leader", "co_leader", "mentor", "member", "volunteer", "alumni"]) {
    assert.equal(can(a(r), "assignments.view_dept", { dept: "tehnic" }), false, r);
  }
});

test("assignments.review: creator, LEADERS or head of the assignment department", () => {
  const t = (dept, created_by = 99) => ({ created_by, dept });
  assert.ok(can(a("member", { id: 7 }), "assignments.review", t("tehnic", 7)));
  assert.ok(can(a("team_leader"), "assignments.review", t(null)));
  assert.ok(can(a("co_leader"), "assignments.review", t("tehnic")));
  assert.ok(can(a("head_nontech"), "assignments.review", t("non-tehnic")));
  assert.equal(can(a("head_nontech"), "assignments.review", t("tehnic")), false);
  assert.equal(can(a("head_nontech"), "assignments.review", t(null)), false);
  assert.equal(can(a("mentor"), "assignments.review", t("tehnic")), false);
  assert.equal(can(a("member"), "assignments.review", t("tehnic")), false);
});

test("submissions.work: owner (individual), group member (grup), only while activa", () => {
  const me = a("member", { id: 7 });
  assert.ok(can(me, "submissions.work", { status: "activa", mode: "individual", member_id: 7 }));
  assert.equal(can(me, "submissions.work", { status: "activa", mode: "individual", member_id: 8 }), false);
  assert.ok(can(me, "submissions.work", { status: "activa", mode: "grup", member_id: null, is_group_member: true }));
  assert.equal(can(me, "submissions.work", { status: "activa", mode: "grup", member_id: null, is_group_member: false }), false);
  assert.equal(can(me, "submissions.work", { status: "inchisa", mode: "individual", member_id: 7 }), false);
});
