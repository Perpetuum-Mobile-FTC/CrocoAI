// Public endpoints - no auth, no requireAuth anywhere in this router (design-formular-date.md §2/3).
// Own rate limiting (in-memory, per IP) separate from the login one in auth.js.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { wrap } = require("../middleware/error-handler");
const applicationsSvc = require("../services/applications");
const completionSvc = require("../services/completion");
const registrationSvc = require("../services/registration");
const regulamentSvc = require("../services/regulament");
const { setAuthCookie } = require("../middleware/auth");
const { ipKey } = require("../domain/ip"); // limits per IPv4 / per IPv6 /64
const { createRateLimiter, createWindowCounter } = require("../middleware/rate-limit");

const router = express.Router();

// Applications: 3/hour + 5/day per IP (design §2).
const HOUR = 3600000, DAY = 86400000;
const appHourly = createRateLimiter({ windowMs: HOUR, max: 3 });
const appDaily = createRateLimiter({ windowMs: DAY, max: 5 });
function applicationsRateLimited(ip) {
  const hour = appHourly.limited(ip); // both windows count every request
  const day = appDaily.limited(ip);
  return hour || day;
}

router.post("/applications", wrap((req, res) => {
  const body = req.body || {};
  // Honeypot: hidden "website" field must stay empty - pretend success to the bot either way.
  if (body.website) return res.json({ ok: true });
  if (applicationsRateLimited(ipKey(req.ip))) return res.status(429).json({ error: "Prea multe cereri trimise de la acest IP. Încearcă mai târziu." });
  applicationsSvc.create(body, req.ip);
  res.json({ ok: true });
}));

// Self-registration (design-inregistrare.md §2) in two steps since security package A3: /register
// validates and sends a WhatsApp code, /register/verify creates the account. Only SUCCESSFUL
// registrations count against 30/hour + 60/day per IP (a school Wi-Fi shares one address); all
// attempts (form, code, resend) are capped at 300/hour. Code limits (per phone / IP) live in the service.
const regOk = { hour: createWindowCounter(HOUR), day: createWindowCounter(DAY) };
const regAll = createWindowCounter(HOUR);
const TOO_MANY = "Prea multe înregistrări de la acest IP. Încearcă mai târziu sau scrie-i unui lider.";
function regLimited(ip) {
  const all = regAll.get(ip);
  const hour = regOk.hour.get(ip);
  const day = regOk.day.get(ip);
  if (all.count >= 300 || hour.count >= 30 || day.count >= 60) return null;
  all.count++;
  return { hour, day };
}

router.post("/register", wrap(async (req, res) => {
  const body = req.body || {};
  if (body.website) return res.json({ ok: true });
  if (!regLimited(ipKey(req.ip))) return res.status(429).json({ error: TOO_MANY });
  res.json({ ok: true, ...(await registrationSvc.start(body, req.ip)) });
}));

router.post("/register/resend", wrap(async (req, res) => {
  if (!regLimited(ipKey(req.ip))) return res.status(429).json({ error: TOO_MANY });
  res.json(await registrationSvc.resend((req.body || {}).pending_id, req.ip));
}));

router.post("/register/verify", wrap((req, res) => {
  const counters = regLimited(ipKey(req.ip));
  if (!counters) return res.status(429).json({ error: TOO_MANY });
  const { pending_id, code } = req.body || {};
  const member = registrationSvc.verify(pending_id, code, req.ip);
  counters.hour.count++; counters.day.count++;
  setAuthCookie(res, member);
  res.json({ ok: true, redirect: "/" });
}));

// Completion: 30 requests / 15 min per IP (guards against brute-forcing the token itself).
const completionLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const completionRateLimited = (ip) => completionLimit.limited(ip);

router.get("/completion/:token", wrap((req, res) => {
  if (completionRateLimited(ipKey(req.ip))) return res.status(429).json({ error: "Prea multe încercări. Așteaptă câteva minute." });
  res.json(completionSvc.getByToken(req.params.token));
}));

router.post("/completion/:token", wrap(async (req, res) => {
  if (completionRateLimited(ipKey(req.ip))) return res.status(429).json({ error: "Prea multe încercări. Așteaptă câteva minute." });
  const body = req.body || {};
  if (body.website) return res.status(400).json({ error: "Cerere invalidă." });
  res.json(await completionSvc.submit(req.params.token, body));
}));

// GDPR notice draft (app/knowledge/informare-date.md) - version/date parsed from the leading
// HTML comment so the form footer can show them without hardcoding a second copy.
router.get("/informare", wrap((req, res) => {
  const file = path.join(__dirname, "..", "..", "knowledge", "informare-date.md");
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^<!--\s*versiune:\s*(.+?)\s*\|\s*data:\s*(.+?)\s*-->\r?\n?/);
  res.json({ version: m ? m[1] : null, date: m ? m[2] : null, content: m ? raw.slice(m[0].length) : raw });
}));

// Art. 72.3: the regulament the sign-up box accepts - readable before the account exists.
router.get("/regulament", wrap((req, res) => {
  res.json({ version: regulamentSvc.version(), content: regulamentSvc.publicText() });
}));

module.exports = router;
