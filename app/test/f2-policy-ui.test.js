// Curățenie F2 item 7: no role lists left in the UI; account edits / role changes / submission reads go
// through named policy actions; Grupuri gets the creatable departments from the server.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("f2_policy_ui");

const { server } = require("../server");
const db = require("../src/db");
const members = require("../src/services/members");

let BASE, M;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" }, { key: "co", role: "co_leader" }, { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "mentor", role: "mentor" }, { key: "m", role: "member" }, { key: "tlp", role: "team_leader", status: "pauza" },
  ]);
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("GET /api/groups/departments mirrors groups.manage per department", async () => {
  const expected = { tl: ["tehnic", "non-tehnic", "mixt"], co: ["tehnic", "non-tehnic", "mixt"], mentor: ["tehnic", "non-tehnic", "mixt"], ht: ["tehnic"], m: [], tlp: [] };
  for (const [k, depts] of Object.entries(expected)) {
    const cookie = await login(BASE, M[k].phone);
    const res = await fetch(`${BASE}/api/groups/departments`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).departments, depts, k);
  }
});

test("front-end: sections.js and grupuri.js hold no role lists", () => {
  for (const f of ["public/js/sections.js", "public/js/pages/grupuri.js"]) {
    assert.doesNotMatch(read(f), /team_leader|co_leader|head_tech|head_nontech|"mentor"/, f);
  }
});

test("services: members.js and assignments.js compose no isSelf inline", () => {
  for (const f of ["src/services/members.js", "src/services/assignments.js"]) assert.doesNotMatch(read(f), /\bisSelf\b/, f);
});

test("members: account edits and role changes keep their refusals (members.edit_account / members.change_role)", () => {
  const actor = (k) => db.prepare("SELECT * FROM members WHERE id = ?").get(M[k].id);
  assert.throws(() => members.update(actor("co"), M.mentor.id, { email: "x@y.ro" }), /Doar Team Leader-ul/);
  assert.doesNotThrow(() => members.update(actor("co"), M.m.id, { email: "m@y.ro" }));
  assert.doesNotThrow(() => members.update(actor("co"), M.co.id, { email: "co@y.ro" }), "own fields");
  assert.throws(() => members.update(actor("co"), M.co.id, { role: "member" }), /Nu îți poți schimba singur rolul/);
  assert.doesNotThrow(() => members.update(actor("co"), M.m.id, { role: "volunteer" }));
});
