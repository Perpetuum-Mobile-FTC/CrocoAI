const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const events = require("../services/events");

const router = express.Router();
router.use(requireAuth);

router.get("/", wrap((req, res) => {
  res.json(events.list(req.user, req.query));
}));

router.get("/types", wrap((req, res) => {
  res.json(events.VALID_TYPES);
}));

router.post("/", wrap((req, res) => {
  res.json(events.create(req.user, req.body));
}));

router.put("/:id", wrap((req, res) => {
  res.json(events.update(req.user, req.params.id, req.body));
}));

router.delete("/:id", wrap((req, res) => {
  events.remove(req.user, req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
