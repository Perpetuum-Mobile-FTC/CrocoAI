-- Persistent outbound WhatsApp queue (ops package E): paced sends survive a restart.
-- A row is deleted once sent; after WA_QUEUE_MAX_ATTEMPTS failures it stays as 'failed' (text cleared),
-- pruned after 30 days.
CREATE TABLE wa_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_wa_queue_pending ON wa_queue(status, next_attempt_at, id);
