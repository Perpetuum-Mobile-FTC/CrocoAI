// Documents (GDPR/participation). Design v2 §7. Files are never served statically - always
// through the authorized download endpoint. Stored at data/documents/<member_id>/<uuid>.<ext>.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can, isSelf } = require("../domain/policy");
const { isMinor, documentGuidance, MEDICAL_DESTRUCTION } = require("../domain/rules");
const auditLog = require("./audit-log");
const audience = require("./audience");
const notifications = require("./notifications");

const DOCS_DIR = process.env.DOCUMENTS_DIR || path.join(__dirname, "..", "..", "data", "documents");

function listTypes() {
  return db.prepare("SELECT * FROM document_types").all();
}

function getType(key) {
  const t = db.prepare("SELECT * FROM document_types WHERE key = ?").get(key);
  if (!t) throw new DomainError("NOT_FOUND", "Tip de document necunoscut.");
  return t;
}

// Which document types are required for a given member (design §7 required_for column).
function requiredFor(member) {
  const minor = isMinor(member.birthdate);
  const hasUpcomingDeplasareMinori = minor && db.prepare(`
    SELECT 1 FROM events WHERE type = 'competitie' AND start_time > datetime('now') LIMIT 1
  `).get();
  return listTypes().filter((t) => {
    if (t.required_for === "toti") return true;
    if (t.required_for === "minori") return minor;
    if (t.required_for === "majori") return !minor;
    if (t.required_for === "deplasare_minori") return !!hasUpcomingDeplasareMinori;
    return false;
  }).map((t) => ({ ...t, ...documentGuidance(t.key, minor) }));
}

// Latest document (any status) per type for a member, plus required list with status.
function myStatus(actor, memberId) {
  assertCan(actor, "documents.view", { member_id: memberId });
  const member = db.prepare("SELECT * FROM members WHERE id = ?").get(memberId);
  if (!member) throw new DomainError("NOT_FOUND", "Membru negăsit.");
  const required = requiredFor(member);
  const docs = db.prepare("SELECT * FROM member_documents WHERE member_id = ? ORDER BY uploaded_at DESC").all(memberId);
  return required.map((t) => {
    const latest = docs.find((d) => d.type_key === t.key) || null;
    return { ...t, document: latest };
  });
}

function assertMimeAllowed(mime, buffer) {
  const allowed = {
    "application/pdf": [0x25, 0x50, 0x44, 0x46], // %PDF
    "image/jpeg": [0xff, 0xd8, 0xff],
    "image/png": [0x89, 0x50, 0x4e, 0x47],
    "image/heic": null, // magic bytes vary (ftyp box at offset 4); checked separately below
    "image/heif": null,
  };
  if (!(mime in allowed)) throw new DomainError("INVALID", "Tip de fișier neacceptat (doar PDF/JPG/PNG/HEIC).");
  const magic = allowed[mime];
  if (magic) {
    const header = Array.from(buffer.slice(0, magic.length));
    if (!magic.every((b, i) => header[i] === b)) throw new DomainError("INVALID", "Conținutul fișierului nu corespunde tipului declarat.");
  } else {
    const ftyp = buffer.slice(4, 8).toString("ascii");
    if (ftyp !== "ftyp") throw new DomainError("INVALID", "Conținutul fișierului nu corespunde tipului declarat.");
  }
}

function upload(actor, memberId, typeKey, file, eventId) {
  const owner = db.prepare("SELECT status FROM members WHERE id = ?").get(memberId);
  assertCan(actor, "documents.upload", { member_id: memberId, type_key: typeKey, member_status: owner && owner.status },
    "Fișa medicală nu se încarcă pentru un membru ieșit din echipă (Art. 41.8).");
  getType(typeKey);
  if (!file || !file.buffer) throw new DomainError("INVALID", "Fișier lipsă.");
  const MAX_SIZE = 15 * 1024 * 1024;
  if (file.size > MAX_SIZE) throw new DomainError("INVALID", "Fișierul depășește 15 MB.");
  assertMimeAllowed(file.mimetype, file.buffer);

  const memberDir = path.join(DOCS_DIR, String(memberId));
  fs.mkdirSync(memberDir, { recursive: true });
  const ext = path.extname(file.originalname) || "";
  const fileName = `${crypto.randomUUID()}${ext}`;
  const filePath = path.join(memberDir, fileName);
  fs.writeFileSync(filePath, file.buffer);

  const info = db.prepare(`
    INSERT INTO member_documents (member_id, type_key, event_id, file_path, original_name, mime, size, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'incarcat')
  `).run(memberId, typeKey, eventId || null, path.relative(DOCS_DIR, filePath), file.originalname, file.mimetype, file.size);

  const body = `${db.prepare("SELECT full_name FROM members WHERE id=?").get(memberId).full_name} a încărcat ${getType(typeKey).title}`;
  for (const id of audience.leaderIds()) notifications.create(id, "document_uploaded", "Document încărcat", body, "/documente");

  return db.prepare("SELECT * FROM member_documents WHERE id = ?").get(info.lastInsertRowid);
}

