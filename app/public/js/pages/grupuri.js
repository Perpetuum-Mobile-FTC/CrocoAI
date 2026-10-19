import { api } from "../api.js";
import { esc, loadingHtml, errorHtml, emptyHtml, toast, openModal, confirmDialog, busyOnClick } from "../ui.js";

import { DEPT_LABELS } from "./membri-labels.js";

const DEPT = { ...DEPT_LABELS, mixt: "Mixt" };

export async function mountGrupuri(container) {
  // Departments the user may create groups in: policy groups.manage, from the server.
  let depts = [];
  try { depts = (await api.get("/api/groups/departments")).departments; } catch { /* no "+ Grup nou" button */ }
  container.innerHTML = `<div class="container">
    <div class="page-header"><h1>Grupuri</h1>${depts.length ? `<button class="btn" id="new-group-btn">+ Grup nou</button>` : ""}</div>
    <div id="group-list">${loadingHtml()}</div></div>`;
  let members = [];
  try { members = (await api.get("/api/members")).filter((m) => m.status === "activ"); } catch (e) { toast(`Nu am putut încărca membrii: ${e.message}`, "error"); }
  const listEl = document.getElementById("group-list");

  async function load() {
    listEl.innerHTML = loadingHtml();
    try {
      const groups = await api.get("/api/groups");
      if (!groups.length) { listEl.innerHTML = emptyHtml("Niciun grup încă."); return; }
      listEl.innerHTML = groups.map((g) => `
        <div class="card" data-group="${g.id}">
          <div class="card-header"><h3>${esc(g.name)} <span class="badge">${esc(DEPT[g.department] || g.department)}</span></h3>
            ${g.can_manage ? `<div><button class="btn btn-small btn-ghost" data-edit>Editează</button> <button class="btn btn-small btn-danger" data-del>Șterge</button></div>` : ""}</div>
          ${g.description ? `<p class="muted">${esc(g.description)}</p>` : ""}
          <div class="tag-list">${g.members.map((m) => `<span class="tag-chip">${m.role === "leader" ? "★ " : ""}${esc(m.name)}</span>`).join("") || `<span class="muted small">Fără membri</span>`}</div>
        </div>`).join("");
      listEl.querySelectorAll("[data-group]").forEach((card) => {
        const g = groups.find((x) => String(x.id) === card.dataset.group);
        card.querySelector("[data-edit]")?.addEventListener("click", () => openGroupModal(g, depts, members, load));
        card.querySelector("[data-del]")?.addEventListener("click", async () => {
          if (!(await confirmDialog(`Ștergi grupul „${g.name}”? Temele lui rămân în arhivă.`, { danger: true }))) return;
          try { await api.del(`/api/groups/${g.id}`); toast("Grup șters", "success"); load(); } catch (e) { toast(e.message, "error"); }
        });
      });
    } catch (e) {
      listEl.innerHTML = errorHtml(e);
      listEl.querySelector("[data-retry]")?.addEventListener("click", load);
    }
  }
  document.getElementById("new-group-btn")?.addEventListener("click", () => openGroupModal(null, depts, members, load));
  await load();
}

function openGroupModal(group, depts, members, onSaved) {
  const current = new Map((group ? group.members : []).map((m) => [m.id, m.role]));
  const deptOptions = group && !depts.includes(group.department) ? [group.department, ...depts] : depts;
  const modal = openModal(`
    <h3>${group ? "Editează grupul" : "Grup nou"}</h3>
    <div class="form">
      <input class="input" id="g-name" aria-label="Nume (ex. Programare)" placeholder="Nume (ex. Programare)" value="${group ? esc(group.name) : ""}">
      <input class="input" id="g-desc" aria-label="Descriere (opțional)" placeholder="Descriere (opțional)" value="${group && group.description ? esc(group.description) : ""}">
      <select class="input" id="g-dept" aria-label="Departament">${deptOptions.map((d) => `<option value="${d}" ${group && group.department === d ? "selected" : ""}>${DEPT[d] || d}</option>`).join("")}</select>
      <div class="field-label">Membri (★ = lider de grup, poate da teme grupului)</div>
      <div class="checkbox-list" id="g-members"></div>
      <button class="btn" id="g-save">${group ? "Salvează" : "Creează"}</button>
    </div>`);
  const el = modal.el;
  const renderMembers = () => {
    const dept = el.querySelector("#g-dept").value;
    const eligible = members.filter((m) => dept === "mixt" || m.department === dept || m.department === "ambele" || current.has(m.id));
    el.querySelector("#g-members").innerHTML = eligible.map((m) => `
      <label class="checkbox-row">
        <input type="checkbox" data-member="${m.id}" ${current.has(m.id) ? "checked" : ""}>
        <span>${esc(m.name)} <span class="muted small">${esc(DEPT_LABELS[m.department] || m.department || "")}</span></span>
        <input type="checkbox" data-leader="${m.id}" title="Lider de grup" ${current.get(m.id) === "leader" ? "checked" : ""}> ★
      </label>`).join("") || `<p class="muted small">Niciun membru eligibil.</p>`;
  };
  el.querySelector("#g-dept").addEventListener("change", renderMembers);
  el.querySelector("#g-members").addEventListener("change", (e) => {
    const id = Number(e.target.dataset.member || e.target.dataset.leader);
    if (!id) return;
    const checked = el.querySelector(`[data-member="${id}"]`).checked;
    const leader = el.querySelector(`[data-leader="${id}"]`).checked;
    if (e.target.dataset.leader && leader) el.querySelector(`[data-member="${id}"]`).checked = true;
    if (e.target.dataset.member && !checked) { el.querySelector(`[data-leader="${id}"]`).checked = false; current.delete(id); return; }
    if (checked || leader) current.set(id, leader ? "leader" : "member"); else current.delete(id);
  });
  renderMembers();
  let saved = group; // after a successful create, retries go through PATCH instead of a second POST
  busyOnClick(el.querySelector("#g-save"), async () => {
    const body = { name: el.querySelector("#g-name").value, description: el.querySelector("#g-desc").value, department: el.querySelector("#g-dept").value };
    try {
      const g = saved ? await api.patch(`/api/groups/${saved.id}`, body) : await api.post("/api/groups", body);
      saved = g;
      await api.put(`/api/groups/${g.id}/members`, { members: [...current].map(([member_id, role]) => ({ member_id, role })) });
      toast("Grup salvat", "success");
      modal.close();
      onSaved();
    } catch (e) { toast(e.message, "error"); }
  });
}
