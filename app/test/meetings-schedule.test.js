// Ședințe all-in-one (design-sedinte-v2.md §5): scheduling + announcement, reschedule, cancel,
// chunked live recording (order, idempotent duplicate, gap -> 409, 5 MB limit, stop -> concatenated
// file + transcription started - mocked), resume after interruption, permissions.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers, login } = require("./_assign-env");

const env = initEnv("sedinte_v2");
const AUDIO_DIR = path.join(__dirname, "._sedinte_v2_audio");
fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
process.env.MEETINGS_AUDIO_DIR = AUDIO_DIR;

const { server } = require("../server");
const db = require("../src/db");
const meetingsSvc = require("../src/services/meetings");
const attendanceSvc = require("../src/services/attendance");
const { DomainError } = require("../src/domain/errors");

let M, BASE, C;
const transcribed = []; // [{ meetingId, file }]
const originalTranscribe = require("../src/services/transcription").transcribeInBackground;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "mentor", role: "mentor" },
    { key: "a", role: "member" },
    { key: "b", role: "member" },
    { key: "gone", role: "member", status: "iesit" },
  ]);
  C = {};
  for (const k of ["tl", "a"]) C[k] = await login(BASE, M[k].phone);
  require("../src/services/transcription").transcribeInBackground = (meetingId, file) => transcribed.push({ meetingId, file });
});

after(async () => {
  require("../src/services/transcription").transcribeInBackground = originalTranscribe;
  await new Promise((r) => server.close(r));
  db.close();
  env.cleanup();
  fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
  delete process.env.MEETINGS_AUDIO_DIR;
  delete process.env.TEAM_GROUP_ID;
});

beforeEach(() => { env.waSent.length = 0; process.env.TEAM_GROUP_ID = "120363000000@g.us"; });

function req(cookie, method, url, body, headers) {
  const isBuf = Buffer.isBuffer(body);
  return fetch(BASE + url, {
    method,
    headers: { ...(body && !isBuf ? { "Content-Type": "application/json" } : {}), ...(headers || {}), Cookie: cookie },
    body: body == null ? undefined : (isBuf ? body : JSON.stringify(body)),
  });
}
const base = (over) => ({ title: "Ședința săptămânală", type: "sedinta", date: "2027-03-02", time: "18:30", duration: 90, mode: "fizic", location: "Sala S03", agenda: ["Robot", "Buget"], ...over });
const notifCount = (id) => db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND type = 'meeting'").get(id).c;

// ─── Programare ────────────────────────────────────────────────────────────────────────────────
test("schedule creates event + attendance session + meeting in one go and announces on the group + in-app", async () => {
  const m = await meetingsSvc.schedule(M.tl, base());
  assert.ok(m.id);
  assert.deepEqual(m.agenda, ["Robot", "Buget"]);
  assert.equal(m.session.date, "2027-03-02");
  assert.equal(m.session.start_time, "18:30");
  assert.equal(m.session.type, "sedinta");
  assert.ok(m.session.event_id);
  const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(m.session.event_id);
  assert.equal(ev.location, "Sala S03");
  assert.equal(ev.type, "sedinta");
  // Bucharest 18:30 in March (EET, UTC+2) = 16:30Z, 90 min -> 18:00Z
  assert.equal(ev.start_time, "2027-03-02T16:30:00.000Z");
  assert.equal(ev.end_time, "2027-03-02T18:00:00.000Z");

  assert.equal(env.waSent.length, 1);
  assert.equal(env.waSent[0].to, "120363000000@g.us");
  assert.match(env.waSent[0].text, /^📅 Ședință Ședința săptămânală — .*02\.03, ora 18:30, Sala S03\. Ordinea de zi: Robot; Buget/);
  assert.equal(notifCount(M.a.id), 1);
  assert.equal(notifCount(M.tl.id), 1);
  assert.equal(notifCount(M.gone.id), 0, "inactive members get no in-app notification");
});

test("schedule without TEAM_GROUP_ID announces in-app only", async () => {
  delete process.env.TEAM_GROUP_ID;
  const before = notifCount(M.a.id);
  await meetingsSvc.schedule(M.tl, base({ date: "2027-03-09" }));
  assert.equal(env.waSent.length, 0);
  assert.equal(notifCount(M.a.id), before + 1);
});

