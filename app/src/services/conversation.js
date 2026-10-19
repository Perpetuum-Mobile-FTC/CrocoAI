// The ONE reply pipeline for the AI assistant, shared by the web chat (routes/ai.js) and WhatsApp
// (routes/wa-incoming.js): onboarding dialog (WhatsApp, private) -> pending "DA" confirmation ->
// deterministic commands -> runAgent; then persistence per channel (web_chat_messages / messages).
const db = require("../db");
const agent = require("../ai/agent"); // namespace import so tests can mock runAgent
const commands = require("../ai/commands");
const pending = require("../ai/pending");
const waGateway = require("./wa-gateway"); // namespace import so tests can mock sendWhatsApp
const onboarding = require("./onboarding");

const HISTORY_LIMIT = 8;
const UNKNOWN_SENDER_TEXT = "Nu te recunosc ca membru al echipei. Contactează un Team Leader.";
const ERROR_TEXT = {
  web: "Scuze, am o problemă tehnică momentan. Încearcă din nou în câteva minute.",
  wa: "Scuze, am o problemă tehnică momentan.",
};

const webChatId = (actor) => `web:${actor.id}`;

// ─── Persistence ──────────────────────────────────────────────────────────────────────────────

// Web chat: chronological (oldest -> newest), last `limit` lines of the member's own chat.
function webHistory(actor, limit = 100) {
  return db.prepare("SELECT * FROM web_chat_messages WHERE member_id = ? ORDER BY id DESC LIMIT ?").all(actor.id, limit).reverse();
}

function saveWeb(actor, type, body) {
  db.prepare("INSERT INTO web_chat_messages (member_id, message_type, body) VALUES (?, ?, ?)").run(actor.id, type, body);
}

// WhatsApp: context lines of a chat. isOther (design-ai-hardening.md §4): a group-chat line from
// someone other than the current sender is context, never an instruction.
function waHistory(chatId, fromDigits) {
  return db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?").all(chatId, HISTORY_LIMIT).reverse()
    .map((m) => ({
      from: m.from_me ? "bot" : "user",
      name: m.sender_name,
      body: m.body,
      isOther: !m.from_me && !!fromDigits && m.sender_phone !== fromDigits,
    }));
}

// Idempotency (design v2 §8): true = first time we see msgId, false = already processed.
// Any error other than a primary-key clash is rethrown.
function claimWaMessage(msgId) {
  try {
    db.prepare("INSERT INTO wa_message_log (msg_id) VALUES (?)").run(msgId);
    return true;
  } catch (err) {
    if (String(err.code).startsWith("SQLITE_CONSTRAINT")) return false;
    throw err;
  }
}

function memberByPhone(digits) {
  return digits ? db.prepare("SELECT * FROM members WHERE phone = ?").get(digits) : null;
}

// Logs an incoming WhatsApp message and returns the history read BEFORE logging it (audit fix: the
// current message used to appear twice in context).
function recordWaIncoming({ chatId, fromDigits, pushName, text, isGroup, groupName }) {
  const history = waHistory(chatId, fromDigits);
  db.prepare(`INSERT INTO messages (chat_id, sender_phone, sender_name, body, from_me, is_group, group_name)
    VALUES (?, ?, ?, ?, 0, ?, ?)`).run(chatId, fromDigits || null, pushName || null, text || "", isGroup ? 1 : 0, groupName || null);
  return history;
}

function saveWaReply(chatId, reply, isGroup) {
  db.prepare(`INSERT INTO messages (chat_id, sender_phone, sender_name, body, from_me, is_group)
    VALUES (?, NULL, 'CrocoAI', ?, 1, ?)`).run(chatId, reply, isGroup ? 1 : 0);
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────────────────────

// -> { reply, notice?, stage: "unknown"|"onboarding"|"confirmed"|"command"|"agent" }
async function answer({ actor, channel, chatId, text, isGroup = false, history }) {
  if (!actor) return { reply: UNKNOWN_SENDER_TEXT, stage: "unknown" };
  // Onboarding hook (design-phase2.md §6, C3): NO LLM during onboarding (v1 lesson). WhatsApp private only.
  if (channel === "wa" && !isGroup && actor.onboarding_step > 0) {
    return { reply: await onboarding.handleReply(actor, text), stage: "onboarding" };
  }
  // Groups (A4): no confirmations there - only public answers.
  const confirmed = isGroup ? null : await pending.confirmIfAny(actor.id, chatId, text);
  if (confirmed) return { reply: confirmed, stage: "confirmed" };
  const detReply = commands.tryHandle(actor, text, { isGroup });
  if (detReply) return { reply: detReply, stage: "command" };
  const { reply, notice } = await agent.runAgent({ actor, channel, chatId, text, history, isGroup });
  return { reply: reply || notice, notice, stage: "agent" };
}

// handleMessage({ actor, channel: "web"|"wa", chatId, text, isGroup, history? })
//   web: reads history, logs the user line, answers, logs the reply -> the JSON body of POST /api/ai/web-chat.
//   wa:  `history` comes from recordWaIncoming (the incoming line is logged even when the bot stays silent);
//        answers, sends on WhatsApp, logs the reply once sent -> { reply, sent }.
async function handleMessage({ actor, channel, chatId, text, isGroup = false, history }) {
  if (channel === "web") return handleWeb(actor, chatId || webChatId(actor), text);
  let reply;
  try {
    ({ reply } = await answer({ actor, channel: "wa", chatId, text, isGroup, history }));
  } catch (err) {
    console.error("[WA-INCOMING] AI error:", err.message);
    reply = ERROR_TEXT.wa;
  }
  if (!reply) return { reply: null, sent: false };
  const sent = await waGateway.sendWhatsApp(chatId, reply);
  if (sent) saveWaReply(chatId, reply, isGroup);
  return { reply, sent: !!sent };
}

async function handleWeb(actor, chatId, text) {
  const history = webHistory(actor, HISTORY_LIMIT)
    .map((m) => ({ from: m.message_type === "web-ai" ? "bot" : "user", name: actor.full_name, body: m.body }));
  saveWeb(actor, "web-user", text);
  try {
    const { reply, notice, stage } = await answer({ actor, channel: "web", chatId, text, history });
    saveWeb(actor, "web-ai", reply);
    const pendingConfirmation = stage === "confirmed" ? null : pending.getPublic(actor.id, chatId);
    return notice ? { reply, notice, pending_confirmation: pendingConfirmation } : { reply, pending_confirmation: pendingConfirmation };
  } catch (err) {
    console.error("[AI web-chat]", err.message);
    saveWeb(actor, "web-ai", ERROR_TEXT.web);
    return { reply: ERROR_TEXT.web };
  }
}

// Current pending WhatsApp-send confirmation of the member's web chat (restores the DA/Anulează prompt).
function webPending(actor) {
  return pending.getPublic(actor.id, webChatId(actor));
}

module.exports = { handleMessage, answer, webHistory, webPending, claimWaMessage, memberByPhone, recordWaIncoming, UNKNOWN_SENDER_TEXT };
