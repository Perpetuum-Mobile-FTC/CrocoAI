const express = require("express");
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const meetings = require("../services/meetings");
const { DomainError } = require("../domain/errors");
const { createRateLimiter } = require("../middleware/rate-limit");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

const router = express.Router();
router.use(requireAuth);

router.get("/", wrap((req, res) => {
  res.json(meetings.list(req.user, req.query));
}));

// AI tool parity endpoints (same services called by ai/tools-meetings.js) - keep BEFORE "/:id".
router.get("/last-approved", wrap((req, res) => {
  res.json(meetings.lastApproved(req.user));
}));
router.get("/search", wrap((req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) throw new DomainError("INVALID", "Parametrul q este obligatoriu.");
  res.json(meetings.search(req.user, q));
}));
router.get("/decisions", wrap((req, res) => {
  const date = req.query.date;
  if (!date) throw new DomainError("INVALID", "Parametrul date este obligatoriu.");
  res.json(meetings.decisionsFor(req.user, date));
}));

// Ședințe v3 (design-sedinte-v3.md) - keep BEFORE "/:id".
router.get("/targets", wrap((req, res) => {
  res.json(meetings.allowedTargets(req.user));
}));
router.get("/upcoming/mine", wrap((req, res) => {
  res.json(meetings.upcomingMine(req.user));
}));

// Light per-user rate limit on QR scans: 20 / minute.
const scanLimit = createRateLimiter({ windowMs: 60 * 1000, max: 20 });
router.post("/scan", wrap((req, res) => {
  if (scanLimit.limited(req.user.id)) throw new DomainError("LIMIT", "Prea multe scanări. Încearcă din nou peste un minut.");
  res.json(meetings.scan(req.user, (req.body || {}).token));
}));

router.post("/schedule", wrap(async (req, res) => {
  res.json(await meetings.schedule(req.user, req.body));
}));

router.post("/session/:sessionId", wrap((req, res) => {
  res.json(meetings.getOrCreateForSession(req.user, req.params.sessionId));
}));

router.get("/:id", wrap((req, res) => {
  res.json(meetings.get(req.user, req.params.id));
}));

router.put("/:id/reschedule", wrap(async (req, res) => {
  res.json(await meetings.reschedule(req.user, req.params.id, req.body));
}));

router.delete("/:id", wrap(async (req, res) => {
  res.json(await meetings.cancel(req.user, req.params.id));
}));

// Prezență cu cod QR (design-sedinte-v3.md §2).
router.get("/:id/qr", wrap(async (req, res) => {
  res.json(await meetings.attendanceQr(req.user, req.params.id));
}));
router.get("/:id/attendance", wrap((req, res) => {
  res.json(meetings.attendanceRoster(req.user, req.params.id));
}));
router.put("/:id/attendance", wrap((req, res) => {
  res.json(meetings.markAttendance(req.user, req.params.id, (req.body || {}).records));
}));
router.post("/:id/attendance/close", wrap((req, res) => {
  res.json(meetings.closeAttendance(req.user, req.params.id));
}));
router.post("/:id/attendance/reopen", wrap((req, res) => {
  res.json(meetings.reopenAttendance(req.user, req.params.id));
}));

// Live recording (design-sedinte-v2.md §3). Chunks are raw bytes, 5 MB max, this route only.
router.post("/:id/recording/start", wrap((req, res) => {
  res.json(meetings.startRecording(req.user, req.params.id, req.body || {}));
}));
router.get("/:id/recording", wrap((req, res) => {
  res.json(meetings.getRecording(req.user, req.params.id));
}));
router.post("/:id/recording/:rid/chunk", express.raw({ type: "*/*", limit: "5mb" }), wrap((req, res) => {
  res.json(meetings.uploadChunk(req.user, req.params.id, req.params.rid, req.query.seq, req.body));
}));
router.post("/:id/recording/:rid/stop", wrap((req, res) => {
  res.json(meetings.stopRecording(req.user, req.params.id, req.params.rid));
}));
router.post("/:id/recording/:rid/abandon", wrap((req, res) => {
  res.json(meetings.abandonRecording(req.user, req.params.id, req.params.rid));
}));

router.put("/:id/agenda", wrap((req, res) => {
  res.json(meetings.updateAgenda(req.user, req.params.id, req.body.agenda));
}));

router.put("/:id/meet-link", wrap((req, res) => {
  res.json(meetings.setMeetLinkManual(req.user, req.params.id, req.body.link));
}));

router.post("/:id/meet-link/auto", wrap(async (req, res) => {
  res.json(await meetings.createMeetLinkAuto(req.user, req.params.id));
}));

router.post("/:id/audio", upload.single("file"), wrap((req, res) => {
  res.json(meetings.uploadAudio(req.user, req.params.id, req.file));
}));

router.get("/:id/audio/status", wrap((req, res) => {
  res.json(meetings.audioStatus(req.user, req.params.id));
}));

router.post("/:id/draft", wrap(async (req, res) => {
  res.json(await meetings.generateDraft(req.user, req.params.id));
}));

router.put("/:id/draft", wrap((req, res) => {
  res.json(meetings.updateDraft(req.user, req.params.id, req.body.draft));
}));

router.post("/:id/approve", wrap((req, res) => {
  res.json(meetings.approve(req.user, req.params.id));
}));

// A2: the printable PV runs no script at all (only its own inline <style>), whatever the draft holds.
router.get("/:id/export", wrap((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  res.send(meetings.exportHtml(req.user, req.params.id));
}));

module.exports = router;
