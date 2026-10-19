const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const home = require("../services/home");

const router = express.Router();
router.use(requireAuth);

// Acasă in one call (design-pachet-b.md B1): every card for the logged-in user, null = card not available.
router.get("/", wrap((req, res) => {
  res.json(home.summary(req.user));
}));

module.exports = router;
