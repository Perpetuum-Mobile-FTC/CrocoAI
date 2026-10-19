// Tool <-> route parity for Teme (design v2 §11 rule) + scope includes platform assignments.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("assign_ai");
const { server } = require("../server");
const db = require("../src/db");
const { buildToolList } = require("../src/ai/tools");
const assignments = require("../src/services/assignments");
const { SCOPE_DESCRIPTION } = require("../src/domain/ai-policy");

let M, BASE, A;
async function toolsFor(member) {
  const list = await buildToolList({ actor: member, channel: "web", chatId: `web:${member.id}` });
  const byName = {};
  for (const t of list) byName[t.name] = (args) => t.handler(args, {});
  return byName;
}
const text = (r) => r.content[0].text;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "a", role: "member", department: "tehnic" },
    { key: "nt", role: "member", department: "non-tehnic" },
  ]);
  A = assignments.create(M.ht, { title: "Model CAD șasiu", mode: "individual", target_type: "departament", target_dept: "tehnic", todos: ["Schiță"], due_at: "2030-01-10T16:00:00Z" });
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

test("temele_mele lists the same assignments as GET /api/assignments?scope=mine&status=activa", async () => {
  const t = await toolsFor(M.a);
  const out = text(await t.temele_mele({}));
  const res = await (await fetch(`${BASE}/api/assignments?scope=mine&status=activa`, { headers: { Cookie: await login(BASE, M.a.phone) } })).json();
  for (const a of res) assert.ok(out.includes(`#${a.id}`) && out.includes(a.title), out);
});

test("detalii_tema shows my to-do; outsider gets the same refusal as the route", async () => {
  const mine = text(await (await toolsFor(M.a)).detalii_tema({ tema_id: A.id }));
  assert.match(mine, /Schiță/);
  const refused = await (await toolsFor(M.nt)).detalii_tema({ tema_id: A.id });
  assert.equal(refused.isError, true);
  const res = await fetch(`${BASE}/api/assignments/${A.id}`, { headers: { Cookie: await login(BASE, M.nt.phone) } });
  assert.equal(res.status, 403);
  assert.ok(text(refused).startsWith((await res.json()).error));
});

test("status_predari_tema: creator sees who has not submitted, a member is refused", async () => {
  const s = text(await (await toolsFor(M.ht)).status_predari_tema({ tema_id: A.id }));
  assert.match(s, new RegExp(M.a.full_name));
  const r = await (await toolsFor(M.a)).status_predari_tema({ tema_id: A.id });
  assert.equal(r.isError, true);
});

test("AI scope explicitly allows platform assignments (avoid refusing 'ce teme am?')", () => {
  assert.match(SCOPE_DESCRIPTION, /modulul Teme/);
});
