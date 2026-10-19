// Shared UI helpers: escaping, toasts, modal, confirm, busy buttons, empty/loading/error states.

export function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Turns "Art. 20.1" / "Art 51" occurrences in plain text into clickable links to /regulament#art-N.
export function linkifyArticles(text) {
  const safe = esc(text);
  return safe.replace(/Art\.?\s?(\d+(?:\.\d+)?)/g, (m, n) =>
    `<a href="/documente?tab=regulament#art-${n}" class="art-link" data-art="${n}">${m}</a>`
  );
}

// Escapes plain text and turns http(s) URLs into anchors (new tab, rel=noopener). Nothing else becomes markup.
export function linkifyUrls(text) {
  const raw = String(text == null ? "" : text);
  let out = "";
  let last = 0;
  for (const m of raw.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, ""); // trailing punctuation belongs to the sentence
    out += esc(raw.slice(last, m.index)) + `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`;
    last = m.index + url.length;
  }
  return out + esc(raw.slice(last));
}

let toastHost = null;
export function toast(message, type = "info") {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.id = "toast-host";
    toastHost.setAttribute("aria-live", "polite");
    toastHost.setAttribute("role", "status");
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, 3800);
}

// Shared dialog behaviour (docs/design-pwa-ui.md §D): focus moves into the dialog, Tab stays inside it,
// Escape closes it, focus returns to whatever opened it. Dialogs can stack (a confirm over a modal or over the
// photo lightbox): only the top one reacts to Tab/Escape, and its Escape never reaches the dialog underneath.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const dialogStack = [];
const visibleFocusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);

export function trapDialog(overlay, dialog, onEscape) {
  const opener = document.activeElement;
  const entry = { overlay, dialog };
  dialogStack.push(entry);
  function onKey(e) {
    if (dialogStack[dialogStack.length - 1] !== entry) return; // a dialog above this one handles the key
    if (!overlay.isConnected) { release(); return; }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation(); // the modal / lightbox underneath stays open
      onEscape();
      return;
    }
    if (e.key !== "Tab") return;
    const list = visibleFocusables(dialog);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }
  let released = false;
  function release() {
    if (released) return;
    released = true;
    document.removeEventListener("keydown", onKey, true);
    const i = dialogStack.indexOf(entry);
    if (i >= 0) dialogStack.splice(i, 1);
    // After the current click/key handling (the opener may be disabled for a moment by busyOnClick): back to the
    // opener if it can take focus, otherwise into the dialog that is now on top.
    setTimeout(() => {
      if (opener && opener.isConnected && !opener.disabled && opener !== document.body && typeof opener.focus === "function") {
        opener.focus();
        if (document.activeElement === opener) return;
      }
      const parent = dialogStack[dialogStack.length - 1];
      if (!parent) return;
      const target = visibleFocusables(parent.dialog)[0] || parent.dialog;
      if (target === parent.dialog && !parent.dialog.hasAttribute("tabindex")) parent.dialog.setAttribute("tabindex", "-1");
      target.focus();
    }, 0);
  }
  document.addEventListener("keydown", onKey, true);
  return release;
}
let dialogSeq = 0;

