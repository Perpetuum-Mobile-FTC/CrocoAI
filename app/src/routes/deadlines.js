const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const deadlines = require("../services/deadlines");

const router = express.Router();
router.use(requireAuth);

// ?all=1 also returns past deadlines (Admin → Termene).
router.get("/", wrap((req, res) => {
  res.json(deadlines.list(req.user, { all: req.query.all === "1" }));
}));

router.post("/", wrap((req, res) => {
  res.json(deadlines.create(req.user, req.body || {}));
}));

router.put("/:id", wrap((req, res) => {
  res.json(deadlines.update(req.user, req.params.id, req.body || {}));
}));

router.delete("/:id", wrap((req, res) => {
  res.json(deadlines.remove(req.user, req.params.id));
}));

module.exports = router;
