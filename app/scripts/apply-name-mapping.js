// Splits existing members' names into Prenume + Nume de familie from an explicit mapping (migration 029 leaves
// the parts NULL - names are never guess-split). The mapping file holds real names: keep it out of the repo.
// Usage: node scripts/apply-name-mapping.js mapping.json [--dry-run]
//   mapping.json: { "<member id>": ["Prenume", "Nume"], ... }
// Sets first_name, last_name (normalized) and full_name = "Prenume Nume" in one transaction. DB: DB_PATH or the
// app default (data/crocoai.db). Pure domain + better-sqlite3 only (no services, no migrations run here).
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { validateNameParts } = require("../src/domain/name");

function loadMapping(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The mapping must be an object { id: [first, last] }.");
  return Object.entries(raw).map(([id, parts]) => {
    if (!/^\d+$/.test(id) || !Array.isArray(parts) || parts.length !== 2) throw new Error(`Bad entry for id ${id}: expected ["Prenume", "Nume"].`);
    const { errors, value } = validateNameParts({ first_name: parts[0], last_name: parts[1] });
    if (Object.keys(errors).length) throw new Error(`id ${id}: ${Object.values(errors).join(" ")}`);
    return { id: Number(id), ...value };
  });
}

// Returns the printed lines; writes nothing when dryRun. Throws (nothing written) on an unknown id.
function applyMapping(db, entries, { dryRun = false } = {}) {
  const get = db.prepare("SELECT id, full_name FROM members WHERE id = ?");
  const set = db.prepare("UPDATE members SET first_name = ?, last_name = ?, full_name = ? WHERE id = ?");
  const lines = [];
  db.transaction(() => {
    for (const e of entries) {
      const m = get.get(e.id);
      if (!m) throw new Error(`Member ${e.id} not found - nothing was written.`);
      lines.push(`${e.id}: ${m.full_name} -> ${e.full_name}`);
      if (!dryRun) set.run(e.first_name, e.last_name, e.full_name, e.id);
    }
  })();
  lines.push(`${dryRun ? "Would update" : "Updated"} ${entries.length} member(s).${dryRun ? " (dry run, nothing written)" : ""}`);
  return lines;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) { console.error("Usage: node scripts/apply-name-mapping.js mapping.json [--dry-run]"); process.exit(1); }
  const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "data", "crocoai.db");
  if (!fs.existsSync(dbPath)) { console.error(`DB not found: ${dbPath}`); process.exit(1); }
  const db = new Database(dbPath);
  try {
    const cols = db.prepare("PRAGMA table_info(members)").all().map((c) => c.name);
    if (!cols.includes("first_name")) throw new Error("members.first_name is missing - start the app once so migration 029 runs.");
    for (const line of applyMapping(db, loadMapping(file), { dryRun })) console.log(line);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { loadMapping, applyMapping };
