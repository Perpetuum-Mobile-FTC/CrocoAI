// Parses the vendored regulament into articles and exposes search/get/full. Used identically
// by the Regulament page and the AI tool `cauta_regulament` (design v2, §1, §8).
const fs = require("fs");
const path = require("path");
const { assertCan } = require("../domain/policy");

const FILE_PATH = path.join(__dirname, "..", "..", "knowledge", "regulament-intern.md");

function stripDiacritics(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

let cache = null;

// Parses `**Art. N — Title**` blocks (keeping the chapter heading above them).
function parse() {
  if (cache) return cache;
  const raw = fs.readFileSync(FILE_PATH, "utf8");
  const lines = raw.split("\n");
  const articles = [];
  let currentChapter = null;
  let current = null;

  for (const line of lines) {
    const chapterMatch = line.match(/^##\s+(CAPITOLUL.+)$/);
    if (chapterMatch) { currentChapter = chapterMatch[1].trim(); continue; }

    const artMatch = line.match(/^\*\*Art\.\s*(\d+)\s*[—-]\s*(.+?)\*\*\s*$/);
    if (artMatch) {
      if (current) articles.push(current);
      current = { number: parseInt(artMatch[1], 10), title: artMatch[2].trim(), chapter: currentChapter, text: "" };
      continue;
    }
    if (current) current.text += line + "\n";
  }
  if (current) articles.push(current);
  for (const a of articles) a.text = a.text.trim();
  cache = articles;
  return articles;
}

function get(articleNumber) {
  return parse().find((a) => a.number === Number(articleNumber)) || null;
}

function full() {
  return fs.readFileSync(FILE_PATH, "utf8");
}

// Simple scoring: counts occurrences of each query word (diacritic-insensitive) in title+text,
// title match weighted higher. Returns top N articles with exact text + number.
function search(query, limit = 5) {
  const words = stripDiacritics(query).split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return [];
  const scored = parse().map((a) => {
    const title = stripDiacritics(a.title);
    const text = stripDiacritics(a.text);
    let score = 0;
    for (const w of words) {
      if (title.includes(w)) score += 3;
      const occurrences = text.split(w).length - 1;
      score += occurrences;
    }
    return { article: a, score };
  }).filter((r) => r.score > 0);
  scored.sort((a, b) => b.score - a.score || a.article.number - b.article.number);
  return scored.slice(0, limit).map((r) => ({
    number: r.article.number,
    title: r.article.title,
    chapter: r.article.chapter,
    text: r.article.text,
  }));
}

// Version from the header (`**Versiunea:** 1.0`) - stored with every electronic acceptance (Art. 72.3).
function version() {
  const m = fs.readFileSync(FILE_PATH, "utf8").match(/^\*\*Versiunea:\*\*\s*(.+?)\s*$/m);
  return m ? m[1] : null;
}

// Full text for the public sign-up forms (Art. 72.3: you accept what you could read), without the vendoring comment.
function publicText() {
  return fs.readFileSync(FILE_PATH, "utf8").replace(/^<!--[\s\S]*?-->\s*/, "");
}

// Actor-gated entry points shared by the routes and the AI tool (regulament.read).
function fullFor(actor) { assertCan(actor, "regulament.read"); return full(); }
function searchFor(actor, query) { assertCan(actor, "regulament.read"); return search(query || ""); }
function articleFor(actor, n) { assertCan(actor, "regulament.read"); return get(n); }

module.exports = { parse, get, full, search, fullFor, searchFor, articleFor, version, publicText };
