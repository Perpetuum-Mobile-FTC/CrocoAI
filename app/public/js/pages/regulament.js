import { api } from "../api.js";
import { esc, loadingHtml, errorHtml, emptyHtml } from "../ui.js";

// Mirrors the server-side parser in src/services/regulament.js (chapter headings + `**Art. N — Title**`)
// so the page can build chapter navigation + per-article anchors client-side from the raw markdown.
function parseRegulament(raw) {
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
  const chapters = [];
  for (const a of articles) {
    a.text = a.text.trim();
    if (!chapters.includes(a.chapter)) chapters.push(a.chapter);
  }
  return { articles, chapters };
}

function mdToHtml(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .split(/\n{2,}/).map((block) => {
      const lines = block.split("\n").filter((l) => l.trim());
      if (lines.every((l) => /^-\s/.test(l.trim()))) {
        return `<ul>${lines.map((l) => `<li>${l.trim().replace(/^-\s/, "")}</li>`).join("")}</ul>`;
      }
      return `<p>${lines.join("<br>")}</p>`;
    }).join("");
}

export async function mountRegulament(container, hash) {
  container.innerHTML = `
    <div class="container regulament-page">
      <h1>Regulament</h1>
      <div class="tabs" id="reg-tabs">
        <button class="tab-btn active" data-tab="intern">Regulament intern</button>
        <button class="tab-btn" data-tab="ftc">Manuale FTC</button>
      </div>
      <div id="tab-intern" class="tab-pane">${loadingHtml()}</div>
      <div id="tab-ftc" class="tab-pane hidden"></div>
    </div>`;
  const wrap = container.querySelector(".container");

  container.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      container.querySelectorAll(".tab-pane").forEach((p) => p.classList.add("hidden"));
      const pane = document.getElementById(`tab-${btn.dataset.tab}`);
      pane.classList.remove("hidden");
      if (!pane.dataset.loaded) { pane.dataset.loaded = "1"; if (btn.dataset.tab === "ftc") mountFtcTab(pane); }
    });
  });

  await mountInternTab(document.getElementById("tab-intern"), wrap, hash);
}

async function mountInternTab(pane, wrap, hash) {
  let data;
  try {
    data = await api.get("/api/regulament");
  } catch (e) { pane.innerHTML = errorHtml(e); return; }

  const { articles, chapters } = parseRegulament(data.full);

  pane.innerHTML = `
    <input class="input" id="reg-search" aria-label="Caută în regulament" placeholder="Caută în regulament…" style="margin-bottom:16px">
    <div id="reg-search-results"></div>
    <div class="regulament-layout">
      <nav class="regulament-nav" id="reg-nav">
        ${chapters.map((ch) => `
          <div class="reg-chapter-group">
            <div class="reg-chapter-title">${esc(ch)}</div>
            ${articles.filter((a) => a.chapter === ch).map((a) => `<a href="/documente?tab=regulament#art-${a.number}" data-link data-art-nav="${a.number}">Art. ${a.number} — ${esc(a.title)}</a>`).join("")}
          </div>`).join("")}
      </nav>
      <div class="regulament-content" id="reg-content">
        ${articles.map((a) => `
          <section class="reg-article" id="art-${a.number}">
            <h2>Art. ${a.number} — ${esc(a.title)}</h2>
            ${mdToHtml(a.text)}
          </section>`).join("")}
      </div>
    </div>`;

  let searchTimer = null;
  document.getElementById("reg-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => doSearch(q), 250);
  });

  async function doSearch(q) {
    const resultsEl = document.getElementById("reg-search-results");
    if (!q) { resultsEl.innerHTML = ""; document.getElementById("reg-content").classList.remove("hidden"); return; }
    document.getElementById("reg-content").classList.add("hidden");
    resultsEl.innerHTML = loadingHtml("Se caută…");
    try {
      const results = await api.get(`/api/regulament/search?q=${encodeURIComponent(q)}`);
      resultsEl.innerHTML = results.length
        ? `<div class="card"><div class="list">${results.map((r) => `
            <a href="/documente?tab=regulament#art-${r.number}" data-link class="list-item">
              <div class="list-item-main"><strong>Art. ${r.number} — ${esc(r.title)}</strong><span class="muted small">${esc(r.chapter || "")}</span></div>
            </a>`).join("")}</div></div>`
        : emptyHtml("Niciun rezultat.");
    } catch (e) { resultsEl.innerHTML = errorHtml(e); }
  }

  function scrollToHash() {
    const h = location.hash;
    if (h && h.startsWith("#art-")) {
      const el = document.getElementById(h.slice(1));
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        wrap.querySelectorAll(".reg-article").forEach((s) => s.classList.remove("highlight"));
        el.classList.add("highlight");
      }
    }
  }
  scrollToHash();
  window.addEventListener("hashchange", scrollToHash, { once: false });
}

// "Manuale FTC" (docs/design-ai-hardening.md §2) — same search the AI tool cauta_manual_ftc uses,
// so the platform and the agent show identical results for the same query.
async function mountFtcTab(pane) {
  pane.innerHTML = `
    <p class="muted">Caută în Competition Manual (sezonul curent) și Regulamentul Nație prin Educație
    2026–2027. Textele oficiale FTC sunt în engleză.</p>
    <p class="muted small" id="ftc-manual-version"></p>
    <input class="input" id="ftc-search" aria-label="Caută (ex. robot size, TeleOp, inspection)" placeholder="Caută (ex. robot size, TeleOp, inspection)…" style="margin-bottom:16px">
    <div id="ftc-search-results"></div>`;

  api.get("/api/ftc-docs/manual-version").then((meta) => {
    const label = document.getElementById("ftc-manual-version");
    if (!meta || !label) return;
    const date = meta.fetched_at ? new Date(meta.fetched_at).toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest" }) : "";
    label.textContent = `Competition Manual: ${meta.season || ""} — ${meta.version || ""}${date ? `, actualizat ${date}` : ""}.`;
  }).catch(() => {});

  let searchTimer = null;
  const input = document.getElementById("ftc-search");
  input.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => doFtcSearch(q), 250);
  });

  async function doFtcSearch(q) {
    const resultsEl = document.getElementById("ftc-search-results");
    if (!q) { resultsEl.innerHTML = ""; return; }
    resultsEl.innerHTML = loadingHtml("Se caută…");
    try {
      const results = await api.get(`/api/ftc-docs/search?q=${encodeURIComponent(q)}`);
      resultsEl.innerHTML = results.length
        ? `<div class="card"><div class="list">${results.map((r) => `
            <div class="list-item">
              <div class="list-item-main"><strong>${esc(r.code)} — ${esc(r.title)}</strong><span class="muted small">${esc(r.source)}</span></div>
              <p>${esc(r.text)}</p>
            </div>`).join("")}</div></div>`
        : emptyHtml("Niciun rezultat.");
    } catch (e) { resultsEl.innerHTML = errorHtml(e); }
  }
}
