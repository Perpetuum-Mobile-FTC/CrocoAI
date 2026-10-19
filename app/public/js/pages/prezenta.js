import { api } from "../api.js";
import { esc, fmtDate, fmtTime, fmtPct, loadingHtml, errorHtml, emptyHtml, toast, openModal, confirmDialog, todayLocal, busyOnClick, competitionLevelBadge, competitionLevelField, wireCompetitionLevel } from "../ui.js";
import { currentUser, can } from "../app.js";

const TYPE_LABELS = { sedinta: "Ședință", urgenta: "Urgență", competitie: "Competiție", antrenament: "Antrenament", eveniment: "Eveniment" };
const STATUS_LABELS = { prezent: "Prezent", absent: "Absent", motivat: "Motivat", scutit: "Scutit" };

export async function mountPrezenta(container) {
  const user = currentUser();
  const isManager = can("attendance.mark");
  const isOversight = can("attendance.view_all");

  container.innerHTML = `
    <div class="container">
      <div class="page-header">
        <h1>Prezență</h1>
        ${isManager ? `<button class="btn" id="new-session-btn">+ Sesiune nouă</button>` : ""}
      </div>
      <div class="tabs" id="prez-tabs">
        <button class="tab-btn active" data-tab="sesiuni">Sesiuni</button>
        <button class="tab-btn" data-tab="cereri">Cereri de motivare</button>
        ${isOversight ? `<button class="tab-btn" data-tab="stats">Statistici</button>` : ""}
      </div>
      <div id="tab-sesiuni" class="tab-pane">${loadingHtml()}</div>
      <div id="tab-cereri" class="tab-pane hidden"></div>
      ${isOversight ? `<div id="tab-stats" class="tab-pane hidden"></div>` : ""}
    </div>`;

  container.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      container.querySelectorAll(".tab-pane").forEach((p) => p.classList.add("hidden"));
      const pane = document.getElementById(`tab-${btn.dataset.tab}`);
      pane.classList.remove("hidden");
      if (!pane.dataset.loaded) {
        pane.dataset.loaded = "1";
        if (btn.dataset.tab === "cereri") loadCereri(pane, user, isManager);
        if (btn.dataset.tab === "stats") loadStats(pane);
      }
    });
  });

  await loadSessions(document.getElementById("tab-sesiuni"), isManager);

  if (isManager) {
    document.getElementById("new-session-btn").addEventListener("click", () => openNewSessionModal(() => loadSessions(document.getElementById("tab-sesiuni"), isManager)));
  }
}

async function loadSessions(pane, isManager) {
  pane.innerHTML = loadingHtml();
  try {
    const sessions = await api.get("/api/attendance/sessions");
    if (!sessions.length) { pane.innerHTML = emptyHtml("Nicio sesiune încă."); return; }
    sessions.sort((a, b) => (b.date + (b.start_time || "")).localeCompare(a.date + (a.start_time || "")));
    pane.innerHTML = `
      <div class="filters" id="session-filters">
        <button class="filter-btn active" data-type="">Toate</button>
        ${Object.entries(TYPE_LABELS).map(([k, v]) => `<button class="filter-btn" data-type="${k}">${v}</button>`).join("")}
      </div>
      <div class="card"><div class="list" id="session-list">
        ${sessions.map((s) => sessionRow(s, isManager)).join("")}
      </div></div>`;
    pane.querySelectorAll("[data-type]").forEach((btn) => {
      btn.addEventListener("click", () => {
        pane.querySelectorAll("[data-type]").forEach((b) => b.classList.toggle("active", b === btn));
        const t = btn.dataset.type;
        pane.querySelectorAll("#session-list .list-item").forEach((row) => {
          row.style.display = !t || row.dataset.type === t ? "" : "none";
        });
      });
    });
  } catch (e) {
    pane.innerHTML = errorHtml(e);
  }
}

