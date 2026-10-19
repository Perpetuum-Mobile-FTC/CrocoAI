// Curățenie F2 item 4: the live recorder's upload queue / state machine (public/js/recorder-queue.js,
// pure ES module) driven with fakes: no DOM, no MediaRecorder, no real timers.
const { test, before } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

let R;
before(async () => {
  const tmp = path.join(os.tmpdir(), `crocoai-recorder-queue-${process.pid}.mjs`);
  fs.copyFileSync(path.join(__dirname, "..", "public", "js", "recorder-queue.js"), tmp);
  try { R = await import(pathToFileURL(tmp).href); } finally { fs.unlinkSync(tmp); }
});

const httpError = (status, message = "err", data = null) => Object.assign(new Error(message), { status, data });
const blob = (n = 10) => ({ size: n });
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// Harness: `responses` = queue of per-call behaviours for sendChunk (undefined -> success).
function make({ responses = [], stopResult, stopped = null } = {}) {
  const calls = { chunks: [], stop: 0, sleeps: [], stopRecorder: 0, requestData: 0, release: 0, allowUnload: 0 };
  let clock = 1_000_000;
  const ctl = { stopResult };
  const q = new R.RecorderQueue({
    sendChunk: async (seq) => { calls.chunks.push(seq); const r = responses.shift(); if (r) throw r; },
    sendStop: async () => { calls.stop++; if (ctl.stopResult) throw ctl.stopResult; },
    capture: {
      stopRecorder: () => { calls.stopRecorder++; },
      requestData: () => { calls.requestData++; },
      release: () => { calls.release++; },
      allowUnload: () => { calls.allowUnload++; },
      stopped,
    },
    now: () => clock,
    sleep: async (ms) => { calls.sleeps.push(ms); },
    timeslice: 1000,
  });
  return { q, calls, ctl, tick: (ms) => { clock += ms; return clock; } };
}

test("chunks go out in seq order, one at a time", async () => {
  const { q, calls } = make();
  q.onData(blob()); q.onData(blob()); q.onData({ size: 0 }); q.onData(blob());
  await flush();
  assert.deepEqual(calls.chunks, [0, 1, 2]);
  assert.equal(q.sent, 3);
  assert.equal(q.queue.length, 0);
});

test("409 with expected_seq past the chunk: skipped (server has it); any other 409 is fatal", async () => {
  const { q, calls } = make({ responses: [httpError(409, "seq", { expected_seq: 2 })] });
  q.onData(blob()); q.onData(blob());
  await flush();
  assert.deepEqual(calls.chunks, [0, 1]);
  assert.equal(q.sent, 1, "chunk 0 dropped without counting as sent");
  assert.equal(q.state, "recording");

  const b = make({ responses: [httpError(409, "seq", { expected_seq: 0 })] });
  b.q.onData(blob());
  await flush();
  assert.equal(b.q.state, "failed", "a 409 that is not 'already have it' is a fatal 4xx");
});

test("401: warning, retry with backoff, warning cleared after success", async () => {
  const { q, calls } = make({ responses: [httpError(401), httpError(401)] });
  const seen = [];
  q.onChange = () => seen.push(q.warn);
  q.onData(blob());
  await flush();
  assert.deepEqual(calls.chunks, [0, 0, 0]);
  assert.deepEqual(calls.sleeps, [R.backoffMs(1), R.backoffMs(2)]);
  assert.ok(seen.includes(R.MSG_SESSION_EXPIRED));
  assert.equal(q.warn, null);
  assert.equal(q.attempt, 0);
  assert.equal(q.state, "recording");
});

