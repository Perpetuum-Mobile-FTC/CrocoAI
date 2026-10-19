// Acasă = the personal page (docs/design-pachet-b.md B1), top to bottom: „De verificat” (leadership), greeting +
// 3 stats, Termene, Anunțuri, Temele mele, To-do, Ședințele mele, Prezența mea, Documente lipsă. Everything comes
// from ONE call (GET /api/home); a card the user may not see arrives as null and is simply not drawn.
import { api } from "../api.js";
import { esc, fmtDate, fmtDateTime, fmtPct, fmtTime, loadingHtml, errorHtml, linkifyArticles, toast } from "../ui.js";
import { currentUser, can } from "../app.js";
import { openAbsenceModal } from "./prezenta.js";
import { announcementHtml } from "./anunturi.js";

const ATT_LABELS = { prezent: "Prezent", absent: "Absent", motivat: "Motivat", scutit: "Scutit" };
const ATT_BADGE = { prezent: "badge-ok", absent: "badge-danger", motivat: "", scutit: "" };
const SESSION_TYPES = { sedinta: "Ședință", urgenta: "Urgență", competitie: "Competiție", antrenament: "Antrenament", eveniment: "Eveniment" };

export async function mountAcasa(container) {
  const user = currentUser();
  container.innerHTML = `<div class="container home"><div id="home-main">${loadingHtml()}</div>
    ${can("attendance.view_all") ? `<div id="acasa-echipa"></div>` : ""}<div id="install-slot"></div></div>`;
  const main = container.querySelector("#home-main");
  try {
    const h = await api.get("/api/home");
    main.innerHTML = renderHome(h, user);
    wireTaskToggles(main);
    main.querySelector("#cere-motivare-btn")?.addEventListener("click", () => openAbsenceModal(() => mountAcasa(container)));
    if (location.hash === "#prezenta-mea") main.querySelector("#prezenta-mea")?.scrollIntoView();
  } catch (e) {
    main.innerHTML = errorHtml(e);
    main.querySelector("[data-retry]")?.addEventListener("click", () => mountAcasa(container));
    return;
  }
  if (can("attendance.view_all")) loadTeam(container.querySelector("#acasa-echipa"), user);
  renderInstall(container.querySelector("#install-slot"));
}

// Discreet „Instalează aplicația” (docs/design-pwa-ui.md §C): the browser's install prompt where there is one
// (js/pwa.js keeps the beforeinstallprompt event), the Share-menu hint on iPhone/iPad (dismissible), nothing
// once installed. One listener at a time: re-mounting Acasă drops the previous one.
const IOS_HINT_KEY = "crocoai.iosInstallHintDismissed";
let offInstall = null;
function iosHintDismissed() {
  try { return localStorage.getItem(IOS_HINT_KEY) === "1"; } catch (e) { return false; }
}
function renderInstall(slot) {
  if (offInstall) { offInstall(); offInstall = null; }
  const pwa = window.crocoPwa;
  if (!slot || !pwa || pwa.isStandalone()) return;
  const paint = () => {
    if (!slot.isConnected) { if (offInstall) { offInstall(); offInstall = null; } return; }
    if (pwa.canPrompt()) {
      slot.innerHTML = `<div class="card install-card"><p class="muted">Pune CrocoAI pe ecranul principal, ca o aplicație.</p>
        <button class="btn btn-ghost btn-small" id="install-btn">Instalează aplicația</button></div>`;
      slot.querySelector("#install-btn").addEventListener("click", async () => {
        if (await pwa.prompt()) toast("CrocoAI a fost instalată", "success");
      });
    } else if (pwa.isIos() && !iosHintDismissed()) {
      slot.innerHTML = `<div class="card install-card"><p class="muted small">Pe iPhone / iPad: apasă <strong>Share</strong> (pătratul cu săgeată) → <strong>Adaugă pe ecranul principal</strong>, ca să ai CrocoAI ca aplicație.</p>
        <button class="btn-icon" id="install-hint-close" aria-label="Ascunde indicația" title="Ascunde">&times;</button></div>`;
      slot.querySelector("#install-hint-close").addEventListener("click", () => {
        try { localStorage.setItem(IOS_HINT_KEY, "1"); } catch (e) { /* private mode: hide for this visit only */ }
        slot.innerHTML = "";
      });
    } else {
      slot.innerHTML = "";
    }
  };
  paint();
  offInstall = pwa.onChange(paint);
}

