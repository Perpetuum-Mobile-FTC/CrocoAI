const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const waGroups = require("../services/wa-groups");

const router = express.Router();
router.use(requireAuth);

// ?sync=1 also pulls the groups the number is in from the gateway (Admin page uses it).
router.get("/", wrap(async (req, res) => {
  res.json(await waGroups.list(req.user, { sync: req.query.sync === "1" }));
}));

// Admin page: synced list + gateway_error (null, or why the list could not be refreshed) - 200 either way.
router.get("/overview", wrap(async (req, res) => {
  res.json(await waGroups.overview(req.user));
}));

router.post("/:groupId/tracked", wrap((req, res) => {
  const { tracked } = req.body || {};
  res.json(waGroups.setTracked(req.user, req.params.groupId, !!tracked));
}));

router.post("/:groupId/invite-link", wrap((req, res) => {
  const { link } = req.body || {};
  res.json(waGroups.setInviteLink(req.user, req.params.groupId, link));
}));

module.exports = router;
