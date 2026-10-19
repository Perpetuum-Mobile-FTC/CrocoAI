// AI ops (ops package E, item 7): "today" = the Europe/Bucharest calendar day, daily cost alert to the
// active Team Leader (once per day, from the scheduler), `ai_provider` in /api/health without secrets.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._ai_ops_test.db");
const DOCS_DIR = path.join(__dirname, "._ai_ops_test_documents");
process.env.DB_PATH = DB_FILE;
process.env.DOCUMENTS_DIR = DOCS_DIR;
process.env.ADMIN_INITIAL_PASSWORD = "admintest123";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.WA_SHARED_SECRET = "test-wa-secret";
process.env.WA_GATEWAY_URL = "http://mock-wa-gateway.test";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
fs.rmSync(DOCS_DIR, { recursive: true, force: true });

const realFetch = global.fetch;
global.fetch = async (url, opts) => (String(url).startsWith(process.env.WA_GATEWAY_URL) ? new Response("{}", { status: 200 }) : realFetch(url, opts));

const { server } = require("../server");
const db = require("../src/db");
const aiUsage = require("../src/services/ai-usage");
const providers = require("../src/ai/providers");
const waGateway = require("../src/services/wa-gateway");
const reminderScheduler = require("../src/services/reminder-scheduler");
const { clearAiProviderEnv } = require("./_ai-env");

let BASE, tl, pausedTl, member;
let waSent = [];

const addUsage = (memberId, createdAt, cost) =>
  db.prepare("INSERT INTO ai_usage (member_id, channel, input_tokens, output_tokens, cost_usd, created_at) VALUES (?, 'wa', 10, 5, ?, ?)")
    .run(memberId, cost, createdAt);

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const hash = bcrypt.hashSync("test1234", 4);
  const insert = db.prepare(`
    INSERT INTO members (full_name, username, phone, phone_verified_at, role, auth_role, status, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  tl = insert.run("TL Cost", "cost-tl", "40700006001", "2026-10-01T00:00:00Z", "team_leader", "team_leader", "activ", hash).lastInsertRowid;
  pausedTl = insert.run("TL Pauza", "cost-tl2", "40700006002", "2026-10-01T00:00:00Z", "team_leader", "team_leader", "pauza", hash).lastInsertRowid;
  member = insert.run("Membru Cost", "cost-m", "40700006003", null, "member", "member", "activ", hash).lastInsertRowid;
});

beforeEach(() => {
  db.prepare("DELETE FROM ai_usage").run();
  db.prepare("DELETE FROM notifications").run();
  waSent = [];
  waGateway.sendWhatsApp = async (to, text) => { waSent.push({ to, text }); return true; };
  delete process.env.AI_DAILY_COST_ALERT_USD;
  clearAiProviderEnv();
  providers._reset();
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  fs.rmSync(DOCS_DIR, { recursive: true, force: true });
});

test("todayUsage counts the Europe/Bucharest day, not the UTC day", () => {
  // 2026-10-16T22:30Z = 01:30 on 17 Oct in Bucharest (UTC+3). Bucharest midnight = 2026-10-16T21:00Z.
  const now = new Date("2026-10-16T22:30:00.000Z");
  addUsage(member, "2026-10-16T20:30:00.000Z", 0.1); // 23:30 on the 16th (Bucharest) - yesterday
  addUsage(member, "2026-10-16T21:30:00.000Z", 0.2); // 00:30 on the 17th - today
  addUsage(member, "2026-10-16T22:00:00.000Z", 0.3); // today
  const u = aiUsage.todayUsage(member, now);
  assert.equal(u.callsToday, 2);
  assert.equal(u.globalTokensToday, 30);
  assert.ok(Math.abs(aiUsage.costToday(now) - 0.5) < 1e-9);
});

test("todayUsage in winter time (UTC+2) starts at 22:00Z", () => {
  const now = new Date("2026-12-01T10:00:00.000Z");
  addUsage(member, "2026-11-30T21:59:00.000Z", 1); // 23:59 on 30 Nov
  addUsage(member, "2026-11-30T22:01:00.000Z", 1); // 00:01 on 1 Dec
  assert.equal(aiUsage.todayUsage(member, now).callsToday, 1);
});

test("byMember calls_today uses the Bucharest day too", () => {
  const now = new Date();
  addUsage(member, now.toISOString(), 0.01);
  const tlActor = db.prepare("SELECT * FROM members WHERE id = ?").get(tl);
  const rows = aiUsage.byMember(tlActor, {});
  const mine = rows.find((r) => r.member_id === member);
  assert.equal(mine.calls_today, 1);
});

test("daily cost over AI_DAILY_COST_ALERT_USD notifies the active TL once per day (in-app + WhatsApp)", async () => {
  process.env.AI_DAILY_COST_ALERT_USD = "1";
  const now = new Date();
  addUsage(member, now.toISOString(), 0.6);
  await aiUsage.checkDailyCost(now);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type = 'ai_cost'").get().c, 0, "under the threshold: nothing");

  addUsage(member, now.toISOString(), 0.6);
  await aiUsage.checkDailyCost(now);
  await aiUsage.checkDailyCost(now);
  const notes = db.prepare("SELECT * FROM notifications WHERE type = 'ai_cost' AND member_id = ?").all(tl);
  assert.equal(notes.length, 1, "once per day");
  assert.match(notes[0].body, /1\.20/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type = 'ai_cost' AND member_id IN (?, ?)").get(pausedTl, member).c, 0,
    "only active Team Leaders");
  assert.deepEqual(waSent.filter((w) => w.to === "40700006001").length, 1);
  assert.ok(!waSent.some((w) => w.to === "40700006002"));
});

test("default threshold is $2", async () => {
  const now = new Date();
  addUsage(member, now.toISOString(), 1.9);
  await aiUsage.checkDailyCost(now);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type = 'ai_cost'").get().c, 0);
  addUsage(member, now.toISOString(), 0.2);
  await aiUsage.checkDailyCost(now);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type = 'ai_cost' AND member_id = ?").get(tl).c, 1);
});

test("the scheduler tick runs the daily cost check", async () => {
  process.env.AI_DAILY_COST_ALERT_USD = "0.5";
  addUsage(member, new Date().toISOString(), 1);
  await reminderScheduler.tick(new Date());
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type = 'ai_cost' AND member_id = ?").get(tl).c, 1);
});

test("providers.activeProvider: first configured provider not in cooldown, else 'none'", async () => {
  assert.equal(providers.activeProvider(), "none");
  process.env.ANTHROPIC_API_KEY = "sk-secret-test";
  process.env.GROQ_API_KEY = "gsk-secret-test";
  assert.equal(providers.activeProvider(), "claude-main");
  await providers.runWithFallback(async (p) => {
    if (p.id === "claude-main") throw new Error("rate limit");
    return "ok";
  });
  assert.equal(providers.activeProvider(), "groq");
});

test("/api/health reports ai_provider with no secrets", async () => {
  let body = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(body.checks.ai_provider, "none");
  process.env.GROQ_API_KEY = "gsk-secret-test";
  const text = await (await fetch(`${BASE}/api/health`)).text();
  body = JSON.parse(text);
  assert.equal(body.checks.ai_provider, "groq");
  assert.ok(!text.includes("gsk-secret-test"));
});
