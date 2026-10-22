import { api } from "../api.js";
import { esc, fmtDate, fmtSeen, fmtPct, loadingHtml, errorHtml, emptyHtml, toast, openModal, confirmDialog, busyOnClick, linkifyArticles, showOneTimePassword } from "../ui.js";
import { currentUser, can, ROLE_NAMES } from "../app.js";
import { STATUS_LABELS, DEPT_LABELS, DOC_STATUS_LABELS, TASK_STATUS_LABELS, fmtPhone } from "./membri-labels.js";

// ─── Profil membru ───
export async function mountMembruProfil(container, id) {
  container.innerHTML = `<div class="container">${loadingHtml()}</div>`;
  const wrap = container.querySelector(".container");
  const user = currentUser();
  let m;
  try {
    m = await api.get(`/api/members/${id}`);
  } catch (e) { wrap.innerHTML = errorHtml(e); return; }

  const isSelf = String(user.id) === String(id);
  const isLeader = can("members.manage");
  const canSeeContacts = can("members.view_contacts") || isSelf;
  const canOnboarding = can("onboarding.manage"); // policy onboarding.view / onboarding.manage

  wrap.innerHTML = `
    <div class="page-header">
      <div class="profile-header">
        <div class="avatar avatar-lg">${esc(m.name.slice(0, 1).toUpperCase())}</div>
        <div>
          <h1>${esc(m.name)}</h1>
          <p class="muted">${esc(ROLE_NAMES[m.role] || m.role)}${m.department ? " · " + esc(DEPT_LABELS[m.department] || m.department) : ""} · <span class="badge">${esc(STATUS_LABELS[m.status] || m.status)}</span></p>
        </div>
      </div>
      <div class="page-header-actions">
        ${isSelf ? `<button class="btn btn-ghost" id="edit-own-btn">Editează datele mele</button>
          <button class="btn btn-ghost" id="change-pw-btn">Schimbă parola</button>` : ""}
        ${isLeader ? `<button class="btn btn-ghost" id="edit-member-btn">Editează</button>` : ""}
      </div>
    </div>
    <div class="tabs" id="profile-tabs" role="tablist">
      <button class="tab-btn active" role="tab" aria-selected="true" aria-controls="tab-info" data-tab="info">Info</button>
      ${canSeeContacts || isLeader ? `<button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-parinti" data-tab="parinti">Părinți/tutori</button>` : ""}
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-prezenta" data-tab="prezenta">Prezență</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-documente" data-tab="documente">Documente</button>
      ${m.warnings !== undefined ? `<button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-avertismente" data-tab="avertismente">Avertismente</button>` : ""}
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-taskuri" data-tab="taskuri">Taskuri</button>
      ${canOnboarding || isSelf ? `<button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-integrare" data-tab="integrare">Integrare</button>` : ""}
    </div>
    <div id="tab-info" class="tab-pane">${renderInfo(m, canSeeContacts, isLeader)}</div>
    <div id="tab-parinti" class="tab-pane hidden"></div>
    <div id="tab-prezenta" class="tab-pane hidden"></div>
    <div id="tab-documente" class="tab-pane hidden"></div>
    <div id="tab-avertismente" class="tab-pane hidden"></div>
    <div id="tab-taskuri" class="tab-pane hidden">${renderTasks(m.tasks)}</div>
    <div id="tab-integrare" class="tab-pane hidden"></div>
  `;

  wrap.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".tab-btn").forEach((b) => { b.classList.toggle("active", b === btn); b.setAttribute("aria-selected", String(b === btn)); });
      wrap.querySelectorAll(".tab-pane").forEach((p) => p.classList.add("hidden"));
      const pane = document.getElementById(`tab-${btn.dataset.tab}`);
      pane.classList.remove("hidden");
      if (!pane.dataset.loaded) {
        pane.dataset.loaded = "1";
        if (btn.dataset.tab === "parinti") loadGuardians(pane, id, isLeader || isSelf);
        if (btn.dataset.tab === "prezenta") loadMemberAttendance(pane, id);
        if (btn.dataset.tab === "documente") loadMemberDocuments(pane, id, can("documents.review"));
        if (btn.dataset.tab === "avertismente") loadWarnings(pane, id, can("warnings.record"));
        if (btn.dataset.tab === "integrare") loadOnboarding(pane, id, canOnboarding);
      }
    });
  });

  if (isSelf) {
    document.getElementById("edit-own-btn").addEventListener("click", () => openEditOwnModal(m, () => mountMembruProfil(container, id)));
    document.getElementById("change-pw-btn").addEventListener("click", () => openChangePasswordModal(m));
  }
  if (isLeader) {
    document.getElementById("edit-member-btn").addEventListener("click", () => openEditMemberModal(m, () => mountMembruProfil(container, id)));
  }
}

// Prenume / Nume de familie for an edit form: the stored parts, or (not split yet) a guess - last word = family
// name - that the person checks before saving (the server never splits a name on its own).
function namePrefill(m) {
  if (m.first_name || m.last_name) return { first: m.first_name || "", last: m.last_name || "" };
  const words = String(m.name || "").trim().split(/\s+/).filter(Boolean);
  return words.length < 2 ? { first: words[0] || "", last: "" } : { first: words.slice(0, -1).join(" "), last: words[words.length - 1] };
}

function nameFields(prefix, m) {
  const n = namePrefill(m);
  return `<label class="field-label" for="${prefix}-first">Prenume</label>
      <input class="input" id="${prefix}-first" autocomplete="given-name" maxlength="60" value="${esc(n.first)}">
      <label class="field-label" for="${prefix}-last">Nume de familie</label>
      <input class="input" id="${prefix}-last" autocomplete="family-name" maxlength="60" value="${esc(n.last)}">
      ${m.first_name || m.last_name ? "" : `<p class="muted small">Prenumele și numele de familie sunt propuse din numele complet — verifică-le, se salvează așa.</p>`}`;
}

// „Contul meu”: the fields a member edits on themselves (server: members.updateOwn / profile.OWN_EDITABLE).
function openEditOwnModal(m, onSaved) {
  const modal = openModal(`
    <h3>Datele mele</h3>
    <form class="form" id="own-form">
      ${nameFields("own", m)}
      <label class="field-label">Email<input class="input" type="email" id="own-email" autocomplete="email" value="${esc(m.email || "")}"></label>
      <label class="field-label">Școală<input class="input" id="own-school" value="${esc(m.school || "")}"></label>
      <label class="field-label">Clasă<input class="input" id="own-class" value="${esc(m.class || "")}"></label>
      <p class="muted small">Numele se scrie „Prenume Nume”, cu majusculă doar la început. Telefonul, data nașterii și departamentul le schimbă un lider al echipei.</p>
      <button class="btn" type="submit" id="own-save">Salvează</button>
      <div class="form-error" id="own-error" role="alert"></div>
    </form>`);
  const el = modal.el;
  el.querySelector("#own-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = el.querySelector("#own-save");
    if (btn.disabled) return;
    btn.disabled = true;
    el.querySelector("#own-error").textContent = "";
    try {
      await api.patch("/api/members/me", {
        first_name: el.querySelector("#own-first").value.trim(),
        last_name: el.querySelector("#own-last").value.trim(),
        email: el.querySelector("#own-email").value.trim(),
        school: el.querySelector("#own-school").value.trim(),
        class: el.querySelector("#own-class").value.trim(),
      });
      modal.close();
      toast("Datele au fost salvate.", "success");
      onSaved();
    } catch (err) { el.querySelector("#own-error").textContent = err.message; }
    finally { btn.disabled = false; }
  });
}

function openChangePasswordModal(m) {
  const modal = openModal(`
    <h3>Schimbă parola</h3>
    <form class="form" id="cpw-form">
      <input type="text" autocomplete="username" value="${esc(m.username || "")}" hidden>
      <label class="field-label">Parola actuală<input class="input" type="password" id="cpw-current" autocomplete="current-password" required></label>
      <label class="field-label">Parola nouă (minim 8 caractere)<input class="input" type="password" id="cpw-new" autocomplete="new-password" minlength="8" required></label>
      <label class="field-label">Confirmă parola nouă<input class="input" type="password" id="cpw-confirm" autocomplete="new-password" required></label>
      <p class="muted small">După schimbare te conectezi din nou cu parola nouă (pe toate dispozitivele).</p>
      <button class="btn" type="submit" id="cpw-save">Schimbă parola</button>
      <div class="form-error" id="cpw-error" role="alert"></div>
    </form>`);
  const el = modal.el;
  el.querySelector("#cpw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = el.querySelector("#cpw-error");
    const current = el.querySelector("#cpw-current").value;
    const next = el.querySelector("#cpw-new").value;
    errEl.textContent = "";
    if (next !== el.querySelector("#cpw-confirm").value) { errEl.textContent = "Parolele nu coincid."; return; }
    const btn = el.querySelector("#cpw-save");
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      // The server checks the current password and the password rules (rules.passwordError).
      await api.post("/api/auth/change-password", { current_password: current, new_password: next });
      modal.close();
      toast("Parola a fost schimbată. Conectează-te cu parola nouă.", "success");
      setTimeout(() => { location.href = "/login"; }, 1500);
    } catch (err) { errEl.textContent = err.message; }
    finally { btn.disabled = false; }
  });
}

function renderInfo(m, canSeeContacts, isLeader) {
  const rows = m.first_name || m.last_name
    ? [["Prenume", esc(m.first_name || "—")], ["Nume de familie", esc(m.last_name || "—")]]
    : [["Nume", esc(m.name)]];
  if (canSeeContacts) {
    if (m.phone) rows.push(["Telefon", `<a href="tel:+${esc((m.phone || "").replace(/\D/g, ""))}">${esc(fmtPhone(m.phone))}</a> · <a href="https://wa.me/${esc((m.phone || "").replace(/\D/g, ""))}" target="_blank">WhatsApp</a>`]);
    if (m.email) rows.push(["Email", esc(m.email)]);
    if (m.birthdate) rows.push(["Data nașterii", fmtDate(m.birthdate)]);
    if (m.school) rows.push(["Școală", esc(m.school)]);
    if (m.class) rows.push(["Clasă", esc(m.class)]);
  }
  rows.push(["Membru din", m.joined_at ? fmtDate(m.joined_at) : "—"]);
  if ("last_seen_at" in m) rows.push(["Văzut ultima dată", fmtSeen(m.last_seen_at)]);
  if (m.left_at) rows.push(["Ieșit la", fmtDate(m.left_at)]);
  if (m.pause_until) rows.push(["Pauză până la", fmtDate(m.pause_until)]);
  if (isLeader && m.notes) rows.push(["Note (interne)", esc(m.notes)]);
  if (!rows.length) return emptyHtml("Nicio informație de contact vizibilă pentru tine.");
  return `<div class="card"><table class="kv-table">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("")}</table></div>`;
}

function renderTasks(tasks) {
  if (!tasks) return emptyHtml("Nu ai acces la taskurile acestui membru.");
  if (!tasks.length) return emptyHtml("Niciun task.");
  return `<div class="card"><div class="list">${tasks.map((t) => `
    <div class="list-item ${t.status === "done" ? "done" : ""}">
      <div class="list-item-main"><strong>${esc(t.title)}</strong></div>
      <div class="list-item-meta muted small">${t.due_date ? fmtDate(t.due_date) : ""} <span class="badge ${t.status === "done" ? "badge-ok" : ""}">${esc(TASK_STATUS_LABELS[t.status] || t.status)}</span></div>
    </div>`).join("")}</div></div>`;
}

async function loadGuardians(pane, id, canManage) {
  pane.innerHTML = loadingHtml();
  try {
    const guardians = await api.get(`/api/members/${id}/guardians`);
    pane.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>Părinți/tutori</h2>${canManage ? `<button class="btn btn-small" id="add-guardian-btn">+ Adaugă</button>` : ""}</div>
        ${guardians.length ? `<div class="list">${guardians.map((g) => `
          <div class="list-item" data-g-id="${g.id}">
            <div class="list-item-main"><strong>${esc(g.name)}</strong><span class="muted small">${esc(g.relation || "")}</span></div>
            <div class="list-item-meta">
              ${g.phone ? `<a href="tel:+${esc(g.phone.replace(/\D/g, ""))}" class="small">${esc(fmtPhone(g.phone))}</a>` : ""}
              ${canManage ? `<button class="btn-icon" data-del-guardian>&times;</button>` : ""}
            </div>
          </div>`).join("")}</div>` : emptyHtml("Niciun părinte/tutore înregistrat.")}
      </div>`;
    if (canManage) {
      document.getElementById("add-guardian-btn").addEventListener("click", () => openGuardianModal(id, () => { pane.dataset.loaded = ""; loadGuardians(pane, id, canManage); }));
      pane.querySelectorAll("[data-del-guardian]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!(await confirmDialog("Ștergi acest părinte/tutore?", { danger: true }))) return;
          const gid = btn.closest("[data-g-id]").dataset.gId;
          try { await api.del(`/api/guardians/${gid}`); pane.dataset.loaded = ""; loadGuardians(pane, id, canManage); }
          catch (e) { toast(e.message, "error"); }
        });
      });
    }
  } catch (e) { pane.innerHTML = errorHtml(e); }
}
function openGuardianModal(memberId, onSaved) {
  const modal = openModal(`
    <h3>Părinte/tutore nou</h3>
    <div class="form">
      <input class="input" id="g-name" aria-label="Nume" placeholder="Nume">
      <input class="input" id="g-relation" aria-label="Relație (ex: mamă, tată, tutore)" placeholder="Relație (ex: mamă, tată, tutore)">
      <input class="input" id="g-phone" aria-label="Telefon" placeholder="Telefon">
      <input class="input" id="g-email" aria-label="Email" placeholder="Email">
      <button class="btn" id="g-save">Salvează</button>
      <div class="form-error" id="g-error"></div>
    </div>`);
  busyOnClick(modal.el.querySelector("#g-save"), async () => {
    const errEl = modal.el.querySelector("#g-error");
    const name = modal.el.querySelector("#g-name").value.trim();
    if (!name) { errEl.textContent = "Numele e obligatoriu."; return; }
    try {
      await api.post(`/api/members/${memberId}/guardians`, {
        name,
        relation: modal.el.querySelector("#g-relation").value.trim() || undefined,
        phone: modal.el.querySelector("#g-phone").value.trim() || undefined,
        email: modal.el.querySelector("#g-email").value.trim() || undefined,
      });
      modal.close();
      onSaved();
    } catch (e) { errEl.textContent = e.message; }
  });
}

