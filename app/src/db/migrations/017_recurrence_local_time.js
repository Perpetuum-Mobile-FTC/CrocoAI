// Weekly series used to be generated in UTC (fixed 7-day steps, session.date/start_time = UTC), so an
// 18:00 Europe/Bucharest meeting showed "15:00" and drifted 1 h after DST. Sessions are now generated in
// local wall-clock time (services/events.js). This rewrites the rows the old generator produced:
//   - sessions of a recurring event whose start_time is still the generator's UTC HH:MM -> date = local
//     date of that occurrence, start_time = the series' local HH:MM (hand-edited times are left alone);
//     (if that collides with an existing local-time row: an empty duplicate is deleted, one with records
//     or a meeting is left and logged);
//   - event_exceptions of recurring events -> local dates;
//   - per-session reminder flags (recurring occurrences are reminded one by one); the first occurrence
//     inherits the event's flags so nothing is re-sent.
// Only domain/time (pure, no db) is required - never services (CLAUDE.md: circular require with src/db).
const { utcToBucharest } = require("../../domain/time");

function up(db) {
  db.exec("ALTER TABLE attendance_sessions ADD COLUMN reminded_24h INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE attendance_sessions ADD COLUMN reminded_1h INTEGER NOT NULL DEFAULT 0");

  const sessionsOf = db.prepare("SELECT id, date, start_time FROM attendance_sessions WHERE event_id = ?");
  const updateSession = db.prepare("UPDATE attendance_sessions SET date = ?, start_time = ? WHERE id = ?");
  const setFlags = db.prepare("UPDATE attendance_sessions SET reminded_24h = ?, reminded_1h = ? WHERE id = ?");
  const hasData = db.prepare("SELECT 1 FROM attendance_records WHERE session_id = ? UNION SELECT 1 FROM meetings WHERE session_id = ?");
  const deleteSession = db.prepare("DELETE FROM attendance_sessions WHERE id = ?");
  const exceptionsOf = db.prepare("SELECT date FROM event_exceptions WHERE event_id = ?");
  const updateException = db.prepare("UPDATE OR IGNORE event_exceptions SET date = ? WHERE event_id = ? AND date = ?");

  for (const ev of db.prepare("SELECT * FROM events WHERE recurrence IS NOT NULL").all()) {
    const evMs = Date.parse(ev.start_time);
    if (isNaN(evMs)) continue;
    const utcTime = new Date(evMs).toISOString().slice(11, 16); // what the old generator stored
    const series = utcToBucharest(evMs); // the series' local first date + HH:MM
    const localDateOf = (utcDate) => utcToBucharest(Date.parse(`${utcDate}T${utcTime}:00Z`)).date;

    for (const s of sessionsOf.all(ev.id)) {
      if (s.start_time !== utcTime) continue;
      const date = localDateOf(s.date);
      try {
        updateSession.run(date, series.time, s.id);
      } catch (err) {
        if (!/UNIQUE/.test(err.message)) throw err;
        // A local-time row for this occurrence already exists: this one is its UTC-time duplicate.
        if (hasData.get(s.id, s.id)) console.warn(`[DB] 017: session ${s.id} (${s.date} ${s.start_time}) has records/meeting, a local-time duplicate exists - left as is`);
        else deleteSession.run(s.id);
        continue;
      }
      if (date === series.date) setFlags.run(ev.reminded_24h || 0, ev.reminded_1h || 0, s.id);
    }
    for (const x of exceptionsOf.all(ev.id)) {
      const date = localDateOf(x.date);
      if (date !== x.date) updateException.run(date, ev.id, x.date);
    }
  }
}

module.exports = { up };
