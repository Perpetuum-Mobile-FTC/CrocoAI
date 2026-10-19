const express = require("express");
const fs = require("fs");
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const resources = require("../services/resources");
const { DomainError } = require("../domain/errors");
const { RESOURCE_MAX_FILE_SIZE } = require("../domain/rules");

const mp = multer({ storage: multer.memoryStorage(), limits: { fileSize: RESOURCE_MAX_FILE_SIZE, files: 1 } }).single("file");
// multer passes non-multipart requests (JSON links) straight through.
function upload(req, res, next) {
  mp(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return next(new DomainError("INVALID", `Fișier prea mare (max ${RESOURCE_MAX_FILE_SIZE / 1024 / 1024} MB).`));
    if (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT") return next(new DomainError("INVALID", "Trimite un singur fișier (câmpul „file”)."));
    next(err);
  });
}

// Safe to render in the browser tab; everything else (html, svg, office...) is forced to download.
const INLINE = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/(plain|markdown|csv))$/i;

const router = express.Router();
router.use(requireAuth);

router.get("/", wrap((req, res) => {
  res.json({
    categories: resources.listCategories(),
    can_manage: resources.canManage(req.user),
    resources: resources.list(req.user, { q: req.query.q || undefined, category: req.query.category || undefined }),
  });
}));

router.post("/", upload, wrap((req, res) => {
  const body = req.body || {};
  const resource = req.file || body.kind === "file"
    ? resources.createFile(req.user, body, req.file)
    : resources.createLink(req.user, body);
  res.status(201).json({ resource });
}));

router.put("/:id", wrap((req, res) => res.json({ resource: resources.update(req.user, req.params.id, req.body || {}) })));
router.post("/:id/file", upload, wrap((req, res) => res.json({ resource: resources.replaceFile(req.user, req.params.id, req.file) })));
router.delete("/:id", wrap((req, res) => { resources.remove(req.user, req.params.id); res.json({ ok: true }); }));

router.get("/:id/file", wrap((req, res) => {
  const f = resources.openFile(req.user, req.params.id);
  const inline = INLINE.test(f.mime.split(";")[0].trim()) && req.query.download !== "1";
  res.setHeader("Content-Type", f.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`);
  res.send(fs.readFileSync(f.path)); // not res.sendFile: requires options.root on Express 5
}));

module.exports = router;
