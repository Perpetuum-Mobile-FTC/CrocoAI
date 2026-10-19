import { api } from "../api.js";
import { esc, fmtDateTime, loadingHtml, errorHtml, emptyHtml, toast, openModal, confirmDialog, busyOnClick, fileField } from "../ui.js";
import { navigate } from "../router.js";
import { can } from "../app.js";
import { DEPT_LABELS } from "./membri-labels.js";

const STATUS = { de_facut: ["De făcut", ""], predat: ["Predat", "badge-warn"], de_refacut: ["De refăcut", "badge-danger"], acceptat: ["Acceptat", "badge-ok"] };
const statusBadge = (s) => { const [l, c] = STATUS[s] || [s, ""]; return `<span class="badge ${c}">${esc(l)}</span>`; };
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function dueHtml(a) {
  if (!a.due_at) return `<span class="muted small">fără termen</span>`;
  const over = a.status === "activa" && new Date(a.due_at) < new Date();
  return over ? `<span class="badge badge-danger">Termen depășit: ${esc(fmtDateTime(a.due_at))}</span>`
    : `<span class="muted small">Termen: ${esc(fmtDateTime(a.due_at))}</span>`;
}

function progressHtml(p) {
  return `<span class="muted small">${p.acceptat} acceptate · ${p.predat} de verificat · ${p.de_facut + p.de_refacut} nepredate (din ${p.total})</span>`;
}

export async function mountTeme(container) {
  container.innerHTML = `<div class="container">
    <div class="page-header"><h1>Teme</h1><div class="page-header-actions" id="teme-actions"></div></div>
    <div class="filters" id="teme-filters">
      <button class="filter-btn active" data-scope="mine" data-status="activa">De făcut</button>
      <button class="filter-btn" data-scope="mine" data-status="inchisa">Arhivă</button>
    </div>
    <div id="teme-list">${loadingHtml()}</div></div>`;
  let targets = { departments: [], groups: [] };
  let toReview = [];
  // „De verificat”: the server returns exactly what this user may review (same list as the Acasă card).
  const [t, r] = await Promise.allSettled([api.get("/api/assignments/targets"), api.get("/api/assignments?scope=review")]);
  if (t.status === "fulfilled") targets = t.value;
  if (r.status === "fulfilled") toReview = r.value;
  const wantReview = new URLSearchParams(location.search).get("filtru") === "de-verificat";
  if (toReview.length || wantReview) {
    const waiting = toReview.reduce((n, a) => n + (a.waiting || 0), 0);
    document.getElementById("teme-filters").insertAdjacentHTML("beforeend",
      `<button class="filter-btn" data-scope="review" data-status="">De verificat${waiting ? ` (${waiting})` : ""}</button>`);
  }
  if (targets.departments.length || targets.groups.length) {
    document.getElementById("teme-filters").insertAdjacentHTML("beforeend", `<button class="filter-btn" data-scope="given" data-status="">Date de mine</button>`);
    document.getElementById("teme-actions").innerHTML = `<button class="btn" id="new-tema-btn">+ Temă nouă</button>`;
    document.getElementById("new-tema-btn").addEventListener("click", () => openCreateModal(targets));
  }
  if (can("assignments.view_dept")) { // a department head
    document.getElementById("teme-filters").insertAdjacentHTML("beforeend", `<button class="filter-btn" data-scope="all" data-status="">Departamentul meu</button>`);
  }
  const listEl = document.getElementById("teme-list");
  let filter = { scope: "mine", status: "activa" };
  const setActive = (scope, status) => {
    filter = { scope, status };
    document.querySelectorAll("#teme-filters [data-scope]").forEach((b) => b.classList.toggle("active", b.dataset.scope === scope && b.dataset.status === status));
  };
  async function load(first) {
    listEl.innerHTML = loadingHtml();
    try {
      const items = await api.get(`/api/assignments?${new URLSearchParams(filter)}`);
      // Someone who can give assignments usually has none to do: land on "Date de mine" instead of an empty list.
      if (first && !items.length && filter.scope === "mine" && (targets.departments.length || targets.groups.length)) {
        setActive("given", "");
        return load();
      }
      if (!items.length) { listEl.innerHTML = emptyHtml(filter.scope === "given" ? "N-ai dat încă nicio temă." : filter.scope === "review" ? "Nicio predare de verificat." : "Nicio temă aici."); return; }
      listEl.innerHTML = `<div class="card"><div class="list">${items.map((a) => `
        <a class="list-item" href="/teme/${a.id}" data-link>
          <div class="list-item-main"><strong>${esc(a.title)}</strong><span class="muted small">${esc(a.target_label)}${a.mode === "grup" ? " · de grup" : ""}</span></div>
          <div class="list-item-meta">${dueHtml(a)}
            ${a.waiting ? `<span class="badge badge-warn">${a.waiting === 1 ? "1 predare de verificat" : `${a.waiting} predări de verificat`}</span>` : ""}
            ${a.my_submission && filter.scope === "mine" ? statusBadge(a.my_submission.status) : ""}
            ${a.progress && (filter.scope === "given" || filter.scope === "all") ? progressHtml(a.progress) : ""}
            ${a.status === "inchisa" ? `<span class="badge">Închisă</span>` : ""}</div>
        </a>`).join("")}</div></div>`;
    } catch (e) {
      listEl.innerHTML = errorHtml(e);
      listEl.querySelector("[data-retry]")?.addEventListener("click", load);
    }
  }
  document.getElementById("teme-filters").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-scope]");
    if (!btn) return;
    setActive(btn.dataset.scope, btn.dataset.status);
    // Keep the filter in the URL so „Înapoi” from an assignment returns to it.
    const q = new URLSearchParams(location.search);
    if (btn.dataset.scope === "review") q.set("filtru", "de-verificat"); else q.delete("filtru");
    history.replaceState({}, "", `${location.pathname}${q.toString() ? `?${q}` : ""}`);
    load();
  });
  if (wantReview) setActive("review", "");
  await load(!wantReview);
}