function review(actor, docId, status, note) {
  assertCan(actor, "documents.review");
  if (!["aprobat", "respins"].includes(status)) throw new DomainError("INVALID", "Status invalid.");
  const doc = db.prepare("SELECT * FROM member_documents WHERE id = ?").get(docId);
  if (!doc) throw new DomainError("NOT_FOUND", "Document negăsit.");
  db.prepare(`
    UPDATE member_documents SET status=?, review_note=?, reviewed_by=?, reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(status, note || null, actor.id, docId);
  db.prepare("INSERT INTO notifications (member_id, type, title, body, link) VALUES (?, 'document_reviewed', ?, ?, '/documente')")
    .run(doc.member_id, status === "aprobat" ? "Document aprobat" : "Document respins", note || null);
  // Onboarding checklist hook (design-phase2.md §6): auto-tick "documente" once all required
  // docs are approved. Lazy require avoids a circular dependency (onboarding.js requires this file).
  if (status === "aprobat") {
    try { require("./onboarding").onDocumentApproved(doc.member_id); } catch { /* no active onboarding, ignore */ }
  }
  return db.prepare("SELECT * FROM member_documents WHERE id = ?").get(docId);
}

// Art. 72.3: the regulament box ticked when the account was created counts as a signed Anexa 6. Stored as an
// approved anexa6_regulament row without a file - the note keeps the moment and the version accepted. A member who
// already has an approved Anexa 6 keeps it.
const REGULAMENT_TYPE = "anexa6_regulament";
function recordRegulamentAcceptance(memberId, { at, version, guardian }) {
  const approved = db.prepare("SELECT 1 FROM member_documents WHERE member_id = ? AND type_key = ? AND status = 'aprobat'").get(memberId, REGULAMENT_TYPE);
  if (approved) return;
  const note = `Acceptat electronic la crearea contului (Art. 72.3), regulament v${version || "?"}${guardian ? ", cu acordul părintelui/tutorelui" : ""}.`;
  db.prepare(`
    INSERT INTO member_documents (member_id, type_key, status, review_note, reviewed_at, uploaded_at)
    VALUES (?, ?, 'aprobat', ?, ?, ?)
  `).run(memberId, REGULAMENT_TYPE, note, at, at);
  try { require("./onboarding").onDocumentApproved(memberId); } catch { /* no active onboarding, ignore */ }
}

// Returns absolute file path if actor is allowed to download this document.
function authorizedFilePath(actor, docId) {
  const doc = db.prepare("SELECT * FROM member_documents WHERE id = ?").get(docId);
  if (!doc) throw new DomainError("NOT_FOUND", "Document negăsit.");
  assertCan(actor, "documents.view_file", doc);
  if (!doc.file_path) throw new DomainError("NOT_FOUND", "Document acceptat electronic, fără fișier (Art. 72.3).");
  // Art. 41.4: access log for medical sheets opened by someone other than the owner (no file content) -
  // persistent in audit_log (TL reads it in Admin), plus one line in the container log.
  if (doc.type_key === "fisa_medicala" && !isSelf(actor, doc.member_id)) {
    auditLog.record({ actor, action: "fisa_medicala.open", member_id: doc.member_id, object_type: "member_document", object_id: doc.id });
    console.log(`[AUDIT] fisa_medicala: member ${actor.id} (${actor.role}) opened the sheet of member ${doc.member_id} (doc ${doc.id}) at ${new Date().toISOString()}`);
  }
  return { doc, absPath: path.join(DOCS_DIR, doc.file_path) };
}

// Art. 41.8: delete every medical-sheet row of a member (+ one content-free audit_log entry, only if there was
// something to destroy). DB part only, so callers can run it inside their own transaction; returns the file paths
// to pass to removeFiles() AFTER the commit. `actor` null = the retention job.
function destroyMedicalRows(actor, memberId) {
  const rows = db.prepare("SELECT id, file_path FROM member_documents WHERE member_id = ? AND type_key = ?")
    .all(memberId, MEDICAL_DESTRUCTION.typeKey);
  if (!rows.length) return [];
  db.prepare("DELETE FROM member_documents WHERE member_id = ? AND type_key = ?").run(memberId, MEDICAL_DESTRUCTION.typeKey);
  auditLog.record({ actor, action: MEDICAL_DESTRUCTION.auditAction, member_id: memberId, object_type: "member", detail: `count=${rows.length}` });
  return rows.map((r) => r.file_path);
}

// Best effort: a failure is logged (path only) and never undoes the DB deletion; the file is then orphaned on disk.
function removeFiles(relPaths) {
  let failures = 0;
  for (const rel of relPaths) {
    try { fs.rmSync(path.join(DOCS_DIR, rel), { force: true }); }
    catch (err) { failures += 1; console.log(`[MEDICAL] could not delete file ${rel}: ${err.message}`); }
  }
  return failures;
}

// Orphans: files left in an 'iesit' member's folder that no member_documents row references (a delete that failed
// earlier). Only regular files inside DOCS_DIR/<id>/ are touched; a failure is counted and retried on the next run.
function removeOrphanFiles(memberId) {
  const out = { removed: 0, failures: 0 };
  const root = path.resolve(DOCS_DIR);
  const dir = path.resolve(root, String(memberId));
  if (path.dirname(dir) !== root || !fs.existsSync(dir)) return out;
  const referenced = new Set(db.prepare("SELECT file_path FROM member_documents WHERE member_id = ?").all(memberId)
    .map((r) => path.resolve(root, r.file_path)));
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (!ent.isFile() || referenced.has(abs)) continue; // regular files only, never a symlink or subdir
    try { fs.rmSync(abs); out.removed += 1; }
    catch (err) { out.failures += 1; console.log(`[MEDICAL] could not delete orphan ${memberId}/${ent.name}: ${err.message}`); }
  }
  try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* not empty or already gone */ }
  return out;
}

// Retention safety net: members already 'iesit' that still have a sheet. Returns the number of rows destroyed,
// plus orphan files removed / delete failures (the latter are retried by the next daily run).
function destroyMedicalOfLeftMembers() {
  const ids = db.prepare(`SELECT DISTINCT d.member_id id FROM member_documents d JOIN members m ON m.id = d.member_id
    WHERE d.type_key = ? AND m.status = 'iesit'`).all(MEDICAL_DESTRUCTION.typeKey).map((r) => r.id);
  let files = [];
  db.transaction(() => { for (const id of ids) files = files.concat(destroyMedicalRows(null, id)); })();
  let failures = removeFiles(files);
  let orphans = 0;
  for (const m of db.prepare("SELECT id FROM members WHERE status = 'iesit'").all()) {
    const r = removeOrphanFiles(m.id);
    orphans += r.removed; failures += r.failures;
  }
  return { destroyed: files.length, orphans_removed: orphans, file_failures: failures };
}

// LEADERS matrix: members x document types, with status (and "lipsă" filter done client-side).
function matrix(actor) {
  assertCan(actor, "documents.review");
  const members = db.prepare("SELECT * FROM members WHERE status != 'iesit'").all();
  return members.map((m) => ({
    member_id: m.id,
    name: m.full_name,
    documents: myStatus(actor, m.id).map((d) => ({
      key: d.key,
      title: d.title,
      status: d.document ? d.document.status : "lipsa",
      document_id: d.document ? d.document.id : null,
      can_open: !!d.document && !!d.document.file_path && can(actor, "documents.view_file", d.document), // the UI shows „Deschide fișierul” only then
      electronic: !!d.document && !d.document.file_path, // Art. 72.3: accepted at sign-up, no file
      uploaded_at: d.document ? d.document.uploaded_at : null,
      review_note: d.document ? d.document.review_note : null,
    })),
  }));
}

module.exports = { DOCS_DIR, listTypes, getType, requiredFor, myStatus, upload, review, authorizedFilePath, recordRegulamentAcceptance, matrix, destroyMedicalRows, removeFiles, destroyMedicalOfLeftMembers };
