// Shared meeting helpers (design-phase2.md §4, design-sedinte-v3.md): rows, parsing, permission targets
// and the full meeting view. Used by meetings.js (facade), meeting-schedule.js and meeting-minutes.js.
const path = require("path");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");
const rules = require("../domain/rules");
const { bucharestToUtcMs } = require("../domain/time"); // DST-aware local -> UTC
const attendanceSvc = require("./attendance");
const googleMeetSvc = require("./google-meet");
const audience = require("./meeting-audience");

const MEETING_SESSION_TYPES = ["sedinta", "urgenta"];
const AUDIO_DIR = process.env.MEETINGS_AUDIO_DIR || path.join(__dirname, "..", "..", "data", "meetings");

function stripDiacritics(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function requireSession(sessionId) {
  const s = db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(sessionId);
  if (!s) throw new DomainError("NOT_FOUND", "Sesiune negăsită.");
  return s;
}

function requireMeetingRow(id) {
  const m = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id);
  if (!m) throw new DomainError("NOT_FOUND", "Ședință/PV negăsit.");
  return m;
}

// Where a meeting is in time (Europe/Bucharest wall clock): "programata" before the start, "in_desfasurare"
// from the start until start + duration, "incheiata" afterwards. PV badges only make sense once it started.
const DEFAULT_DURATION_MIN = 120; // same default as scheduling (meeting-schedule.js)
function meetingPhase(date, startTime, durationMin, nowMs = Date.now()) {
  if (!date) return "incheiata";
  const start = bucharestToUtcMs(date, (startTime || "00:00").slice(0, 5));
  const end = start + (durationMin || DEFAULT_DURATION_MIN) * 60000;
  return nowMs < start ? "programata" : nowMs < end ? "in_desfasurare" : "incheiata";
}

function parseMeeting(row) {
  if (!row) return null;
  const session = requireSession(row.session_id);
  const ev = session.event_id ? db.prepare("SELECT location, start_time, end_time FROM events WHERE id = ?").get(session.event_id) : null;
  const durationMin = ev && ev.end_time ? Math.round((new Date(ev.end_time) - new Date(ev.start_time)) / 60000) : null;
  return {
    ...row,
    audience: audience.describe(audience.ofSession(session, row.created_by)),
    location: ev ? ev.location : null,
    duration_min: durationMin,
    phase: meetingPhase(session.date, session.start_time, durationMin),
    mode: row.meet_link ? "online" : "fizic",
    agenda: row.agenda ? JSON.parse(row.agenda) : [],
    transcript_segments: row.transcript_segments ? JSON.parse(row.transcript_segments) : null,
    draft: row.draft ? JSON.parse(row.draft) : null,
    session,
    retention: rules.minutesRetentionUntil(session.date),
  };
}

function assertNotApproved(meetingRow) {
  if (meetingRow.status === "approved") throw new DomainError("INVALID", "PV aprobat este imuabil (Art. 49.2).");
}

// Policy target of a stored meeting: its audience + its creator (design-sedinte-v3.md §1).
function targetOf(meetingRow, session) {
  return audience.ofSession(session || requireSession(meetingRow.session_id), meetingRow.created_by);
}

function assertOrganize(actor, meetingRow) {
  assertCan(actor, "meetings.organize", targetOf(meetingRow), "Doar organizatorii acestei ședințe pot face asta.");
}

// View permission: approved PVs are visible to active/alumni members (Art. 49.3); drafts only to
// OVERSIGHT (managers + mentors).
function assertCanView(actor, meetingRow) {
  if (meetingRow.status === "approved") {
    assertCan(actor, "meetings.view_final");
  } else {
    assertCan(actor, "meetings.view_drafts");
  }
}

// Today in Europe/Bucharest as YYYY-MM-DD (session dates are stored as local calendar dates).
function todayBucharest() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
}

// Active members see date/place/agenda of UPCOMING meetings (design-sedinte-v2.md §4) - never the
// draft, transcript or audio state of an unapproved meeting.
function upcomingView(meeting) {
  const { id, session_id, status, agenda, meet_link, location, duration_min, mode, phase, session, retention, audience: aud } = meeting;
  return { id, session_id, status, agenda, meet_link, location, duration_min, mode, phase, session, retention, audience: aud, upcoming: true };
}

// Full page: oversight + the meeting's organizers (group leaders for their group, design-sedinte-v3.md §3).
// Others: an approved PV (Art. 49.3), or the details of an upcoming meeting they are invited to.
function get(actor, id) {
  const row = requireMeetingRow(id);
  const session = requireSession(row.session_id);
  const target = targetOf(row, session);
  if (can(actor, "meetings.view", target)) {
    return {
      ...parseMeeting(row),
      can_organize: can(actor, "meetings.organize", target),
      can_manage: can(actor, "meetings.manage"),
      can_approve: row.status !== "approved" && can(actor, "meetings.approve", target),
    };
  }
  if (row.status !== "approved") {
    if (session.date >= todayBucharest() && can(actor, "meetings.view_upcoming") && attendanceSvc.isInvited(session, actor.id)) {
      return upcomingView(parseMeeting(row));
    }
  }
  assertCanView(actor, row);
  return parseMeeting(row);
}

function normalizeMeetLink(link) {
  const l = String(link || "").trim();
  if (!l) throw new DomainError("INVALID", "Link lipsă.");
  if (!/^https:\/\/\S+$/i.test(l)) throw new DomainError("INVALID", "Linkul trebuie să înceapă cu https://");
  return l;
}

// Session local date + HH:MM (Europe/Bucharest) + real duration -> ISO UTC instants for Google (design-pachet-b.md B3).
function googleTimes(session, durationMin) {
  const startMs = bucharestToUtcMs(session.date, (session.start_time || "00:00").slice(0, 5));
  return { startTime: new Date(startMs).toISOString(), endTime: new Date(startMs + (durationMin || 120) * 60000).toISOString() };
}

// The Google event behind a stored automatic link is no longer needed (link replaced, meeting cancelled or
// moved to a room). Best-effort: google-meet never throws.
function dropGoogleEvent(row) {
  if (row.meet_source !== "auto" || !row.meet_event_id) return Promise.resolve(false);
  return googleMeetSvc.deleteMeetingEvent(row.meet_event_id);
}

module.exports = {
  MEETING_SESSION_TYPES, AUDIO_DIR, meetingPhase, stripDiacritics, requireSession, requireMeetingRow, parseMeeting, assertNotApproved,
  targetOf, assertOrganize, assertCanView, todayBucharest, get, normalizeMeetLink, googleTimes, dropGoogleEvent,
};
