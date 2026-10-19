// Ședințe all-in-one (design-sedinte-v2.md + v3): lista (viitoare / trecute), „+ Ședință nouă” (cu destinatari),
// iar pagina unei ședințe = Detalii → Ordinea de zi → Prezență (cod QR) → Înregistrare → Ciornă PV → Aprobare/Export.
// Master-detail într-o singură pagină (fără sub-rută), ca day-detail din calendar.js.
import { api } from "../api.js";
import { esc, fmtDate, fmtTime, loadingHtml, errorHtml, emptyHtml, toast, confirmDialog, busyOnClick, openModal, todayLocal, fileField } from "../ui.js";
import { currentUser, can } from "../app.js";
import { navigate } from "../router.js";
import { renderRecordingBox } from "./sedinte-recorder.js";
import { DEPT_LABELS } from "./membri-labels.js";

const STATUS_LABELS = { approved: "Aprobat", draft: "Ciornă", none: "Fără PV" };
// Before the start there is no PV yet: the server's `phase` (Bucharest time) decides; PV badges only afterwards.
function meetingBadge(phase, status) {
  if (status !== "approved" && phase === "programata") return `<span class="badge">Programată</span>`;
  if (status !== "approved" && phase === "in_desfasurare") return `<span class="badge badge-ok">În desfășurare</span>`;
  const s = status || "none";
  return `<span class="badge ${s === "approved" ? "badge-ok" : s === "draft" ? "badge-warn" : ""}">${esc(STATUS_LABELS[s] || s)}</span>`;
}
const MARKS = [["prezent", "P", "Prezent"], ["absent", "A", "Absent"], ["motivat", "M", "Motivat"]];

// `detailId` (route /sedinte/:id): only that meeting's page, with a back link - own URL, back button and deep links work.
export async function mountSedinte(container, detailId, { standalone = false } = {}) {
  const user = currentUser();
  const canManage = can("meetings.manage"); // only to open a PV for a session without one; the meeting page uses server flags
  let targets = { team: false, departments: [], groups: [] };
  try { targets = await api.get("/api/meetings/targets"); } catch (e) { /* no scheduling button */ }
  const canSchedule = targets.team || targets.departments.length > 0 || targets.groups.length > 0;

  if (detailId) return mountMeetingPage(container, detailId, { user, canManage, targets, standalone });

  container.innerHTML = `
    <div class="container">
      <div class="page-header"><h1>Ședințe</h1>
        ${canSchedule ? `<button class="btn" id="new-meeting-btn">+ Ședință nouă</button>` : ""}</div>
      <div class="card"><div id="meeting-list">${loadingHtml()}</div></div>
    </div>`;

  const listEl = document.getElementById("meeting-list");
  const ctx = { user, canManage, targets, reloadList: loadList };

  async function loadList() {
    listEl.innerHTML = loadingHtml();
    try {
      const rows = await api.get("/api/meetings");
      renderList(listEl, rows, { onOpen: (row) => openMeeting(row, ctx) });
    } catch (e) { listEl.innerHTML = errorHtml(e); }
  }
  const newBtn = document.getElementById("new-meeting-btn");
  if (newBtn) newBtn.addEventListener("click", () => openScheduleModal(null, (meeting) => navigate(`/sedinte/${meeting.id}`), targets));
  await loadList();
  return () => document.querySelectorAll(".qr-overlay").forEach((o) => o.dispatchEvent(new Event("qr:close")));
}

function listRow(r) {
  return `<div class="list-item meeting-row" role="button" tabindex="0" data-session-id="${r.session_id}" data-meeting-id="${r.meeting_id || ""}">
    <div class="list-item-main">
      <strong>${esc(r.title || "Ședință")}</strong>
      <span class="muted small">${fmtDate(r.date)}${r.start_time ? " · " + fmtTime(r.start_time) : ""}${r.location ? " · " + esc(r.location) : r.meet_link ? " · online" : ""} · ${esc(r.audience_label || "Toată echipa")}</span>
    </div>
    <div class="list-item-meta">${meetingBadge(r.phase, r.meeting_status)}</div>
  </div>`;
}

