// The ONLY definition of the member profile schema (design-formular-date.md §1). Used by the
// public application form, the completion form, Admin → Membri edit, and the AI agent.
const { normalizePhone } = require("./phone");
const { isMinor, passwordError } = require("./rules");
const { TEAM } = require("./team");

const DEPARTMENTS = ["tehnic", "non-tehnic", "ambele"];
const GUARDIAN_RELATIONS = ["mama", "tata", "tutore", "altul"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FIELD_LABELS = {
  full_name: "numele complet",
  phone: "telefon",
  email: "email",
  birthdate: "data nașterii",
  class: "clasă",
  school: "școală",
  department: "departament",
  guardian: "datele părintelui/tutorelui",
  guardian_name: "numele părintelui/tutorelui",
  guardian_relation: "relația părintelui/tutorelui",
  guardian_phone: "telefonul părintelui/tutorelui",
  motivation: "motivația",
  gdpr_ack: "confirmarea informării GDPR",
  guardian_ack: "acordul părintelui/tutorelui",
  username: "username",
  password: "parola",
};

// Self-registration (docs/design-inregistrare.md §1).
const ROLE_CHOICES = ["recrut", "membru", "head_tech", "head_nontech", "co_leader", "team_leader", "mentor"];
const OTHER_SCHOOL = "Altă școală";
const SCHOOLS = [...TEAM.schools, OTHER_SCHOOL]; // the team's schools: src/domain/team.js
const USERNAME_RE = /^[a-z0-9.-]{3,30}$/;

// Accepts "dd.mm.yyyy" or ISO "yyyy-mm-dd". Returns ISO or null.
function parseBirthdate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm}-${dd}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function plausibleAge(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const mm = now.getMonth() - d.getMonth();
  if (mm < 0 || (mm === 0 && now.getDate() < d.getDate())) age--;
  return age >= 10 && age <= 25;
}

