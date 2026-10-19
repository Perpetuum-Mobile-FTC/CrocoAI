const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const onboarding = require("../services/onboarding");

const router = express.Router();
router.use(requireAuth);

// LEADERS start a new onboarding process.
router.post("/", wrap((req, res) => {
  res.json(onboarding.start(req.user, req.body || {}));
}));

// MANAGERS: full list (with checklist + overdue flag per Art. 43.3).
router.get("/", wrap((req, res) => {
  res.json(onboarding.list(req.user));
}));

// MANAGERS: overdue signals for the Acasă dashboard (Art. 43.3). Must stay before "/:memberId".
router.get("/signals/overdue", wrap((req, res) => {
  res.json(onboarding.overdueSignals(req.user));
}));

// MANAGERS or the member themselves.
router.get("/:memberId", wrap((req, res) => {
  res.json(onboarding.detail(req.user, req.params.memberId));
}));

router.post("/:memberId/checklist/:stepKey", wrap((req, res) => {
  const { done } = req.body || {};
  res.json(onboarding.setTick(req.user, req.params.memberId, req.params.stepKey, done !== false));
}));

router.post("/:memberId/restart", wrap((req, res) => {
  res.json(onboarding.restart(req.user, req.params.memberId));
}));

router.post("/:memberId/cancel", wrap((req, res) => {
  res.json(onboarding.cancel(req.user, req.params.memberId));
}));

module.exports = router;
