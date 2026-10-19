const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const regulament = require("../services/regulament");

const router = express.Router();
router.use(requireAuth);

router.get("/", wrap((req, res) => {
  res.json({ full: regulament.fullFor(req.user) });
}));

router.get("/search", wrap((req, res) => {
  res.json(regulament.searchFor(req.user, req.query.q));
}));

router.get("/article/:n", wrap((req, res) => {
  const article = regulament.articleFor(req.user, req.params.n);
  if (!article) return res.status(404).json({ error: "Articol negăsit." });
  res.json(article);
}));

module.exports = router;
