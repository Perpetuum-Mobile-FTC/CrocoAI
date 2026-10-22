-- „Văzut ultima dată” (2026-10-22): when a member last used the platform (any authenticated request), recorded
-- at most once per rules.LAST_SEEN_RESOLUTION_MS. last_login only changes on a password login, and accounts made
-- through /inscriere are logged in automatically for 30 days, so it said "never" for people who use the app.
ALTER TABLE members ADD COLUMN last_seen_at TEXT;
UPDATE members SET last_seen_at = last_login WHERE last_login IS NOT NULL;
