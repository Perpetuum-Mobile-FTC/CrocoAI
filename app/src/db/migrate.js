// Applies the numbered migrations (src/db/migrations/*.sql|*.js, in name order) not yet listed in
// `_migrations`, each in its own transaction. Takes the connection so tests can migrate throwaway DBs
// (test/f2-migrations.test.js); src/db/index.js runs it on the app DB at startup.
const path = require("path");
const fs = require("fs");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") || f.endsWith(".js")).sort();
}

// { until: "010_..." } stops after that file (inclusive); beforeApply(applied) runs once when something is pending.
function migrate(db, { until, beforeApply = () => {}, log = (m) => console.log(m) } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const applied = new Set(db.prepare("SELECT name FROM _migrations").all().map((r) => r.name));
  const files = migrationFiles().filter((f) => !until || f <= until);
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) return [];

  beforeApply(applied);

  for (const file of pending) {
    db.exec("BEGIN");
    try {
      if (file.endsWith(".sql")) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
      } else {
        require(path.join(MIGRATIONS_DIR, file)).up(db);
      }
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
      db.exec("COMMIT");
      log(`[DB] Applied migration ${file}`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return pending;
}

module.exports = { migrate, migrationFiles, MIGRATIONS_DIR };
