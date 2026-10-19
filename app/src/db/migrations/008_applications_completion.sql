-- Formular de date + cont (docs/design-formular-date.md). Public applications (Art. 14.1/14.2)
-- and profile-completion tokens for existing members.

CREATE TABLE applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  birthdate TEXT NOT NULL,
  class TEXT NOT NULL,
  school TEXT NOT NULL,
  department TEXT NOT NULL,
  guardian_name TEXT,
  guardian_relation TEXT,
  guardian_phone TEXT,
  guardian_email TEXT,
  motivation TEXT NOT NULL,
  source TEXT,
  gdpr_ack_at TEXT NOT NULL,
  guardian_ack_at TEXT,
  status TEXT NOT NULL DEFAULT 'in_asteptare', -- in_asteptare | acceptata | respinsa
  decided_by INTEGER REFERENCES members(id),
  decided_at TEXT,
  decision_note TEXT,
  created_member_id INTEGER REFERENCES members(id),
  ip_hash TEXT NOT NULL, -- sha256 of the submitter's IP, never the raw address
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_applications_status ON applications(status);
CREATE INDEX idx_applications_phone ON applications(phone);

-- One link per member per use; token itself is never stored, only its hash (design §3).
CREATE TABLE completion_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES members(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_completion_tokens_member ON completion_tokens(member_id);
