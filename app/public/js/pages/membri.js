import { api } from "../api.js";
import { esc, loadingHtml, errorHtml, emptyHtml, toast, openModal, confirmDialog, busyOnClick, fileField, showOneTimePassword } from "../ui.js";
import { can, ROLE_NAMES } from "../app.js";
import { DEPT_LABELS, STATUS_LABELS } from "./membri-labels.js";

// Sub-modules: membri-cereri.js (applications), membri-profil.js (member profile), membri-labels.js.
export { mountMembruProfil } from "./membri-profil.js";

export async function mountMembri(container) {
  const isLeader = can("members.manage");
  container.innerHTML = `
    <div class="container">
      <div class="page-header">
        <h1>Membri</h1>
        ${isLeader ? `<div class="page-header-actions">
          <button class="btn btn-ghost" id="import-btn">Import CSV/vCard</button>
          <button class="btn btn-ghost" id="start-onboarding-btn">+ Voluntar nou (onboarding)</button>
          <button class="btn" id="add-member-btn">+ Membru nou</button>
        </div>` : ""}
      </div>
      <div id="tab-membri">
        <input class="input" id="member-search" aria-label="Caută după nume" placeholder="Caută după nume…" style="margin-bottom:12px">
        <div class="filters" id="member-filters">
          <select class="input" id="filter-role" aria-label="Filtru rol"><option value="">Toate rolurile</option>${Object.entries(ROLE_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
          <select class="input" id="filter-dept" aria-label="Filtru departament"><option value="">Toate departamentele</option>${Object.entries(DEPT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
          <select class="input" id="filter-status" aria-label="Filtru status"><option value="">Toate statusurile</option>${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        </div>
        ${isLeader ? `<div class="page-header-actions" style="margin-bottom:10px"><button class="btn btn-ghost btn-small" id="bulk-completion-btn">Trimite link de completare — toți cu date lipsă</button></div>` : ""}
        <div id="member-list">${loadingHtml()}</div>
      </div>
    </div>`;

  const listEl = document.getElementById("member-list");
  let members = [];
  let missingById = new Map();
  try {
    const [membersRes, missingRes] = await Promise.allSettled([
      api.get("/api/members"),
      isLeader ? api.get("/api/members/missing-data") : Promise.resolve([]),
    ]);
    if (membersRes.status !== "fulfilled") throw membersRes.reason;
    members = membersRes.value;
    if (missingRes.status === "fulfilled") missingById = new Map(missingRes.value.map((r) => [r.id, r]));
  } catch (e) { listEl.innerHTML = errorHtml(e); return; }

  function applyFilters() {
    const q = document.getElementById("member-search").value.trim().toLowerCase();
    const role = document.getElementById("filter-role").value;
    const dept = document.getElementById("filter-dept").value;
    const status = document.getElementById("filter-status").value;
    const filtered = members.filter((m) =>
      (!q || m.name.toLowerCase().includes(q)) &&
      (!role || m.role === role) &&
      (!dept || m.department === dept) &&
      (!status || m.status === status)
    );
    renderList(listEl, filtered, missingById, isLeader);
  }
  ["member-search"].forEach((id) => document.getElementById(id).addEventListener("input", applyFilters));
  ["filter-role", "filter-dept", "filter-status"].forEach((id) => document.getElementById(id).addEventListener("change", applyFilters));
  applyFilters();

  if (isLeader) {
    document.getElementById("add-member-btn").addEventListener("click", () => openAddMemberModal(() => mountMembri(container)));
    document.getElementById("import-btn").addEventListener("click", () => openImportModal(() => mountMembri(container)));
    document.getElementById("start-onboarding-btn").addEventListener("click", () => openStartOnboardingModal(members, () => mountMembri(container)));
    busyOnClick(document.getElementById("bulk-completion-btn"), async () => {
      const ids = [...missingById.keys()];
      if (!ids.length) { toast("Niciun membru cu date lipsă.", "info"); return; }
      if (!(await confirmDialog(`Trimiți link de completare către ${ids.length} membri cu date lipsă? Mesajele se trimit la interval de 20s.`))) return;
      try {
        const res = await api.post("/api/completion-links/bulk", { member_ids: ids });
        const queued = res.filter((r) => r.queued).length;
        const manual = res.filter((r) => !r.queued);
        toast(`${queued} linkuri puse în coadă pe WhatsApp.${manual.length ? ` ${manual.length} fără telefon — trimite-le manual.` : ""}`, "success");
      } catch (e) { toast(e.message, "error"); }
    });
  }
}