function renderList(listEl, rows, { onOpen }) {
  if (!rows.length) { listEl.innerHTML = emptyHtml("Nicio ședință încă."); return; }
  const live = rows.filter((r) => r.phase === "in_desfasurare" && r.meeting_status !== "approved");
  const upcoming = rows.filter((r) => r.phase === "programata" && r.meeting_status !== "approved").reverse(); // API: DESC -> cele mai apropiate primele
  const past = rows.filter((r) => !upcoming.includes(r) && !live.includes(r));
  listEl.innerHTML =
    (live.length ? `<h3>În desfășurare</h3><div class="list">${live.map(listRow).join("")}</div>` : "") +
    (upcoming.length ? `<h3>Viitoare</h3><div class="list">${upcoming.map(listRow).join("")}</div>` : "") +
    (past.length ? `<h3>Trecute</h3><div class="list">${past.map(listRow).join("")}</div>` : "");
  listEl.querySelectorAll("[data-session-id]").forEach((row) => {
    const open = () => onOpen({ sessionId: row.dataset.sessionId, meetingId: row.dataset.meetingId || null });
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

// A list row -> its own page. A session without a meeting yet gets one first (managers only).
async function openMeeting({ sessionId, meetingId }, ctx) {
  if (meetingId) { navigate(`/sedinte/${meetingId}`); return; }
  if (!ctx.canManage) { toast("Nu există încă un proces verbal pentru această ședință.", "info"); return; }
  try {
    const meeting = await api.post(`/api/meetings/session/${sessionId}`);
    navigate(`/sedinte/${meeting.id}`);
  } catch (e) { toast(e.message, "error"); }
}

async function mountMeetingPage(container, meetingId, base) {
  const back = base.standalone ? ["/", "← Acasă"] : ["/sedinte", "← Ședințe"];
  container.innerHTML = `<div class="container">
    <p><a href="${back[0]}" data-link class="btn btn-ghost btn-small">${back[1]}</a></p>
    <div id="meeting-detail">${loadingHtml()}</div></div>`;
  const detailEl = document.getElementById("meeting-detail");
  const ctx = { ...base, reloadList: () => {}, afterCancel: () => navigate("/sedinte") };
  try {
    renderDetail(detailEl, await api.get(`/api/meetings/${meetingId}`), ctx);
    const h = detailEl.querySelector("h2");
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  } catch (e) {
    detailEl.innerHTML = base.standalone && (e.status === 403 || e.status === 404)
      ? `<div class="card state state-error" role="alert"><p>${esc(e.status === 404 ? "Ședința nu există." : "Nu ai acces la această ședință.")}</p>
          <a href="/" data-link class="btn">Acasă</a></div>`
      : `<div class="card">${errorHtml(e)}</div>`;
  }
  return () => document.querySelectorAll(".qr-overlay").forEach((o) => o.dispatchEvent(new Event("qr:close")));
}

async function reloadDetail(detailEl, meetingId, ctx) {
  try { renderDetail(detailEl, await api.get(`/api/meetings/${meetingId}`), ctx); }
  catch (e) { detailEl.innerHTML = `<div class="card">${errorHtml(e)}</div>`; }
}

// "Pentru" options from GET /api/meetings/targets (the audience rule lives in policy.js).
function audienceOptions(targets) {
  const DEPT = Object.fromEntries(Object.entries(DEPT_LABELS).map(([k, v]) => [k, `Departament ${v}`]));
  return [
    ...(targets.team ? [["echipa", "Toată echipa"]] : []),
    ...targets.departments.map((d) => [`departament:${d}`, DEPT[d] || d]),
    ...targets.groups.map((g) => [`grup:${g.id}`, `Grupul ${g.name}`]),
  ].map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join("");
}

// Form shared by "+ Ședință nouă" (meeting = null) and "Modifică" (the audience can't change).
function openScheduleModal(meeting, onSaved, targets) {
  const s = meeting ? meeting.session : null;
  const online = meeting ? meeting.mode === "online" : false;
  const modal = openModal(`
    <h3>${meeting ? "Modifică ședința" : "Ședință nouă"}</h3>
    <div class="form">
      <label class="field-label">Titlu<input class="input" id="sch-title" value="${esc(s ? s.title || "" : "")}" placeholder="Ședința săptămânală"></label>
      ${meeting ? `<p class="muted small">Pentru: ${esc(meeting.audience ? meeting.audience.label : "Toată echipa")}</p>` : `<label class="field-label">Pentru<select class="input" id="sch-audience">${audienceOptions(targets)}</select></label>`}
      ${meeting ? "" : `<label class="field-label">Tip<select class="input" id="sch-type"><option value="sedinta">Ședință</option>${can("events.manage_urgenta") ? `<option value="urgenta">Ședință de urgență</option>` : ""}</select></label>`}
      <label class="field-label">Dată<input class="input" type="date" id="sch-date" value="${esc(s ? s.date : todayLocal())}"></label>
      <label class="field-label">Oră<input class="input" type="time" id="sch-time" value="${esc(s && s.start_time ? s.start_time.slice(0, 5) : "18:00")}"></label>
      <label class="field-label">Durată (minute)<input class="input" type="number" id="sch-duration" min="15" max="600" value="${meeting && meeting.duration_min ? meeting.duration_min : 120}"></label>
      <label class="field-label">Loc<select class="input" id="sch-mode"><option value="fizic" ${online ? "" : "selected"}>Fizic</option><option value="online" ${online ? "selected" : ""}>Online (Meet)</option></select></label>
      <label class="field-label" id="sch-loc-wrap">Sala<input class="input" id="sch-location" value="${esc(meeting && meeting.location ? meeting.location : "Sala S03")}"></label>
      <label class="field-label" id="sch-link-wrap">Link Meet (gol = se creează automat, dacă e configurat)<input class="input" id="sch-link" value="${esc(meeting && meeting.meet_link ? meeting.meet_link : "")}" placeholder="https://meet.google.com/…"></label>
      <label class="field-label">Ordinea de zi (un punct pe linie)<textarea class="input" id="sch-agenda" rows="4">${esc(meeting ? (meeting.agenda || []).join("\n") : "")}</textarea></label>
      <button class="btn" id="sch-save">${meeting ? "Salvează" : "Programează și anunță"}</button>
      <div class="form-error" id="sch-error"></div>
    </div>`);
  const el = modal.el;
  const q = (id) => el.querySelector(id);
  const syncMode = () => {
    const isOnline = q("#sch-mode").value === "online";
    q("#sch-loc-wrap").style.display = isOnline ? "none" : "";
    q("#sch-link-wrap").style.display = isOnline ? "" : "none";
  };
  q("#sch-mode").addEventListener("change", syncMode);
  syncMode();
  busyOnClick(q("#sch-save"), async () => {
    q("#sch-error").textContent = "";
    const body = {
      title: q("#sch-title").value.trim(), date: q("#sch-date").value, time: q("#sch-time").value,
      duration: Number(q("#sch-duration").value), mode: q("#sch-mode").value,
      location: q("#sch-location").value.trim(), meet_link: q("#sch-link").value.trim() || undefined,
      agenda: q("#sch-agenda").value.split("\n").map((l) => l.trim()).filter(Boolean),
    };
    if (!meeting) {
      body.type = q("#sch-type").value;
      const [kind, val] = q("#sch-audience").value.split(":");
      body.target_type = kind;
      if (kind === "departament") body.target_dept = val;
      if (kind === "grup") body.target_team_id = Number(val);
    }
    try {
      const saved = meeting ? await api.put(`/api/meetings/${meeting.id}/reschedule`, body) : await api.post("/api/meetings/schedule", body);
      modal.close();
      toast(meeting ? "Ședință modificată" : "Ședință programată și anunțată", "success");
      await onSaved(saved);
    } catch (e) { q("#sch-error").textContent = e.message + (e.article ? ` (${e.article})` : ""); }
  });
}

function renderDetail(detailEl, meeting, ctx) {
  const canManage = !!meeting.can_manage; // recording, audio, PV draft (MANAGERS)
  const canApprove = !!meeting.can_approve; // LEADERS + head of the meeting's department
  const canOrganize = !!meeting.can_organize; // modify / cancel / agenda / attendance (audience rule + creator)
  const approved = meeting.status === "approved";
  const upcomingOnly = !!meeting.upcoming; // simple member: details of a future meeting, no PV data
  const d = meeting.draft;
  const placeHtml = meeting.mode === "online" && meeting.meet_link
    ? `<a href="${esc(meeting.meet_link)}" target="_blank" rel="noopener">Link Meet</a>`
    : meeting.location ? esc(meeting.location) : `<span class="muted">loc nespecificat</span>`;

  detailEl.innerHTML = `
    <div class="card meeting-detail">
      <div class="page-header">
        <h2>${esc(meeting.session.title || "Ședință")} — ${esc(fmtDate(meeting.session.date))}</h2>
        ${meetingBadge(meeting.phase, meeting.status)}
      </div>

      <div class="meeting-section" id="details-box">
        <p><strong>${esc(fmtDate(meeting.session.date))}${meeting.session.start_time ? ", ora " + esc(fmtTime(meeting.session.start_time)) : ""}</strong>
          ${meeting.duration_min ? `<span class="muted small"> · ${esc(meeting.duration_min)} min</span>` : ""} · ${placeHtml}
          <span class="muted small"> · Pentru: ${esc(meeting.audience ? meeting.audience.label : "Toată echipa")}</span></p>
        ${canOrganize && !approved ? `<div class="form-actions">
          <button class="btn btn-small" id="edit-meeting-btn">Modifică</button>
          <button class="btn btn-small btn-ghost" id="cancel-meeting-btn">Anulează ședința</button></div>` : ""}
        <div id="meet-box"></div>
      </div>

      <h3>Ordinea de zi</h3>
      <div id="agenda-box"></div>

      ${upcomingOnly ? "" : `<h3>Prezență</h3><div id="attendance-box"></div>`}
      ${canManage ? `<h3>Înregistrare</h3><div id="audio-box"></div>` : ""}

      ${upcomingOnly ? "" : `<h3>Ciornă proces verbal</h3><div id="draft-box"></div>
      <div class="form-actions" style="margin-top:1rem">
        ${!approved && canManage ? `<button class="btn" id="gen-draft-btn">${d ? "Regenerează ciorna (AI)" : "Generează ciorna (AI)"}</button>` : ""}
        ${!approved && canApprove && d ? `<button class="btn btn-primary" id="approve-btn">Aprobă PV</button>` : ""}
        ${approved ? `<a class="btn btn-ghost" href="/api/meetings/${meeting.id}/export" target="_blank" rel="noopener">Exportă / printează</a>` : ""}
      </div>
      <p class="muted small">Retenție minimă (Art. 49.2): până la ${esc(fmtDate(meeting.retention.until))}.</p>`}
    </div>`;

  // Legacy meetings (created before scheduling existed) may have neither place nor link: keep the old Meet box.
  if (canManage && !approved && !meeting.location && !meeting.meet_link) renderMeetBox(detailEl.querySelector("#meet-box"), meeting, ctx);
  renderAgendaBox(detailEl.querySelector("#agenda-box"), meeting);
  if (!upcomingOnly) renderAttendanceBox(detailEl.querySelector("#attendance-box"), meeting);
  if (canManage) {
    renderAudioBox(detailEl.querySelector("#audio-box"), meeting, ctx, () => reloadDetail(detailEl, meeting.id, ctx));
  }
  if (!upcomingOnly) renderDraftBox(detailEl.querySelector("#draft-box"), meeting, ctx);

  const editBtn = detailEl.querySelector("#edit-meeting-btn");
  if (editBtn) editBtn.addEventListener("click", () => openScheduleModal(meeting, async (updated) => {
    renderDetail(detailEl, updated, ctx);
    ctx.reloadList();
  }, ctx.targets));
  const cancelBtn = detailEl.querySelector("#cancel-meeting-btn");
  if (cancelBtn) busyOnClick(cancelBtn, async () => {
    if (!(await confirmDialog("Anulezi ședința? Se șterge din calendar și se anunță echipa.", { danger: true }))) return;
    try {
      await api.del(`/api/meetings/${meeting.id}`);
      toast("Ședință anulată", "success");
      detailEl.innerHTML = "";
      ctx.reloadList();
      if (ctx.afterCancel) ctx.afterCancel();
    } catch (e) { toast(e.message, "error"); }
  });

  const genBtn = detailEl.querySelector("#gen-draft-btn");
  if (genBtn) busyOnClick(genBtn, async () => {
    try {
      const updated = await api.post(`/api/meetings/${meeting.id}/draft`);
      toast("Ciornă generată", "success");
      renderDetail(detailEl, updated, ctx);
    } catch (e) { toast(e.message + (e.article ? ` (${e.article})` : ""), "error"); }
  });

  const approveBtn = detailEl.querySelector("#approve-btn");
  if (approveBtn) busyOnClick(approveBtn, async () => {
    if (!(await confirmDialog("Aprobi acest proces verbal? Devine imuabil și acțiunile se transformă în taskuri."))) return;
    try {
      const updated = await api.post(`/api/meetings/${meeting.id}/approve`);
      toast("PV aprobat", "success");
      renderDetail(detailEl, updated, ctx);
      ctx.reloadList();
    } catch (e) { toast(e.message + (e.article ? ` (${e.article})` : ""), "error"); }
  });
}

// Prezență (design-sedinte-v3.md §2): chemați + participanți extra, P / A / M manual, cod QR pe tot ecranul,
// Închide / Redeschide prezența. Lista se actualizează singură (~5 s) cât timp e pe ecran.
async function renderAttendanceBox(box, meeting) {
  const approved = meeting.status === "approved";
  const editable = !!meeting.can_organize && !approved;
  const url = `/api/meetings/${meeting.id}/attendance`;
  let data = null;
  let busy = false;

  const markBtns = (m) => MARKS.map(([st, letter, label]) =>
    `<button type="button" class="mark-status-pill mark-${st} ${m.record === st ? "on" : ""} ${!m.record && m.suggested === st ? "suggested" : ""}" data-st="${st}" title="${esc(label)}${!m.record && m.suggested === st ? " (absență aprobată)" : ""}" aria-label="${esc(label)}: ${esc(m.name)}${!m.record && m.suggested === st ? " (absență aprobată)" : ""}" aria-pressed="${m.record === st}" ${editable ? "" : "disabled"}>${letter}</button>`).join("");
  const row = (m) => `
    <div class="mark-row" data-id="${m.id}" style="cursor:default">
      <div class="avatar">${esc((m.name || "?").slice(0, 1).toUpperCase())}</div>
      <div class="mark-row-info"><strong>${esc(m.name)}</strong>${m.status === "pauza" ? '<span class="muted small"> · în pauză</span>' : ""}${m.id === data.created_by ? '<span class="muted small"> · a programat ședința</span>' : ""}${m.extra ? '<span class="badge">Extra</span>' : ""}</div>
      ${m.record === "scutit" ? `<div class="mark-status-pill mark-scutit">Scutit</div>` : `<div class="mark-btns">${markBtns(m)}</div>`}
    </div>`;

  function paint() {
    const c = data.counts;
    const closed = !!data.closed_at;
    box.innerHTML = `
      <p class="muted small" id="att-counter">${c.present}/${c.invited} chemați prezenți · ${c.marked} marcați${c.extras ? ` · ${c.extras} extra` : ""}
        ${closed ? ` · <span class="badge badge-ok">Prezență închisă</span>` : ""}</p>
      ${editable ? `<div class="form-actions">
        ${closed ? `<button class="btn btn-small btn-ghost" id="att-reopen">Redeschide prezența</button>`
          : `<button class="btn btn-small" id="att-qr">Prezență cu cod QR</button>
             <button class="btn btn-small btn-ghost" id="att-close">Închide prezența</button>`}</div>` : ""}
      <div class="marking-list">${data.invited.map(row).join("") || emptyHtml("Niciun membru chemat.")}</div>
      ${data.extras.length ? `<h4>Participanți extra</h4><div class="marking-list">${data.extras.map(row).join("")}</div>` : ""}`;

    box.querySelectorAll(".mark-row").forEach((r) => {
      r.querySelectorAll("[data-st]").forEach((btn) => btn.addEventListener("click", () => {
        const m = [...data.invited, ...data.extras].find((x) => x.id === Number(r.dataset.id));
        if (!m || m.record === btn.dataset.st) return;
        act(() => api.put(url, { records: [{ member_id: m.id, status: btn.dataset.st }] }));
      }));
    });
    const qrBtn = box.querySelector("#att-qr");
    if (qrBtn) qrBtn.addEventListener("click", () => openQrScreen(meeting, () => act(() => api.get(url))));
    const closeBtn = box.querySelector("#att-close");
    if (closeBtn) closeBtn.addEventListener("click", async () => {
      if (!(await confirmDialog("Închizi prezența? Chemații nemarcați devin absenți (cei cu absență aprobată: motivați), iar codul QR nu mai funcționează."))) return;
      act(() => api.post(`${url}/close`), "Prezență închisă");
    });
    const reopenBtn = box.querySelector("#att-reopen");
    if (reopenBtn) reopenBtn.addEventListener("click", () => act(() => api.post(`${url}/reopen`), "Prezență redeschisă"));
  }

  async function act(fn, okMsg) {
    busy = true;
    try { data = await fn(); paint(); if (okMsg) toast(okMsg, "success"); }
    catch (e) { toast(e.message, "error"); }
    finally { busy = false; }
  }

  box.innerHTML = loadingHtml();
  try { data = await api.get(url); paint(); }
  catch (e) { box.innerHTML = errorHtml(e); return; }

  const timer = setInterval(async () => {
    if (!box.isConnected) { clearInterval(timer); return; }
    if (busy || document.hidden || approved) return;
    try {
      const fresh = await api.get(url);
      // repaint only on a real change, so a click in progress is never lost to a re-render
      if (!busy && JSON.stringify(fresh) !== JSON.stringify(data)) { data = fresh; paint(); }
    } catch (e) { /* next tick */ }
  }, 5000);
}

// Full-screen QR: refreshed every ~5 s (the token rotates every 30 s), with a countdown to the next code.
function openQrScreen(meeting, onClose) {
  const overlay = document.createElement("div");
  overlay.className = "qr-overlay";
  overlay.innerHTML = `
    <div class="qr-panel">
      <h2>${esc(meeting.session.title || "Ședință")}</h2>
      <p class="qr-hint">Scanează codul cu telefonul ca să fii marcat prezent.</p>
      <div class="qr-code" id="qr-code">${loadingHtml()}</div>
      <p class="qr-countdown" id="qr-countdown" aria-live="polite"></p>
      <button class="btn" id="qr-close">Închide</button>
    </div>`;
  document.body.appendChild(overlay);
  if (overlay.requestFullscreen) overlay.requestFullscreen().catch(() => {});

  // While a code is available it is refreshed every ~5 s (the token rotates every 30 s). A 4xx answer is the
  // server saying there is no code (too early, attendance closed...): polling stops, the message stays, and
  // opening the QR screen again retries. Network errors / 5xx are transient: keep polling, „Se reîncearcă…”.
  // The link inside the code (with its token) is never shown as text.
  let secondsLeft = 0;
  let stopped = false;
  let refreshTimer = null;
  let countdownTimer = null;
  function startTimers() {
    if (refreshTimer) return;
    refreshTimer = setInterval(refresh, 5000);
    countdownTimer = setInterval(() => { if (secondsLeft > 0) { secondsLeft -= 1; tick(); if (secondsLeft === 0) refresh(); } }, 1000);
  }
  function stopTimers() {
    clearInterval(refreshTimer);
    clearInterval(countdownTimer);
    refreshTimer = countdownTimer = null;
  }
  async function refresh() {
    try {
      const qr = await api.get(`/api/meetings/${meeting.id}/qr`);
      if (stopped) return;
      overlay.querySelector("#qr-code").innerHTML = qr.svg; // server-generated SVG (qrcode lib), no user text inside
      secondsLeft = qr.seconds_left;
      tick();
      startTimers();
    } catch (e) {
      if (stopped) return;
      const domainAnswer = e.status >= 400 && e.status < 500;
      if (domainAnswer) {
        stopTimers();
        overlay.querySelector("#qr-code").innerHTML = `<p class="qr-error">${esc(e.message)}</p>`;
        overlay.querySelector("#qr-countdown").textContent = "Închide și redeschide codul QR ca să încerci din nou.";
        secondsLeft = 0;
        return;
      }
      // transient: keep the last code (it may still be valid) and keep trying
      secondsLeft = 0;
      overlay.querySelector("#qr-countdown").textContent = "Se reîncearcă…";
      startTimers();
    }
  }
  function tick() {
    if (secondsLeft <= 0) return;
    overlay.querySelector("#qr-countdown").textContent = `Cod nou în ${secondsLeft} s`;
  }
  function close() {
    if (stopped) return;
    stopped = true;
    stopTimers();
    document.removeEventListener("keydown", onKey);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    overlay.remove();
    if (onClose) onClose();
  }
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  overlay.querySelector("#qr-close").addEventListener("click", close);
  overlay.addEventListener("qr:close", close);
  refresh();
}

function renderAgendaBox(box, meeting) {
  const approved = meeting.status === "approved";
  const editable = !!meeting.can_organize && !approved;
  box.innerHTML = `
    <ol id="agenda-list">${(meeting.agenda || []).map((a, i) => `
      <li data-idx="${i}"><span>${esc(a)}</span>${editable ? `<button class="btn-icon" data-remove-agenda aria-label="Șterge punctul ${esc(a)}" title="Șterge">&times;</button>` : ""}</li>`).join("") || `<li class="muted">Niciun punct încă.</li>`}
    </ol>
    ${editable ? `<div class="form">
        <input class="input" id="agenda-new" aria-label="Punct nou pe ordinea de zi" placeholder="Punct nou pe ordinea de zi">
        <button class="btn btn-small" id="agenda-add">Adaugă</button>
      </div>` : ""}`;
  if (!editable) return;

  let agenda = [...(meeting.agenda || [])];
  async function save() {
    const updated = await api.put(`/api/meetings/${meeting.id}/agenda`, { agenda });
    meeting.agenda = updated.agenda;
  }
  box.querySelector("#agenda-add").addEventListener("click", async () => {
    const input = box.querySelector("#agenda-new");
    const val = input.value.trim();
    if (!val) return;
    agenda.push(val);
    try { await save(); input.value = ""; renderAgendaBox(box, meeting); }
    catch (e) { toast(e.message, "error"); }
  });
  box.querySelectorAll("[data-remove-agenda]").forEach((btn, i) => {
    btn.addEventListener("click", async () => {
      agenda.splice(i, 1);
      try { await save(); renderAgendaBox(box, meeting); }
      catch (e) { toast(e.message, "error"); }
    });
  });
}

function renderMeetBox(box, meeting, ctx) {
  const canManage = !!meeting.can_manage;
  const approved = meeting.status === "approved";
  if (!meeting.meet_link) {
    box.innerHTML = `<p class="muted">Niciun link Meet.</p>` + (canManage && !approved ? `
      <div class="form">
        <button class="btn btn-small" id="meet-auto">Creează automat (Google Calendar)</button>
        <input class="input" id="meet-manual" aria-label="sau lipește link manual" placeholder="sau lipește link manual">
        <button class="btn btn-small" id="meet-manual-save">Salvează</button>
      </div>` : "");
    if (canManage && !approved) {
      box.querySelector("#meet-auto").addEventListener("click", async (e) => {
        try {
          const res = await api.post(`/api/meetings/${meeting.id}/meet-link/auto`);
          if (!res.configured) { toast("Nu există cont Google configurat - introdu linkul manual.", "info"); return; }
          if (!res.meet_link) { toast("Crearea automată a eșuat - introdu linkul manual.", "error"); return; }
          meeting.meet_link = res.meet_link;
          renderMeetBox(box, meeting, ctx);
          toast("Link Meet creat", "success");
        } catch (e) { toast(e.message, "error"); }
      });
      box.querySelector("#meet-manual-save").addEventListener("click", async () => {
        const link = box.querySelector("#meet-manual").value.trim();
        if (!link) return;
        try {
          const updated = await api.put(`/api/meetings/${meeting.id}/meet-link`, { link });
          meeting.meet_link = updated.meet_link;
          renderMeetBox(box, meeting, ctx);
          toast("Link salvat", "success");
        } catch (e) { toast(e.message, "error"); }
      });
    }
    return;
  }
  box.innerHTML = `<p><a href="${esc(meeting.meet_link)}" target="_blank" rel="noopener">${esc(meeting.meet_link)}</a>
    <span class="muted small">(${meeting.meet_source === "auto" ? "Google Calendar" : "manual"})</span></p>`;
}

function renderAudioBox(box, meeting, ctx, reload) {
  const approved = meeting.status === "approved";
  box.innerHTML = `
    <p class="muted small">Status audio: <span id="audio-status-label">${esc(describeAudioStatus(meeting))}</span></p>
    <div id="live-rec-box"></div>
    ${!approved ? `<p class="muted small" style="margin-top:.75rem">Sau încarcă un fișier existent:</p>
    <div class="form-actions">${fileField("audio-file", { accept: ".mp3,.m4a,.wav,.webm,.ogg", label: "Alege fișier audio" })}
    <button class="btn btn-small" id="audio-upload">Încarcă fișier</button></div>` : ""}`;
  renderRecordingBox(box.querySelector("#live-rec-box"), meeting, { onChange: reload });
  if (meeting.audio_status === "processing") pollAudioStatus(box, meeting);
  const uploadBtn = box.querySelector("#audio-upload");
  if (!uploadBtn) return;
  busyOnClick(uploadBtn, async () => {
    const fileInput = box.querySelector("#audio-file");
    if (!fileInput.files.length) { toast("Alege un fișier audio.", "error"); return; }
    const fd = new FormData();
    fd.append("file", fileInput.files[0]);
    try {
      await api.upload(`/api/meetings/${meeting.id}/audio`, fd);
      toast("Audio încărcat, se procesează transcrierea...", "success");
      pollAudioStatus(box, meeting);
    } catch (e) { toast(e.message, "error"); }
  });
}

function describeAudioStatus(meeting) {
  const map = { none: "fără audio", processing: "se transcrie…", done: "transcriere finalizată", error: meeting.audio_error || "eroare la transcriere" };
  return map[meeting.audio_status] || meeting.audio_status || "—";
}

let pollTimer = null; // one poller at a time; cleared on re-render / navigation (label detached)
function pollAudioStatus(box, meeting) {
  const label = box.querySelector("#audio-status-label");
  clearInterval(pollTimer);
  const timer = pollTimer = setInterval(async () => {
    if (!label || !label.isConnected) { clearInterval(timer); return; }
    try {
      const status = await api.get(`/api/meetings/${meeting.id}/audio/status`);
      meeting.audio_status = status.audio_status;
      meeting.audio_error = status.audio_error;
      if (label) label.textContent = describeAudioStatus(meeting);
      if (status.audio_status === "done" || status.audio_status === "error") clearInterval(timer);
    } catch (e) { clearInterval(timer); }
  }, 4000);
}

function renderDraftBox(box, meeting, ctx) {
  const canManage = !!meeting.can_manage;
  const approved = meeting.status === "approved";
  const d = meeting.draft;
  if (!d) { box.innerHTML = `<p class="muted">Nicio ciornă generată încă.</p>`; return; }

  const editable = canManage && !approved;
  box.innerHTML = `
    <p><strong>Prezențe:</strong> ${esc(d.attendance.total_present)} din ${esc(d.attendance.total_roster)} membri activi
      (motivați: ${esc((d.attendance.absent_motivated_names || []).join(", ") || "—")})</p>

    <div id="discussions-list">${(d.discussions || []).map((disc, i) => `
      <div class="card" style="margin:.5rem 0" data-disc-idx="${i}">
        <strong>${esc(disc.point)}</strong>${disc.majora ? ` <span class="badge badge-warn">Decizie majoră · Art. 47.2</span>` : ""}
        <p class="muted small">${esc(disc.discussion)}</p>
        <p><strong>Decizie:</strong> ${editable ? `<input class="input" data-field="decision" value="${esc(disc.decision)}">` : esc(disc.decision)}</p>
      </div>`).join("") || `<p class="muted">Nicio discuție.</p>`}
    </div>

    <p><strong>Anunțuri:</strong></p>
    ${editable ? `<textarea class="input" id="announcements-field" rows="2">${esc(d.announcements || "")}</textarea>` : `<p>${esc(d.announcements || "—")}</p>`}

    <p><strong>Acțiuni:</strong></p>
    <div class="table-scroll"><table class="data-table"><thead><tr><th>Acțiune</th><th>Responsabil</th><th>Termen</th></tr></thead>
      <tbody>${(d.actions || []).map((a) => `<tr><td>${esc(a.action)}</td><td>${esc(a.responsible_name || "—")}</td><td>${a.due_date ? esc(fmtDate(a.due_date)) : "—"}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Nicio acțiune.</td></tr>`}</tbody>
    </table></div>

    <p><strong>Ședința următoare:</strong> ${d.next_meeting && d.next_meeting.date ? esc(fmtDate(d.next_meeting.date)) : "neprogramată"}${d.next_meeting && d.next_meeting.note ? " — " + esc(d.next_meeting.note) : ""}</p>

    ${d.redactat_de || d.verificat_de ? `<p class="muted small">Redactat de: ${esc(d.redactat_de || "—")} · Verificat de: ${esc(d.verificat_de || "—")}</p>` : ""}
    ${editable ? `<button class="btn btn-small" id="draft-save">Salvează modificările</button>` : ""}`;

  const saveBtn = box.querySelector("#draft-save");
  if (!saveBtn) return;
  busyOnClick(saveBtn, async () => {
    const newDraft = JSON.parse(JSON.stringify(d));
    box.querySelectorAll("[data-disc-idx]").forEach((card) => {
      const idx = Number(card.dataset.discIdx);
      const input = card.querySelector('[data-field="decision"]');
      if (input) newDraft.discussions[idx].decision = input.value;
    });
    const announcementsField = box.querySelector("#announcements-field");
    if (announcementsField) newDraft.announcements = announcementsField.value;
    try {
      const updated = await api.put(`/api/meetings/${meeting.id}/draft`, { draft: newDraft });
      toast("Ciornă salvată", "success");
      Object.assign(meeting, updated);
      renderDraftBox(box, meeting, ctx);
    } catch (e) { toast(e.message, "error"); }
  });
}
