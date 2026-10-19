import { api } from "../api.js";
import { esc, loadingHtml, errorHtml, emptyHtml, toast, openModal, busyOnClick, confirmDialog, fmtDateTime, trapDialog } from "../ui.js";
import { currentUser, can } from "../app.js";

export async function mountPoze(container) {
  container.innerHTML = `<div class="container" id="poze-root">${loadingHtml()}</div>`;
  await renderAlbums(document.getElementById("poze-root"));
}

async function renderAlbums(root) {
  root.innerHTML = loadingHtml();
  try {
    const albums = await api.get("/api/photos/albums");
    const user = currentUser();
    root.innerHTML = `
      <h1>Poze</h1>
      <div class="doc-card-actions" style="margin-bottom:16px">
        <button class="btn btn-small" id="new-album-btn">+ Album nou</button>
      </div>
      ${albums.length ? `<div class="album-grid">${albums.map(albumCard).join("")}</div>` : emptyHtml("Niciun album încă.")}
    `;
    document.getElementById("new-album-btn").addEventListener("click", () => openNewAlbumModal(root));
    root.querySelectorAll("[data-album-id]").forEach((el) => {
      const open = () => renderAlbum(root, el.dataset.albumId, el.dataset.albumTitle);
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  } catch (e) { root.innerHTML = errorHtml(e); }
}

function albumCard(a) {
  return `
    <div class="card album-card" role="button" tabindex="0" data-album-id="${a.id}" data-album-title="${esc(a.title)}">
      <div class="album-thumb" aria-hidden="true">📷</div>
      <h2 style="font-size:0.95em">${esc(a.title)}</h2>
      <p class="muted small">${a.photo_count} poz${a.photo_count === 1 ? "ă" : "e"}${a.source === "whatsapp" ? " · WhatsApp" : ""}</p>
    </div>`;
}

function openNewAlbumModal(root) {
  const modal = openModal(`
    <h3>Album nou</h3>
    <div class="form">
      <label class="field-label">Titlu<input class="input" id="album-title"></label>
      <label class="field-label">Lună (opțional, YYYY-MM)<input class="input" id="album-month" placeholder="2026-10"></label>
      <div class="form-error" id="album-error"></div>
      <div class="modal-actions"><button class="btn" id="album-create">Creează</button></div>
    </div>`);
  busyOnClick(modal.el.querySelector("#album-create"), async () => {
    const title = modal.el.querySelector("#album-title").value.trim();
    const month = modal.el.querySelector("#album-month").value.trim();
    const errEl = modal.el.querySelector("#album-error");
    try {
      await api.post("/api/photos/albums", { title, month: month || undefined });
      modal.close();
      renderAlbums(root);
    } catch (e) { errEl.textContent = e.message; }
  });
}

let MEMBERS_CACHE = null;
async function getMembers() {
  if (!MEMBERS_CACHE) MEMBERS_CACHE = await api.get("/api/members");
  return MEMBERS_CACHE;
}

async function renderAlbum(root, albumId, title) {
  root.innerHTML = loadingHtml();
  try {
    const photos = await api.get(`/api/photos/albums/${albumId}/photos`);
    const user = currentUser();
    root.innerHTML = `
      <div class="card-header" style="margin-bottom:12px">
        <h1>${esc(title)}</h1>
        <a href="#" id="back-albums" class="btn btn-ghost btn-small">← Albume</a>
      </div>
      <div class="upload-drop" id="upload-drop">
        <label class="btn file-upload-btn">
          Încarcă poze/video
          <input type="file" id="photo-input" accept="image/jpeg,image/png,image/heic,video/mp4,video/quicktime,video/webm" multiple class="sr-only">
        </label>
        <div class="upload-progress hidden" id="upload-progress"></div>
      </div>
      ${photos.length ? `<div class="photo-grid" id="photo-grid">${photos.map((p) => photoThumb(p)).join("")}</div>` : emptyHtml("Niciun fișier în acest album încă.")}
    `;
    document.getElementById("back-albums").addEventListener("click", (e) => { e.preventDefault(); renderAlbums(root); });
    wireUpload(root, albumId, title);
    wirePhotoClicks(root, albumId, title, photos, user);
  } catch (e) { root.innerHTML = errorHtml(e); }
}

function photoThumb(p) {
  const badge = p.publication.publishable
    ? `<span class="badge badge-ok photo-badge">Publicabil</span>`
    : `<span class="badge badge-warn photo-badge">Nepublicabil</span>`;
  const src = `/api/photos/${p.id}/thumb`;
  const media = p.media_type === "video"
    ? `<video src="/api/photos/${p.id}/medium" muted></video>`
    : `<img src="${src}" loading="lazy" alt="">`;
  return `<div class="photo-thumb" role="button" tabindex="0" aria-label="Deschide fișierul" data-photo-id="${p.id}">${media}${badge}</div>`;
}

function wireUpload(root, albumId, title) {
  const input = document.getElementById("photo-input");
  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) { toast(`${f.name} depășește 25 MB.`, "error"); return; }
    }
    const progress = document.getElementById("upload-progress");
    progress.classList.remove("hidden");
    progress.textContent = `Se încarcă ${files.length} fișier(e)…`;
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    try {
      await api.upload(`/api/photos/albums/${albumId}/photos`, fd);
      toast("Poze încărcate.", "success");
      renderAlbum(root, albumId, title);
    } catch (e) {
      progress.classList.add("hidden");
      toast(e.message, "error");
    } finally { input.value = ""; }
  });
}

