// Member management (members.manage = LEADERS). Permission is enforced inside services, not
// here - routes stay thin; requireAuth is the only route-level gate.
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const members = require("../services/members");
const registration = require("../services/registration");

const router = express.Router();
router.use(requireAuth);

router.get("/members", wrap((req, res) => {
  res.json(members.adminList(req.user));
}));

router.post("/members", wrap((req, res) => {
  res.json(members.create(req.user, req.body));
}));

router.put("/members/:id", wrap((req, res) => {
  res.json(members.update(req.user, req.params.id, req.body));
}));

router.post("/members/:id/status", wrap((req, res) => {
  const { status, reason, pause_until } = req.body || {};
  const result = status === "pauza" ? members.setPause(req.user, req.params.id, pause_until, reason) : members.changeStatus(req.user, req.params.id, status, reason);
  res.json(result);
}));

// Legacy soft-delete alias (deactivate = status iesit).
router.delete("/members/:id", wrap((req, res) => {
  res.json(members.changeStatus(req.user, req.params.id, "iesit", "dezactivat din admin"));
}));

router.post("/members/:id/reset-password", wrap((req, res) => {
  res.json(members.resetPassword(req.user, req.params.id));
}));

router.get("/role-requests", wrap((req, res) => {
  res.json(registration.listRoleRequests(req.user));
}));

router.post("/role-requests/:memberId", wrap((req, res) => {
  res.json(registration.decideRoleRequest(req.user, req.params.memberId, !!(req.body || {}).approve));
}));

router.post("/import/preview", wrap((req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ error: "rows trebuie să fie listă." });
  res.json(members.previewImport(req.user, rows));
}));

router.post("/import/commit", wrap((req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ error: "rows trebuie să fie listă." });
  res.json(members.commitImport(req.user, rows));
}));

router.get("/ai-usage", wrap((req, res) => {
  const aiUsage = require("../services/ai-usage");
  res.json(aiUsage.summary(req.user, req.query));
}));

// Per-member usage + refusals/limits/crisis signals, content-free (design-ai-hardening.md §5, LEADERS).
router.get("/ai-usage/by-member", wrap((req, res) => {
  const aiUsage = require("../services/ai-usage");
  res.json(aiUsage.byMember(req.user, req.query));
}));

// Access log of medical sheets (Team Leader only, Art. 41.2 / 41.4).
router.get("/audit-log", wrap((req, res) => {
  res.json(require("../services/audit-log").list(req.user, req.query));
}));

router.get("/ai-flags", wrap((req, res) => {
  const aiUsage = require("../services/ai-usage");
  res.json(aiUsage.flagsSummary(req.user, req.query));
}));

module.exports = router;
