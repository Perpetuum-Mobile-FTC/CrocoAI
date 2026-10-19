// Meetings + minutes (procese verbale), design-phase2.md §4. A "meeting" is 1:1 with an existing
// attendance_sessions row of type 'sedinta'/'urgenta': agenda, Meet link, audio, transcript and
// the PV draft/approval all live here. Attendance for the PV is ALWAYS read from
// attendance_records (never from the transcript, Art. 19/51).
// Facade: meeting-core.js (rows, view), meeting-schedule.js (programare), meeting-minutes.js (PV),
// meeting-recordings.js, meeting-attendance.js, meeting-audience.js. Callers only require this file.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");
const { bucharestToUtcMs } = require("../domain/time");

const attendanceSvc = require("./attendance");
const googleMeetSvc = require("./google-meet");
const transcriptionSvc = require("./transcription");
const recordings = require("./meeting-recordings");
const audience = require("./meeting-audience");
const meetingAttendance = require("./meeting-attendance");
const core = require("./meeting-core");
const minutes = require("./meeting-minutes");
const scheduling = require("./meeting-schedule");

const {
  MEETING_SESSION_TYPES, AUDIO_DIR, requireSession, requireMeetingRow, parseMeeting, assertNotApproved, assertOrganize,
  assertCanView, todayBucharest, get, normalizeMeetLink, googleTimes, dropGoogleEvent,
} = core;
const MAX_AUDIO_SIZE = 300 * 1024 * 1024; // 300 MB
const ALLOWED_AUDIO_EXT = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".webm": "audio/webm", ".ogg": "audio/ogg" };

function getOrCreateForSession(actor, sessionId) {
  assertCan(actor, "meetings.manage");
  const session = requireSession(sessionId);
  if (!MEETING_SESSION_TYPES.includes(session.type)) {
    throw new DomainError("INVALID", "Doar ședințele (sedinta/urgenta) au proces verbal.");
  }
  let row = db.prepare("SELECT * FROM meetings WHERE session_id = ?").get(sessionId);
  if (!row) {
    const info = db.prepare(`
      INSERT INTO meetings (session_id, created_by) VALUES (?, ?)
    `).run(sessionId, actor.id);
    row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(info.lastInsertRowid);
  }
  return parseMeeting(row);
}

// Acasă card „Ședințele tale viitoare”: meetings from today on that the actor is invited to.
function upcomingMine(actor) {
  assertCan(actor, "meetings.view_upcoming");
  const rows = db.prepare(`
    SELECT m.* FROM meetings m JOIN attendance_sessions s ON s.id = m.session_id
    WHERE s.type IN ('sedinta','urgenta') AND s.date >= ? AND m.status != 'approved'
    ORDER BY s.date, s.start_time
  `).all(todayBucharest());
  return rows.map(parseMeeting)
    .filter((mt) => attendanceSvc.isInvited(mt.session, actor.id))
    .map((mt) => ({
      id: mt.id, title: mt.session.title || "Ședință", type: mt.session.type, date: mt.session.date, time: (mt.session.start_time || "").slice(0, 5),
      duration_min: mt.duration_min, mode: mt.mode, location: mt.location, meet_link: mt.meet_link, agenda: mt.agenda, audience: mt.audience,
    }));
}

// List sessions of meeting-eligible types in a range, each with its meeting status (if any).
// Non-OVERSIGHT callers only see sessions that already have an APPROVED PV (Art. 49.3).
function list(actor, { from, to } = {}) {
  const oversight = can(actor, "meetings.view_drafts"); // OVERSIGHT: drafts too
  if (!oversight) assertCan(actor, "meetings.view_final");
  let sql = `
    SELECT s.id AS session_id, s.date, s.start_time, s.title, s.type, s.team_id, s.target_dept,
           m.id AS meeting_id, m.status AS meeting_status, m.agenda, m.meet_link, m.audio_status, m.approved_at, m.created_by,
           e.location, e.start_time AS ev_start, e.end_time AS ev_end
    FROM attendance_sessions s
    LEFT JOIN meetings m ON m.session_id = s.id
    LEFT JOIN events e ON e.id = s.event_id
    WHERE s.type IN ('sedinta','urgenta')
  `;
  const params = [];
  if (from) { sql += " AND s.date >= ?"; params.push(from); }
  if (to) { sql += " AND s.date <= ?"; params.push(to); }
  sql += " ORDER BY s.date DESC, s.start_time DESC";
  let rows = db.prepare(sql).all(...params);
  if (!oversight) {
    const today = todayBucharest();
    const upcoming = can(actor, "meetings.view_upcoming");
    rows = rows.filter((r) => {
      if (r.meeting_status === "approved") return true;
      if (r.meeting_id && can(actor, "meetings.view", audience.ofSession({ id: r.session_id, team_id: r.team_id, target_dept: r.target_dept }, r.created_by))) {
        r.organizer_view = true;
        return true;
      }
      return upcoming && r.meeting_id && r.date >= today && attendanceSvc.isInvited({ id: r.session_id, team_id: r.team_id, target_dept: r.target_dept }, actor.id);
    });
    rows = rows.map((r) => (r.meeting_status === "approved" || r.organizer_view ? r : { ...r, audio_status: undefined }));
  }
  const now = Date.now();
  return rows.map(({ created_by, organizer_view, ev_start, ev_end, ...r }) => ({
    ...r, agenda: r.agenda ? JSON.parse(r.agenda) : [],
    phase: core.meetingPhase(r.date, r.start_time, ev_end ? Math.round((new Date(ev_end) - new Date(ev_start)) / 60000) : null, now),
    audience_label: r.team_id || r.target_dept ? audience.ofSession(r, null).label : "Toată echipa",
  }));
}

