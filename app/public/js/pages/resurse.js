import { api } from "../api.js";
import { esc, loadingHtml, errorHtml, emptyHtml, toast, openModal, busyOnClick, confirmDialog, fileField } from "../ui.js";

const MAX_BYTES = 50 * 1048576;
const nf = new Intl.NumberFormat("ro-RO", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function fmtSize(n) {
  if (n >= 1048576) return `${nf.format(n / 1048576)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// Short text badge as icon: link or file type by mime / extension.
function iconFor(r) {
  if (r.kind === "link") return "🔗";
  const mime = (r.file && r.file.mime) || "";
  const name = ((r.file && r.file.name) || "").toLowerCase();
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "PDF";
  if (/wordprocessing|msword/.test(mime) || /\.docx?$/.test(name)) return "DOC";
  if (/presentation|powerpoint/.test(mime) || /\.pptx?$/.test(name)) return "PPT";
  if (mime.startsWith("image/")) return "IMG";
  if (/zip|compressed|x-7z|x-rar/.test(mime) || /\.(zip|7z|rar)$/.test(name)) return "ZIP";
  return "FIȘ";
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return url || ""; }
}

function itemHtml(r, canManage) {
  const isLink = r.kind === "link";
  const fileUrl = `/api/resources/${r.id}/file`;
  const metaHtml = isLink ? esc(domainOf(r.url)) : (r.file ? `${fmtSize(r.file.size)} · ${esc(r.file.name)}` : "");
  const href = isLink ? esc(r.url) : fileUrl;
  return `<div class="res-item" data-id="${r.id}">
    <div class="res-icon" aria-hidden="true">${iconFor(r)}</div>
    <div class="res-main">
      <a class="res-title" href="${href}" target="_blank" rel="noopener">${esc(r.title)}</a>
      ${r.description ? `<div class="res-desc">${esc(r.description)}</div>` : ""}
      <div class="res-meta">${metaHtml}</div>
    </div>
    <div class="res-actions">
      ${isLink ? "" : `<a class="btn btn-ghost btn-small" href="${fileUrl}?download=1" download>Descarcă</a>`}
      ${canManage ? `<button class="btn btn-ghost btn-small" data-edit="${r.id}">Editează</button><button class="btn btn-ghost btn-small" data-del="${r.id}">Șterge</button>` : ""}
    </div>
  </div>`;
}

export async function mountResurse(container) {
  const state = { q: "", category: "", data: null };
  container.innerHTML = `
    <div class="container">
      <div class="page-header">
        <h1>Resurse</h1>
        <div class="page-header-actions" id="res-actions"></div>
      </div>
      <div class="res-toolbar"><input class="input" id="res-q" type="search" placeholder="Caută în resurse…" aria-label="Caută în resurse"></div>
      <div class="res-chips" id="res-chips"></div>
      <div id="res-body">${loadingHtml()}</div>
    </div>`;
  const body = container.querySelector("#res-body");
  const chips = container.querySelector("#res-chips");
  const actions = container.querySelector("#res-actions");
  let seq = 0;
  let categories = [];

  function renderChips() {
    const all = [{ key: "", label: "Toate" }, ...categories];
    chips.innerHTML = all.map((c) => `<button class="res-chip${c.key === state.category ? " active" : ""}" data-cat="${esc(c.key)}">${esc(c.label)}</button>`).join("");
  }

  function renderList() {
    const d = state.data;
    const list = d.resources;
    if (!list.length) {
      body.innerHTML = emptyHtml(state.q ? `Nicio resursă găsită pentru „${state.q}”.` : "Nu există resurse încă.");
      return;
    }
    const groups = categories.map((c) => ({ c, items: list.filter((r) => r.category === c.key) })).filter((g) => g.items.length);
    const known = new Set(categories.map((c) => c.key));
    const rest = list.filter((r) => !known.has(r.category));
    if (rest.length) groups.push({ c: { key: "_", label: "Altele" }, items: rest });
    body.innerHTML = groups.map((g) => `<section class="res-group"><h2>${esc(g.c.label)}</h2>${g.items.map((r) => itemHtml(r, d.can_manage)).join("")}</section>`).join("");
  }

  async function load({ spinner = true } = {}) {
    const my = ++seq;
    if (spinner) body.innerHTML = loadingHtml();
    try {
      const qs = new URLSearchParams();
      if (state.q) qs.set("q", state.q);
      if (state.category) qs.set("category", state.category);
      const d = await api.get(`/api/resources?${qs}`);
      if (my !== seq) return;
      state.data = d;
      if (!categories.length || d.categories.length) categories = d.categories;
      renderChips();
      actions.innerHTML = d.can_manage ? `<button class="btn" id="res-add">+ Resursă nouă</button>` : "";
      renderList();
    } catch (e) {
      if (my !== seq) return;
      body.innerHTML = errorHtml(e);
      body.querySelector("[data-retry]")?.addEventListener("click", () => load());
    }
  }

  let timer = null;
  container.querySelector("#res-q").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value.trim(); load({ spinner: false }); }, 300);
  });
  chips.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    state.category = b.dataset.cat;
    load({ spinner: false });
  });
  actions.addEventListener("click", (e) => {
    if (e.target.closest("#res-add")) openForm(null);
  });
  body.addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-edit]");
    if (ed) return openForm(state.data.resources.find((r) => r.id === Number(ed.dataset.edit)));
    const del = e.target.closest("[data-del]");
    if (del) {
      const r = state.data.resources.find((x) => x.id === Number(del.dataset.del));
      if (!r || !(await confirmDialog(`Ștergi resursa „${r.title}”?`, { danger: true }))) return;
      try {
        await api.del(`/api/resources/${r.id}`);
        toast("Resursa a fost ștearsă.", "success");
        load({ spinner: false });
      } catch (err) { toast(err.message, "error"); }
    }
  });

  function openForm(res) {
    const editing = !!res;
    const isFile = editing ? res.kind === "file" : true;
    const cats = categories.map((c) => `<option value="${esc(c.key)}"${res && res.category === c.key ? " selected" : ""}>${esc(c.label)}</option>`).join("");
    const modal = openModal(`
      <h3>${editing ? "Editează resursa" : "Adaugă resursă"}</h3>
      <div class="form">
        ${editing ? "" : `<div class="tabs" id="rf-kind">
          <button type="button" class="tab-btn active" data-kind="file">Fișier</button>
          <button type="button" class="tab-btn" data-kind="link">Link</button></div>`}
        <label class="field-label">Categorie<select class="input" id="rf-cat">${cats}</select></label>
        <label class="field-label">Titlu<input class="input" id="rf-title" maxlength="200" value="${esc(res ? res.title : "")}"></label>
        <label class="field-label">Descriere<textarea class="input" id="rf-desc" rows="3" maxlength="1000">${esc(res ? res.description : "")}</textarea></label>
        <div class="field-label" id="rf-file-wrap">${editing ? `Înlocuiește fișierul (opțional)${res.file ? ` — acum: ${esc(res.file.name)}` : ""}` : "Fișier"}
          ${fileField("rf-file")}<span class="muted small">Max 50 MB.</span></div>
        <label class="field-label hidden" id="rf-url-wrap">Adresă (URL)<input class="input" type="url" id="rf-url" placeholder="https://…" value="${esc(res && res.url ? res.url : "")}"></label>
        <div class="upload-progress hidden" id="rf-prog"></div>
        <div class="form-error" id="rf-err" role="alert"></div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" id="rf-cancel">Anulează</button><button type="button" class="btn" id="rf-save">${editing ? "Salvează" : "Adaugă"}</button></div>
      </div>`);
    const $ = (s) => modal.el.querySelector(s);
    let kind = isFile ? "file" : "link";
    const sync = () => {
      $("#rf-file-wrap").classList.toggle("hidden", kind !== "file");
      $("#rf-url-wrap").classList.toggle("hidden", kind !== "link");
    };
    sync();
    modal.el.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => {
      kind = b.dataset.kind;
      modal.el.querySelectorAll("[data-kind]").forEach((x) => x.classList.toggle("active", x === b));
      sync();
    }));
    $("#rf-cancel").addEventListener("click", () => modal.close());
    busyOnClick($("#rf-save"), async () => {
      const err = $("#rf-err");
      err.textContent = "";
      const category = $("#rf-cat").value;
      const title = $("#rf-title").value.trim();
      const description = $("#rf-desc").value.trim();
      const url = $("#rf-url").value.trim();
      const file = $("#rf-file").files[0];
      if (!title && !(kind === "file" && file)) { err.textContent = "Titlul este obligatoriu."; return; }
      if (kind === "link" && !url) { err.textContent = "Adresa este obligatorie."; return; }
      if (kind === "file" && !editing && !file) { err.textContent = "Alege un fișier."; return; }
      if (file && file.size > MAX_BYTES) { err.textContent = "Fișierul depășește 50 MB."; return; }
      const prog = $("#rf-prog");
      try {
        if (file) { prog.classList.remove("hidden"); prog.textContent = "Se încarcă fișierul…"; }
        if (!editing) {
          if (kind === "link") {
            await api.post("/api/resources", { kind: "link", category, title, description, url });
          } else {
            const fd = new FormData();
            fd.append("file", file);
            fd.append("category", category);
            fd.append("title", title);
            fd.append("description", description);
            await api.upload("/api/resources", fd);
          }
        } else {
          const patch = { category, title, description };
          if (kind === "link") patch.url = url;
          await api.put(`/api/resources/${res.id}`, patch);
          if (kind === "file" && file) {
            const fd = new FormData();
            fd.append("file", file);
            await api.upload(`/api/resources/${res.id}/file`, fd);
          }
        }
        toast(editing ? "Resursa a fost salvată." : "Resursa a fost adăugată.", "success");
        modal.close();
        load({ spinner: false });
      } catch (e) {
        err.textContent = e.message;
        prog.classList.add("hidden");
      }
    });
  }

  await load();
}
