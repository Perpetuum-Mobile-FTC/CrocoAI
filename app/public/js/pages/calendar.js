import { api } from "../api.js";
import { esc, fmtTime, loadingHtml, errorHtml, toast, openModal, confirmDialog, busyOnClick, dateLocal, competitionLevelBadge, competitionLevelField, wireCompetitionLevel } from "../ui.js";
import { currentUser, can } from "../app.js";

const TYPE_LABELS = { sedinta: "Ședință", urgenta: "Urgență", competitie: "Competiție", antrenament: "Antrenament", eveniment: "Eveniment" };
const DAY_NAMES = ["Lu", "Ma", "Mi", "Jo", "Vi", "Sâ", "Du"];

export async function mountCalendar(container) {
  const user = currentUser();
  const canManage = can("events.manage") || can("events.manage_urgenta"); // a mentor: emergency meetings only
  let cursor = new Date();
  cursor.setDate(1);

  container.innerHTML = `
    <div class="container">
      <div class="page-header"><h1>Calendar</h1>${canManage ? `<button class="btn" id="new-event-btn">+ Eveniment nou</button>` : ""}</div>
      <div class="card">
        <div class="cal-nav">
          <button type="button" class="cal-arrow" id="cal-prev" aria-label="Luna anterioară">&#8592;</button>
          <span class="cal-month-label" id="cal-label" aria-live="polite"></span>
          <button type="button" class="cal-arrow" id="cal-next" aria-label="Luna următoare">&#8594;</button>
        </div>
        <div class="cal-header">${DAY_NAMES.map((d) => `<div class="cal-day-name">${d}</div>`).join("")}</div>
        <div class="cal-body" id="cal-body">${loadingHtml()}</div>
      </div>
      <div id="day-detail"></div>
    </div>`;

  document.getElementById("cal-prev").addEventListener("click", () => { cursor.setMonth(cursor.getMonth() - 1); render(); });
  document.getElementById("cal-next").addEventListener("click", () => { cursor.setMonth(cursor.getMonth() + 1); render(); });
  if (canManage) document.getElementById("new-event-btn").addEventListener("click", () => openEventModal(null, user, () => render()));

  async function render() {
    document.getElementById("cal-label").textContent = cursor.toLocaleDateString("ro-RO", { month: "long", year: "numeric" });
    const bodyEl = document.getElementById("cal-body");
    bodyEl.innerHTML = loadingHtml();
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    try {
      const events = await api.get(`/api/events?from=${dateLocal(first)}&to=${dateLocal(last)}T23:59:59`);
      renderGrid(bodyEl, first, last, events, user, canManage, render);
    } catch (e) { bodyEl.innerHTML = errorHtml(e); }
  }
  await render();
}

function renderGrid(bodyEl, first, last, events, user, canManage, reload) {
  const byDay = {};
  for (const ev of events) {
    const d = dateLocal(new Date(ev.start_time));
    (byDay[d] = byDay[d] || []).push(ev);
  }
  const startWeekday = (first.getDay() + 6) % 7; // Monday = 0
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= last.getDate(); d++) cells.push(new Date(first.getFullYear(), first.getMonth(), d));
  const todayStr = dateLocal(new Date());

  bodyEl.innerHTML = cells.map((d) => {
    if (!d) return `<div class="cal-cell empty"></div>`;
    const key = dateLocal(d);
    const dayEvents = byDay[key] || [];
    return `<div class="cal-cell ${key === todayStr ? "today" : ""}" data-day="${key}" role="button" tabindex="0" aria-label="${esc(d.toLocaleDateString("ro-RO", { day: "numeric", month: "long" }))}${dayEvents.length ? `, ${dayEvents.length} ${dayEvents.length === 1 ? "eveniment" : "evenimente"}` : ""}">
        <span class="cal-cell-num">${d.getDate()}</span>
        ${dayEvents.slice(0, 2).map((ev) => `<div class="cal-event-dot">${esc(ev.title)}</div>`).join("")}
        ${dayEvents.length > 2 ? `<div class="cal-event-more">+${dayEvents.length - 2}</div>` : ""}
      </div>`;
  }).join("");

  bodyEl.querySelectorAll("[data-day]").forEach((cell) => {
    const open = () => showDayDetail(cell.dataset.day, byDay[cell.dataset.day] || [], user, canManage, reload);
    cell.addEventListener("click", open);
    cell.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

function showDayDetail(day, dayEvents, user, canManage, reload) {
  const detail = document.getElementById("day-detail");
  detail.innerHTML = `
    <div class="card">
      <h2>${new Date(day + "T00:00:00").toLocaleDateString("ro-RO", { weekday: "long", day: "numeric", month: "long" })}</h2>
      ${dayEvents.length ? `<div class="list">${dayEvents.map((ev, i) => `
        <div class="list-item" data-ev-id="${ev.id}" data-ev-idx="${i}">
          <div class="list-item-main">
            <strong>${esc(ev.title)}</strong>
            <span class="muted small">${fmtTime(new Date(ev.start_time).toTimeString())} · ${esc(TYPE_LABELS[ev.type] || ev.type)}${ev.location ? " · " + esc(ev.location) : ""}</span>
            ${ev.type === "competitie" && ev.competition_level ? `<div class="small">${competitionLevelBadge(ev.competition_level)}</div>` : ""}
            ${ev.recurrence ? `<div class="muted small">Se repetă săptămânal</div>` : ""}
            ${ev.meeting_id && !ev.recurrence ? `<div class="muted small">Ședință — se modifică sau se anulează din Ședințe.</div>` : ""}
          </div>
          <div class="list-item-meta">
            ${ev.meeting_id && user.meetings_section ? `<a class="btn btn-small btn-ghost" href="/sedinte" data-link>Ședințe</a>` : ""}
            ${(ev.type === "sedinta" || ev.type === "urgenta") && user.meetings_section ? `<a class="btn btn-small btn-ghost" href="/sedinte?tab=prezenta" data-link>Prezență</a>` : ""}
            ${editable(ev, user, canManage) ? `<button class="btn-icon" data-edit-ev title="${ev.recurrence ? "Editează seria" : "Editează"}" aria-label="${ev.recurrence ? "Editează seria" : "Editează"} ${esc(ev.title)}">✎</button><button class="btn-icon" data-del-ev title="${ev.recurrence ? "Șterge seria" : "Șterge"}" aria-label="${ev.recurrence ? "Șterge seria" : "Șterge"} ${esc(ev.title)}">&times;</button>` : ""}
          </div>
        </div>`).join("")}</div>` : `<p class="muted">Niciun eveniment în această zi.</p>`}
    </div>`;
  detail.querySelectorAll("[data-edit-ev]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ev = dayEvents[Number(btn.closest("[data-ev-idx]").dataset.evIdx)];
      // An occurrence of a series edits the whole series: start from the series' first date, not this one.
      openEventModal(ev.series_start_time ? { ...ev, start_time: ev.series_start_time } : ev, user, reload);
    });
  });
  detail.querySelectorAll("[data-del-ev]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ev = dayEvents[Number(btn.closest("[data-ev-idx]").dataset.evIdx)];
      if (!(await confirmDialog(ev.recurrence ? "Ștergi toată seria (toate aparițiile)?" : "Ștergi acest eveniment?", { danger: true }))) return;
      const id = btn.closest("[data-ev-id]").dataset.evId;
      try { await api.del(`/api/events/${id}`); toast("Eveniment șters", "success"); reload(); }
      catch (e) { toast(e.message, "error"); }
    });
  });
}

