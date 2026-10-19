// Monthly check for a new FTC Competition Manual version (BIOBUZZ 2026-2027), docs/design-ai-
// hardening.md §2 update. Downloads the official PDF with a conditional request, extracts it with
// src/services/ftc-pdf-extract.js (same parser the local sync script uses), diffs it rule-by-rule
// against the stored version, and - only for a REAL version change, never the first-ever import -
// announces it with one isolated AI call (same isolation pattern as ai/agent.js: fixed empty HOME,
// no tools, no persistence) + a deterministic fallback, posted identically as a platform
// announcement (services/announcements.js) and to WhatsApp.
const { TEAM } = require("../domain/team");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const db = require("../db");
const { assertCan } = require("../domain/policy");
const ftcDocs = require("./ftc-docs");
const ftcPdf = require("./ftc-pdf-extract");
const announcementsSvc = require("./announcements");
const { whatsappPhone } = require("./members");
const notifications = require("./notifications");
const audience = require("./audience");
const aiUsageSvc = require("./ai-usage");
const waGateway = require("./wa-gateway"); // namespace import (not destructured) so tests can mock waGateway.sendWhatsApp

const MANUAL_URL = () => process.env.FTC_MANUAL_URL || "https://ftc-resources.firstinspires.org/ftc/game/manual";
const MAX_PDF_BYTES = 50 * 1024 * 1024; // 50 MB cap
const FETCH_TIMEOUT_MS = 30000;
const SCHEDULER_STATE_FILE = "scheduler-state.json";

function runtimeDir() { return ftcDocs.RUNTIME_DIR; }
function manualPath(dir) { return path.join(dir || runtimeDir(), ftcDocs.MANUAL_FILENAME); }
function previousDir() { return path.join(runtimeDir(), "previous"); }

function loadMeta() { return ftcDocs.loadMeta(); }
function saveMeta(meta) {
  fs.mkdirSync(runtimeDir(), { recursive: true });
  const tmp = ftcDocs.META_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, ftcDocs.META_PATH);
}

// --- Version/filename parsing ------------------------------------------------------------------
// e.g. filename="BIOBUZZ_Competition_Manual_TU03.pdf" -> { season: "BIOBUZZ", version: "TU03" }
function parseFilename(filename) {
  const f = String(filename || "");
  const versionMatch = f.match(/_([A-Z]{2}\d{2})(?:\.pdf)?$/i);
  const seasonMatch = f.match(/^([A-Z0-9]+)_/i);
  return {
    version: versionMatch ? versionMatch[1].toUpperCase() : null,
    season: seasonMatch ? seasonMatch[1].toUpperCase() : null,
  };
}

function filenameFromContentDisposition(header) {
  if (!header) return null;
  const m = header.match(/filename="?([^";]+)"?/i);
  return m ? m[1] : null;
}

