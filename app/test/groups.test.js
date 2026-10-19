const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("groups");
const { server } = require("../server");
const db = require("../src/db");
const groups = require("../src/services/groups");

let M, BASE;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "tech", role: "member", department: "tehnic" },
    { key: "both", role: "member", department: "ambele" },
    { key: "nontech", role: "member", department: "non-tehnic" },
  ]);
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

test("head_tech creates a tehnic group with tehnic/ambele members", () => {
  const g = groups.create(M.ht, { name: "Programare", department: "tehnic" });
  const full = groups.setMembers(M.ht, g.id, [{ member_id: M.tech.id, role: "leader" }, { member_id: M.both.id, role: "member" }]);
  assert.equal(full.members.length, 2);
  assert.equal(full.members.find((m) => m.id === M.tech.id).role, "leader");
  assert.equal(full.created_by, M.ht.id);
});

test("head_tech cannot add a non-tehnic member or create a mixt group", () => {
  const g = groups.create(M.ht, { name: "CAD", department: "tehnic" });
  assert.throws(() => groups.setMembers(M.ht, g.id, [{ member_id: M.nontech.id, role: "member" }]), /departamentul tău/);
  assert.throws(() => groups.create(M.ht, { name: "Mix", department: "mixt" }), /departamentul tău/);
});

test("team leader creates a mixt group with anyone", () => {
  const g = groups.create(M.tl, { name: "Eveniment", department: "mixt" });
  const full = groups.setMembers(M.tl, g.id, [{ member_id: M.tech.id }, { member_id: M.nontech.id }]);
  assert.equal(full.members.length, 2);
});

test("members only see their own groups; managers see all", () => {
  const mine = groups.list(M.nontech).map((g) => g.name);
  assert.deepEqual(mine, ["Eveniment"]);
  assert.ok(groups.list(M.ht).length >= 3);
  const other = groups.list(M.ht).find((g) => g.name === "Programare");
  assert.throws(() => groups.get(M.nontech, other.id), /acces/);
});

test("invalid name / department rejected", () => {
  assert.throws(() => groups.create(M.tl, { name: " " }), /obligatoriu/);
  assert.throws(() => groups.create(M.tl, { name: "x", department: "altul" }), /invalid/);
});

test("HTTP: POST /api/groups + PUT members, legacy /api/teams applies department rules", async () => {
  const cookie = await login(BASE, M.ht.phone);
  const res = await fetch(`${BASE}/api/groups`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: "Electronică", department: "tehnic" }) });
  assert.equal(res.status, 200);
  const g = await res.json();
  const put = await fetch(`${BASE}/api/groups/${g.id}/members`, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ members: [{ member_id: M.nontech.id, role: "member" }] }) });
  assert.equal(put.status, 403);
  const legacy = await fetch(`${BASE}/api/teams`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: "Legacy" }) });
  assert.equal(legacy.status, 403, "head_tech cannot create a mixt team through the legacy route");
});

test("refusal message says why when the group already has off-department members", () => {
  const g = groups.create(M.tl, { name: "MixtHT", department: "tehnic" });
  groups.setMembers(M.tl, g.id, [{ member_id: M.nontech.id }]);
  assert.throws(() => groups.addMember(M.ht, g.id, M.tech.id, "member"), /conține membri din alt departament/);
  const g2 = groups.create(M.ht, { name: "Clean", department: "tehnic" });
  assert.throws(() => groups.setMembers(M.ht, g2.id, [{ member_id: M.nontech.id }]), /departamentul tău/);
});

test("legacy /api/teams keeps its shape but follows group visibility", async () => {
  const g = groups.create(M.tl, { name: "Legacy", department: "mixt" });
  groups.setMembers(M.tl, g.id, [{ member_id: M.tech.id, role: "leader" }, { member_id: M.both.id }]);
  const get = async (phone, url) => (await fetch(`${BASE}${url}`, { headers: { cookie: await login(BASE, phone) } }));
  const list = await (await get(M.tech.phone, "/api/teams")).json();
  const item = list.find((t) => t.id === g.id);
  assert.deepEqual(Object.keys(item).sort(), ["description", "id", "leaders", "member_count", "name"]);
  assert.equal(item.member_count, 2);
  assert.deepEqual(item.leaders.map((l) => l.id), [M.tech.id]);
  assert.ok(!list.some((t) => t.name === "Programare" && !groups.get(M.tl, t.id).members.some((m) => m.id === M.tech.id)));
  assert.equal((await get(M.nontech.phone, `/api/teams/${g.id}`)).status, 403);
  const det = await (await get(M.tech.phone, `/api/teams/${g.id}`)).json();
  assert.deepEqual(Object.keys(det).sort(), ["description", "id", "members", "name"]);
  assert.deepEqual(Object.keys(det.members[0]).sort(), ["id", "name", "role"]);
});
