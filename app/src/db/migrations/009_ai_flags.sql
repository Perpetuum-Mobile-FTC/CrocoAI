-- AI hardening monitoring (docs/design-ai-hardening.md §5). No message content is ever stored
-- here, only the category and who/when/channel, so LEADERS (and the crisis view) can monitor
-- refusals, limit hits and crisis signals without seeing what anyone wrote.
CREATE TABLE ai_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER REFERENCES members(id),
  channel TEXT NOT NULL, -- wa | web
  category TEXT NOT NULL, -- off_topic | periculos | date_personale | injectie | criza | limita
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ai_flags_member ON ai_flags(member_id, created_at);
CREATE INDEX idx_ai_flags_category ON ai_flags(category, created_at);
