// Curățenie F2 item 1: one audience module (domain/audience.js pure + services/audience.js DB).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers } = require("./_assign-env");
const env = initEnv("f2_audience");

const db = require("../src/db");
const policy = require("../src/domain/policy");
const dom = require("../src/domain/audience");
const audience = require("../src/services/audience");
const groups = require("../src/services/groups");

let M;
before(() => {
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "tlp", role: "team_leader", status: "pauza" },
    { key: "co", role: "co_leader" },
    { key: "cop", role: "co_leader", status: "pauza" },
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "hn", role: "head_nontech", department: "non-tehnic" },
    { key: "hnp", role: "head_nontech", department: "non-tehnic", status: "pauza" },
    { key: "m", role: "member", department: "tehnic" },
  ]);
});
after(() => { db.close(); env.cleanup(); });

const ids = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);
const only = (rows) => ids(rows).filter((id) => Object.values(M).some((m) => m.id === id));

test("domain/audience: head roles come from policy.HEAD_DEPT (single source)", () => {
  for (const [role, dept] of Object.entries(policy.HEAD_DEPT)) assert.equal(dom.HEAD_ROLE[dept], role);
  assert.deepEqual(dom.headRolesFor("tehnic"), ["head_tech"]);
  assert.deepEqual(dom.headRolesFor("non-tehnic"), ["head_nontech"]);
  assert.deepEqual(dom.headRolesFor("ambele").sort(), ["head_nontech", "head_tech"]);
  // NULL / unknown department: both heads (used to fall through to head_nontech only)
  assert.deepEqual(dom.headRolesFor(null).sort(), ["head_nontech", "head_tech"]);
  assert.equal(dom.resolveDept("tehnic", "mixt"), "tehnic");
  assert.equal(dom.resolveDept(null, "mixt"), "mixt");
  assert.equal(dom.resolveDept(null, undefined), null);
});

test("services/audience: recipients are active (policy) only", () => {
  assert.deepEqual(only(audience.activeLeaders()), ids([M.tl, M.co]));
  assert.deepEqual(only(audience.activeTeamLeaders()), ids([M.tl]));
  assert.deepEqual(audience.leaderIds().filter((id) => [M.tlp.id, M.cop.id].includes(id)), []);
  assert.deepEqual(only(audience.headsFor("tehnic")), ids([M.ht]));
  assert.deepEqual(only(audience.headsFor("non-tehnic")), ids([M.hn]));
  assert.deepEqual(only(audience.headsFor("ambele")), ids([M.ht, M.hn]));
  assert.deepEqual(only(audience.headsFor(null)), ids([M.ht, M.hn]));
  assert.deepEqual(only(audience.membersWhoCan("registration.limit_alert")), ids([M.tl]));
});

test("services/audience: department of a session / assignment / group info", () => {
  const g = groups.create(M.tl, { name: "Mix", department: "mixt" });
  groups.setMembers(M.tl, g.id, [{ member_id: M.m.id, role: "leader" }]);
  assert.equal(audience.sessionDept({ target_dept: "tehnic", team_id: null }), "tehnic");
  assert.equal(audience.sessionDept({ target_dept: null, team_id: g.id }), "mixt");
  assert.equal(audience.sessionDept({ target_dept: null, team_id: null }), null);
  assert.equal(audience.assignmentDept({ target_type: "departament", target_dept: "non-tehnic" }), "non-tehnic");
  assert.equal(audience.assignmentDept({ target_type: "grup", target_team_id: g.id }), "mixt");
  const info = audience.teamInfo(g.id);
  assert.equal(info.name, "Mix");
  assert.deepEqual(info.leader_ids, [M.m.id]);
  assert.equal(audience.teamInfo(999999), null);
});

test("no service keeps its own copy of the audience helpers", () => {
  const dir = path.join(__dirname, "..", "src", "services");
  for (const f of fs.readdirSync(dir)) {
    if (f === "audience.js") continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(src, /function (teamInfo|sessionDept|assignmentDept)\b/, f);
    assert.doesNotMatch(src, /deptFilter|HEAD_OF\b/, f);
    assert.doesNotMatch(src, /const DEPT_LABEL = /, f);
    assert.doesNotMatch(src, /FROM members WHERE role IN \('team_leader',\s*'co_leader'\)/, f);
  }
});

test("document upload notifies only active leaders", () => {
  const documents = require("../src/services/documents");
  const before = db.prepare("SELECT MAX(id) m FROM notifications").get().m || 0;
  documents.upload(M.m, M.m.id, "anexa6_regulament", { originalname: "a.pdf", mimetype: "application/pdf", size: 8, buffer: Buffer.from("%PDF-1.4") });
  const got = db.prepare("SELECT member_id FROM notifications WHERE id > ? AND type = 'document_uploaded'").all(before).map((r) => r.member_id);
  assert.ok(got.includes(M.tl.id) && got.includes(M.co.id));
  assert.ok(!got.includes(M.tlp.id) && !got.includes(M.cop.id), "paused leaders get nothing");
});
