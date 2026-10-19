// Route-level + wa-incoming hook + AI tool parity for onboarding (design-phase2.md §6, C3).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._onboarding_routes_test.db");
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INITIAL_PASSWORD = "admintest123";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.WA_SHARED_SECRET = "test-wa-secret";
process.env.LOGIN_RATE_LIMIT_MAX = "1000";
process.env.WA_GATEWAY_URL = "http://mock-wa-gateway.test";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const { server } = require("../server");
const db = require("../src/db");
const { buildToolList } = require("../src/ai/tools");

// wa-gateway.js is required (and its `sendWhatsApp` destructured) by wa-incoming.js at load time,
// so reassigning the module's exports later has no effect there - intercept at the fetch level
// instead, only for calls to the fake gateway host, so the real HTTP requests to our own test
// server still go through.
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  if (String(url).startsWith(process.env.WA_GATEWAY_URL)) {
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, code: 200 }) });
  }
  return realFetch(url, opts);
};

let BASE;
let tl, member;

function cookieFrom(res) { return (res.headers.get("set-cookie") || "").split(";")[0]; }
async function login(phone, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, password }),
  });
  assert.equal(res.status, 200, `login failed: ${await res.text()}`);
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
  tl = insert.run("Onboarding TL", "ob-tl", "40700003001", "team_leader", "team_leader", hash).lastInsertRowid;
  member = insert.run("Onboarding Membru", "ob-membru", "40700003002", "member", "member", hash).lastInsertRowid;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  global.fetch = realFetch;
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  try { fs.rmSync(path.join(__dirname, "backups"), { recursive: true, force: true }); } catch {}
});

test("POST /api/onboarding is LEADERS only", async () => {
  const memberCookie = await login("ob-membru", "test1234");
  const res = await fetch(`${BASE}/api/onboarding`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: memberCookie },
    body: JSON.stringify({ name: "X", phone: "40799990001" }),
  });
  assert.equal(res.status, 403);
});

test("start onboarding via route, then the WhatsApp dialog is routed through wa-incoming BEFORE the AI agent", async () => {
  const tlCookie = await login("ob-tl", "test1234");
  const startRes = await fetch(`${BASE}/api/onboarding`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: tlCookie },
    body: JSON.stringify({ name: "Voluntar Ruta", phone: "40799990002", department: "tehnic" }),
  });
  assert.equal(startRes.status, 200);
  const started = await startRes.json();
  assert.equal(started.member.onboarding_step, 1);

  // Simulate the member's WhatsApp reply - this must go through onboarding.handleReply, never the
  // LLM agent (no ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN is set in tests, so if the hook didn't
  // take precedence, this would come back as the "not configured" agent notice instead).
  const incomingRes = await fetch(`${BASE}/wa/incoming`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({ msgId: "ob-m1", from: "40799990002", text: "Voluntar Numele Ruta", isGroup: false }),
  });
  assert.equal(incomingRes.status, 200);
  const incomingBody = await incomingRes.json();
  assert.equal(incomingBody.handled, true);

  // Give the fire-and-forget processReply() a tick to run and persist the bot's reply.
  await new Promise((r) => setTimeout(r, 150));
  const botReply = db.prepare("SELECT * FROM messages WHERE chat_id = '40799990002' AND from_me = 1 ORDER BY id DESC LIMIT 1").get();
  assert.ok(botReply, "expected a bot reply to be logged");
  assert.match(botReply.body, /clasă/); // the deterministic next question, not an LLM answer

  const freshMember = db.prepare("SELECT * FROM members WHERE phone = '40799990002'").get();
  assert.equal(freshMember.onboarding_step, 2);
});

test("GET/detail/checklist/restart/cancel routes match the service (MANAGERS only)", async () => {
  const tlCookie = await login("ob-tl", "test1234");
  const startRes = await fetch(`${BASE}/api/onboarding`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: tlCookie },
    body: JSON.stringify({ name: "Voluntar Checklist", phone: "40799990003" }),
  });
  const started = await startRes.json();
  const memberId = started.member.id;

  const listRes = await fetch(`${BASE}/api/onboarding`, { headers: { Cookie: tlCookie } });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(list.some((o) => o.member_id === memberId));

  const detailRes = await fetch(`${BASE}/api/onboarding/${memberId}`, { headers: { Cookie: tlCookie } });
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.ok(detail.checklist.length > 0);

  const tickRes = await fetch(`${BASE}/api/onboarding/${memberId}/checklist/prezentare`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: tlCookie }, body: JSON.stringify({ done: true }),
  });
  assert.equal(tickRes.status, 200);
  const ticked = await tickRes.json();
  assert.equal(ticked.checklist.find((c) => c.step_key === "prezentare").done, true);

  const memberCookie = await login("ob-membru", "test1234");
  const forbiddenTick = await fetch(`${BASE}/api/onboarding/${memberId}/checklist/prezentare`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: memberCookie }, body: JSON.stringify({ done: false }),
  });
  assert.equal(forbiddenTick.status, 403);

  const restartRes = await fetch(`${BASE}/api/onboarding/${memberId}/restart`, { method: "POST", headers: { Cookie: tlCookie } });
  assert.equal(restartRes.status, 200);

  const cancelRes = await fetch(`${BASE}/api/onboarding/${memberId}/cancel`, { method: "POST", headers: { Cookie: tlCookie } });
  assert.equal(cancelRes.status, 200);
});

test("stare_onboarding (tool) matches GET /api/onboarding for a manager", async () => {
  const tlCookie = await login("ob-tl", "test1234");
  const httpRes = await fetch(`${BASE}/api/onboarding`, { headers: { Cookie: tlCookie } });
  const httpList = await httpRes.json();

  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(tl);
  const tools = await buildToolList({ actor, channel: "web", chatId: `web:${tl}` });
  const toolDef = tools.find((t) => t.name === "stare_onboarding");
  const toolOut = await toolDef.handler({}, {});
  const text = toolOut.content[0].text;
  for (const row of httpList) {
    assert.match(text, new RegExp(row.member_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("stare_onboarding (tool) refuses a plain member exactly like the route", async () => {
  const memberCookie = await login("ob-membru", "test1234");
  const httpRes = await fetch(`${BASE}/api/onboarding`, { headers: { Cookie: memberCookie } });
  assert.equal(httpRes.status, 403);
  const httpBody = await httpRes.json();

  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(member);
  const tools = await buildToolList({ actor, channel: "web", chatId: `web:${member}` });
  const toolDef = tools.find((t) => t.name === "stare_onboarding");
  const toolOut = await toolDef.handler({}, {});
  assert.equal(toolOut.isError, true);
  assert.ok(toolOut.content[0].text.startsWith(httpBody.error));
});
