import { api } from "../api.js";
import { esc, loadingHtml, errorHtml, emptyHtml, toast, openModal, busyOnClick, confirmDialog, linkifyArticles, fmtDateTime } from "../ui.js";
import { can } from "../app.js";
import { DOC_STATUS_LABELS } from "./membri-labels.js";

const STATUS_LABEL = DOC_STATUS_LABELS;
const STATUS_CLASS = { lipsa: "badge-warn", incarcat: "", aprobat: "badge-ok", respins: "badge-danger" };

export async function mountDocumente(container) {
  const isLeader = can("documents.review");
  container.innerHTML = `
    <div class="container">
      <h1>Documente</h1>
      <div class="tabs" id="doc-tabs">
        <button class="tab-btn active" data-tab="mele">Documentele mele</button>
        ${isLeader ? `<button class="tab-btn" data-tab="matrice">Matrice membri</button>` : ""}
      </div>
      <div id="tab-mele" class="tab-pane">${loadingHtml()}</div>
      ${isLeader ? `<div id="tab-matrice" class="tab-pane hidden"></div>` : ""}
    </div>`;

  container.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      container.querySelectorAll(".tab-pane").forEach((p) => p.classList.add("hidden"));
      const pane = document.getElementById(`tab-${btn.dataset.tab}`);
      pane.classList.remove("hidden");
      if (btn.dataset.tab === "matrice" && !pane.dataset.loaded) { pane.dataset.loaded = "1"; loadMatrix(pane); }
    });
  });

  await loadMine(document.getElementById("tab-mele"));
}

async function loadMine(pane) {
  pane.innerHTML = loadingHtml();
  try {
    const docs = await api.get("/api/documents/me");
    if (!docs.length) { pane.innerHTML = emptyHtml("Niciun document necesar pentru tine."); return; }
    pane.innerHTML = `<div class="doc-grid">${docs.map(docCard).join("")}</div>`;
    wireUploads(pane);
    wireConsentWithdraw(pane);
  } catch (e) { pane.innerHTML = errorHtml(e); }
}

// Art. 59.3: the member withdraws their own photo/video consent, effective from now on - every
// photo tagging them becomes non-publishable on the next read, nothing retroactive.
function wireConsentWithdraw(pane) {
  pane.querySelectorAll("[data-withdraw-photo-consent]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog("Retragi acordul de consimțământ foto/video (Art. 59.3)? De acum nu se vor mai publica poze noi cu tine.", { danger: true });
      if (!ok) return;
      try {
        await api.post("/api/photos/consent/withdraw");
        toast("Acord foto retras.", "success");
      } catch (e) { toast(e.message, "error"); }
    });
  });
}

function docCard(d) {
  const status = d.document ? d.document.status : "lipsa";
  return `
    <div class="card doc-card" data-key="${d.key}">
      <div class="card-header">
        <h2>${esc(d.title)}</h2>
        <span class="badge ${STATUS_CLASS[status]}">${STATUS_LABEL[status]}</span>
      </div>
      <p class="muted small">${esc(d.who_signs || "")} ${d.article ? `· ${linkifyArticles(d.article)}` : ""}</p>
      ${d.document && d.document.status === "respins" && d.document.review_note ? `<p class="doc-review-note">Motiv respingere: ${esc(d.document.review_note)}</p>` : ""}
      ${d.document && !d.document.file_path && d.document.review_note ? `<p class="muted small">${esc(d.document.review_note)}</p>` : ""}
      <div class="doc-card-actions">
        ${d.source ? `<a class="btn btn-ghost btn-small" href="/api/documents/template/${d.key}" target="_blank">Descarcă șablonul</a>` : ""}
        <label class="btn btn-small file-upload-btn">
          ${status === "lipsa" ? "Încarcă" : "Re-încarcă"}
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.heic" data-upload-input class="sr-only">
        </label>
        ${d.key === "anexa13_foto_video" && status === "aprobat" ? `<button class="btn btn-ghost btn-small" data-withdraw-photo-consent>Retrag acordul foto</button>` : ""}
      </div>
      <div class="upload-progress hidden" data-progress></div>
    </div>`;
}

function wireUploads(pane) {
  pane.querySelectorAll("[data-upload-input]").forEach((input) => {
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 15 * 1024 * 1024) { toast("Fișierul depășește 15 MB.", "error"); input.value = ""; return; }
      const card = input.closest(".doc-card");
      const key = card.dataset.key;
      const progress = card.querySelector("[data-progress]");
      progress.classList.remove("hidden");
      progress.textContent = "Se încarcă…";
      const fd = new FormData();
      fd.append("file", file);
      try {
        await api.upload(`/api/documents/${key}/upload`, fd);
        toast("Document încărcat", "success");
        loadMine(pane);
      } catch (e) {
        progress.classList.add("hidden");
        toast(e.message, "error");
      } finally { input.value = ""; }
    });
  });
}

