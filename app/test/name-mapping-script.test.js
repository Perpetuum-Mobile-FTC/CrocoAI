// scripts/apply-name-mapping.js on a throwaway DB (migrated with the app migrations): dry run, real run, rollback.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");
const { migrate } = require("../src/db/migrate");
const { loadMapping, applyMapping } = require("../scripts/apply-name-mapping");

test("apply-name-mapping: dry run writes nothing, real run sets the 3 columns in one transaction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "name-map-"));
  const dbFile = path.join(dir, "map.db");
  const tmp = new Database(dbFile);
  migrate(tmp, { log: () => {} });
  const ins = tmp.prepare("INSERT INTO members (full_name, username, phone, role, auth_role, status) VALUES (?, ?, ?, 'member', 'member', 'activ')");
  const a = ins.run("POPESCU ana", "a1", "40711000001").lastInsertRowid;
  const b = ins.run("ion vasile", "b1", "40711000002").lastInsertRowid;
  tmp.close();
  const mapFile = path.join(dir, "map.json");
  fs.writeFileSync(mapFile, JSON.stringify({ [a]: ["ANA", "popescu"], [b]: ["ion", "vasile"] }));
  const script = path.join(__dirname, "..", "scripts", "apply-name-mapping.js");
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { env: { ...process.env, DB_PATH: dbFile }, encoding: "utf8" });

  const dry = run(mapFile, "--dry-run");
  assert.match(dry, new RegExp(`${a}: POPESCU ana -> Ana Popescu`));
  assert.match(dry, /Would update 2 member\(s\)/);
  let check = new Database(dbFile, { readonly: true });
  assert.equal(check.prepare("SELECT full_name FROM members WHERE id = ?").get(a).full_name, "POPESCU ana");
  check.close();

  const real = run(mapFile);
  assert.match(real, /Updated 2 member\(s\)/);
  check = new Database(dbFile);
  assert.deepEqual(check.prepare("SELECT first_name, last_name, full_name FROM members WHERE id = ?").get(a), { first_name: "Ana", last_name: "Popescu", full_name: "Ana Popescu" });
  assert.deepEqual(check.prepare("SELECT first_name, last_name, full_name FROM members WHERE id = ?").get(b), { first_name: "Ion", last_name: "Vasile", full_name: "Ion Vasile" });

  // an unknown id rolls the whole batch back; a bad name is refused before writing
  assert.throws(() => applyMapping(check, [{ id: a, first_name: "X", last_name: "Y", full_name: "X Y" }, { id: 999, first_name: "Z", last_name: "W", full_name: "Z W" }]), /999 not found/);
  assert.equal(check.prepare("SELECT full_name FROM members WHERE id = ?").get(a).full_name, "Ana Popescu");
  fs.writeFileSync(mapFile, JSON.stringify({ [a]: ["Ana1", "Pop"] }));
  assert.throws(() => loadMapping(mapFile), /Prenumele poate conține doar litere/);
  check.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
