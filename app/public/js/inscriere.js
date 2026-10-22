// Registration page (moved out of inscriere.html: CSP without 'unsafe-inline' for scripts). Two steps since
// security package A3: the form sends a WhatsApp code, the code creates the account.
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

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

const $ = (id) => document.getElementById(id);
const HEADS = { head_tech: "tehnic", head_nontech: "non-tehnic" };

// Sections depend on the chosen role (docs/design-inregistrare.md §1).
function updateVisibility() {
  const role = $("role_choice").value;
  const mentor = role === "mentor";
  const minor = !mentor && computeIsMinor($("birthdate").value);
  $("student-section").classList.toggle("hidden", mentor);
  $("department-wrap").classList.toggle("hidden", role in HEADS);
  $("motivation-wrap").classList.toggle("hidden", role !== "recrut");
  $("role-note").classList.toggle("hidden", !["head_tech", "head_nontech", "co_leader", "team_leader", "mentor"].includes(role));
  $("school_other").classList.toggle("hidden", $("school").value !== "Altă școală");
  $("school_other_label").classList.toggle("hidden", $("school").value !== "Altă școală");
  // A school with a required email domain carries it on its <option> (server-side, src/domain/team.js).
  const domain = ($("school").selectedOptions[0] || {}).dataset?.emailDomain;
  $("email-note").textContent = domain ? `Pentru ${$("school").value} folosește adresa ${domain}.` : "";
  $("email-note").classList.toggle("hidden", !domain);
  $("guardian-section").classList.toggle("hidden", !minor);
  $("guardian-ack-row").classList.toggle("hidden", !minor);
}
for (const id of ["role_choice", "birthdate", "school"]) $(id).addEventListener("change", updateVisibility);
updateVisibility();

let gdprInfo = null;
fetch("/api/public/informare").then((r) => r.json()).then((d) => {
  gdprInfo = d;
  document.getElementById("footer-note").textContent = d.version ? `Informare GDPR — versiune ${d.version}, ${d.date || ""}` : "";
}).catch(() => {});

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

// Server field errors: shown under each field, the field marked invalid, and the first visible one
// scrolled into view and focused (docs/design-pwa-ui.md §D) - otherwise the message sits off-screen.
function showFieldErrors(errors) {
  for (const [field, msg] of Object.entries(errors || {})) {
    const errEl = document.getElementById(`err-${field}`);
    if (errEl) errEl.textContent = msg;
    const input = document.getElementById(field);
    if (input) {
      input.setAttribute("aria-invalid", "true");
      if (errEl) input.setAttribute("aria-describedby", errEl.id);
    }
  }
  const firstErr = [...document.querySelectorAll(".field-error")].find((el) => el.textContent && el.offsetParent !== null);
  if (!firstErr) return false;
  const input = document.getElementById(firstErr.id.slice(4));
  const target = input && input.offsetParent !== null ? input : firstErr;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  if (target === input) input.focus({ preventScroll: true });
  return true;
}

