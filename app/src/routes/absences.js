const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const absences = require("../services/absences");

const router = express.Router();
router.use(requireAuth);

router.get("/", wrap((req, res) => {
  const { member_id, status } = req.query;
  res.json(absences.list(req.user, { member_id, status }));
}));

router.post("/", wrap((req, res) => {
  res.json(absences.create(req.user, req.body));
}));

router.post("/:id/decide", wrap((req, res) => {
  const { status, note } = req.body || {};
  res.json(absences.decide(req.user, req.params.id, status, note));
}));

module.exports = router;
