const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const announcements = require("../services/announcements");

const router = express.Router();
router.use(requireAuth);

router.get("/", wrap((req, res) => {
  res.json(announcements.list(req.user, { limit: req.query.limit }));
}));

// Publish form options: the audiences the user may publish to (empty = may not publish).
router.get("/audiences", wrap((req, res) => {
  res.json(announcements.allowedAudiences(req.user));
}));

router.post("/", wrap(async (req, res) => {
  res.json(await announcements.publish(req.user, req.body || {}));
}));

router.delete("/:id", wrap((req, res) => {
  res.json(announcements.remove(req.user, req.params.id));
}));

module.exports = router;
