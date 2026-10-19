-- History of fetched Competition Manual versions (FTC monthly check, BIOBUZZ 2026-2027). One row
-- per real version change (never for "unchanged" checks, never for the first-ever/seed import) -
-- services/ftc-manual-updater.js. added/removed/changed are JSON arrays of {code, title}.
CREATE TABLE ftc_manual_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  filename TEXT,
  etag TEXT,
  sha256 TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  added TEXT NOT NULL DEFAULT '[]',
  removed TEXT NOT NULL DEFAULT '[]',
  changed TEXT NOT NULL DEFAULT '[]',
  summary TEXT
);
CREATE INDEX idx_ftc_manual_versions_fetched ON ftc_manual_versions(fetched_at);
