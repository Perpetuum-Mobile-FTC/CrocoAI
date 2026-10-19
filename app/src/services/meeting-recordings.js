// Live recording of a meeting, uploaded chunk by chunk (design-sedinte-v2.md §3). The browser's
// MediaRecorder emits timeslice chunks; concatenating them in seq order yields a valid file (only
// chunk 0 carries the container header), so seq is strict. Parts live on disk under
// <AUDIO_DIR>/<meeting>/rec-<id>/<seq>.part; `meeting_recordings.chunks` is the next expected seq.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan } = require("../domain/policy");
const transcriptionSvc = require("./transcription");

const AUDIO_DIR = () => process.env.MEETINGS_AUDIO_DIR || path.join(__dirname, "..", "..", "data", "meetings");
const MAX_CHUNK_BYTES = 5 * 1024 * 1024;

function meetingOr404(id) {
  const m = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id);
  if (!m) throw new DomainError("NOT_FOUND", "Ședință/PV negăsit.");
  return m;
}
function recordingOr404(meetingId, rid) {
  const r = db.prepare("SELECT * FROM meeting_recordings WHERE id = ? AND meeting_id = ?").get(rid, meetingId);
  if (!r) throw new DomainError("NOT_FOUND", "Înregistrare negăsită.");
  return r;
}
const recDir = (meetingId, rid) => path.join(AUDIO_DIR(), String(meetingId), `rec-${rid}`);

function extFor(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("mp4") || m.includes("aac") || m.includes("m4a")) return ".m4a";
  if (m.includes("ogg")) return ".ogg";
  return ".webm";
}

function view(r) {
  if (!r) return { recording_id: null };
  return { recording_id: r.id, status: r.status, chunks: r.chunks, bytes: r.bytes, started_at: r.started_at, last_chunk_at: r.last_chunk_at, mime: r.mime };
}

function activeRecording(meetingId) {
  return db.prepare("SELECT * FROM meeting_recordings WHERE meeting_id = ? AND status = 'recording' ORDER BY id DESC LIMIT 1").get(meetingId);
}

function startRecording(actor, meetingId, { mime, replace } = {}) {
  assertCan(actor, "meetings.manage");
  const meeting = meetingOr404(meetingId);
  if (meeting.status === "approved") throw new DomainError("INVALID", "PV aprobat este imuabil (Art. 49.2).");
  if (activeRecording(meetingId)) {
    throw new DomainError("CONFLICT", "Există deja o înregistrare neterminată pentru această ședință - finalizeaz-o sau renunță la ea.");
  }
  if (["processing", "done"].includes(meeting.audio_status) && !replace) {
    throw new DomainError("CONFLICT", "Ședința are deja audio. Trimite replace: true pentru a-l înlocui.");
  }
  const info = db.prepare("INSERT INTO meeting_recordings (meeting_id, started_by, mime) VALUES (?, ?, ?)")
    .run(meetingId, actor.id, mime ? String(mime).slice(0, 100) : null);
  fs.mkdirSync(recDir(meeting.id, info.lastInsertRowid), { recursive: true });
  return { recording_id: info.lastInsertRowid };
}

function getRecording(actor, meetingId) {
  assertCan(actor, "meetings.manage");
  meetingOr404(meetingId);
  return view(activeRecording(meetingId));
}

// seq == chunks -> store; seq < chunks -> duplicate (200, untouched); seq > chunks -> 409 expected_seq.
function uploadChunk(actor, meetingId, rid, seq, buffer) {
  assertCan(actor, "meetings.manage");
  const meeting = meetingOr404(meetingId);
  const rec = recordingOr404(meeting.id, rid);
  if (rec.status !== "recording") throw new DomainError("INVALID", "Înregistrarea nu mai e activă.");
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 0) throw new DomainError("INVALID", "seq invalid.");
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new DomainError("INVALID", "Bucată goală.");
  if (buffer.length > MAX_CHUNK_BYTES) throw new DomainError("INVALID", "Bucata depășește 5 MB.");
  const touch = () => db.prepare("UPDATE meeting_recordings SET last_chunk_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(rec.id);
  if (n < rec.chunks) { touch(); return { received: rec.chunks, bytes: rec.bytes, duplicate: true }; }
  if (n > rec.chunks) {
    const err = new DomainError("CONFLICT", `Bucată lipsă: se așteaptă seq=${rec.chunks}.`);
    err.extra = { expected_seq: rec.chunks };
    throw err;
  }
  const dir = recDir(meeting.id, rec.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${n}.part`), buffer);
  db.prepare("UPDATE meeting_recordings SET chunks = chunks + 1, bytes = bytes + ?, last_chunk_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(buffer.length, rec.id);
  return { received: n + 1, bytes: rec.bytes + buffer.length, duplicate: false };
}

// Concatenates the parts in order into one file and hands it to the existing transcription pipeline.
function stopRecording(actor, meetingId, rid) {
  assertCan(actor, "meetings.manage");
  const meeting = meetingOr404(meetingId);
  const rec = recordingOr404(meeting.id, rid);
  const meetings = require("./meetings"); // lazy: meetings.js re-exports this module
  if (rec.status === "finalized") return meetings.get(actor, meeting.id); // idempotent
  if (rec.status !== "recording") throw new DomainError("INVALID", "Înregistrarea a fost abandonată.");
  if (meeting.status === "approved") throw new DomainError("INVALID", "PV aprobat este imuabil (Art. 49.2).");
  if (rec.chunks < 1) throw new DomainError("INVALID", "Nicio bucată primită - nu există nimic de finalizat.");

  const dir = recDir(meeting.id, rec.id);
  const outDir = path.join(AUDIO_DIR(), String(meeting.id));
  const absPath = path.join(outDir, `${crypto.randomUUID()}${extFor(rec.mime)}`);
  const fd = fs.openSync(absPath, "w");
  try {
    for (let i = 0; i < rec.chunks; i++) {
      const part = path.join(dir, `${i}.part`);
      if (!fs.existsSync(part)) throw new DomainError("INVALID", `Bucata ${i} lipsește de pe server.`);
      fs.writeSync(fd, fs.readFileSync(part));
    }
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(absPath, { force: true });
    throw err;
  }
  fs.closeSync(fd);

  db.transaction(() => {
    db.prepare("UPDATE meeting_recordings SET status='finalized' WHERE id = ?").run(rec.id);
    db.prepare(`
      UPDATE meetings SET audio_path=?, audio_status='processing', audio_error=NULL, transcript=NULL, transcript_segments=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
    `).run(path.relative(AUDIO_DIR(), absPath), meeting.id);
  })();
  fs.rmSync(dir, { recursive: true, force: true });
  transcriptionSvc.transcribeInBackground(meeting.id, absPath);
  return meetings.get(actor, meeting.id);
}

function abandonRecording(actor, meetingId, rid) {
  assertCan(actor, "meetings.manage");
  const meeting = meetingOr404(meetingId);
  const rec = recordingOr404(meeting.id, rid);
  if (rec.status === "finalized") throw new DomainError("INVALID", "Înregistrarea e deja finalizată.");
  db.prepare("UPDATE meeting_recordings SET status='abandoned' WHERE id = ?").run(rec.id);
  fs.rmSync(recDir(meeting.id, rec.id), { recursive: true, force: true });
  return { ok: true };
}

module.exports = { MAX_CHUNK_BYTES, startRecording, getRecording, uploadChunk, stopRecording, abandonRecording };