document.getElementById("submit-btn").addEventListener("click", async () => {
  clearErrors();
  const btn = $("submit-btn");
  const role = $("role_choice").value;
  const mentor = role === "mentor";
  const minor = !mentor && computeIsMinor($("birthdate").value);
  const body = {
    website: $("website").value,
    role_choice: role,
    first_name: $("first_name").value.trim(),
    last_name: $("last_name").value.trim(),
    phone: $("phone").value.trim(),
    email: $("email").value.trim(),
    username: $("username").value.trim().toLowerCase(),
    password: $("password").value,
    password_confirm: $("password_confirm").value,
    gdpr_ack: $("gdpr_ack").checked,
    regulament_ack: $("regulament_ack").checked,
  };
  if (!mentor) {
    body.school = $("school").value;
    body.school_other = $("school_other").value.trim();
    body.class = $("class").value.trim();
    body.birthdate = $("birthdate").value;
    body.department = role in HEADS ? HEADS[role] : $("department").value;
  }
  if (role === "recrut") body.motivation = $("motivation").value.trim();
  if (pendingId) body.pending_id = pendingId; // corrected form: replaces our own pending registration
  if (minor) {
    body.guardian_name = $("guardian_name").value.trim();
    body.guardian_relation = $("guardian_relation").value;
    body.guardian_phone = $("guardian_phone").value.trim();
    body.guardian_email = $("guardian_email").value.trim();
    body.guardian_ack = $("guardian_ack").checked;
  }

  btn.disabled = true;
  try {
    const res = await fetch("/api/public/register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      $("form-error").textContent = data.error || "Nu am putut crea contul.";
      if (!showFieldErrors(data.errors)) $("form-error").scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (!data.pending_id) return; // honeypot answer
    showCodeStep(data);
  } catch (e) {
    $("form-error").textContent = "Eroare de rețea. Verifică conexiunea și reîncearcă.";
  } finally {
    btn.disabled = false;
  }
});

// ── Step 2: the 6-digit code sent on WhatsApp (security package A3) ─────────────────────────────
let pendingId = null;
let resendTimer = null;

function showCodeStep(data) {
  pendingId = data.pending_id;
  $("form-section").classList.add("hidden");
  $("code-section").classList.remove("hidden");
  $("code-phone").textContent = data.phone_hint || "";
  $("code-ttl").textContent = String(data.code_ttl_min || 10);
  $("code").value = "";
  $("code-error").textContent = "";
  $("code").focus();
  startResendCountdown(data.resend_after_sec || 60);
}

function startResendCountdown(sec) {
  clearInterval(resendTimer);
  let left = sec;
  const btn = $("resend-btn");
  const tick = () => {
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `Retrimite codul (${left} s)` : "Retrimite codul";
    left--;
    if (left < 0) clearInterval(resendTimer);
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { res, data: await res.json().catch(() => ({})) };
}

async function verifyCode() {
  const code = $("code").value.replace(/\D/g, "");
  $("code-error").textContent = "";
  $("code-info").textContent = "";
  if (code.length !== 6) { $("code-error").textContent = "Codul are 6 cifre."; return; }
  const btn = $("verify-btn");
  btn.disabled = true;
  try {
    const { res, data } = await postJson("/api/public/register/verify", { pending_id: pendingId, code });
    if (res.ok) { location.href = data.redirect || "/"; return; }
    $("code-error").textContent = data.error || "Codul nu a putut fi verificat.";
    if (res.status === 404 || data.errors) backToForm(data);
  } catch (e) {
    $("code-error").textContent = "Eroare de rețea. Verifică conexiunea și reîncearcă.";
  } finally {
    btn.disabled = false;
  }
}

function backToForm(data) {
  clearInterval(resendTimer);
  if (data) pendingId = null; // the server dropped it (expired, or data taken meanwhile): next submit starts fresh
  $("code-section").classList.add("hidden");
  $("form-section").classList.remove("hidden");
  $("form-error").textContent = (data && data.error) || "";
  showFieldErrors(data && data.errors);
}

$("verify-btn").addEventListener("click", verifyCode);
$("code").addEventListener("keydown", (e) => { if (e.key === "Enter") verifyCode(); });
$("change-data-btn").addEventListener("click", (e) => { e.preventDefault(); backToForm(null); });
$("resend-btn").addEventListener("click", async () => {
  $("code-error").textContent = "";
  $("code-info").textContent = "";
  $("resend-btn").disabled = true;
  try {
    const { res, data } = await postJson("/api/public/register/resend", { pending_id: pendingId });
    if (res.ok) {
      $("code-info").textContent = "Ți-am trimis un cod nou. Cel vechi nu mai e valabil.";
      startResendCountdown(data.resend_after_sec || 60);
      return;
    }
    $("code-error").textContent = data.error || "Nu am putut retrimite codul.";
    if (res.status === 404) backToForm(data);
    else $("resend-btn").disabled = false;
  } catch (e) {
    $("code-error").textContent = "Eroare de rețea. Verifică conexiunea și reîncearcă.";
    $("resend-btn").disabled = false;
  }
});
