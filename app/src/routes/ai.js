const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { wrap } = require("../middleware/error-handler");
const conversation = require("../services/conversation");

const router = express.Router();
router.use(requireAuth);

// Chronological order (oldest -> newest), last 100.
router.get("/web-history", (req, res) => {
  res.json(conversation.webHistory(req.user));
});

// Current pending WhatsApp-send confirmation for this member's web chat, or null - lets the
// frontend restore the DA/Anulează prompt after a page reload.
router.get("/pending", wrap((req, res) => {
  res.json({ pending_confirmation: conversation.webPending(req.user) });
}));

// Same pipeline as WhatsApp (services/conversation.js); errors become a fixed reply with status 200.
router.post("/web-chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: "Mesaj gol" });
  res.json(await conversation.handleMessage({ actor: req.user, channel: "web", chatId: `web:${req.user.id}`, text: message }));
});

module.exports = router;
