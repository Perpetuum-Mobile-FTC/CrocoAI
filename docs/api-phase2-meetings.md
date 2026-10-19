# API — Ședințe + proces-verbal (Faza 2, modul C1)

Extinde `docs/api-v2.md` §"Stubs (Phase 2)". Toate rutele sunt sub `/api/meetings`, necesită
autentificare (`requireAuth`), și folosesc EXCLUSIV `src/services/meetings.js` (actor-first,
permisiuni din `src/domain/policy.js`, reguli din `src/domain/rules.js`). O "ședință" (meeting) e
1:1 cu o `attendance_sessions` existentă de tip `sedinta`/`urgenta` (Art. 19, 51).

## Permisiuni (deja în `policy.js`, design-phase2.md §2)
- `meetings.manage` — MANAGERS: agendă, link Meet, audio, generare/editare ciornă PV.
- `meetings.approve` — LEADERS: aprobare PV (imuabil după aceea).
- `meetings.view_drafts` — OVERSIGHT (MANAGERS + mentori): vede ciornele.
- `meetings.view_upcoming` — membri activi: văd dată/oră/loc/Meet/ordinea de zi pentru ședințele VIITOARE (nu ciorna/transcriptul).
- `meetings.view_final` — membri activi/pauză/alumni: vede DOAR PV-urile aprobate (Art. 49.3).

## Endpoints

### `GET /api/meetings?from=&to=`
Listă sesiuni de tip `sedinta`/`urgenta` cu statusul PV-ului asociat (`none`/`draft`/`approved`).
Non-OVERSIGHT: doar rândurile cu `meeting_status === "approved"`.

### `GET /api/meetings/last-approved`
Cel mai recent PV aprobat (sau `null`). Folosit de tool-ul AI `ultimul_proces_verbal`.

### `GET /api/meetings/search?q=text`
Căutare substring (diacritice/case-insensitive) în draft+transcript. Aprobate pentru toți cu
`meetings.view_final`; ciornele doar pentru OVERSIGHT. Folosit de `cauta_procese_verbale`.

### `GET /api/meetings/decisions?date=YYYY-MM-DD`
Deciziile consemnate în PV-ul ședinței din acea dată (`{ date, decisions: [...] }`), fiecare cu
flag `majora` (Art. 47.2/47.4). Folosit de `deciziile_sedintei`.

### `POST /api/meetings/session/:sessionId`
MANAGERS. Creează (idempotent) rândul `meetings` pentru o sesiune existentă de tip sedinta/urgenta.

### `GET /api/meetings/:id`
Detaliu complet (sesiune, agendă, link Meet, status audio, draft parsat, `retention`). Ciornă:
necesită `meetings.view_drafts`; aprobat: necesită `meetings.view_final`.

### `PUT /api/meetings/:id/agenda` `{ agenda: string[] }`
MANAGERS, doar înainte de aprobare.

### `PUT /api/meetings/:id/meet-link` `{ link }`
Setare manuală a linkului Meet. MANAGERS, doar înainte de aprobare.

### `POST /api/meetings/:id/meet-link/auto`
Creează un eveniment Google Calendar cu Meet (necesită `GOOGLE_CLIENT_ID/SECRET/GOOGLE_TEAM_REFRESH_TOKEN`).
Nu aruncă eroare dacă nu e configurat — răspunde `{ configured: false, meet_link: null }`, UI cere
linkul manual. Dacă Google eșuează: `{ configured: true, meet_link: null, failed: true }`.

### `POST /api/meetings/:id/audio` (multipart, câmp `file`)
MANAGERS. Audio ≤ 300 MB, extensii `mp3/m4a/wav/webm/ogg`. Salvat în `/app/data/meetings/<id>/`,
pornește transcrierea în fundal (`services/transcription.js`) — răspunsul nu așteaptă finalizarea.

### `GET /api/meetings/:id/audio/status`
`{ audio_status: none|processing|done|error, audio_error, has_transcript }` — polling din UI.

### `POST /api/meetings/:id/draft`
MANAGERS. Generează ciorna PV cu UN singur apel AI (Agent SDK, fără tool-uri, izolat ca în
`ai/agent.js`, înregistrat în `ai_usage`). Prezențele vin din `attendance_records` ale sesiunii —
NICIODATĂ din transcript. Eșuează cu `INVALID` dacă AI nu e configurat sau dacă răspunsul nu e
JSON valid.

### `PUT /api/meetings/:id/draft` `{ draft: {...} }`
MANAGERS, doar înainte de aprobare. Înlocuiește ciorna (editare manuală din UI).

