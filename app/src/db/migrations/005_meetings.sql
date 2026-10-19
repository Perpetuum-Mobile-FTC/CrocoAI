-- Meetings + minutes (procese verbale), design-phase2.md §4. 1:1 with attendance_sessions
-- (a "meeting" is the Meet link / audio / transcript / PV attached to an existing session).
CREATE TABLE meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL UNIQUE REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  agenda TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  meet_link TEXT,
  meet_source TEXT, -- 'auto' (Google Calendar) | 'manual'
  meet_event_id TEXT,
  audio_path TEXT, -- relative to data/meetings/
  audio_status TEXT NOT NULL DEFAULT 'none', -- none | processing | done | error
  audio_error TEXT,
  transcript TEXT,
  transcript_segments TEXT, -- JSON array [{ index, text }], ordered
  draft TEXT, -- JSON, Anexa 7 structure (see services/meetings.js)
  draft_generated_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | approved
  version INTEGER NOT NULL DEFAULT 1,
  approved_by INTEGER REFERENCES members(id),
  approved_at TEXT,
  created_by INTEGER REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_meetings_status ON meetings(status);
