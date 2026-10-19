import { api } from "./api.js";
import { esc, toast, fmtDateTime, linkifyUrls } from "./ui.js";
import * as router from "./router.js";
import { SECTIONS, visibleSections, visibleTabs, activeTab, bottomKeys, sectionForPath } from "./sections.js";

import { mountAcasa } from "./pages/acasa.js";
import { mountAnunturi } from "./pages/anunturi.js";
import { mountPrezenta, mountPrezentaSesiune } from "./pages/prezenta.js";
import { mountMembri, mountMembruProfil } from "./pages/membri.js";
import { mountCereri, loadCereriBadge } from "./pages/membri-cereri.js";
import { mountDocumente } from "./pages/documente.js";
import { mountRegulament } from "./pages/regulament.js";
import { mountTaskuri } from "./pages/taskuri.js";
import { mountCalendar } from "./pages/calendar.js";
import { mountChat } from "./pages/chat.js";
import { mountAdmin, mountCereriRol, mountTermene } from "./pages/admin.js";
import { mountSedinte } from "./pages/sedinte.js";
import { mountPoze } from "./pages/poze.js";
import { mountResurse } from "./pages/resurse.js";
import { mountGrupuri } from "./pages/grupuri.js";
import { mountTeme, mountTema } from "./pages/teme.js";
import { mountScan } from "./pages/scan.js";

export const ROLE_NAMES = {
  team_leader: "Team Leader",
  co_leader: "Co-Leader",
  head_tech: "Șef Departament Tehnic",
  head_nontech: "Șef Departament Non-Tehnic",
  member: "Membru",
  volunteer: "Voluntar",
  mentor: "Mentor",
  alumni: "Alumni",
};
let ME = null;
export function currentUser() { return ME; }
// Rights come from the server (GET /api/auth/me `permissions`, policy.UI_ACTIONS) - never from role lists here.
export function can(action) { return !!(ME && ME.permissions && ME.permissions[action]); }

const ICONS = {
  acasa: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  membri: '<circle cx="9" cy="8" r="3"/><path d="M2 20c0-4 3-6 7-6s7 2 7 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14c3 .3 5 2 5 6"/>',
  documente: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.38 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/>',
  admin: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  sedinte: '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  teme: '<path d="M4 19.5V5a2 2 0 0 1 2-2h12v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="m9 9 2 2 4-4"/>',
};
function svg(key) { return `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`; }

function buildSidebar(user) {
  const items = visibleSections(user);
  const nav = document.getElementById("sidebar-nav");
  nav.innerHTML = items.map((i) => `
    <a href="${i.path}" data-link data-nav="${i.key}">
      <span class="nav-icon">${svg(i.icon)}</span>
      <span>${esc(i.label)}</span>
    </a>`).join("");
  const userBox = document.getElementById("sidebar-user");
  userBox.innerHTML = `
    <a href="/cont" data-link class="sidebar-account" title="Contul meu">
      <div class="avatar" aria-hidden="true">${esc((user.name || "?").slice(0, 1).toUpperCase())}</div>
      <div class="sidebar-user-info">
        <div class="name">${esc(user.name)}</div>
        <div class="role">${esc(ROLE_NAMES[user.role] || user.role)}</div>
        <div class="role account-hint">Contul meu</div>
      </div>
    </a>
    <button class="logout-btn" id="logout-btn" aria-label="Deconectare" title="Deconectare">
      <span class="nav-icon">${svg("logout")}</span>
    </button>`;
  document.getElementById("logout-btn").addEventListener("click", doLogout);
}

