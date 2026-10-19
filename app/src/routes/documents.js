const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const documents = require("../services/documents");
const templates = require("../services/doc-templates");
const membersSvc = require("../services/members");
const { DomainError } = require("../domain/errors");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const router = express.Router();
router.use(requireAuth);

router.get("/types", wrap((req, res) => {
  res.json(documents.listTypes());
}));

router.get("/me", wrap((req, res) => {
  res.json(documents.myStatus(req.user, req.user.id));
}));

router.get("/matrix", wrap((req, res) => {
  res.json(documents.matrix(req.user));
}));

// PDF (official templates, served as-is) or rendered HTML (anexe/forms, pre-filled).
router.get("/template/:key", wrap((req, res) => {
  const type = documents.getType(req.params.key);
  if (type.source === "pdf") {
    const PDF_FILES = {
      first_policies: "Declaratie-FIRST-POLICIES 2024-minor_si_major.pdf",
      consimtamant_participanti_majori: "Declaratie-consimtamant_participanti-majori-2024.pdf",
      consimtamant_imagine_majori: "Declaratie-consimtamant-prelucrare-imagine_majori-2024.pdf",
    };
    const fileName = PDF_FILES[type.key];
    if (!fileName) throw new DomainError("NOT_FOUND", "Șablon indisponibil.");
    const filePath = path.join(__dirname, "..", "..", "templates", fileName);
    if (!fs.existsSync(filePath)) throw new DomainError("NOT_FOUND", "Șablon indisponibil.");
    res.setHeader("Content-Type", "application/pdf");
    return res.send(fs.readFileSync(filePath)); // not res.sendFile: requires options.root on Express 5
  }
  const member = membersSvc.requireRaw(req.user.id);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(templates.render(type.key, member));
}));

router.post("/:typeKey/upload", upload.single("file"), wrap((req, res) => {
  const memberId = req.body.member_id || req.user.id;
  const doc = documents.upload(req.user, memberId, req.params.typeKey, req.file, req.body.event_id);
  res.json(doc);
}));

router.get("/file/:id", wrap((req, res) => {
  const { doc, absPath } = documents.authorizedFilePath(req.user, req.params.id);
  if (!fs.existsSync(absPath)) throw new DomainError("NOT_FOUND", "Fișier negăsit pe disc.");
  res.setHeader("Content-Type", doc.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.original_name || "document")}"`);
  res.send(fs.readFileSync(absPath)); // not res.sendFile: that requires an options.root even for absolute paths on Express 5
}));

router.post("/:id/review", wrap((req, res) => {
  const { status, note } = req.body || {};
  res.json(documents.review(req.user, req.params.id, status, note));
}));

module.exports = router;
