// Upserts members from a JSON file: [{full_name, phone, email?}]
// Usage: node scripts/import-members.js path/to/members.json
// Goes through the same domain/services/members.js preview+commit used by
// POST /api/admin/import/preview + /commit, so role/status/phone-normalization stay consistent
// with the web UI's import flow (design v2 §6).
const fs = require("fs");
const path = require("path");

// Minimal .env loader (no extra dependency) so DB_PATH etc. are picked up when run standalone.
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || "").trim();
  }
}

const db = require("../src/db");
const members = require("../src/services/members");

function main() {
  const file = process.argv[2];
  if (!file) { console.error("Usage: node scripts/import-members.js members.json"); process.exit(1); }
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = list.map((entry) => ({ name: entry.full_name || entry.name, phone: entry.phone, email: entry.email }));

  // Script-level import needs LEADERS rights; there's no logged-in operator here, so we impersonate
  // the first team_leader found in the DB (same actor the web UI would use).
  const actor = db.prepare("SELECT * FROM members WHERE role = 'team_leader' LIMIT 1").get();
  if (!actor) { console.error("No team_leader found in DB - run this after the initial admin seed."); process.exit(1); }

  const results = members.commitImport(actor, rows);
  const created = results.filter((r) => r.action === "create").length;
  const updated = results.filter((r) => r.action === "update").length;
  const skipped = results.filter((r) => r.action === "skip_invalid_phone").length;
  console.log(`[IMPORT] Created ${created}, updated ${updated}, skipped ${skipped} (invalid phone).`);
  // Each new account has its own random temporary password (must be changed at first login), shown only here.
  for (const r of results.filter((x) => x.password)) console.log(`  ${r.name}\t${r.username}\t${r.password}`);
}

main();