// ─── Onboarding (Art. 14, 43) ───
function openStartOnboardingModal(members, onSaved) {
  const buddyOptions = members.filter((m) => m.status === "activ").map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
  const modal = openModal(`
    <h3>Voluntar nou — pornește integrarea</h3>
    <div class="form">
      <input class="input" id="ob-name" aria-label="Nume complet" placeholder="Nume complet">
      <input class="input" id="ob-phone" aria-label="Telefon (WhatsApp)" placeholder="Telefon (WhatsApp)">
      <select class="input" id="ob-dept" aria-label="Departament"><option value="ambele">Ambele</option><option value="tehnic">Tehnic</option><option value="non-tehnic">Non-tehnic</option></select>
      <select class="input" id="ob-buddy" aria-label="Buddy"><option value="">Fără buddy</option>${buddyOptions}</select>
      <button class="btn" id="ob-save">Pornește onboarding</button>
      <div class="form-error" id="ob-error"></div>
    </div>`);
  busyOnClick(modal.el.querySelector("#ob-save"), async () => {
    const errEl = modal.el.querySelector("#ob-error");
    errEl.textContent = "";
    const name = modal.el.querySelector("#ob-name").value.trim();
    const phone = modal.el.querySelector("#ob-phone").value.trim();
    if (!name || !phone) { errEl.textContent = "Numele și telefonul sunt obligatorii."; return; }
    const buddyId = modal.el.querySelector("#ob-buddy").value;
    try {
      await api.post("/api/onboarding", {
        name, phone,
        department: modal.el.querySelector("#ob-dept").value,
        buddy_id: buddyId ? Number(buddyId) : undefined,
      });
      modal.close();
      toast("Onboarding pornit — botul i-a trimis un mesaj de bun venit pe WhatsApp.", "success");
      onSaved();
    } catch (e) { errEl.textContent = e.message; }
  });
}

function renderList(listEl, members, missingById, isLeader) {
  if (!members.length) { listEl.innerHTML = emptyHtml("Niciun membru găsit."); return; }
  missingById = missingById || new Map();
  members.sort((a, b) => a.name.localeCompare(b.name, "ro"));
  listEl.innerHTML = `<div class="card"><div class="list">
    ${members.map((m) => `
      <div class="list-item ${m.status !== "activ" ? "member-inactive" : ""}" data-member-row="${m.id}">
        <a href="/membri/${m.id}" data-link class="list-item-main">
          <div class="avatar">${esc(m.name.slice(0, 1).toUpperCase())}</div>
          <div>
            <strong>${esc(m.name)}</strong>
            <div class="muted small">${esc(ROLE_NAMES[m.role] || m.role)}${m.department ? " · " + esc(DEPT_LABELS[m.department] || m.department) : ""}</div>
          </div>
        </a>
        <div class="list-item-meta">
          ${missingById.has(m.id) ? `<span class="badge badge-warn" >Date incomplete</span>` : ""}
          <span class="badge ${m.status !== "activ" ? "badge-warn" : ""}">${esc(STATUS_LABELS[m.status] || m.status)}</span>
          ${isLeader && missingById.has(m.id) ? `<button class="btn btn-small btn-ghost" data-send-link="${m.id}">Trimite link</button>` : ""}
        </div>
      </div>`).join("")}
  </div></div>`;

  if (isLeader) {
    listEl.querySelectorAll("[data-send-link]").forEach((btn) => {
      busyOnClick(btn, async () => {
        try {
          const [res] = await api.post("/api/completion-links/bulk", { member_ids: [Number(btn.dataset.sendLink)] });
          if (res && res.queued) toast("Link trimis — se pune în coadă pe WhatsApp.", "success");
          else toast(`Membrul nu are telefon înregistrat. Link: ${res ? res.url : ""}`, "warning");
        } catch (e) { toast(e.message, "error"); }
      });
    });
  }
}