function openCreateModal(targets) {
  const DEPT = Object.fromEntries(Object.entries(DEPT_LABELS).map(([k, v]) => [k, `Departament ${v}`]));
  const modal = openModal(`
    <h3>Temă nouă</h3>
    <div class="form">
      <input class="input" id="t-title" aria-label="Titlu" placeholder="Titlu">
      <textarea class="input" id="t-desc" rows="4" aria-label="Descriere / cerințe" placeholder="Descriere / cerințe"></textarea>
      <label class="field-label">Termen <input class="input" type="datetime-local" id="t-due"></label>
      <label class="field-label">Tip<select class="input" id="t-mode">
        <option value="individual">Individuală — fiecare predă lucrarea lui</option>
        <option value="grup">De grup — o lucrare comună</option>
      </select></label>
      <label class="field-label">Pentru<select class="input" id="t-target">
        ${targets.departments.map((d) => `<option value="departament:${d}" data-kind="departament">${esc(DEPT[d] || d)}</option>`).join("")}
        ${targets.groups.map((g) => `<option value="grup:${g.id}" data-kind="grup">Grupul ${esc(g.name)}</option>`).join("")}
      </select></label>
      <textarea class="input" id="t-todos" rows="3" aria-label="To-do (câte un punct pe rând, opțional)" placeholder="To-do (câte un punct pe rând, opțional)"></textarea>
      <div class="field-label">Materiale (opțional, max 25 MB/fișier) ${fileField("t-files", { multiple: true, label: "Alege fișiere" })}</div>
      <button class="btn" id="t-save">Creează tema</button>
    </div>`);
  const el = modal.el;
  const syncTargets = () => {
    const grupMode = el.querySelector("#t-mode").value === "grup";
    el.querySelectorAll('#t-target option[data-kind="departament"]').forEach((o) => { o.disabled = grupMode; });
    const sel = el.querySelector("#t-target");
    if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) {
      const first = [...sel.options].find((o) => !o.disabled);
      sel.value = first ? first.value : "";
    }
  };
  el.querySelector("#t-mode").addEventListener("change", syncTargets);
  busyOnClick(el.querySelector("#t-save"), async () => {
    const [target_type, target] = (el.querySelector("#t-target").value || ":").split(":");
    const due = el.querySelector("#t-due").value;
    if (due && new Date(due) < new Date()) { toast("Termenul e în trecut.", "error"); return; }
    const picked = [...el.querySelector("#t-files").files];
    if (picked.some((f) => f.size > 25 * 1048576)) { toast("Fișier prea mare (max 25 MB).", "error"); return; }
    if (picked.reduce((n, f) => n + f.size, 0) > 90 * 1048576) { toast("Materialele depășesc 90 MB în total — încarcă mai puține odată.", "error"); return; }
    const fd = new FormData();
    fd.append("title", el.querySelector("#t-title").value);
    fd.append("description", el.querySelector("#t-desc").value);
    if (due) fd.append("due_at", new Date(due).toISOString());
    fd.append("mode", el.querySelector("#t-mode").value);
    fd.append("target_type", target_type);
    fd.append(target_type === "grup" ? "target_team_id" : "target_dept", target);
    fd.append("todos", JSON.stringify(el.querySelector("#t-todos").value.split("\n")));
    for (const f of picked) fd.append("materials", f);
    try {
      const a = await api.upload("/api/assignments", fd);
      toast("Tema a fost dată", "success");
      modal.close();
      navigate(`/teme/${a.id}`);
    } catch (e) { toast(e.message, "error"); }
  });
}

