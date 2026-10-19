// AI provider fallback chain (docs/design-ai-fallback.md): claude-main -> claude-backup -> qwen -> groq.
// The real Agent SDK and the real network are NEVER called here: the Claude path is replaced via
// agent.callClaude / complete.claudeComplete, and global fetch is a fake OpenAI-compatible server.
const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "._ai_fallback_test.db");
process.env.DB_PATH = DB_FILE;
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const db = require("../src/db");
const agent = require("../src/ai/agent");
const providers = require("../src/ai/providers");
const completeMod = require("../src/ai/complete");
const aiPolicy = require("../src/domain/ai-policy");
const tasksSvc = require("../src/services/tasks");
const waGateway = require("../src/services/wa-gateway");
const meetingsSvc = require("../src/services/meetings");
const updater = require("../src/services/ftc-manual-updater");

const ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: "tok-main",
  CLAUDE_CODE_OAUTH_TOKEN_BACKUP: "tok-backup",
  AI_MODEL: "claude-test-model",
  QWEN_BASE_URL: "http://qwen.test/v1",
  QWEN_API_KEY: "qwen-key",
  QWEN_MODEL: "qwen-test",
  GROQ_API_KEY: "groq-key",
};
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const QWEN_URL = "http://qwen.test/v1/chat/completions";

let member, leader;
let claudeCalls; // provider ids the fake Claude path was called for
let claudeBehavior; // id -> function(provider) returning a callModel-shaped result or throwing
let fetchCalls; // { url, body }
let fetchQueue; // url -> array of responses (each: object = JSON 200, or { status, text })
let waSent;
const realFetch = global.fetch;
const realCallClaude = agent.callClaude;
const realLoadQuery = agent.loadQuery;

before(() => {
  const insert = db.prepare("INSERT INTO members (full_name, phone, role, auth_role, status) VALUES (?, ?, ?, ?, 'activ')");
  member = { id: insert.run("Membru Fallback", "40700009001", "member", "member").lastInsertRowid, role: "member", auth_role: "member", status: "activ", full_name: "Membru Fallback" };
  leader = { id: insert.run("Leader Fallback", "40700009002", "team_leader", "team_leader").lastInsertRowid, role: "team_leader", auth_role: "team_leader", status: "activ", full_name: "Leader Fallback" };
});

after(() => {
  global.fetch = realFetch;
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
});

function claudeOk(text) {
  return (p) => ({ finalText: text, resultUsage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001, toolCalls: 0, model: p.model });
}