export function confirmDialog(message, { danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const msgId = `dlg-msg-${++dialogSeq}`;
    overlay.innerHTML = `
      <div class="modal confirm-modal" role="alertdialog" aria-modal="true" aria-describedby="${msgId}" aria-label="Confirmare">
        <p id="${msgId}">${esc(message)}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-act="no">Anulează</button>
          <button class="btn ${danger ? "btn-danger" : ""}" data-act="yes">Confirmă</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const release = trapDialog(overlay, overlay.querySelector(".modal"), () => finish(false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
      const act = e.target.closest("[data-act]");
      if (act) finish(act.dataset.act === "yes");
    });
    overlay.querySelector(danger ? '[data-act="no"]' : '[data-act="yes"]').focus();
    let done = false;
    function finish(result) {
      if (done) return;
      done = true;
      overlay.remove();
      release();
      resolve(result);
    }
  });
}

export function openModal(innerHtml, { onClose } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <button class="modal-close" aria-label="Închide">&times;</button>
      <div class="modal-body"></div>
    </div>`;
  overlay.querySelector(".modal-body").innerHTML = innerHtml;
  const dialog = overlay.querySelector(".modal");
  const title = dialog.querySelector(".modal-body h1, .modal-body h2, .modal-body h3");
  if (title) {
    title.id = title.id || `dlg-title-${++dialogSeq}`;
    dialog.setAttribute("aria-labelledby", title.id);
  } else {
    dialog.setAttribute("aria-label", "Fereastră");
  }
  document.body.appendChild(overlay);
  let closed = false;
  const release = trapDialog(overlay, dialog, () => close());
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    release();
    if (onClose) onClose();
  }
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest(".modal-close")) close();
  });
  // Initial focus: the first form field, otherwise the close button.
  const firstField = dialog.querySelector(".modal-body input:not([type=hidden]):not([disabled]), .modal-body select, .modal-body textarea");
  (firstField || dialog.querySelector(".modal-close")).focus();
  return { el: overlay, close };
}