// validateProfile(input, { mode: "public" | "completion" | "admin" }) -> { ok, errors, value }
// "public"/"completion" require the GDPR consents + (for minors) guardian data; "public" also
// requires the motivation text. "admin" (members.update) skips consents - LEADERS enter data on
// someone's behalf and the consent audit trail only makes sense for self-service submissions.
function validateProfile(input, { mode = "admin" } = {}) {
  if (mode === "register") return validateRegistration(input);
  const data = input || {};
  const errors = {};
  const value = {};

  const name = String(data.full_name || "").trim();
  if (!name || name.split(/\s+/).filter(Boolean).length < 2) {
    errors.full_name = "Introdu numele complet (prenume și nume).";
  } else {
    value.full_name = name;
  }

  const digits = data.phone ? normalizePhone(data.phone) : null;
  if (!digits) errors.phone = "Numărul de telefon nu este valid.";
  else value.phone = digits;

  const email = String(data.email || "").trim();
  if (!email || !EMAIL_RE.test(email)) errors.email = "Adresa de email nu este validă.";
  else value.email = email;

  const iso = parseBirthdate(data.birthdate);
  if (!iso || !plausibleAge(iso)) errors.birthdate = "Data nașterii nu este validă (vârstă așteptată între 10 și 25 de ani).";
  else value.birthdate = iso;

  if (!String(data.class || "").trim()) errors.class = "Completează clasa.";
  else value.class = String(data.class).trim();

  if (!String(data.school || "").trim()) errors.school = "Completează școala.";
  else value.school = String(data.school).trim();

  if (!DEPARTMENTS.includes(data.department)) errors.department = "Alege un departament.";
  else value.department = data.department;

  const minor = value.birthdate ? isMinor(value.birthdate) : true;
  value.is_minor = minor;

  if (minor) {
    const gname = String(data.guardian_name || "").trim();
    if (!gname) errors.guardian_name = "Numele părintelui/tutorelui e obligatoriu pentru minori.";
    else value.guardian_name = gname;

    if (!GUARDIAN_RELATIONS.includes(data.guardian_relation)) errors.guardian_relation = "Alege relația (mamă/tată/tutore/altul).";
    else value.guardian_relation = data.guardian_relation;

    const gdigits = data.guardian_phone ? normalizePhone(data.guardian_phone) : null;
    if (!gdigits) errors.guardian_phone = "Telefonul părintelui/tutorelui nu este valid.";
    else value.guardian_phone = gdigits;

    if (data.guardian_email) {
      const ge = String(data.guardian_email).trim();
      if (!EMAIL_RE.test(ge)) errors.guardian_email = "Adresa de email a părintelui/tutorelui nu este validă.";
      else value.guardian_email = ge;
    }
  }

  if (mode === "public") {
    const motivation = String(data.motivation || "").trim();
    if (!motivation) errors.motivation = "Spune-ne de ce vrei să intri în echipă.";
    else if (motivation.length > 1000) errors.motivation = "Motivația poate avea cel mult 1000 de caractere.";
    else value.motivation = motivation;

    if (data.source) value.source = String(data.source).trim().slice(0, 300);
  }

  if (mode === "public" || mode === "completion") {
    if (!data.gdpr_ack) errors.gdpr_ack = "Trebuie să confirmi că ai citit informarea privind prelucrarea datelor.";
    else value.gdpr_ack = true;
    if (minor) {
      if (!data.guardian_ack) errors.guardian_ack = "Este nevoie de acordul părintelui/tutorelui.";
      else value.guardian_ack = true;
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, value };
}

// mode "register": per-role field table. Returns value.requested_role (leadership roles apply
// only after confirmation), value.role (what the account starts as) and value.is_mentor.
function validateRegistration(input) {
  const data = input || {};
  const errors = {};
  const value = {};

  const choice = data.role_choice;
  if (!ROLE_CHOICES.includes(choice)) errors.role_choice = "Alege rolul tău în echipă.";
  else {
    value.role_choice = choice;
    value.role = choice === "recrut" ? "volunteer" : "member";
    value.requested_role = ["recrut", "membru"].includes(choice) ? null : choice;
  }
  const mentor = choice === "mentor";
  value.is_mentor = mentor;

  const name = String(data.full_name || "").trim();
  if (name.split(/\s+/).filter(Boolean).length < 2) errors.full_name = "Introdu numele complet (prenume și nume).";
  else value.full_name = name;

  const digits = data.phone ? normalizePhone(data.phone) : null;
  if (!digits) errors.phone = "Numărul de telefon nu este valid.";
  else value.phone = digits;

  const username = String(data.username || "").trim().toLowerCase();
  if (!USERNAME_RE.test(username) || !/[a-z]/.test(username)) errors.username = "Username: 3-30 caractere, doar litere mici, cifre, punct și cratimă, cu cel puțin o literă.";
  else if (normalizePhone(username)) errors.username = "Username-ul nu poate fi un număr de telefon.";
  else value.username = username;

  const password = String(data.password || "");
  const pwError = passwordError(password); // the one password policy (rules.js, A1)
  if (pwError) errors.password = pwError;
  else value.password = password;
  if (!errors.password && data.password_confirm !== password) errors.password_confirm = "Parolele nu coincid.";

  const email = String(data.email || "").trim();
  if (!EMAIL_RE.test(email)) errors.email = "Adresa de email nu este validă.";
  else value.email = email;

  let minor = false;
  if (mentor) {
    value.department = "ambele";
  } else {
    const school = String(data.school || "").trim();
    if (!SCHOOLS.includes(school)) errors.school = "Alege școala.";
    else if (school === OTHER_SCHOOL) {
      const other = String(data.school_other || "").trim();
      if (!other) errors.school_other = "Scrie numele școlii.";
      else value.school = other.slice(0, 120);
    } else value.school = school;
    const emailErr = schoolEmailError(school, value.email);
    if (emailErr) errors.email = emailErr;

    if (!String(data.class || "").trim()) errors.class = "Completează clasa.";
    else value.class = String(data.class).trim();

    const iso = parseBirthdate(data.birthdate);
    if (!iso || !plausibleAge(iso)) errors.birthdate = "Data nașterii nu este validă (vârstă așteptată între 10 și 25 de ani).";
    else value.birthdate = iso;

    if (choice === "head_tech") value.department = "tehnic";
    else if (choice === "head_nontech") value.department = "non-tehnic";
    else if (!DEPARTMENTS.includes(data.department)) errors.department = "Alege un departament.";
    else value.department = data.department;

    minor = value.birthdate ? isMinor(value.birthdate) : false;
    if (minor) {
      const gname = String(data.guardian_name || "").trim();
      if (!gname) errors.guardian_name = "Numele părintelui/tutorelui e obligatoriu pentru minori.";
      else value.guardian_name = gname;
      if (!GUARDIAN_RELATIONS.includes(data.guardian_relation)) errors.guardian_relation = "Alege relația (mamă/tată/tutore/altul).";
      else value.guardian_relation = data.guardian_relation;
      const gdigits = data.guardian_phone ? normalizePhone(data.guardian_phone) : null;
      if (!gdigits) errors.guardian_phone = "Telefonul părintelui/tutorelui nu este valid.";
      else value.guardian_phone = gdigits;
      if (data.guardian_email) {
        const ge = String(data.guardian_email).trim();
        if (!EMAIL_RE.test(ge)) errors.guardian_email = "Adresa de email a părintelui/tutorelui nu este validă.";
        else value.guardian_email = ge;
      }
    }

    if (choice === "recrut") {
      const motivation = String(data.motivation || "").trim();
      if (!motivation) errors.motivation = "Spune-ne de ce vrei să intri în echipă.";
      else if (motivation.length > 1000) errors.motivation = "Motivația poate avea cel mult 1000 de caractere.";
      else value.motivation = motivation;
    }
  }
  value.is_minor = minor;

  if (!data.gdpr_ack) errors.gdpr_ack = "Trebuie să confirmi că ai citit informarea privind prelucrarea datelor.";
  else value.gdpr_ack = true;
  if (minor) {
    if (!data.guardian_ack) errors.guardian_ack = "Este nevoie de acordul părintelui/tutorelui.";
    else value.guardian_ack = true;
  }

  return { ok: Object.keys(errors).length === 0, errors, value };
}

// „Contul meu”: the fields a member edits on their own account (members.updateOwn). Partial: only the keys sent.
// Name, phone (the bot's identity, verified), department and role stay with the leaders.
// birthdate stays with leaders: it decides the minor documents (Art. 14.2) and the guardian requirement.
// A school listed in TEAM.schoolEmailDomains requires its students' email on that domain.
function schoolEmailError(school, email) {
  const domain = TEAM.schoolEmailDomains[school];
  if (domain && email && !email.toLowerCase().endsWith(domain.toLowerCase())) return `Elevii de la ${school} folosesc adresa de email ${domain}.`;
  return null;
}

const OWN_EDITABLE = ["email", "class", "school"];
function validateOwnEdit(input) {
  const data = input || {};
  const errors = {};
  const value = {};
  if (data.email !== undefined) {
    const email = String(data.email || "").trim();
    if (email && !EMAIL_RE.test(email)) errors.email = "Adresa de email nu este validă.";
    else value.email = email || null;
  }
  for (const k of ["class", "school"]) {
    if (data[k] === undefined) continue;
    const v = String(data[k] || "").trim();
    if (v.length > 120) errors[k] = "Cel mult 120 de caractere.";
    else value[k] = v || null;
  }
  return { ok: Object.keys(errors).length === 0, errors, value };
}

// Missing core fields on an existing member (badge in Membri/Acasă + AI tools, same code
// everywhere - design-formular-date.md §3). `hasGuardian` must be computed by the caller
// (profile.js stays DB-free); pass true if unknown/not applicable to skip that check.
function missingFields(member, hasGuardian = true) {
  if (!member) return ["full_name", "phone", "email", "birthdate", "class", "school"];
  const missing = [];
  if (!member.email) missing.push("email");
  if (!member.birthdate) missing.push("birthdate");
  if (!member.class) missing.push("class");
  if (!member.school) missing.push("school");
  if (isMinor(member.birthdate) && !hasGuardian) missing.push("guardian");
  return missing;
}

module.exports = {
  DEPARTMENTS,
  ROLE_CHOICES,
  SCHOOLS,
  OTHER_SCHOOL,
  GUARDIAN_RELATIONS,
  FIELD_LABELS,
  parseBirthdate,
  validateProfile,
  OWN_EDITABLE,
  validateOwnEdit,
  schoolEmailError,
  missingFields,
};
