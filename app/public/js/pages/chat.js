import { api } from "../api.js";
import { esc, linkifyArticles, fmtDateTime, loadingHtml, errorHtml, toast, busyOnClick } from "../ui.js";

export async function mountChat(container) {
  container.innerHTML = `
    <div class="container chat-page">
      <h1>Chat AI</h1>
      <div class="chat-window" id="chat-window" role="log" aria-live="polite" aria-label="Conversația cu CrocoAI">${loadingHtml()}</div>
      <div id="chat-pending" class="chat-pending-bar hidden"></div>
      <div class="chat-input-bar">
        <textarea class="input" id="chat-input" rows="1" placeholder="Scrie un mesaj…" aria-label="Mesaj pentru CrocoAI" enterkeyhint="enter"></textarea>
        <button class="btn" id="chat-send">Trimite</button>
      </div>
    </div>`;

  const windowEl = document.getElementById("chat-window");
  const pendingEl = document.getElementById("chat-pending");
  try {
    const history = await api.get("/api/ai/web-history");
    windowEl.innerHTML = history.length ? history.map(renderMsg).join("") : `<p class="muted">Scrie-i botului CrocoAI — răspunde pe baza regulamentului și a datelor tale.</p>`;
    scrollDown(windowEl);
  } catch (e) { windowEl.innerHTML = errorHtml(e); }

  try {
    const { pending_confirmation } = await api.get("/api/ai/pending");
    renderPending(pendingEl, pending_confirmation);
  } catch (e) { /* non-critical: just skip restoring the pending prompt */ }

  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");
  // Desktop (fine pointer): Enter sends, Shift+Enter = new line. Phone/tablet: Enter = new line, „Trimite” sends.
  const touch = window.matchMedia("(pointer: coarse)").matches;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); send(); }
  });
  const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight + 2, window.innerHeight * 0.4)}px`; };
  input.addEventListener("input", grow);
  busyOnClick(sendBtn, () => send());

  pendingEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-pending-da]")) { input.value = "DA"; send(); }
    if (e.target.closest("[data-pending-cancel]")) { input.value = "Anulează"; send(); }
  });

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    if (windowEl.querySelector(":scope > p.muted")) windowEl.innerHTML = ""; // drop the intro text
    appendUserMsg(windowEl, text);
    input.value = "";
    grow();
    scrollDown(windowEl);
    try {
      const { reply, pending_confirmation } = await api.post("/api/ai/web-chat", { message: text });
      appendAiMsg(windowEl, reply);
      scrollDown(windowEl);
      renderPending(pendingEl, pending_confirmation);
    } catch (e) {
      toast(e.message, "error");
    }
  }
}

function renderPending(pendingEl, pc) {
  if (!pc) { pendingEl.classList.add("hidden"); pendingEl.innerHTML = ""; return; }
  pendingEl.classList.remove("hidden");
  pendingEl.innerHTML = `
    <p>${esc(pc.summary)} <span class="muted small">(expiră ${fmtDateTime(pc.expires_at)})</span></p>
    <div><button class="btn btn-small" data-pending-da>DA</button><button class="btn btn-small btn-ghost" data-pending-cancel>Anulează</button></div>`;
}

function renderMsg(m) {
  return m.message_type === "web-ai" || m.from_me ? aiMsgHtml(m.body) : userMsgHtml(m.body);
}
function userMsgHtml(text) {
  return `<div class="chat-msg chat-msg-user"><div class="chat-bubble">${esc(text)}</div></div>`;
}
// Bot replies use WhatsApp style: *bold*, plus clickable "Art. N" links (escaped first by linkifyArticles).
function aiMsgHtml(text) {
  const html = linkifyArticles(text).replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>");
  return `<div class="chat-msg chat-msg-ai"><div class="chat-bubble">${html}</div></div>`;
}
function appendUserMsg(windowEl, text) { windowEl.insertAdjacentHTML("beforeend", userMsgHtml(text)); }
function appendAiMsg(windowEl, text) { windowEl.insertAdjacentHTML("beforeend", aiMsgHtml(text)); }
function scrollDown(el) { el.scrollTop = el.scrollHeight; }
