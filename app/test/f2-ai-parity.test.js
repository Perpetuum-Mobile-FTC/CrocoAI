// Curățenie F2 item 5: AI tool <-> route parity harness over test/_ai-parity.js.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("f2_ai_parity");

const { server } = require("../server");
const db = require("../src/db");
const { buildToolList } = require("../src/ai/tools");
const tasksSvc = require("../src/services/tasks");
const absencesSvc = require("../src/services/absences");
const eventsSvc = require("../src/services/events");
const announcements = require("../src/services/announcements");
const { PARITY } = require("./_ai-parity");

let BASE, M;
const cookies = {};
const ctx = {};

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "member", role: "member", department: "tehnic" },
    { key: "other", role: "member", department: "non-tehnic" },
  ]);
  db.prepare("UPDATE members SET full_name = 'Membru Paritate Unu' WHERE id = ?").run(M.member.id);
  db.prepare("UPDATE members SET full_name = 'Membru Parităte Doi', email = 'x@y.ro' WHERE id = ?").run(M.other.id);
  M = Object.fromEntries(Object.entries(M).map(([k, m]) => [k, db.prepare("SELECT * FROM members WHERE id = ?").get(m.id)]));
  for (const k of Object.keys(M)) cookies[k] = await login(BASE, M[k].phone);
  const soon = (d) => new Date(Date.now() + d * 86400000).toISOString();
  eventsSvc.create(M.tl, { title: "Antrenament paritate", start_time: soon(2), location: "Sala 1", type: "antrenament" });
  eventsSvc.create(M.tl, { title: "Prea departe", start_time: soon(40), type: "eveniment" });
  await announcements.publish(M.tl, { title: "Anunț paritate", body: "text", audience: "echipa" });
  await announcements.publish(M.tl, { title: "Doar non-tehnic", audience: "non-tehnic" });
  Object.assign(ctx, {
    M,
    task: (owner) => tasksSvc.create(M.tl, { title: `T ${owner.id}`, assigned_member_id: owner.id }),
    absence: () => absencesSvc.create(M.member, { date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), reason: "școală" }),
  });
});
after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  env.cleanup();
});

async function toolsAs(actor, opts = {}) {
  const list = await buildToolList({ actor, channel: "web", chatId: `web:${actor.id}`, ...opts });
  return Object.fromEntries(list.map((t) => [t.name, t]));
}

test("every AI tool has a parity entry (route + args mapping), and every entry has a tool", async () => {
  const names = Object.keys(await toolsAs(M.tl)).sort();
  assert.ok(names.length >= 30);
  assert.deepEqual(names.filter((n) => !PARITY[n]), [], "tools without a parity entry in test/_ai-parity.js");
  assert.deepEqual(Object.keys(PARITY).filter((n) => !names.includes(n)), [], "stale parity entries");
  for (const [name, e] of Object.entries(PARITY)) {
    assert.ok(e.route !== undefined && typeof e.args === "string", `${name}: route + args`);
    if (e.route === null) assert.ok(e.why, `${name}: a tool without a route says why`);
    assert.ok(e.cases || e.coveredBy, `${name}: cases or coveredBy`);
    if (e.coveredBy) {
      const src = fs.readFileSync(path.join(__dirname, e.coveredBy), "utf8");
      assert.ok(src.includes(name), `${e.coveredBy} must exercise ${name}`);
    }
  }
});

for (const [name, entry] of Object.entries(PARITY)) {
  if (!entry.cases) continue;
  entry.cases.forEach((c, i) => {
    test(`parity ${name} #${i + 1} (${c.as}): tool == ${entry.route}`, async () => {
      const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(M[c.as].id);
      const tool = (await toolsAs(actor))[name];
      const out = await tool.handler(c.tool(ctx), {});
      const req = c.http(ctx);
      const res = await fetch(`${BASE}${req.path}`, {
        method: req.method || "GET",
        headers: { Cookie: cookies[c.as], "Content-Type": "application/json" },
        body: req.body ? JSON.stringify(req.body) : undefined,
      });
      const json = await res.json();
      const text = out.content[0].text;
      if (res.status >= 400) {
        assert.equal(out.isError, true, `tool must refuse like the route (${res.status} ${json.error})`);
        assert.equal(text, `${json.error}${json.article ? ` (${json.article})` : ""}`);
      } else {
        assert.ok(!out.isError, text);
        const norm = c.normalize || ((t) => t);
        assert.equal(norm(text), norm(c.expect(json, ctx)));
      }
    });
  });
}

test("the harness sees real data (not only empty answers)", async () => {
  const t = await toolsAs(M.member);
  assert.match((await t.evenimente_urmatoare.handler({ zile: 10 }, {})).content[0].text, /Antrenament paritate/);
  assert.doesNotMatch((await t.evenimente_urmatoare.handler({ zile: 10 }, {})).content[0].text, /Prea departe/);
  const ann = (await t.anunturi_recente.handler({}, {})).content[0].text;
  assert.match(ann, /Anunț paritate/);
  assert.doesNotMatch(ann, /Doar non-tehnic/, "audience filtering is the service's, same for tool and route");
  assert.match((await t.cauta_membru.handler({ query: "membru paritate" }, {})).content[0].text, /Paritate Unu[\s\S]*Parităte Doi|Parităte Doi[\s\S]*Paritate Unu/);
});
