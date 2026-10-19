const bcrypt = require("bcryptjs");
const db = require("./index");
const { normalizePhone } = require("../domain/phone");

function seed() {
  const count = db.prepare("SELECT COUNT(*) c FROM members").get().c;
  if (count > 0) return;

  const password = process.env.ADMIN_INITIAL_PASSWORD;
  if (!password) {
    console.warn("[SEED] ADMIN_INITIAL_PASSWORD not set, skipping admin seed.");
    return;
  }
  const hash = bcrypt.hashSync(password, 10);
  const name = process.env.ADMIN_FULL_NAME || "Team Leader";
  const username = process.env.ADMIN_USERNAME || "admin";
  const phone = normalizePhone(process.env.ADMIN_PHONE || "") || "pending-admin"; // placeholder until the admin sets a real number
  db.prepare(`
    INSERT INTO members (full_name, username, phone, auth_role, role, status, must_change_password, password_hash, department, joined_at)
    VALUES (?, ?, ?, 'team_leader', 'team_leader', 'activ', 1, ?, 'ambele', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(name, username, phone, hash);
  console.log(`[SEED] Created initial admin ${username}`);
}

module.exports = { seed };