function chatReply(content, extra = {}) {
  return { choices: [{ message: { role: "assistant", content, ...extra }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
}

function toolCallReply(name, args, id = "call_1") {
  return chatReply(null, { tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
}

beforeEach(() => {
  for (const k of Object.keys(ENV)) process.env[k] = ENV[k];
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AI_PROVIDER_COOLDOWN_MIN;
  delete process.env.AI_PROVIDER_TIMEOUT_MS;
  process.env.AI_BURST_PER_MINUTE = "100";
  providers._reset();
  db.prepare("DELETE FROM ai_usage").run();
  db.prepare("DELETE FROM ai_flags").run();
  db.prepare("DELETE FROM notifications").run();

  claudeCalls = [];
  claudeBehavior = { "claude-main": claudeOk("Răspuns de la principal."), "claude-backup": claudeOk("Răspuns de la rezervă.") };
  agent.callClaude = async (p) => {
    claudeCalls.push(p.id);
    return claudeBehavior[p.id](p);
  };
  completeMod.claudeComplete = async (p) => {
    claudeCalls.push(p.id);
    const r = claudeBehavior[p.id](p);
    return { text: r.finalText, usage: r.resultUsage, cost: r.costUsd };
  };

  fetchCalls = [];
  fetchQueue = {};
  global.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    fetchCalls.push({ url: String(url), body, headers: init && init.headers });
    const q = fetchQueue[String(url)];
    if (!q || !q.length) throw new Error(`unexpected fetch ${url}`);
    const r = q.shift();
    const resp = typeof r === "function" ? await r(body) : r;
    if (resp && resp.status) return new Response(resp.text || "", { status: resp.status });
    return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  agent.loadQuery = realLoadQuery;

  waSent = [];
  waGateway.sendWhatsApp = async (to, text) => { waSent.push({ to, text }); return true; };
});

function run(text = "salut") {
  return agent.runAgent({ actor: member, channel: "web", chatId: "web:fb", text, history: [] });
}

function lastUsage() {
  return db.prepare("SELECT * FROM ai_usage ORDER BY id DESC LIMIT 1").get();
}

// ---- providers: configuration & helpers ------------------------------------------------------

test("providers: order main -> backup -> qwen -> groq, unconfigured ones skipped", () => {
  assert.deepEqual(providers.list().map((p) => p.id), ["claude-main", "claude-backup", "qwen", "groq"]);
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_BACKUP;
  delete process.env.QWEN_API_KEY;
  assert.deepEqual(providers.list().map((p) => p.id), ["claude-main", "groq"]);
  const groq = providers.list().find((p) => p.id === "groq");
  assert.equal(groq.model, "openai/gpt-oss-120b");
});

test("providers: isConfigured is true with any single provider (e.g. only Groq)", () => {
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_BACKUP", "QWEN_API_KEY"]) delete process.env[k];
  assert.equal(providers.isConfigured(), true);
  assert.equal(agent.isConfigured(), true);
  delete process.env.GROQ_API_KEY;
  assert.equal(providers.isConfigured(), false);
  assert.equal(agent.isConfigured(), false);
});

test("providers: claude-backup env carries the backup token as CLAUDE_CODE_OAUTH_TOKEN, no API key", () => {
  process.env.ANTHROPIC_API_KEY = "api-main";
  const backup = providers.list().find((p) => p.id === "claude-backup");
  const env = providers.claudeEnv(backup);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "tok-backup");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  const main = providers.list().find((p) => p.id === "claude-main");
  const mainEnv = providers.claudeEnv(main);
  assert.equal(mainEnv.ANTHROPIC_API_KEY, "api-main");
  assert.equal(mainEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("providers: isFailoverError / parseResetTime", () => {
  for (const s of ["Claude AI usage limit reached|1791800000", "429 Too Many Requests", "API Error: 529 overloaded",
    "API Error: 401 authentication_error", "Invalid bearer token", "Your credit balance is too low", "rate_limit_error"]) {
    assert.equal(providers.isFailoverError(s), true, s);
  }
  assert.equal(providers.isFailoverError(new Error("HTTP 429: slow down")), true);
  assert.equal(providers.isFailoverError("Robotul are maxim 18 inch (R101). Ai 2 taskuri."), false);
  const inOneHour = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(providers.parseResetTime(`Claude AI usage limit reached|${inOneHour}`), inOneHour * 1000);
  assert.equal(providers.parseResetTime("API Error: 529"), null);
  // clamped to [now+1min, now+24h], else null (= default cooldown)
  const past = Math.floor(Date.now() / 1000) - 60;
  const farFuture = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
  assert.equal(providers.parseResetTime(`usage limit reached|${past}`), null);
  assert.equal(providers.parseResetTime(`usage limit reached|${farFuture}`), null);
});

// ---- chain via runAgent ---------------------------------------------------------------------

test("chain: primary success -> only claude-main called, ai_usage.model = AI_MODEL", async () => {
  const r = await run();
  assert.equal(r.reply, "Răspuns de la principal.");
  assert.deepEqual(claudeCalls, ["claude-main"]);
  assert.equal(fetchCalls.length, 0);
  assert.equal(lastUsage().model, "claude-test-model");
});

test("chain: thrown error on main -> backup answers", async () => {
  claudeBehavior["claude-main"] = () => { throw new Error("spawn failed"); };
  const r = await run();
  assert.equal(r.reply, "Răspuns de la rezervă.");
  assert.deepEqual(claudeCalls, ["claude-main", "claude-backup"]);
});

test("chain: non-success result (no final text) -> next provider", async () => {
  claudeBehavior["claude-main"] = (p) => ({ finalText: null, resultUsage: null, costUsd: 0, toolCalls: 0, model: p.model });
  const r = await run();
  assert.equal(r.reply, "Răspuns de la rezervă.");
});

test("chain: 'usage limit reached|<epoch>' -> failover + cooldown until that time, then skipped without a call", async () => {
  const epoch = Math.floor(Date.now() / 1000) + 3600;
  claudeBehavior["claude-main"] = claudeOk(`Claude AI usage limit reached|${epoch}`);
  const r = await run();
  assert.equal(r.reply, "Răspuns de la rezervă.");
  assert.equal(providers.cooldownUntil("claude-main"), epoch * 1000);

  claudeCalls = [];
  const r2 = await run();
  assert.equal(r2.reply, "Răspuns de la rezervă.");
  assert.deepEqual(claudeCalls, ["claude-backup"], "main in cooldown must be skipped without a call");
});

test("chain: 429 / 529 / 401 texts each trigger failover with default cooldown", async () => {
  for (const msg of ["API Error: 429 Too Many Requests", "API Error: 529 {\"type\":\"overloaded_error\"}", "API Error: 401 authentication_error"]) {
    providers._reset();
    claudeCalls = [];
    claudeBehavior["claude-main"] = claudeOk(msg);
    const before = Date.now();
    const r = await run();
    assert.equal(r.reply, "Răspuns de la rezervă.", msg);
    assert.deepEqual(claudeCalls, ["claude-main", "claude-backup"], msg);
    const until = providers.cooldownUntil("claude-main");
    assert.ok(until >= before + 15 * 60 * 1000 - 1000 && until <= Date.now() + 15 * 60 * 1000 + 1000, msg);
  }
});

test("chain: timeout -> next provider", async () => {
  process.env.AI_PROVIDER_TIMEOUT_MS = "30";
  claudeBehavior["claude-main"] = () => new Promise(() => {}); // never resolves
  const r = await run();
  assert.equal(r.reply, "Răspuns de la rezervă.");
});

test("chain: unconfigured providers skipped (main fails, backup+qwen missing -> groq)", async () => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_BACKUP;
  delete process.env.QWEN_API_KEY;
  claudeBehavior["claude-main"] = () => { throw new Error("boom"); };
  fetchQueue[GROQ_URL] = [chatReply("Răspuns Groq.")];
  const r = await run();
  assert.equal(r.reply, "Răspuns Groq.");
  assert.deepEqual(claudeCalls, ["claude-main"]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, GROQ_URL);
  assert.equal(fetchCalls[0].body.model, "openai/gpt-oss-120b");
  assert.equal(lastUsage().model, "openai/gpt-oss-120b");
});

test("chain: qwen HTTP 429 -> groq", async () => {
  claudeBehavior["claude-main"] = () => { throw new Error("x"); };
  claudeBehavior["claude-backup"] = () => { throw new Error("y"); };
  fetchQueue[QWEN_URL] = [{ status: 429, text: "rate limited" }];
  fetchQueue[GROQ_URL] = [chatReply("Răspuns Groq.")];
  const r = await run();
  assert.equal(r.reply, "Răspuns Groq.");
});

test("chain: all providers fail -> existing technical-problem reply", async () => {
  claudeBehavior["claude-main"] = () => { throw new Error("x"); };
  claudeBehavior["claude-backup"] = () => { throw new Error("y"); };
  fetchQueue[QWEN_URL] = [{ status: 500, text: "down" }];
  fetchQueue[GROQ_URL] = [{ status: 503, text: "down" }];
  const r = await run();
  assert.match(r.reply, /problemă tehnică/);
});

// ---- OpenAI-compatible engine ---------------------------------------------------------------

function onlyQwen() {
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_BACKUP", "GROQ_API_KEY"]) delete process.env[k];
}

test("openai engine: tool_call -> real tool handler (member's tasks) -> final text, <think> stripped, ai_usage", async () => {
  onlyQwen();
  tasksSvc.create(member, { title: "Montează brațul robotului" });
  fetchQueue[QWEN_URL] = [
    toolCallReply("taskurile_mele", {}),
    (body) => {
      const toolMsg = body.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg, "tool result must be sent back");
      assert.equal(toolMsg.tool_call_id, "call_1");
      assert.match(toolMsg.content, /Montează brațul robotului/);
      return chatReply("<think>caut taskurile</think>Ai un task: Montează brațul robotului.");
    },
  ];
  const r = await run("ce taskuri am?");
  assert.equal(r.reply, "Ai un task: Montează brațul robotului.");
  assert.equal(r.tool_calls, 1);

  const first = fetchCalls[0].body;
  assert.equal(first.model, "qwen-test");
  assert.equal(first.max_tokens, aiPolicy.maxOutputTokens());
  assert.equal(first.messages[0].role, "system");
  assert.equal(first.messages[0].content, agent.SYSTEM_PROMPT);
  assert.match(first.messages[1].content, /ce taskuri am\?/);
  const spec = first.tools.find((t) => t.function.name === "taskurile_mele");
  assert.equal(spec.type, "function");
  assert.equal(spec.function.parameters.type, "object");
  assert.equal(fetchCalls[0].headers.Authorization, "Bearer qwen-key");

  const u = lastUsage();
  assert.equal(u.model, "qwen-test");
  assert.equal(u.input_tokens, 200);
  assert.equal(u.output_tokens, 40);
  assert.equal(u.tool_calls, 1);
});

test("openai engine: a tool DomainError is passed to the model and does NOT trigger failover", async () => {
  onlyQwen();
  process.env.GROQ_API_KEY = "groq-key"; // available, must NOT be used
  fetchQueue[QWEN_URL] = [
    toolCallReply("actualizeaza_task", { id: 999999, status: "done" }),
    (body) => {
      const toolMsg = body.messages.find((m) => m.role === "tool");
      assert.match(toolMsg.content, /negăsit|nu există|Nu ai/i);
      return chatReply("Nu am găsit taskul.");
    },
  ];
  const r = await run("marchează taskul 999999 ca gata");
  assert.equal(r.reply, "Nu am găsit taskul.");
  assert.ok(fetchCalls.every((c) => c.url === QWEN_URL));
  assert.equal(providers.cooldownUntil("qwen"), 0);
});

test("openai engine: invalid tool arguments become a tool error, not a failover", async () => {
  onlyQwen();
  fetchQueue[QWEN_URL] = [
    toolCallReply("actualizeaza_task", { id: "nu-e-numar" }),
    (body) => {
      assert.match(body.messages.find((m) => m.role === "tool").content, /invalid/i);
      return chatReply("Am nevoie de ID-ul taskului.");
    },
  ];
  const r = await run("actualizează taskul");
  assert.equal(r.reply, "Am nevoie de ID-ul taskului.");
});

test("openai engine: [REFUZ:off_topic] in a qwen reply is still replaced by the fixed text", async () => {
  onlyQwen();
  fetchQueue[QWEN_URL] = [chatReply("<think>e eseu</think>[REFUZ:off_topic]")];
  const r = await run("scrie-mi un eseu despre Luceafărul");
  assert.equal(r.reply, aiPolicy.REFUSAL_TEXTS.off_topic);
  const flag = db.prepare("SELECT * FROM ai_flags ORDER BY id DESC LIMIT 1").get();
  assert.equal(flag.category, "off_topic");
});

test("openai engine: never-ending tool calls past MAX_TURNS count as a provider failure", async () => {
  onlyQwen();
  fetchQueue[QWEN_URL] = Array.from({ length: 20 }, (_, i) => toolCallReply("profilul_meu", {}, `c${i}`));
  const r = await run();
  assert.match(r.reply, /problemă tehnică/);
  assert.ok(providers.cooldownUntil("qwen") > Date.now());
});

// ---- notifications --------------------------------------------------------------------------

test("notify: team_leader gets one in-app + one WhatsApp on switch, nothing while in cooldown, one on recovery", async () => {
  process.env.AI_PROVIDER_COOLDOWN_MIN = "0.0005"; // 30 ms
  claudeBehavior["claude-main"] = claudeOk("API Error: 429 Too Many Requests");
  await run();
  await run(); // main in cooldown or failing again - no new notification
  let notes = db.prepare("SELECT * FROM notifications WHERE member_id = ? AND type = 'ai_provider'").all(leader.id);
  assert.equal(notes.length, 1);
  assert.equal(waSent.length, 1);
  assert.equal(waSent[0].to, "40700009002");
  assert.ok(!/salut/.test(notes[0].body), "no conversation content");

  await new Promise((r) => setTimeout(r, 50));
  claudeBehavior["claude-main"] = claudeOk("Răspuns de la principal.");
  const r = await run();
  assert.equal(r.reply, "Răspuns de la principal.");
  await run();
  notes = db.prepare("SELECT * FROM notifications WHERE member_id = ? AND type = 'ai_provider' ORDER BY id").all(leader.id);
  assert.equal(notes.length, 2);
  assert.equal(waSent.length, 2);
  assert.match(notes[1].title, /revenit|funcțional/i);
  // regular members are never notified
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ?").get(member.id).c, 0);
});

// ---- complete(): no-tool calls (PV draft, FTC announcement) ----------------------------------

test("complete: same chain without tools; qwen fallback strips <think> and uses maxTokens", async () => {
  claudeBehavior["claude-main"] = () => { throw new Error("x"); };
  claudeBehavior["claude-backup"] = claudeOk("Claude AI usage limit reached|1891800000");
  fetchQueue[QWEN_URL] = [chatReply("<think>...</think>{\"ok\":true}")];
  const r = await completeMod.complete({ system: "SYS", prompt: "PROMPT", maxTokens: 1234 });
  assert.equal(r.text, "{\"ok\":true}");
  assert.equal(r.model, "qwen-test");
  assert.deepEqual(claudeCalls, ["claude-main", "claude-backup"]);
  const body = fetchCalls[0].body;
  assert.equal(body.max_tokens, 1234);
  assert.equal(body.tools, undefined);
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
});

test("complete: all fail -> text null (callers keep their fallbacks)", async () => {
  claudeBehavior["claude-main"] = () => { throw new Error("x"); };
  claudeBehavior["claude-backup"] = () => { throw new Error("y"); };
  fetchQueue[QWEN_URL] = [{ status: 500 }];
  fetchQueue[GROQ_URL] = [{ status: 500 }];
  const r = await completeMod.complete({ system: "S", prompt: "P" });
  assert.equal(r.text, null);
});

test("meetings.generateDraftText and ftc updater generateAnnouncementText go through complete()", async () => {
  claudeBehavior["claude-main"] = claudeOk("{\"discussions\":[]}");
  const d = await meetingsSvc.generateDraftText("prompt PV");
  assert.equal(d.text, "{\"discussions\":[]}");
  assert.equal(d.model, "claude-test-model");

  claudeBehavior["claude-main"] = () => { throw new Error("x"); };
  claudeBehavior["claude-backup"] = () => { throw new Error("y"); };
  providers._reset();
  fetchQueue[QWEN_URL] = [chatReply("- R101 modificată.")];
  const a = await updater.generateAnnouncementText("diff");
  assert.equal(a.text, "- R101 modificată.");
  assert.equal(a.model, "qwen-test");
});

// ---- fix round 1: no failover after a write, 413/length, notifications, failed-attempt usage ---

function taskCount(title) {
  return db.prepare("SELECT COUNT(*) c FROM tasks WHERE title = ?").get(title).c;
}

test("write guard (openai): qwen runs creeaza_task then HTTP 500 -> groq NOT called, exactly one task, fixed reply", async () => {
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_BACKUP"]) delete process.env[k];
  fetchQueue[QWEN_URL] = [toolCallReply("creeaza_task", { titlu: "Task unic fallback" }), { status: 500, text: "boom" }];
  fetchQueue[GROQ_URL] = [toolCallReply("creeaza_task", { titlu: "Task unic fallback" }), chatReply("Gata.")];
  const r = await run("creează-mi taskul Task unic fallback");
  assert.equal(r.reply, aiPolicy.WRITE_INTERRUPTED_TEXT);
  assert.equal(taskCount("Task unic fallback"), 1);
  assert.ok(fetchCalls.every((c) => c.url === QWEN_URL), "groq must not be called after a write");
  assert.ok(providers.cooldownUntil("qwen") > Date.now(), "qwen still goes into cooldown");
});

test("write guard (openai): a write tool that returned an error does not block failover", async () => {
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_BACKUP"]) delete process.env[k];
  fetchQueue[QWEN_URL] = [toolCallReply("actualizeaza_task", { id: 999999, status: "done" }), { status: 500 }];
  fetchQueue[GROQ_URL] = [chatReply("Răspuns Groq.")];
  const r = await run();
  assert.equal(r.reply, "Răspuns Groq.");
});

test("write guard: no tool starts after the attempt timed out (signal aborted)", async () => {
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_BACKUP"]) delete process.env[k];
  process.env.AI_PROVIDER_TIMEOUT_MS = "40";
  fetchQueue[QWEN_URL] = [async () => {
    await new Promise((res) => setTimeout(res, 80)); // answers after the timeout, ignoring the signal
    return toolCallReply("creeaza_task", { titlu: "Task după timeout" });
  }];
  fetchQueue[GROQ_URL] = [chatReply("Răspuns Groq.")];
  const r = await run();
  assert.equal(r.reply, "Răspuns Groq.");
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(taskCount("Task după timeout"), 0);
});

function fakeQuery(messagesFor) {
  const seen = [];
  agent.loadQuery = async () => (opts) => {
    seen.push(opts.options.env.CLAUDE_CODE_OAUTH_TOKEN);
    const list = messagesFor(opts.options.env.CLAUDE_CODE_OAUTH_TOKEN);
    return (async function* () { for (const m of list) yield m; })();
  };
  return seen;
}

test("write guard (claude): tool_use creeaza_task + non-error tool_result, then error result -> backup NOT called", async () => {
  agent.callClaude = realCallClaude;
  const seen = fakeQuery(() => [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__crocoai__creeaza_task", input: { titlu: "x" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: false, content: [{ type: "text", text: "Task creat: x." }] }] } },
    { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], usage: { input_tokens: 500, output_tokens: 20 }, total_cost_usd: 0.01 },
  ]);
  const r = await run();
  assert.equal(r.reply, aiPolicy.WRITE_INTERRUPTED_TEXT);
  assert.deepEqual(seen, ["tok-main"]);
  // tokens of the failed attempt are recorded (unattributed, so they count for the global budget only)
  const failed = db.prepare("SELECT * FROM ai_usage WHERE member_id IS NULL").all();
  assert.equal(failed.length, 1);
  assert.equal(failed[0].input_tokens, 500);
  assert.match(failed[0].model, /claude-test-model.*eșuat/);
});

test("write guard (claude): a write tool_result with is_error does not block failover", async () => {
  agent.callClaude = realCallClaude;
  const seen = fakeQuery((tok) => tok === "tok-main" ? [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__crocoai__creeaza_task", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: [{ type: "text", text: "Nu ai permisiunea." }] }] } },
    { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] },
  ] : [
    { type: "result", subtype: "success", is_error: false, result: "Răspuns de la rezervă.", usage: { input_tokens: 1, output_tokens: 1 } },
  ]);
  const r = await run();
  assert.equal(r.reply, "Răspuns de la rezervă.");
  assert.deepEqual(seen, ["tok-main", "tok-backup"]);
});

test("claude: success text is an error only with a known prefix; is_error result fails over", async () => {
  claudeBehavior["claude-main"] = claudeOk("Limita de 429 de puncte e în regula G301.");
  let r = await run();
  assert.equal(r.reply, "Limita de 429 de puncte e în regula G301.");

  providers._reset();
  agent.callClaude = realCallClaude;
  fakeQuery((tok) => tok === "tok-main"
    ? [{ type: "result", subtype: "success", is_error: true, result: "Something odd" }]
    : [{ type: "result", subtype: "success", is_error: false, result: "Răspuns de la rezervă." }]);
  r = await run();
  assert.equal(r.reply, "Răspuns de la rezervă.");
});

test("HTTP 413 / finish_reason length with empty content -> next provider, no cooldown, no notification", async () => {
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_BACKUP"]) delete process.env[k];
  fetchQueue[QWEN_URL] = [{ status: 413, text: "Request too large" }];
  fetchQueue[GROQ_URL] = [chatReply("Răspuns Groq.")];
  let r = await run();
  assert.equal(r.reply, "Răspuns Groq.");
  assert.equal(providers.cooldownUntil("qwen"), 0);

  fetchQueue[QWEN_URL] = [{ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 50, completion_tokens: 600 } }];
  fetchQueue[GROQ_URL] = [chatReply("Răspuns Groq 2.")];
  r = await run();
  assert.equal(r.reply, "Răspuns Groq 2.");
  assert.equal(providers.cooldownUntil("qwen"), 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications").get().c, 0);
});

test("notify: qwen/groq individual failures do not notify", async () => {
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_BACKUP"]) delete process.env[k];
  fetchQueue[QWEN_URL] = [{ status: 500 }];
  fetchQueue[GROQ_URL] = [chatReply("Răspuns Groq.")];
  await run();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications").get().c, 0);
  assert.equal(waSent.length, 0);
});

test("notify: claude-main down (1) + all providers down (1), once, not repeated while still down", async () => {
  claudeBehavior["claude-main"] = () => { throw new Error("x"); };
  claudeBehavior["claude-backup"] = () => { throw new Error("y"); };
  fetchQueue[QWEN_URL] = [{ status: 500 }];
  fetchQueue[GROQ_URL] = [{ status: 500 }];
  const r = await run();
  assert.match(r.reply, /problemă tehnică/);
  await run(); // everything in cooldown: no calls, no new notification
  const notes = db.prepare("SELECT title FROM notifications WHERE member_id = ? ORDER BY id").all(leader.id);
  assert.equal(notes.length, 2);
  assert.match(notes[1].title, /niciun furnizor|indisponibil/i);
  assert.equal(waSent.length, 2);
});

test("failed attempts' tokens are recorded unattributed (global budget), member count unchanged", async () => {
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_BACKUP"]) delete process.env[k];
  fetchQueue[QWEN_URL] = [toolCallReply("profilul_meu", {}), { status: 500 }];
  fetchQueue[GROQ_URL] = [chatReply("Răspuns Groq.")];
  await run();
  const failed = db.prepare("SELECT * FROM ai_usage WHERE member_id IS NULL").all();
  assert.equal(failed.length, 1);
  assert.equal(failed[0].input_tokens, 100);
  assert.match(failed[0].model, /qwen-test.*eșuat/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM ai_usage WHERE member_id = ?").get(member.id).c, 1);
});

test("openai engine: tool lookup by name uses own keys only (no prototype names)", async () => {
  onlyQwen();
  fetchQueue[QWEN_URL] = [
    toolCallReply("toString", {}),
    (body) => {
      assert.match(body.messages.find((m) => m.role === "tool").content, /necunoscut/);
      return chatReply("Ok.");
    },
  ];
  const r = await run();
  assert.equal(r.reply, "Ok.");
});

test("markFailed logs provider + error class only, never the reply/body text", async () => {
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_BACKUP"]) delete process.env[k];
  claudeBehavior["claude-main"] = claudeOk("x");
  fetchQueue[QWEN_URL] = [{ status: 500, text: "SECRET-BODY-TEXT" }];
  fetchQueue[GROQ_URL] = [chatReply("Răspuns Groq.")];
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try { await run(); } finally { console.error = orig; }
  assert.ok(logs.some((l) => /qwen/.test(l) && /HTTP 500/.test(l)));
  assert.ok(!logs.some((l) => l.includes("SECRET-BODY-TEXT")));
});

test("WRITE_TOOLS lists every writing tool and each exists in buildToolList", async () => {
  const { WRITE_TOOLS, buildToolList } = require("../src/ai/tools");
  const names = new Set((await buildToolList({ actor: member, channel: "web", chatId: "x" })).map((t) => t.name));
  for (const w of ["creeaza_task", "actualizeaza_task", "cere_motivare_absenta", "decide_motivare", "creeaza_reminder", "trimite_whatsapp"]) {
    assert.ok(WRITE_TOOLS.has(w), w);
  }
  for (const w of WRITE_TOOLS) assert.ok(names.has(w), `${w} exists`);
});