// One-time password (new member, reset, accepted application): never stored in clear, so it is shown exactly once
// in a dialog that closes only with its button (no Escape / backdrop), with a copy button.
export function showOneTimePassword({ title = "Parolă temporară", intro = "", username = "", password }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const id = ++dialogSeq;
    overlay.innerHTML = `
      <div class="modal otp-modal" role="alertdialog" aria-modal="true" aria-labelledby="otp-title-${id}" aria-describedby="otp-note-${id}">
        <h3 id="otp-title-${id}">${esc(title)}</h3>
        ${intro ? `<p>${esc(intro)}</p>` : ""}
        ${username ? `<label class="field-label">Username<input class="input" readonly value="${esc(username)}"></label>` : ""}
        <label class="field-label" for="otp-value-${id}">Parolă temporară</label>
        <div class="otp-row"><input class="input otp-value" id="otp-value-${id}" readonly value="${esc(password)}">
          <button type="button" class="btn btn-ghost" data-copy>Copiază</button></div>
        <p class="muted small" id="otp-note-${id}"><strong>Parola se afișează doar acum</strong> — nu mai poate fi văzută după ce închizi. Comunic-o în afara platformei; la prima autentificare i se cere s-o schimbe.</p>
        <p class="small otp-copied" aria-live="polite"></p>
        <div class="modal-actions-row"><button type="button" class="btn" data-done>Am notat parola, închide</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const field = overlay.querySelector(".otp-value");
    const status = overlay.querySelector(".otp-copied");
    const release = trapDialog(overlay, overlay.querySelector(".modal"), () => {}); // Escape does nothing here
    overlay.querySelector("[data-copy]").addEventListener("click", async () => {
      field.focus();
      field.select();
      try {
        await navigator.clipboard.writeText(password);
        status.textContent = "Copiată.";
      } catch {
        // No clipboard API (http, old browser): the text is selected, the user copies it by hand.
        const ok = (() => { try { return document.execCommand("copy"); } catch { return false; } })();
        status.textContent = ok ? "Copiată." : "Parola e selectată — copiaz-o manual.";
      }
    });
    overlay.querySelector("[data-done]").addEventListener("click", () => {
      overlay.remove();
      release();
      resolve();
    });
    field.focus();
    field.select();
  });
}

// Wraps an async click handler: disables the button + shows a busy state while the
// promise is in flight, prevents double-submit.
export function busyOnClick(btn, handler) {
  btn.addEventListener("click", async (e) => {
    if (btn.disabled) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.classList.add("is-busy");
    try {
      await handler(e);
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-busy");
      if (btn.textContent !== original && btn.dataset.keepLabel !== "1") btn.textContent = original;
    }
  });
}

export function loadingHtml(label = "Se încarcă…") {
  return `<div class="state state-loading"><div class="spinner"></div><p>${esc(label)}</p></div>`;
}
export function emptyHtml(label = "Nimic de afișat.") {
  return `<div class="state state-empty"><p>${esc(label)}</p></div>`;
}
// 403 = retrying cannot help: offer „Înapoi” instead (handled globally in app.js via [data-back]).
export function errorHtml(err, retryLabel = "Reîncearcă") {
  const msg = err && err.message ? err.message : "A apărut o eroare.";
  const forbidden = err && err.status === 403;
  return `<div class="state state-error" role="alert">
      <p>${esc(msg)}</p>
      ${forbidden ? `<button class="btn btn-ghost" data-back>Înapoi</button>` : `<button class="btn btn-ghost" data-retry>${esc(retryLabel)}</button>`}
    </div>`;
}

// Styled file picker with a Romanian label; the chosen file names are filled in by app.js ([data-file-pick]).
export function fileField(id, { accept = "", multiple = false, label = "Alege fișier" } = {}) {
  return `<span class="file-pick" data-file-pick>
      <input type="file" id="${esc(id)}" ${accept ? `accept="${esc(accept)}"` : ""} ${multiple ? "multiple" : ""}>
      <label for="${esc(id)}" class="btn btn-ghost btn-small">${esc(label)}</label>
      <span class="file-pick-name" aria-live="polite">Niciun fișier ales</span>
    </span>`;
}

// Generic render helper: shows loading, then calls fetcher(), then render(data) or errorHtml.
export async function renderAsync(container, fetcher, render, { emptyCheck, emptyLabel } = {}) {
  container.innerHTML = loadingHtml();
  try {
    const data = await fetcher();
    if (emptyCheck && emptyCheck(data)) {
      container.innerHTML = emptyHtml(emptyLabel);
      return data;
    }
    container.innerHTML = "";
    render(data, container);
    return data;
  } catch (err) {
    container.innerHTML = errorHtml(err);
    const retry = container.querySelector("[data-retry]");
    if (retry) retry.addEventListener("click", () => renderAsync(container, fetcher, render, { emptyCheck, emptyLabel }));
    throw err;
  }
}

export function fmtDate(d) {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d.length === 10 ? d + "T00:00:00" : d) : d;
  if (isNaN(date)) return d;
  return date.toLocaleDateString("ro-RO", { day: "2-digit", month: "2-digit", year: "numeric" });
}
export function fmtDateTime(d) {
  if (!d) return "";
  const date = new Date(d);
  if (isNaN(date)) return d;
  return date.toLocaleString("ro-RO", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
// Attendance pct is null when sessions_counted is 0 (no sessions yet this season).
export function fmtPct(pct) {
  return pct == null ? "—" : `${pct.toFixed(0)}%`;
}
export function fmtTime(t) {
  if (!t) return "";
  return t.slice(0, 5);
}
// Local YYYY-MM-DD (no UTC shift bug).
export function todayLocal() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}
export function dateLocal(d) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

// ─── Nivel competiție (regulament) ───
export const COMPETITION_LEVELS = { regional: "Regională", national: "Națională", international: "Internațională" };

export function competitionLevelBadge(level) {
  if (!COMPETITION_LEVELS[level]) return "";
  const hint = level === "international"
    ? ` <span class="muted small">Participare așteptată, fără sancțiuni (Art. 22.2)</span>` : "";
  return `<span class="badge">${esc(COMPETITION_LEVELS[level])}</span>${hint}`;
}

// Select „Nivel competiție”; ascuns până când tipul ales e competiție (vezi wireCompetitionLevel).
export function competitionLevelField(id, current) {
  const sel = COMPETITION_LEVELS[current] ? current : "regional";
  return `<label class="field-label" id="${id}-wrap" style="display:none">Nivel competiție<select class="input" id="${id}">${Object.entries(COMPETITION_LEVELS).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${v}</option>`).join("")}</select></label>`;
}
export function wireCompetitionLevel(root, typeSel, levelId) {
  const t = root.querySelector(typeSel), w = root.querySelector(`#${levelId}-wrap`);
  const sync = () => { w.style.display = t.value === "competitie" ? "" : "none"; };
  t.addEventListener("change", sync);
  sync();
}
