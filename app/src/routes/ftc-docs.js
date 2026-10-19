const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const ftcDocs = require("../services/ftc-docs");
const ftcManualUpdater = require("../services/ftc-manual-updater");

const router = express.Router();
router.use(requireAuth);

// Same permission as the internal regulament (design-ai-hardening.md §2) - any member can read it.
router.get("/search", wrap((req, res) => {
  res.json(ftcDocs.searchFor(req.user, req.query.q));
}));

router.get("/docs", wrap((req, res) => {
  res.json(ftcDocs.listDocsFor(req.user));
}));

router.get("/doc/:file", wrap((req, res) => {
  const content = ftcDocs.fullFor(req.user, req.params.file);
  if (content === null) return res.status(404).json({ error: "Document negăsit." });
  res.json({ file: req.params.file, full: content });
}));

// Season/version label for the Regulament page ("BIOBUZZ — TU03, actualizat 01.10.2026") - any
// member can read it, same as the rest of this router.
router.get("/manual-version", wrap((req, res) => {
  res.json(ftcDocs.manualVersionFor(req.user));
}));

// Full status + history for the Admin "Manual FTC" panel (LEADERS only - enforced in the service).
router.get("/manual-status", wrap((req, res) => {
  res.json(ftcManualUpdater.getStatus(req.user));
}));

// Forces a check now (LEADERS only - enforced in the service).
router.post("/check", wrap(async (req, res) => {
  res.json(await ftcManualUpdater.checkForUpdate({ actor: req.user, force: true }));
}));

module.exports = router;
