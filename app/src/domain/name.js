// Member names: "Prenume Nume" (first name, then family name). members.first_name / last_name hold the parts,
// members.full_name is the display name used everywhere and is always composeFullName(first, last) when the
// parts are set. A legacy single name (CSV/vCard import, old clients, the WhatsApp onboarding dialog) is only
// normalized for capitalization and leaves the parts NULL - names are never guess-split when stored.
const MAX_PART = 60;
const PART_RE = /^[\p{L}\p{M}' ’-]+$/u;

// Trim, collapse spaces (also around hyphens), every word and every hyphen/apostrophe-separated piece with the
// first letter uppercase and the rest lowercase (Romanian locale, diacritics kept): "ana-maria" -> "Ana-Maria".
function normalizeNamePart(s) {
  return String(s == null ? "" : s)
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/ ?- ?/g, "-")
    .toLocaleLowerCase("ro")
    .replace(/(^|[ '’-])(\p{L})/gu, (_, sep, ch) => sep + ch.toLocaleUpperCase("ro"));
}

function composeFullName(first, last) {
  return `${normalizeNamePart(first)} ${normalizeNamePart(last)}`.trim();
}

const LABELS = {
  first_name: { missing: "Completează prenumele.", subject: "Prenumele" },
  last_name: { missing: "Completează numele de familie.", subject: "Numele de familie" },
};

// Error text for one part (already normalized) or null.
function namePartError(field, value) {
  const l = LABELS[field];
  if (!value) return l.missing;
  if (value.length > MAX_PART) return `${l.subject} poate avea cel mult ${MAX_PART} de caractere.`;
  if (!PART_RE.test(value) || !/\p{L}/u.test(value)) return `${l.subject} poate conține doar litere, spațiu, cratimă și apostrof.`;
  return null;
}

// { first_name, last_name } -> { errors, value: { first_name, last_name, full_name } } (both parts required).
function validateNameParts(data) {
  const errors = {};
  const value = {};
  for (const field of ["first_name", "last_name"]) {
    const v = normalizeNamePart((data || {})[field]);
    const err = namePartError(field, v);
    if (err) errors[field] = err;
    else value[field] = v;
  }
  if (!Object.keys(errors).length) value.full_name = composeFullName(value.first_name, value.last_name);
  return { errors, value };
}

const hasParts = (data) => !!data && (data.first_name !== undefined || data.last_name !== undefined);

// A legacy single name written over a member: the parts stay only if it is the same name (capitalization
// aside), otherwise they are cleared so full_name never disagrees with them.
function legacyNameColumns(name, current = {}) {
  const full_name = normalizeNamePart(name);
  const same = current.first_name && current.last_name &&
    composeFullName(current.first_name, current.last_name).toLocaleLowerCase("ro") === full_name.toLocaleLowerCase("ro");
  return same
    ? { full_name: composeFullName(current.first_name, current.last_name), first_name: current.first_name, last_name: current.last_name }
    : { full_name, first_name: null, last_name: null };
}

// Best-effort prefill when only full_name is known: last word = family name, the rest = first name. Shown in an
// editable form for a person to check - never stored without someone confirming it.
function splitForPrefill(full) {
  const words = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { first_name: words[0] || "", last_name: "" };
  return { first_name: words.slice(0, -1).join(" "), last_name: words[words.length - 1] };
}

module.exports = { MAX_PART, normalizeNamePart, composeFullName, namePartError, validateNameParts, hasParts, legacyNameColumns, splitForPrefill };