function sessionRow(s, isManager) {
  const link = isManager ? `/prezenta/sesiune/${s.id}` : null;
  return `
    <div class="list-item" data-type="${s.type}">
      <div class="list-item-main">
        <div class="event-date-badge"><span class="event-day">${new Date(s.date).getDate()}</span><span class="event-month">${new Date(s.date).toLocaleDateString("ro-RO", { month: "short" })}</span></div>
        <div>
          <strong>${esc(s.title || TYPE_LABELS[s.type] || s.type)}</strong>
          <div class="muted small">${esc(TYPE_LABELS[s.type] || s.type)}${s.start_time ? " · " + fmtTime(s.start_time) : ""}</div>
          ${s.type === "competitie" && s.competition_level ? `<div class="small">${competitionLevelBadge(s.competition_level)}</div>` : ""}
        </div>
      </div>
      <div class="list-item-meta">
        ${link ? `<a href="${link}" data-link class="btn btn-small">Marchează</a>` : `<span class="badge">${esc(TYPE_LABELS[s.type] || s.type)}</span>`}
      </div>
    </div>`;
}

function openNewSessionModal(onSaved) {
  const types = Object.entries(TYPE_LABELS).filter(([k]) => k !== "urgenta" || can("events.manage_urgenta"));
  const modal = openModal(`
    <h3>Sesiune nouă</h3>
    <div class="form">
      <label class="field-label">Tip<select class="input" id="ns-type">${types.map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
      ${competitionLevelField("ns-level")}
      <label class="field-label">Dată<input class="input" type="date" id="ns-date" value="${todayLocal()}"></label>
      <label class="field-label">Oră<input class="input" type="time" id="ns-time"></label>
      <label class="field-label">Titlu (opțional)<input class="input" id="ns-title" placeholder="ex: Ședință generală"></label>
      <button class="btn" id="ns-save">Creează sesiune</button>
      <div class="form-error" id="ns-error"></div>
    </div>`);
  wireCompetitionLevel(modal.el, "#ns-type", "ns-level");
  const saveBtn = modal.el.querySelector("#ns-save");
  busyOnClick(saveBtn, async () => {
    const errEl = modal.el.querySelector("#ns-error");
    errEl.textContent = "";
    const body = {
      type: modal.el.querySelector("#ns-type").value,
      date: modal.el.querySelector("#ns-date").value,
      start_time: modal.el.querySelector("#ns-time").value || undefined,
      title: modal.el.querySelector("#ns-title").value || undefined,
    };
    if (body.type === "competitie") body.competition_level = modal.el.querySelector("#ns-level").value;
    if (!body.date) { errEl.textContent = "Alege o dată."; return; }
    try {
      await api.post("/api/attendance/sessions", body);
      toast("Sesiune creată", "success");
      modal.close();
      onSaved();
    } catch (e) { errEl.textContent = e.message; }
  });
}

// ─── Mobile marking page ───
export async function mountPrezentaSesiune(container, sessionId) {
  container.innerHTML = `<div class="container marking-page">${loadingHtml("Se încarcă sesiunea…")}</div>`;
  const wrap = container.querySelector(".container");
  try {
    const detail = await api.get(`/api/attendance/sessions/${sessionId}`);
    const session = detail.session;
    // Roster is already team-filtered server-side (session.team_id) and carries each member's
    // status (so "scutit" can be offered for members on pause) and their existing record.
    const roster = detail.roster
      .filter((m) => m.status === "activ" || m.status === "pauza")
      .sort((a, b) => a.name.localeCompare(b.name, "ro"));

    const marks = {};
    roster.forEach((m) => { marks[m.id] = m.record || (m.status === "pauza" ? "scutit" : null); });

    wrap.innerHTML = `
      <div class="page-header">
        <h1>${esc(session.title || TYPE_LABELS[session.type])}</h1>
        <span class="muted">${fmtDate(session.date)}${session.start_time ? " · " + fmtTime(session.start_time) : ""}</span>
      </div>
      <input class="input" id="mark-search" aria-label="Caută membru" placeholder="Caută membru…" style="margin-bottom:12px">
      <div class="marking-toolbar">
        <span id="mark-counter" class="muted">0/${roster.length} marcați</span>
        <button class="btn btn-ghost btn-small" id="rest-absent-btn">Restul = Absent</button>
      </div>
      <div class="marking-list" id="marking-list">
        ${roster.map((m) => markRow(m, marks[m.id])).join("")}
      </div>
      <div class="sticky-save-bar">
        <button class="btn btn-full" id="save-marks-btn">Salvează prezența</button>
      </div>`;

    updateCounter(wrap, roster.length);

    wrap.querySelectorAll(".mark-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        cycleMark(row, row.dataset.paused === "1");
        updateCounter(wrap, roster.length);
      });
    });

    wrap.querySelector("#mark-search").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      wrap.querySelectorAll(".mark-row").forEach((row) => {
        row.style.display = row.dataset.name.includes(q) ? "" : "none";
      });
    });

    wrap.querySelector("#rest-absent-btn").addEventListener("click", () => {
      wrap.querySelectorAll(".mark-row").forEach((row) => {
        if (row.dataset.status === "null" || !row.dataset.status) setMark(row, "absent");
      });
      updateCounter(wrap, roster.length);
    });

    const saveBtn = wrap.querySelector("#save-marks-btn");
    busyOnClick(saveBtn, async () => {
      const records = [...wrap.querySelectorAll(".mark-row")]
        .filter((row) => row.dataset.status && row.dataset.status !== "null")
        .map((row) => ({ member_id: Number(row.dataset.id), status: row.dataset.status }));
      try {
        await api.put(`/api/attendance/sessions/${session.id}/records`, { records });
        toast(`Prezență salvată (${records.length} membri)`, "success");
      } catch (e) { toast(e.message, "error"); }
    });
  } catch (e) {
    wrap.innerHTML = errorHtml(e);
  }
}

