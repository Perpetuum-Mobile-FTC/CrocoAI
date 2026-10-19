// Parses a `pdftotext -layout` dump of an FTC source document into the vendored markdown format
// used by app/knowledge/ftc/ and app/data/ftc-docs/ (parsed by src/services/ftc-docs.js):
// `**<CODE> — <title>**` blocks, one per rule/section, so rule numbers survive and can be cited in
// AI answers. This is the SOURCE OF TRUTH parser (ported from scripts/extract-ftc-pdf.py, which is
// kept only as a standalone reference for local dev - see docs/design-ai-hardening.md §2 update).
// Used by scripts/extract-ftc-pdf.js (CLI, local re-vendoring) AND src/services/ftc-manual-updater.js
// (runtime monthly check, inside the container - requires poppler-utils' `pdftotext` binary).
const { execFileSync } = require("child_process");

const RULE_RE = /^([A-Z]{1,3}\d{2,4})\s*\*?\s*(.*)$/;
const NUMBERED_RE = /^(\d+(?:\.\d+)*)\.?\s+([A-ZĂÂÎȘȚ].{2,90})$/;

// Boilerplate lines to drop anywhere (page headers/footers, TOC dot-leaders).
const NOISE_RES = [
  /^\s*\d+\s+of\s+\d+\s*$/,
  /^\s*Page\s*\|\s*\d+\s*$/i,
  /^Section \d+ .* \d+ of \d+\s*$/,
  /^\s*Revision\s+[\d.]+.*\d{4}\s*$/i,
  /\.{4,}\s*\d+\s*$/, // TOC dot-leader lines "Title .......... 12"
  /^\s*$/,
];

function isNoise(line) {
  return NOISE_RES.some((re) => re.test(line));
}

function cleanLines(lines) {
  return lines.filter((l) => !isNoise(l)).map((l) => l.replace(/\s+$/, ""));
}

function parseRules(lines) {
  const out = [];
  let current = null;
  for (const line of cleanLines(lines)) {
    const m = line.match(RULE_RE);
    if (m && m[1].length <= 4) {
      if (current) out.push(current);
      const title = (m[2].split(".")[0] || "").slice(0, 100).trim() || m[1];
      current = { head: `**${m[1]} — ${title}**`, body: [m[2]] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) out.push(current);
  return out.map((c) => `${c.head}\n${c.body.join(" ").trim()}`).join("\n\n");
}

function parseNumbered(lines) {
  const out = [];
  let current = null;
  for (const line of cleanLines(lines)) {
    const m = line.match(NUMBERED_RE);
    if (m) {
      if (current) out.push(current);
      current = { head: `**${m[1]} — ${m[2].trim()}**`, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) out.push(current);
  return out.map((c) => `${c.head}\n${c.body.join(" ").trim()}`).join("\n\n");
}

function parseRaw(lines) {
  return cleanLines(lines).join("\n");
}

// Extracts rule/section sections ({code, title, text}) back out of an already-built markdown
// string (same `**CODE — title**` format) - used to diff two versions of the manual without
// re-parsing PDFs (ftc-manual-updater.js) or to search (ftc-docs.js, same block shape).
function sectionsFromMarkdown(markdown) {
  const lines = String(markdown || "").split("\n");
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\*\*([^—]+?)\s*—\s*(.+?)\*\*\s*$/);
    if (m) {
      if (current) sections.push(current);
      current = { code: m[1].trim(), title: m[2].trim(), text: "" };
      continue;
    }
    if (current) current.text += line + "\n";
  }
  if (current) sections.push(current);
  for (const s of sections) s.text = s.text.trim();
  return sections;
}

// Runs the system `pdftotext -layout` (poppler-utils) on a PDF file and returns the raw text.
// Requires poppler-utils installed (app/Dockerfile runtime stage, or `brew install poppler` locally).
function extractPdfText(pdfPath, { bin } = {}) {
  const pdftotext = bin || process.env.PDFTOTEXT_BIN || "pdftotext";
  return execFileSync(pdftotext, ["-layout", pdfPath, "-"], { maxBuffer: 1024 * 1024 * 100 }).toString("utf8");
}

module.exports = { parseRules, parseNumbered, parseRaw, sectionsFromMarkdown, extractPdfText, cleanLines };
