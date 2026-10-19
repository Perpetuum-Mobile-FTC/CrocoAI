// Pachet B (docs/design-pachet-b.md, 2026-10-16):
//   - announcements: replaces the team chat's "Anunțuri" channel (B2); the old channel posts are copied here,
//     the other chat tables stay in the DB as history only (no UI, no routes).
//   - deadlines: countdown card on Acasă (B1), seeded with the two known season deadlines.
//   - photos.medium_path: a ~1600px variant served to every viewer (B3); the original stays for leaders/uploader.
// Only plain SQL here - never services (CLAUDE.md: circular require with src/db).

// Old channel text -> { title, body }: first line as title (≤ 120 chars), the rest as body.
function splitPost(text) {
  const t = String(text || "").trim();
  const nl = t.indexOf("\n");
  if (nl > 0 && nl <= 120) return { title: t.slice(0, nl).trim(), body: t.slice(nl + 1).trim() };
  if (t.length <= 120) return { title: t, body: "" };
  return { title: `${t.slice(0, 100).trim()}…`, body: t };
}

function up(db) {
  db.exec(`
    CREATE TABLE announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      audience TEXT NOT NULL DEFAULT 'echipa', -- echipa | tehnic | non-tehnic
      author_id INTEGER REFERENCES members(id) ON DELETE SET NULL, -- NULL = automated (e.g. FTC manual update)
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      sent_whatsapp_at TEXT
    );
    CREATE INDEX idx_announcements_created ON announcements(created_at);

    CREATE TABLE deadlines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      date TEXT,       -- YYYY-MM-DD (Europe/Bucharest calendar day); NULL = not announced yet
      date_text TEXT,  -- shown when date is NULL, e.g. "ianuarie–februarie 2027"
      created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    INSERT INTO deadlines (title, date, date_text) VALUES ('Termen înscriere membri pe natie.ro', '2027-01-17', NULL);
    INSERT INTO deadlines (title, date, date_text) VALUES ('Etapa Regională', NULL, 'ianuarie–februarie 2027');

    ALTER TABLE photos ADD COLUMN medium_path TEXT;
  `);

  const hasChat = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'").get();
  if (!hasChat) return;
  const posts = db.prepare(`
    SELECT cm.body, cm.sender_id, cm.created_at FROM chat_messages cm
    JOIN chat_conversations c ON c.id = cm.conversation_id
    WHERE c.type = 'announce' ORDER BY cm.id
  `).all();
  const insert = db.prepare("INSERT INTO announcements (title, body, audience, author_id, created_at) VALUES (?, ?, 'echipa', ?, ?)");
  for (const p of posts) {
    const { title, body } = splitPost(p.body);
    if (title) insert.run(title, body, p.sender_id, p.created_at);
  }
}

module.exports = { up, splitPost };
