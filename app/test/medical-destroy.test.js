// Art. 41.8: the medical sheet is destroyed (rows + files) when a member becomes 'iesit'; retention is the safety net.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers } = require("./_assign-env");

const env = initEnv("medical_destroy");
const db = require("../src/db");
const members = require("../src/services/members");
const documents = require("../src/services/documents");
const retention = require("../src/services/retention");
const rules = require("../src/domain/rules");

let M;
before(() => {
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "a", role: "member" },
    { key: "b", role: "member" },
    { key: "c", role: "member" },
    { key: "d", role: "member" },
  ]);
});
after(() => { db.close(); env.cleanup(); });

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("x")]);
function addDoc(memberId, typeKey) {
  const file = { buffer: PDF, size: PDF.length, mimetype: "application/pdf", originalname: "f.pdf" };
  const row = documents.upload({ id: memberId, role: "member", status: "activ" }, memberId, typeKey, file);
  return { id: row.id, abs: path.join(documents.DOCS_DIR, row.file_path) };
}
const rowsOf = (id, type) => db.prepare("SELECT * FROM member_documents WHERE member_id = ? AND type_key = ?").all(id, type);
const audits = (id) => db.prepare("SELECT * FROM audit_log WHERE action = 'medical_destroyed' AND member_id = ?").all(id);

test("rule constant cites Art. 41.8", () => {
  assert.match(rules.MEDICAL_DESTRUCTION.article, /41\.8/);
});

test("changeStatus -> iesit destroys medical rows + files, audits, leaves other docs and members alone", () => {
  const m1 = addDoc(M.a.id, "fisa_medicala");
  const m2 = addDoc(M.a.id, "fisa_medicala");
  const other = addDoc(M.a.id, "anexa5_confidentialitate");
  const bMed = addDoc(M.b.id, "fisa_medicala");
  members.changeStatus(M.tl, M.a.id, "iesit", "pleacă");
  assert.equal(rowsOf(M.a.id, "fisa_medicala").length, 0);
  assert.ok(!fs.existsSync(m1.abs) && !fs.existsSync(m2.abs));
  assert.equal(rowsOf(M.a.id, "anexa5_confidentialitate").length, 1);
  assert.ok(fs.existsSync(other.abs));
  assert.equal(rowsOf(M.b.id, "fisa_medicala").length, 1);
  assert.ok(fs.existsSync(bMed.abs));
  const a = audits(M.a.id);
  assert.equal(a.length, 1);
  assert.equal(a[0].actor_id, M.tl.id);
  assert.equal(a[0].detail, "count=2");
  assert.equal(audits(M.b.id).length, 0);
});

test("a status change that is not iesit keeps the medical sheet", () => {
  members.changeStatus(M.tl, M.b.id, "pauza", "x");
  assert.equal(rowsOf(M.b.id, "fisa_medicala").length, 1);
  members.setPause(M.tl, M.b.id, null, "x");
  assert.equal(rowsOf(M.b.id, "fisa_medicala").length, 1);
});

test("iesit without any medical sheet writes no audit entry", () => {
  members.changeStatus(M.tl, M.d.id, "iesit", "x");
  assert.equal(audits(M.d.id).length, 0);
});

test("reactivation does not break anything and restores nothing; a new sheet can be uploaded", () => {
  members.changeStatus(M.tl, M.a.id, "activ", "revine");
  assert.equal(rowsOf(M.a.id, "fisa_medicala").length, 0);
  addDoc(M.a.id, "fisa_medicala");
  assert.equal(rowsOf(M.a.id, "fisa_medicala").length, 1);
  assert.equal(audits(M.a.id).length, 1);
});

test("retention sweeps a pre-existing iesit member, is idempotent, logs the count", () => {
  const d1 = addDoc(M.c.id, "fisa_medicala");
  db.prepare("UPDATE members SET status = 'iesit', active = 0 WHERE id = ?").run(M.c.id); // before this change
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(" ")); };
  let first, second;
  try { first = retention.run(new Date()); second = retention.run(new Date()); } finally { console.log = orig; }
  assert.equal(first.medical_destroyed, 1);
  assert.equal(first.medical_file_failures, 0);
  assert.equal(second.medical_destroyed, 0);
  assert.equal(rowsOf(M.c.id, "fisa_medicala").length, 0);
  assert.ok(!fs.existsSync(d1.abs));
  assert.equal(audits(M.c.id).length, 1);
  assert.equal(audits(M.c.id)[0].actor_id, null);
  assert.ok(logs.some((l) => l.startsWith("[RETENTION]") && l.includes("medical_destroyed=1")));
  // active members' sheets are untouched
  assert.equal(rowsOf(M.a.id, "fisa_medicala").length, 1);
});

test("a missing file on disk does not block the DB deletion", () => {
  const x = addDoc(M.b.id, "fisa_medicala");
  fs.unlinkSync(x.abs);
  members.changeStatus(M.tl, M.b.id, "iesit", "x");
  assert.equal(rowsOf(M.b.id, "fisa_medicala").length, 0);
});

test("upload of a medical sheet for an iesit member is refused (Romanian message); other types still allowed", () => {
  const file = { buffer: PDF, size: PDF.length, mimetype: "application/pdf", originalname: "f.pdf" };
  assert.throws(() => documents.upload(M.tl, M.d.id, "fisa_medicala", file), (e) => e.code === "FORBIDDEN" && /Art\. 41\.8/.test(e.message));
  assert.throws(() => documents.upload({ id: M.d.id, role: "member", status: "iesit" }, M.d.id, "fisa_medicala", file), /ieșit/);
  assert.equal(rowsOf(M.d.id, "fisa_medicala").length, 0);
});

test("retention removes orphan files of iesit members (own dir only), retries failed deletes, drops empty dir", () => {
  const root = documents.DOCS_DIR;
  const dir = path.join(root, String(M.d.id));
  fs.mkdirSync(dir, { recursive: true });
  const orphan = path.join(dir, "orphan.pdf");
  fs.writeFileSync(orphan, "x");
  // an active member's folder and an unrelated file must never be touched
  const keep = addDoc(M.a.id, "fisa_medicala");
  const stray = path.join(root, String(M.a.id), "stray.pdf");
  fs.writeFileSync(stray, "x");
  fs.mkdirSync(path.join(dir, "sub")); // subdirs are not regular files: left alone

  const realRm = fs.rmSync;
  fs.rmSync = (p, o) => { if (p === orphan) { const e = new Error("EPERM: operation not permitted"); e.code = "EPERM"; throw e; } return realRm(p, o); };
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(" ")); };
  let r1, r2, r3;
  try { r1 = retention.run(new Date()); fs.rmSync = realRm; r2 = retention.run(new Date()); r3 = retention.run(new Date()); }
  finally { fs.rmSync = realRm; console.log = orig; }
  assert.equal(r1.medical_file_failures, 1);
  assert.equal(r1.medical_orphans_removed, 0);
  assert.ok(logs.some((l) => l.startsWith("[RETENTION]") && l.includes("medical_file_failures=1")));
  assert.equal(r2.medical_orphans_removed, 1); // retried automatically
  assert.equal(r2.medical_file_failures, 0);
  assert.ok(!fs.existsSync(orphan));
  assert.equal(r3.medical_orphans_removed, 0);
  assert.ok(fs.existsSync(stray) && fs.existsSync(keep.abs));
  assert.ok(fs.existsSync(path.join(dir, "sub")), "subdirectory untouched, dir kept");
  fs.rmdirSync(path.join(dir, "sub"));
  retention.run(new Date());
  assert.ok(!fs.existsSync(dir), "empty dir removed");
});
