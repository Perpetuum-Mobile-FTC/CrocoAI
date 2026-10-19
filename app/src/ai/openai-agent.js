// OpenAI-compatible engine (a self-hosted Qwen, Groq) for the fallback chain
// (docs/design-ai-fallback.md). Same SYSTEM_PROMPT, same tool objects from buildToolList (schema
// from their zod shape, handler called exactly like the SDK does: handler(args, {})), so the
// golden rule holds whatever model answers. Tool errors (DomainError -> isError result) go back to
// the model as a normal tool message; only HTTP/protocol failures throw (= provider failure).
const { z } = require("zod");

function toolSpecs(toolList) {
  return toolList.map((t) => {
    const parameters = z.toJSONSchema(z.object(t.inputSchema || {}));
    delete parameters.$schema;
    return { type: "function", function: { name: t.name, description: t.description, parameters } };
  });
}

function stripThink(text) {
  return String(text || "").replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim();
}

// Throws on failure. err.status = HTTP status (logged instead of the body); err.noCooldown for
// "request too large" (413) and an empty reply cut by max_tokens - a problem of this request, not
// of the provider, so the chain moves on without a cooldown.
async function chat(provider, body, signal) {
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: provider.model, ...(provider.extraBody || {}), ...body }),
    signal,
  });
  const raw = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
    err.status = res.status;
    if (res.status === 413) err.noCooldown = true;
    throw err;
  }
  const data = JSON.parse(raw);
  const choice = data.choices && data.choices[0];
  const message = choice && choice.message;
  if (!message) throw new Error("răspuns fără choices");
  const usage = data.usage || {};
  if (choice.finish_reason === "length" && !(message.tool_calls || []).length && !stripThink(message.content)) {
    const err = new Error("răspuns gol (max_tokens atins)");
    err.kind = "length";
    err.noCooldown = true;
    err.usage = usage;
    throw err;
  }
  return { message, usage };
}

// Runs one tool call; always returns { text, isError } (errors included), never throws.
async function execTool(tool, rawArgs) {
  if (!tool) return { text: "Eroare: tool necunoscut.", isError: true };
  let args;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { text: "Eroare: argumente invalide (JSON).", isError: true };
  }
  const parsed = z.object(tool.inputSchema || {}).safeParse(args || {});
  if (!parsed.success) {
    return { text: `Eroare: argumente invalide - ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, isError: true };
  }
  try {
    const result = await tool.handler(parsed.data, {});
    return { text: (result.content || []).map((c) => c.text || "").join("\n"), isError: !!result.isError };
  } catch (err) {
    console.error("[AI-TOOL]", err.stack || err.message);
    return { text: "A apărut o eroare tehnică la executarea acestei acțiuni.", isError: true };
  }
}

function addUsage(attempt, u) {
  attempt.usage.input_tokens += (u && u.prompt_tokens) || 0;
  attempt.usage.output_tokens += (u && u.completion_tokens) || 0;
}

// Chat loop with tools. Returns { text, usage: { input_tokens, output_tokens }, toolCalls }.
// `attempt` (from providers.runWithFallback) gets the tokens as they are spent and wrote=true once
// a write tool (WRITE_TOOLS) succeeded, so a later failure does not hand the turn to another provider.
async function runAgent(provider, { system, user, toolList, writeTools, maxTurns, maxTokens, signal, attempt }) {
  attempt = attempt || { usage: { input_tokens: 0, output_tokens: 0 }, wrote: false };
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  const byName = new Map(toolList.map((t) => [t.name, t]));
  const tools = toolSpecs(toolList);
  let toolCalls = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    let reply;
    try {
      reply = await chat(provider, { messages, tools, max_tokens: maxTokens }, signal);
    } catch (err) {
      addUsage(attempt, err.usage);
      throw err;
    }
    const { message, usage: u } = reply;
    addUsage(attempt, u);

    const calls = message.tool_calls || [];
    if (!calls.length) return { text: stripThink(message.content), usage: { ...attempt.usage }, toolCalls };

    messages.push({ role: "assistant", content: message.content || null, tool_calls: calls });
    for (const call of calls) {
      // Nothing may start once the attempt timed out / was abandoned.
      if (signal && signal.aborted) throw new Error("apel anulat (timeout)");
      toolCalls++;
      const fn = call.function || {};
      const tool = byName.get(fn.name);
      const { text, isError } = await execTool(tool, fn.arguments);
      if (tool && !isError && writeTools && writeTools.has(tool.name)) attempt.wrote = true;
      messages.push({ role: "tool", tool_call_id: call.id, content: text });
    }
  }
  throw new Error(`limita de ${maxTurns} runde depășită`);
}

// Single call without tools (PV draft, FTC announcement).
async function complete(provider, { system, prompt, maxTokens, signal, attempt }) {
  const messages = [{ role: "system", content: system }, { role: "user", content: prompt }];
  let reply;
  try {
    reply = await chat(provider, { messages, max_tokens: maxTokens }, signal);
  } catch (err) {
    if (attempt) addUsage(attempt, err.usage);
    throw err;
  }
  const { message, usage: u } = reply;
  if (attempt) addUsage(attempt, u);
  return {
    text: stripThink(message.content),
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
  };
}

module.exports = { runAgent, complete, toolSpecs, stripThink, execTool };
