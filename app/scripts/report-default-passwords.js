// READ-ONLY report (security package A1, docs/design-securitate-2026-10.md): accounts still on the old shared
// default password "perpetuum2026" (bcrypt compare), with last_login so the never-logged-in ones stand out.
// Changes nothing - opens the DB read-only and does NOT require src/db (that would run migrations).
//
// Usage (in the container):  node scripts/report-default-passwords.js [path/to/crocoai.db]
// Default DB: $DB_PATH or data/crocoai.db. Extra candidates: DEFAULT_PASSWORDS="pw1,pw2".
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const file = process.argv[2] || process.env.DB_PATH || path.join(__dirname, "..", "data", "crocoai.db");
const candidates = ["perpetuum2026", ...(process.env.DEFAULT_PASSWORDS || "").split(",").map((s) => s.trim()).filter(Boolean)];
const db = new Database(file, { readonly: true, fileMustExist: true });

const rows = db.prepare(`
  SELECT id, full_name, username, role, status, must_change_password, last_login, password_hash
  FROM members WHERE password_hash IS NOT NULL AND status != 'iesit' ORDER BY last_login IS NOT NULL, full_name
`).all();
const hits = rows.filter((m) => candidates.some((pw) => bcrypt.compareSync(pw, m.password_hash)));

console.log(`DB: ${file} - ${hits.length} of ${rows.length} active accounts still accept the default password.`);
for (const m of hits) {
  console.log([m.id, m.full_name, m.username, m.role, m.status, `must_change=${m.must_change_password}`, `last_login=${m.last_login || "NICIODATĂ"}`].join("\t"));
}
db.close();