export async function mountTema(container, id) {
  container.innerHTML = `<div class="container">${loadingHtml()}</div>`;
  let a;
  try { a = await api.get(`/api/assignments/${id}`); } catch (e) {
    container.innerHTML = `<div class="container">${errorHtml(e)}</div>`;
    container.querySelector("[data-retry]")?.addEventListener("click", () => mountTema(container, id));
    return;
  }
  let groupMembers = [];
  if (a.mode === "grup" && a.target_team_id && a.my_submission) {
    try { groupMembers = (await api.get(`/api/groups/${a.target_team_id}`)).members; } catch {}
  }
  const reload = () => mountTema(container, id);
  container.innerHTML = `<div class="container">
    <div class="page-header"><h1>${esc(a.title)}</h1>
      ${a.can_manage ? `<div class="page-header-actions">
        ${a.mode === "individual" && a.status === "activa" ? `<button class="btn btn-ghost btn-small" id="t-addnew">Adaugă membrii noi</button>` : ""}
        <button class="btn btn-ghost btn-small" id="t-edit">Editează</button>
        ${a.status === "activa" ? `<button class="btn btn-ghost btn-small" id="t-close">Închide tema</button>` : ""}
        <button class="btn btn-danger btn-small" id="t-del">Șterge</button></div>` : ""}</div>
    <div class="card">
      <p class="muted small">${esc(a.target_label)} · ${a.mode === "grup" ? "temă de grup" : "individuală"} · dată de ${esc(a.created_by_name || "")} ${a.status === "inchisa" ? `· <span class="badge">Închisă</span>` : ""}</p>
      <p>${dueHtml(a)}</p>
      ${a.description ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(a.description)}</p>` : ""}
      ${a.materials.length ? `<div class="field-label">Materiale</div><ul class="plain-list">${a.materials.map((m) => `<li><a href="/api/assignments/${a.id}/materials/${m.id}" download>${esc(m.filename)}</a> <span class="muted small">${fmtSize(m.size)}</span></li>`).join("")}</ul>` : ""}
    </div>
    <div id="t-mine"></div>
    <div id="t-subs"></div></div>`;

  if (a.my_submission) renderMine(document.getElementById("t-mine"), a, a.my_submission, groupMembers, reload);
  if (a.submissions) renderSubmissions(document.getElementById("t-subs"), a, reload);

  document.getElementById("t-close")?.addEventListener("click", async () => {
    if (!(await confirmDialog("Închizi tema? Nu se mai pot face predări."))) return;
    try { await api.post(`/api/assignments/${a.id}/close`); toast("Temă închisă", "success"); reload(); } catch (e) { toast(e.message, "error"); }
  });
  document.getElementById("t-del")?.addEventListener("click", async () => {
    if (!(await confirmDialog("Ștergi tema definitiv? Se pierd și ciornele nepredate ale membrilor.", { danger: true }))) return;
    try { await api.del(`/api/assignments/${a.id}`); toast("Temă ștearsă", "success"); navigate("/teme"); } catch (e) { toast(e.message, "error"); }
  });
  document.getElementById("t-edit")?.addEventListener("click", () => openEditModal(a, reload));
  document.getElementById("t-addnew")?.addEventListener("click", async () => {
    try { const r = await api.post(`/api/assignments/${a.id}/add-new-members`); toast(r.added ? `Adăugați: ${r.added}` : "Niciun membru nou", "success"); reload(); } catch (e) { toast(e.message, "error"); }
  });
}

// <input type="datetime-local"> wants local "YYYY-MM-DDTHH:mm".
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openEditModal(a, reload) {
  const modal = openModal(`
    <h3>Editează tema</h3>
    <div class="form">
      <input class="input" id="e-title" aria-label="Titlu" placeholder="Titlu" value="${esc(a.title)}">
      <textarea class="input" id="e-desc" rows="4" aria-label="Descriere / cerințe" placeholder="Descriere / cerințe">${esc(a.description || "")}</textarea>
      <label class="field-label">Termen <input class="input" type="datetime-local" id="e-due" value="${esc(toLocalInput(a.due_at))}"></label>
      <button class="btn" id="e-save">Salvează</button>
    </div>`);
  const el = modal.el;
  busyOnClick(el.querySelector("#e-save"), async () => {
    const due = el.querySelector("#e-due").value;
    try {
      await api.patch(`/api/assignments/${a.id}`, {
        title: el.querySelector("#e-title").value,
        description: el.querySelector("#e-desc").value,
        due_at: due ? new Date(due).toISOString() : "",
      });
      toast("Temă actualizată", "success");
      modal.close();
      reload();
    } catch (e) { toast(e.message, "error"); }
  });
}

function filesByVersion(sub, editable, subId) {
  if (!sub.files.length) return `<p class="muted small">Niciun fișier încă.</p>`;
  const versions = [...new Set(sub.files.map((f) => f.version))];
  return versions.map((v) => `
    <div class="field-label">${v > sub.current_version ? "Ciornă (nepredată)" : `Versiunea ${v}`}</div>
    <ul class="plain-list">${sub.files.filter((f) => f.version === v).map((f) => `
      <li><a href="/api/submissions/${subId}/files/${f.id}" download>${esc(f.filename)}</a>
        <span class="muted small">${fmtSize(f.size)} · ${esc(f.uploaded_by_name || "")}</span>
        ${editable && v > sub.current_version ? `<button class="btn-icon" data-delfile="${f.id}" title="Șterge" aria-label="Șterge ${esc(f.filename)}">&times;</button>` : ""}</li>`).join("")}</ul>`).join("");
}

function renderMine(el, a, sub, groupMembers, reload) {
  const editable = a.status === "activa" && (sub.status === "de_facut" || sub.status === "de_refacut");
  const submitted = a.status === "activa" && sub.status === "predat";
  el.innerHTML = `<div class="card">
    <div class="card-header"><h3>${a.mode === "grup" ? "Lucrarea grupului" : "Lucrarea mea"}</h3>${statusBadge(sub.status)}</div>
    ${sub.review_comment ? `<div class="card-warning">Comentariu: ${esc(sub.review_comment)}</div>` : ""}
    ${sub.late ? `<p><span class="badge badge-warn">Predat după termen</span></p>` : ""}
    ${sub.todos.length ? `<div class="checkbox-list">${sub.todos.map((t) => `
      <label class="checkbox-row">
        <input type="checkbox" data-todo="${t.todo_id}" ${t.done ? "checked" : ""} ${editable ? "" : "disabled"}>
        <span>${esc(t.text)} ${t.done && t.done_by_name && a.mode === "grup" ? `<span class="muted small">(${esc(t.done_by_name)})</span>` : ""}</span>
        ${a.mode === "grup" ? `<select class="input input-small" aria-label="Cine face punctul" data-assignee="${t.todo_id}" ${editable ? "" : "disabled"}>
          <option value="">— oricine —</option>
          ${groupMembers.map((m) => `<option value="${m.id}" ${t.assignee_member_id === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
        </select>` : ""}
      </label>`).join("")}</div>` : ""}
    ${filesByVersion(sub, editable, sub.id)}
    ${editable || submitted ? `<div class="upload-drop" id="t-drop">${submitted ? "Ai uitat ceva? Adaugă fișiere la predare: trage-le aici" : "Trage fișierele aici"} sau <label class="file-upload-btn text-link">alege fișiere<input type="file" id="t-upload" multiple class="sr-only"></label> (max 25 MB/fișier)</div>` : ""}
    ${editable ? `<button class="btn" id="t-submit">Predau</button>` : ""}
    ${submitted ? `<button class="btn btn-ghost" id="t-unsubmit">Anulez predarea</button>` : ""}
  </div>`;

  el.querySelectorAll("[data-todo]").forEach((cb) => cb.addEventListener("change", async () => {
    try { await api.patch(`/api/submissions/${sub.id}/todos/${cb.dataset.todo}`, { done: cb.checked }); }
    catch (e) { cb.checked = !cb.checked; toast(e.message, "error"); }
  }));
  el.querySelectorAll("[data-assignee]").forEach((sel) => sel.addEventListener("change", async () => {
    try { await api.patch(`/api/submissions/${sub.id}/todos/${sel.dataset.assignee}`, { assignee_member_id: sel.value ? Number(sel.value) : null }); toast("Punct asignat", "success"); }
    catch (e) { toast(e.message, "error"); reload(); }
  }));
  el.querySelectorAll("[data-delfile]").forEach((b) => b.addEventListener("click", async () => {
    try { await api.del(`/api/submissions/${sub.id}/files/${b.dataset.delfile}`); reload(); } catch (e) { toast(e.message, "error"); }
  }));
  const upload = async (fileList) => {
    const picked = [...fileList]; // FileList can be emptied once the input resets
    if (!picked.length) return;
    // One file per request: the Cloudflare tunnel caps a single request at 100 MB.
    try {
      for (const f of picked) {
        const fd = new FormData();
        fd.append("files", f);
        await api.upload(`/api/submissions/${sub.id}/files`, fd);
      }
      toast("Fișiere încărcate", "success");
    } catch (e) { toast(e.message, "error"); }
    reload();
  };
  el.querySelector("#t-upload")?.addEventListener("change", (e) => upload(e.target.files));
  const drop = el.querySelector("#t-drop");
  if (drop) {
    drop.addEventListener("dragover", (e) => { e.preventDefault(); });
    drop.addEventListener("drop", (e) => { e.preventDefault(); upload(e.dataTransfer.files); });
  }
  const submitBtn = el.querySelector("#t-submit");
  if (submitBtn) busyOnClick(submitBtn, async () => {
    try { await api.post(`/api/submissions/${sub.id}/submit`); toast("Predat!", "success"); reload(); } catch (e) { toast(e.message, "error"); }
  });
  const unsubmitBtn = el.querySelector("#t-unsubmit");
  if (unsubmitBtn) busyOnClick(unsubmitBtn, async () => {
    if (!(await confirmDialog("Anulezi predarea? Lucrarea redevine ciornă: poți șterge sau adăuga fișiere, apoi predai din nou."))) return;
    try { await api.post(`/api/submissions/${sub.id}/unsubmit`); toast("Predare anulată", "success"); reload(); } catch (e) { toast(e.message, "error"); }
  });
}

