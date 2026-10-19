import { api } from "../api.js";
import { esc, fmtDate, loadingHtml, errorHtml, emptyHtml, toast, openModal, confirmDialog, busyOnClick, todayLocal } from "../ui.js";
import { currentUser, can } from "../app.js";

// Reminder time (docs/design-meniu-v2.md §2): typed and shown in Europe/Bucharest, stored as ISO UTC.
const TZ = "Europe/Bucharest";
function toLocalInput(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(" ", "T");
}
function fmtRemind(iso) {
  return new Date(iso).toLocaleString("ro-RO", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export async function mountTaskuri(container) {
  const user = currentUser();
  const isManager = can("tasks.assign"); // the assignee picker
  container.innerHTML = `
    <div class="container">
      <div class="page-header"><h1>Taskuri</h1><button class="btn" id="new-task-btn">+ Task nou</button></div>
      <div class="filters" id="task-filters">
        <button class="filter-btn active" data-filter="mine">Ale mele</button>
        <button class="filter-btn" data-filter="all">Toate</button>
      </div>
      <div id="task-teme"></div>
      <div id="task-list">${loadingHtml()}</div>
    </div>`;

  let members = [];
  if (isManager) { try { members = await api.get("/api/members"); } catch (e) {} }

  let mode = "mine";
  const listEl = document.getElementById("task-list");
  async function load() {
    listEl.innerHTML = loadingHtml();
    try {
      const tasks = await api.get(`/api/tasks${mode === "mine" ? "?mine=1" : ""}`);
      renderTasks(listEl, tasks, user, isManager, members, load);
    } catch (e) { listEl.innerHTML = errorHtml(e); }
  }
  document.querySelectorAll("#task-filters [data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#task-filters [data-filter]").forEach((b) => b.classList.toggle("active", b === btn));
      mode = btn.dataset.filter;
      load();
    });
  });
  await load();

  api.get("/api/assignments/my-todos").then((todos) => {
    if (!todos.length) return;
    document.getElementById("task-teme").innerHTML = `<div class="card"><div class="card-header"><h3>Din teme de grup</h3></div><div class="list">
      ${todos.map((t) => `<a class="list-item" href="/teme/${t.assignment_id}" data-link><div class="list-item-main"><strong>${esc(t.text)}</strong>
      <span class="muted small">${esc(t.assignment_title)}</span></div><div class="list-item-meta">${t.due_at ? `<span class="muted small">${esc(fmtDate(t.due_at))}</span>` : ""}</div></a>`).join("")}
    </div></div>`;
  }).catch(() => {});

  document.getElementById("new-task-btn").addEventListener("click", () => openTaskModal(null, members, isManager, load));
}

function renderTasks(listEl, tasks, user, isManager, members, reload) {
  if (!tasks.length) { listEl.innerHTML = emptyHtml("Niciun task."); return; }
  const pending = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");
  listEl.innerHTML = `<div class="card"><div class="list">
    ${[...pending, ...done].map((t) => taskRow(t, user, isManager)).join("")}
  </div></div>`;
  listEl.querySelectorAll("[data-task-id]").forEach((row) => {
    const id = row.dataset.taskId;
    const task = tasks.find((t) => String(t.id) === id);
    row.querySelector("[data-toggle]").addEventListener("change", async (e) => {
      try { await api.patch(`/api/tasks/${id}`, { status: e.target.checked ? "done" : "pending" }); toast("Task actualizat", "success"); row.classList.toggle("done", e.target.checked); }
      catch (err) { e.target.checked = !e.target.checked; toast(err.message, "error"); }
    });
    row.querySelector("[data-edit]")?.addEventListener("click", () => openTaskModal(task, members, isManager, reload));
    row.querySelector("[data-del]")?.addEventListener("click", async () => {
      if (!(await confirmDialog("Ștergi acest task?", { danger: true }))) return;
      try { await api.del(`/api/tasks/${id}`); toast("Task șters", "success"); reload(); }
      catch (err) { toast(err.message, "error"); }
    });
  });
}