test("schedule online with a manual link (Meet not configured) uses the link in the announcement", async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  const m = await meetingsSvc.schedule(M.tl, base({ date: "2027-03-16", mode: "online", location: undefined, meet_link: "https://meet.google.com/abc-defg-hij" }));
  assert.equal(m.meet_link, "https://meet.google.com/abc-defg-hij");
  assert.equal(m.mode, "online");
  assert.match(env.waSent[0].text, /https:\/\/meet\.google\.com\/abc-defg-hij/);
  await assert.rejects(() => meetingsSvc.schedule(M.tl, base({ date: "2027-03-17", mode: "online", location: undefined })), DomainError);
});

test("schedule validates input and rejects non-managers", async () => {
  await assert.rejects(() => meetingsSvc.schedule(M.a, base({ date: "2027-04-01" })), (e) => e.code === "FORBIDDEN");
  await assert.rejects(() => meetingsSvc.schedule(M.tl, base({ title: "" })), (e) => e.code === "INVALID");
  await assert.rejects(() => meetingsSvc.schedule(M.tl, base({ type: "competitie" })), (e) => e.code === "INVALID");
  await assert.rejects(() => meetingsSvc.schedule(M.tl, base({ date: "02/03/2027" })), (e) => e.code === "INVALID");
  await assert.rejects(() => meetingsSvc.schedule(M.tl, base({ time: "25:00" })), (e) => e.code === "INVALID");
  await assert.rejects(() => meetingsSvc.schedule(M.tl, base({ location: "" })), (e) => e.code === "INVALID");
  assert.equal(env.waSent.length, 0);
});

test("a duplicate slot rolls back everything (no orphan event/meeting, no announcement)", async () => {
  const ev0 = db.prepare("SELECT COUNT(*) c FROM events").get().c;
  await meetingsSvc.schedule(M.tl, base({ date: "2027-04-06" }));
  env.waSent.length = 0;
  const ev1 = db.prepare("SELECT COUNT(*) c FROM events").get().c;
  await assert.rejects(() => meetingsSvc.schedule(M.tl, base({ date: "2027-04-06" })), DomainError);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events").get().c, ev1);
  assert.equal(ev1, ev0 + 1);
  assert.equal(env.waSent.length, 0);
});

test("POST /api/meetings/schedule works over HTTP; members get 403", async () => {
  const res = await req(C.tl, "POST", "/api/meetings/schedule", base({ date: "2027-05-04" }));
  assert.equal(res.status, 200);
  assert.ok((await res.json()).id);
  const denied = await req(C.a, "POST", "/api/meetings/schedule", base({ date: "2027-05-11" }));
  assert.equal(denied.status, 403);
});

// ─── Modificare ────────────────────────────────────────────────────────────────────────────────
test("reschedule updates event + session and announces only when date/time/place changed", async () => {
  const m = await meetingsSvc.schedule(M.tl, base({ date: "2027-06-01" }));
  env.waSent.length = 0;

  await meetingsSvc.reschedule(M.tl, m.id, { title: "Titlu nou", agenda: ["Alt punct"] });
  assert.equal(env.waSent.length, 0, "title/agenda-only change must not announce");

  const moved = await meetingsSvc.reschedule(M.tl, m.id, { time: "19:00" });
  assert.equal(moved.session.start_time, "19:00");
  assert.equal(moved.session.title, "Titlu nou");
  const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(m.session.event_id);
  assert.equal(ev.start_time, "2027-06-01T16:00:00.000Z");
  assert.equal(env.waSent.length, 1);
  assert.match(env.waSent[0].text, /Ședință modificată/);
  assert.match(env.waSent[0].text, /ora 19:00/);

  await meetingsSvc.reschedule(M.tl, m.id, { location: "Sala S04" });
  assert.equal(env.waSent.length, 2);
  assert.equal(db.prepare("SELECT location FROM events WHERE id = ?").get(m.session.event_id).location, "Sala S04");
});

