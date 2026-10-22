// „Văzut ultima dată” (2026-10-22): members.last_seen_at is set by any authenticated request, at most once per
// rules.LAST_SEEN_RESOLUTION_MS, and shown only to OVERSIGHT (policy members.view_activity).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("last_seen");
const { server } = require("../server");
const db = require("../src/db");
const { LAST_SEEN_RESOLUTION_MS } = require("../src/domain/rules");

let BASE, M;
const cookies = {};
const get = (key, url) => fetch(`${BASE}${url}`, { headers: { Cookie: cookies[key] } }).then((r) => r.json());
const seen = (key) => db.prepare("SELECT last_seen_at FROM members WHERE id = ?").get(M[key].id).last_seen_at;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "mentor", role: "mentor" },
    { key: "mt", role: "member", department: "tehnic" },
  ]);
  for (const k of Object.keys(M)) cookies[k] = await login(BASE, M[k].phone);
});
after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  env.cleanup();
});

test("an authenticated request records last_seen_at, at most once per resolution window", async () => {
  db.prepare("UPDATE members SET last_seen_at = NULL WHERE id = ?").run(M.mt.id);
  await get("mt", "/api/auth/me");
  const first = seen("mt");
  assert.ok(first, "recorded on the first request");
  await get("mt", "/api/auth/me");
  assert.equal(seen("mt"), first, "not rewritten within the window");
  const old = new Date(Date.now() - LAST_SEEN_RESOLUTION_MS - 1000).toISOString();
  db.prepare("UPDATE members SET last_seen_at = ? WHERE id = ?").run(old, M.mt.id);
  await get("mt", "/api/auth/me");
  assert.ok(seen("mt") > old, "refreshed once the window has passed");
});

test("last_seen_at is visible to OVERSIGHT only (directory + profile)", async () => {
  const row = (list) => list.find((m) => m.id === M.mt.id);
  assert.ok("last_seen_at" in row(await get("tl", "/api/members")));
  assert.ok("last_seen_at" in row(await get("mentor", "/api/members")));
  assert.ok(!("last_seen_at" in row(await get("mt", "/api/members"))), "plain members don't see others' activity");
  assert.ok("last_seen_at" in (await get("tl", `/api/members/${M.mt.id}`)));
  assert.ok(!("last_seen_at" in (await get("mt", `/api/members/${M.tl.id}`))));
});

test("fmtSeen: today / yesterday / days / older date / never", async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "ui.js"), "utf8");
  const tmp = path.join(os.tmpdir(), `ui-${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  let fmtSeen;
  try { ({ fmtSeen } = await import(pathToFileURL(tmp).href)); } finally { fs.unlinkSync(tmp); }
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(fmtSeen(null, now), "nicio activitate înregistrată");
  assert.equal(fmtSeen("2026-10-22T05:00:00Z", now), "activ azi");
  assert.equal(fmtSeen("2026-10-21T20:00:00Z", now), "activ ieri");
  assert.equal(fmtSeen("2026-10-21T22:30:00Z", now), "activ azi", "Romanian calendar day (UTC+3)");
  assert.equal(fmtSeen("2026-10-19T10:00:00Z", now), "activ acum 3 zile");
  assert.equal(fmtSeen("2026-10-01T10:00:00Z", now), "activ acum 21 de zile");
  assert.match(fmtSeen("2026-08-01T10:00:00Z", now), /^activ ultima dată pe 01\.08\.2026$/);
});
