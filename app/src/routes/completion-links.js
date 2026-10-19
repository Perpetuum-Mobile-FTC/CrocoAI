// LEADERS create completion links (design-formular-date.md §3). The public side of the token
// (GET/POST /api/public/completion/:token) lives in routes/public.js, no auth.
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const completionSvc = require("../services/completion");

const router = express.Router();
router.use(requireAuth);

router.post("/link/:memberId", wrap((req, res) => res.json(completionSvc.createLink(req.user, req.params.memberId))));
router.post("/bulk", wrap((req, res) => res.json(completionSvc.createBulkLinks(req.user, (req.body || {}).member_ids || []))));

module.exports = router;
