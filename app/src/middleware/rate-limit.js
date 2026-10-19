// In-memory fixed-window counters per key (IP via domain/ip.ipKey, or member id), shared by the login,
// public form, registration, completion-link and QR-scan limits. Expired keys are evicted so the maps
// can't grow without bound (one sweep per window). A live key is never dropped: once the map holds
// `maxKeys` live keys, new keys share one OVERFLOW record (flooding with fresh IPs can't reset a counter).
const MAX_KEYS = 50000;
const OVERFLOW = "\0overflow";
const FULL_SWEEP_MS = 1000; // while full, look for expired keys at most once a second

// counter.get(key) -> the live { count, resetAt } record (new/reset when its window ended); callers
// increment `count` themselves when the semantics need it (registration counts only successes).
function createWindowCounter(windowMs, { maxKeys = MAX_KEYS, now = Date.now } = {}) {
  const map = new Map();
  let lastSweep = now();

  function sweep(t) {
    lastSweep = t;
    for (const [k, rec] of map) if (t > rec.resetAt) map.delete(k);
  }

  function get(key) {
    const t = now();
    if (t - lastSweep >= windowMs) sweep(t);
    if (!map.has(key) && map.size >= maxKeys) {
      if (t - lastSweep >= FULL_SWEEP_MS) sweep(t);
      if (map.size >= maxKeys) key = OVERFLOW;
    }
    let rec = map.get(key);
    if (!rec || t > rec.resetAt) {
      rec = { count: 0, resetAt: t + windowMs };
      map.set(key, rec);
    }
    return rec;
  }

  // Counts one hit and returns the count in the current window.
  function hit(key) {
    const rec = get(key);
    rec.count++;
    return rec.count;
  }

  return { get, hit, size: () => map.size };
}

// The common case: every request counts; limited(key) is true once more than `max` hits fell in the window.
function createRateLimiter({ windowMs, max, ...opts }) {
  const counter = createWindowCounter(windowMs, opts);
  return { limited: (key) => counter.hit(key) > max, counter };
}

module.exports = { createWindowCounter, createRateLimiter };
