// Express middleware wrapper around domain/policy.can(), for routes that gate on a simple
// actor-only check (no target row needed - services re-check with the real target anyway).
const { can } = require("../domain/policy");

function requireCan(action) {
  return (req, res, next) => {
    if (!can(req.user, action)) return res.status(403).json({ error: "Acces interzis" });
    next();
  };
}

module.exports = { requireCan };
