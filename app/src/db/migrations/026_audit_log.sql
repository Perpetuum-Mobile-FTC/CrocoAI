-- Persistent access log (cleanup F1, GDPR): who opened another member's medical sheet (Art. 41.4) - no
-- file content, ever. Readable only by the Team Leader (Art. 41.2, policy audit_log.view). Plain INTEGER
-- ids (no FK) so a row survives whatever happens to the member/document rows it points at.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  actor_role TEXT,
  action TEXT NOT NULL,       -- e.g. fisa_medicala.open
  member_id INTEGER,          -- whose data was accessed
  object_type TEXT,           -- e.g. member_document
  object_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
