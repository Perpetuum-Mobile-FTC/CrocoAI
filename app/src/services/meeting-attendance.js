// Prezență cu cod QR (docs/design-sedinte-v3.md §2). The QR holds https://<app>/p/<token>, token =
// "<meetingId>.<16 chars base64url of HMAC-SHA256(secret, `${meetingId}:${floor(now/30s)}`)>": it rotates
// every 30 s, the previous window is still accepted (scans at the boundary), and it only works while
// the meeting runs (15 min before the start -> the end) and attendance is not closed.
// Also: the meeting-page roster (invited + extras), manual P/A/M, close (-> A / M) and reopen.
const crypto = require("crypto");
const QRCode = require("qrcode");

const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan } = require("../domain/policy");
const attendanceSvc = require("./attendance");
const audience = require("./meeting-audience");
const { bucharestToUtcMs } = require("../domain/time");

const WINDOW_MS = 30 * 1000;
const OPEN_BEFORE_MS = 15 * 60 * 1000;
const DEFAULT_DURATION_MS = 120 * 60 * 1000;
const MARK_STATUSES = ["prezent", "absent", "motivat"];
const BAD_TOKEN = "Cod QR invalid sau expirat — scanează codul afișat acum pe ecran.";

const secret = () => process.env.ATTENDANCE_QR_SECRET || process.env.JWT_SECRET || "dev-secret-change-me";
const { baseUrl } = require("../domain/team");
const nowIso = (now) => new Date(now).toISOString();

function signature(meetingId, win) {
  return crypto.createHmac("sha256", secret()).update(`${meetingId}:${win}`).digest("base64url").slice(0, 16);
}

function qrToken(meetingId, now = Date.now()) {
  return `${meetingId}.${signature(meetingId, Math.floor(now / WINDOW_MS))}`;
}

function load(meetingId) {
  const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(meetingId);
  if (!row) throw new DomainError("NOT_FOUND", "Ședință negăsită.");
  const session = db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(row.session_id);
  if (!session) throw new DomainError("NOT_FOUND", "Sesiune negăsită.");
  return { row, session, target: audience.ofSession(session, row.created_by) };
}

function assertOrganize(actor, m) {
  assertCan(actor, "meetings.organize", m.target, "Doar organizatorii acestei ședințe pot gestiona prezența.");
}

function assertNotApproved(m) {
  if (m.row.status === "approved") throw new DomainError("INVALID", "PV aprobat este imuabil (Art. 49.2).");
}

// [open, end] in epoch ms: from 15 min before the start to start + duration. The start is the session's
// own local date + HH:MM (Europe/Bucharest, DST-aware) - right for every occurrence of a weekly series;
// the duration comes from the event (else 2 h). Without a start time: the event's start (else 00:00).
function windowOf(session) {
  const ev = session.event_id ? db.prepare("SELECT start_time, end_time FROM events WHERE id = ?").get(session.event_id) : null;
  const evStart = ev ? new Date(ev.start_time).getTime() : null;
  const duration = ev && ev.end_time ? new Date(ev.end_time).getTime() - evStart : DEFAULT_DURATION_MS;
  const hhmm = (session.start_time || "").slice(0, 5);
  const start = /^\d{2}:\d{2}$/.test(hhmm) ? bucharestToUtcMs(session.date, hhmm) : (ev ? evStart : bucharestToUtcMs(session.date, "00:00"));
  return { open: start - OPEN_BEFORE_MS, start, end: start + duration };
}

// Throws unless the QR may be used at `now` (not closed, not approved, inside the window).
function assertQrOpen(m, now) {
  if (m.row.attendance_closed_at) throw new DomainError("INVALID", "Prezența la această ședință s-a închis.");
  assertNotApproved(m);
  const w = windowOf(m.session);
  if (now < w.open) throw new DomainError("INVALID", "Prezența se deschide cu 15 minute înainte de începerea ședinței.");
  if (now > w.end) throw new DomainError("INVALID", "Ședința s-a încheiat — prezența nu mai poate fi marcată cu cod QR.");
  return w;
}

// The organizer is present: whoever runs attendance (opens the QR or closes it) - extra if not invited.
function markOrganizer(m, actor) {
  const has = db.prepare("SELECT 1 FROM attendance_records WHERE session_id = ? AND member_id = ?").get(m.session.id, actor.id);
  if (!has) attendanceSvc.upsertRecords(m.session, [{ member_id: actor.id, status: "prezent" }], actor.id);
}

// Current QR for the big screen: { token, url, svg, seconds_left, expires_at }.
async function attendanceQr(actor, meetingId, now = Date.now()) {
  const m = load(meetingId);
  assertOrganize(actor, m);
  assertQrOpen(m, now);
  markOrganizer(m, actor);
  const token = qrToken(m.row.id, now);
  const url = `${baseUrl()}/p/${token}`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  const next = (Math.floor(now / WINDOW_MS) + 1) * WINDOW_MS;
  return { token, url, svg, seconds_left: Math.ceil((next - now) / 1000), expires_at: nowIso(next), closes_at: nowIso(windowOf(m.session).end) };
}

