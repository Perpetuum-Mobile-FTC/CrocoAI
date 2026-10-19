// Curățenie F2 item 8: one in-memory rate-limit helper (src/middleware/rate-limit.js) with eviction,
// replacing the copies in auth.js (login), meetings.js (QR scan) and public.js (applications, register, completion).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createRateLimiter, createWindowCounter } = require("../src/middleware/rate-limit");

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test("limited() after max hits in a window, resets when the window ends", () => {
  const c = clock();
  const rl = createRateLimiter({ windowMs: 1000, max: 3, now: c.now });
  assert.deepEqual([1, 2, 3, 4, 5].map(() => rl.limited("ip")), [false, false, false, true, true]);
  assert.equal(rl.limited("other"), false, "per key");
  c.t += 1000;
  assert.equal(rl.limited("ip"), true, "window end is inclusive (now > resetAt resets)");
  c.t += 1;
  assert.equal(rl.limited("ip"), false);
});

test("window counter: get() without counting (registration counts only successes)", () => {
  const c = clock();
  const wc = createWindowCounter(1000, { now: c.now });
  const rec = wc.get("ip");
  assert.equal(rec.count, 0);
  rec.count += 2;
  assert.equal(wc.get("ip").count, 2, "same live record");
  c.t += 1001;
  assert.equal(wc.get("ip").count, 0);
});

test("expired keys are evicted once per window; live keys are capped", () => {
  const c = clock();
  const wc = createWindowCounter(1000, { now: c.now, maxKeys: 100 });
  for (let i = 0; i < 50; i++) wc.hit(`a${i}`);
  assert.equal(wc.size(), 50);
  c.t += 1500;
  wc.hit("fresh"); // first new key after a window: sweep
  assert.equal(wc.size(), 1);
  for (let i = 0; i < 150; i++) wc.hit(`b${i}`);
  assert.equal(wc.size(), 101, "hard cap: 100 keys + the shared overflow record");
  assert.equal(wc.get("b0").count, 1, "live keys are never dropped");
  assert.equal(wc.get("b149").count, 51, "keys past the cap share one counter");
});

test("flooding with fresh keys can't reset a limited key's counter", () => {
  const c = clock();
  const rl = createRateLimiter({ windowMs: 60_000, max: 3, now: c.now, maxKeys: 100 });
  for (let i = 0; i < 4; i++) rl.limited("attacker");
  for (let i = 0; i < 500; i++) rl.limited(`spoof${i}`);
  assert.equal(rl.limited("attacker"), true, "still limited");
  assert.equal(rl.limited("newcomer"), true, "overflow traffic is limited together");
  c.t += 60_001;
  assert.equal(rl.limited("newcomer"), false, "expired keys are swept and new keys get their own record");
});

test("no route keeps its own Map-based limiter", () => {
  const dir = path.join(__dirname, "..", "src", "routes");
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(src, /resetAt/, `${f}: use middleware/rate-limit.js`);
  }
});