// --- Fetch ---------------------------------------------------------------------------------------
async function fetchManual({ etag } = {}) {
  const headers = {};
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(MANUAL_URL(), { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (res.status === 304) return { unchanged: true };

  if (!res.ok) throw new Error(`Manual fetch failed: HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/pdf")) {
    throw new Error(`Manual fetch returned unexpected content-type: ${contentType}`);
  }
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength && contentLength > MAX_PDF_BYTES) {
    throw new Error(`Manual PDF too large (${contentLength} bytes, cap ${MAX_PDF_BYTES})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES) throw new Error(`Manual PDF too large (${buf.length} bytes, cap ${MAX_PDF_BYTES})`);

  return {
    unchanged: false,
    buffer: buf,
    etag: res.headers.get("etag") || null,
    lastModified: res.headers.get("last-modified") || null,
    filename: filenameFromContentDisposition(res.headers.get("content-disposition")),
  };
}

// --- Extraction ------------------------------------------------------------------------------
function extractManualMarkdown(pdfBuffer, { season, version }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crocoai-ftc-manual-"));
  const tmpPdf = path.join(tmpDir, "manual.pdf");
  try {
    fs.writeFileSync(tmpPdf, pdfBuffer);
    const rawText = ftcPdf.extractPdfText(tmpPdf);
    const body = ftcPdf.parseRules(rawText.split("\n"));
    const header = `<!-- Preluat automat de pe ${MANUAL_URL()} prin services/ftc-manual-updater.js. Nu edita direct. -->\n` +
      `# Competition Manual ${season || ""} — Version ${version || ""} (FTC, engleză)\n\n`;
    return header + body;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Diff ----------------------------------------------------------------------------------------
function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// { added: [{code,title}], removed: [{code,title}], changed: [{code,title,oldText,newText}] }
function diffManuals(oldMarkdown, newMarkdown) {
  const oldSections = oldMarkdown ? ftcPdf.sectionsFromMarkdown(oldMarkdown) : [];
  const newSections = ftcPdf.sectionsFromMarkdown(newMarkdown);
  const oldMap = new Map(oldSections.map((s) => [s.code, s]));
  const newMap = new Map(newSections.map((s) => [s.code, s]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [code, s] of newMap) {
    if (!oldMap.has(code)) added.push({ code, title: s.title });
  }
  for (const [code, s] of oldMap) {
    if (!newMap.has(code)) removed.push({ code, title: s.title });
  }
  for (const [code, newS] of newMap) {
    const oldS = oldMap.get(code);
    if (!oldS) continue;
    if (normalizeText(oldS.text) !== normalizeText(newS.text) || oldS.title !== newS.title) {
      changed.push({ code, title: newS.title, oldText: oldS.text.slice(0, 800), newText: newS.text.slice(0, 800) });
    }
  }
  return { added, removed, changed };
}

function hasChanges(diff) {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

// --- Announcement (one isolated AI call, no tools - same pattern as ai/agent.js/meetings.js) -----
function aiConfigured() { return require("../ai/providers").isConfigured(); }

const ANNOUNCE_SYSTEM_PROMPT = `Rezumi în română, pentru echipa de robotică FTC "${TEAM.name}", schimbările
dintre două versiuni ale Competition Manual, STRICT pe baza unui diff structurat (reguli adăugate/eliminate/
modificate) primit ca input. Nu inventezi reguli sau detalii care nu apar în diff. Citezi codul fiecărei reguli
(ex. R101, G301) și titlul ei, pe scurt. Scrii cel mult 700 de caractere, fără introducere sau concluzie - doar
lista schimbărilor, ca text simplu (liniuțe "- "), potrivit pentru WhatsApp.`;

// Goes through the AI fallback chain (ai/complete.js). Exposed separately so tests can replace
// it - the real Agent SDK is NEVER called in tests.
async function generateAnnouncementText(userPrompt) {
  const { complete } = require("../ai/complete");
  return complete({ system: ANNOUNCE_SYSTEM_PROMPT, prompt: userPrompt, maxTokens: 1500, agentDir: "crocoai-agent-ftc-manual" });
}

function buildDiffPrompt({ oldVersion, newVersion, added, removed, changed }) {
  const lines = [`Manual FTC: versiunea ${oldVersion || "necunoscută"} → ${newVersion}.`];
  if (added.length) lines.push(`Reguli ADĂUGATE:\n${added.map((a) => `${a.code} — ${a.title}`).join("\n")}`);
  if (removed.length) lines.push(`Reguli ELIMINATE:\n${removed.map((r) => `${r.code} — ${r.title}`).join("\n")}`);
  if (changed.length) {
    lines.push(`Reguli MODIFICATE:\n${changed.map((c) =>
      `${c.code} — ${c.title}\n  VECHI: ${c.oldText}\n  NOU: ${c.newText}`).join("\n\n")}`);
  }
  return lines.join("\n\n");
}

function deterministicSummary({ added, removed, changed }) {
  const parts = [];
  if (added.length) parts.push(`Reguli noi: ${added.map((a) => `${a.code} (${a.title})`).join(", ")}.`);
  if (removed.length) parts.push(`Reguli eliminate: ${removed.map((r) => `${r.code} (${r.title})`).join(", ")}.`);
  if (changed.length) parts.push(`Reguli modificate: ${changed.map((c) => `${c.code} (${c.title})`).join(", ")}.`);
  return parts.join("\n") || "Au fost detectate modificări minore.";
}

async function buildAnnouncementMessage({ season, oldVersion, newVersion, added, removed, changed }) {
  const header = `📘 Manualul FTC (${season}) a fost actualizat: ${oldVersion || "?"} → ${newVersion}.`;
  let body;
  if (aiConfigured()) {
    try {
      const prompt = buildDiffPrompt({ oldVersion, newVersion, added, removed, changed });
      const { text, usage, cost, model } = await module.exports.generateAnnouncementText(prompt);
      aiUsageSvc.record({ member: null, channel: "system", model, usage, cost_usd: cost, tool_calls: 0 });
      body = text && text.trim() ? text.trim() : deterministicSummary({ added, removed, changed });
    } catch (err) {
      console.error("[FTC-MANUAL] announcement AI call failed, using deterministic summary:", err.message);
      body = deterministicSummary({ added, removed, changed });
    }
  } else {
    body = deterministicSummary({ added, removed, changed });
  }
  let message = `${header}\n${body}\n\nDetalii în CrocoAI → Regulament → Manuale FTC.`;
  if (message.length > 1200) message = `${message.slice(0, 1197)}…`;
  return message;
}

// --- Delivery --------------------------------------------------------------------------------
async function deliverAnnouncement(message) {
  // Platform: an automated announcement for the whole team (Acasă → Anunțuri, design-pachet-b.md B2).
  const [title, ...rest] = message.split("\n");
  const posted = announcementsSvc.publishSystem(title, rest.join("\n"));

  let waOk = false;
  if (process.env.TEAM_GROUP_ID) {
    waOk = await waGateway.sendWhatsApp(process.env.TEAM_GROUP_ID, message);
    if (waOk && posted) db.prepare("UPDATE announcements SET sent_whatsapp_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(posted.id);
  }
  if (!waOk) {
    const prefixed = `⚠️ Nu am putut posta în grupul echipei pe WhatsApp - ${message}`;
    for (const l of audience.activeTeamLeaders()) {
      const phone = whatsappPhone(l); // verified phones only (A3)
      if (phone) await waGateway.sendWhatsApp(phone, prefixed);
      notifications.create(l.id, "ftc_manual_update", "Manual FTC actualizat", message, "/documente?tab=regulament");
    }
  }
}

// --- Scheduler state (idempotent monthly run across restarts) --------------------------------
function schedulerStatePath() { return path.join(runtimeDir(), SCHEDULER_STATE_FILE); }
function loadSchedulerState() {
  try { return JSON.parse(fs.readFileSync(schedulerStatePath(), "utf8")); } catch { return {}; }
}
function saveSchedulerState(state) {
  fs.mkdirSync(runtimeDir(), { recursive: true });
  fs.writeFileSync(schedulerStatePath(), JSON.stringify(state));
}

function bucharestParts(now) {
  const s = now.toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }); // "YYYY-MM-DD HH:mm:ss"
  const [datePart, timePart] = s.split(" ");
  const [y, m, d] = datePart.split("-");
  return { monthKey: `${y}-${m}`, day: d, time: timePart };
}

function monthlyTickDue(now) {
  const { monthKey, day, time } = bucharestParts(now);
  if (day !== "01" || time < "10:00:00") return false;
  const state = loadSchedulerState();
  return state.last_monthly_run !== monthKey;
}

// --- Core: checkForUpdate -----------------------------------------------------------------------
// `actor` is optional: present when called from the force-check route (permission enforced here,
// golden rule), absent when called internally by the scheduler (trusted).
async function checkForUpdate({ actor, force = false } = {}) {
  if (actor) assertCan(actor, "ftc_manual.manage");

  const meta = loadMeta();
  const nowIso = new Date().toISOString();

  let fetched;
  try {
    fetched = await fetchManual({ etag: force ? null : meta && meta.etag });
  } catch (err) {
    const newMeta = { ...(meta || {}), last_checked_at: nowIso, last_check_result: `error: ${err.message}` };
    saveMeta(newMeta);
    return { ok: false, changed: false, error: err.message };
  }

  if (fetched.unchanged) {
    saveMeta({ ...(meta || {}), last_checked_at: nowIso, last_check_result: "unchanged" });
    return { ok: true, changed: false };
  }

  const sha256 = crypto.createHash("sha256").update(fetched.buffer).digest("hex");
  if (meta && meta.sha256 === sha256) {
    saveMeta({ ...meta, etag: fetched.etag || meta.etag, last_modified: fetched.lastModified || meta.last_modified, last_checked_at: nowIso, last_check_result: "unchanged" });
    return { ok: true, changed: false };
  }

  const { version, season } = parseFilename(fetched.filename);
  const newVersion = version || "necunoscuta";
  const newSeason = season || "FTC";

  let newMarkdown;
  try {
    newMarkdown = extractManualMarkdown(fetched.buffer, { season: newSeason, version: newVersion });
  } catch (err) {
    saveMeta({ ...(meta || {}), last_checked_at: nowIso, last_check_result: `error: extracție eșuată (${err.message})` });
    return { ok: false, changed: false, error: `Extracție eșuată: ${err.message}` };
  }

  const isFirstImport = !meta;
  const oldMarkdown = isFirstImport ? null : ftcDocs.full(ftcDocs.MANUAL_FILENAME);
  const diff = diffManuals(oldMarkdown, newMarkdown);

  // Atomic write: tmp files, then rename. Keep the previous version's parsed copy.
  fs.mkdirSync(runtimeDir(), { recursive: true });
  const finalPath = manualPath();
  if (!isFirstImport && fs.existsSync(finalPath) && meta && meta.version) {
    fs.mkdirSync(previousDir(), { recursive: true });
    fs.copyFileSync(finalPath, path.join(previousDir(), `${meta.version}.md`));
  }
  const tmpManual = `${finalPath}.tmp`;
  fs.writeFileSync(tmpManual, newMarkdown);
  fs.renameSync(tmpManual, finalPath);

  const newMeta = {
    source_url: MANUAL_URL(),
    filename: fetched.filename,
    version: newVersion,
    season: newSeason,
    etag: fetched.etag,
    last_modified: fetched.lastModified,
    sha256,
    fetched_at: nowIso,
    last_checked_at: nowIso,
    last_check_result: isFirstImport ? "seed" : "updated",
  };
  saveMeta(newMeta);
  ftcDocs.invalidateCache();

  if (isFirstImport) {
    return { ok: true, changed: true, firstImport: true, version: newVersion };
  }

  db.prepare(`
    INSERT INTO ftc_manual_versions (version, filename, etag, sha256, added, removed, changed, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newVersion, fetched.filename || null, fetched.etag || null, sha256,
    JSON.stringify(diff.added), JSON.stringify(diff.removed), JSON.stringify(diff.changed),
    null
  );

  if (hasChanges(diff)) {
    const message = await buildAnnouncementMessage({
      season: newSeason, oldVersion: meta.version, newVersion, added: diff.added, removed: diff.removed, changed: diff.changed,
    });
    db.prepare("UPDATE ftc_manual_versions SET summary = ? WHERE version = ? AND fetched_at = (SELECT MAX(fetched_at) FROM ftc_manual_versions WHERE version = ?)")
      .run(message, newVersion, newVersion);
    await deliverAnnouncement(message);
  }

  return { ok: true, changed: true, version: newVersion, added: diff.added, removed: diff.removed, changed_rules: diff.changed };
}

// --- Admin status (LEADERS) -----------------------------------------------------------------
function getStatus(actor) {
  assertCan(actor, "ftc_manual.manage");
  const meta = loadMeta();
  const history = db.prepare("SELECT * FROM ftc_manual_versions ORDER BY fetched_at DESC LIMIT 20").all().map((r) => ({
    ...r, added: JSON.parse(r.added), removed: JSON.parse(r.removed), changed: JSON.parse(r.changed),
  }));
  return { current: meta, history };
}

// --- Scheduler (same style as reminder-scheduler.js: tick every 60s, idempotent) ----------------
let lastTickAt = null;
function getLastTickAt() { return lastTickAt; }

async function tick() {
  const now = new Date();
  lastTickAt = now;
  if (!monthlyTickDue(now)) return;
  const { monthKey } = bucharestParts(now);
  const state = loadSchedulerState();
  state.last_monthly_run = monthKey; // marked before running: a crash mid-check retries on next restart's check only if still due, never loops within the same month
  saveSchedulerState(state);
  await checkForUpdate({});
}

function start() {
  setInterval(() => { tick().catch((err) => console.error("[FTC-MANUAL]", err.message)); }, 60000);
  tick().catch((err) => console.error("[FTC-MANUAL]", err.message));
}

module.exports = {
  checkForUpdate,
  getStatus,
  start,
  tick,
  getLastTickAt,
  generateAnnouncementText,
  buildAnnouncementMessage,
  diffManuals,
  deterministicSummary,
  parseFilename,
  monthlyTickDue,
};
