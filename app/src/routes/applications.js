// Review of public applications (LEADERS, reuses onboarding.start - design-formular-date.md §2).
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const applicationsSvc = require("../services/applications");

const router = express.Router();
router.use(requireAuth);

router.get("/", wrap((req, res) => res.json(applicationsSvc.list(req.user, req.query.status))));
router.get("/pending-count", wrap((req, res) => res.json({ count: applicationsSvc.pendingCount(req.user) })));
router.get("/:id", wrap((req, res) => res.json(applicationsSvc.detail(req.user, req.params.id))));
router.post("/:id/accept", wrap(async (req, res) => res.json(await applicationsSvc.accept(req.user, req.params.id, req.body || {}))));
router.post("/:id/reject", wrap((req, res) => res.json(applicationsSvc.reject(req.user, req.params.id, req.body || {}))));

module.exports = router;