function buildBottomNav(user) {
  const items = visibleSections(user);
  const keys = bottomKeys(user);
  const bottomItems = keys.map((k) => items.find((i) => i.key === k)).filter(Boolean);
  const rest = items.filter((i) => !keys.includes(i.key));
  const nav = document.getElementById("bottom-nav");
  nav.innerHTML = bottomItems.map((i) => `
      <a href="${i.path}" data-link data-nav="${i.key}" class="bn-item">
        <span class="nav-icon">${svg(i.icon)}</span><span>${esc(i.label)}</span>
      </a>`).join("") +
    `<button class="bn-item bn-more" id="more-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="more-sheet">
        <span class="nav-icon">${svg("more")}</span><span>Mai mult</span>
      </button>`;

  const sheet = document.getElementById("more-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Mai mult");
  sheet.innerHTML = `<div class="sheet-backdrop"></div>
    <div class="sheet-panel">
      <div class="sheet-handle" aria-hidden="true"></div>
      ${rest.map((i) => `<a href="${i.path}" data-link data-nav="${i.key}" class="sheet-item">
          <span class="nav-icon">${svg(i.icon)}</span><span>${esc(i.label)}</span></a>`).join("")}
      <a href="/cont" data-link class="sheet-item"><span class="nav-icon">${svg("account")}</span><span>Contul meu</span></a>
      <button class="sheet-item sheet-logout" id="sheet-logout-btn">
        <span class="nav-icon">${svg("logout")}</span><span>Deconectare</span>
      </button>
    </div>`;
  const moreBtn = document.getElementById("more-btn");
  const sheetItems = () => [...sheet.querySelectorAll(".sheet-item")];
  // „Mai mult”: a small modal sheet - Escape / backdrop close it, Tab stays inside, focus returns to the button.
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); closeSheet(); return; }
    if (e.key !== "Tab") return;
    const list = sheetItems(), first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function openSheet() {
    sheet.classList.remove("hidden");
    moreBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", onKey);
    sheetItems()[0]?.focus();
  }
  function closeSheet({ restoreFocus = true } = {}) {
    if (sheet.classList.contains("hidden")) return;
    sheet.classList.add("hidden");
    moreBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKey);
    if (restoreFocus) moreBtn.focus();
  }
  moreBtn.addEventListener("click", openSheet);
  sheet.querySelector(".sheet-backdrop").addEventListener("click", () => closeSheet());
  sheet.querySelectorAll("a[data-link]").forEach((a) => a.addEventListener("click", () => closeSheet({ restoreFocus: false })));
  document.getElementById("sheet-logout-btn").addEventListener("click", doLogout);
}

function highlightNav() {
  const key = sectionForPath(location.pathname);
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === key));
}

async function doLogout() {
  try { await api.post("/api/auth/logout"); } catch (e) {}
  location.href = "/login";
}

let notifTimer = null;
async function pollNotifications() {
  if (document.hidden) return;
  try {
    const data = await api.get("/api/notifications", { allow401: true });
    if (!data) return;
    const countEl = document.getElementById("notif-count");
    const btn = document.getElementById("notif-btn");
    const n = data.unread_count || 0;
    if (n > 0) {
      countEl.textContent = n > 99 ? "99+" : String(n);
      countEl.classList.remove("hidden");
    } else {
      countEl.classList.add("hidden");
    }
    // The count is part of the bell's accessible name (the badge itself is aria-hidden).
    btn.setAttribute("aria-label", n === 0 ? "Notificări" : n === 1 ? "Notificări, 1 necitită" : `Notificări, ${n > 99 ? "peste 99" : n} necitite`);
  } catch (e) { /* silent - non-critical */ }
}
function startNotifPolling() {
  pollNotifications();
  notifTimer = setInterval(pollNotifications, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollNotifications(); });
}

// Links stored by older versions point to pages that no longer exist in the SPA.
const LEGACY_NOTIF_LINKS = { "/attendance": "/#prezenta-mea", "/documents": "/documente", "/remindere": "/teme?tab=taskuri", "/chat-echipa": "/anunturi" };
function notifLink(link) {
  if (!link) return null;
  if (link === "/profile") return `/membri/${ME.id}`;
  return LEGACY_NOTIF_LINKS[link] || (link.startsWith("/") && !link.startsWith("//") ? link : null);
}

