// Claude Agent SDK wiring (design v2 §8, hardened per docs/design-ai-hardening.md). ONLY our
// in-process MCP tools are available — every built-in tool (Bash, Read, Write, Edit, WebFetch,
// WebSearch, Task, ...) is disabled, no filesystem settings are loaded (`settingSources: []`), no
// session persistence, Romanian, concise (WhatsApp-sized) answers only, grounded in tool results.
//
// Scope, refusal/crisis texts and limits live in ../domain/ai-policy.js (the single definition,
// shared by WhatsApp and the web chat). This file only wires the SDK call and enforces those
// limits/tags at the one place both channels pass through.
const os = require("os");
const fs = require("fs");
const path = require("path");

const aiPolicy = require("../domain/ai-policy");
const aiUsage = require("../services/ai-usage");
const notifications = require("../services/notifications");
const { buildToolServer, buildToolList, WRITE_TOOLS } = require("./tools");
const { toWhatsAppText } = require("./format");
const providers = require("./providers");
const openaiAgent = require("./openai-agent");
const commands = require("./commands");

const MAX_TURNS = 8;
const HISTORY_LIMIT = 8;
const HISTORY_TRUNCATE = 500;
const BURST_WINDOW_MS = 60 * 1000;

const SYSTEM_PROMPT = aiPolicy.buildSystemPrompt();

// Any provider of the fallback chain configured (docs/design-ai-fallback.md).
function isConfigured() {
  return providers.isConfigured();
}

// Thin wrappers kept for backward compatibility (tests, other call sites) — the real definitions
// live in domain/ai-policy.js now.
function dailyMemberLimit(actor) {
  return aiPolicy.dailyMemberLimit(actor);
}
function globalTokenBudget() {
  return aiPolicy.dailyTokenBudget();
}

// `history` = array of { from: 'user'|'bot', name?, body, isOther? } in chronological order, NOT
// including the current message (callers must fetch it before logging the current one - audit fix
// for the double-message bug). `isOther: true` marks a message from a participant who is neither
// the current sender nor the bot (group chats) - design §4: it's shown as context, not an
// instruction, with an explicit marker so the model never treats it as a command.
function buildUserTurn({ actor, text, history, isGroup = false }) {
  const now = new Date().toLocaleString("ro-RO", { timeZone: "Europe/Bucharest" });
  const lines = [];
  lines.push(`Data și ora curentă (Europe/Bucharest): ${now}`);
  lines.push(`Expeditor: ${actor.full_name}, rol ${actor.role}, id ${actor.id}.`);
  if (isGroup) lines.push(aiPolicy.GROUP_NOTE);
  const recent = (history || []).slice(-HISTORY_LIMIT);
  if (recent.length) {
    lines.push("Conversație recentă (context, nu răspunde la ea direct):");
    for (const m of recent) {
      const body = String(m.body || "").slice(0, HISTORY_TRUNCATE);
      const speaker = m.from === "bot" ? "CrocoAI" : (m.name || "utilizator");
      const mark = m.from === "user" && m.isOther ? ` ${aiPolicy.OTHER_PARTICIPANT_MARK}` : "";
      lines.push(`${speaker}${mark}: ${body}`);
    }
  }
  lines.push(`Mesajul curent al utilizatorului: ${text}`);
  return lines.join("\n");
}

// One fixed, empty working dir (also used as HOME). It must be the same path on every call:
// Claude Code puts the working directory in the prompt, so a new temp dir per call would change
// the prompt prefix and defeat prompt caching (measured: 0 cache reads with per-call dirs).
const AGENT_DIR = path.join(os.tmpdir(), "crocoai-agent");
function makeCwd() {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  return AGENT_DIR;
}