async function loadMemberAttendance(pane, id) {
  pane.innerHTML = loadingHtml();
  try {
    const stats = await api.get(`/api/attendance/stats?member_id=${id}`);
    pane.innerHTML = `
      <div class="card">
        <h2>Prezență — sezon ${esc(stats.season)}</h2>
        <div class="stats">
          <div class="stat"><span class="stat-value">${fmtPct(stats.pct)}</span><span class="stat-label">Procent</span></div>
          <div class="stat"><span class="stat-value">${stats.present}</span><span class="stat-label">Prezent</span></div>
          <div class="stat"><span class="stat-value">${stats.absent}</span><span class="stat-label">Absent</span></div>
          <div class="stat"><span class="stat-value">${stats.motivat}</span><span class="stat-label">Motivat</span></div>
        </div>
        ${stats.signals && stats.signals.length ? `<div class="signals">${stats.signals.map((s) => `<div class="signal-banner">${linkifyArticles(s.message)}</div>`).join("")}</div>` : ""}
      </div>`;
  } catch (e) { pane.innerHTML = errorHtml(e); }
}

async function loadMemberDocuments(pane, id, isLeader) {
  const user = currentUser();
  const isSelf = String(user.id) === String(id);
  if (!isLeader && !isSelf) { pane.innerHTML = emptyHtml("Nu ai acces la documentele acestui membru."); return; }
  pane.innerHTML = loadingHtml();
  try {
    let docs;
    if (isSelf) {
      docs = await api.get("/api/documents/me");
    } else {
      const matrix = await api.get("/api/documents/matrix");
      const row = matrix.find((r) => String(r.member_id) === String(id));
      docs = row ? row.documents.map((d) => ({ key: d.key, title: d.title, document: d.status === "lipsa" ? null : { status: d.status } })) : [];
    }
    pane.innerHTML = `<div class="card"><div class="list">${docs.map((d) => `
      <div class="list-item">
        <div class="list-item-main"><strong>${esc(d.title)}</strong></div>
        <div class="list-item-meta"><span class="badge ${!d.document ? "badge-warn" : d.document.status === "respins" ? "badge-danger" : ""}">${esc(DOC_STATUS_LABELS[d.document ? d.document.status : "lipsa"] || d.document.status)}</span></div>
      </div>`).join("")}</div></div>
      ${isSelf ? `<a href="/documente" data-link class="btn">Gestionează documentele mele</a>` : `<a href="/documente" data-link class="btn btn-ghost">Deschide matricea completă</a>`}`;
  } catch (e) { pane.innerHTML = errorHtml(e); }
}

