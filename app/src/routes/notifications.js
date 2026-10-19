const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const notifications = require("../services/notifications");

const router = express.Router();
router.use(requireAuth);

router.get("/", wrap((req, res) => {
  res.json(notifications.list(req.user));
}));

router.post("/:id/read", wrap((req, res) => {
  notifications.markRead(req.user, req.params.id);
  res.json({ ok: true });
}));

router.post("/read", wrap((req, res) => {
  notifications.markAllRead(req.user);
  res.json({ ok: true });
}));

module.exports = router;