// One Claude provider (claude-main / claude-backup) through the Agent SDK. Exported separately
// (module.exports.callClaude) so tests can replace it — the real SDK must never run in the test suite.
// Throws on a non-success / error result (its text is kept for the reset time, e.g.
// "usage limit reached|<epoch>").
//
// `attempt` (from providers.runWithFallback) receives the tokens and wrote=true once a write tool
// (WRITE_TOOLS) returned a non-error tool_result, so a later failure stops the chain.
async function callClaude(provider, { actor, channel, chatId, text, history, isGroup }, { abortController, attempt } = {}) {
  const query = await module.exports.loadQuery();
  const toolList = await buildToolList({ actor, channel, chatId, isGroup });
  const mcpServer = await buildToolServer({ actor, channel, chatId, isGroup });
  const allowedTools = toolList.map((t) => `mcp__crocoai__${t.name}`);

  const cwd = makeCwd();
  let toolCalls = 0;
  let finalText = null;
  let errorText = null;
  let resultUsage = null;
  let costUsd = 0;
  const model = provider.model;

  const q = query({
    prompt: buildUserTurn({ actor, text, history, isGroup }),
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: [], // disables ALL built-in tools (Bash, Read, Write, Edit, WebFetch, WebSearch, Task, ...)
      disallowedTools: ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Task", "Glob", "Grep", "NotebookEdit"],
      allowedTools,
      mcpServers: { crocoai: mcpServer },
      settingSources: [],
      maxTurns: MAX_TURNS,
      cwd,
      // Isolation: HOME = the empty temp dir, so the claude process never loads the host
      // user's MCP servers, plugins or CLAUDE.md (they cost tens of thousands of tokens/call).
      // CLAUDE_CODE_MAX_OUTPUT_TOKENS caps real model output (design §1) - the system prompt's
      // word-count hint alone isn't a hard limit.
      // The token comes per provider (claude-backup = CLAUDE_CODE_OAUTH_TOKEN_BACKUP).
      env: { ...providers.claudeEnv(provider), HOME: cwd, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(aiPolicy.maxOutputTokens()) },
      strictMcpConfig: true,
      persistSession: false,
      permissionMode: "bypassPermissions",
      ...(abortController ? { abortController } : {}),
    },
  });

  const writeUses = new Set(); // tool_use ids of write tools in this attempt
  for await (const message of q) {
    const content = message.message && Array.isArray(message.message.content) ? message.message.content : [];
    if (message.type === "assistant") {
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        toolCalls++;
        if (WRITE_TOOLS.has(String(block.name || "").replace(/^mcp__crocoai__/, ""))) writeUses.add(block.id);
      }
    }
    if (message.type === "user" && attempt) {
      for (const block of content) {
        if (block.type === "tool_result" && writeUses.has(block.tool_use_id) && !block.is_error) attempt.wrote = true;
      }
    }
    if (message.type === "result") {
      if (message.subtype === "success" && !message.is_error) finalText = toWhatsAppText(message.result);
      else errorText = message.result || (message.errors || []).join("; ") || message.subtype;
      resultUsage = message.usage || null;
      costUsd = message.total_cost_usd || 0;
      if (attempt && resultUsage) {
        attempt.usage = { ...resultUsage };
        attempt.costUsd = costUsd;
      }
    }
  }

  if (!finalText) throw new Error(errorText || "Claude: fără rezultat");
  return { finalText, resultUsage, costUsd, toolCalls, model };
}

// The model call of one agent turn, through the fallback chain (claude-main -> claude-backup ->
// qwen -> groq). Same SYSTEM_PROMPT and same buildToolList tools on every engine. Returns the
// answering provider's model for ai_usage; { finalText: null, model: null } when all failed.
// Exported separately (module.exports.callModel) so tests can replace it with a mock.
async function callModel(args) {
  // Tokens of a failed attempt still count for the global daily budget: recorded without a member
  // (so the member's own call count isn't charged for our provider failure), model marked "eșuat".
  const onFailure = (provider, attempt) => {
    const u = attempt.usage || {};
    if (!(u.input_tokens || u.output_tokens)) return;
    aiUsage.record({ member: null, channel: args.channel, model: `${provider.model} (eșuat)`, usage: u, cost_usd: attempt.costUsd, tool_calls: 0 });
  };
  const answered = await providers.runWithFallback(async (provider, { abortController, attempt }) => {
    if (provider.engine === "claude") {
      const out = await module.exports.callClaude(provider, args, { abortController, attempt });
      providers.checkReply(out.finalText);
      return { ...out, model: provider.model };
    }
    const toolList = await buildToolList({ actor: args.actor, channel: args.channel, chatId: args.chatId, isGroup: args.isGroup });
    const out = await openaiAgent.runAgent(provider, {
      system: SYSTEM_PROMPT,
      user: buildUserTurn(args),
      toolList,
      writeTools: WRITE_TOOLS,
      maxTurns: MAX_TURNS,
      maxTokens: aiPolicy.maxOutputTokens(),
      signal: abortController.signal,
      attempt,
    });
    providers.checkReply(out.text);
    return { finalText: toWhatsAppText(out.text), resultUsage: out.usage, costUsd: 0, toolCalls: out.toolCalls, model: provider.model };
  }, { onFailure });
  if (!answered) return { finalText: null, resultUsage: null, costUsd: 0, toolCalls: 0, model: null };
  // A write already happened and the attempt then failed: no other provider may redo it.
  if (answered.stopped) {
    return { finalText: aiPolicy.WRITE_INTERRUPTED_TEXT, resultUsage: null, costUsd: 0, toolCalls: 0, model: answered.provider.model };
  }
  return answered.result;
}

