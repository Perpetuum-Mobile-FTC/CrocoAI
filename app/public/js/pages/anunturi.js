// Anunțuri (docs/design-pachet-b.md B1): every announcement the user may see + the publish form for those who
// may publish (the audiences come from the server - policy.js decides, not this page).
import { api } from "../api.js";
import { esc, fmtDateTime, loadingHtml, errorHtml, emptyHtml, toast, confirmDialog, busyOnClick } from "../ui.js";

export function announcementHtml(a, { canDelete = false } = {}) {
  return `<article class="announcement" data-ann-id="${a.id}">
      <div class="announcement-head">
        <strong class="announcement-title">${esc(a.title)}</strong>
        ${a.audience !== "echipa" ? `<span class="badge">${esc(a.audience_label)}</span>` : ""}
      </div>
      ${a.body ? `<p class="announcement-body">${esc(a.body)}</p>` : ""}
      <div class="muted small">${esc(a.author_name)} · ${esc(fmtDateTime(a.created_at))}${a.sent_whatsapp_at ? " · trimis și pe WhatsApp" : ""}
        ${canDelete && a.can_delete ? ` · <button class="link-btn" data-ann-del>Șterge</button>` : ""}</div>
    </article>`;
}

export async function mountAnunturi(container) {
  container.innerHTML = `<div class="container">
      <div class="page-header"><h1>Anunțuri</h1><a href="/" data-link class="btn btn-ghost btn-small">← Acasă</a></div>
      <div id="ann-form"></div>
      <div class="card"><div id="ann-list">${loadingHtml()}</div></div>
    </div>`;
  const listEl = container.querySelector("#ann-list");

  async function load() {
    try {
      const rows = await api.get("/api/announcements?limit=100");
      listEl.innerHTML = rows.length ? rows.map((a) => announcementHtml(a, { canDelete: true })).join("") : emptyHtml("Niciun anunț încă.");
      listEl.querySelectorAll("[data-ann-del]").forEach((btn) => btn.addEventListener("click", async () => {
        if (!(await confirmDialog("Ștergi anunțul?", { danger: true }))) return;
        try {
          await api.del(`/api/announcements/${btn.closest("[data-ann-id]").dataset.annId}`);
          toast("Anunț șters", "success");
          load();
        } catch (e) { toast(e.message, "error"); }
      }));
    } catch (e) { listEl.innerHTML = errorHtml(e); }
  }

  try {
    const audiences = await api.get("/api/announcements/audiences");
    if (audiences.length) renderForm(container.querySelector("#ann-form"), audiences, load);
  } catch (e) { /* no form - the list still loads */ }
  await load();
}

function renderForm(el, audiences, onPublished) {
  el.innerHTML = `<div class="card">
      <h2>Anunț nou</h2>
      <div class="form">
        <input class="input" id="ann-title" aria-label="Titlu" placeholder="Titlu" maxlength="200">
        <textarea class="input" id="ann-body" rows="4" aria-label="Text (opțional)" placeholder="Text (opțional)" maxlength="4000"></textarea>
        <label class="field-label">Pentru<select class="input" id="ann-audience">${audiences.map((a) => `<option value="${esc(a.key)}">${esc(a.label)}</option>`).join("")}</select></label>
        <label class="checkbox-row" id="ann-wa-row"><input type="checkbox" id="ann-wa"> Trimite și pe grupul de WhatsApp al echipei</label>
        <button class="btn" id="ann-publish">Publică</button>
        <div class="form-error" id="ann-error"></div>
      </div>
    </div>`;
  const audienceSel = el.querySelector("#ann-audience");
  const waRow = el.querySelector("#ann-wa-row");
  const waCb = el.querySelector("#ann-wa");
  // WhatsApp only for the whole team (server enforces it too).
  const syncWa = () => {
    const team = audienceSel.value === "echipa";
    waRow.classList.toggle("hidden", !team);
    if (!team) waCb.checked = false;
  };
  audienceSel.addEventListener("change", syncWa);
  syncWa();

  busyOnClick(el.querySelector("#ann-publish"), async () => {
    const errEl = el.querySelector("#ann-error");
    errEl.textContent = "";
    try {
      const res = await api.post("/api/announcements", {
        title: el.querySelector("#ann-title").value.trim(),
        body: el.querySelector("#ann-body").value.trim(),
        audience: audienceSel.value,
        send_whatsapp: waCb.checked,
      });
      const wa = { sent: " și trimis pe WhatsApp", failed: ", dar WhatsApp-ul nu a mers", not_configured: " (grupul de WhatsApp nu e configurat)" }[res.whatsapp] || "";
      toast(`Anunț publicat${wa}`, res.whatsapp === "failed" ? "error" : "success");
      el.querySelector("#ann-title").value = "";
      el.querySelector("#ann-body").value = "";
      waCb.checked = false;
      onPublished();
    } catch (e) { errEl.textContent = e.message + (e.article ? ` (${e.article})` : ""); }
  });
}
