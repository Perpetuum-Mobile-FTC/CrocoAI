-- Pachet securitate A (docs/design-securitate-2026-10.md, aprobat de Luca 2026-10-16).
-- A3: telefon verificat. Conturile existente se consideră verificate (create de lideri sau prin formular
-- înainte de codul pe WhatsApp - decizia din design); doar telefoanele reale, nu `pending-*`.
ALTER TABLE members ADD COLUMN phone_verified_at TEXT;
UPDATE members SET phone_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE phone IS NOT NULL AND phone NOT LIKE 'pending-%';

-- A3: înregistrare în așteptare până la confirmarea codului primit pe WhatsApp. Contul se creează
-- abia după cod; rândul se șterge la succes sau după expirare (30 min). Fără parola în clar, fără codul în clar.
CREATE TABLE pending_registrations (
  id TEXT PRIMARY KEY,              -- token aleator trimis browserului
  phone TEXT NOT NULL,
  data TEXT NOT NULL,               -- câmpurile validate (JSON, fără parolă)
  password_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  code_expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pending_registrations_phone ON pending_registrations(phone);

-- Fiecare cod trimis (limite: 3 / telefon / oră, plafon per IP / oră). Curățat după 1 zi.
CREATE TABLE otp_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  ip_hash TEXT,
  sent_at TEXT NOT NULL
);
CREATE INDEX idx_otp_sends_phone ON otp_sends(phone, sent_at);
CREATE INDEX idx_otp_sends_ip ON otp_sends(ip_hash, sent_at);
