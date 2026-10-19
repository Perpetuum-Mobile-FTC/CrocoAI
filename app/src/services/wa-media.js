// Stores media pushed by the gateway from a tracked WhatsApp group (design-phase2.md §5, §7).
// Not actor-gated - called only from routes/wa-incoming's /wa/media, guarded the same way as
// /wa/incoming (x-wa-secret + not reachable through the public tunnel).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { normalizePhone } = require("../domain/phone");
const photos = require("./photos");
const waGroups = require("./wa-groups");

const MAX_SIZE = 25 * 1024 * 1024;

function monthOf(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// { msgId, from, groupId, mediaType, mimetype, filename, caption, data } - data is base64.
async function store({ msgId, from, groupId, mediaType, mimetype, filename, data }) {
  if (!groupId) throw new DomainError("INVALID", "Media fără grup.");
  if (!waGroups.isTracked(groupId)) throw new DomainError("FORBIDDEN", "Grup neurmărit.");
  if (!["image", "video"].includes(mediaType)) throw new DomainError("INVALID", "Tip de media neacceptat.");
  if (!data) throw new DomainError("INVALID", "Conținut media lipsă.");

  const buffer = Buffer.from(data, "base64");
  if (buffer.length > MAX_SIZE) throw new DomainError("INVALID", "Fișierul depășește 25 MB.");
  photos.detectMediaType(mimetype, buffer); // validates magic bytes, throws INVALID on mismatch

  // Idempotency: a msgId already stored is ignored (same contract as /wa/incoming).
  if (msgId && db.prepare("SELECT 1 FROM photos WHERE wa_msg_id = ?").get(msgId)) {
    return { stored: false };
  }

  const group = db.prepare("SELECT * FROM wa_groups WHERE group_id = ?").get(groupId);
  const month = monthOf();
  const album = photos.findOrCreateGroupAlbum(groupId, group && group.name, month);

  const fromDigits = from ? normalizePhone(from) : null;
  const sender = fromDigits ? db.prepare("SELECT id FROM members WHERE phone = ?").get(fromDigits) : null;

  const ext = filename && filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  const dir = path.join(photos.PHOTOS_DIR, String(new Date().getUTCFullYear()), String(new Date().getUTCMonth() + 1).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const filePath = path.join(dir, `${id}${ext}`);
  fs.writeFileSync(filePath, buffer);
  const relPath = path.relative(photos.PHOTOS_DIR, filePath);

  let thumbRelPath = null;
  if (mediaType === "image") {
    try {
      const thumbPath = path.join(dir, `${id}.thumb.jpg`);
      await sharp(filePath).resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 70 }).toFile(thumbPath);
      thumbRelPath = path.relative(photos.PHOTOS_DIR, thumbPath);
    } catch (err) {
      console.error("[WA-MEDIA] thumbnail failed:", err.message);
    }
  }

  const info = db.prepare(`
    INSERT INTO photos (album_id, file_path, thumb_path, mime, media_type, size, original_name, uploaded_by, source, wa_msg_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp', ?)
  `).run(album.id, relPath, thumbRelPath, mimetype, mediaType, buffer.length, filename || null, sender ? sender.id : null, msgId || null);

  return { stored: true, photo_id: info.lastInsertRowid, album_id: album.id };
}

module.exports = { store };
