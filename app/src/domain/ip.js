// Key for per-IP limits and stored IP hashes. One IPv6 subscriber usually owns a whole /64, so every address
// inside it counts as one (otherwise a single phone could rotate addresses past the limits); IPv4-mapped IPv6
// ("::ffff:1.2.3.4") is unwrapped to plain IPv4.
function ipKey(ip) {
  let s = String(ip || "unknown").trim().toLowerCase().split("%")[0];
  if (s.startsWith("::ffff:") && s.includes(".")) return s.slice(7);
  if (!s.includes(":")) return s;
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":") + "::/64";
}

module.exports = { ipKey };
