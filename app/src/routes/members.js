const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const membersSvc = require("../services/members");

const router = express.Router();
// No router.use(requireAuth) here: this router shares the broad "/api" prefix with
// the messages router (see server.js), so a blanket router-level middleware would
// intercept every /api/* request that reaches it first, including unrelated routes like
// /api/health. Each route below gets requireAuth individually instead.

// Directory: name, role, department, status - every authenticated user.
router.get("/members", requireAuth, wrap((req, res) => {
  res.json(membersSvc.listDirectory(req.user));
}));

// LEADERS: members with incomplete profile data (design-formular-date.md §3). Must stay before
// the "/:id" route below.
router.get("/members/missing-data", requireAuth, wrap((req, res) => {
  res.json(membersSvc.missingDataList(req.user));
}));

// „Contul meu”: the logged-in member edits their own fields (members.updateOwn). Before "/:id".
router.patch("/members/me", requireAuth, wrap((req, res) => {
  res.json(membersSvc.updateOwn(req.user, req.body || {}));
}));

// Full profile with attendance/documents/warnings/tasks, filtered by policy.
router.get("/members/:id", requireAuth, wrap((req, res) => {
  const attendance = require("../services/attendance");
  const documents = require("../services/documents");
  const warnings = require("../services/warnings");
  const tasks = require("../services/tasks");

  const profile = membersSvc.getProfile(req.user, req.params.id);
  const out = { ...profile };
  try { out.attendance_stats = attendance.statsFor(req.user, req.params.id); } catch { /* no view permission */ }
  try { out.documents = documents.myStatus(req.user, req.params.id); } catch { /* no view permission */ }
  try { out.warnings = warnings.listFor(req.user, req.params.id); } catch { /* no view permission */ }
  out.tasks = tasks.list(req.user, { mine: false }).filter((t) => t.assigned_member_id === Number(req.params.id));
  res.json(out);
}));

router.get("/members/:id/guardians", requireAuth, wrap((req, res) => {
  res.json(membersSvc.listGuardians(req.user, req.params.id));
}));
router.post("/members/:id/guardians", requireAuth, wrap((req, res) => {
  res.json(membersSvc.addGuardian(req.user, req.params.id, req.body));
}));
router.put("/guardians/:id", requireAuth, wrap((req, res) => {
  res.json(membersSvc.updateGuardian(req.user, req.params.id, req.body));
}));
router.delete("/guardians/:id", requireAuth, wrap((req, res) => {
  membersSvc.removeGuardian(req.user, req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
