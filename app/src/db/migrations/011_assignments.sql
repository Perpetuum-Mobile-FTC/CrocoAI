-- Teme și grupuri (docs/design-teme-grupuri.md §1).
ALTER TABLE teams ADD COLUMN department TEXT NOT NULL DEFAULT 'mixt'; -- tehnic | non-tehnic | mixt
ALTER TABLE teams ADD COLUMN created_by INTEGER REFERENCES members(id);

CREATE TABLE assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  due_at TEXT,
  mode TEXT NOT NULL,                 -- individual | grup
  target_type TEXT NOT NULL,          -- departament | grup
  target_dept TEXT,                   -- tehnic | non-tehnic
  target_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  target_label TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'activa', -- activa | inchisa
  reminded_due INTEGER NOT NULL DEFAULT 0,
  summarized_due INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_assignments_status_due ON assignments(status, due_at);
CREATE INDEX idx_assignments_creator ON assignments(created_by);

CREATE TABLE assignment_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE assignment_todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id), -- NULL for mode='grup'
  status TEXT NOT NULL DEFAULT 'de_facut',  -- de_facut | predat | de_refacut | acceptat
  current_version INTEGER NOT NULL DEFAULT 0,
  submitted_by INTEGER REFERENCES members(id),
  submitted_at TEXT,
  reviewed_by INTEGER REFERENCES members(id),
  review_comment TEXT,
  reviewed_at TEXT,
  UNIQUE (assignment_id, member_id)
);
CREATE INDEX idx_submissions_member ON submissions(member_id);

CREATE TABLE submission_todos (
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  todo_id INTEGER NOT NULL REFERENCES assignment_todos(id) ON DELETE CASCADE,
  done INTEGER NOT NULL DEFAULT 0,
  done_by INTEGER REFERENCES members(id),
  done_at TEXT,
  assignee_member_id INTEGER REFERENCES members(id),
  PRIMARY KEY (submission_id, todo_id)
);
CREATE INDEX idx_submission_todos_assignee ON submission_todos(assignee_member_id, done);

CREATE TABLE submission_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
