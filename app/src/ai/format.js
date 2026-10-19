// Single formatter for tasks/events/attendance/documents/profile text — used by BOTH the AI
// tools (tools.js) and the deterministic commands (commands.js), so the wording is identical
// whichever path produced the answer (design v2 §8).
const { utcToBucharest } = require("../domain/time");

// ISO UTC -> "DD.MM.YYYY HH:MM" Europe/Bucharest.
function formatLocalDateTime(iso) {
  const { date, time } = utcToBucharest(Date.parse(iso));
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y} ${time}`;
}

function formatTasks(tasks) {
  if (!tasks || !tasks.length) return "Nu ai taskuri deschise.";
  return tasks.map((t) => `- ${t.title}${t.due_date ? ` (scadent ${t.due_date})` : ""}${t.remind_at ? ` (reminder ${formatLocalDateTime(t.remind_at)})` : ""} [${t.status}]`).join("\n");
}

function formatEvents(events) {
  if (!events || !events.length) return "Niciun eveniment programat.";
  return events.map((e) => `- ${e.title} — ${formatDateTime(e.start_time)}${e.location ? `, ${e.location}` : ""} (${e.type})`).join("\n");
}

function formatDateTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("ro-RO", { timeZone: "Europe/Bucharest", dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function formatAttendance(stats) {
  if (!stats) return "Nu există date de prezență.";
  const lines = [];
  lines.push(`Sezon ${stats.season}: ${stats.sessions_counted} ședințe contorizate.`);
  lines.push(`Prezent: ${stats.present} · Absent: ${stats.absent} · Motivat: ${stats.motivat} · Scutit: ${stats.scutit}`);
  lines.push(stats.pct === null ? "Procent: fără date suficiente." : `Procent: ${stats.pct}% (prag ${stats.threshold_pct}%)`);
  if (stats.signals && stats.signals.length) {
    lines.push("Semnale:");
    for (const s of stats.signals) lines.push(`- ${s.message}`);
  }
  return lines.join("\n");
}

function formatDocuments(docs) {
  if (!docs || !docs.length) return "Niciun document necesar.";
  return docs.map((d) => {
    const status = d.document ? d.document.status : "lipsă";
    const sign = d.who_signs && status !== "aprobat" ? ` — ${d.who_signs}` : "";
    return `- ${d.title} (${d.article || "fără articol"}): ${status}${sign}`;
  }).join("\n") + (docs.some((d) => !d.document || d.document.status !== "aprobat") && docs[0].steps ? `\n${docs[0].steps}` : "");
}

function formatMissingDocuments(matrix) {
  if (!matrix || !matrix.length) return "Nimeni nu are documente lipsă.";
  const withMissing = matrix
    .map((m) => ({ name: m.name, missing: m.documents.filter((d) => d.status === "lipsa").map((d) => d.title) }))
    .filter((m) => m.missing.length);
  if (!withMissing.length) return "Nimeni nu are documente lipsă.";
  return withMissing.map((m) => `- ${m.name}: ${m.missing.join(", ")}`).join("\n");
}

function formatProfile(profile) {
  if (!profile) return "Profil negăsit.";
  const lines = [`${profile.name} — ${profile.role}${profile.department ? `, ${profile.department}` : ""} (${profile.status})`];
  if (profile.phone) lines.push(`Telefon: ${profile.phone}`);
  if (profile.email) lines.push(`Email: ${profile.email}`);
  if (profile.joined_at) lines.push(`Membru din: ${formatDateTime(profile.joined_at)}`);
  return lines.join("\n");
}

function formatMember(m) {
  return `${m.name} — ${m.role}${m.department ? `, ${m.department}` : ""} (${m.status})`;
}

function formatArticles(articles) {
  if (!articles || !articles.length) return "Niciun articol găsit.";
  return articles.map((a) => `Art. ${a.number} — ${a.title}\n${a.text}`).join("\n\n");
}

// Same shape as formatArticles but for FTC documents (ftc-docs.js): code can be a rule (G301) or
// a section number (6.1), always with the source document so answers cite "unde" exact.
// Capped so one search fits small-context models (Groq on_demand: 8000 tokens/min) and stays cheap:
// a section is cut at FTC_SECTION_MAX chars (a single result, e.g. an exact rule code, at
// FTC_SINGLE_MAX), with a hint to ask for the exact rule; sections stop once FTC_TOTAL_MAX is reached.
const FTC_SECTION_MAX = 1500;
const FTC_SINGLE_MAX = 4000;
const FTC_TOTAL_MAX = 6000;
const FTC_TRUNCATED = "… (text trunchiat — cere regula exactă după cod, ex. R102)";

function formatFtcSections(sections) {
  if (!sections || !sections.length) return "Niciun rezultat găsit în manualele FTC.";
  const max = sections.length === 1 ? FTC_SINGLE_MAX : FTC_SECTION_MAX;
  const parts = [];
  let total = 0;
  for (const s of sections) {
    const text = s.text.length > max ? `${s.text.slice(0, max).trimEnd()}${FTC_TRUNCATED}` : s.text;
    const part = `${s.code} — ${s.title} (${s.source})\n${text}`;
    if (parts.length && total + part.length > FTC_TOTAL_MAX) break;
    parts.push(part);
    total += part.length + 2;
  }
  return parts.join("\n\n");
}

// Safety net for model output: Markdown -> WhatsApp style (*bold*, no # headings).
function toWhatsAppText(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .trim();
}

module.exports = {
  toWhatsAppText,
  formatTasks,
  formatLocalDateTime,
  formatEvents,
  formatAttendance,
  formatDocuments,
  formatMissingDocuments,
  formatProfile,
  formatMember,
  formatArticles,
  formatFtcSections,
  formatDateTime,
};