function openAddMemberModal(onSaved) {
  const modal = openModal(`
    <h3>Membru nou</h3>
    <div class="form">
      <input class="input" id="am-name" aria-label="Nume complet" placeholder="Nume complet">
      <input class="input" id="am-phone" aria-label="Telefon (opțional)" placeholder="Telefon (opțional)">
      <select class="input" id="am-role" aria-label="Rol">${Object.entries(ROLE_NAMES).map(([k, v]) => `<option value="${k}" ${k === "member" ? "selected" : ""}>${v}</option>`).join("")}</select>
      <select class="input" id="am-dept" aria-label="Departament"><option value="">Departament</option>${Object.entries(DEPT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      <button class="btn" id="am-save">Creează membru</button>
      <div class="form-error" id="am-error"></div>
    </div>`);
  busyOnClick(modal.el.querySelector("#am-save"), async () => {
    const errEl = modal.el.querySelector("#am-error");
    errEl.textContent = "";
    const name = modal.el.querySelector("#am-name").value.trim();
    if (!name) { errEl.textContent = "Numele e obligatoriu."; return; }
    const body = {
      name,
      phone: modal.el.querySelector("#am-phone").value.trim() || undefined,
      role: modal.el.querySelector("#am-role").value,
      department: modal.el.querySelector("#am-dept").value || undefined,
    };
    try {
      const res = await api.post("/api/admin/members", body);
      modal.close();
      onSaved();
      await showOneTimePassword({ title: "Membru creat", intro: name, username: res.username, password: res.password });
    } catch (e) { errEl.textContent = e.message; }
  });
}

function openImportModal(onSaved) {
  const modal = openModal(`
    <h3>Import membri (CSV/vCard)</h3>
    <p class="muted small">Fișier CSV cu coloane: name, phone, email — sau fișier .vcf.</p>
    <div class="form">
      ${fileField("import-file", { accept: ".csv,.vcf,text/csv,text/vcard" })}
      <button class="btn" id="import-preview-btn">Previzualizare</button>
      <div class="form-error" id="import-error"></div>
    </div>
    <div id="import-preview"></div>`);

  modal.el.querySelector("#import-preview-btn").addEventListener("click", async () => {
    const errEl = modal.el.querySelector("#import-error");
    errEl.textContent = "";
    const file = modal.el.querySelector("#import-file").files[0];
    if (!file) { errEl.textContent = "Alege un fișier."; return; }
    let rows;
    try {
      const text = await file.text();
      rows = file.name.toLowerCase().endsWith(".vcf") ? parseVcf(text) : parseCsv(text);
    } catch (e) { errEl.textContent = "Nu am putut citi fișierul."; return; }
    if (!rows.length) { errEl.textContent = "Niciun rând valid găsit."; return; }
    let preview;
    try {
      preview = await api.post("/api/admin/import/preview", { rows });
    } catch (e) { errEl.textContent = e.message; return; }
    const previewEl = modal.el.querySelector("#import-preview");
    previewEl.innerHTML = `
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>Nume</th><th>Telefon</th><th>Email</th><th>Acțiune</th></tr></thead>
        <tbody>${preview.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.phone)}</td><td>${esc(r.email || "")}</td><td><span class="badge ${r.action === "skip_invalid_phone" ? "badge-danger" : ""}">${esc(r.action)}</span></td></tr>`).join("")}</tbody>
      </table></div>
      <button class="btn" id="import-confirm-btn">Confirmă importul</button>`;
    busyOnClick(previewEl.querySelector("#import-confirm-btn"), async () => {
      try {
        const results = await api.post("/api/admin/import/commit", { rows });
        const created = results.filter((r) => r.password);
        toast("Import finalizat", "success");
        onSaved();
        if (!created.length) { modal.close(); return; }
        // Temporary passwords are shown only now (never stored in clear) - the leader copies them.
        previewEl.innerHTML = `
          <p><strong>Conturi create — notează parolele acum, nu mai pot fi afișate:</strong></p>
          <div class="table-scroll"><table class="data-table">
            <thead><tr><th>Nume</th><th>Username</th><th>Parolă temporară</th></tr></thead>
            <tbody>${created.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.username)}</td><td><code>${esc(r.password)}</code></td></tr>`).join("")}</tbody>
          </table></div>
          <p class="muted small">La prima autentificare li se cere să-și schimbe parola.</p>`;
      } catch (e) { errEl.textContent = e.message; }
    });
  });
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const iName = header.indexOf("name"), iPhone = header.indexOf("phone"), iEmail = header.indexOf("email");
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    return { name: (cols[iName] || "").trim(), phone: (cols[iPhone] || "").trim(), email: (cols[iEmail] || "").trim() || undefined };
  }).filter((r) => r.name);
}
function parseVcf(text) {
  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  return cards.map((card) => {
    const nameMatch = card.match(/FN:(.*)/i);
    const telMatch = card.match(/TEL[^:]*:(.*)/i);
    const emailMatch = card.match(/EMAIL[^:]*:(.*)/i);
    return {
      name: nameMatch ? nameMatch[1].trim() : "",
      phone: telMatch ? telMatch[1].trim() : "",
      email: emailMatch ? emailMatch[1].trim() : undefined,
    };
  }).filter((r) => r.name);
}