function updateAgenda(actor, id, agenda) {
  const row = requireMeetingRow(id);
  assertOrganize(actor, row);
  assertNotApproved(row);
  if (!Array.isArray(agenda) || agenda.some((a) => typeof a !== "string")) {
    throw new DomainError("INVALID", "Agenda trebuie să fie o listă de puncte text.");
  }
  db.prepare("UPDATE meetings SET agenda=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(JSON.stringify(agenda), id);
  return get(actor, id);
}

function setMeetLinkManual(actor, id, link) {
  const row = requireMeetingRow(id);
  assertCan(actor, "meetings.manage");
  assertNotApproved(row);
  link = normalizeMeetLink(link);
  db.prepare("UPDATE meetings SET meet_link=?, meet_source='manual', meet_event_id=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(link.trim(), id);
  dropGoogleEvent(row); // the replaced automatic link's Google event (best-effort, in the background)
  return get(actor, id);
}

// Tries to create a Google Calendar event with a Meet link. Never throws for "not configured" -
// returns { configured:false } so the UI falls back to the manual field (design-phase2.md §4).
async function createMeetLinkAuto(actor, id) {
  const row = requireMeetingRow(id);
  assertCan(actor, "meetings.manage");
  assertNotApproved(row);
  if (!googleMeetSvc.isConfigured()) return { configured: false, meet_link: null };
  const meeting = parseMeeting(row);
  const result = await googleMeetSvc.createMeetingEvent({ title: meeting.session.title || "Ședință echipă", ...googleTimes(meeting.session, meeting.duration_min) });
  if (!result) return { configured: true, meet_link: null, failed: true };
  db.prepare("UPDATE meetings SET meet_link=?, meet_source='auto', meet_event_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(result.link, result.eventId, id);
  await dropGoogleEvent(row); // a previous automatic link's event
  return { configured: true, meet_link: result.link };
}

function assertAudioFile(file) {
  if (!file || !file.buffer) throw new DomainError("INVALID", "Fișier audio lipsă.");
  if (file.size > MAX_AUDIO_SIZE) throw new DomainError("INVALID", "Fișierul audio depășește 300 MB.");
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (!(ext in ALLOWED_AUDIO_EXT)) {
    throw new DomainError("INVALID", "Tip de fișier audio neacceptat (mp3/m4a/wav/webm/ogg).");
  }
  return ext;
}

// Saves the uploaded audio and kicks off transcription in the background (never blocks the
// response). `transcribeFn` is injectable for tests.
function uploadAudio(actor, id, file, transcribeFn = transcriptionSvc.transcribeInBackground) {
  const row = requireMeetingRow(id);
  assertCan(actor, "meetings.manage");
  assertNotApproved(row);
  const ext = assertAudioFile(file);
  const dir = path.join(AUDIO_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${crypto.randomUUID()}${ext}`;
  const absPath = path.join(dir, fileName);
  fs.writeFileSync(absPath, file.buffer);
  const relPath = path.relative(AUDIO_DIR, absPath);
  db.prepare(`
    UPDATE meetings SET audio_path=?, audio_status='processing', audio_error=NULL, transcript=NULL, transcript_segments=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(relPath, id);
  transcribeFn(id, absPath);
  return get(actor, id);
}

function audioStatus(actor, id) {
  const row = requireMeetingRow(id);
  assertCanView(actor, row);
  return { audio_status: row.audio_status, audio_error: row.audio_error, has_transcript: !!row.transcript };
}

module.exports = {
  MEETING_SESSION_TYPES,
  getOrCreateForSession, get, list, upcomingMine,
  schedule: scheduling.schedule, reschedule: scheduling.reschedule, cancel: scheduling.cancel,
  allowedTargets: audience.allowedTargets, sectionAccess: audience.sectionAccess,
  ...recordings,
  ...meetingAttendance,
  updateAgenda, setMeetLinkManual, createMeetLinkAuto,
  uploadAudio, audioStatus,
  generateDraft: minutes.generateDraft, generateDraftText: minutes.generateDraftText, updateDraft: minutes.updateDraft, approve: minutes.approve,
  exportHtml: minutes.exportHtml, lastApproved: minutes.lastApproved, decisionsFor: minutes.decisionsFor, search: minutes.search,
  requireMeetingRow, parseMeeting, assertNotApproved, detachSharedEvent: scheduling.detachSharedEvent, bucharestToUtcMs,
};
