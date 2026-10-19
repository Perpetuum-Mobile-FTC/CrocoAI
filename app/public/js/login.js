// Login page (moved out of login.html: CSP without 'unsafe-inline' for scripts, design-securitate A2).
// Return to the requested page after login (e.g. a scanned QR link /p/<token>): js/safe-next.js.
function nextUrl() {
  return window.safeNext(new URLSearchParams(location.search).get("next"), location.origin);
}

// Only probe for an existing session when the hint cookie says there may be one (no 401 on every plain visit).
if (document.cookie.split("; ").includes("crocoai_session=1")) {
  fetch("/api/auth/me", { credentials: "same-origin" })
    .then(r => { if (r.ok) return r.json(); throw new Error(); })
    .then(user => {
      if (user.must_change_password) showChangePassword();
      else window.location.href = nextUrl();
    })
    .catch(() => {});
}

// Real <form>s: Enter submits, password managers recognise the fields.
document.getElementById("login-form").addEventListener("submit", (e) => { e.preventDefault(); doLogin(); });
document.getElementById("change-pw-form").addEventListener("submit", (e) => { e.preventDefault(); doChangePassword(); });

// „Arată parola” toggles.
document.querySelectorAll("[data-pw-toggle]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.pwToggle);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "Ascunde" : "Arată";
    btn.setAttribute("aria-label", show ? "Ascunde parola" : "Arată parola");
    btn.setAttribute("aria-pressed", String(show));
  });
});

async function doLogin() {
  const phone = document.getElementById("phone").value.trim();
  const password = document.getElementById("password").value;
  const errEl = document.getElementById("error");
  errEl.textContent = "";
  if (!phone || !password) {
    errEl.textContent = "Completează utilizatorul și parola.";
    document.getElementById(phone ? "password" : "phone").focus();
    return;
  }
  const btn = document.getElementById("login-btn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", body: JSON.stringify({ phone, password })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Eroare la conectare"; return; }
    if (data.user.must_change_password) showChangePassword();
    else window.location.href = nextUrl();
  } catch (e) { errEl.textContent = "Eroare de rețea. Verifică conexiunea și reîncearcă."; }
  finally { btn.disabled = false; }
}

function showChangePassword() {
  document.getElementById("login-section").classList.add("hidden");
  document.getElementById("change-pw-section").classList.add("active");
  document.getElementById("new-password").focus();
}


async function doChangePassword() {
  const newPw = document.getElementById("new-password").value;
  const confirmPw = document.getElementById("confirm-password").value;
  const errEl = document.getElementById("pw-error");
  errEl.textContent = "";
  if (!newPw || newPw.length < 8) { errEl.textContent = "Parola trebuie să aibă cel puțin 8 caractere."; return; }
  if (newPw !== confirmPw) { errEl.textContent = "Parolele nu coincid"; return; }
  try {
    const res = await fetch("/api/auth/change-password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", body: JSON.stringify({ new_password: newPw })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Eroare"; return; }
    window.location.href = nextUrl();
  } catch (e) { errEl.textContent = "Eroare de rețea. Verifică conexiunea și reîncearcă."; }
}
