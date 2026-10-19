-- Regulament revizuit (decizie Luca 2026-10-16).
-- Art. 22.1/22.2: nivelul competiției (regional/national obligatorii, international doar așteptat).
-- Art. 21.1: cerere de motivare depusă după ședință (max 48h) - marcată `ulterioara`.
-- Rândurile `competitie` existente devin 'regional' (obligatorii, comportamentul de până acum).
ALTER TABLE events ADD COLUMN competition_level TEXT CHECK (competition_level IN ('regional','national','international'));
ALTER TABLE attendance_sessions ADD COLUMN competition_level TEXT CHECK (competition_level IN ('regional','national','international'));
UPDATE events SET competition_level = 'regional' WHERE type = 'competitie';
UPDATE attendance_sessions SET competition_level = 'regional' WHERE type = 'competitie';
ALTER TABLE absence_requests ADD COLUMN ulterioara INTEGER NOT NULL DEFAULT 0;