function renderHome(h, user) {
  const tasks = h.todos || [];
  const assignments = h.assignments || [];
  const stats = h.attendance && h.attendance.stats;
  return [
    renderReview(h.review),
    `<div class="card home-hello">
      <h2>Bun venit, ${esc(user.name.split(" ")[0])}</h2>
      <div class="stats">
        ${h.attendance ? `<div class="stat"><span class="stat-value">${stats ? fmtPct(stats.pct) : "—"}</span><span class="stat-label">Prezență sezon</span></div>` : ""}
        <div class="stat"><span class="stat-value">${assignments.length}</span><span class="stat-label">Teme de făcut</span></div>
        <div class="stat"><span class="stat-value">${tasks.length}</span><span class="stat-label">Taskuri</span></div>
      </div>
      ${stats && stats.signals && stats.signals.length ? `<div class="signals">${stats.signals.map((s) => `<div class="signal-banner">${linkifyArticles(s.message)}</div>`).join("")}</div>` : ""}
    </div>`,
    renderDeadlines(h.deadlines),
    renderAnnouncements(h.announcements, h.can_publish),
    renderAssignments(assignments),
    renderTodos(h.todos),
    renderMyMeetings(h.meetings),
    renderMyAttendance(h.attendance, h.cards && h.cards.absence_request),
    renderDocuments(h.documents),
  ].join("");
}

// „De verificat”: counts + links, only what the server says this user decides.
function renderReview(items) {
  if (!items) return "";
  return `<div class="card home-review">
      <div class="card-header"><h2>De verificat</h2></div>
      ${items.length ? `<div class="review-row">${items.map((i) => `
        <a class="review-chip" href="${esc(i.link)}" data-link><span class="review-count">${esc(i.count)}</span><span>${esc(i.label)}</span></a>`).join("")}</div>`
        : `<p class="muted small">Nimic de verificat acum.</p>`}
    </div>`;
}

function renderDeadlines(list) {
  if (!list || !list.length) return "";
  return `<div class="card">
      <div class="card-header"><h2>Termene</h2></div>
      <div class="deadline-list">${list.map((d) => `
        <div class="deadline ${d.days_left === 0 ? "deadline-today" : ""}">
          <div class="deadline-main"><strong>${esc(d.title)}</strong>
            <span class="muted small">${d.date ? esc(fmtDate(d.date)) : esc(d.date_text || "")}</span></div>
          <span class="deadline-count ${d.date ? "" : "deadline-unknown"}">${d.days_left != null && d.days_left > 1 ? `Mai sunt <b>${esc(d.days_left)}</b> zile` : esc(d.countdown)}</span>
        </div>`).join("")}</div>
    </div>`;
}

function renderAnnouncements(list, canPublish) {
  if (!list) return "";
  return `<div class="card">
      <div class="card-header"><h2>Anunțuri</h2><a href="/anunturi" data-link class="small">${canPublish ? "Publică / vezi toate →" : "Vezi toate →"}</a></div>
      ${list.length ? list.map((a) => announcementHtml(a)).join("") : `<p class="muted">Niciun anunț.</p>`}
    </div>`;
}

function renderAssignments(list) {
  if (!list || !list.length) return "";
  return `<div class="card">
      <div class="card-header"><h2>Temele mele</h2><a href="/teme" data-link class="small">Toate →</a></div>
      <div class="list">${list.slice(0, 6).map((a) => `
        <a class="list-item" href="/teme/${a.id}" data-link>
          <div class="list-item-main"><strong>${esc(a.title)}</strong></div>
          <div class="list-item-meta">${a.status === "de_refacut" ? `<span class="badge badge-danger">De refăcut</span>` : ""}
            <span class="muted small">${a.due_at ? esc(fmtDateTime(a.due_at)) : "fără termen"}</span></div>
        </a>`).join("")}</div>
    </div>`;
}