function wirePhotoClicks(root, albumId, title, photos, user) {
  root.querySelectorAll("[data-photo-id]").forEach((el) => {
    const open = () => {
      const photo = photos.find((p) => String(p.id) === el.dataset.photoId);
      openLightbox(root, albumId, title, photo, user);
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

function openLightbox(root, albumId, title, photo, user) {
  const overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Poză");
  // Per-photo rights from the server (policy photos.tag / photos.delete / photos.download_original).
  const canTag = !!photo.can_tag;
  const canDelete = !!photo.can_delete;
  const canPublish = can("photos.publish");
  const media = photo.media_type === "video"
    ? `<video src="/api/photos/${photo.id}/medium" controls autoplay></video>`
    : `<img src="/api/photos/${photo.id}/medium" alt="">`; // reduced variant for every viewer; the original is a download for leaders/uploader
  overlay.innerHTML = `
    <button class="lightbox-close" aria-label="Închide">&times;</button>
    ${media}
    <p class="${photo.publication.publishable ? "" : "doc-review-note"}">${esc(photo.publication.message)}</p>
    <div class="tag-list" id="lb-tags">${photo.tags.map((t) => `
      <span class="tag-chip">${esc(t.name)} ${canTag ? `<button data-untag="${t.member_id}" aria-label="Scoate eticheta ${esc(t.name)}">&times;</button>` : ""}</span>`).join("") || "<span class=\"muted small\">Nicio etichetă.</span>"}</div>
    <div class="lightbox-actions">
      ${canTag ? `<button class="btn btn-ghost btn-small" id="lb-tag-add">Etichetează</button>` : ""}
      ${photo.can_download_original ? `<a class="btn btn-ghost btn-small" href="/api/photos/${photo.id}/file" target="_blank">Descarcă originalul</a>` : ""}
      ${canPublish ? `<button class="btn btn-small" id="lb-publish">${photo.published ? "Retrage publicarea" : "Publică"}</button>` : ""}
      <button class="btn btn-ghost btn-small" id="lb-report">Raportează context privat</button>
      ${canDelete ? `<button class="btn btn-danger btn-small" id="lb-delete">Șterge</button>` : ""}
    </div>`;
  document.body.appendChild(overlay);
  // Same dialog stack as the modals (ui.trapDialog): a confirm opened from here handles Escape alone.
  const release = trapDialog(overlay, overlay, () => close());
  const close = () => {
    overlay.remove();
    release();
  };
  overlay.querySelector(".lightbox-close").addEventListener("click", close);
  overlay.querySelector(".lightbox-close").focus();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  overlay.querySelectorAll("[data-untag]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api.del(`/api/photos/${photo.id}/tags/${btn.dataset.untag}`);
        close();
        renderAlbum(root, albumId, title);
      } catch (e) { toast(e.message, "error"); }
    });
  });

  const tagBtn = overlay.querySelector("#lb-tag-add");
  if (tagBtn) tagBtn.addEventListener("click", async () => {
    await openTagPicker(photo.id, () => { close(); renderAlbum(root, albumId, title); });
  });

  const publishBtn = overlay.querySelector("#lb-publish");
  if (publishBtn) busyOnClick(publishBtn, async () => {
    try {
      await api.post(`/api/photos/${photo.id}/publish`, { published: !photo.published });
      toast(photo.published ? "Publicare retrasă." : "Poză publicată.", "success");
      close();
      renderAlbum(root, albumId, title);
    } catch (e) { toast(e.message, "error"); }
  });

  overlay.querySelector("#lb-report").addEventListener("click", async () => {
    const ok = await confirmDialog("Raportezi această poză ca fiind într-un context privat (Art. 59.4)? Team Leader va fi notificat.");
    if (!ok) return;
    try {
      await api.post(`/api/photos/${photo.id}/report`);
      toast("Raportat către Team Leader.", "success");
      close();
    } catch (e) { toast(e.message, "error"); }
  });

  const delBtn = overlay.querySelector("#lb-delete");
  if (delBtn) delBtn.addEventListener("click", async () => {
    const ok = await confirmDialog("Ștergi definitiv această poză?", { danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/photos/${photo.id}`);
      toast("Poză ștearsă.", "success");
      close();
      renderAlbum(root, albumId, title);
    } catch (e) { toast(e.message, "error"); }
  });
}

async function openTagPicker(photoId, onDone) {
  const members = await getMembers();
  const modal = openModal(`
    <h3>Etichetează membri</h3>
    <input class="input" id="tag-search" aria-label="Caută după nume" placeholder="Caută după nume…" style="margin-bottom:10px">
    <div id="tag-list" style="max-height:260px;overflow-y:auto"></div>`);
  const listEl = modal.el.querySelector("#tag-list");
  const render = (q) => {
    const matches = members.filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase()));
    listEl.innerHTML = matches.map((m) => `<button class="btn btn-ghost btn-small" style="display:block;width:100%;text-align:left;margin-bottom:4px" data-tag-member="${m.id}">${esc(m.name)}</button>`).join("") || `<p class="muted small">Niciun membru găsit.</p>`;
    listEl.querySelectorAll("[data-tag-member]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api.post(`/api/photos/${photoId}/tags`, { member_id: Number(btn.dataset.tagMember) });
          toast("Etichetat.", "success");
          modal.close();
          onDone();
        } catch (e) { toast(e.message, "error"); }
      });
    });
  };
  render("");
  modal.el.querySelector("#tag-search").addEventListener("input", (e) => render(e.target.value));
}