test("reschedule is MANAGERS only and refused after the PV is approved", async () => {
  const m = await meetingsSvc.schedule(M.tl, base({ date: "2027-06-08" }));
  await assert.rejects(() => meetingsSvc.reschedule(M.a, m.id, { time: "20:00" }), (e) => e.code === "FORBIDDEN");
  db.prepare("UPDATE meetings SET status='approved' WHERE id = ?").run(m.id);
  await assert.rejects(() => meetingsSvc.reschedule(M.tl, m.id, { time: "20:00" }), (e) => e.code === "INVALID");
});

// ─── Anulare ───────────────────────────────────────────────────────────────────────────────────
test("cancel deletes meeting + session + event and announces", async () => {
  const m = await meetingsSvc.schedule(M.tl, base({ date: "2027-07-06" }));
  env.waSent.length = 0;
  await meetingsSvc.cancel(M.tl, m.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM meetings WHERE id = ?").get(m.id).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attendance_sessions WHERE id = ?").get(m.session.id).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE id = ?").get(m.session.event_id).c, 0);
  assert.equal(env.waSent.length, 1);
  assert.match(env.waSent[0].text, /Ședință anulată/);
});

test("cancel is refused when attendance is marked, audio exists, a recording exists or the PV is approved", async () => {
  const withAtt = await meetingsSvc.schedule(M.tl, base({ date: "2027-07-13" }));
  attendanceSvc.markRecords(M.tl, withAtt.session.id, [{ member_id: M.a.id, status: "prezent" }]);
  await assert.rejects(() => meetingsSvc.cancel(M.tl, withAtt.id), (e) => e.code === "INVALID");

  const withAudio = await meetingsSvc.schedule(M.tl, base({ date: "2027-07-20" }));
  db.prepare("UPDATE meetings SET audio_status='done', audio_path='x/y.webm' WHERE id = ?").run(withAudio.id);
  await assert.rejects(() => meetingsSvc.cancel(M.tl, withAudio.id), (e) => e.code === "INVALID");

  const withRec = await meetingsSvc.schedule(M.tl, base({ date: "2027-07-27" }));
  meetingsSvc.startRecording(M.tl, withRec.id, {});
  await assert.rejects(() => meetingsSvc.cancel(M.tl, withRec.id), (e) => e.code === "INVALID");

  const approved = await meetingsSvc.schedule(M.tl, base({ date: "2027-08-03" }));
  db.prepare("UPDATE meetings SET status='approved' WHERE id = ?").run(approved.id);
  await assert.rejects(() => meetingsSvc.cancel(M.tl, approved.id), (e) => e.code === "INVALID");
  assert.equal(env.waSent.filter((s) => /anulată/.test(s.text)).length, 0);

  const plain = await meetingsSvc.schedule(M.tl, base({ date: "2027-08-10" }));
  await assert.rejects(() => meetingsSvc.cancel(M.a, plain.id), (e) => e.code === "FORBIDDEN");
});

// ─── Vizibilitate ──────────────────────────────────────────────────────────────────────────────
test("active members see upcoming meeting details (no draft/transcript); past unapproved stay hidden", async () => {
  const m = await meetingsSvc.schedule(M.tl, base({ date: "2099-01-05" }));
  const seen = meetingsSvc.get(M.a, m.id);
  assert.equal(seen.session.date, "2099-01-05");
  assert.deepEqual(seen.agenda, ["Robot", "Buget"]);
  assert.equal(seen.draft, undefined);
  assert.equal(seen.transcript, undefined);
  assert.ok(meetingsSvc.list(M.a, {}).some((r) => r.meeting_id === m.id));

  const past = await meetingsSvc.schedule(M.tl, base({ date: "2020-01-07" }));
  assert.throws(() => meetingsSvc.get(M.a, past.id), DomainError);
  assert.ok(!meetingsSvc.list(M.a, {}).some((r) => r.meeting_id === past.id));
});

// ─── Înregistrare live ─────────────────────────────────────────────────────────────────────────
async function newMeeting(date) { return meetingsSvc.schedule(M.tl, base({ date })); }
const chunkUrl = (mid, rid, seq) => `/api/meetings/${mid}/recording/${rid}/chunk?seq=${seq}`;
const bin = (...bytes) => Buffer.from(bytes);

