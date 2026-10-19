// multer (memory) for assignment uploads: maps multer limit errors to DomainError so the client
// gets a 400 with a Romanian message instead of a 500 (design-teme-grupuri.md §1.3).
const fs = require("fs");
const multer = require("multer");
const { DomainError } = require("../domain/errors");
const { MAX_SIZE } = require("../services/assignment-files");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SIZE, files: 10 } });

function uploadArray(field) {
  const mw = upload.array(field, 10);
  return (req, res, next) => mw(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return next(new DomainError("INVALID", "Fișier prea mare (max 25 MB)."));
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") return next(new DomainError("INVALID", "Maxim 10 fișiere odată."));
    next(err);
  });
}

function sendDownload(res, row, absPath) {
  if (!fs.existsSync(absPath)) throw new DomainError("NOT_FOUND", "Fișier negăsit pe disc.");
  res.setHeader("Content-Type", row.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
  res.send(fs.readFileSync(absPath)); // not res.sendFile: requires options.root on Express 5
}

module.exports = { uploadArray, sendDownload };
