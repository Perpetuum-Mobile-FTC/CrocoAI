// Poze cu consimțământ (design-phase2.md §5, Art. 45.4, 59). Files stored at
// data/photos/<yyyy>/<mm>/<uuid>.<ext> + a thumbnail (sharp), served ONLY through the authorized
// route handlers below - never statically. Publication state is never a stored boolean: it's
// recomputed on every read from rules.photoPublication() against each tagged member's LIVE
// anexa13_foto_video consent (approved + not withdrawn).
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const sharp = require("sharp");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");
const { photoPublication, isMinor } = require("../domain/rules");
const notifications = require("./notifications");
const audience = require("./audience");

const PHOTOS_DIR = process.env.PHOTOS_DIR || path.join(__dirname, "..", "..", "data", "photos");
const MAX_SIZE = 25 * 1024 * 1024;
const THUMB_WIDTH = 480;
const MEDIUM_WIDTH = 1600; // what every viewer sees in the lightbox (design-pachet-b.md B3)

// --- Magic-byte validation (design §5: "validate type by magic bytes") ---
const IMAGE_MAGIC = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
};
function detectMediaType(mime, buffer) {
  if (mime === "image/jpeg" || mime === "image/png") {
    const magic = IMAGE_MAGIC[mime];
    const header = Array.from(buffer.slice(0, magic.length));
    if (!magic.every((b, i) => header[i] === b)) throw new DomainError("INVALID", "Conținutul fișierului nu corespunde tipului declarat.");
    return "image";
  }
  if (mime === "image/heic" || mime === "image/heif") {
    const ftyp = buffer.slice(4, 8).toString("ascii");
    if (ftyp !== "ftyp") throw new DomainError("INVALID", "Conținutul fișierului nu corespunde tipului declarat.");
    return "image"; // thumbnail generation may fail for HEIC - handled gracefully below
  }
  if (mime === "video/mp4" || mime === "video/quicktime" || mime === "video/webm" || mime === "video/3gpp") {
    return "video"; // video magic bytes vary too much by container; mimetype is enough here
  }
  throw new DomainError("INVALID", "Tip de fișier neacceptat (imagini JPG/PNG/HEIC sau video scurt).");
}

// --- Consent (Art. 59) ---
// Latest anexa13_foto_video document + latest withdrawal event decide the live consent state.
// A withdrawal "wins" only if it happened after the latest approval (re-consent via a newer
// approved document cancels an older withdrawal) - keeps every withdrawal as a permanent audit row.
function consentFor(memberId) {
  const doc = db.prepare(`
    SELECT * FROM member_documents WHERE member_id = ? AND type_key = 'anexa13_foto_video'
    ORDER BY uploaded_at DESC LIMIT 1
  `).get(memberId);
  const approved = !!doc && doc.status === "aprobat";
  const withdrawal = db.prepare(`
    SELECT * FROM photo_consent_withdrawals WHERE member_id = ? ORDER BY withdrawn_at DESC LIMIT 1
  `).get(memberId);
  const withdrawn = !!withdrawal && (!approved || !doc.reviewed_at || withdrawal.withdrawn_at > doc.reviewed_at);
  return { approved, withdrawn };
}

function withdrawConsent(actor) {
  db.prepare("INSERT INTO photo_consent_withdrawals (member_id) VALUES (?)").run(actor.id);
  return { withdrawn: true };
}

function myConsentStatus(actor) {
  const c = consentFor(actor.id);
  const pub = photoPublication([{ member_id: actor.id, name: actor.full_name || "tu", ...c }]);
  return { ...c, minor: isMinor(actor.birthdate), publishable: pub.publishable, article: pub.article, message: pub.message };
}

// Publication state for a single photo, computed live from its current tags.
function publicationFor(photoId) {
  const tags = db.prepare(`
    SELECT pt.member_id, m.full_name AS name FROM photo_tags pt
    JOIN members m ON m.id = pt.member_id WHERE pt.photo_id = ?
  `).all(photoId);
  if (!tags.length) return { publishable: true, article: "Art. 59.1", message: "Nicio persoană etichetată." };
  const consents = tags.map((t) => ({ member_id: t.member_id, name: t.name, ...consentFor(t.member_id) }));
  return photoPublication(consents);
}

