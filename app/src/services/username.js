const crypto = require("crypto");
const db = require("../db");
const { TEMP_PASSWORD_LENGTH } = require("../domain/rules");

// Strips diacritics and normalizes a name into "firstname.lastname" form.
function slugify(str) {
  return String(str || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .trim()
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

// Generates a unique username like "ion.popescu" (adds numeric suffix on collision).
function generateUsername(fullName) {
  const parts = slugify(fullName);
  let base = parts.length >= 2 ? parts[0] + "." + parts[parts.length - 1] : (parts[0] || "membru");
  let username = base;
  let n = 1;
  const exists = db.prepare("SELECT 1 FROM members WHERE username = ?");
  while (exists.get(username)) {
    n++;
    username = base + n;
  }
  return username;
}

// Temporary passwords (create, reset, completion, onboarding): CSPRNG, no look-alike characters.
function randomPassword(len = TEMP_PASSWORD_LENGTH) {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

module.exports = { generateUsername, randomPassword, slugify };
