// Profile-completion page (moved out of completare.html: CSP without 'unsafe-inline' for scripts).
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
const token = location.pathname.split("/completare/")[1];

function computeIsMinor(iso) {
  if (!iso) return true;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return true;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age < 18;
}
function updateGuardianVisibility() {
  const minor = computeIsMinor(document.getElementById("birthdate").value);
  document.getElementById("guardian-section").classList.toggle("hidden", !minor);
  document.getElementById("guardian-ack-row").classList.toggle("hidden", !minor);
}

let gdprInfo = null;
fetch("/api/public/informare").then((r) => r.json()).then((d) => {
  gdprInfo = d;
  document.getElementById("footer-note").textContent = d.version ? `Informare GDPR — versiune ${d.version}, ${d.date || ""}` : "";
}).catch(() => {});

(async () => {
  try {
    const res = await fetch(`/api/public/completion/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    document.getElementById("loading-section").classList.add("hidden");
    document.getElementById("form-section").classList.remove("hidden");
    document.getElementById("first_name").value = data.first_name || ""; // server prefill: parts, or a guess to check
    document.getElementById("last_name").value = data.last_name || "";
    document.getElementById("phone").value = data.phone || "";
    document.getElementById("email").value = data.email || "";
    document.getElementById("birthdate").value = data.birthdate || "";
    document.getElementById("class").value = data.class || "";
    document.getElementById("school").value = data.school || "";
    document.getElementById("department").value = data.department || "";
    if (data.guardian) {
      document.getElementById("guardian_name").value = data.guardian.name || "";
      document.getElementById("guardian_relation").value = data.guardian.relation || "";
      document.getElementById("guardian_phone").value = data.guardian.phone || "";
      document.getElementById("guardian_email").value = data.guardian.email || "";
    }
    updateGuardianVisibility();
    document.getElementById("birthdate").addEventListener("change", updateGuardianVisibility);
  } catch (e) {
    document.getElementById("loading-section").classList.add("hidden");
    document.getElementById("invalid-section").classList.remove("hidden");
  }
})();

document.getElementById("open-gdpr").addEventListener("click", (e) => {
  e.preventDefault();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="gdpr-modal-box">${esc(gdprInfo ? gdprInfo.content : "Se încarcă...")}<br><button class="btn" id="close-gdpr">Închide</button></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay || ev.target.id === "close-gdpr") overlay.remove(); });
});

// Art. 72.3: the regulament the box accepts, readable in place (same modal as the GDPR notice).
let regulamentInfo = null;
fetch("/api/public/regulament").then((r) => r.json()).then((d) => { regulamentInfo = d; }).catch(() => {});
document.getElementById("open-regulament").addEventListener("click", (e) => {
  e.preventDefault();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="gdpr-modal-box">${esc(regulamentInfo ? regulamentInfo.content : "Se încarcă...")}<br><button class="btn" id="close-regulament">Închide</button></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay || ev.target.id === "close-regulament") overlay.remove(); });
});

function clearErrors() {
  document.querySelectorAll(".field-error").forEach((el) => (el.textContent = ""));
  document.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  document.getElementById("form-error").textContent = "";
}

document.getElementById("submit-btn").addEventListener("click", async () => {
  clearErrors();
  const btn = document.getElementById("submit-btn");
  const minor = computeIsMinor(document.getElementById("birthdate").value);
  const body = {
    website: document.getElementById("website").value,
    first_name: document.getElementById("first_name").value.trim(),
    last_name: document.getElementById("last_name").value.trim(),
    phone: document.getElementById("phone").value.trim(),
    email: document.getElementById("email").value.trim(),
    birthdate: document.getElementById("birthdate").value,
    class: document.getElementById("class").value.trim(),
    school: document.getElementById("school").value.trim(),
    department: document.getElementById("department").value,
    gdpr_ack: document.getElementById("gdpr_ack").checked,
    regulament_ack: document.getElementById("regulament_ack").checked,
  };
  if (minor) {
    body.guardian_name = document.getElementById("guardian_name").value.trim();
    body.guardian_relation = document.getElementById("guardian_relation").value;
    body.guardian_phone = document.getElementById("guardian_phone").value.trim();
    body.guardian_email = document.getElementById("guardian_email").value.trim();
    body.guardian_ack = document.getElementById("guardian_ack").checked;
  }

  btn.disabled = true;
  try {
    const res = await fetch(`/api/public/completion/${encodeURIComponent(token)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      for (const [field, msg] of Object.entries(data.errors || {})) {
        const el = document.getElementById(`err-${field}`);
        if (el) el.textContent = msg;
        const input = document.getElementById(field);
        if (input) input.setAttribute("aria-invalid", "true");
      }
      document.getElementById("form-error").textContent = data.error || "Nu am putut salva datele.";
      // Scroll to + focus the first visible invalid field (docs/design-pwa-ui.md §D).
      const first = [...document.querySelectorAll(".field-error")].find((el) => el.textContent && el.offsetParent !== null);
      const input = first && document.getElementById(first.id.slice(4));
      const target = input && input.offsetParent !== null ? input : (first || document.getElementById("form-error"));
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      if (target === input) input.focus({ preventScroll: true });
      return;
    }
    document.getElementById("success-text").textContent = data.credentials_sent
      ? `Datele au fost actualizate. Ți-am trimis username-ul (${data.username}) și o parolă temporară pe WhatsApp.`
      : "Datele au fost actualizate.";
    document.getElementById("form-section").classList.add("hidden");
    document.getElementById("success-section").classList.remove("hidden");
  } catch (e) {
    document.getElementById("form-error").textContent = "Eroare de rețea. Verifică conexiunea și reîncearcă.";
  } finally {
    btn.disabled = false;
  }
});