function renderSubmissions(el, a, reload) {
  el.innerHTML = `<div class="card">
    <div class="card-header"><h3>Predări</h3>${progressHtml(a.progress)}</div>
    <div class="table-scroll"><table class="data-table stack-table">
      <thead><tr><th>${a.mode === "grup" ? "Grup" : "Membru"}</th><th>Status</th><th>Predat</th><th>Fișiere</th><th></th></tr></thead>
      <tbody>${a.submissions.map((s) => `<tr>
        <td data-label="${a.mode === "grup" ? "Grup" : "Membru"}">${esc(s.member_name || a.target_label)}</td>
        <td data-label="Status">${statusBadge(s.status)}</td>
        <td data-label="Predat">${s.submitted_at ? esc(fmtDateTime(s.submitted_at)) : "—"} ${s.late ? `<span class="badge badge-warn">Întârziat</span>` : ""}</td>
        <td data-label="Fișiere">${s.files.length}</td>
        <td class="stack-action"><button class="btn btn-small ${s.status === "predat" ? "" : "btn-ghost"}" data-open="${s.id}">${s.status === "predat" && a.can_review ? "Verifică" : "Vezi"}</button></td>
      </tr>`).join("")}</tbody></table></div></div>`;
  el.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
    openReviewModal(a, a.submissions.find((s) => String(s.id) === b.dataset.open), reload);
  }));
}

