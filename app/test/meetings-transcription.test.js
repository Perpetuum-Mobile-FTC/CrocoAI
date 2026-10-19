// Groq transcription client + Google Meet client: mocked fetch, no real network, no ffmpeg
// required (segmentAudio itself isn't exercised here - only the pure fetch-calling functions).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const DB_FILE = path.join(__dirname, "._meetings_transcription_test.db");
process.env.DB_PATH = DB_FILE;
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const db = require("../src/db");
const transcription = require("../src/services/transcription");
const googleMeet = require("../src/services/google-meet");

const originalFetch = global.fetch;
let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crocoai-transcription-test-"));
});

after(() => {
  global.fetch = originalFetch;
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.GROQ_API_KEY;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_TEAM_REFRESH_TOKEN;
});

test("transcription.isConfigured reflects GROQ_API_KEY", () => {
  delete process.env.GROQ_API_KEY;
  assert.equal(transcription.isConfigured(), false);
  process.env.GROQ_API_KEY = "test-groq-key";
  assert.equal(transcription.isConfigured(), true);
});

test("transcribeSegment throws without GROQ_API_KEY (no network attempted)", async () => {
  delete process.env.GROQ_API_KEY;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error("should not be called"); };
  const file = path.join(tmpDir, "seg-000.wav");
  fs.writeFileSync(file, Buffer.from([0, 1, 2, 3]));
  await assert.rejects(() => transcription.transcribeSegment(file), /GROQ_API_KEY/);
  assert.equal(fetchCalled, false);
  process.env.GROQ_API_KEY = "test-groq-key";
});

test("transcribeAllSegments preserves input order even when later segments resolve first", async () => {
  const files = [0, 1, 2].map((i) => {
    const f = path.join(tmpDir, `seg-ord-${i}.wav`);
    fs.writeFileSync(f, Buffer.from([i]));
    return f;
  });
  const callOrder = [];
  global.fetch = async (url, opts) => {
    const idx = callOrder.length;
    callOrder.push(idx);
    // Simulate out-of-order network latency: segment 0 is "slowest".
    const delay = idx === 0 ? 15 : 0;
    await new Promise((r) => setTimeout(r, delay));
    return {
      ok: true,
      json: async () => ({ text: `segment-${idx}` }),
    };
  };
  const result = await transcription.transcribeAllSegments(files);
  assert.deepEqual(result.map((r) => r.text), ["segment-0", "segment-1", "segment-2"]);
  assert.deepEqual(result.map((r) => r.index), [0, 1, 2]);
});

test("transcribeSegment surfaces Groq HTTP errors with status + body", async () => {
  global.fetch = async () => ({ ok: false, status: 401, text: async () => "invalid api key" });
  const file = path.join(tmpDir, "seg-err.wav");
  fs.writeFileSync(file, Buffer.from([9]));
  await assert.rejects(() => transcription.transcribeSegment(file), /401/);
});

test("transcription.runJob records a friendly error on the meeting row when GROQ_API_KEY is missing", async () => {
  delete process.env.GROQ_API_KEY;
  db.prepare("INSERT INTO members (full_name, phone, role, auth_role, status) VALUES ('TL T','40700020001','team_leader','team_leader','activ')").run();
  const sess = db.prepare("INSERT INTO attendance_sessions (date, start_time, type, title, created_by) VALUES ('2026-09-09','18:00','sedinta','S', 1)").run();
  const meeting = db.prepare("INSERT INTO meetings (session_id, created_by) VALUES (?, 1)").run(sess.lastInsertRowid);
  await transcription.runJob(meeting.lastInsertRowid, "/nonexistent/audio.mp3");
  const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(meeting.lastInsertRowid);
  assert.equal(row.audio_status, "error");
  assert.match(row.audio_error, /GROQ_API_KEY/);
  process.env.GROQ_API_KEY = "test-groq-key";
});

test("google-meet.isConfigured is false without the 3 required env vars; createMeetingEvent resolves null (never throws, never blocks)", async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_TEAM_REFRESH_TOKEN;
  assert.equal(googleMeet.isConfigured(), false);
  const result = await googleMeet.createMeetingEvent({ title: "x", startTime: "2026-09-09T18:00:00", endTime: "2026-09-09T20:00:00" });
  assert.equal(result, null);
});

test("google-meet.createMeetingEvent returns the hangoutLink when configured (mocked fetch)", async () => {
  process.env.GOOGLE_CLIENT_ID = "cid";
  process.env.GOOGLE_CLIENT_SECRET = "csecret";
  process.env.GOOGLE_TEAM_REFRESH_TOKEN = "rtoken";
  global.fetch = async (url) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      return { ok: true, json: async () => ({ access_token: "tok123" }) };
    }
    return { ok: true, json: async () => ({ id: "evt1", hangoutLink: "https://meet.google.com/abc-defg-hij" }) };
  };
  const result = await googleMeet.createMeetingEvent({ title: "Ședință", startTime: "2026-09-09T18:00:00", endTime: "2026-09-09T20:00:00" });
  assert.deepEqual(result, { link: "https://meet.google.com/abc-defg-hij", eventId: "evt1" });
});

test("google-meet.createMeetingEvent returns null (not throws) when Google responds with an error", async () => {
  global.fetch = async () => ({ ok: false, status: 500 });
  const result = await googleMeet.createMeetingEvent({ title: "x", startTime: "2026-09-09T18:00:00", endTime: "2026-09-09T20:00:00" });
  assert.equal(result, null);
});
