-- Onboarding (Art. 14, 47) + Chat echipă (Art. 23.1, 24) — design-phase2.md §6.

-- Ops update (gateway §7): GET /group/:id/invite is unreliable (WA Web invite module doesn't
-- load headlessly) - LEADERS can set a manually-copied invite link per group as a fallback.
ALTER TABLE wa_groups ADD COLUMN invite_link TEXT;

-- ── Onboarding ───────────────────────────────────────────────────────────
-- One row per onboarding process. A member can be restarted (new row) after a previous
-- one was completed/cancelled, but only one 'activ' row at a time (enforced in the service).
CREATE TABLE onboarding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  buddy_id INTEGER REFERENCES members(id),
  started_by INTEGER REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'activ', -- activ | complet | anulat
  draft TEXT NOT NULL DEFAULT '{}', -- JSON of dialog answers collected so far
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX idx_onboarding_member ON onboarding(member_id, status);

-- Checklist items mirror rules.ONBOARDING_STEPS (Art. 47.2) for each onboarding process.
CREATE TABLE onboarding_checklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  onboarding_id INTEGER NOT NULL REFERENCES onboarding(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_by INTEGER REFERENCES members(id),
  done_at TEXT,
  UNIQUE(onboarding_id, step_key)
);

-- ── Chat echipă ──────────────────────────────────────────────────────────
CREATE TABLE chat_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, -- direct | group | announce
  name TEXT, -- group/announce display name
  created_by INTEGER REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE chat_participants (
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, member_id)
);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES members(id),
  body TEXT NOT NULL,
  reported INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_chat_messages_conv ON chat_messages(conversation_id, id);

CREATE TABLE chat_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  reported_by INTEGER REFERENCES members(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Singleton official "Anunțuri" channel (Art. 23.1) — created once, never duplicated.
INSERT INTO chat_conversations (type, name) VALUES ('announce', 'Anunțuri');
