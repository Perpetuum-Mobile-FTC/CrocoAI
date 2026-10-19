const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const tasks = require("../services/tasks");

const router = express.Router();
router.use(requireAuth);

router.get("/", wrap((req, res) => {
  const { status, mine } = req.query;
  res.json(tasks.list(req.user, { status, mine: mine === "1" || mine === "true" }));
}));

router.post("/", wrap((req, res) => {
  res.json(tasks.create(req.user, req.body));
}));

router.put("/:id", wrap((req, res) => {
  res.json(tasks.update(req.user, req.params.id, req.body));
}));

router.patch("/:id", wrap((req, res) => {
  const { status, title, due_date, remind_at } = req.body || {};
  if (status && !title && due_date === undefined && remind_at === undefined) return res.json(tasks.updateStatus(req.user, req.params.id, status));
  res.json(tasks.update(req.user, req.params.id, req.body));
}));

router.delete("/:id", wrap((req, res) => {
  tasks.remove(req.user, req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
