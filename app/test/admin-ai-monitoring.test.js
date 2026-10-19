// Admin "Consum AI" monitoring endpoints (docs/design-ai-hardening.md §5, §6): per-member usage,
// refusals by category, limit hits, crisis signals (content-free) - LEADERS only, same as the
// existing /api/admin/ai-usage endpoint.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._admin_ai_monitoring_test.db");
const DOCS_DIR = path.join(__dirname, "._admin_ai_monitoring_test_documents");
process.env.DB_PATH = DB_FILE;
process.env.DOCUMENTS_DIR = DOCS_DIR;
process.env.ADMIN_INITIAL_PASSWORD = "admintest123";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.WA_SHARED_SECRET = "test-wa-secret";
process.env.LOGIN_RATE_LIMIT_MAX = "1000";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
fs.rmSync(DOCS_DIR, { recursive: true, force: true });

const { server } = require("../server");
const db = require("../src/db");
const aiUsage = require("../src/services/ai-usage");

let BASE;
let leader, member;

function cookieFrom(res) {
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

async function login(phone, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  assert.equal(res.status, 200, `login failed for ${phone}: ${await res.text()}`);
  return cookieFrom(res);
}

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const hash = bcrypt.hashSync("test1234", 10);
  const insert = db.prepare(`
    INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, 'activ', ?, 0)
  `);
  leader = insert.run("Team Leader Monitor", "monitor-leader", "40700005001", "team_leader", "team_leader", hash).lastInsertRowid;
  member = insert.run("Membru Monitor", "monitor-membru", "40700005002", "member", "member", hash).lastInsertRowid;

  aiUsage.record({ member: { id: member }, channel: "web", model: "mock", usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: 0.001, tool_calls: 0 });
  aiUsage.recordFlag({ member_id: member, channel: "web", category: "off_topic" });
  aiUsage.recordFlag({ member_id: member, channel: "wa", category: "criza" });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  try { fs.rmSync(DOCS_DIR, { recursive: true, force: true }); } catch {}
});

test("GET /api/admin/ai-usage/by-member: LEADERS only, includes the member's usage", async () => {
  const memberCookie = await login("monitor-membru", "test1234");
  const forbidden = await fetch(`${BASE}/api/admin/ai-usage/by-member`, { headers: { Cookie: memberCookie } });
  assert.equal(forbidden.status, 403);

  const leaderCookie = await login("monitor-leader", "test1234");
  const res = await fetch(`${BASE}/api/admin/ai-usage/by-member`, { headers: { Cookie: leaderCookie } });
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.ok(rows.some((r) => r.member_id === member));
});

test("GET /api/admin/ai-flags: LEADERS only, aggregates by category with no message content, lists crisis signals", async () => {
  const memberCookie = await login("monitor-membru", "test1234");
  const forbidden = await fetch(`${BASE}/api/admin/ai-flags`, { headers: { Cookie: memberCookie } });
  assert.equal(forbidden.status, 403);

  const leaderCookie = await login("monitor-leader", "test1234");
  const res = await fetch(`${BASE}/api/admin/ai-flags`, { headers: { Cookie: leaderCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.byCategory.some((c) => c.category === "off_topic"));
  assert.equal(body.crisisSignals.length, 1);
  assert.equal(body.crisisSignals[0].member_name, "Membru Monitor");
  assert.ok(!Object.keys(body.crisisSignals[0]).includes("body"), "crisis signals must never carry message content");
});
