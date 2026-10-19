const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { snapshot } = require("./snapshot");
const { migrate } = require("./migrate");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "..", "data", "crocoai.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Consistent snapshot to data/backups/pre-migration-<timestamp>.db before applying anything
// pending (design v2 §6).
function backupBeforeMigration(applied) {
  if (applied.size === 0) return; // fresh install: nothing to protect yet
  const backupDir = path.join(path.dirname(DB_PATH), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(backupDir, `pre-migration-${stamp}-${process.pid}.db`); // VACUUM INTO never overwrites
  snapshot(db, dest);
  console.log(`[DB] Backup before migration: ${dest}`);
}

migrate(db, { beforeApply: backupBeforeMigration });

module.exports = db;