function decoratePhoto(row) {
  const tags = db.prepare(`
    SELECT pt.member_id, m.full_name AS name FROM photo_tags pt
    JOIN members m ON m.id = pt.member_id WHERE pt.photo_id = ? ORDER BY m.full_name COLLATE NOCASE
  `).all(row.id);
  return {
    ...row,
    published: !!row.published,
    reported_private: !!row.reported_private,
    tags,
    publication: publicationFor(row.id),
  };
}

// --- Albums ---
function listAlbums(actor) {
  assertCan(actor, "photos.view");
  return db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM photos p WHERE p.album_id = a.id) AS photo_count
    FROM albums a ORDER BY COALESCE(a.month, '') DESC, a.created_at DESC
  `).all();
}

function getAlbum(id) {
  const a = db.prepare("SELECT * FROM albums WHERE id = ?").get(id);
  if (!a) throw new DomainError("NOT_FOUND", "Album negăsit.");
  return a;
}

function createAlbum(actor, { title, month, event_id, session_id }) {
  assertCan(actor, "photos.upload");
  if (!title || !title.trim()) throw new DomainError("INVALID", "Titlul albumului e obligatoriu.");
  const info = db.prepare(`
    INSERT INTO albums (title, month, event_id, session_id, source, created_by) VALUES (?, ?, ?, ?, 'platforma', ?)
  `).run(title.trim(), month || null, event_id || null, session_id || null, actor.id);
  return getAlbum(info.lastInsertRowid);
}

// Used by wa-media.js (system call, not actor-gated): one album per tracked group per month.
function findOrCreateGroupAlbum(groupId, groupName, month) {
  const existing = db.prepare("SELECT * FROM albums WHERE wa_group_id = ? AND month = ?").get(groupId, month);
  if (existing) return existing;
  const title = `${groupName || "Grup WhatsApp"} — ${month}`;
  const info = db.prepare(`
    INSERT INTO albums (title, month, source, wa_group_id) VALUES (?, ?, 'whatsapp', ?)
  `).run(title, month, groupId);
  return getAlbum(info.lastInsertRowid);
}

function listPhotos(actor, albumId) {
  assertCan(actor, "photos.view");
  getAlbum(albumId);
  const rows = db.prepare("SELECT * FROM photos WHERE album_id = ? ORDER BY uploaded_at DESC").all(albumId);
  // Per-photo rights for the lightbox (the UI shows only what the server would allow).
  return rows.map((r) => ({
    ...decoratePhoto(r),
    can_tag: can(actor, "photos.tag", r),
    can_delete: can(actor, "photos.delete", r),
    can_download_original: can(actor, "photos.download_original", r),
  }));
}

function getPhoto(id) {
  const p = db.prepare("SELECT * FROM photos WHERE id = ?").get(id);
  if (!p) throw new DomainError("NOT_FOUND", "Poză negăsită.");
  return p;
}

// --- Upload (platform) ---
async function ensureThumb(absPath, mediaType, destThumbPath) {
  if (mediaType !== "image") return null; // video thumbnails are out of scope (design §5: "fine")
  try {
    await sharp(absPath).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).jpeg({ quality: 70 }).toFile(destThumbPath);
    return destThumbPath;
  } catch (err) {
    console.error("[PHOTOS] thumbnail failed:", err.message); // e.g. unsupported HEIC build - OK without one
    return null;
  }
}

// Written to a unique temp file, then renamed: a concurrent reader never sees a half-written JPEG.
async function makeMedium(absPath, destPath) {
  const tmp = `${destPath}.${process.pid}.${crypto.randomUUID()}.tmp.jpg`;
  try {
    await sharp(absPath).rotate().resize({ width: MEDIUM_WIDTH, height: MEDIUM_WIDTH, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(tmp);
    fs.renameSync(tmp, destPath);
    return destPath;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    console.error("[PHOTOS] medium variant failed:", err.message);
    return null;
  }
}

function mediumRelFor(photo) {
  const rel = photo.file_path;
  return path.join(path.dirname(rel), `${path.basename(rel, path.extname(rel))}.medium.jpg`);
}

function storeFile(buffer, ext) {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dir = path.join(PHOTOS_DIR, yyyy, mm);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const filePath = path.join(dir, `${id}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return { filePath, relPath: path.relative(PHOTOS_DIR, filePath), thumbRelPath: path.relative(PHOTOS_DIR, path.join(dir, `${id}.thumb.jpg`)) };
}

