-- CrocoAI v2 schema additions (design-v2.md §6). Additive only - never edit 001.

-- ── members ──────────────────────────────────────────────────────────────
ALTER TABLE members ADD COLUMN role TEXT;
ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'activ';
ALTER TABLE members ADD COLUMN pause_until TEXT;
ALTER TABLE members ADD COLUMN birthdate TEXT;
ALTER TABLE members ADD COLUMN joined_at TEXT;
ALTER TABLE members ADD COLUMN left_at TEXT;
ALTER TABLE members ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE guardians (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relation TEXT,
  phone TEXT,
  email TEXT
);
CREATE INDEX idx_guardians_member ON guardians(member_id);

CREATE TABLE member_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  changed_by INTEGER REFERENCES members(id),
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_member_status_history_member ON member_status_history(member_id);

-- ── attendance ───────────────────────────────────────────────────────────
ALTER TABLE attendance_sessions ADD COLUMN start_time TEXT;
ALTER TABLE attendance_sessions ADD COLUMN event_id INTEGER REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE attendance_sessions ADD COLUMN created_by INTEGER REFERENCES members(id);
CREATE UNIQUE INDEX idx_attendance_sessions_unique ON attendance_sessions(date, IFNULL(start_time,''), type, IFNULL(team_id,0));

ALTER TABLE attendance_records ADD COLUMN marked_by INTEGER REFERENCES members(id);
ALTER TABLE attendance_records ADD COLUMN marked_at TEXT;

CREATE TABLE absence_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES attendance_sessions(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | aprobata | respinsa
  tardiva INTEGER NOT NULL DEFAULT 0,
  decided_by INTEGER REFERENCES members(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_absence_requests_member ON absence_requests(member_id);
CREATE INDEX idx_absence_requests_status ON absence_requests(status);

CREATE TABLE warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  level TEXT NOT NULL, -- verbal | scris | suspendare | excludere
  article TEXT,
  reason TEXT,
  recorded_by INTEGER REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_warnings_member ON warnings(member_id);

-- ── tasks / reminders / events ──────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN assigned_member_id INTEGER REFERENCES members(id);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_member_id, status);

ALTER TABLE reminders ADD COLUMN target_member_id INTEGER REFERENCES members(id);
ALTER TABLE reminders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN failed INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_reminders_sent ON reminders(sent, remind_at);

ALTER TABLE events ADD COLUMN type TEXT NOT NULL DEFAULT 'eveniment';
ALTER TABLE events ADD COLUMN recurrence TEXT; -- 'weekly' | NULL
ALTER TABLE events ADD COLUMN recurrence_until TEXT;
ALTER TABLE events ADD COLUMN created_by INTEGER REFERENCES members(id);
CREATE INDEX idx_events_start ON events(start_time);

-- ── documents ────────────────────────────────────────────────────────────
CREATE TABLE document_types (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  required_for TEXT NOT NULL, -- toti | minori | majori | deplasare_minori
  article TEXT,
  source TEXT NOT NULL -- 'pdf' | 'html-anexa' | 'html-form'
);

CREATE TABLE member_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  type_key TEXT NOT NULL REFERENCES document_types(key),
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  file_path TEXT,
  original_name TEXT,
  mime TEXT,
  size INTEGER,
  status TEXT NOT NULL DEFAULT 'incarcat', -- incarcat | aprobat | respins
  review_note TEXT,
  reviewed_by INTEGER REFERENCES members(id),
  reviewed_at TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_member_documents_member ON member_documents(member_id, type_key);

-- ── whatsapp / ai ────────────────────────────────────────────────────────
CREATE TABLE wa_pending_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  action TEXT NOT NULL, -- json
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE wa_message_log (
  msg_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER REFERENCES members(id),
  channel TEXT NOT NULL, -- wa | web
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ai_usage_member ON ai_usage(member_id, created_at);

-- ── remaining indexes from design §6 ───────────────────────────────────
CREATE INDEX idx_notifications_member_read ON notifications(member_id, read, created_at);
