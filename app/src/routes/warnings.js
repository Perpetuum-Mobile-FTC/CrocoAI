const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const warnings = require("../services/warnings");

const router = express.Router();
router.use(requireAuth);

router.get("/member/:id", wrap((req, res) => {
  res.json(warnings.listFor(req.user, req.params.id));
}));

router.post("/", wrap((req, res) => {
  res.json(warnings.record(req.user, req.body));
}));

module.exports = router;