test("chunks: strict order, duplicate idempotent, gap -> 409 expected_seq, then stop concatenates in order and starts transcription", async () => {
  const m = await newMeeting("2027-09-07");
  const startRes = await req(C.tl, "POST", `/api/meetings/${m.id}/recording/start`, { mime: "audio/webm;codecs=opus" });
  assert.equal(startRes.status, 200);
  const { recording_id: rid } = await startRes.json();
  assert.ok(rid);

  const hdr = { "Content-Type": "audio/webm" };
  let r = await req(C.tl, "POST", chunkUrl(m.id, rid, 0), bin(1, 2, 3), hdr);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).received, 1);

  r = await req(C.tl, "POST", chunkUrl(m.id, rid, 2), bin(9, 9), hdr);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).expected_seq, 1);

  r = await req(C.tl, "POST", chunkUrl(m.id, rid, 1), bin(4, 5), hdr);
  assert.equal(r.status, 200);

  // duplicate of seq 0 with DIFFERENT bytes: 200, not rewritten
  r = await req(C.tl, "POST", chunkUrl(m.id, rid, 0), bin(7, 7, 7), hdr);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).duplicate, true);

  r = await req(C.tl, "POST", chunkUrl(m.id, rid, 2), bin(6), hdr);
  assert.equal(r.status, 200);

  const st = await (await req(C.tl, "GET", `/api/meetings/${m.id}/recording`)).json();
  assert.equal(st.recording_id, rid);
  assert.equal(st.chunks, 3);
  assert.equal(st.bytes, 6);

  transcribed.length = 0;
  const stop = await req(C.tl, "POST", `/api/meetings/${m.id}/recording/${rid}/stop`);
  assert.equal(stop.status, 200);
  const body = await stop.json();
  assert.equal(body.audio_status, "processing");
  assert.equal(transcribed.length, 1);
  assert.equal(transcribed[0].meetingId, m.id);
  assert.match(transcribed[0].file, /\.webm$/);
  assert.deepEqual([...fs.readFileSync(transcribed[0].file)], [1, 2, 3, 4, 5, 6]);

  const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(m.id);
  assert.equal(row.audio_status, "processing");
  assert.equal(db.prepare("SELECT status FROM meeting_recordings WHERE id = ?").get(rid).status, "finalized");
  // no active recording left
  assert.equal((await (await req(C.tl, "GET", `/api/meetings/${m.id}/recording`)).json()).recording_id, null);
  // parts cleaned up, only the final file remains
  assert.ok(!fs.existsSync(path.join(AUDIO_DIR, String(m.id), `rec-${rid}`)));
});

test("mp4 mime yields an .m4a final file", async () => {
  const m = await newMeeting("2027-09-14");
  const { recording_id: rid } = meetingsSvc.startRecording(M.tl, m.id, { mime: "audio/mp4" });
  meetingsSvc.uploadChunk(M.tl, m.id, rid, 0, bin(1));
  transcribed.length = 0;
  meetingsSvc.stopRecording(M.tl, m.id, rid);
  assert.match(transcribed[0].file, /\.m4a$/);
});

test("a chunk over 5 MB is rejected (413) and an empty chunk is invalid", async () => {
  const m = await newMeeting("2027-09-21");
  const { recording_id: rid } = meetingsSvc.startRecording(M.tl, m.id, {});
  const big = Buffer.alloc(5 * 1024 * 1024 + 1024, 1);
  let r = await req(C.tl, "POST", chunkUrl(m.id, rid, 0), big, { "Content-Type": "audio/webm" });
  assert.equal(r.status, 413);
  r = await req(C.tl, "POST", chunkUrl(m.id, rid, 0), Buffer.alloc(0), { "Content-Type": "audio/webm" });
  assert.equal(r.status, 400);
  r = await req(C.tl, "POST", `/api/meetings/${m.id}/recording/${rid}/chunk?seq=abc`, bin(1), { "Content-Type": "audio/webm" });
  assert.equal(r.status, 400);
  assert.equal(db.prepare("SELECT chunks FROM meeting_recordings WHERE id = ?").get(rid).chunks, 0);
});