### `POST /api/meetings/:id/approve`
LEADERS. PV devine imuabil (`status=approved`, `approved_by/at`, `redactat_de`/`verificat_de`
completate). Acțiunile din ciornă cu un responsabil identificat devin taskuri
(`services/tasks.create`).

### `GET /api/meetings/:id/export`
HTML printabil, layout Anexa 7 (prezențe, ordine de zi, discuții/decizii, anunțuri, acțiuni,
ședința următoare, semnături, retenție Art. 49.2).

## Structura ciornei (`draft`, JSON)
```json
{
  "session_date": "2026-09-10", "start_time": "18:00", "location": "Sala S03",
  "agenda": ["Punct 1", "Punct 2"],
  "attendance": { "total_present": 8, "total_roster": 10, "present_names": [...], "absent_motivated_names": [...], "absent_names": [...] },
  "discussions": [{ "point": "...", "discussion": "...", "decision": "...", "majora": false }],
  "announcements": "...",
  "actions": [{ "action": "...", "responsible_name": "...", "responsible_member_id": 12, "due_date": "2026-09-20" }],
  "next_meeting": { "date": "2026-09-17", "note": "..." },
  "redactat_de": null, "verificat_de": null
}
```

## Ședințe all-in-one (design-sedinte-v2.md)

Programare, modificare, anulare (MANAGERS, `meetings.manage`). Anunțul: notificare în platformă pentru
fiecare membru activ + UN mesaj pe `TEAM_GROUP_ID` (dacă e setat; fără DM-uri). Ora se interpretează în
Europe/Bucharest; evenimentul din calendar se stochează în UTC.

### `POST /api/meetings/schedule`
`{ title, type: "sedinta"|"urgenta", date: "YYYY-MM-DD", time: "HH:MM", duration (min, 15–600, implicit 120),
mode: "fizic"|"online", location (obligatoriu la fizic), meet_link (online; gol = Meet automat dacă e configurat,
altfel 400), agenda: string[] }`. O tranzacție: `events` + `attendance_sessions` (cu `event_id`) + `meetings`.
Returnează ședința (cu `location`, `duration_min`, `mode`). Slot identic (dată+oră+tip) → 400.

### `PUT /api/meetings/:id/reschedule`
Aceleași câmpuri, toate opționale. Doar înainte de aprobarea PV. Anunț „Ședință modificată” DOAR dacă s-a schimbat
data, ora sau locul/linkul.

### `DELETE /api/meetings/:id`
Refuzat (400) dacă există prezențe marcate, audio/înregistrare (non-abandonată) sau PV aprobat. Șterge ședința,
sesiunea și evenimentul; anunț „Ședință anulată”.

### Înregistrare live (chunked) — `meetings.manage`
- `POST /api/meetings/:id/recording/start` `{ mime?, replace? }` → `{ recording_id }`. 409 dacă există deja o
  înregistrare neterminată sau ședința are audio (`processing`/`done`) fără `replace: true`; 400 după aprobarea PV.
- `POST /api/meetings/:id/recording/:rid/chunk?seq=N` — body binar (orice Content-Type), ≤ 5 MB (413 peste).
  `seq` strict crescător de la 0: egal cu următorul așteptat → scrie `data/meetings/<id>/rec-<rid>/<seq>.part`
  (`{ received, bytes, duplicate:false }`); deja primit → 200 `{ duplicate:true }` fără re-scriere;
  cu gol → 409 `{ error, code:"CONFLICT", expected_seq }`.
- `POST /api/meetings/:id/recording/:rid/stop` — concatenează bucățile în ordine într-un singur fișier
  (`.webm` / `.m4a` după `mime`), șterge bucățile, setează `audio_status='processing'` și pornește transcrierea
  existentă. Idempotent pentru o înregistrare deja finalizată. Returnează ședința.
- `POST /api/meetings/:id/recording/:rid/abandon` — marchează `abandoned`, șterge bucățile.
- `GET /api/meetings/:id/recording` → `{ recording_id, status, chunks, bytes, started_at, mime }` pentru înregistrarea
  neterminată sau `{ recording_id: null }`.

### Vizibilitate
(Restrâns în v3, vezi mai jos.) `GET /api/meetings` și `GET /api/meetings/:id` pentru un membru activ includ și ședințele viitoare neaprobate, într-o
formă redusă (fără `draft`/`transcript`, cu `upcoming: true`). `GET /api/attendance/sessions/:id` marchează în
`roster[].suggested = "motivat"` membrii cu absență aprobată pentru data sesiunii și fără înregistrare.

## Ședințe v3 — destinatari și prezență cu cod QR (design-sedinte-v3.md)