function renderTodos(list) {
  if (!list) return "";
  return `<div class="card">
      <div class="card-header"><h2>To-do</h2><a href="/teme?tab=taskuri" data-link class="small">Toate →</a></div>
      ${list.length ? `<div class="list">${list.slice(0, 8).map((t) => `
        <label class="list-item todo-item">
          <span class="list-item-main"><input type="checkbox" data-task-id="${t.id}" aria-label="Marchează task finalizat">
            <span>${esc(t.title)}${t.remind_at && !t.reminded ? ` <span title="Reminder ${esc(fmtDateTime(t.remind_at))}">🔔</span>` : ""}</span></span>
          <span class="list-item-meta muted small">${t.due_date ? esc(fmtDate(t.due_date)) : ""}</span>
        </label>`).join("")}</div>` : `<p class="muted">Niciun task de făcut.</p>`}
    </div>`;
}

function renderMyMeetings(items) {
  if (!items || !items.length) return "";
  return `<div class="card"><div class="card-header"><h2>Ședințele mele viitoare</h2></div>
    <div class="list">${items.map((m) => `
      <div class="list-item meeting-mine">
        <div class="list-item-main"><div>
          <strong>${esc(m.title)}</strong>${m.type === "urgenta" ? ` <span class="badge badge-danger">Urgență</span>` : ""}
          <div class="muted small">${esc(fmtDate(m.date))}${m.time ? ", ora " + esc(fmtTime(m.time)) : ""}${m.duration_min ? ` · ${esc(m.duration_min)} min` : ""}
            · ${m.mode === "online" && m.meet_link ? `<a href="${esc(m.meet_link)}" target="_blank" rel="noopener">Link Meet</a>` : esc(m.location || "loc nespecificat")}
            · ${esc(m.audience ? m.audience.label || "Toată echipa" : "Toată echipa")}</div>
          ${m.agenda && m.agenda.length ? `<ol class="small meeting-mine-agenda">${m.agenda.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>` : ""}
        </div></div>
      </div>`).join("")}</div></div>`;
}

// „Prezența mea”: own attendance + absence requests (the percentage is already in the greeting stats).
function renderMyAttendance(att, canRequest) {
  if (!att) return "";
  const { stats, pending_absences: absences } = att;
  const recent = (stats && stats.recent) || [];
  return `<div class="card" id="prezenta-mea">
      <div class="card-header"><h2>Prezența mea</h2>${canRequest ? `<button class="btn btn-small" id="cere-motivare-btn">Cere motivare</button>` : ""}</div>
      ${stats ? `<div class="stats">
        <div class="stat"><span class="stat-value">${stats.present}</span><span class="stat-label">Prezent</span></div>
        <div class="stat"><span class="stat-value">${stats.absent}</span><span class="stat-label">Absent</span></div>
        <div class="stat"><span class="stat-value">${stats.motivat}</span><span class="stat-label">Motivat</span></div>
      </div>` : ""}
      ${recent.length ? `<h3>Ultimele sesiuni</h3><div class="list">${recent.map((r) => `
        <div class="list-item"><div class="list-item-main"><strong>${fmtDate(r.date)}</strong>
          <span class="muted small">${esc(r.title || SESSION_TYPES[r.type] || r.type)}</span></div>
          <div class="list-item-meta"><span class="badge ${ATT_BADGE[r.status] || ""}">${esc(ATT_LABELS[r.status] || r.status)}</span></div></div>`).join("")}</div>`
        : `<p class="muted">Nicio sesiune marcată încă în acest sezon.</p>`}
      ${(absences || []).length ? `<h3>Cereri de motivare în așteptare</h3>
      <ul class="plain-list">
        ${absences.map((a) => `<li>${fmtDate(a.date)}${a.tardiva ? ' <span class="badge badge-warn">Târzie</span>' : ""}${a.ulterioara ? ' <span class="badge badge-warn">Motivare ulterioară</span>' : ""} — ${esc(a.reason || "")}</li>`).join("")}
      </ul>` : ""}
    </div>`;
}

