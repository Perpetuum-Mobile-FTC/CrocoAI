// AI provider fallback chain (docs/design-ai-fallback.md): claude-main -> claude-backup -> qwen -> groq.
// Providers come from env on every call (unconfigured ones are skipped). A failing provider goes into
// an in-memory cooldown (until the reset time in its message, else AI_PROVIDER_COOLDOWN_MIN) and is
// skipped without a call while it lasts. Team Leaders are told once when a provider goes down and
// once when it recovers - never with conversation content.
const notifications = require("../services/notifications");
const audience = require("../services/audience");
const waGateway = require("../services/wa-gateway");

const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5"; // production model (decision Luca, CLAUDE.md „Consum AI”)
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const LABELS = {
  "claude-main": "Claude (principal)",
  "claude-backup": "Claude (rezervă)",
  qwen: "Qwen",
  groq: "Groq",
};

function list() {
  const env = process.env;
  const claudeModel = env.AI_MODEL || DEFAULT_CLAUDE_MODEL;
  const out = [];
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) {
    out.push({ id: "claude-main", engine: "claude", model: claudeModel });
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN_BACKUP) {
    out.push({ id: "claude-backup", engine: "claude", model: claudeModel });
  }
  if (env.QWEN_BASE_URL && env.QWEN_API_KEY) {
    out.push({
      id: "qwen", engine: "openai", model: env.QWEN_MODEL || "qwen3.8",
      baseUrl: env.QWEN_BASE_URL.replace(/\/+$/, ""), apiKey: env.QWEN_API_KEY,
      // Keeps the model's hidden reasoning short so it fits in max_tokens (measured on the server).
      extraBody: { reasoning_effort: "low" },
    });
  }
  if (env.GROQ_API_KEY) {
    out.push({
      id: "groq", engine: "openai", model: env.GROQ_CHAT_MODEL || "openai/gpt-oss-120b",
      baseUrl: GROQ_BASE_URL, apiKey: env.GROQ_API_KEY,
      extraBody: { reasoning_effort: "low" },
    });
  }
  return out;
}

function isConfigured() {
  return list().length > 0;
}

