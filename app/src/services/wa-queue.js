// Outbound WhatsApp queue enforcing a minimum delay between sends (shared number - design-formular-date.md
// §3: bulk completion links need >= 20s spacing to avoid WhatsApp's anti-spam detection).
// Persisted in SQLite (`wa_queue`, ops package E): enqueue() writes the row first, start() drains what a
// restart left behind. A failed send is retried after WA_QUEUE_RETRY_MS × attempts, up to
// WA_QUEUE_MAX_ATTEMPTS, then marked 'failed' (text cleared - it may hold a completion link).
const db = require("../db");
const waGateway = require("./wa-gateway");

const MIN_DELAY_MS = parseInt(process.env.WA_QUEUE_DELAY_MS, 10) || 20000;
const MAX_ATTEMPTS = parseInt(process.env.WA_QUEUE_MAX_ATTEMPTS, 10) || 5;
const RETRY_MS = parseInt(process.env.WA_QUEUE_RETRY_MS, 10) || 60000;
const MAX_IDLE_WAIT_MS = 5000; // re-check often while waiting for a retry, so new items aren't held back

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (ms) => new Date(ms).toISOString();

let running = null; // promise of the current drain loop
let lastSendAt = 0;

async function loop() {
  for (;;) {
    const item = db.prepare("SELECT * FROM wa_queue WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT 1").get(iso(Date.now()));
    if (!item) {
      const next = db.prepare("SELECT MIN(next_attempt_at) AS t FROM wa_queue WHERE status = 'pending'").get().t;
      if (!next) return;
      await sleep(Math.min(MAX_IDLE_WAIT_MS, Math.max(0, Date.parse(next) - Date.now())));
      continue;
    }
    const wait = lastSendAt + MIN_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const ok = await waGateway.sendWhatsApp(item.to_addr, item.text);
    lastSendAt = Date.now();
    if (ok) {
      db.prepare("DELETE FROM wa_queue WHERE id = ?").run(item.id);
      continue;
    }
    const attempts = item.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare("UPDATE wa_queue SET attempts = ?, status = 'failed', text = '' WHERE id = ?").run(attempts, item.id);
      console.error(`[WA-QUEUE] item ${item.id} failed after ${attempts} attempts`);
    } else {
      db.prepare("UPDATE wa_queue SET attempts = ?, next_attempt_at = ? WHERE id = ?").run(attempts, iso(Date.now() + RETRY_MS * attempts), item.id);
    }
  }
}

// Starts the drain loop if it isn't running; returns a promise resolved when the queue is empty.
function drain() {
  if (!running) {
    running = loop().then(() => {
      running = null;
      // an item enqueued while the loop was finishing (same microtask window) - pick it up
      try { if (pendingCount()) return drain(); } catch { /* db closed (tests) */ }
    }, (err) => {
      running = null;
      console.error("[WA-QUEUE]", err.message);
    });
  }
  return running;
}

function enqueue(to, text) {
  db.prepare("INSERT INTO wa_queue (to_addr, text) VALUES (?, ?)").run(to, text);
  drain();
}

// On server start: drop old failed rows and send whatever a restart left pending.
function start() {
  db.prepare("DELETE FROM wa_queue WHERE status = 'failed' AND created_at < ?").run(iso(Date.now() - 30 * 86400000));
  drain();
}

function pendingCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM wa_queue WHERE status = 'pending'").get().c;
}

module.exports = { enqueue, start, drain, pendingCount, MIN_DELAY_MS };
