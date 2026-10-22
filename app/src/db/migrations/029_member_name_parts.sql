-- Prenume + Nume de familie (2026-10-22). members.full_name stays the display name and is written as
-- "first_name last_name" whenever the parts are set (src/domain/name.js). Existing rows keep NULL parts:
-- production names are split with an explicit mapping (scripts/apply-name-mapping.js), never guessed here.
-- pending_registrations keeps its validated fields in the JSON `data` column (first_name/last_name included).
ALTER TABLE members ADD COLUMN first_name TEXT;
ALTER TABLE members ADD COLUMN last_name TEXT;
ALTER TABLE applications ADD COLUMN first_name TEXT;
ALTER TABLE applications ADD COLUMN last_name TEXT;
