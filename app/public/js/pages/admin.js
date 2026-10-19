import { api } from "../api.js";
import { esc, fmtDateTime, loadingHtml, errorHtml, emptyHtml, toast } from "../ui.js";
import { can } from "../app.js";

export async function mountAdmin(container) {
  if (!can("members.manage")) {
    container.innerHTML = `<div class="container">${emptyHtml("Nu ai acces la secțiunea Admin (doar Team Leader/Co-Leader).")}</div>`;
    return;
  }
  container.innerHTML = `
    <div class="container">
      <h1>Admin</h1>
      <div class="card">
        <h2>Membri</h2>
        <p class="muted">Creare, editare, resetare parolă și import se fac din <a href="/echipa?tab=membri" data-link>Echipă → Membri</a>.</p>
      </div>
      <div class="tabs" id="admin-tabs" role="tablist">
        <button class="tab-btn active" role="tab" aria-selected="true" aria-controls="tab-grupuri" data-tab="grupuri">Grupuri WhatsApp</button>
        <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-ai" data-tab="ai">Utilizare AI</button>
        <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-ftc-manual" data-tab="ftc-manual">Manual FTC</button>
        ${can("audit_log.view") ? `<button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-jurnal" data-tab="jurnal">Jurnal acces date</button>` : ""}
      </div>
      <div id="tab-grupuri" class="tab-pane">${loadingHtml()}</div>
      <div id="tab-ai" class="tab-pane hidden"></div>
      <div id="tab-ftc-manual" class="tab-pane hidden"></div>
      <div id="tab-jurnal" class="tab-pane hidden"></div>
    </div>`;

  container.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".tab-btn").forEach((b) => { b.classList.toggle("active", b === btn); b.setAttribute("aria-selected", String(b === btn)); });
      container.querySelectorAll(".tab-pane").forEach((p) => p.classList.add("hidden"));
      const pane = document.getElementById(`tab-${btn.dataset.tab}`);
      pane.classList.remove("hidden");
      if (!pane.dataset.loaded) {
        pane.dataset.loaded = "1";
        if (btn.dataset.tab === "ai") loadAiUsage(pane);
        if (btn.dataset.tab === "ftc-manual") loadFtcManual(pane);
        if (btn.dataset.tab === "jurnal") loadAuditLog(pane);
      }
    });
  });

  await loadGroups(document.getElementById("tab-grupuri"));
}

// Role requests from self-registration (docs/design-inregistrare.md §2): confirm or reject.
// Its own tab of the Admin section (docs/design-meniu-v2.md §1).
export async function mountCereriRol(container) {
  if (!can("members.manage")) {
    container.innerHTML = `<div class="container">${emptyHtml("Nu ai acces la secțiunea Admin (doar Team Leader/Co-Leader).")}</div>`;
    return;
  }
  container.innerHTML = `<div class="container"><div id="role-requests"></div></div>`;
  await loadRoleRequests(container.querySelector("#role-requests"));
}

async function loadRoleRequests(pane) {
  pane.innerHTML = loadingHtml();
  try {
    const rows = await api.get("/api/admin/role-requests");
    pane.innerHTML = `<div class="card"><h2>Cereri de rol</h2>${rows.length ? `<div class="list">${rows.map((r) => `
      <div class="list-item" data-member-id="${r.id}">
        <div class="list-item-main">
          <strong>${esc(r.name)}</strong>
          <span class="muted small">acum: ${esc(r.role_label)} → cere: <strong>${esc(r.requested_role_label)}</strong> · ${fmtDateTime(r.joined_at)}</span>
        </div>
        <div class="list-item-meta">
          <button class="btn btn-small" data-approve="1">Confirmă</button>
          <button class="btn btn-small btn-ghost" data-approve="0">Respinge</button>
        </div>
      </div>`).join("")}</div>` : emptyHtml("Nicio cerere de rol în așteptare.")}</div>`;
    pane.querySelectorAll("[data-approve]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api.post(`/api/admin/role-requests/${btn.closest("[data-member-id]").dataset.memberId}`, { approve: btn.dataset.approve === "1" });
          toast("Cerere actualizată", "success");
          loadRoleRequests(pane);
        } catch (e) { toast(e.message, "error"); btn.disabled = false; }
      });
    });
  } catch (e) { pane.innerHTML = errorHtml(e); }
}

async function loadGroups(pane) {
  pane.innerHTML = loadingHtml();
  try {
    // Gateway down: the server says so (gateway_error) and still sends the groups already known.
    const { groups, gateway_error: gatewayError } = await api.get("/api/wa-groups/overview");
    pane.innerHTML = (gatewayError ? `<div class="state state-error" role="alert"><p>${esc(gatewayError)}</p><button class="btn btn-ghost" data-retry-groups>Reîncearcă</button></div>` : "") + (groups.length ? `<div class="card"><div class="list">${groups.map((g) => `
      <div class="list-item wa-group-item" data-group-id="${esc(g.group_id)}">
        <div class="list-item-main"><strong>${esc(g.name || g.group_id)}</strong></div>
        <div class="list-item-meta">
          <label class="switch"><input type="checkbox" data-tracked-toggle ${g.tracked ? "checked" : ""}><span class="switch-slider"></span></label>
          <span class="muted small">${g.tracked ? "urmărit" : "neurmărit"}</span>
        </div>
        <div class="list-item-meta wa-group-invite">
          <input class="input input-small" data-invite-link aria-label="Link invitație manual (https://chat.whatsapp.com/...)" placeholder="Link invitație manual (https://chat.whatsapp.com/...)" value="${esc(g.invite_link || "")}">
          <button class="btn btn-small btn-ghost" data-save-invite>Salvează link</button>
        </div>
      </div>`).join("")}</div></div>` : gatewayError ? "" : emptyHtml("Niciun grup înregistrat încă."));
    pane.querySelector("[data-retry-groups]")?.addEventListener("click", () => loadGroups(pane));
    pane.querySelectorAll("[data-tracked-toggle]").forEach((cb) => {
      cb.addEventListener("change", async () => {
        const groupId = cb.closest("[data-group-id]").dataset.groupId;
        cb.disabled = true;
        try {
          await api.post(`/api/wa-groups/${encodeURIComponent(groupId)}/tracked`, { tracked: cb.checked });
          toast("Grup actualizat", "success");
          cb.closest(".list-item").querySelector(".muted").textContent = cb.checked ? "urmărit" : "neurmărit";
        } catch (e) { cb.checked = !cb.checked; toast(e.message, "error"); }
        finally { cb.disabled = false; }
      });
    });
    pane.querySelectorAll("[data-save-invite]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const item = btn.closest("[data-group-id]");
        const groupId = item.dataset.groupId;
        const link = item.querySelector("[data-invite-link]").value.trim();
        btn.disabled = true;
        try {
          await api.post(`/api/wa-groups/${encodeURIComponent(groupId)}/invite-link`, { link });
          toast("Link de invitație salvat", "success");
        } catch (e) { toast(e.message, "error"); }
        finally { btn.disabled = false; }
      });
    });
  } catch (e) { pane.innerHTML = errorHtml(e); }
}

const FLAG_CATEGORY_LABELS = {
  off_topic: "În afara scopului",
  periculos: "Cerere periculoasă",
  date_personale: "Date personale",
  injectie: "Injecție de instrucțiuni",
  criza: "Criză",
  limita: "Limită atinsă",
};

async function loadAiUsage(pane) {
  pane.innerHTML = loadingHtml();
  try {
    const [data, byMember, flags] = await Promise.all([
      api.get("/api/admin/ai-usage"),
      api.get("/api/admin/ai-usage/by-member?days=7"),
      api.get("/api/admin/ai-flags?days=7"),
    ]);
    pane.innerHTML = `
      <div class="card">
        <h2>Totaluri</h2>
        <div class="stats">
          <div class="stat"><span class="stat-value">${data.totals.calls || 0}</span><span class="stat-label">Apeluri</span></div>
          <div class="stat"><span class="stat-value">${data.totals.input_tokens || 0}</span><span class="stat-label">Input tokeni</span></div>
          <div class="stat"><span class="stat-value">${data.totals.output_tokens || 0}</span><span class="stat-label">Output tokeni</span></div>
          <div class="stat"><span class="stat-value">$${(data.totals.cost_usd || 0).toFixed(2)}</span><span class="stat-label">Cost estimat</span></div>
        </div>
      </div>

      <div class="card">
        <h2>Consum per membru (ultimele 7 zile)</h2>
        ${byMember.length ? `<div class="table-scroll"><table class="data-table">
          <thead><tr><th>Membru</th><th>Apeluri azi</th><th>Apeluri 7 zile</th><th>Tokeni 7 zile</th><th>Cost 7 zile</th></tr></thead>
          <tbody>${byMember.map((m) => `<tr>
            <td>${esc(m.member_name)}</td><td>${m.calls_today || 0}</td><td>${m.calls_period || 0}</td>
            <td>${m.tokens_period || 0}</td><td>$${(m.cost_period || 0).toFixed(4)}</td>
          </tr>`).join("")}</tbody>
        </table></div>` : emptyHtml("Niciun apel AI în ultimele 7 zile.")}
      </div>

      <div class="card">
        <h2>Refuzuri și limite (ultimele 7 zile)</h2>
        ${flags.byCategory.length ? `<div class="stats">${flags.byCategory.map((c) => `
          <div class="stat"><span class="stat-value">${c.count}</span><span class="stat-label">${esc(FLAG_CATEGORY_LABELS[c.category] || c.category)}</span></div>
        `).join("")}</div>` : `<p class="muted">Niciun refuz sau limită atinsă.</p>`}
      </div>

      <div class="card">
        <h2>Membri care au atins limita (ultimele 7 zile)</h2>
        ${flags.limitHits.length ? `<div class="list">${flags.limitHits.map((l) => `
          <div class="list-item"><div class="list-item-main">${esc(l.member_name)} <span class="muted small">× ${l.count}</span></div></div>
        `).join("")}</div>` : `<p class="muted">Nimeni nu a atins limita.</p>`}
      </div>

      <div class="card">
        <h2>Semnale de criză (ultimele 7 zile)</h2>
        <p class="muted small">Doar număr + dată + membru — conținutul conversației NU e păstrat niciodată.</p>
        ${flags.crisisSignals.length ? `<div class="list">${flags.crisisSignals.map((s) => `
          <div class="list-item"><div class="list-item-main">${esc(s.member_name || "membru necunoscut")} — ${esc(s.channel)} <span class="muted small">${fmtDateTime(s.created_at)}</span></div></div>
        `).join("")}</div>` : `<p class="muted">Niciun semnal înregistrat.</p>`}
      </div>

      ${data.rows && data.rows.length ? `
      <div class="card"><h2>Istoric apeluri</h2><div class="table-scroll"><table class="data-table">
        <thead><tr><th>Dată</th><th>Membru</th><th>Canal</th><th>Model</th><th>Tokeni</th><th>Cost</th></tr></thead>
        <tbody>${data.rows.map((r) => `<tr>
          <td>${fmtDateTime(r.created_at)}</td><td>${esc(r.member_name || r.member_id || "")}</td>
          <td>${esc(r.channel || "")}</td><td>${esc(r.model || "")}</td>
          <td>${(r.input_tokens || 0) + (r.output_tokens || 0)}</td><td>$${(r.cost_usd || 0).toFixed(4)}</td>
        </tr>`).join("")}</tbody>
      </table></div></div>` : `<div class="card">${emptyHtml("Niciun apel AI înregistrat încă.")}</div>`}
    `;
  } catch (e) { pane.innerHTML = errorHtml(e); }
}

// Manual FTC (docs/design-ai-hardening.md §2 update): current version, last check, history +
// force-check now (LEADERS, same `ftc_manual.manage` permission the routes enforce server-side).
// Who opened another member's medical sheet (Team Leader only, Art. 41.2 / 41.4) - no content, just the access.
const AUDIT_ACTIONS = { "fisa_medicala.open": "a deschis fișa medicală a lui", "medical_destroyed": "a distrus fișa medicală (Art. 41.8) a lui", "profile.self_edit": "a modificat datele de profil ale lui" };
async function loadAuditLog(pane) {
  pane.innerHTML = loadingHtml();
  try {
    const rows = await api.get("/api/admin/audit-log");
    pane.innerHTML = `<div class="card"><h2>Jurnal acces date</h2>
      <p class="muted small">Fiecare deschidere a fișei medicale a altui membru (Art. 41.4). Vizibil doar Team Leader-ului.</p>
      ${rows.length ? `<div class="list">${rows.map((r) => `
        <div class="list-item"><div class="list-item-main">
          <strong>${esc(r.actor_name || `#${r.actor_id}`)}</strong>
          <span class="muted small">${esc(AUDIT_ACTIONS[r.action] || r.action)} ${esc(r.member_name || `#${r.member_id}`)} · ${fmtDateTime(r.created_at)}</span>
        </div></div>`).join("")}</div>` : emptyHtml("Nicio intrare.")}</div>`;
  } catch (e) { pane.innerHTML = errorHtml(e); }
}

async function loadFtcManual(pane) {
  pane.innerHTML = loadingHtml();
  try {
    await renderFtcManual(pane);
  } catch (e) { pane.innerHTML = errorHtml(e); }
}

async function renderFtcManual(pane) {
  const status = await api.get("/api/ftc-docs/manual-status");
  const c = status.current;
  pane.innerHTML = `
    <div class="card">
      <h2>Versiune curentă</h2>
      ${c ? `
        <div class="stats">
          <div class="stat"><span class="stat-value">${esc(c.season || "")}</span><span class="stat-label">Sezon</span></div>
          <div class="stat"><span class="stat-value">${esc(c.version || "")}</span><span class="stat-label">Versiune</span></div>
          <div class="stat"><span class="stat-value">${fmtDateTime(c.fetched_at)}</span><span class="stat-label">Preluată la</span></div>
        </div>
        <p class="muted small">Ultima verificare: ${fmtDateTime(c.last_checked_at)} — ${esc(c.last_check_result || "")}</p>
      ` : emptyHtml("Niciun manual preluat încă.")}
      <button class="btn" id="ftc-check-now">Verifică acum</button>
    </div>
    <div class="card">
      <h2>Istoric versiuni</h2>
      ${status.history.length ? `<div class="list">${status.history.map((h) => `
        <div class="list-item">
          <div class="list-item-main">
            <strong>${esc(h.version)}</strong> <span class="muted small">${fmtDateTime(h.fetched_at)}</span>
            <p class="small">${esc(h.summary || "(fără rezumat)")}</p>
            <p class="muted small">+${h.added.length} / -${h.removed.length} / ~${h.changed.length} reguli</p>
          </div>
        </div>`).join("")}</div>` : emptyHtml("Nicio schimbare de versiune înregistrată încă.")}
    </div>`;

  pane.querySelector("#ftc-check-now").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Se verifică…";
    try {
      const result = await api.post("/api/ftc-docs/check", {});
      if (result.error) toast(result.error, "error");
      else toast(result.changed ? `Manual actualizat la ${result.version || ""}.` : "Nicio schimbare.", "success");
      await renderFtcManual(pane);
    } catch (e2) { toast(e2.message, "error"); e.target.disabled = false; e.target.textContent = "Verifică acum"; }
  });
}

// Admin → Termene (docs/design-pachet-b.md B1): the countdown deadlines shown on Acasă. TL / co-leader / heads
// (deadlines.manage on the server); a deadline has a date, or a text while the date is not announced yet.
export async function mountTermene(container) {
  container.innerHTML = `<div class="container">
      <div class="card">
        <h2>Termen nou</h2>
        <div class="form" id="dl-form">
          <input class="input" id="dl-title" aria-label="Titlu (ex. Etapa Regională)" placeholder="Titlu (ex. Etapa Regională)" maxlength="200">
          <label class="field-label">Data<input class="input" type="date" id="dl-date"></label>
          <input class="input" id="dl-text" aria-label="Sau, dacă data nu e anunțată: ex. ianuarie–februarie 2027" placeholder="Sau, dacă data nu e anunțată: ex. ianuarie–februarie 2027" maxlength="100">
          <button class="btn" id="dl-save">Adaugă</button>
          <div class="form-error" id="dl-error"></div>
        </div>
      </div>
      <div class="card"><h2>Termene</h2><div id="dl-list">${loadingHtml()}</div></div>
    </div>`;
  const listEl = container.querySelector("#dl-list");
  const errEl = container.querySelector("#dl-error");

  async function load() {
    try {
      const rows = await api.get("/api/deadlines?all=1");
      listEl.innerHTML = rows.length ? `<div class="list">${rows.map((d) => `
        <div class="list-item" data-dl-id="${d.id}">
          <div class="list-item-main"><div><strong>${esc(d.title)}</strong>
            <div class="muted small">${d.date ? esc(d.date.split("-").reverse().join(".")) : esc(d.date_text || "dată neanunțată")} · ${esc(d.days_left != null && d.days_left < 0 ? "trecut" : d.countdown)}</div></div></div>
          <div class="list-item-meta"><button class="btn btn-small btn-ghost" data-dl-del>Șterge</button></div>
        </div>`).join("")}</div>` : emptyHtml("Niciun termen.");
      listEl.querySelectorAll("[data-dl-del]").forEach((btn) => btn.addEventListener("click", async () => {
        const id = btn.closest("[data-dl-id]").dataset.dlId;
        try { await api.del(`/api/deadlines/${id}`); toast("Termen șters", "success"); load(); }
        catch (e) { toast(e.message, "error"); }
      }));
    } catch (e) { listEl.innerHTML = errorHtml(e); }
  }

  container.querySelector("#dl-save").addEventListener("click", async () => {
    errEl.textContent = "";
    const body = {
      title: container.querySelector("#dl-title").value.trim(),
      date: container.querySelector("#dl-date").value || null,
      date_text: container.querySelector("#dl-text").value.trim() || null,
    };
    try {
      await api.post("/api/deadlines", body);
      toast("Termen adăugat", "success");
      container.querySelector("#dl-title").value = "";
      container.querySelector("#dl-date").value = "";
      container.querySelector("#dl-text").value = "";
      load();
    } catch (e) { errEl.textContent = e.message; }
  });
  await load();
}