// Any active account scans: invited -> P, others -> P "extra". Idempotent.
function scan(actor, token, now = Date.now()) {
  assertCan(actor, "meetings.scan", null, "Doar membrii activi își pot marca prezența.");
  const match = /^(\d+)\.([A-Za-z0-9_-]{16})$/.exec(String(token || "").trim());
  if (!match) throw new DomainError("INVALID", BAD_TOKEN);
  const meetingId = Number(match[1]);
  const row = db.prepare("SELECT id FROM meetings WHERE id = ?").get(meetingId);
  if (!row) throw new DomainError("INVALID", BAD_TOKEN);
  const win = Math.floor(now / WINDOW_MS);
  const given = Buffer.from(match[2]);
  const valid = [win, win - 1].some((w) => crypto.timingSafeEqual(given, Buffer.from(signature(meetingId, w))));
  if (!valid) throw new DomainError("INVALID", BAD_TOKEN);

  const m = load(meetingId);
  assertQrOpen(m, now);
  const title = m.session.title || "Ședință";
  const existing = db.prepare("SELECT * FROM attendance_records WHERE session_id = ? AND member_id = ?").get(m.session.id, actor.id);
  if (existing && existing.status === "prezent") {
    return { meeting_id: m.row.id, meeting_title: title, status: "deja marcat", extra: !!existing.extra };
  }
  attendanceSvc.upsertRecords(m.session, [{ member_id: actor.id, status: "prezent", note: "cod QR" }], actor.id);
  return { meeting_id: m.row.id, meeting_title: title, status: "prezent", extra: !attendanceSvc.isInvited(m.session, actor.id) };
}

// Meeting-page roster: invited (with records / approved-absence suggestion) + extras, and the state.
function rosterView(m) {
  const { roster } = attendanceSvc.sessionRoster(m.session);
  const w = windowOf(m.session);
  const invited = roster.filter((r) => !r.extra);
  return {
    session_id: m.session.id,
    closed_at: m.row.attendance_closed_at || null,
    window: { opens_at: nowIso(w.open), ends_at: nowIso(w.end) },
    created_by: m.row.created_by,
    invited,
    extras: roster.filter((r) => r.extra),
    counts: {
      invited: invited.length,
      present: invited.filter((r) => r.record === "prezent").length,
      marked: invited.filter((r) => r.record).length,
      extras: roster.length - invited.length,
    },
  };
}

function attendanceRoster(actor, meetingId) {
  const m = load(meetingId);
  assertCan(actor, "meetings.view", m.target);
  return rosterView(m);
}

// Manual P / A / M from the meeting page (phone-less members). records = [{ member_id, status }]
function markAttendance(actor, meetingId, records) {
  const m = load(meetingId);
  assertOrganize(actor, m);
  assertNotApproved(m);
  if (!Array.isArray(records) || records.some((r) => !MARK_STATUSES.includes(r && r.status))) {
    throw new DomainError("INVALID", "Marcaj invalid (prezent / absent / motivat).");
  }
  for (const r of records) {
    if (!db.prepare("SELECT 1 FROM members WHERE id = ?").get(r.member_id)) throw new DomainError("INVALID", "Membru inexistent.");
    // Someone outside the audience can only be an extra participant (present); A / M only for the invited.
    if (r.status !== "prezent" && !attendanceSvc.isInvited(m.session, r.member_id)) {
      throw new DomainError("INVALID", "Un participant din afara destinatarilor poate fi marcat doar prezent.");
    }
  }
  attendanceSvc.upsertRecords(m.session, records.map((r) => ({ member_id: Number(r.member_id), status: r.status })), actor.id);
  return rosterView(load(meetingId));
}

// „Închide prezența” (only once the meeting has started): the closer P (if unmarked); every unmarked invited member -> M if they have an
// approved absence for that date/session, otherwise A. The QR stops working.
function closeAttendance(actor, meetingId, now = Date.now()) {
  const m = load(meetingId);
  assertOrganize(actor, m);
  assertNotApproved(m);
  if (m.row.attendance_closed_at) throw new DomainError("INVALID", "Prezența e deja închisă.");
  if (now < windowOf(m.session).start) throw new DomainError("INVALID", "Prezența se poate închide doar după începerea ședinței.");
  db.transaction(() => {
    markOrganizer(m, actor);
    const marked = new Set(db.prepare("SELECT member_id FROM attendance_records WHERE session_id = ?").all(m.session.id).map((r) => r.member_id));
    const approved = attendanceSvc.approvedAbsenceIds(m.session);
    const records = attendanceSvc.invitedMemberIds(m.session)
      .filter((id) => !marked.has(id))
      .map((id) => ({ member_id: id, status: approved.has(id) ? "motivat" : "absent" }));
    attendanceSvc.upsertRecords(m.session, records, actor.id);
    db.prepare("UPDATE meetings SET attendance_closed_at = ? WHERE id = ?").run(nowIso(now), m.row.id);
  })();
  return rosterView(load(meetingId));
}

// Reopen (mistakes): marks stay as they are; the QR works again while the meeting window lasts.
function reopenAttendance(actor, meetingId) {
  const m = load(meetingId);
  assertOrganize(actor, m);
  assertNotApproved(m);
  db.prepare("UPDATE meetings SET attendance_closed_at = NULL WHERE id = ?").run(m.row.id);
  return rosterView(load(meetingId));
}

module.exports = { qrToken, attendanceQr, scan, attendanceRoster, markAttendance, closeAttendance, reopenAttendance };
