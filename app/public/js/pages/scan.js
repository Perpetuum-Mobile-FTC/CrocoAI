// /p/<token>: the link inside the meeting QR code (design-sedinte-v3.md §2). Any logged-in active member;
// not logged in -> /login?next=/p/<token> (server.js + login.html) and back here.
import { api } from "../api.js";
import { esc } from "../ui.js";

export async function mountScan(container, token) {
  container.innerHTML = `<div class="container"><div class="card scan-result"><p class="muted">Se marchează prezența…</p></div></div>`;
  const box = container.querySelector(".scan-result");
  try {
    const r = await api.post("/api/meetings/scan", { token });
    const already = r.status === "deja marcat";
    box.innerHTML = `
      <div class="scan-icon scan-ok">✅</div>
      <h2>${already ? "Ești deja marcat prezent" : "Prezent"}</h2>
      <p class="scan-title">${esc(r.meeting_title)}</p>
      ${r.extra ? `<p class="muted">Ai fost trecut ca participant extra (ședința nu e pentru grupul / departamentul tău).</p>` : ""}
      <a href="/" data-link class="btn">Acasă</a>`;
  } catch (e) {
    box.innerHTML = `
      <div class="scan-icon">⚠️</div>
      <h2>Prezența nu a fost marcată</h2>
      <p>${esc(e.message)}</p>
      <a href="/" data-link class="btn btn-ghost">Acasă</a>`;
  }
}
