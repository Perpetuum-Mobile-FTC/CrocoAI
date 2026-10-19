# CrocoAI — Ședințe all-in-one (design, aprobat de Luca 2026-10-12)

Extinde `docs/design-phase2.md` §4 și `docs/api-phase2-meetings.md`. Regula de aur: permisiuni doar în
`src/domain/policy.js`, logică în `src/services/*`, rute și UI subțiri.

Decizii Luca (2026-10-12):
- Pagina unei ședințe = locul unic pentru **programare, prezență, înregistrare live, PV**.
- Înregistrare live din browser (ședințe fizice), **trimisă pe server bucată cu bucată** (~1 min), cu reluare după întrerupere.
- Anunțul ședinței: notificare în platformă pentru fiecare membru activ + **un mesaj pe grupul de Anunțuri**
  (`TEAM_GROUP_ID`; LUCID e admin în grupuri din 2026-10-12). Fără DM-uri în masă. Dacă `TEAM_GROUP_ID` e gol → doar în platformă.

## 1. Programare (`meetings.manage` = MANAGERS)
- „+ Ședință nouă” pe pagina Ședințe: titlu, tip (`sedinta` / `urgenta`), dată, oră, durată (min), loc:
  `fizic` (text sală) sau `online` (Meet automat prin `google-meet.js`; dacă nu e configurat → câmp manual), ordinea de zi.
- `meetings.schedule(actor, data)` — o tranzacție: `events` (calendar, cu loc/Meet) + `attendance_sessions`
  (tip sedinta/urgenta, `event_id`) + `meetings` (agendă, link Meet) → apoi anunț.
- `meetings.reschedule(actor, meetingId, data)` — actualizează eveniment + sesiune (+ Meet dacă devine online); anunț „Ședință modificată”
  doar dacă se schimbă data/ora/locul.
- `meetings.cancel(actor, meetingId)` — permis doar dacă nu există prezențe marcate, nici audio/înregistrare, nici PV aprobat;
  șterge ședința + sesiunea + evenimentul; anunț „Ședință anulată”.
- Reminderele existente pentru evenimente (24h / 1h, `reminder-scheduler`) rămân valabile (grup + platformă).
- Textul anunțului (grup): „📅 Ședință <titlu> — <zi dd.mm>, ora <hh:mm>, <sala | link Meet>. Ordinea de zi: …”.

## 2. Prezență pe pagina ședinței (`attendance.mark` = MANAGERS)
- Lista membrilor activi (aceeași listă ca la sesiunea de prezență existentă, cu filtrul de echipă dacă e cazul) cu
  butoane P / A / M salvate imediat prin serviciul existent `attendance` (`PUT /api/attendance/sessions/:id/records`).
- Absențele aprobate pentru data respectivă apar pre-marcate „M” (regula existentă, dacă există; altfel nimic pre-marcat).
- Statisticile din pagina Prezență rămân corecte (aceleași tabele).

## 3. Înregistrare live (`meetings.manage`)
- UI: Start / Pauză / Reia / Oprește, cronometru, indicator de nivel (AnalyserNode), contor „bucăți trimise”,
  Screen Wake Lock pe durata înregistrării, avertisment la închiderea tab-ului în timp ce înregistrează.
- `MediaRecorder` (`audio/webm;codecs=opus`, ~32 kbps, `timeslice` 60 s); fallback `audio/mp4` pe Safari.
- API:
  - `POST /api/meetings/:id/recording/start` → `{ recording_id }` (refuzat dacă ședința are deja audio finalizat, cu opțiune
    explicită `replace: true`; refuzat după aprobarea PV).
  - `POST /api/meetings/:id/recording/:rid/chunk?seq=N` (body binar, ≤ 5 MB) — seq strict crescător de la 0;
    seq deja primit → 200 idempotent fără re-scriere; seq cu gol → 409 cu `expected_seq` (clientul retrimite din coada locală).
    Bucățile se scriu în `data/meetings/<id>/rec-<rid>/<seq>.part`.
  - `POST /api/meetings/:id/recording/:rid/stop` → concatenează bucățile în ordine într-un singur fișier și pornește
    pipeline-ul existent de transcriere (`transcription.js`, ffmpeg + Groq).
  - `GET /api/meetings/:id/recording` → starea înregistrării active/neterminate (`recording_id`, bucăți primite, bytes, început),
    ca UI-ul să ofere „Finalizează înregistrarea” după o întrerupere.
- Clientul ține bucățile netrimise într-o coadă în memorie și reîncearcă (cu backoff) până ajung.
- „Încarcă fișier” (fluxul existent) rămâne ca alternativă.

## 4. Pagina unei ședințe (ordine)
Detalii (dată, oră, loc / Meet, butoane Modifică / Anulează) → Ordinea de zi → Prezență → Înregistrare → Ciornă PV → Aprobare/Export.
Membrii obișnuiți văd ca acum doar PV-urile aprobate; detaliile ședințelor viitoare (dată, loc, ordinea de zi) le văd toți membrii activi.

## 5. Teste
Programare (eveniment + sesiune + ședință + anunț: grup dacă `TEAM_GROUP_ID`, altfel doar platformă), modificare (anunț doar la
schimbare de dată/oră/loc), anulare (refuzată cu prezențe/audio), bucăți (ordine, duplicat idempotent, gol → 409, limită 5 MB,
stop → fișier concatenat corect + transcriere pornită — cu transcrierea mock-uită), reluare după întrerupere, permisiuni.
Test în browser cu microfon simulat (Chromium `--use-fake-device-for-media-stream`).