test("resume after interruption: GET shows the unfinished recording; stop finalizes it; abandon discards it", async () => {
  const m = await newMeeting("2027-09-28");
  const { recording_id: rid } = meetingsSvc.startRecording(M.tl, m.id, { mime: "audio/webm" });
  meetingsSvc.uploadChunk(M.tl, m.id, rid, 0, bin(1, 1));
  meetingsSvc.uploadChunk(M.tl, m.id, rid, 1, bin(2, 2));
  // "new page session"
  const st = meetingsSvc.getRecording(M.tl, m.id);
  assert.equal(st.recording_id, rid);
  assert.equal(st.chunks, 2);
  assert.equal(st.bytes, 4);
  assert.ok(st.started_at);
  // cannot start a second one while one is unfinished
  assert.throws(() => meetingsSvc.startRecording(M.tl, m.id, {}), (e) => e.code === "CONFLICT");
  // abandon
  meetingsSvc.abandonRecording(M.tl, m.id, rid);
  assert.equal(meetingsSvc.getRecording(M.tl, m.id).recording_id, null);
  assert.ok(!fs.existsSync(path.join(AUDIO_DIR, String(m.id), `rec-${rid}`)));
  assert.throws(() => meetingsSvc.uploadChunk(M.tl, m.id, rid, 2, bin(3)), DomainError);
  // new one can start, and stop with zero chunks is invalid
  const second = meetingsSvc.startRecording(M.tl, m.id, {});
  assert.throws(() => meetingsSvc.stopRecording(M.tl, m.id, second.recording_id), (e) => e.code === "INVALID");
});

test("start is refused when the meeting already has audio unless replace:true; refused after PV approval", async () => {
  const m = await newMeeting("2027-10-05");
  db.prepare("UPDATE meetings SET audio_status='done', audio_path='a/b.webm' WHERE id = ?").run(m.id);
  assert.throws(() => meetingsSvc.startRecording(M.tl, m.id, {}), (e) => e.code === "CONFLICT" && /replace/i.test(e.message));
  const { recording_id: rid } = meetingsSvc.startRecording(M.tl, m.id, { replace: true });
  assert.ok(rid);
  meetingsSvc.abandonRecording(M.tl, m.id, rid);
  db.prepare("UPDATE meetings SET status='approved' WHERE id = ?").run(m.id);
  assert.throws(() => meetingsSvc.startRecording(M.tl, m.id, { replace: true }), (e) => e.code === "INVALID");
});

test("recording endpoints require meetings.manage", async () => {
  const m = await newMeeting("2027-10-12");
  for (const [method, url] of [
    ["POST", `/api/meetings/${m.id}/recording/start`],
    ["GET", `/api/meetings/${m.id}/recording`],
    ["POST", `/api/meetings/${m.id}/recording/1/stop`],
    ["POST", `/api/meetings/${m.id}/recording/1/abandon`],
  ]) {
    const r = await req(C.a, method, url, method === "POST" ? {} : undefined);
    assert.equal(r.status, 403, `${method} ${url}`);
  }
  const r = await req(C.a, "POST", chunkUrl(m.id, 1, 0), bin(1), { "Content-Type": "audio/webm" });
  assert.equal(r.status, 403);
});

// ─── Prezență (pre-marcare M) ──────────────────────────────────────────────────────────────────
test("session detail flags approved absences for the date as suggested 'motivat' (no record yet)", async () => {
  const m = await newMeeting("2027-11-02");
  db.prepare("INSERT INTO absence_requests (member_id, date, reason, status) VALUES (?, '2027-11-02', 'x', 'aprobata')").run(M.b.id);
  db.prepare("INSERT INTO absence_requests (member_id, date, reason, status) VALUES (?, '2027-11-02', 'x', 'pending')").run(M.a.id);
  const detail = attendanceSvc.getSessionDetail(M.tl, m.session.id);
  assert.equal(detail.roster.find((r) => r.id === M.b.id).suggested, "motivat");
  assert.equal(detail.roster.find((r) => r.id === M.a.id).suggested, undefined);
});