### Permisiuni noi (`policy.js`)
- `meetings.schedule(actor, target)` — `target = { target_type: "echipa"|"departament"|"grup", target_dept?, team? }`,
  regula de la teme: TL, co-leader, mentori → orice; șef de departament → toată echipa, departamentul lui și grupurile
  din departamentul lui; lider de grup → doar grupul lui. Doar conturi `activ`.
- `meetings.organize(actor, target + created_by)` — `meetings.schedule` pe destinatarul ședinței SAU creatorul ei (cont `activ`):
  modificare, anulare, ordinea de zi, cod QR, marcare manuală, închidere/redeschidere prezență.
- `meetings.view(actor, target)` — OVERSIGHT + organizatorii: pagina completă (prezență, PV).
- `meetings.view_section(actor, { leads_group })` — OVERSIGHT + liderii de grup: secțiunea Ședințe în platformă
  (`GET /api/auth/me` → `meetings_section`). Membrii văd cardul de pe Acasă.
- `meetings.scan` — orice cont `activ`.
- Înregistrarea, audio, ciorna PV rămân `meetings.manage` (MANAGERS); aprobarea `meetings.approve`.

### Programare cu destinatari
`POST /api/meetings/schedule` primește în plus `target_type` (implicit `echipa`), `target_dept` (`tehnic`|`non-tehnic`)
sau `target_team_id`. Stocare: `attendance_sessions.team_id` (grup) / `target_dept` (departament, migrația 016);
slotul unic include și departamentul. Chemații (`attendance.invitedMemberIds(session)`, singura definiție), doar membri
**activi**: departament d → rol `member`/`volunteer` cu `department` = d sau `ambele` + șeful departamentului d; grup →
membrii grupului (orice rol); echipă → toți, mai puțin rolurile `mentor`/`alumni`. Anunțul pe `TEAM_GROUP_ID` numește
destinatarul („📅 Ședință Departament Tehnic — <titlu>, …”, „📅 Ședință Grupul X — …”); notificările din platformă (și
reminderele 24h/1h) doar chemaților, cu link `/sedinte` pentru cei care văd secțiunea Ședințe, altfel `/`.
`PUT /reschedule` / `DELETE` cer `meetings.organize`; destinatarul nu se schimbă la modificare.
`GET /api/meetings/targets` → `{ team, departments: [], groups: [{ id, name, department }] }` (opțiunile „Pentru”).
`GET /api/meetings/upcoming/mine` → ședințele de azi încolo la care ești chemat
(`{ id, title, type, date, time, duration_min, mode, location, meet_link, agenda, audience }`).
`GET /api/meetings/:id` → în plus `audience { type, dept, team_id, team_name, label }`, `attendance_closed_at`,
`can_organize`, `can_manage`, `can_approve` (LEADERS + șeful departamentului ședinței); membrii obișnuiți primesc vederea redusă doar pentru ședințele viitoare la care sunt chemați.
`GET /api/meetings` → în plus `audience_label`; non-OVERSIGHT: PV aprobate, ședințele pe care le organizează,
ședințele viitoare la care sunt chemați.

### Prezență
- `GET /api/meetings/:id/qr` (`organize`) → `{ token, url, svg, seconds_left, expires_at, closes_at }`. SVG generat pe
  server (`qrcode`), URL `APP_BASE_URL/p/<token>`. 400 dacă prezența e închisă, PV aprobat sau în afara ferestrei.
  Marchează prezent pe cel care o deschide (extra dacă nu e chemat).
  - Token: `<meetingId>.<16 caractere base64url din HMAC-SHA256(secret, "<meetingId>:<floor(now/30s)>")>`,
    secret `ATTENDANCE_QR_SECRET` || `JWT_SECRET`. Acceptat și tokenul ferestrei anterioare.
  - Fereastra: de la 15 min înainte de start până la sfârșitul evenimentului (start + durată; 2 h fără eveniment).
- `POST /api/meetings/scan` `{ token }` (orice cont activ; max 20/min/utilizator → 429) →
  `{ meeting_id, meeting_title, status: "prezent"|"deja marcat", extra }`. Chemat → P; altcineva → P cu `extra = 1`.
  Token greșit/expirat, înainte/după ședință, prezență închisă → 400 cu mesaj.
- `GET /api/meetings/:id/attendance` (`meetings.view`) → `{ session_id, closed_at, window, created_by, invited: [...],
  extras: [...], counts: { invited, present, marked, extras } }`; fiecare rând `{ id, name, status, record, suggested?, extra? }`.
- `PUT /api/meetings/:id/attendance` `{ records: [{ member_id, status: "prezent"|"absent"|"motivat" }] }` (`organize`).
  Un membru din afara destinatarilor poate primi doar `prezent` (extra); `absent`/`motivat` → 400.
