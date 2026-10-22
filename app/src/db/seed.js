const bcrypt = require("bcryptjs");
const db = require("./index");
const { normalizePhone } = require("../domain/phone");
const { normalizeNamePart, composeFullName } = require("../domain/name");

// ADMIN_FULL_NAME "Prenume Nume": split on the last space (a single word = just a display name, parts NULL).
function adminName(raw) {
  const full = normalizeNamePart(raw || "Team Leader");
  const i = full.lastIndexOf(" ");
  if (i < 0) return { full_name: full, first_name: null, last_name: null };
  const first_name = full.slice(0, i), last_name = full.slice(i + 1);
  return { full_name: composeFullName(first_name, last_name), first_name, last_name };
}

function seed() {
  const count = db.prepare("SELECT COUNT(*) c FROM members").get().c;
  if (count > 0) return;

  const password = process.env.ADMIN_INITIAL_PASSWORD;
  if (!password) {
    console.warn("[SEED] ADMIN_INITIAL_PASSWORD not set, skipping admin seed.");
    return;
  }
  const hash = bcrypt.hashSync(password, 10);
  const name = adminName(process.env.ADMIN_FULL_NAME);
  const username = process.env.ADMIN_USERNAME || "admin";
  const phone = normalizePhone(process.env.ADMIN_PHONE || "") || "pending-admin"; // placeholder until the admin sets a real number
  db.prepare(`
    INSERT INTO members (full_name, first_name, last_name, username, phone, auth_role, role, status, must_change_password, password_hash, department, joined_at)
    VALUES (?, ?, ?, ?, ?, 'team_leader', 'team_leader', 'activ', 1, ?, 'ambele', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(name.full_name, name.first_name, name.last_name, username, phone, hash);
  console.log(`[SEED] Created initial admin ${username}`);
}

module.exports = { seed, adminName };
