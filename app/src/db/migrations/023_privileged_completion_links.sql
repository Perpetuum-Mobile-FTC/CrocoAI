-- Pachet securitate A, runda de fix 2: linkurile publice de completare pot schimba telefonul contului. Pentru
-- TL / co-leader / mentor ele se creează acum doar de Team Leader; cele nefolosite create înainte de fix se șterg.
DELETE FROM completion_tokens
WHERE used_at IS NULL
  AND member_id IN (SELECT id FROM members WHERE role IN ('team_leader', 'co_leader', 'mentor'));
