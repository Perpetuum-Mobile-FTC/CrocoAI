// Audio -> transcript pipeline (design-phase2.md §4): ffmpeg converts the uploaded audio to
// mono 16kHz WAV segments of ~10 minutes, each segment is sent to Groq's `whisper-large-v3`
// (language=ro) via `fetch`/multipart. Runs as a background job; the `meetings` row IS the job
// status (audio_status/audio_error/transcript) - no separate job table needed. Never throws to
// the caller: failures are recorded on the row so the PV can still be drafted/edited manually.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const db = require("../db");

const SEGMENT_SECONDS = 600; // ~10 min (design-phase2.md §4)
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3";

function isConfigured() {
  return !!process.env.GROQ_API_KEY;
}

// Splits `inputPath` into mono/16kHz WAV segments inside `outDir`. Resolves to an ordered list
// of absolute file paths.
function segmentAudio(inputPath, outDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    const pattern = path.join(outDir, "seg-%03d.wav");
    const args = ["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", "-f", "segment", "-segment_time", String(SEGMENT_SECONDS), pattern];
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (err) => reject(new Error(`ffmpeg indisponibil: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg a eșuat (cod ${code}): ${stderr.slice(-500)}`));
      const files = fs.readdirSync(outDir).filter((f) => f.startsWith("seg-") && f.endsWith(".wav")).sort();
      if (!files.length) return reject(new Error("Niciun segment audio generat."));
      resolve(files.map((f) => path.join(outDir, f)));
    });
  });
}

// Sends ONE segment to Groq. Node 22's built-in fetch/FormData/Blob - no extra dependency.
async function transcribeSegment(filePath) {
  if (!isConfigured()) throw new Error("GROQ_API_KEY lipsește.");
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("model", GROQ_MODEL);
  form.append("language", "ro");
  form.append("response_format", "json");
  form.append("file", new Blob([buf]), path.basename(filePath));
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq a răspuns cu eroare (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.text || "";
}

// Transcribes every segment IN ORDER (sequential, not Promise.all) so the resulting transcript
// keeps chronological order regardless of each request's response time.
async function transcribeAllSegments(filePaths) {
  const texts = [];
  for (let i = 0; i < filePaths.length; i++) {
    const text = await transcribeSegment(filePaths[i]);
    texts.push({ index: i, text });
  }
  return texts;
}

// Full pipeline for one meeting's audio file. Updates the `meetings` row as it progresses.
// Never throws - callers run this detached (fire-and-forget).
async function runJob(meetingId, audioAbsPath) {
  if (!isConfigured()) {
    db.prepare("UPDATE meetings SET audio_status='error', audio_error=? WHERE id=?")
      .run("Transcrierea automată necesită GROQ_API_KEY - completează procesul verbal manual.", meetingId);
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crocoai-transcribe-"));
  try {
    const segments = await segmentAudio(audioAbsPath, tmpDir);
    const texts = await transcribeAllSegments(segments);
    const transcript = texts.map((t) => t.text.trim()).filter(Boolean).join("\n\n");
    db.prepare("UPDATE meetings SET audio_status='done', transcript=?, transcript_segments=?, audio_error=NULL WHERE id=?")
      .run(transcript, JSON.stringify(texts), meetingId);
  } catch (err) {
    db.prepare("UPDATE meetings SET audio_status='error', audio_error=? WHERE id=?").run(err.message, meetingId);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Fire-and-forget wrapper used by services/meetings.js right after the upload is saved.
function transcribeInBackground(meetingId, audioAbsPath) {
  runJob(meetingId, audioAbsPath).catch((err) => console.error("[TRANSCRIPTION]", err.stack || err.message));
}

module.exports = {
  isConfigured, segmentAudio, transcribeSegment, transcribeAllSegments, runJob, transcribeInBackground,
  SEGMENT_SECONDS, GROQ_MODEL,
};
