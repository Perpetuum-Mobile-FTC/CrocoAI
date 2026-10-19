// Disk storage for assignment materials and submissions (design-teme-grupuri.md §1.3):
// data/assignments/<assignment_id>/{materials,submissions/<submission_id>}/<uuid>.<ext>.
// Never served statically - only through authorized routes.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { DomainError } = require("../domain/errors");

const MAX_SIZE = 25 * 1024 * 1024;
const root = () => path.resolve(process.env.ASSIGNMENTS_DIR || path.join(__dirname, "..", "..", "data", "assignments"));

// multer decodes multipart filenames as latin1, so "Temă.pdf" arrives as "TemÄ\x83.pdf". Re-decode as
// UTF-8 only when every char fits latin1 (otherwise the name is already proper UTF-8 and latin1
// re-encoding would truncate chars above U+00FF). If the re-decode yields replacement chars the
// name was not UTF-8 bytes, keep it as received.
function originalName(file) {
  const raw = String((file && file.originalname) || "fisier");
  let name = raw;
  if (!/[^\x00-\xff]/.test(raw)) {
    const utf8 = Buffer.from(raw, "latin1").toString("utf8");
    if (!utf8.includes("\uFFFD")) name = utf8;
  }
  return path.basename(name).slice(0, 200) || "fisier";
}

function check(file) {
  if (!file || !file.buffer) throw new DomainError("INVALID", "Fișier lipsă.");
  if (file.size > MAX_SIZE) throw new DomainError("INVALID", "Fișier prea mare (max 25 MB).");
}

function absPath(rel) {
  const abs = path.resolve(root(), String(rel || ""));
  if (!abs.startsWith(root() + path.sep)) throw new DomainError("NOT_FOUND", "Fișier negăsit.");
  return abs;
}

function save(relDir, file) {
  check(file);
  const filename = originalName(file);
  const ext = path.extname(filename).toLowerCase().slice(0, 10);
  const rel = path.join(relDir, crypto.randomUUID() + ext);
  const abs = absPath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, file.buffer);
  return { filename, path: rel, size: file.size, mime: file.mimetype || null };
}

function remove(rel) {
  try { fs.unlinkSync(absPath(rel)); } catch {}
}

function removeAssignmentDir(assignmentId) {
  fs.rmSync(path.join(root(), String(Number(assignmentId))), { recursive: true, force: true });
}

module.exports = { MAX_SIZE, originalName, check, save, absPath, remove, removeAssignmentDir };