// ─── Fix round 1 ───────────────────────────────────────────────────────────────────────────────
const eventsSvc = require("../src/services/events");
function recurringMeeting(startIso) {
  const ev = eventsSvc.create(M.tl, { title: "Serie", type: "sedinta", location: "S03", start_time: startIso, end_time: new Date(Date.parse(startIso) + 3600000).toISOString(),
    recurrence: "weekly", recurrence_until: new Date(Date.parse(startIso) + 14 * 86400000).toISOString() });
  const sessions = db.prepare("SELECT * FROM attendance_sessions WHERE event_id = ? ORDER BY date").all(ev.id);
  assert.equal(sessions.length, 3);
  return { ev, sessions, meeting: meetingsSvc.getOrCreateForSession(M.tl, sessions[1].id) };
}

test("reschedule of a meeting in a recurring series detaches it: series event and other sessions untouched", async () => {
  const { ev, sessions, meeting } = recurringMeeting("2028-01-04T16:00:00.000Z");
  const moved = await meetingsSvc.reschedule(M.tl, meeting.id, { date: "2028-01-12", time: "19:00", location: "Sala S09", title: "Doar asta" });
  assert.notEqual(moved.session.event_id, ev.id);
  const own = db.prepare("SELECT * FROM events WHERE id = ?").get(moved.session.event_id);
  assert.equal(own.recurrence, null);
  assert.equal(own.location, "Sala S09");
  const series = db.prepare("SELECT * FROM events WHERE id = ?").get(ev.id);
  assert.equal(series.start_time, "2028-01-04T16:00:00.000Z");
  assert.equal(series.title, "Serie");
  assert.equal(series.recurrence, "weekly");
  const left = db.prepare("SELECT id FROM attendance_sessions WHERE event_id = ?").all(ev.id).map((r) => r.id);
  assert.deepEqual(left.sort(), [sessions[0].id, sessions[2].id].sort());
});

test("cancel of a meeting in a recurring series removes only that session", async () => {
  const { ev, sessions, meeting } = recurringMeeting("2028-02-01T16:00:00.000Z");
  await meetingsSvc.cancel(M.tl, meeting.id);
  assert.ok(db.prepare("SELECT id FROM events WHERE id = ?").get(ev.id), "series event must survive");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attendance_sessions WHERE event_id = ?").get(ev.id).c, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attendance_sessions WHERE id = ?").get(sessions[1].id).c, 0);
});

test("GET recording exposes last_chunk_at, updated by each chunk", () => {
  return newMeeting("2028-03-07").then((m) => {
    const { recording_id: rid } = meetingsSvc.startRecording(M.tl, m.id, {});
    assert.equal(meetingsSvc.getRecording(M.tl, m.id).last_chunk_at, null);
    meetingsSvc.uploadChunk(M.tl, m.id, rid, 0, bin(1));
    assert.match(meetingsSvc.getRecording(M.tl, m.id).last_chunk_at, /^\d{4}-\d\d-\d\dT/);
  });
});

test("meet_link must be https (schedule, reschedule, manual set)", async () => {
  const mk = (over) => base({ date: "2028-04-04", mode: "online", location: undefined, ...over });
  await assert.rejects(() => meetingsSvc.schedule(M.tl, mk({ meet_link: "javascript:alert(1)" })), (e) => e.code === "INVALID");
  await assert.rejects(() => meetingsSvc.schedule(M.tl, mk({ meet_link: "http://meet.example/x" })), (e) => e.code === "INVALID");
  const m = await meetingsSvc.schedule(M.tl, mk({ meet_link: "https://meet.google.com/aaa-bbbb-ccc" }));
  await assert.rejects(() => meetingsSvc.reschedule(M.tl, m.id, { meet_link: "ftp://x" }), (e) => e.code === "INVALID");
  assert.throws(() => meetingsSvc.setMeetLinkManual(M.tl, m.id, "javascript:1"), (e) => e.code === "INVALID");
});

