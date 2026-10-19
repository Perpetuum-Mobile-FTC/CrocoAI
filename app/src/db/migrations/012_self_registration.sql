-- Înregistrare directă (docs/design-inregistrare.md). Rolurile de conducere cerute la înregistrare
-- rămân aici până le confirmă TL/co-leader (Admin -> Cereri de rol). applications.status e TEXT
-- liber: rândurile de audit ale înregistrărilor folosesc 'inregistrat'.
ALTER TABLE members ADD COLUMN requested_role TEXT;