// Single-file upload; routes/photos.js calls this once per file in a multi-upload request.
async function upload(actor, albumId, file) {
  assertCan(actor, "photos.upload");
  getAlbum(albumId);
  if (!file || !file.buffer) throw new DomainError("INVALID", "Fișier lipsă.");
  if (file.size > MAX_SIZE) throw new DomainError("INVALID", "Fișierul depășește 25 MB.");
  const mediaType = detectMediaType(file.mimetype, file.buffer);

  const ext = path.extname(file.originalname) || "";
  const { filePath, relPath, thumbRelPath } = storeFile(file.buffer, ext);
  const thumbPath = await ensureThumb(filePath, mediaType, path.join(PHOTOS_DIR, thumbRelPath));
  const mediumRel = mediumRelFor({ file_path: relPath });
  const mediumPath = mediaType === "image" ? await makeMedium(filePath, path.join(PHOTOS_DIR, mediumRel)) : null;

  const info = db.prepare(`
    INSERT INTO photos (album_id, file_path, thumb_path, medium_path, mime, media_type, size, original_name, uploaded_by, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'platforma')
  `).run(albumId, relPath, thumbPath ? thumbRelPath : null, mediumPath ? mediumRel : null, file.mimetype, mediaType, file.size, file.originalname || null, actor.id);

  return decoratePhoto(getPhoto(info.lastInsertRowid));
}

// --- Tagging ---
function assertCanTag(actor, photo) {
  assertCan(actor, "photos.tag", photo);
}

function tagMember(actor, photoId, memberId) {
  const photo = getPhoto(photoId);
  assertCanTag(actor, photo);
  const member = db.prepare("SELECT id FROM members WHERE id = ?").get(memberId);
  if (!member) throw new DomainError("NOT_FOUND", "Membru negăsit.");
  db.prepare(`
    INSERT INTO photo_tags (photo_id, member_id, tagged_by) VALUES (?, ?, ?)
    ON CONFLICT(photo_id, member_id) DO NOTHING
  `).run(photoId, memberId, actor.id);
  return decoratePhoto(photo);
}

function untagMember(actor, photoId, memberId) {
  const photo = getPhoto(photoId);
  assertCanTag(actor, photo);
  db.prepare("DELETE FROM photo_tags WHERE photo_id = ? AND member_id = ?").run(photoId, memberId);
  return decoratePhoto(photo);
}

// --- Delete ---
function remove(actor, photoId) {
  const photo = getPhoto(photoId);
  assertCan(actor, "photos.delete", photo);
  for (const rel of [photo.file_path, photo.thumb_path, photo.medium_path]) {
    if (!rel) continue;
    try { fs.unlinkSync(path.join(PHOTOS_DIR, rel)); } catch { /* already gone - fine */ }
  }
  db.prepare("DELETE FROM photos WHERE id = ?").run(photoId);
}

