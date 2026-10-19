// Events + weekly recurrence (generates attendance sessions of the event's type). Design v2 §4, §6.
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");
const time = require("../domain/time");
const rules = require("../domain/rules");

const VALID_TYPES = ["sedinta", "urgenta", "competitie", "antrenament", "eveniment"];

function assertCanManage(actor, type) {
  if (type === "urgenta") {
    assertCan(actor, "events.manage_urgenta", null, "Doar Team Leader-ul, Co-Leader-ul sau mentorii activi pot crea ședințe de urgență (Art. 51.1).");
    return;
  }
  assertCan(actor, "events.manage");
}

// Generates attendance_sessions OF THE EVENT'S TYPE for a weekly-recurring event (a weekly „antrenament” is an
// informative training session, not a counted meeting - rules.COUNTING_SESSION_TYPES), up to `until`, in
// Europe/Bucharest wall-clock time: every occurrence keeps the first one's local weekday and HH:MM
// across DST; session.date / start_time are local. `recurrence_until` as a bare date = through that local day.
// `skip`: extra local dates not to (re)create (occurrences still covered by a past / kept session).
function generateRecurrenceSessions(event, skip = new Set()) {
  if (event.recurrence !== "weekly" || !event.recurrence_until) return;
  const first = time.utcToBucharest(new Date(event.start_time).getTime());
  const untilRaw = String(event.recurrence_until);
  const untilDate = /^\d{4}-\d{2}-\d{2}$/.test(untilRaw) ? untilRaw : null;
  const untilMs = untilDate ? null : new Date(untilRaw).getTime();
  if (isNaN(new Date(event.start_time).getTime()) || (!untilDate && isNaN(untilMs))) return;
  const skipped = new Set([...skip, ...db.prepare("SELECT date FROM event_exceptions WHERE event_id = ?").all(event.id).map((r) => r.date)]);
  const type = VALID_TYPES.includes(event.type) ? event.type : "eveniment";
  const insert = db.prepare(`
    INSERT OR IGNORE INTO attendance_sessions (date, start_time, type, title, event_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const has = db.prepare("SELECT 1 FROM attendance_sessions WHERE event_id = ? AND date = ?"); // one session per date of a series
  for (let i = 0, date = first.date; i < 520; i++, date = time.addDays(date, 7)) { // ≤ 10 years
    if (untilDate ? date > untilDate : time.bucharestToUtcMs(date, first.time) > untilMs) break;
    if (skipped.has(date) || has.get(event.id, date)) continue;
    insert.run(date, first.time, type, event.title, event.id, event.created_by);
  }
}

// The series changed type: its sessions follow (those with a meeting/PV keep theirs - a PV needs a meeting type;
// a slot already taken by an identical session of the new type is left as it is).
// Only sessions from today on: past ones were held as what they were (attendance percentage stays as it was).
function retypeSeriesSessions(eventId, type, now = Date.now()) {
  db.prepare(`
    UPDATE attendance_sessions SET type = @type
    WHERE event_id = @eventId AND type <> @type AND date >= @today AND id NOT IN (SELECT session_id FROM meetings)
      AND NOT EXISTS (SELECT 1 FROM attendance_sessions o WHERE o.id <> attendance_sessions.id AND o.date = attendance_sessions.date
        AND IFNULL(o.start_time,'') = IFNULL(attendance_sessions.start_time,'') AND o.type = @type
        AND IFNULL(o.team_id,0) = IFNULL(attendance_sessions.team_id,0) AND IFNULL(o.target_dept,'') = IFNULL(attendance_sessions.target_dept,''))
  `).run({ eventId, type, today: time.utcToBucharest(now).date });
}

function create(actor, data) {
  const { title, start_time, type } = data || {};
  if (!title || !start_time) throw new DomainError("INVALID", "Titlu și dată obligatorii.");
  assertCanManage(actor, VALID_TYPES.includes(type) ? type : "eveniment");
  return insertEvent(actor.id, data);
}

// Unchecked insert/update/delete: for services that authorize themselves (meetings.schedule uses the
// audience rule of policy.js, design-sedinte-v3.md §1).
function insertEvent(createdBy, data) {
  const { title, location, start_time, end_time, type, recurrence, recurrence_until, competition_level } = data || {};
  if (!title || !start_time) throw new DomainError("INVALID", "Titlu și dată obligatorii.");
  const finalType = VALID_TYPES.includes(type) ? type : "eveniment";
  const level = rules.resolveCompetitionLevel(finalType, competition_level); // Art. 22.1 / 22.2
  const info = db.prepare(`
    INSERT INTO events (title, location, start_time, end_time, type, recurrence, recurrence_until, created_by, competition_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title.trim(), location || null, start_time, end_time || null, finalType,
    recurrence === "weekly" ? "weekly" : null, recurrence === "weekly" ? (recurrence_until || null) : null, createdBy, level);
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(info.lastInsertRowid);
  generateRecurrenceSessions(event);
  return event;
}

// `now` (epoch ms) decides which sessions are past when a series moves - injectable for tests.
function update(actor, id, data, now = Date.now()) {
  const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  if (!ev) throw new DomainError("NOT_FOUND", "Eveniment negăsit.");
  assertCanManage(actor, (data && data.type) || ev.type);
  assertNotMeetingEvent(ev);
  const d = data || {};
  const moves = ["start_time", "end_time", "recurrence", "recurrence_until"].some((k) => d[k] !== undefined && d[k] !== ev[k]);
  if (moves) assertNoAutoMeetSessions(ev, now);
  return patchEvent(id, d, now);
}

// A series whose future sessions have meetings with an automatic Google Meet: moving/deleting it from the Calendar
// would leave those Google events at the old time - they are moved one by one from Ședințe.
function assertNoAutoMeetSessions(ev, now = Date.now()) {
  if (!ev.recurrence) return;
  const hit = db.prepare(`SELECT 1 FROM attendance_sessions s JOIN meetings m ON m.session_id = s.id
    WHERE s.event_id = ? AND s.date >= ? AND m.meet_source = 'auto' AND m.meet_event_id IS NOT NULL LIMIT 1`)
    .get(ev.id, time.utcToBucharest(now).date);
  if (hit) throw new DomainError("INVALID", "Seria are ședințe cu Meet automat — mută-le din Ședințe.");
}

// The meeting (if any) that owns a one-off event: its time, place and cancellation belong to Ședințe
// (meetings.organize, design-pachet-b.md B3) - never to the generic Calendar edit.
function meetingIdOf(ev) {
  if (!ev || ev.recurrence) return null;
  const row = db.prepare(`SELECT m.id FROM meetings m JOIN attendance_sessions s ON s.id = m.session_id
    WHERE s.event_id = ? LIMIT 1`).get(ev.id);
  return row ? row.id : null;
}

function assertNotMeetingEvent(ev) {
  if (meetingIdOf(ev)) throw new DomainError("INVALID", "Evenimentul aparține unei ședințe - modifică-l sau anulează-l din Ședințe.");
}

// A session "has data" when moving it would rewrite history: attendance records, or a meeting with
// audio / a recording / a PV draft or approval (a meeting with only an agenda can move).
const hasDataStmt = () => db.prepare(`
  SELECT 1 FROM attendance_records WHERE session_id = @id
  UNION SELECT 1 FROM meetings m WHERE m.session_id = @id AND (m.audio_path IS NOT NULL OR m.audio_status != 'none'
    OR m.draft IS NOT NULL OR m.status = 'approved'
    OR EXISTS (SELECT 1 FROM meeting_recordings r WHERE r.meeting_id = m.id AND r.status != 'abandoned'))
`);

// The series' start moved (time and/or weekday): future sessions without data move IN PLACE to the
// new local date/time (reminder flags reset) instead of leaving stale-time copies next to new ones.
// Past sessions and sessions with data stay (the latter are returned as `stale`). Returns the local
// dates the generator must not recreate (covered by a session that did not move) + `stale`.
function moveSeriesSessions(oldEv, newEv, now) {
  const oldFirst = time.utcToBucharest(new Date(oldEv.start_time).getTime());
  const newFirst = time.utcToBucharest(new Date(newEv.start_time).getTime());
  const dayShift = Math.round((Date.parse(`${newFirst.date}T00:00:00Z`) - Date.parse(`${oldFirst.date}T00:00:00Z`)) / 86400000);
  const today = time.utcToBucharest(now).date;
  const hasData = hasDataStmt();
  const skip = new Set();
  const stale = [];
  const movable = [];
  for (const s of db.prepare("SELECT * FROM attendance_sessions WHERE event_id = ? ORDER BY date").all(oldEv.id)) {
    skip.add(time.addDays(s.date, dayShift));
    if (s.date < today) continue;
    if (hasData.get({ id: s.id })) { stale.push({ id: s.id, date: s.date, start_time: s.start_time }); continue; }
    movable.push(s);
  }
  // Two phases, so a shift by whole weeks never collides a moved row with a not-yet-moved sibling:
  // 1) park every movable row on a unique temporary start_time, 2) place each one at its target.
  const park = db.prepare("UPDATE attendance_sessions SET start_time = ? WHERE id = ?");
  for (const s of movable) park.run(`~tmp-${s.id}`, s.id);
  const movedIds = new Set(movable.map((s) => s.id));
  const occupant = db.prepare(`SELECT id FROM attendance_sessions WHERE date = ? AND IFNULL(start_time,'') = ? AND type = ?
    AND IFNULL(team_id,0) = IFNULL(?,0) AND IFNULL(target_dept,'') = IFNULL(?,'') AND id != ?`);
  const place = db.prepare("UPDATE attendance_sessions SET date = ?, start_time = ?, reminded_24h = 0, reminded_1h = 0 WHERE id = ?");
  for (const s of movable) {
    const target = time.addDays(s.date, dayShift);
    const other = occupant.get(target, newFirst.time, s.type, s.team_id, s.target_dept, s.id);
    if (!other) { place.run(target, newFirst.time, s.id); continue; }
    if (movedIds.has(other.id)) {
      // two rows of this series on the same date (one hand-edited): keep this one where it was, report it
      if (occupant.get(s.date, s.start_time, s.type, s.team_id, s.target_dept, s.id)) {
        db.prepare("DELETE FROM attendance_sessions WHERE id = ?").run(s.id); // its old slot is taken too: empty duplicate
        console.warn(`[EVENTS] series ${oldEv.id}: session ${s.id} (${s.date} ${s.start_time}) dropped as a duplicate (target ${target} and old slot both taken)`);
        continue;
      }
      park.run(s.start_time, s.id);
      stale.push({ id: s.id, date: s.date, start_time: s.start_time });
      console.warn(`[EVENTS] series ${oldEv.id}: session ${s.id} (${s.date} ${s.start_time}) would collide with moved session ${other.id} at ${target} ${newFirst.time} - kept at the old time`);
    } else {
      // a genuinely pre-existing identical session already holds the slot: this empty row is its duplicate
      db.prepare("DELETE FROM attendance_sessions WHERE id = ?").run(s.id);
      console.warn(`[EVENTS] series ${oldEv.id}: session ${s.id} (${s.date} ${s.start_time}) dropped as a duplicate of existing session ${other.id} at ${target} ${newFirst.time}`);
    }
  }
  for (const x of db.prepare("SELECT date FROM event_exceptions WHERE event_id = ?").all(oldEv.id)) skip.add(time.addDays(x.date, dayShift));
  if (stale.length) console.warn(`[EVENTS] series ${oldEv.id} moved; sessions with data kept at the old time: ${stale.map((x) => x.id).join(", ")}`);
  return { skip, stale };
}

function patchEvent(id, data, now = Date.now()) {
  return db.transaction(() => patchEventTx(id, data, now))();
}

function patchEventTx(id, data, now) {
  const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  if (!ev) throw new DomainError("NOT_FOUND", "Eveniment negăsit.");
  const { title, location, start_time, end_time, type, recurrence, recurrence_until, competition_level } = data || {};
  const finalType = (type && VALID_TYPES.includes(type)) ? type : ev.type;
  const level = rules.resolveCompetitionLevel(finalType, competition_level, ev.competition_level);
  db.prepare(`
    UPDATE events SET title=COALESCE(?,title), location=?, start_time=COALESCE(?,start_time), end_time=?,
      type=COALESCE(?,type), recurrence=?, recurrence_until=?, competition_level=?
    WHERE id=?
  `).run(
    title || null,
    location !== undefined ? location : ev.location,
    start_time || null,
    end_time !== undefined ? end_time : ev.end_time,
    (type && VALID_TYPES.includes(type)) ? type : null,
    recurrence === "weekly" ? "weekly" : (recurrence === undefined ? ev.recurrence : null),
    recurrence === "weekly" ? (recurrence_until || ev.recurrence_until) : (recurrence === undefined ? ev.recurrence_until : null),
    level,
    id
  );
  const updated = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  // The start moved: the 24h/1h reminders must fire again for the new time (one-off events keep the flags on the event).
  if (ev.start_time !== updated.start_time) db.prepare("UPDATE events SET reminded_24h = 0, reminded_1h = 0 WHERE id = ?").run(id);
  let moved = { skip: new Set(), stale: [] };
  if (updated.recurrence && ev.type !== updated.type) retypeSeriesSessions(id, updated.type);
  if (ev.recurrence && updated.recurrence && ev.start_time !== updated.start_time) moved = moveSeriesSessions(ev, updated, now);
  generateRecurrenceSessions(updated, moved.skip);
  return updated.recurrence ? { ...updated, stale_sessions: moved.stale } : updated;
}

function remove(actor, id) {
  const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  if (!ev) throw new DomainError("NOT_FOUND", "Eveniment negăsit.");
  assertCanManage(actor, ev.type);
  assertNotMeetingEvent(ev);
  assertNoAutoMeetSessions(ev);
  deleteEvent(id);
}

function deleteEvent(id) {
  db.prepare("DELETE FROM events WHERE id = ?").run(id);
}

// One item per occurrence (design-pachet-b.md B3): a weekly series is expanded from its sessions (local date +
// HH:MM, DST-aware; cancelled/detached dates have no session), each item keeping the series `id` plus
// `occurrence_date` and `series_start_time`. A series without sessions (no end date) shows once, as before.
// `meeting_id`: the meeting that owns a one-off event (edit/cancel only from Ședințe). Same list for the
// Calendar, Acasă and the bot (evenimente_urmatoare). `from`/`to` compare like the stored ISO instants.
function list(actor, { from, to } = {}) {
  const inRange = (iso) => (!from || iso >= from) && (!to || iso <= to);
  const out = [];
  const sessionsOf = db.prepare("SELECT * FROM attendance_sessions WHERE event_id = ? ORDER BY date, start_time");
  const meetingOfSession = db.prepare("SELECT id FROM meetings WHERE session_id = ?");
  for (const ev of db.prepare("SELECT * FROM events ORDER BY start_time").all()) {
    if (!ev.recurrence) {
      if (inRange(ev.start_time)) out.push({ ...ev, meeting_id: meetingIdOf(ev) });
      continue;
    }
    const sessions = sessionsOf.all(ev.id);
    if (!sessions.length) {
      if (inRange(ev.start_time)) out.push({ ...ev, meeting_id: null });
      continue;
    }
    const durationMs = ev.end_time ? new Date(ev.end_time).getTime() - new Date(ev.start_time).getTime() : null;
    for (const s of sessions) {
      const hhmm = (s.start_time || "").slice(0, 5);
      if (!/^\d{2}:\d{2}$/.test(hhmm)) continue;
      const startMs = time.bucharestToUtcMs(s.date, hhmm);
      const start = new Date(startMs).toISOString();
      if (!inRange(start)) continue;
      const m = meetingOfSession.get(s.id);
      out.push({
        ...ev, start_time: start, end_time: durationMs != null ? new Date(startMs + durationMs).toISOString() : null,
        series_start_time: ev.start_time, occurrence_date: s.date, session_id: s.id, meeting_id: m ? m.id : null,
      });
    }
  }
  return out.sort((a, b) => a.start_time.localeCompare(b.start_time));
}

module.exports = { VALID_TYPES, create, update, remove, list, meetingIdOf, generateRecurrenceSessions, insertEvent, patchEvent, deleteEvent };