function openReviewModal(a, sub, reload) {
  const canReview = a.can_review && sub.status === "predat";
  const modal = openModal(`
    <h3>${esc(sub.member_name || a.target_label)} ${statusBadge(sub.status)}</h3>
    ${sub.todos.length ? `<ul class="plain-list">${sub.todos.map((t) => `<li>${t.done ? "☑" : "☐"} ${esc(t.text)}</li>`).join("")}</ul>` : ""}
    ${filesByVersion(sub, false, sub.id)}
    ${sub.review_comment ? `<p class="muted">Ultimul comentariu: ${esc(sub.review_comment)}</p>` : ""}
    ${canReview ? `<div class="form">
      <textarea class="input" id="r-comment" rows="3" aria-label="Comentariu (obligatoriu la „De refăcut”)" placeholder="Comentariu (obligatoriu la „De refăcut”)"></textarea>
      <div class="modal-actions-row">
        <button class="btn btn-danger" id="r-redo">De refăcut</button>
        <button class="btn" id="r-ok">Acceptat</button>
      </div></div>` : ""}`);
  const decide = (decision) => async () => {
    try {
      await api.post(`/api/submissions/${sub.id}/review`, { decision, comment: modal.el.querySelector("#r-comment").value });
      toast("Verificare salvată", "success");
      modal.close();
      reload();
    } catch (e) { toast(e.message, "error"); }
  };
  if (canReview) {
    busyOnClick(modal.el.querySelector("#r-ok"), decide("acceptat"));
    busyOnClick(modal.el.querySelector("#r-redo"), decide("de_refacut"));
  }
}
