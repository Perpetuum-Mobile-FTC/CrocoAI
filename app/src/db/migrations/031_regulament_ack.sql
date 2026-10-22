-- Art. 72.3 (2026-10-22): accepting the regulament by ticking the box when the account is created replaces the
-- signed Anexa 6. A public application keeps the moment and version until a leader accepts it and the member exists.
ALTER TABLE applications ADD COLUMN regulament_ack_at TEXT;
ALTER TABLE applications ADD COLUMN regulament_version TEXT;