// Env for the Agent SDK child process of a Claude provider (HOME isolation is added by the caller).
function claudeEnv(provider) {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN_BACKUP;
  if (provider.id === "claude-backup") {
    delete env.ANTHROPIC_API_KEY;
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN_BACKUP;
    return env;
  }
  if (env.ANTHROPIC_API_KEY) delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

function cooldownMs() { return (Number(process.env.AI_PROVIDER_COOLDOWN_MIN) || 15) * 60 * 1000; }
function timeoutMs() { return Number(process.env.AI_PROVIDER_TIMEOUT_MS) || 90 * 1000; }

// Limit / auth / overload signs in an error message or a model "answer" (Claude Code returns e.g.
// "Claude AI usage limit reached|<epoch>" or "API Error: 529 ..." as the result text).
const FAILOVER_RE = new RegExp([
  "usage limit", "rate[ _-]?limit", "too many requests", "overloaded", "credit balance",
  "authentication", "unauthorized", "invalid[^.\\n]{0,40}(token|api[ _-]?key)",
  "\\b(status|error|code|http)\\W{0,3}(401|429|529)\\b",
  "\\b(401|429|529)\\b\\W{0,3}(error|too many|overloaded|unauthorized|status)",
].join("|"), "i");

function isFailoverError(errOrText) {
  const s = errOrText instanceof Error ? errOrText.message : String(errOrText || "");
  return FAILOVER_RE.test(s);
}

// "usage limit reached|1760000000" -> epoch ms (seconds or ms accepted), clamped to
// [now+1min, now+24h]; anything else (missing, past, absurd) -> null = default cooldown.
function parseResetTime(text) {
  const m = String(text || "").match(/limit reached\|(\d{10,13})/i);
  if (!m) return null;
  const ms = m[1].length === 13 ? Number(m[1]) : Number(m[1]) * 1000;
  const now = Date.now();
  if (ms < now + 60 * 1000 || ms > now + 24 * 3600 * 1000) return null;
  return ms;
}

// A reply is a provider failure only if it is empty or STARTS with a known error prefix (Claude
// Code puts e.g. "Claude AI usage limit reached|<epoch>" / "API Error: 529 ..." in the result).
// Otherwise is_error / HTTP status decide - a real answer may mention "429" or "401".
const ERROR_PREFIX_RE = /^\s*(Claude AI usage limit|API Error|Invalid API key|Credit balance|Request too large)/i;
function checkReply(text) {
  if (!text || !String(text).trim()) throw new Error("răspuns gol / non-success");
  if (ERROR_PREFIX_RE.test(String(text))) throw new Error(String(text));
}

// ---- health state (in memory; restart = reset) -------------------------------------------------
const state = new Map(); // id -> { until, down }
let allDown = false;

function get(id) {
  if (!state.has(id)) state.set(id, { until: 0, down: false });
  return state.get(id);
}

function cooldownUntil(id) {
  return state.has(id) ? state.get(id).until : 0;
}

function hhmm(ms) {
  return new Date(ms).toLocaleTimeString("ro-RO", { timeZone: "Europe/Bucharest", hour: "2-digit", minute: "2-digit" });
}

function notifyLeaders(title, body) {
  try {
    for (const l of audience.activeTeamLeaders()) {
      notifications.create(l.id, "ai_provider", title, body, null);
      if (l.phone && !l.phone.startsWith("pending-")) {
        Promise.resolve(waGateway.sendWhatsApp(l.phone, `${title}: ${body}`)).catch(() => {});
      }
    }
  } catch (e) {
    console.error("[AI-PROVIDER] notify failed:", e.message);
  }
}

// Short, content-free description of a failure for logs/notifications (never the reply/body text).
function errorKind(err) {
  if (err && err.status) return `HTTP ${err.status}`;
  if (err && err.kind) return err.kind;
  if (isFailoverError(err)) return "limită/autentificare/supraîncărcare";
  return (err && err.name) || "Error";
}

// Team Leader notifications (controller ruling): only claude-main going down / recovering, plus once
// when every provider is down. Individual backup/qwen/groq failures are only logged.
function markFailed(provider, err) {
  const s = get(provider.id);
  s.until = parseResetTime(err && err.message) || Date.now() + cooldownMs();
  console.error(`[AI-PROVIDER] ${provider.id} failed (${errorKind(err)}), cooldown until ${new Date(s.until).toISOString()}`);
  if (s.down) return; // already announced for this outage
  s.down = true;
  if (provider.id === "claude-main") {
    notifyLeaders("Asistent AI: comutare pe rezervă",
      `${LABELS[provider.id]} nu răspunde (${errorKind(err)}). Răspund furnizorii de rezervă; reîncerc după ${hhmm(s.until)}.`);
  }
}

function markOk(provider) {
  allDown = false;
  const s = get(provider.id);
  s.until = 0;
  if (!s.down) return;
  s.down = false;
  if (provider.id === "claude-main") notifyLeaders("Asistent AI: furnizor revenit", `${LABELS[provider.id]} funcționează din nou.`);
}

function markAllDown() {
  if (allDown) return;
  allDown = true;
  notifyLeaders("Asistent AI indisponibil", "Niciun furnizor AI nu răspunde momentan (toți au eșuat sau sunt în pauză). " +
    "Comenzile fără AI funcționează în continuare.");
}

// Tries `fn(provider, { abortController, attempt })` on each configured provider not in cooldown,
// in order. `attempt` = { usage: {input_tokens, output_tokens}, costUsd, wrote } is filled by the
// engine as it goes. A throw or a timeout = failure:
//  - err.noCooldown (HTTP 413, empty reply cut by max_tokens): next provider, no cooldown/notification;
//  - otherwise cooldown (+ notification rules above);
//  - if a write tool already succeeded in the attempt (attempt.wrote) the chain STOPS (the next
//    provider would repeat the action) -> { provider, stopped: true }.
// `onFailure(provider, attempt, err)` lets the caller record the failed attempt's tokens.
// Returns { provider, result }, { provider, stopped: true }, or null when nothing answered.
async function runWithFallback(fn, { onFailure } = {}) {
  for (const provider of list()) {
    if (cooldownUntil(provider.id) > Date.now()) continue;
    const abortController = new AbortController();
    const attempt = { usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0, wrote: false };
    let timer;
    try {
      const call = Promise.resolve().then(() => fn(provider, { abortController, attempt }));
      call.catch(() => {}); // a late rejection after a timeout must not be unhandled
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          abortController.abort();
          const err = new Error(`timeout după ${timeoutMs()} ms`);
          err.kind = "timeout";
          reject(err);
        }, timeoutMs());
      });
      const result = await Promise.race([call, timeout]);
      markOk(provider);
      return { provider, result };
    } catch (err) {
      abortController.abort();
      if (onFailure) {
        try { onFailure(provider, attempt, err); } catch (e) { console.error("[AI-PROVIDER] onFailure:", e.message); }
      }
      if (err && err.noCooldown) {
        console.error(`[AI-PROVIDER] ${provider.id} failed (${errorKind(err)}), no cooldown`);
      } else {
        markFailed(provider, err);
      }
      if (attempt.wrote) return { provider, stopped: true };
    } finally {
      clearTimeout(timer);
    }
  }
  markAllDown();
  return null;
}

// Id of the provider the next call would try first ("none" if nothing is configured or all are in
// cooldown) - for /api/health; never exposes keys/URLs.
function activeProvider() {
  const p = list().find((x) => cooldownUntil(x.id) <= Date.now());
  return p ? p.id : "none";
}

function _reset() { state.clear(); allDown = false; }

module.exports = {
  list, isConfigured, claudeEnv, isFailoverError, parseResetTime, checkReply,
  cooldownUntil, runWithFallback, activeProvider, LABELS, _reset,
};
