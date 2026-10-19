-- Regulament intern revizuit (72 articole, Anexele 14-17): renumerotare citări salvate ca DATE.
-- Idempotent: fiecare UPDATE se aplică doar dacă valoarea veche e încă prezentă.
-- 63 -> 59 (consimțământ foto/video), 49.4 -> 45.4, 62.3 -> 58.3, 54.3 -> 50.3.
UPDATE document_types SET article = 'Art. 59, 45.4' WHERE key = 'anexa13_foto_video' AND article = 'Art. 63, 49.4';
UPDATE document_types SET article = 'Art. 58.3' WHERE key = 'fisa_medicala' AND article = 'Art. 62.3';
UPDATE document_types SET article = 'Art. 50.3' WHERE key = 'acord_parental_deplasare' AND article = 'Art. 54.3';
