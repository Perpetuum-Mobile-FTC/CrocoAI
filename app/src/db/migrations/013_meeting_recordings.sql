-- Live recording sessions for a meeting (design-sedinte-v2.md §3). Chunks live on disk in
-- data/meetings/<meeting_id>/rec-<id>/<seq>.part; `chunks` = number received so far = next expected seq.
CREATE TABLE meeting_recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  started_by INTEGER REFERENCES members(id),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL DEFAULT 'recording', -- recording | finalized | abandoned
  chunks INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  mime TEXT
);
CREATE INDEX idx_meeting_recordings_meeting ON meeting_recordings(meeting_id, status);
