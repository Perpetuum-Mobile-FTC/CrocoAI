const express = require("express");
const { decideOwnership } = require("../services/wa-ownership");
const conversation = require("../services/conversation");
const waGroups = require("../services/wa-groups");
const waMedia = require("../services/wa-media");
const { normalizePhone } = require("../domain/phone");
const { DomainError } = require("../domain/errors");

const router = express.Router();

router.post("/wa/incoming", (req, res) => {
  // Never reachable through the public tunnel - only the gateway container on the internal network.
  if (req.headers["cf-connecting-ip"]) return res.status(403).json({ error: "Forbidden" });
  const secret = req.headers["x-wa-secret"];
  if (!secret || secret !== process.env.WA_SHARED_SECRET) return res.status(403).json({ error: "Forbidden" });

  const { msgId, from, pushName, text, isGroup, groupId, groupName, mentioned, quotedFromMe, hasMedia, mediaType } = req.body || {};
  if (!from && !isGroup) return res.status(400).json({ error: "Missing from" });

  // Idempotency: a msgId already processed is ignored (design v2 §8).
  if (msgId) {
    try {
      if (!conversation.claimWaMessage(msgId)) return res.json({ handled: true });
    } catch (err) {
      console.error("[WA-INCOMING] idempotency insert failed:", err.code, err.message);
      return res.status(500).json({ handled: false });
    }
  }

  const ownerPhone = process.env.OWNER_PHONE || null;
  const fromDigits = from ? normalizePhone(from) : null;
  const member = conversation.memberByPhone(fromDigits);

  // Only tracked groups are processed/logged; unknown groups are recorded untracked and dropped.
  let groupTracked = false;
  if (isGroup) {
    const group = waGroups.upsertSeen(groupId, groupName);
    if (!group.tracked) {
      return res.json({ handled: true });
    }
    groupTracked = true;
  }

  // --- Poze cu consimțământ (design-phase2.md §5, §7): ask the gateway to push media from
  // tracked groups so it can be stored in an album, attributed to the sender if they're a member.
  const wantMedia = groupTracked && !!hasMedia && (mediaType === "image" || mediaType === "video");

  const decision = decideOwnership({ from: fromDigits, text, isGroup, mentioned, quotedFromMe, member, ownerPhone });
  // Media-only messages (no text/caption) must never reach the AI agent, even if mentioned/quoted.
  if (hasMedia && !text) decision.shouldReply = false;

  // Respond immediately; do the rest asynchronously so the gateway isn't blocked.
  res.json({ handled: decision.handled, ...(wantMedia ? { want_media: true } : {}) });
  if (!decision.handled) return;

  const chatId = isGroup ? groupId : fromDigits;
  const history = conversation.recordWaIncoming({ chatId, fromDigits, pushName, text, isGroup, groupName });
  if (!decision.shouldReply) return;

  // Same pipeline as the web chat (services/conversation.js).
  conversation.handleMessage({ actor: member, channel: "wa", chatId, text: decision.text, isGroup: !!isGroup, history })
    .catch((err) => console.error("[WA-INCOMING]", err.message));
});

// Gateway push, following a want_media:true response above (design-phase2.md §7). Same guard as
// /wa/incoming. Body: { msgId, from, groupId, mediaType, mimetype, filename, caption, data (base64) }.
// Relies on server.js's global express.json() limit being large enough for a base64-encoded 25MB
// file (~34MB encoded) - bumped there alongside this route.
router.post("/wa/media", express.json({ limit: "40mb" }), async (req, res) => {
  if (req.headers["cf-connecting-ip"]) return res.status(403).json({ error: "Forbidden" });
  const secret = req.headers["x-wa-secret"];
  if (!secret || secret !== process.env.WA_SHARED_SECRET) return res.status(403).json({ error: "Forbidden" });

  try {
    const result = await waMedia.store(req.body || {});
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof DomainError) return res.status(err.code === "FORBIDDEN" ? 403 : 400).json({ error: err.message });
    console.error("[WA-MEDIA]", err.stack || err.message);
    res.status(500).json({ error: "Eroare internă de server" });
  }
});

module.exports = router;
