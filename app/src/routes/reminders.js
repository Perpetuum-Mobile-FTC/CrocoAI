const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const reminders = require("../services/reminders");

const router = express.Router();
router.use(requireAuth);

router.get("/", wrap((req, res) => {
  const { sent } = req.query;
  res.json(reminders.list(req.user, { sent: sent === undefined ? undefined : sent === "1" }));
}));

router.post("/", wrap((req, res) => {
  res.json(reminders.create(req.user, req.body));
}));

router.delete("/:id", wrap((req, res) => {
  reminders.remove(req.user, req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
