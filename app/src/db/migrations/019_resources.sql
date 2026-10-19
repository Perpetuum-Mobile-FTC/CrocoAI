-- Resurse: shared library of files and external links grouped by category.
-- Files live on disk at data/resources/<stored_name> (never served statically).
CREATE TABLE resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('file','link')),
  url TEXT,
  file_name TEXT,
  file_mime TEXT,
  file_size INTEGER,
  stored_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_resources_category ON resources(category);
