const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const { uploadArray, sendDownload } = require("../middleware/upload");
const submissions = require("../services/submissions");

const router = express.Router();
router.use(requireAuth);

router.patch("/:id/todos/:todoId", wrap((req, res) => res.json(submissions.toggleTodo(req.user, req.params.id, req.params.todoId, req.body || {}))));
router.post("/:id/files", uploadArray("files"), wrap((req, res) => res.json(submissions.addFiles(req.user, req.params.id, req.files || []))));
router.delete("/:id/files/:fileId", wrap((req, res) => res.json(submissions.removeFile(req.user, req.params.id, req.params.fileId))));
router.post("/:id/submit", wrap((req, res) => res.json(submissions.submit(req.user, req.params.id))));
router.post("/:id/unsubmit", wrap((req, res) => res.json(submissions.unsubmit(req.user, req.params.id))));
router.post("/:id/review", wrap((req, res) => res.json(submissions.review(req.user, req.params.id, req.body || {}))));
router.get("/:id/files/:fileId", wrap((req, res) => {
  const { row, absPath } = submissions.submissionFile(req.user, req.params.id, req.params.fileId);
  sendDownload(res, row, absPath);
}));

module.exports = router;
