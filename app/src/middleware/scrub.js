// Defense in depth: no API response may ever carry credential material, whatever a service
// returns (found 2026-10-02: raw member rows incl. password_hash in accept/onboarding responses).
const SECRET_KEYS = new Set(["password_hash", "token_version"]);

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!SECRET_KEYS.has(k)) out[k] = scrub(v);
    return out;
  }
  return value;
}

function scrubJson(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => json(scrub(body));
  next();
}

module.exports = { scrub, scrubJson };
