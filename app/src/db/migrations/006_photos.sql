-- Poze cu consimțământ (design-phase2.md §5, Art. 49.4, 63). Additive only.

CREATE TABLE albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  month TEXT, -- YYYY-MM, used for monthly albums (manual or WhatsApp auto-import)
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  session_id INTEGER REFERENCES attendance_sessions(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'platforma', -- 'platforma' | 'whatsapp'
  wa_group_id TEXT, -- set only for source='whatsapp' albums (one per tracked group + month)
  created_by INTEGER REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_albums_month ON albums(month);
-- One album per tracked WhatsApp group per month (NULLs don't collide in SQLite unique indexes,
-- which is fine: platform albums never set wa_group_id).
CREATE UNIQUE INDEX idx_albums_wa_group_month ON albums(wa_group_id, month);

CREATE TABLE photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  thumb_path TEXT, -- NULL when a thumbnail couldn't be generated (e.g. HEIC, video)
  mime TEXT NOT NULL,
  media_type TEXT NOT NULL, -- 'image' | 'video'
  size INTEGER NOT NULL,
  original_name TEXT,
  uploaded_by INTEGER REFERENCES members(id), -- NULL if a WhatsApp sender isn't a known member
  source TEXT NOT NULL DEFAULT 'platforma', -- 'platforma' | 'whatsapp'
  wa_msg_id TEXT,
  -- Publication state is NEVER stored as a stale boolean derived from consent - "published" here
  -- only records the LEADERS' explicit publish/unpublish decision (Art. 63.5). Whether it CAN be
  -- shown is always recomputed live from rules.photoPublication() on every tagged member's consent.
  published INTEGER NOT NULL DEFAULT 0,
  published_by INTEGER REFERENCES members(id),
  published_at TEXT,
  reported_private INTEGER NOT NULL DEFAULT 0, -- Art. 63.4 flag for LEADERS review
  reported_by INTEGER REFERENCES members(id),
  reported_at TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_photos_album ON photos(album_id);
CREATE UNIQUE INDEX idx_photos_wa_msg ON photos(wa_msg_id);

CREATE TABLE photo_tags (
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  tagged_by INTEGER REFERENCES members(id),
  tagged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (photo_id, member_id)
);
CREATE INDEX idx_photo_tags_member ON photo_tags(member_id);

-- Art. 63.3: consent withdrawal, effective from now on (never retroactive, never deleted - this is
-- the audit trail). A member can withdraw more than once over time (e.g. after re-consenting via a
-- newly approved Anexa 13); photos.js always compares the latest withdrawal against the latest
-- approved anexa13_foto_video document to decide the live consent state.
CREATE TABLE photo_consent_withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  withdrawn_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_photo_consent_withdrawals_member ON photo_consent_withdrawals(member_id);
