const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const photos = require("../services/photos");
const { DomainError } = require("../domain/errors");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const router = express.Router();
router.use(requireAuth);

// File after the service's auth check, with HTTP Range (206) support - iOS Safari only plays video that way.
// Express 5: sendFile needs `root` (CLAUDE.md lesson); Content-Type from the stored mime, not the extension.
function sendMedia(res, next, absPath, mime) {
  if (!absPath || !fs.existsSync(absPath)) throw new DomainError("NOT_FOUND", "Fișier negăsit pe disc.");
  res.setHeader("Content-Type", mime || "application/octet-stream");
  res.sendFile(path.basename(absPath), { root: path.dirname(absPath), dotfiles: "allow" }, (err) => {
    if (err && !res.headersSent) next(err);
  });
}

router.get("/albums", wrap((req, res) => {
  res.json(photos.listAlbums(req.user));
}));

router.post("/albums", wrap((req, res) => {
  res.json(photos.createAlbum(req.user, req.body || {}));
}));

router.get("/albums/:id/photos", wrap((req, res) => {
  res.json(photos.listPhotos(req.user, req.params.id));
}));

router.post("/albums/:id/photos", upload.array("files", 20), wrap(async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw new DomainError("INVALID", "Niciun fișier primit.");
  const results = [];
  for (const file of files) results.push(await photos.upload(req.user, req.params.id, file));
  res.json(results);
}));

router.post("/:id/tags", wrap((req, res) => {
  const { member_id } = req.body || {};
  res.json(photos.tagMember(req.user, req.params.id, member_id));
}));

router.delete("/:id/tags/:memberId", wrap((req, res) => {
  res.json(photos.untagMember(req.user, req.params.id, req.params.memberId));
}));

router.delete("/:id", wrap((req, res) => {
  photos.remove(req.user, req.params.id);
  res.json({ ok: true });
}));

router.post("/:id/publish", wrap((req, res) => {
  const { published } = req.body || {};
  res.json(photos.publish(req.user, req.params.id, !!published));
}));

router.post("/:id/report", wrap((req, res) => {
  res.json(photos.reportPrivate(req.user, req.params.id));
}));

router.get("/:id/file", wrap((req, res, next) => {
  const { photo, absPath } = photos.authorizedPath(req.user, req.params.id, "original");
  sendMedia(res, next, absPath, photo.mime);
}));

// Shown when a photo/video has no generated thumbnail (A7: the original is never sent as a thumb).
const THUMB_PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
<rect width="320" height="240" fill="#1f2a22"/><text x="160" y="128" font-family="sans-serif" font-size="18" fill="#9fb5a5" text-anchor="middle">Fără previzualizare</text></svg>`;

// Large view for every viewer (design-pachet-b.md B3): reduced JPEG (or the video itself); never the original image.
router.get("/:id/medium", wrap(async (req, res, next) => {
  const { absPath, mime, placeholder } = await photos.mediumFile(req.user, req.params.id);
  if (placeholder) {
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    return res.send(THUMB_PLACEHOLDER);
  }
  sendMedia(res, next, absPath, mime);
}));

router.get("/:id/thumb", wrap((req, res) => {
  const { absPath, placeholder } = photos.authorizedPath(req.user, req.params.id, "thumb");
  if (placeholder) {
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    return res.send(THUMB_PLACEHOLDER);
  }
  if (!fs.existsSync(absPath)) throw new DomainError("NOT_FOUND", "Fișier negăsit pe disc.");
  res.setHeader("Content-Type", "image/jpeg");
  res.send(fs.readFileSync(absPath));
}));

// Own consent status + withdrawal (Art. 59.3) - also used by the Documente page.
router.get("/consent/me", wrap((req, res) => {
  res.json(photos.myConsentStatus(req.user));
}));

router.post("/consent/withdraw", wrap((req, res) => {
  res.json(photos.withdrawConsent(req.user));
}));

// LEADERS: photos that can't be published right now (missing/withdrawn consent somewhere).
router.get("/unpublishable", wrap((req, res) => {
  res.json(photos.unpublishable(req.user));
}));

module.exports = router;