async function loadMatrix(pane) {
  pane.innerHTML = loadingHtml();
  try {
    const matrix = await api.get("/api/documents/matrix");
    if (!matrix.length) { pane.innerHTML = emptyHtml("Niciun membru."); return; }
    const docKeys = matrix[0].documents.map((d) => d.key);
    const docTitles = matrix[0].documents.map((d) => d.title);
    pane.innerHTML = `
      <div class="filters"><label class="filter-btn checkbox-row"><input type="checkbox" id="only-missing"> doar lipsă</label></div>
      <div class="table-scroll"><table class="data-table matrix-table">
        <thead><tr><th>Membru</th>${docTitles.map((t) => `<th title="${esc(t)}">${esc(shorten(t))}</th>`).join("")}</tr></thead>
        <tbody>
          ${matrix.map((row) => `<tr data-member-row data-has-missing="${row.documents.some((d) => d.status === "lipsa") ? 1 : 0}">
            <td><a href="/membri/${row.member_id}" data-link>${esc(row.name)}</a></td>
            ${row.documents.map((d) => `<td><button class="matrix-cell ${STATUS_CLASS[d.status]}"
                data-member-id="${row.member_id}" data-key="${d.key}" data-status="${d.status}"
                data-title="${esc(d.title)}" data-document-id="${d.document_id || ""}"
                data-uploaded-at="${d.uploaded_at || ""}" data-review-note="${esc(d.review_note || "")}" data-can-open="${d.can_open ? 1 : 0}" data-electronic="${d.electronic ? 1 : 0}"
              >${STATUS_LABEL[d.status]}</button></td>`).join("")}
          </tr>`).join("")}
        </tbody>
      </table></div>`;
    document.getElementById("only-missing").addEventListener("change", (e) => {
      pane.querySelectorAll("[data-member-row]").forEach((row) => {
        row.style.display = !e.target.checked || row.dataset.hasMissing === "1" ? "" : "none";
      });
    });
    pane.querySelectorAll(".matrix-cell").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.status === "lipsa") { toast("Niciun document încărcat încă.", "info"); return; }
        openReviewModal(btn, () => { pane.dataset.loaded = ""; loadMatrix(pane); });
      });
    });
  } catch (e) { pane.innerHTML = errorHtml(e); }
}
function shorten(title) { return title.length > 18 ? title.slice(0, 16) + "…" : title; }

function openReviewModal(btn, onDone) {
  const { status, title, documentId, uploadedAt, reviewNote } = {
    status: btn.dataset.status,
    title: btn.dataset.title,
    documentId: btn.dataset.documentId,
    uploadedAt: btn.dataset.uploadedAt,
    reviewNote: btn.dataset.reviewNote,
  };
  // Art. 41.4: fișa medicală a altcuiva se deschide doar de Team Leader și mentori; co-leaderul vede statusul în
  // matrice, dar nu poate deschide fișierul. Dreptul vine de la server (documents.view_file → `can_open`).
  const canOpen = btn.dataset.canOpen === "1";
  const modal = openModal(`
    <h3>${esc(title)}</h3>
    <p class="muted small">Status curent: ${STATUS_LABEL[status].toLowerCase()} ${uploadedAt ? `· încărcat ${fmtDateTime(uploadedAt)}` : ""}</p>
    ${reviewNote ? `<p class="doc-review-note">Notă anterioară: ${esc(reviewNote)}</p>` : ""}
    ${btn.dataset.electronic === "1"
      ? `<p class="muted small">Acceptat electronic la crearea contului, fără fișier (Art. 72.3).</p>`
      : canOpen
      ? `<a class="btn btn-ghost btn-small" href="/api/documents/file/${documentId}" target="_blank">Deschide fișierul</a>`
      : `<p class="doc-review-note">Fișa medicală a altui membru se deschide doar de team leader sau mentor (Art. 58.3, 41.4).</p>`}
    <div class="form" style="margin-top:12px">
      <label class="field-label">Notă (opțional)<textarea class="input" id="review-note" rows="2">${esc(reviewNote || "")}</textarea></label>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="review-reject">Respinge</button>
        <button class="btn" id="review-approve">Aprobă</button>
      </div>
      <div class="form-error" id="review-error"></div>
    </div>`);

  const submit = async (newStatus) => {
    const note = modal.el.querySelector("#review-note").value;
    const errEl = modal.el.querySelector("#review-error");
    try {
      await api.post(`/api/documents/${documentId}/review`, { status: newStatus, note });
      toast(newStatus === "aprobat" ? "Document aprobat" : "Document respins", "success");
      modal.close();
      onDone();
    } catch (e) { errEl.textContent = e.message; }
  };
  busyOnClick(modal.el.querySelector("#review-approve"), () => submit("aprobat"));
  busyOnClick(modal.el.querySelector("#review-reject"), () => submit("respins"));
}