test("reschedule keeps an auto Meet (source/event id) when the same link is resent", async () => {
  const m = await meetingsSvc.schedule(M.tl, base({ date: "2028-05-02", mode: "online", location: undefined, meet_link: "https://meet.google.com/zzz-yyyy-xxx" }));
  db.prepare("UPDATE meetings SET meet_source='auto', meet_event_id='gev1' WHERE id = ?").run(m.id);
  const r = await meetingsSvc.reschedule(M.tl, m.id, { time: "19:30", meet_link: "https://meet.google.com/zzz-yyyy-xxx", mode: "online" });
  assert.equal(r.meet_source, "auto");
  assert.equal(r.meet_event_id, "gev1");
});

test("reschedule of a team-scoped session maps a UNIQUE clash to a DomainError (not 500)", async () => {
  const team = db.prepare("INSERT INTO teams (name) VALUES ('Echipa X')").run().lastInsertRowid;
  const a = await meetingsSvc.schedule(M.tl, base({ date: "2028-06-06", time: "17:00" }));
  const b = await meetingsSvc.schedule(M.tl, base({ date: "2028-06-06", time: "18:00" }));
  db.prepare("UPDATE attendance_sessions SET team_id = ? WHERE id IN (?, ?)").run(team, a.session.id, b.session.id);
  await assert.rejects(() => meetingsSvc.reschedule(M.tl, b.id, { time: "17:00" }), (e) => e instanceof DomainError);
});

test("disk paths use DB ids, not URL params (recording dir under the meeting id)", () => {
  return newMeeting("2028-07-04").then((m) => {
    const { recording_id: rid } = meetingsSvc.startRecording(M.tl, m.id, {});
    assert.throws(() => meetingsSvc.uploadChunk(M.tl, `${m.id}/../../x`, rid, 0, bin(1)), DomainError);
    meetingsSvc.uploadChunk(M.tl, String(m.id), String(rid), "0", bin(1));
    assert.ok(fs.existsSync(path.join(AUDIO_DIR, String(m.id), `rec-${rid}`, "0.part")));
  });
});

// ─── Fix round 2 ───────────────────────────────────────────────────────────────────────────────
test("a cancelled session of a recurring series is not recreated when the series is updated", async () => {
  const { ev, sessions, meeting } = recurringMeeting("2028-08-01T16:00:00.000Z");
  await meetingsSvc.cancel(M.tl, meeting.id);
  eventsSvc.update(M.tl, ev.id, { title: "Serie 2" });
  const dates = db.prepare("SELECT date FROM attendance_sessions WHERE event_id = ?").all(ev.id).map((r) => r.date);
  assert.ok(!dates.includes(sessions[1].date));
  assert.equal(dates.length, 2);
});

test("the original slot of a detached (rescheduled) session is not recreated by the series", async () => {
  const { ev, sessions, meeting } = recurringMeeting("2028-09-05T16:00:00.000Z");
  await meetingsSvc.reschedule(M.tl, meeting.id, { date: "2028-09-14", time: "19:00" });
  eventsSvc.update(M.tl, ev.id, { title: "Serie 3" });
  const orig = db.prepare("SELECT COUNT(*) c FROM attendance_sessions WHERE event_id = ? AND date = ?").get(ev.id, sessions[1].date).c;
  assert.equal(orig, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attendance_sessions WHERE date = ? AND type = 'sedinta' AND event_id != ?").get(sessions[1].date, ev.id).c, 0);
});

// ─── Fix round 3 ───────────────────────────────────────────────────────────────────────────────
test("detachSharedEvent is atomic: a failing copy leaves no exception row and the session keeps its event", () => {
  const { ev, meeting } = recurringMeeting("2028-10-03T16:00:00.000Z");
  const realCreate = eventsSvc.insertEvent; // the copy goes through the unchecked insert (v3: organizers may not be MANAGERS)
  eventsSvc.insertEvent = () => { throw new Error("boom"); };
  try {
    assert.throws(() => meetingsSvc.detachSharedEvent(M.tl, meeting.session), /boom/);
  } finally { eventsSvc.insertEvent = realCreate; }
  assert.equal(db.prepare("SELECT COUNT(*) c FROM event_exceptions WHERE event_id = ?").get(ev.id).c, 0);
  assert.equal(db.prepare("SELECT event_id FROM attendance_sessions WHERE id = ?").get(meeting.session.id).event_id, ev.id);
});