async function openNotifications() {
  const { openModal } = await import("./ui.js");
  let data;
  try { data = await api.get("/api/notifications"); } catch (e) { toast(e.message, "error"); return; }
  const list = (data.notifications || []);
  const html = list.length
    ? `<h3>Notificări</h3><div class="notif-list">${list.map((n) => `
        <div class="notif-item ${n.read ? "" : "unread"} ${notifLink(n.link) ? "has-link" : ""}" data-id="${n.id}" data-link="${esc(notifLink(n.link) || "")}">
          <button type="button" class="notif-title">${esc(n.title || "")}</button>
          ${n.body ? `<span class="notif-text">${linkifyUrls(n.body)}</span>` : ""}
          <span class="notif-time muted small">${esc(fmtDateTime(n.created_at))}</span>
        </div>`).join("")}</div>
       <button class="btn btn-ghost" id="mark-all-read">Marchează tot ca citit</button>`
    : `<h3>Notificări</h3><p class="muted">Nicio notificare.</p>`;
  const modal = openModal(html);
  modal.el.querySelector("#mark-all-read")?.addEventListener("click", async () => {
    await api.post("/api/notifications/read");
    pollNotifications();
    modal.close();
  });
  // Click: mark as read, then go where the notification points (if anywhere).
  modal.el.querySelectorAll(".notif-item").forEach((el) => {
    el.addEventListener("click", async (e) => {
      if (e.target.closest("a")) return; // a link inside the text opens on its own
      if (el.classList.contains("unread")) {
        try { await api.post(`/api/notifications/${el.dataset.id}/read`); } catch (e) { /* non-critical */ }
        el.classList.remove("unread");
        pollNotifications();
      }
      if (el.dataset.link) {
        modal.close();
        router.navigate(el.dataset.link);
      }
    });
  });
}

// Delegated helpers used by many pages: „Înapoi” on a 403 (ui.errorHtml) and the file name next to
// „Alege fișier” (ui.fileField).
function wireGlobalHelpers() {
  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-back]")) return;
    if (history.length > 1) history.back();
    else router.navigate("/");
  });
  document.addEventListener("change", (e) => {
    const input = e.target;
    if (input.type !== "file") return;
    const wrap = input.closest("[data-file-pick]");
    const label = wrap && wrap.querySelector(".file-pick-name");
    if (!label) return;
    const names = [...input.files].map((f) => f.name);
    label.textContent = names.length ? (names.length > 2 ? `${names.length} fișiere alese` : names.join(", ")) : "Niciun fișier ales";
  });
}

// Section tabs -> existing page modules, mounted into the section body (docs/design-meniu-v2.md §1).
const TAB_MOUNTS = {
  "sedinte/sedinte": (c, id) => mountSedinte(c, id),
  "sedinte/prezenta": (c) => mountPrezenta(c),
  "teme/teme": (c) => mountTeme(c),
  "teme/taskuri": (c) => mountTaskuri(c),
  "echipa/membri": (c) => mountMembri(c),
  "echipa/grupuri": (c) => mountGrupuri(c),
  "echipa/cereri": (c) => mountCereri(c),
  "documente/documente": (c) => mountDocumente(c),
  "documente/regulament": (c) => mountRegulament(c, location.hash),
  "documente/poze": (c) => mountPoze(c),
  "documente/resurse": (c) => mountResurse(c),
  "admin/admin": (c) => mountAdmin(c),
  "admin/cereri-rol": (c) => mountCereriRol(c),
  "admin/termene": (c) => mountTermene(c),
};

