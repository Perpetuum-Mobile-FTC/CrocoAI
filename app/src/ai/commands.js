// Deterministic commands — zero LLM calls, work even when no AI credentials are configured
// (design v2 §8). Same services + the same format.js used by the AI tools, so wording matches.
const tasksSvc = require("../services/tasks");
const eventsSvc = require("../services/events");
const attendanceSvc = require("../services/attendance");
const documentsSvc = require("../services/documents");
const membersSvc = require("../services/members");
const profile = require("../domain/profile");
const format = require("./format");
const { GROUP_PRIVATE_TEXT } = require("../domain/ai-policy");

// Commands that show the sender's own data: never answered inside a WhatsApp group (A4).
const PRIVATE_COMMANDS = new Set(["taskuri", "taskurile mele", "prezenta", "prezenta mea", "documente", "documentele mele", "date", "profil", "datele mele"]);

function stripDiacritics(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const HELP_TEXT = `Comenzi disponibile:
- taskuri — taskurile tale deschise
- sedinta / evenimente — următoarele evenimente
- prezenta — statisticile tale de prezență
- documente — documentele cerute și statusul lor
- date / profil — ce câmpuri lipsesc din profilul tău
- ajutor — acest mesaj
Poți și să-mi scrii liber o întrebare (dacă AI-ul e configurat).`;

const THANKS_RE = /^(mersi|multumesc|mulțumesc|thanks|ty|salut|buna|bună|ok|okay|bine|super|perfect)[!.\s]*$/i;
const EMOJI_ONLY_RE = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u;

// Returns a reply string if `text` matched a deterministic command, else null.
function tryHandle(actor, text, { isGroup = false } = {}) {
  const raw = (text || "").trim();
  if (!raw) return null;
  const norm = stripDiacritics(raw);
  if (isGroup && PRIVATE_COMMANDS.has(norm)) return GROUP_PRIVATE_TEXT;

  if (norm === "ajutor" || norm === "help") return HELP_TEXT;
  if (norm === "taskuri" || norm === "taskurile mele") return format.formatTasks(tasksSvc.list(actor, { mine: true }));
  if (norm === "sedinta" || norm === "sedinte" || norm === "evenimente") {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    return format.formatEvents(eventsSvc.list(actor, { from, to }));
  }
  if (norm === "prezenta" || norm === "prezenta mea") return format.formatAttendance(attendanceSvc.statsFor(actor, actor.id));
  if (norm === "documente" || norm === "documentele mele") return format.formatDocuments(documentsSvc.myStatus(actor, actor.id));
  if (norm === "date" || norm === "profil" || norm === "datele mele") {
    const missing = membersSvc.myMissingFields(actor);
    return missing.length
      ? `Îți lipsesc: ${missing.map((f) => profile.FIELD_LABELS[f] || f).join(", ")}.`
      : "Profilul tău este complet.";
  }

  if (THANKS_RE.test(raw)) return "Cu plăcere! 🐊";
  if (EMOJI_ONLY_RE.test(raw)) return "👍";

  return null;
}

module.exports = { tryHandle, HELP_TEXT };