// --- Publish/unpublish (LEADERS, Art. 59.5, only if publishable right now) ---
function publish(actor, photoId, value) {
  assertCan(actor, "photos.publish");
  const photo = getPhoto(photoId);
  if (value) {
    const pub = publicationFor(photoId);
    if (!pub.publishable) throw new DomainError("FORBIDDEN", pub.message, pub.article);
    db.prepare("UPDATE photos SET published = 1, published_by = ?, published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(actor.id, photoId);
  } else {
    db.prepare("UPDATE photos SET published = 0, published_by = NULL, published_at = NULL WHERE id = ?").run(photoId);
  }
  return decoratePhoto(getPhoto(photoId));
}

// --- Authorized file access (never static) ---
function authorizedPath(actor, photoId, variant) {
  assertCan(actor, "photos.view");
  const photo = getPhoto(photoId);
  if (variant === "original") assertCan(actor, "photos.download_original", photo, "Doar Team Leader/Co-Leader pot descărca originalul.");
  // A7: no thumbnail (HEIC, video, failed resize) -> placeholder; the original is never served as a thumb.
  if (variant === "thumb" && !photo.thumb_path) return { photo, absPath: null, placeholder: true };
  const rel = variant === "thumb" ? photo.thumb_path : photo.file_path;
  const absPath = path.join(PHOTOS_DIR, rel);
  return { photo, absPath };
}

// The large view for every viewer (photos.view): a ~1600px JPEG, made on first request for older photos /
// WhatsApp imports. Videos have no reduced variant: the video itself is what a viewer plays. No variant possible
// (e.g. HEIC without decoder) -> the thumbnail or the placeholder; the original stays leaders/uploader only.
async function mediumFile(actor, photoId) {
  assertCan(actor, "photos.view");
  const photo = getPhoto(photoId);
  if (photo.media_type === "video") return { absPath: path.join(PHOTOS_DIR, photo.file_path), mime: photo.mime };
  if (photo.medium_path && fs.existsSync(path.join(PHOTOS_DIR, photo.medium_path))) {
    return { absPath: path.join(PHOTOS_DIR, photo.medium_path), mime: "image/jpeg" };
  }
  const rel = mediumRelFor(photo);
  if (await makeMedium(path.join(PHOTOS_DIR, photo.file_path), path.join(PHOTOS_DIR, rel))) {
    db.prepare("UPDATE photos SET medium_path = ? WHERE id = ?").run(rel, photo.id);
    return { absPath: path.join(PHOTOS_DIR, rel), mime: "image/jpeg" };
  }
  if (photo.thumb_path) return { absPath: path.join(PHOTOS_DIR, photo.thumb_path), mime: "image/jpeg" };
  return { absPath: null, placeholder: true };
}

// --- Report "context privat" (Art. 59.4) ---
function reportPrivate(actor, photoId) {
  assertCan(actor, "photos.view");
  const photo = getPhoto(photoId);
  db.prepare(`
    UPDATE photos SET reported_private = 1, reported_by = ?, reported_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?
  `).run(actor.id, photoId);
  for (const l of audience.activeLeaders()) {
    notifications.create(l.id, "photo_reported", "Poză raportată context privat",
      `${actor.full_name} a raportat o poză din albumul #${photo.album_id} (Art. 59.4).`, "/documente?tab=poze");
  }
  return decoratePhoto(getPhoto(photoId));
}

// --- AI tools helpers ---
function photosOf(actor, memberId) {
  assertCan(actor, "photos.view");
  const rows = db.prepare(`
    SELECT p.* FROM photos p JOIN photo_tags pt ON pt.photo_id = p.id
    WHERE pt.member_id = ? ORDER BY p.uploaded_at DESC
  `).all(memberId);
  return rows.map(decoratePhoto);
}

function unpublishable(actor) {
  assertCan(actor, "photos.publish");
  const rows = db.prepare("SELECT * FROM photos ORDER BY uploaded_at DESC").all();
  return rows.map(decoratePhoto).filter((p) => !p.publication.publishable);
}

module.exports = {
  PHOTOS_DIR,
  listAlbums,
  getAlbum,
  createAlbum,
  findOrCreateGroupAlbum,
  listPhotos,
  getPhoto,
  upload,
  tagMember,
  untagMember,
  remove,
  publish,
  authorizedPath,
  mediumFile,
  reportPrivate,
  consentFor,
  withdrawConsent,
  myConsentStatus,
  publicationFor,
  photosOf,
  unpublishable,
  detectMediaType,
  decoratePhoto,
};
