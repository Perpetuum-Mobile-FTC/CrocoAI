const express = require("express");
const { requireAuth, setAuthCookie, clearAuthCookie, LOGIN_ALLOWED_STATUSES } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const { ipKey } = require("../domain/ip");
const { createRateLimiter } = require("../middleware/rate-limit");
const members = require("../services/members");
const meetingAudience = require("../services/meeting-audience");
const { uiPermissions } = require("../domain/policy");

const router = express.Router();

// In-memory rate limit: 10 attempts / 15 min per IP (LOGIN_RATE_LIMIT_MAX).
const loginLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX) || 10 });

function toPublicUser(m) {
  return {
    id: m.id,
    name: m.full_name,
    role: m.role,
    status: m.status,
    must_change_password: !!m.must_change_password,
  };
}

// Accepts username OR phone (normalized) - design v2 §2.
router.post("/login", (req, res) => {
  const ip = ipKey(req.ip); // IPv6 grouped by /64
  if (loginLimit.limited(ip)) return res.status(429).json({ error: "Prea multe încercări. Așteaptă câteva minute." });

  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: "Completează toate câmpurile" });

  const member = members.authenticate(phone, password, LOGIN_ALLOWED_STATUSES);
  if (!member) return res.status(401).json({ error: "Utilizator sau parolă incorectă" });
  setAuthCookie(res, member);
  res.json({ user: toPublicUser(member) });
});

router.get("/me", requireAuth, (req, res) => {
  // meetings_section: whether the Ședințe section is shown (design-sedinte-v3.md §3, rule in policy.js).
  // permissions: { "<action>": boolean } for policy.UI_ACTIONS - the SPA shows controls from these, never from roles.
  res.json({ ...toPublicUser(req.user), meetings_section: meetingAudience.sectionAccess(req.user), permissions: uiPermissions(req.user) });
});

// A1: logout invalidates the token itself (token_version++), not just the browser cookie.
router.post("/logout", requireAuth, (req, res) => {
  members.bumpTokenVersion(req.user.id);
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.post("/change-password", requireAuth, wrap((req, res) => {
  const { new_password, current_password } = req.body || {};
  members.changeOwnPassword(req.user, new_password, current_password);
  clearAuthCookie(res); // token_version bumped - old cookie invalid, force re-login
  res.json({ ok: true });
}));

module.exports = router;
