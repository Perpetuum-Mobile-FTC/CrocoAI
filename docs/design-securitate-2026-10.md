# CrocoAI — Pachet securitate A (din auditul 2026-10-16, aprobat de Luca)

Regula de aur rămâne: permisiuni doar în `src/domain/policy.js`, logică în servicii.

## A1. Parole
- `members.create` / import: parolă aleatoare (`crypto`), niciodată `perpetuum2026`; parola se afișează o singură dată liderului.
- `must_change_password=1` impus pe server: `requireAuth` permite doar `/api/auth/me`, `/api/auth/change-password`,
  `/api/auth/logout` până la schimbare (403 cu mesaj clar pentru restul).
- Politică unică: minim 8 caractere peste tot (schimbare, reset, înregistrare); schimbarea cere parola curentă
  (excepție: când `must_change_password=1`); parole temporare cu `crypto.randomInt`; logout → `token_version++`.
- Script/endpoint de raport (fără modificări automate): conturile care încă au parola implicită (bcrypt compare) și
  `last_login IS NULL` — lista pentru Luca.

## A2. XSS în proces-verbal
- `updateDraft` validează schema ciornei (fiecare câmp cu tipul lui; numere pentru prezențe).
- Exportul HTML și SPA-ul escapează toate câmpurile; CSP strict (`script-src 'none'`) pe ruta de export.
- `script-src` global fără `'unsafe-inline'` dacă nu strică paginile (altfel nonce) — verificat în browser.

## A3. Înregistrare cu cod pe WhatsApp
- Pasul 1: formularul se validează ca acum, dar contul NU se creează; se salvează o înregistrare în așteptare
  (`pending_registrations`: datele validate, hash-ul parolei, hash-ul codului, expiră în 30 min) și se trimite pe
  WhatsApp (gateway, imediat, nu prin coadă) un cod de 6 cifre: „Codul tău CrocoAI: 123456 (valabil 10 minute)”.
- Pasul 2: utilizatorul introduce codul → contul se creează exact ca acum (activ, logat automat, cereri de rol etc.).
- Limite: 5 încercări pe cod; retrimitere după 60 s; codul expiră în 10 min. Coduri trimise: max 3 / telefon / oră și
  6 / telefon / zi, 30 / IP / oră (`OTP_MAX_PER_IP_HOUR`; IPv6 grupat pe /64 — Wi-Fi-ul școlii), 60 / oră în total
  (`OTP_MAX_GLOBAL_HOUR`; la atingere, Team Leader-ul activ e anunțat o dată pe oră). Verificarea limitelor și
  rezervarea trimiterii se fac sincron, înainte de orice apel la gateway (fără curse la cereri paralele).
- O singură înregistrare în așteptare per telefon: o nouă cerere pentru același număr e refuzată (409, „Dacă ai închis
  pagina, încearcă din nou peste 30 de minute sau scrie-i unui lider.”) până expiră, cu excepția celei care trimite
  `pending_id`-ul ei (formularul corectat de același utilizator).
- Dacă numărul nu e pe WhatsApp (`resolve` eșuează) → mesaj clar „Numărul nu are WhatsApp — scrie-i unui lider”.
- Remindere WhatsApp doar către telefoane verificate (`members.phone_verified_at`); conturile existente se consideră
  verificate (au fost create înainte, de lideri sau prin formular — decizie: marcate verificate la migrare).
- Plafon: max 20 de taskuri cu reminder active per membru; titlu task ≤ 200 caractere.

## A4. Botul în grupuri WhatsApp
- `buildToolList` primește `isGroup`; în grupuri rămân doar tool-urile publice (regulament, manual FTC, evenimente,
  resurse); pentru restul răspunsul fix „Scrie-mi în privat pentru asta.” (fără date; botul nu scrie singur în privat).
- Membrii care nu sunt `activ` (sau `pauza`) nu pot folosi botul nici în grupuri.

## A5. Statusul contează pentru drepturi
- Grupurile privilegiate (LEADERS, MANAGERS, OVERSIGHT, mentor) cer `status = 'activ'`.

## A6. Ierarhie
- Doar Team Leader-ul poate da/lua rolurile `team_leader`, `co_leader`, `mentor` și poate reseta parola unui cont cu rol
  egal sau mai mare; co-leader-ul nu își poate schimba propriul rol.

## A7. Vizibilitate taskuri
- Membrii obișnuiți văd doar taskurile lor (asignate lor sau create de ei); managerii văd tot. La fel `/api/reminders`.
- `/api/photos/:id/thumb` nu servește originalul când lipsește miniatura (placeholder).

## Teste
Fiecare punct are teste (permisiuni pe rol și status, OTP: expirare/încercări/retrimitere/limite, must_change pe server,
XSS în export, tool-uri în grup, ierarhie, vizibilitate taskuri). Test în browser pentru înregistrarea cu cod (gateway
simulat) și pentru schimbarea obligatorie a parolei.