async function loadWarnings(pane, id, isLeader) {
  pane.innerHTML = loadingHtml();
  try {
    const warnings = await api.get(`/api/warnings/member/${id}`);
    pane.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>Avertismente</h2>${isLeader ? `<button class="btn btn-small" id="add-warning-btn">+ Adaugă</button>` : ""}</div>
        ${warnings.length ? `<div class="list">${warnings.map((w) => `
          <div class="list-item">
            <div class="list-item-main"><strong>${esc(w.level)}</strong><span class="muted small">${esc(w.reason || "")}</span></div>
            <div class="list-item-meta muted small">${w.article ? esc(w.article) : ""} · ${fmtDate(w.created_at)}</div>
          </div>`).join("")}</div>` : emptyHtml("Niciun avertisment.")}
      </div>`;
    if (isLeader) {
      document.getElementById("add-warning-btn").addEventListener("click", () => openWarningModal(id, () => { pane.dataset.loaded = ""; loadWarnings(pane, id, isLeader); }));
    }
  } catch (e) { pane.innerHTML = errorHtml(e); }
}
function openWarningModal(memberId, onSaved) {
  const modal = openModal(`
    <h3>Avertisment nou (Art. 30.1)</h3>
    <div class="form">
      <select class="input" id="w-level" aria-label="Nivel avertisment">
        <option value="verbal">Avertisment verbal</option>
        <option value="scris">Avertisment scris</option>
        <option value="suspendare">Suspendare</option>
        <option value="excludere">Excludere</option>
      </select>
      <textarea class="input" id="w-reason" rows="3" aria-label="Motiv" placeholder="Motiv"></textarea>
      <button class="btn" id="w-save">Înregistrează</button>
      <div class="form-error" id="w-error"></div>
    </div>`);
  busyOnClick(modal.el.querySelector("#w-save"), async () => {
    try {
      await api.post("/api/warnings", { member_id: Number(memberId), level: modal.el.querySelector("#w-level").value, reason: modal.el.querySelector("#w-reason").value });
      modal.close();
      onSaved();
    } catch (e) { modal.el.querySelector("#w-error").textContent = e.message; }
  });
}

async function loadOnboarding(pane, id, isLeader) {
  pane.innerHTML = loadingHtml();
  try {
    const o = await api.get(`/api/onboarding/${id}`);
    pane.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>Integrare (Art. 43)</h2>
          <span class="badge ${o.status === "complet" ? "badge-ok" : o.overdue ? "badge-danger" : "badge-warn"}">${o.status === "complet" ? "Complet" : o.overdue ? "Depășit (30+ zile)" : "În curs"}</span>
        </div>
        <div class="list">${o.checklist.map((c) => `
          <div class="list-item">
            <div class="list-item-main">
              ${isLeader ? `<input type="checkbox" data-step-key="${esc(c.step_key)}" ${c.done ? "checked" : ""}>` : ""}
              <strong>${esc(c.label)}</strong>
            </div>
            <div class="list-item-meta muted small">${c.article ? esc(c.article) : ""}</div>
          </div>`).join("")}</div>
        ${isLeader ? `<div class="modal-actions-row" style="margin-top:12px">
          <button class="btn btn-ghost btn-small" id="ob-restart-btn">Repornește integrarea</button>
          ${o.status === "activ" ? `<button class="btn btn-ghost btn-small" id="ob-cancel-btn">Anulează</button>` : ""}
        </div>` : ""}
      </div>`;
    if (isLeader) {
      pane.querySelectorAll("[data-step-key]").forEach((cb) => {
        cb.addEventListener("change", async () => {
          cb.disabled = true;
          try { await api.post(`/api/onboarding/${id}/checklist/${cb.dataset.stepKey}`, { done: cb.checked }); toast("Checklist actualizat", "success"); }
          catch (e) { cb.checked = !cb.checked; toast(e.message, "error"); }
          finally { cb.disabled = false; }
        });
      });
      document.getElementById("ob-restart-btn").addEventListener("click", async () => {
        if (!(await confirmDialog("Repornești procesul de integrare de la zero?"))) return;
        try { await api.post(`/api/onboarding/${id}/restart`); toast("Integrare repornită", "success"); pane.dataset.loaded = ""; loadOnboarding(pane, id, isLeader); }
        catch (e) { toast(e.message, "error"); }
      });
      const cancelBtn = document.getElementById("ob-cancel-btn");
      if (cancelBtn) cancelBtn.addEventListener("click", async () => {
        if (!(await confirmDialog("Anulezi procesul de integrare?", { danger: true }))) return;
        try { await api.post(`/api/onboarding/${id}/cancel`); toast("Integrare anulată", "success"); pane.dataset.loaded = ""; loadOnboarding(pane, id, isLeader); }
        catch (e) { toast(e.message, "error"); }
      });
    }
  } catch (e) {
    pane.innerHTML = e.status === 404 ? emptyHtml("Niciun proces de integrare pentru acest membru.") : errorHtml(e);
  }
}