// /<section>?tab=<tab>: a tab bar (only if more than one tab is visible) + the tab's page.
function mountSection(container, key, detailId) {
  const section = SECTIONS.find((s) => s.key === key);
  const tabs = visibleTabs(section, ME);
  // A meeting link for someone without the Ședințe section (an invited member, an approved PV): the meeting page on
  // its own - the server decides what they may see (meetings.get), never the Prezență tab instead.
  if (detailId && !tabs.some((t) => t.key === "sedinte")) return mountSedinte(container, detailId, { standalone: true });
  // Old links (notifications, Acasă) pointed at /echipa?tab=membri#cereri.
  const requested = detailId ? "sedinte" : key === "echipa" && location.hash === "#cereri" ? "cereri" : new URLSearchParams(location.search).get("tab");
  const tab = activeTab(section, ME, requested);
  if (!tab) {
    container.innerHTML = `<div class="state state-empty"><p>Nu ai acces la această secțiune.</p><a href="/" data-link class="btn">Acasă</a></div>`;
    return;
  }
  container.innerHTML = `${tabs.length > 1 ? `<div class="container section-tabs-wrap"><nav class="tabs section-tabs">
      ${tabs.map((t) => `<a href="${section.path}?tab=${t.key}" data-link data-section-tab="${t.key}" class="tab-btn ${t.key === tab ? "active" : ""}"${t.key === tab ? ' aria-current="page"' : ""}>${esc(t.label)}${t.key === "cereri" ? ` <span id="cereri-badge" class="badge badge-warn hidden"></span>` : ""}</a>`).join("")}
    </nav></div>` : ""}<div class="section-body"></div>`;
  if (tabs.some((t) => t.key === "cereri")) loadCereriBadge();
  return TAB_MOUNTS[`${key}/${tab}`](container.querySelector(".section-body"), detailId);
}

function setupRoutes() {
  router.register("/", (p, c) => mountAcasa(c));
  router.register("/anunturi", (p, c) => mountAnunturi(c));
  router.register("/sedinte", (p, c) => mountSection(c, "sedinte"));
  router.register("/sedinte/:id", (p, c) => mountSection(c, "sedinte", p.id));
  router.register("/prezenta/sesiune/:id", (p, c) => mountPrezentaSesiune(c, p.id));
  router.register("/teme", (p, c) => mountSection(c, "teme"));
  router.register("/teme/:id", (p, c) => mountTema(c, p.id));
  router.register("/calendar", (p, c) => mountCalendar(c));
  router.register("/echipa", (p, c) => mountSection(c, "echipa"));
  router.register("/membri/:id", (p, c) => mountMembruProfil(c, p.id));
  router.register("/cont", (p, c) => mountMembruProfil(c, ME.id)); // „Contul meu”
  router.register("/documente", (p, c) => mountSection(c, "documente"));
  router.register("/chat", (p, c) => mountChat(c));
  router.register("/admin", (p, c) => mountSection(c, "admin"));
  router.register("/p/:token", (p, c) => mountScan(c, p.token));
  router.setNotFound((c) => {
    c.innerHTML = `<div class="container"><div class="state state-empty not-found">
      <p class="scan-icon" aria-hidden="true">🐊</p>
      <h1>Pagina nu există</h1>
      <p>Adresa <strong>${esc(location.pathname)}</strong> nu duce nicăieri în CrocoAI.</p>
      <a href="/" data-link class="btn">Acasă</a></div></div>`;
  });
}

async function boot() {
  let user;
  try {
    user = await api.get("/api/auth/me", { allow401: true });
  } catch (e) { user = null; }
  const loginUrl = location.pathname === "/" ? "/login" : `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  if (!user) { location.href = loginUrl; return; }
  if (user.must_change_password) { location.href = loginUrl; return; }
  ME = user;

  document.getElementById("boot-loading").remove();
  document.getElementById("app-shell").classList.remove("hidden");

  buildSidebar(user);
  buildBottomNav(user);
  document.getElementById("notif-btn").addEventListener("click", openNotifications);
  wireGlobalHelpers();
  startNotifPolling();

  setupRoutes();
  router.init(document.getElementById("view"));
  document.addEventListener("route:changed", highlightNav);
}

boot();
