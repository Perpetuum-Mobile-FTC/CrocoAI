const jwt = require("jsonwebtoken");
const db = require("../db");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) throw new Error("JWT_SECRET is required in production");
const COOKIE_NAME = "crocoai_token";
// Readable (non-httpOnly) hint with no secret in it: lets /login skip the /api/auth/me probe (a 401 console error on
// every visit) when there is certainly no session. Auth itself still only trusts the httpOnly token.
const HINT_COOKIE = "crocoai_session";

// Login allowed for activ / pauza / alumni (design v2 §3). token_version in the JWT invalidates
// old sessions on password change/reset/deactivation (design v2 §2).
const LOGIN_ALLOWED_STATUSES = ["activ", "pauza", "alumni"];
const MUST_CHANGE_ALLOWED = ["/api/auth/me", "/api/auth/change-password", "/api/auth/logout"];

function signToken(member) {
  return jwt.sign({ id: member.id, tv: member.token_version }, JWT_SECRET, { expiresIn: "30d" });
}

function setAuthCookie(res, member) {
  res.cookie(COOKIE_NAME, signToken(member), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  setHintCookie(res);
}

function setHintCookie(res) {
  res.cookie(HINT_COOKIE, "1", {
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
  res.clearCookie(HINT_COOKIE);
}

// Requires a valid session; attaches req.user (member row). Checks token_version so that a
// password change/reset/deactivation invalidates every other session immediately.
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Neautentificat" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const member = db.prepare("SELECT * FROM members WHERE id = ?").get(payload.id);
    if (!member) return res.status(401).json({ error: "Neautentificat" });
    if (!LOGIN_ALLOWED_STATUSES.includes(member.status)) return res.status(401).json({ error: "Neautentificat" });
    if ((member.token_version || 1) !== payload.tv) return res.status(401).json({ error: "Sesiune expirată, autentifică-te din nou" });
    // A1: a temporary password must be replaced before anything else is reachable.
    if (member.must_change_password && !MUST_CHANGE_ALLOWED.includes(req.baseUrl + req.path)) {
      return res.status(403).json({ error: "Trebuie să îți schimbi parola înainte de a continua.", code: "MUST_CHANGE_PASSWORD" });
    }
    req.user = member;
    if (!req.cookies[HINT_COOKIE]) setHintCookie(res); // sessions from before the hint cookie existed
    next();
  } catch (err) {
    return res.status(401).json({ error: "Neautentificat" });
  }
}

module.exports = { requireAuth, signToken, setAuthCookie, clearAuthCookie, COOKIE_NAME, JWT_SECRET, LOGIN_ALLOWED_STATUSES };