function markRow(m, status) {
  return `<div class="mark-row" data-id="${m.id}" data-name="${esc(m.name.toLowerCase())}" data-status="${status || "null"}" data-paused="${m.status === "pauza" ? 1 : 0}">
    <div class="avatar">${esc(m.name.slice(0, 1).toUpperCase())}</div>
    <div class="mark-row-info"><strong>${esc(m.name)}</strong>${m.status === "pauza" ? '<span class="muted small"> · în pauză</span>' : ""}</div>
    <div class="mark-status-pill" data-pill>${status && status !== "null" ? STATUS_LABELS[status] : "—"}</div>
  </div>`;
}

function cycleMark(row, allowScutit) {
  const order = allowScutit ? [null, "prezent", "absent", "motivat", "scutit"] : [null, "prezent", "absent", "motivat"];
  const cur = row.dataset.status === "null" ? null : row.dataset.status;
  const idx = order.indexOf(cur);
  const next = order[(idx + 1) % order.length];
  setMark(row, next);
}
function setMark(row, status) {
  row.dataset.status = status || "null";
  const pill = row.querySelector("[data-pill]");
  pill.textContent = status ? STATUS_LABELS[status] : "—";
  pill.className = "mark-status-pill" + (status ? ` mark-${status}` : "");
}
function updateCounter(wrap, total) {
  const marked = [...wrap.querySelectorAll(".mark-row")].filter((r) => r.dataset.status && r.dataset.status !== "null").length;
  wrap.querySelector("#mark-counter").textContent = `${marked}/${total} marcați`;
}

