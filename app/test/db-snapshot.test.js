const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { snapshot } = require("../src/db/snapshot");

test("snapshot includes data that only exists in the WAL file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crocoai-snap-"));
  const db = new Database(path.join(dir, "live.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec("CREATE TABLE t (v TEXT)");
  db.prepare("INSERT INTO t VALUES (?)").run("only-in-wal");

  const dest = path.join(dir, "it's-a-backup.db"); // quote in path on purpose
  snapshot(db, dest);
  const copy = new Database(dest, { readonly: true });
  assert.equal(copy.prepare("SELECT v FROM t").get().v, "only-in-wal");
  copy.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
