CREATE TABLE members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  username TEXT UNIQUE,
  phone TEXT UNIQUE NOT NULL,
  email TEXT,
  class TEXT,
  school TEXT,
  department TEXT DEFAULT 'ambele', -- tehnic | non-tehnic | ambele
  auth_role TEXT NOT NULL DEFAULT 'member', -- team_leader | mentor | member
  active INTEGER NOT NULL DEFAULT 1,
  onboarding_step INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  notes TEXT,
  last_login TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- leader | member
  PRIMARY KEY (team_id, member_id)
);

CREATE TABLE attendance_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL, -- YYYY-MM-DD
  title TEXT,
  type TEXT NOT NULL DEFAULT 'sedinta', -- sedinta | antrenament | competitie
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE attendance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status TEXT NOT NULL, -- P | A | M (motivat)
  note TEXT,
  UNIQUE(session_id, member_id)
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  assigned_phone TEXT,
  assigned_name TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done
  reminded_due INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  location TEXT,
  start_time TEXT NOT NULL, -- ISO with Z
  end_time TEXT,
  reminded_24h INTEGER NOT NULL DEFAULT 0,
  reminded_1h INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_phone TEXT NOT NULL,
  target_name TEXT,
  message TEXT NOT NULL,
  remind_at TEXT NOT NULL, -- ISO with Z
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL, -- phone or group id (@g.us)
  sender_phone TEXT,
  sender_name TEXT,
  body TEXT,
  from_me INTEGER NOT NULL DEFAULT 0,
  is_group INTEGER NOT NULL DEFAULT 0,
  group_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE wa_groups (
  group_id TEXT PRIMARY KEY,
  name TEXT,
  tracked INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE web_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  message_type TEXT NOT NULL, -- 'web-user' | 'web-ai'
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_messages_chat ON messages(chat_id, created_at);
CREATE INDEX idx_attendance_records_member ON attendance_records(member_id);
CREATE INDEX idx_web_chat_member ON web_chat_messages(member_id, created_at);