- `POST /api/meetings/:id/attendance/close` (`organize`) — 400 înainte de ora de început; cel care închide → P (dacă nemarcat); chemații activi nemarcați →
  M dacă au absență aprobată pentru data/sesiunea ședinței, altfel A; setează `attendance_closed_at` (codul QR nu mai merge).
- `POST /api/meetings/:id/attendance/reopen` (`organize`) — `attendance_closed_at = NULL`; marcajele rămân.

### Statistici
`attendance_records.extra` se calculează la FIECARE scriere de marcaj, inclusiv prin ruta veche
`PUT /api/attendance/sessions/:id/records` (`markRecords`, pagina Prezență): 1 dacă membrul nu e în regula de chemați a
sesiunii (status ignorat). Rândurile vechi (dinainte de migrația 016) au `extra = 0`.
`attendance_records.extra = 1` nu intră niciodată în procent (`statsFor` → `extra_present` separat); ședințele pe
departament se numără, ca cele pe grup, doar pentru cei cu înregistrare de chemat. `GET /api/attendance/sessions/:id`
listează rosterul după regula de chemați (inclusiv membrii în pauză / alumni, pentru „scutit”) + participanții extra
(`extra: true`) — se aplică și sesiunilor vechi „toată echipa”: mentorii nu mai apar în roster, iar un marcaj pus unui
mentor devine extra.

### Pagina de scanare
SPA `/p/:token` (orice membru logat) apelează `POST /api/meetings/scan`. Nelogat → `302 /login?next=/p/<token>`;
`login.html` revine doar la căi relative same-origin (`public/js/safe-next.js`, testat în `test/safe-next.test.js`:
refuză și căile care se rezolvă la `//host`, ex. `/.//evil.com`, `/%2e//evil.com`).
Ședințele săptămânale recurente (migrația 017): sesiunile se generează în ora locală Europe/Bucharest — fiecare apariție
păstrează ziua și ora locală a primei apariții peste schimbarea de oră; `session.date`/`start_time` sunt locale.
Fereastra QR = `session.date` + `start_time` local → UTC (DST-aware), durata = durata evenimentului.
Reminderele 24h/1h: evenimentele unice au flag-urile pe `events`; aparițiile unei serii au flag-uri proprii pe
`attendance_sessions` (`reminded_24h`, `reminded_1h`) și se calculează din data/ora locală a sesiunii. Destinatari în
platformă: pentru o sesiune care e ședință (sau are departament/grup) `invitedMemberIds(session)`, altfel toți activii.
Modificarea orei/zilei unei serii (`PUT /api/events/:id`, inclusiv formularul din calendar): sesiunile viitoare (data locală
≥ azi) fără date (fără prezențe; fără ședință cu audio/înregistrare/PV) se mută pe loc la noua dată/oră locală, cu flag-urile
de reminder resetate; cele trecute rămân; cele cu date rămân la ora veche și sunt raportate în răspuns ca
`stale_sessions: [{ id, date, start_time }]` (+ log). Se generează doar aparițiile lipsă — fără dubluri.
Mutarea se face în două faze (toate rândurile mutabile sunt „parcate” pe un `start_time` temporar unic, apoi plasate),
deci o mutare cu ±7 zile (aceeași oră) nu pierde nicio sesiune. Dacă ținta e ocupată de o sesiune care NU face parte din
mutare (dublură reală), rândul mutat — gol prin definiție — se șterge, cu log `[EVENTS] … dropped as a duplicate`.
Linkul Google Meet automat al unei ședințe mutate astfel NU se actualizează (evenimentul din Google Calendar rămâne la
ora veche); linkul în sine rămâne valabil — dacă e nevoie, se modifică ședința din pagina ei.

## Tool-uri AI (`src/ai/tools-meetings.js`)
`ultimul_proces_verbal`, `cauta_procese_verbale(text)`, `deciziile_sedintei(data)` — wrapează
EXACT aceleași funcții din `services/meetings.js` ca rutele de mai sus (paritate testată în
`test/meetings-ai-consistency.test.js`).

## Operare
- `.env`: `GROQ_API_KEY` (transcriere), `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_TEAM_REFRESH_TOKEN`
  (link Meet automat, opțional), `MEETINGS_AUDIO_DIR` (implicit `app/data/meetings`).
- Dockerfile runtime: `ffmpeg` instalat (apt) pentru segmentarea audio.
- Fără `GROQ_API_KEY`: upload-ul audio e acceptat, dar `audio_status` devine `error` cu mesaj clar
  — PV se completează manual, nimic nu blochează fluxul.
- Fără cont Google: linkul Meet e mereu manual, niciodată blocant.
