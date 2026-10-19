const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const { uploadArray, sendDownload } = require("../middleware/upload");
const assignments = require("../services/assignments");
const submissions = require("../services/submissions");

const router = express.Router();
router.use(requireAuth);

// Static paths before /:id.
router.get("/targets", wrap((req, res) => res.json(assignments.allowedTargets(req.user))));
router.get("/my-todos", wrap((req, res) => res.json(submissions.myTodos(req.user))));

router.get("/", wrap((req, res) => res.json(assignments.list(req.user, { scope: req.query.scope || "mine", status: req.query.status || undefined }))));
router.post("/", uploadArray("materials"), wrap((req, res) => res.json(assignments.create(req.user, req.body || {}, req.files || []))));
router.get("/:id", wrap((req, res) => res.json(assignments.get(req.user, req.params.id))));
router.patch("/:id", wrap((req, res) => res.json(assignments.update(req.user, req.params.id, req.body || {}))));
router.post("/:id/close", wrap((req, res) => res.json(assignments.close(req.user, req.params.id))));
router.delete("/:id", wrap((req, res) => { assignments.remove(req.user, req.params.id); res.json({ ok: true }); }));
router.post("/:id/add-new-members", wrap((req, res) => res.json(assignments.addNewMembers(req.user, req.params.id))));
router.get("/:id/materials/:fileId", wrap((req, res) => {
  const { row, absPath } = assignments.materialFile(req.user, req.params.id, req.params.fileId);
  sendDownload(res, row, absPath);
}));

module.exports = router;
