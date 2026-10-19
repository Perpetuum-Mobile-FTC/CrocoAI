// Parses the FTC documents (Competition Manual, Regulament NpE) into searchable sections. Used
// identically by GET /api/ftc-docs/search, the "Manuale FTC" tab in the Regulament page, and the AI
// tool `cauta_manual_ftc` (docs/design-ai-hardening.md §2).
//
// The Competition Manual is fetched/updated live by services/ftc-manual-updater.js (monthly check,
// BIOBUZZ 2026-2027) and stored in RUNTIME_DIR (app/data/ftc-docs/, persisted volume). Until the
// first successful fetch (or if that directory is ever empty), this falls back to the vendored
// SEED copy in app/knowledge/ftc/ (BIOBUZZ TU03 as of 2026-10-02) - same file shape either way.
// Regulament NpE has no live source (static per season) - always vendored (sync-ftc-docs.sh).
const fs = require("fs");
const path = require("path");
const { sectionsFromMarkdown } = require("./ftc-pdf-extract");
const { assertCan } = require("../domain/policy");

const SEED_DIR = path.join(__dirname, "..", "..", "knowledge", "ftc");
const RUNTIME_DIR = process.env.FTC_DOCS_DIR || path.join(__dirname, "..", "..", "data", "ftc-docs");
const META_PATH = path.join(RUNTIME_DIR, "meta.json");
const MANUAL_FILENAME = "competition-manual.md";

// Describes the vendored seed so the version label is correct even before any runtime fetch ran.
const SEED_META = { season: "BIOBUZZ", version: "TU03", fetched_at: "2026-10-02", seed: true };

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  } catch {
    return null;
  }
}

// Current manual file: runtime fetch if present, otherwise the vendored seed. Returns
// { filePath, meta } where meta is null only if even the seed is somehow missing.
function manualSource() {
  const runtimeFile = path.join(RUNTIME_DIR, MANUAL_FILENAME);
  const meta = loadMeta();
  if (meta && fs.existsSync(runtimeFile)) return { filePath: runtimeFile, meta };
  const seedFile = path.join(SEED_DIR, MANUAL_FILENAME);
  return { filePath: seedFile, meta: fs.existsSync(seedFile) ? SEED_META : null };
}

// Public: version info for the Regulament page / AI tool citations, e.g. "BIOBUZZ TU03".
function manualVersionInfo() {
  const { meta } = manualSource();
  return meta;
}

function manualSourceLabel() {
  const meta = manualVersionInfo();
  if (!meta) return "Competition Manual (FTC, engleză)";
  return `Competition Manual ${meta.season} ${meta.version} (FTC, engleză)`;
}

function docsList() {
  return [
    { file: MANUAL_FILENAME, source: manualSourceLabel() },
    { file: "regulament-npe.md", source: "Regulament Nație prin Educație 2026-2027" },
  ];
}

function stripDiacritics(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

let cache = null;
let cacheKey = null;

function fileFor(docFile) {
  if (docFile === MANUAL_FILENAME) return manualSource().filePath;
  return path.join(SEED_DIR, docFile);
}

function parseDoc(doc) {
  const filePath = fileFor(doc.file);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  return sectionsFromMarkdown(raw).map((s) => ({ ...s, source: doc.source }));
}

// Cache key includes the manual's fetched_at/version so an update (ftc-manual-updater.js) doesn't
// serve stale search results until the next process restart - invalidateCache() also forces it.
function currentCacheKey() {
  const meta = manualVersionInfo();
  return meta ? `${meta.version}:${meta.fetched_at}` : "none";
}

function parse() {
  const key = currentCacheKey();
  if (cache && cacheKey === key) return cache;
  const docs = docsList();
  cache = docs.flatMap(parseDoc);
  cacheKey = key;
  return cache;
}

// Called by ftc-manual-updater.js right after swapping in a new version.
function invalidateCache() {
  cache = null;
  cacheKey = null;
}

function full(docFile) {
  const filePath = fileFor(docFile);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

function listDocs() {
  return docsList();
}

// Common words that appear in nearly every rule's text (ROBOT, MATCH, TEAM...) and would
// otherwise swamp the score without discriminating between sections.
const STOPWORDS = new Set(["the", "and", "for", "are", "with", "robot", "robots", "team", "teams",
  "match", "field", "this", "that", "must", "may", "not", "din", "pentru", "care", "este", "sau"]);

// Same scoring style as services/regulament.js: word-occurrence count, diacritic-insensitive,
// title match weighted higher, plus an exact-code match (e.g. "R101") always wins.
function search(query, limit = 5) {
  const q = stripDiacritics(query).trim();
  const words = q.split(/\s+/).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  const exactCode = query.trim().toUpperCase();
  const all = parse();

  const exact = all.filter((s) => s.code.toUpperCase() === exactCode);
  if (exact.length) return exact.slice(0, limit);

  if (words.length === 0) return [];
  const scored = all.map((s) => {
    const title = stripDiacritics(s.title);
    const text = stripDiacritics(s.text);
    const code = stripDiacritics(s.code);
    let score = 0;
    for (const w of words) {
      const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
      if (code.includes(w)) score += 5;
      if (title.match(re)) score += 3;
      // Cap per-word occurrence contribution so one very common term in a long section can't
      // outscore a tightly-relevant short one.
      score += Math.min((text.match(re) || []).length, 3);
    }
    return { section: s, score };
  }).filter((r) => r.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((r) => r.section);
}

// Actor-gated entry points shared by the routes and the AI tool: same permission as the internal
// regulament (design-ai-hardening.md §2) - any member can read the FTC manuals.
function searchFor(actor, query) { assertCan(actor, "regulament.read"); return search(query || ""); }
function listDocsFor(actor) { assertCan(actor, "regulament.read"); return listDocs(); }
function fullFor(actor, docFile) { assertCan(actor, "regulament.read"); return full(docFile); }
function manualVersionFor(actor) { assertCan(actor, "regulament.read"); return manualVersionInfo(); }

module.exports = {
  search, parse, full, listDocs, invalidateCache, manualVersionInfo,
  searchFor, listDocsFor, fullFor, manualVersionFor,
  RUNTIME_DIR, SEED_DIR, META_PATH, MANUAL_FILENAME, loadMeta,
};