function openEditMemberModal(m, onSaved) {
  const modal = openModal(`
    <h3>Editează membru</h3>
    <div class="form">
      ${nameFields("em", m)}
      <input class="input" id="em-phone" value="${esc(m.phone || "")}" aria-label="Telefon" placeholder="Telefon">
      <input class="input" id="em-email" value="${esc(m.email || "")}" aria-label="Email" placeholder="Email">
      <select class="input" id="em-role" aria-label="Rol">${Object.entries(ROLE_NAMES).map(([k, v]) => `<option value="${k}" ${k === m.role ? "selected" : ""}>${v}</option>`).join("")}</select>
      <select class="input" id="em-dept" aria-label="Departament"><option value="">Departament</option>${Object.entries(DEPT_LABELS).map(([d, l]) => `<option value="${d}" ${m.department === d ? "selected" : ""}>${l}</option>`).join("")}</select>
      <input class="input" id="em-class" value="${esc(m.class || "")}" aria-label="Clasă" placeholder="Clasă">
      <input class="input" id="em-school" value="${esc(m.school || "")}" aria-label="Școală" placeholder="Școală">
      <input class="input" type="date" id="em-birthdate" value="${m.birthdate || ""}">
      <select class="input" id="em-status" aria-label="Status">${["activ", "pauza", "iesit", "alumni"].map((s) => `<option value="${s}" ${m.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      <input class="input" id="em-status-reason" aria-label="Motiv schimbare status (opțional)" placeholder="Motiv schimbare status (opțional)">
      <input class="input" type="date" id="em-pause-until" aria-label="Pauză până la" placeholder="Pauză până la" value="${m.pause_until || ""}">
      <textarea class="input" id="em-notes" rows="2" aria-label="Note interne" placeholder="Note interne">${esc(m.notes || "")}</textarea>
      <div class="modal-actions-row">
        <button class="btn" id="em-save">Salvează</button>
        <button class="btn btn-ghost" id="em-reset-pw">Resetează parola</button>
      </div>
      <div class="form-error" id="em-error"></div>
    </div>`);

  busyOnClick(modal.el.querySelector("#em-save"), async () => {
    const errEl = modal.el.querySelector("#em-error");
    errEl.textContent = "";
    const body = {
      first_name: modal.el.querySelector("#em-first").value.trim(),
      last_name: modal.el.querySelector("#em-last").value.trim(),
      phone: modal.el.querySelector("#em-phone").value.trim() || undefined,
      email: modal.el.querySelector("#em-email").value.trim() || undefined,
      role: modal.el.querySelector("#em-role").value,
      department: modal.el.querySelector("#em-dept").value || undefined,
      class: modal.el.querySelector("#em-class").value.trim() || undefined,
      school: modal.el.querySelector("#em-school").value.trim() || undefined,
      birthdate: modal.el.querySelector("#em-birthdate").value || undefined,
      notes: modal.el.querySelector("#em-notes").value.trim() || undefined,
    };
    try {
      await api.put(`/api/admin/members/${m.id}`, body);
      const newStatus = modal.el.querySelector("#em-status").value;
      if (newStatus !== m.status) {
        await api.post(`/api/admin/members/${m.id}/status`, {
          status: newStatus,
          reason: modal.el.querySelector("#em-status-reason").value.trim() || undefined,
          pause_until: newStatus === "pauza" ? (modal.el.querySelector("#em-pause-until").value || undefined) : undefined,
        });
      }
      toast("Membru actualizat", "success");
      modal.close();
      onSaved();
    } catch (e) { errEl.textContent = e.message; }
  });

  busyOnClick(modal.el.querySelector("#em-reset-pw"), async () => {
    if (!(await confirmDialog("Resetezi parola acestui membru?"))) return;
    try {
      const res = await api.post(`/api/admin/members/${m.id}/reset-password`);
      await showOneTimePassword({ title: "Parolă resetată", intro: m.name, username: m.username, password: res.password });
    } catch (e) { toast(e.message, "error"); }
  });
}
