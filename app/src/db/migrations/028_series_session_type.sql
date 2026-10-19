-- Weekly calendar series used to generate every session as 'sedinta', whatever the event type (UX audit 2026-10-19,
-- item 10): a weekly "antrenament" showed up in Ședințe ("Fără PV") and counted in the attendance percentage.
-- From now on a series generates sessions of its own type (services/events.js); this fixes the rows already made.
-- Touches only sessions of a weekly NON-'sedinta' event that are still 'sedinta', have no meeting (PV) row and whose
-- slot is free for the new type. Their attendance records stay; they simply stop counting as meetings
-- (rules.COUNTING_SESSION_TYPES) unless the series is 'urgenta'.
UPDATE attendance_sessions
SET type = (SELECT e.type FROM events e WHERE e.id = attendance_sessions.event_id)
WHERE type = 'sedinta'
  AND event_id IN (SELECT id FROM events WHERE recurrence = 'weekly' AND type IN ('urgenta', 'competitie', 'antrenament', 'eveniment'))
  AND id NOT IN (SELECT session_id FROM meetings)
  AND NOT EXISTS (
    SELECT 1 FROM attendance_sessions o
    WHERE o.id <> attendance_sessions.id AND o.date = attendance_sessions.date
      AND IFNULL(o.start_time, '') = IFNULL(attendance_sessions.start_time, '')
      AND o.type = (SELECT e.type FROM events e WHERE e.id = attendance_sessions.event_id)
      AND IFNULL(o.team_id, 0) = IFNULL(attendance_sessions.team_id, 0)
      AND IFNULL(o.target_dept, '') = IFNULL(attendance_sessions.target_dept, ''));
