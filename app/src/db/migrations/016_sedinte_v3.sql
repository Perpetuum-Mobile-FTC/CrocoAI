-- Ședințe v3 (docs/design-sedinte-v3.md): department audience, QR attendance.
-- attendance_sessions.team_id (existing) = group audience; target_dept = department audience
-- (tehnic | non-tehnic); both NULL = whole team. Two departments may meet in the same slot.
ALTER TABLE attendance_sessions ADD COLUMN target_dept TEXT;
DROP INDEX idx_attendance_sessions_unique;
CREATE UNIQUE INDEX idx_attendance_sessions_unique
  ON attendance_sessions(date, IFNULL(start_time,''), type, IFNULL(team_id,0), IFNULL(target_dept,''));

-- 1 = the member was not invited (outside the session's audience): only ever "prezent", never
-- counted in the attendance percentage.
ALTER TABLE attendance_records ADD COLUMN extra INTEGER NOT NULL DEFAULT 0;

-- Set by "Închide prezența" (unmarked invited -> A / M); the QR stops working. NULL = open.
ALTER TABLE meetings ADD COLUMN attendance_closed_at TEXT;
