-- Art. 41.8: short content-free note on an entry (e.g. count=2 for medical_destroyed).
ALTER TABLE audit_log ADD COLUMN detail TEXT;