function taskRow(t, user, isManager) {
  // No PATCH-status check in UI: status toggle is always sent, server enforces owner/assignee/MANAGERS.
  // Full edit (PUT): MANAGERS, or the creator of a task made for themselves; delete: MANAGERS or the assignee.
  const canDelete = !!t.can_delete; // from the server (policy tasks.delete)
  const canEdit = !!t.can_edit; // from the server (policy tasks.edit)
  return `<div class="list-item ${t.status === "done" ? "done" : ""}" data-task-id="${t.id}">
    <div class="list-item-main">
      <label class="check-hit"><input type="checkbox" data-toggle ${t.status === "done" ? "checked" : ""} aria-label="Finalizat: ${esc(t.title)}"></label>
      <strong>${esc(t.title)}</strong>
    </div>
    <div class="list-item-meta">
      ${t.remind_at ? `<span class="muted small task-reminder" title="${t.reminded ? "Reminder trimis" : "Reminder"}">🔔 ${esc(fmtRemind(t.remind_at))}${t.reminded ? " ✓" : ""}</span>` : ""}
      ${t.due_date ? `<span class="muted small">${esc(fmtDate(t.due_date))}</span>` : ""}
      ${t.assigned_name ? `<span class="badge">${esc(t.assigned_name)}</span>` : ""}
      ${canEdit ? `<button class="btn-icon" data-edit title="Editează" aria-label="Editează taskul ${esc(t.title)}">✎</button>` : ""}
      ${canDelete ? `<button class="btn-icon" data-del title="Șterge" aria-label="Șterge taskul ${esc(t.title)}">&times;</button>` : ""}
    </div>
  </div>`;
}

function openTaskModal(task, members, isManager, onSaved) {
  const me = currentUser(); // listed once, as „Pentru mine”
  const modal = openModal(`
    <h3>${task ? "Editează task" : "Task nou"}</h3>
    <div class="form">
      <label class="field-label">Titlu<input class="input" id="tk-title" value="${task ? esc(task.title) : ""}"></label>
      <label class="field-label">Termen (opțional)<input class="input" type="date" id="tk-due" value="${task && task.due_date ? esc(task.due_date) : ""}"></label>
      <label class="field-label">Amintește-mi la (opțional)<input class="input" type="datetime-local" id="tk-remind" value="${task ? esc(toLocalInput(task.remind_at)) : ""}"></label>
      <p class="form-warning" id="tk-remind-warn" role="status"></p>
      ${isManager ? `<label class="field-label">Pentru<select class="input" id="tk-assignee"><option value="${me.id}">Pentru mine</option>${members.filter((m) => m.id !== me.id).map((m) => `<option value="${m.id}" ${task && task.assigned_member_id === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>` : ""}
      <button class="btn" id="tk-save">${task ? "Salvează" : "Creează"}</button>
      <div class="form-error" id="tk-error"></div>
    </div>`);
  // A reminder in the past would never be sent: warn while typing, refuse on save (only if the time was changed).
  const remindEl = modal.el.querySelector("#tk-remind");
  const original = remindEl.value;
  const remindInPast = () => remindEl.value && remindEl.value !== original && remindEl.value < toLocalInput(new Date().toISOString());
  const syncWarn = () => { modal.el.querySelector("#tk-remind-warn").textContent = remindInPast() ? "Ora reminderului e în trecut — alege o oră din viitor." : ""; };
  remindEl.addEventListener("input", syncWarn);
  remindEl.addEventListener("change", syncWarn);
  busyOnClick(modal.el.querySelector("#tk-save"), async () => {
    const errEl = modal.el.querySelector("#tk-error");
    const title = modal.el.querySelector("#tk-title").value.trim();
    if (!title) { errEl.textContent = "Titlul e obligatoriu."; return; }
    const remind = remindEl.value;
    if (remindInPast()) { syncWarn(); remindEl.focus(); return; } // the warning under the field says why
    const body = { title, due_date: modal.el.querySelector("#tk-due").value || undefined };
    if (remind) body.remind_at = remind; // local Bucharest time, the server stores UTC
    else if (task && task.remind_at) body.remind_at = null;
    const assigneeEl = modal.el.querySelector("#tk-assignee");
    if (assigneeEl && assigneeEl.value) body.assigned_member_id = Number(assigneeEl.value);
    try {
      if (task) await api.put(`/api/tasks/${task.id}`, body);
      else await api.post("/api/tasks", body);
      toast("Task salvat", "success");
      modal.close();
      onSaved();
    } catch (e) { errEl.textContent = e.message; }
  });
}