test("5xx / 429 / network errors are retried; backoff is capped at 30 s", async () => {
  const { q, calls } = make({ responses: [httpError(503), httpError(429), Object.assign(new Error("offline"), { status: undefined })] });
  q.onData(blob());
  await flush();
  assert.deepEqual(calls.chunks, [0, 0, 0, 0]);
  assert.equal(q.sent, 1);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(R.backoffMs), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("fatal 4xx: failed, queue dropped, mic released, unload allowed; 'nu mai e activă' -> other-device text", async () => {
  const { q, calls } = make({ responses: [httpError(400, "Înregistrarea nu mai e activă.")] });
  q.onData(blob()); q.onData(blob());
  await flush();
  assert.equal(q.state, "failed");
  assert.equal(q.error, R.MSG_OTHER_DEVICE);
  assert.equal(q.queue.length, 0);
  assert.deepEqual([calls.stopRecorder, calls.release, calls.allowUnload], [1, 1, 1]);
  q.onData(blob());
  await flush();
  assert.deepEqual(calls.chunks, [0], "nothing is queued after a failure");
  assert.equal(await q.finish(), false, "finish is a no-op once failed");

  const b = make({ responses: [httpError(413, "Bucată prea mare.")] });
  b.q.onData(blob());
  await flush();
  assert.equal(b.q.error, "Bucată prea mare.");
});

test("watchdog: silent past timeslice+15s -> probe once (requestData), then interrupted after another timeslice", async () => {
  const { q, calls, tick } = make();
  q.watchdog(tick(1000 + 15000)); // exactly at the limit: nothing
  assert.equal(calls.requestData, 0);
  q.watchdog(tick(1));
  assert.equal(calls.requestData, 1);
  assert.equal(q.stallSecs, 16);
  q.watchdog(tick(500));
  assert.equal(calls.requestData, 1, "probe only once");
  assert.equal(q.state, "recording");
  q.watchdog(tick(600));
  assert.equal(q.state, "interrupted");
  assert.equal(q.error, R.MSG_NO_SOUND);
  assert.deepEqual([calls.stopRecorder, calls.release], [1, 1]);
});

test("watchdog: data arriving resets the stall; paused recordings are not watched", async () => {
  const { q, calls, tick } = make();
  q.watchdog(tick(20000));
  assert.equal(calls.requestData, 1);
  q.onData(blob());
  assert.equal(q.stallSecs, 0);
  assert.equal(q.probeAt, null);
  q.pause();
  q.watchdog(tick(100000));
  assert.equal(q.state, "paused");
  q.resume();
  assert.equal(q.state, "recording");
  q.watchdog(tick(1000));
  assert.equal(calls.requestData, 1, "resume resets lastData");
});

test("recorder stopping by itself while recording -> interrupted; later interrupts don't override", async () => {
  const { q } = make();
  q.onRecorderStopped();
  assert.equal(q.state, "interrupted");
  assert.equal(q.error, R.MSG_RECORDER_STOPPED);
  q.interrupt("alt motiv");
  assert.equal(q.error, R.MSG_RECORDER_STOPPED);
});

test("finish: stops the recorder, flushes the queue, then POST /stop; unload allowed only after", async () => {
  const { q, calls } = make({ responses: [httpError(503)], stopped: Promise.resolve() });
  q.onData(blob());
  assert.equal(await q.finish(), true);
  assert.equal(calls.stop, 1);
  assert.equal(q.queue.length, 0);
  assert.equal(calls.allowUnload, 1);
  assert.equal(calls.stopRecorder, 1);
});

test("finish: a recorder that never fires 'stop' does not block /stop (timeout race)", async () => {
  const { q, calls } = make({ stopped: new Promise(() => {}) });
  assert.equal(await q.finish(), true);
  assert.ok(calls.sleeps.includes(R.STOP_TIMEOUT_MS));
  assert.equal(calls.stop, 1);
});

test("finish: /stop failing -> stopfailed with the reason, retry succeeds", async () => {
  const h = make({ stopResult: httpError(500, "server jos") });
  await assert.rejects(h.q.finish(), /server jos/);
  assert.equal(h.q.state, "stopfailed");
  assert.equal(h.q.error, "Finalizarea a eșuat: server jos");
  assert.equal(h.calls.allowUnload, 0, "tab-close guard stays");
  h.ctl.stopResult = null;
  assert.equal(await h.q.finish(), true);
  assert.equal(h.calls.stop, 2);
  assert.equal(h.calls.allowUnload, 1);
});

test("finish: a fatal chunk error while flushing -> rejects, state stays failed", async () => {
  const { q } = make({ responses: [httpError(403, "Interzis")] });
  q.pumping = true; // a pump is "in flight": the chunk waits for finish()'s flush loop
  q.onData(blob());
  q.pumping = false;
  await assert.rejects(q.finish(), /Interzis/);
  assert.equal(q.state, "failed");
});