// Meeting events belong to Ședințe (the server refuses Calendar edits too, design-pachet-b.md B3).
function editable(ev, user, canManage) {
  if (ev.meeting_id && !ev.recurrence) return false;
  return can("events.manage") || (can("events.manage_urgenta") && ev.type === "urgenta");
}

// Stored instant (ISO) -> "YYYY-MM-DDTHH:MM" in the browser's local time, for <input type="datetime-local">.
function toLocalInput(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openEventModal(ev, user, onSaved) {
  const urgentOnly = !can("events.manage"); // reached only with events.manage_urgenta (an active mentor)
  const canUrgent = can("events.manage_urgenta");
  const typeOptions = urgentOnly ? ["urgenta"] : Object.keys(TYPE_LABELS).filter((t) => t !== "urgenta" || canUrgent || (ev && ev.type === "urgenta"));
  const modal = openModal(`
    <h3>${ev ? "Editează eveniment" : "Eveniment nou"}</h3>
    <div class="form">
      <input class="input" id="ev-title" aria-label="Titlu" placeholder="Titlu" value="${ev ? esc(ev.title) : ""}">
      <label class="field-label">Tip<select class="input" id="ev-type">${typeOptions.map((t) => `<option value="${t}" ${ev && ev.type === t ? "selected" : ""}>${TYPE_LABELS[t]}</option>`).join("")}</select></label>
      ${competitionLevelField("ev-level", ev && ev.competition_level)}
      <label class="field-label">Data și ora<input class="input" type="datetime-local" id="ev-start" value="${ev ? esc(toLocalInput(ev.start_time)) : ""}"></label>
      <input class="input" id="ev-location" aria-label="Locație" placeholder="Locație" value="${ev && ev.location ? esc(ev.location) : ""}">
      ${!ev ? `<label class="checkbox-row"><input type="checkbox" id="ev-recurring"> Recurență săptămânală</label>
      <label class="field-label">Până la<input class="input" type="date" id="ev-recur-until" disabled></label>` : ""}
      <button class="btn" id="ev-save">${ev ? "Salvează" : "Creează"}</button>
      <div class="form-error" id="ev-error"></div>
    </div>`);

  wireCompetitionLevel(modal.el, "#ev-type", "ev-level");
  const recurCb = modal.el.querySelector("#ev-recurring");
  if (recurCb) recurCb.addEventListener("change", () => { modal.el.querySelector("#ev-recur-until").disabled = !recurCb.checked; });

  busyOnClick(modal.el.querySelector("#ev-save"), async () => {
    const errEl = modal.el.querySelector("#ev-error");
    const title = modal.el.querySelector("#ev-title").value.trim();
    const start = modal.el.querySelector("#ev-start").value;
    if (!title || !start) { errEl.textContent = "Titlul și data sunt obligatorii."; return; }
    const body = {
      title,
      type: modal.el.querySelector("#ev-type").value,
      start_time: new Date(start).toISOString(), // datetime-local is the browser's local time -> send an instant
      location: modal.el.querySelector("#ev-location").value.trim() || undefined,
    };
    if (body.type === "competitie") body.competition_level = modal.el.querySelector("#ev-level").value;
    if (recurCb && recurCb.checked) {
      body.recurrence = "weekly";
      body.recurrence_until = modal.el.querySelector("#ev-recur-until").value || undefined;
    }
    try {
      if (ev) await api.put(`/api/events/${ev.id}`, body);
      else await api.post("/api/events", body);
      toast("Eveniment salvat", "success");
      modal.close();
      onSaved();
    } catch (e) { errEl.textContent = e.message + (e.article ? ` (${e.article})` : ""); }
  });
}