function renderDocuments(list) {
  if (!list || !list.length) return "";
  return `<div class="card card-warning">
      <div class="card-header"><h2>Documente lipsă</h2><a href="/documente" data-link class="btn btn-small">Completează</a></div>
      <div class="doc-chips">${list.map((d) => `<span class="doc-chip">${esc(d.title)} ${d.status === "respins" ? '<span class="badge badge-danger">Respins</span>' : ""}</span>`).join("")}</div>
    </div>`;
}

function wireTaskToggles(root) {
  root.querySelectorAll("[data-task-id]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      cb.disabled = true;
      try {
        await api.patch(`/api/tasks/${cb.dataset.taskId}`, { status: cb.checked ? "done" : "pending" });
        cb.closest(".list-item").classList.toggle("done", cb.checked);
        toast(cb.checked ? "Task bifat" : "Task redeschis", "success");
      } catch (e) {
        cb.checked = !cb.checked;
        toast(e.message, "error");
      } finally { cb.disabled = false; }
    });
  });
}

// Team overview (oversight): members with attendance signals + overdue onboarding. Pending decisions are in
// „De verificat” above (no duplicates).
async function loadTeam(teamEl, user) {
  if (!teamEl) return;
  const isManager = can("onboarding.manage");
  const isLeader = can("members.manage");
  const [statsAll, onboardingOverdue, missingData] = await Promise.allSettled([
    api.get("/api/attendance/stats"),
    isManager ? api.get("/api/onboarding/signals/overdue") : Promise.resolve([]),
    isLeader ? api.get("/api/members/missing-data") : Promise.resolve([]),
  ]);
  const all = statsAll.status === "fulfilled" ? statsAll.value : [];
  const overdue = onboardingOverdue.status === "fulfilled" ? onboardingOverdue.value : [];
  const missing = missingData.status === "fulfilled" ? missingData.value : [];
  const withSignals = all.filter((s) => s.signals && s.signals.length);
  teamEl.innerHTML = `
    <div class="card">
      <h2>Echipa</h2>
      <div class="stats">
        <div class="stat"><span class="stat-value">${all.length}</span><span class="stat-label">Membri activi</span></div>
        <div class="stat"><span class="stat-value">${withSignals.length}</span><span class="stat-label">Cu semnale</span></div>
        <div class="stat"><span class="stat-value">${overdue.length}</span><span class="stat-label">Integrare depășită</span></div>
      </div>
      ${withSignals.length ? `<div class="list">${withSignals.map((s) => `
        <div class="list-item">
          <div class="list-item-main"><a href="/membri/${s.member_id}" data-link><strong>${esc(s.member_name)}</strong></a></div>
          <div class="list-item-meta">${s.signals.map((sig) => `<span class="badge badge-warn" title="${esc(sig.article || "")}">${esc(sig.message.split(" — ")[0] || sig.message)}</span>`).join(" ")}</div>
        </div>`).join("")}</div>` : ""}
      ${isLeader && missing.length ? `<p class="small"><a href="/echipa?tab=cereri" data-link>${esc(missing.length)} ${missing.length === 1 ? "membru are" : "membri au"} date de profil incomplete →</a></p>` : ""}
      ${overdue.length ? `<h3>Integrare depășită (Art. 43.3)</h3><ul class="plain-list">
        ${overdue.map((o) => `<li><a href="/membri/${o.member_id}" data-link>${esc(o.member_name)}</a> — peste 30 de zile, checklist incomplet</li>`).join("")}
      </ul>` : ""}
    </div>`;
}
