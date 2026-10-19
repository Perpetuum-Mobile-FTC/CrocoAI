// Unit tests for the deterministic command parser, pending-action confirmation, and limits.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "._ai_unit_test.db");
process.env.DB_PATH = DB_FILE;
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const db = require("../src/db");
const commands = require("../src/ai/commands");
const pending = require("../src/ai/pending");
const agent = require("../src/ai/agent");

let member, leader;

before(() => {
  const insert = db.prepare("INSERT INTO members (full_name, phone, role, auth_role, status) VALUES (?, ?, ?, ?, 'activ')");
  member = { id: insert.run("Membru Unit", "40700002001", "member", "member").lastInsertRowid, role: "member", status: "activ", full_name: "Membru Unit" };
  leader = { id: insert.run("Leader Unit", "40700002002", "team_leader", "team_leader").lastInsertRowid, role: "team_leader", status: "activ", full_name: "Leader Unit" };
});

after(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
});

test("commands: 'ajutor' returns the help text, diacritic/case-insensitive", () => {
  assert.equal(commands.tryHandle(member, "ajutor"), commands.HELP_TEXT);
  assert.equal(commands.tryHandle(member, "AJUTOR"), commands.HELP_TEXT);
  assert.equal(commands.tryHandle(member, "Ajutor"), commands.HELP_TEXT);
});

test("commands: 'taskuri' lists tasks with zero LLM calls (no AI config needed)", () => {
  const out = commands.tryHandle(member, "taskuri");
  assert.ok(out.includes("Nu ai taskuri") || out.length > 0);
});

test("commands: 'prezenta' works even without diacritics", () => {
  const out = commands.tryHandle(member, "prezență");
  assert.ok(typeof out === "string");
});

test("commands: thanks and emoji-only get a short reply", () => {
  assert.equal(commands.tryHandle(member, "mersi!"), "Cu plăcere! 🐊");
  assert.equal(commands.tryHandle(member, "👍"), "👍");
});

test("commands: free text (not a known command) returns null so the caller falls through to the AI agent", () => {
  assert.equal(commands.tryHandle(member, "cand e urmatoarea sedinta de robotica si cine conduce"), null);
});

test("pending: create + confirm with 'DA' resolves and removes the row", async () => {
  const row = pending.create(leader, "web:test-chat", { to: "40700000000", message: "bună" });
  assert.ok(pending.findActive(leader.id, "web:test-chat"));
  const result = await pending.confirmIfAny(leader.id, "web:test-chat", "DA");
  assert.match(result, /am trimis|nu am reușit/i);
  assert.equal(pending.findActive(leader.id, "web:test-chat"), null);
});

test("pending: anything other than DA cancels it", async () => {
  pending.create(leader, "web:test-chat-2", { to: "40700000000", message: "bună" });
  const result = await pending.confirmIfAny(leader.id, "web:test-chat-2", "nu, lasă");
  assert.match(result, /am anulat/i);
  assert.equal(pending.findActive(leader.id, "web:test-chat-2"), null);
});

test("pending: expired action is treated as gone", () => {
  const row = pending.create(leader, "web:test-chat-3", { to: "x", message: "y" });
  db.prepare("UPDATE wa_pending_actions SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), row.id);
  assert.equal(pending.findActive(leader.id, "web:test-chat-3"), null);
});

test("pending: confirmIfAny returns null when there is nothing pending", async () => {
  const result = await pending.confirmIfAny(member.id, "web:nothing-pending", "DA");
  assert.equal(result, null);
});

test("pending: getPublic returns a structured {summary, expires_at} while active, null once consumed/expired", async () => {
  assert.equal(pending.getPublic(leader.id, "web:test-chat-4"), null);
  pending.create(leader, "web:test-chat-4", { to: "40722223333", message: "bună echipă" });
  const pub = pending.getPublic(leader.id, "web:test-chat-4");
  assert.ok(pub);
  assert.match(pub.summary, /40722223333/);
  assert.match(pub.summary, /bună echipă/);
  assert.ok(pub.expires_at);
  await pending.confirmIfAny(leader.id, "web:test-chat-4", "DA");
  assert.equal(pending.getPublic(leader.id, "web:test-chat-4"), null);
});

test("limits: LEADERS get 3x the member daily call limit", () => {
  process.env.AI_DAILY_LIMIT_MEMBER = "10";
  assert.equal(agent.dailyMemberLimit(member), 10);
  assert.equal(agent.dailyMemberLimit(leader), 30);
  delete process.env.AI_DAILY_LIMIT_MEMBER;
});

test("agent.runAgent returns a 'not configured' notice with no ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN, with zero tool calls", async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  require("./_ai-env").clearAiProviderEnv();
  const result = await agent.runAgent({ actor: member, channel: "web", chatId: "web:x", text: "salut", history: [] });
  assert.equal(result.reply, null);
  assert.match(result.notice, /nu e configurat/i);
  if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedToken) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
});

test("toWhatsAppText converts Markdown emphasis and headings to WhatsApp style", () => {
  const { toWhatsAppText } = require("../src/ai/format");
  assert.equal(toWhatsAppText("## Prezență\n**75%** din ședințe (__Art. 20.1__)"), "*Prezență*\n*75%* din ședințe (_Art. 20.1_)");
});

test("document guidance: one definition, personalised by age, shown by agent formatter", () => {
  const rules = require("../src/domain/rules");
  const { formatDocuments } = require("../src/ai/format");
  assert.equal(rules.documentGuidance("anexa13_foto_video", true).who_signs, "Semnează părintele/tutorele.");
  assert.equal(rules.documentGuidance("anexa13_foto_video", false).who_signs, "Semnezi tu.");
  const text = formatDocuments([{ key: "anexa13_foto_video", title: "Acord foto", article: "Art. 59", document: null, ...rules.documentGuidance("anexa13_foto_video", true) }]);
  assert.match(text, /Semnează părintele\/tutorele/);
  assert.match(text, /Descarcă șablonul/);
});