// The Agent SDK query() - exported so tests can swap it (the real SDK never runs in tests).
async function loadQuery() {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return query;
}

// Runs one agent turn. Returns { reply } or { reply: null, notice } when AI is unavailable/over
// limit (deterministic commands still work independently via commands.js, called by the routes
// before this). `history` excludes the current message (design v2 §9). `isGroup`: WhatsApp group chat
// (A4) - public tools only, personal requests answered with ai-policy.GROUP_PRIVATE_TEXT.
async function runAgent({ actor, channel, chatId, text, history, isGroup = false }) {
  if (!isConfigured()) {
    return { reply: null, notice: `Asistentul AI nu e configurat încă. Poți folosi comenzile:\n${commands.HELP_TEXT}` };
  }

  // Input too long -> deterministic reply, NO model call at all (design §1).
  if (aiPolicy.tooLong(text)) {
    return { reply: aiPolicy.tooLongReply() };
  }

  const usage = aiUsage.todayUsage(actor.id);
  const memberLimit = aiPolicy.dailyMemberLimit(actor);
  if (usage.callsToday >= memberLimit) {
    aiUsage.recordFlag({ member_id: actor.id, channel, category: "limita" });
    return { reply: null, notice: `Ai atins limita zilnică de ${memberLimit} apeluri AI. Mai încearcă mâine, sau folosește comenzile:\n${commands.HELP_TEXT}` };
  }

  // Burst limit: too many calls in the last minute (design §1).
  const burstCount = aiUsage.callsInWindow(actor.id, BURST_WINDOW_MS);
  if (burstCount >= aiPolicy.burstPerMinute()) {
    aiUsage.recordFlag({ member_id: actor.id, channel, category: "limita" });
    return { reply: null, notice: "Prea multe mesaje într-un minut. Așteaptă puțin și încearcă din nou." };
  }

  if (usage.globalTokensToday >= aiPolicy.dailyTokenBudget()) {
    return { reply: null, notice: "Bugetul zilnic de AI al echipei s-a epuizat. Mai încearcă mâine." };
  }

  // Pre-call budget estimate: don't start a call that would very likely blow the remaining
  // global budget on its own (design §1).
  if (aiPolicy.wouldExceedBudget({ text, history, globalTokensToday: usage.globalTokensToday })) {
    return { reply: null, notice: "Bugetul zilnic de AI al echipei s-a epuizat. Mai încearcă mâine." };
  }

  // Exposed as module.exports.callModel so tests can replace it with a mock (same pattern as
  // services/meetings.js's generateDraftText) - the real Agent SDK is NEVER called in tests.
  const { finalText, resultUsage, costUsd, toolCalls, model } = await module.exports.callModel({ actor, channel, chatId, text, history, isGroup });

  // model null = every provider failed or was in cooldown: nothing was consumed, nothing to record.
  if (model) aiUsage.record({ member: actor, channel, model, usage: resultUsage, cost_usd: costUsd, tool_calls: toolCalls });

  if (!finalText) {
    return { reply: "Scuze, am o problemă tehnică momentan. Încearcă din nou în câteva minute." };
  }

  // Tag handling (design §1/§6): applied in this ONE place for both channels. A [REFUZ:<cat>] or
  // [CRIZA] tag anywhere in the reply replaces the WHOLE reply with the fixed text and is recorded
  // in ai_flags (no message content stored). Crisis additionally notifies team_leader + active
  // mentors, with no content.
  const { text: tagged, flagCategory } = aiPolicy.applyTags(finalText);
  if (flagCategory) {
    aiUsage.recordFlag({ member_id: actor.id, channel, category: flagCategory });
    if (flagCategory === "criza") notifications.notifyCrisisSignal(actor);
  }

  const reply = aiPolicy.truncateReply(tagged);
  return { reply, usage: resultUsage, cost_usd: costUsd, tool_calls: toolCalls };
}

module.exports = { runAgent, callModel, callClaude, loadQuery, isConfigured, SYSTEM_PROMPT, dailyMemberLimit, globalTokenBudget, buildUserTurn };
