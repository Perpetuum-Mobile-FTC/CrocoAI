import { api } from "../api.js";
import { esc, fmtDate, fmtDateTime, loadingHtml, errorHtml, emptyHtml, toast, openModal, confirmDialog, busyOnClick, showOneTimePassword } from "../ui.js";
import { DEPT_LABELS, APPLICATION_STATUS_LABELS, GUARDIAN_RELATION_LABELS, fmtPhone } from "./membri-labels.js";

// ─── Cereri de înscriere (design-formular-date.md §2) ───
export async function loadCereriBadge() {
  try {
    const { count } = await api.get("/api/applications/pending-count");
    const badge = document.getElementById("cereri-badge");
    if (!badge) return;
    badge.textContent = count > 0 ? String(count) : ""; // 0 -> hidden (after the last accept / reject)
    badge.classList.toggle("hidden", !(count > 0));
  } catch (e) { /* non-critical */ }
}

// The "Cereri" tab of the Echipă section (a single tab row; the pending count rides on the tab link).
export function mountCereri(container) {
  container.innerHTML = `<div class="container"><div class="page-header"><h1>Cereri de înscriere</h1></div><div id="tab-cereri"></div></div>`;
  return loadCereri(document.getElementById("tab-cereri"));
}

export async function loadCereri(pane) {
  pane.innerHTML = loadingHtml();
  try {
    const apps = await api.get("/api/applications");
    if (!apps.length) { pane.innerHTML = emptyHtml("Nicio cerere de înscriere."); return; }
    pane.innerHTML = `<div class="card"><div class="list">${apps.map((a) => `
      <div class="list-item" data-app-id="${a.id}">
        <div class="list-item-main">
          <strong>${esc(a.full_name)}</strong>
          <span class="muted small">${esc(a.class)} · ${esc(a.school)} · ${esc(DEPT_LABELS[a.department] || a.department)}</span>
        </div>
        <div class="list-item-meta">
          <span class="badge ${a.status === "in_asteptare" ? "badge-warn" : a.status === "respinsa" ? "badge-danger" : "badge-ok"}">${esc(APPLICATION_STATUS_LABELS[a.status] || a.status)}</span>
          <button class="btn btn-small btn-ghost" data-view-app>Detalii</button>
        </div>
      </div>`).join("")}</div></div>`;
    pane.querySelectorAll("[data-view-app]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.closest("[data-app-id]").dataset.appId;
        const app = apps.find((a) => String(a.id) === id);
        openApplicationModal(app, () => { pane.dataset.loaded = ""; loadCereri(pane); loadCereriBadge(); });
      });
    });
  } catch (e) { pane.innerHTML = errorHtml(e); }
}

function openApplicationModal(app, onDecided) {
  const minor = !!app.guardian_name;
  const modal = openModal(`
    <h3>${esc(app.full_name)}</h3>
    <table class="kv-table">
      <tr><th>Telefon</th><td>${esc(fmtPhone(app.phone))}</td></tr>
      <tr><th>Email</th><td>${esc(app.email)}</td></tr>
      <tr><th>Data nașterii</th><td>${fmtDate(app.birthdate)}</td></tr>
      <tr><th>Clasă / Școală</th><td>${esc(app.class)} · ${esc(app.school)}</td></tr>
      <tr><th>Departament</th><td>${esc(DEPT_LABELS[app.department] || app.department)}</td></tr>
      ${minor ? `<tr><th>Părinte/tutore</th><td>${esc(app.guardian_name)} (${esc(GUARDIAN_RELATION_LABELS[app.guardian_relation] || app.guardian_relation)}) · ${esc(fmtPhone(app.guardian_phone))}</td></tr>` : ""}
      <tr><th>Motivație</th><td>${esc(app.motivation)}</td></tr>
      ${app.source ? `<tr><th>Cum a aflat</th><td>${esc(app.source)}</td></tr>` : ""}
      <tr><th>Trimisă la</th><td>${fmtDateTime(app.created_at)}</td></tr>
    </table>
    ${app.status === "in_asteptare" ? `
    <div class="form" style="margin-top:14px">
      <textarea class="input" id="app-note" rows="2" aria-label="Notă (opțională)" placeholder="Notă (opțională)"></textarea>
      <div class="checkbox-row" style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="app-notify-reject"><label for="app-notify-reject">Trimite mesaj WhatsApp politicos la respingere</label>
      </div>
      <div class="modal-actions-row">
        <button class="btn" id="app-accept">Acceptă</button>
        <button class="btn btn-ghost" id="app-reject">Respinge</button>
      </div>
      <div class="form-error" id="app-error"></div>
    </div>` : `<p class="muted small" style="margin-top:10px">Cerere ${esc(APPLICATION_STATUS_LABELS[app.status] || app.status)}${app.decision_note ? ` — ${esc(app.decision_note)}` : ""}</p>`}
  `);

  if (app.status !== "in_asteptare") return;

  busyOnClick(modal.el.querySelector("#app-accept"), async () => {
    const errEl = modal.el.querySelector("#app-error");
    try {
      const note = modal.el.querySelector("#app-note").value.trim() || undefined;
      const res = await api.post(`/api/applications/${app.id}/accept`, { note });
      modal.close();
      onDecided();
      if (res.sent_whatsapp) toast("Membru creat și credențialele au fost trimise pe WhatsApp.", "success");
      else await showOneTimePassword({ title: "Membru creat", intro: res.whatsapp_unavailable ? "WhatsApp nu este disponibil acum, credențialele nu au fost trimise — comunică-le manual." : "Numărul nu are WhatsApp — comunică-i credențialele manual.", username: res.member.username, password: res.password });
    } catch (e) { errEl.textContent = e.message; }
  });

  busyOnClick(modal.el.querySelector("#app-reject"), async () => {
    const errEl = modal.el.querySelector("#app-error");
    if (!(await confirmDialog("Respingi această cerere?", { danger: true }))) return;
    try {
      const note = modal.el.querySelector("#app-note").value.trim() || undefined;
      const notify = modal.el.querySelector("#app-notify-reject").checked;
      await api.post(`/api/applications/${app.id}/reject`, { note, notify });
      modal.close();
      toast("Cerere respinsă", "success");
      onDecided();
    } catch (e) { errEl.textContent = e.message; }
  });
}
