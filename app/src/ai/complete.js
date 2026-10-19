// Single AI call without tools (PV draft, FTC manual announcement) through the same fallback chain
// as the agent (docs/design-ai-fallback.md). Claude providers run an isolated Agent SDK query
// (fixed empty HOME/cwd per caller, no tools, no persistence); qwen/groq a plain chat completion.
const os = require("os");
const fs = require("fs");
const path = require("path");

const providers = require("./providers");
const aiUsage = require("../services/ai-usage");
const openaiAgent = require("./openai-agent");

const DEFAULT_MAX_TOKENS = 2000;

// Exported separately (module.exports.claudeComplete) so tests can replace it - the real SDK is
// NEVER called in tests. Throws on a non-success / error result.
async function claudeComplete(provider, { system, prompt, agentDir }, { abortController, attempt } = {}) {
  const query = await require("./agent").loadQuery();
  const cwd = path.join(os.tmpdir(), agentDir || "crocoai-agent-complete");
  fs.mkdirSync(cwd, { recursive: true });
  let text = null;
  let errorText = null;
  let usage = null;
  let cost = 0;

  const q = query({
    prompt,
    options: {
      systemPrompt: system,
      model: provider.model,
      tools: [],
      disallowedTools: ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Task", "Glob", "Grep", "NotebookEdit"],
      allowedTools: [],
      settingSources: [],
      maxTurns: 1,
      cwd,
      env: { ...providers.claudeEnv(provider), HOME: cwd },
      strictMcpConfig: true,
      persistSession: false,
      permissionMode: "bypassPermissions",
      ...(abortController ? { abortController } : {}),
    },
  });

  for await (const message of q) {
    if (message.type === "result") {
      if (message.subtype === "success" && !message.is_error) text = message.result;
      else errorText = message.result || (message.errors || []).join("; ") || message.subtype;
      usage = message.usage || null;
      cost = message.total_cost_usd || 0;
      if (attempt && usage) { attempt.usage = { ...usage }; attempt.costUsd = cost; }
    }
  }
  if (!text) throw new Error(errorText || "Claude: fără rezultat");
  return { text, usage, cost };
}

// Returns { text, usage, cost, model }; text/model null when every provider failed (callers keep
// their own fallbacks: manual PV, deterministic announcement).
async function complete({ system, prompt, maxTokens = DEFAULT_MAX_TOKENS, agentDir }) {
  // Failed attempts' tokens still count for the global budget (unattributed, model marked "eșuat").
  const onFailure = (provider, attempt) => {
    const u = attempt.usage || {};
    if (!(u.input_tokens || u.output_tokens)) return;
    aiUsage.record({ member: null, channel: "system", model: `${provider.model} (eșuat)`, usage: u, cost_usd: attempt.costUsd, tool_calls: 0 });
  };
  const answered = await providers.runWithFallback(async (provider, { abortController, attempt }) => {
    let out;
    if (provider.engine === "claude") {
      out = await module.exports.claudeComplete(provider, { system, prompt, agentDir }, { abortController, attempt });
      out = { text: out.text, usage: out.usage, cost: out.cost || 0 };
    } else {
      out = await openaiAgent.complete(provider, { system, prompt, maxTokens, signal: abortController.signal, attempt });
      out = { ...out, cost: 0 };
    }
    providers.checkReply(out.text);
    return { ...out, model: provider.model };
  }, { onFailure });
  if (!answered) return { text: null, usage: null, cost: 0, model: null };
  return answered.result;
}

module.exports = { complete, claudeComplete };