// ─── Cereri de motivare ───
async function loadCereri(pane, user, isManager) {
  pane.innerHTML = loadingHtml();
  try {
    const url = isManager ? "/api/absences" : `/api/absences?member_id=${user.id}`;
    const list = await api.get(url);
    pane.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>${isManager ? "Toate cererile" : "Cererile mele"}</h2>
          <button class="btn btn-small" id="new-abs-btn">+ Cerere nouă</button></div>
        ${list.length ? `<div class="list">${list.sort((a, b) => b.id - a.id).map((a) => absRow(a, isManager)).join("")}</div>` : emptyHtml("Nicio cerere.")}
      </div>`;
    document.getElementById("new-abs-btn").addEventListener("click", () => openAbsenceModal(() => loadCereriRefresh(pane, user, isManager)));
    wireAbsDecisions(pane);
  } catch (e) { pane.innerHTML = errorHtml(e); }
}
function loadCereriRefresh(pane, user, isManager) { pane.dataset.loaded = ""; loadCereri(pane, user, isManager); }

function absRow(a, isManager) {
  const statusBadge = { pending: "badge-warn", aprobata: "", respinsa: "badge-danger" }[a.status] || "";
  return `<div class="list-item" data-abs-id="${a.id}">
    <div class="list-item-main">
      <strong>${isManager ? esc(a.member_name) : fmtDate(a.date)}</strong>
      <span class="muted small">${isManager ? fmtDate(a.date) : ""} ${a.tardiva ? "· cerere târzie" : ""} ${a.ulterioara ? `<span class="badge badge-warn">Motivare ulterioară</span>` : ""} — ${esc(a.reason || "")}</span>
    </div>
    <div class="list-item-meta">
      <span class="badge ${statusBadge}">${esc(a.status)}</span>
      ${isManager && a.status === "pending" ? `<button class="btn btn-small" data-decide="aprobata">Aprobă</button><button class="btn btn-small btn-ghost" data-decide="respinsa">Respinge</button>` : ""}
    </div>
  </div>`;
}
function wireAbsDecisions(pane) {
  pane.querySelectorAll("[data-decide]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("[data-abs-id]");
      btn.disabled = true;
      try {
        await api.post(`/api/absences/${row.dataset.absId}/decide`, { status: btn.dataset.decide });
        toast("Cerere actualizată", "success");
        row.querySelector(".badge").textContent = btn.dataset.decide;
        row.querySelectorAll("[data-decide]").forEach((b) => b.remove());
      } catch (e) { toast(e.message, "error"); } finally { btn.disabled = false; }
    });
  });
}

// Also used by the Acasă „Prezența mea” card (docs/design-meniu-v2.md).
export function openAbsenceModal(onSaved) {
  const modal = openModal(`
    <h3>Cerere motivare absență</h3>
    <div class="form">
      <label class="field-label">Dată<input class="input" type="date" id="abs-date" value="${todayLocal()}"></label>
      <label class="field-label">Motiv (obligatoriu)<textarea class="input" id="abs-reason" rows="3" required placeholder="De ce lipsești?"></textarea></label>
      <button class="btn" id="abs-save">Trimite cererea</button>
      <div class="form-error" id="abs-error"></div>
    </div>`);
  const btn = modal.el.querySelector("#abs-save");
  busyOnClick(btn, async () => {
    const errEl = modal.el.querySelector("#abs-error");
    errEl.textContent = "";
    const date = modal.el.querySelector("#abs-date").value;
    const reason = modal.el.querySelector("#abs-reason").value;
    if (!date) { errEl.textContent = "Alege o dată."; return; }
    try {
      const res = await api.post("/api/absences", { date, reason });
      if (res && res.ulterioara) toast("Cererea a fost trimisă după ședință (Art. 21.1) și așteaptă aprobarea.", "success");
      else toast(res.tardiva ? "Cerere trimisă (târzie - decizia rămâne la conducere)" : "Cerere trimisă", "success");
      modal.close();
      onSaved();
    } catch (e) { errEl.textContent = e.message + (e.article ? ` (${e.article})` : ""); }
  });
}

// ─── Statistici (OVERSIGHT) ───
async function loadStats(pane) {
  pane.innerHTML = loadingHtml();
  try {
    const stats = await api.get("/api/attendance/stats");
    pane.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>Statistici echipă</h2>
          <div class="export-actions">
            <a class="btn btn-small btn-ghost" href="/api/attendance/export/csv" target="_blank">Export CSV</a>
            <a class="btn btn-small btn-ghost" href="/api/attendance/export/html" target="_blank">Export / print</a>
          </div>
        </div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>Membru</th><th>Prezent</th><th>Absent</th><th>Motivat</th><th>%</th><th>Semnale</th></tr></thead>
          <tbody>
            ${stats.map((s) => `<tr>
              <td><a href="/membri/${s.member_id}" data-link>${esc(s.member_name)}</a></td>
              <td>${s.present}</td><td>${s.absent}</td><td>${s.motivat}</td>
              <td>${fmtPct(s.pct)}</td>
              <td>${(s.signals || []).map((sig) => `<span class="badge badge-warn" title="${esc(sig.article || "")}">!</span>`).join("")}</td>
            </tr>`).join("")}
          </tbody>
        </table></div>
      </div>`;
  } catch (e) { pane.innerHTML = errorHtml(e); }
}
