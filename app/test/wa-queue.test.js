// Persistent outbound WhatsApp queue (ops package E, item 6): items live in SQLite (`wa_queue`), survive a
// restart (drained by start()), keep the pacing between sends, and a failed send is retried up to
// WA_QUEUE_MAX_ATTEMPTS times before the row is marked failed.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "._wa_queue_test.db");
process.env.DB_PATH = DB_FILE;
process.env.WA_QUEUE_DELAY_MS = "60";
process.env.WA_QUEUE_RETRY_MS = "10";
process.env.WA_QUEUE_MAX_ATTEMPTS = "3";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const db = require("../src/db");
const waGateway = require("../src/services/wa-gateway");
const waQueue = require("../src/services/wa-queue");

let sent;
before(() => { sent = []; });
beforeEach(() => {
  sent = [];
  db.prepare("DELETE FROM wa_queue").run();
  waGateway.sendWhatsApp = async (to, text) => { sent.push({ to, text, at: Date.now() }); return true; };
});
after(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
});

test("enqueue stores the item before sending; sent items leave the table", async () => {
  let release;
  waGateway.sendWhatsApp = (to, text) => new Promise((resolve) => { release = () => { sent.push({ to, text }); resolve(true); }; });
  waQueue.enqueue("40700000001", "salut");
  const row = db.prepare("SELECT * FROM wa_queue").get();
  assert.equal(row.to_addr, "40700000001");
  assert.equal(row.text, "salut");
  assert.equal(row.status, "pending");
  assert.equal(waQueue.pendingCount(), 1);
  await new Promise((r) => setTimeout(r, 5));
  release();
  await waQueue.drain();
  assert.deepEqual(sent.map((s) => s.text), ["salut"]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM wa_queue").get().c, 0);
  assert.equal(waQueue.pendingCount(), 0);
});

test("sends in order, spaced by >= WA_QUEUE_DELAY_MS", async () => {
  waQueue.enqueue("40700000001", "a");
  waQueue.enqueue("40700000002", "b");
  waQueue.enqueue("40700000003", "c");
  await waQueue.drain();
  assert.deepEqual(sent.map((s) => s.text), ["a", "b", "c"]);
  for (let i = 1; i < sent.length; i++) {
    assert.ok(sent[i].at - sent[i - 1].at >= 55, `spacing ${sent[i].at - sent[i - 1].at}ms`);
  }
});

test("items left in the table (a restart) are sent by start()", async () => {
  const ins = db.prepare("INSERT INTO wa_queue (to_addr, text) VALUES (?, ?)");
  ins.run("40700000001", "din-coada-1");
  ins.run("40700000002", "din-coada-2");
  waQueue.start();
  await waQueue.drain();
  assert.deepEqual(sent.map((s) => s.text), ["din-coada-1", "din-coada-2"]);
  assert.equal(waQueue.pendingCount(), 0);
});

test("a failing send is retried, then marked failed after WA_QUEUE_MAX_ATTEMPTS; others still go out", async () => {
  let calls = 0;
  waGateway.sendWhatsApp = async (to, text) => {
    if (to === "40700000009") { calls++; return false; }
    sent.push({ to, text, at: Date.now() });
    return true;
  };
  waQueue.enqueue("40700000009", "nu merge");
  waQueue.enqueue("40700000001", "merge");
  await waQueue.drain();
  assert.equal(calls, 3);
  assert.deepEqual(sent.map((s) => s.text), ["merge"]);
  const row = db.prepare("SELECT * FROM wa_queue WHERE to_addr = '40700000009'").get();
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 3);
  assert.equal(row.text, "", "message text is not kept for failed rows");
  assert.equal(waQueue.pendingCount(), 0);
});

test("a send that succeeds on retry is delivered once", async () => {
  let calls = 0;
  waGateway.sendWhatsApp = async (to, text) => {
    calls++;
    if (calls === 1) return false;
    sent.push({ to, text });
    return true;
  };
  waQueue.enqueue("40700000001", "a doua oară");
  await waQueue.drain();
  assert.equal(calls, 2);
  assert.deepEqual(sent.map((s) => s.text), ["a doua oară"]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM wa_queue").get().c, 0);
});

test("start() prunes failed rows older than 30 days", async () => {
  db.prepare("INSERT INTO wa_queue (to_addr, text, status, created_at) VALUES ('x', '', 'failed', '2020-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO wa_queue (to_addr, text, status) VALUES ('y', '', 'failed')").run();
  waQueue.start();
  await waQueue.drain();
  assert.deepEqual(db.prepare("SELECT to_addr FROM wa_queue").all().map((r) => r.to_addr), ["y"]);
});
