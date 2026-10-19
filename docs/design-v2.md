# CrocoAI v2 — design (sursa de adevăr pentru implementare)

Scop: rezolvă tot din `docs/audit-2026-10-01.md` + pagina Documente (GDPR/participare) + **coerență totală
între platformă și agentul AI**. Regula de aur: **platforma și agentul nu au logică proprie** — amândouă apelează
același strat `app/src/domain/`. Nicio regulă, permisiune, prag sau calcul nu se scrie de două ori.

Sursa regulilor: Regulamentul intern v1.0 (repo `moldluca/perpetuum-docs`, `regulament/regulament-intern.md` +
`regulament/anexe.md`). Se vendorizează în `app/knowledge/` (copie + `scripts/sync-regulament.sh`), cu versiunea în antet.
Platforma (pagina Regulament) și agentul (tool `cauta_regulament`) citesc **aceeași copie**.

---

## 1. Arhitectură

```
routes/*.js  ─┐                       ┌─ domain/policy.js   (roluri + can())
              ├─► domain/services ────┤─ domain/rules.js    (praguri, sezoane, termene — cu articol)
ai/tools.js  ─┘   (members, attendance,└─ db
                   absences, tasks, events, reminders, documents, regulament, wa)
```
- **Toate verificările de permisiuni și validările stau în services**, primesc `actor` (rândul membrului care acționează)
  și aruncă `DomainError(code, message_ro, article?)` (`FORBIDDEN`, `NOT_FOUND`, `INVALID`, `LATE`, `LIMIT`).
- Rutele: map `DomainError` → HTTP (403/404/400/409/429) cu `{error, article}`. Agentul: același mesaj, verbatim.
- Error handler JSON global în Express (niciun răspuns HTML de eroare).

## 2. Roluri (Regulament Art. 4–12) — coloana `members.role`

| role | Nume afișat | Articol |
|---|---|---|
| `team_leader` | Team Leader | Art. 5 |
| `co_leader` | Co-Leader | Art. 6 |
| `head_tech` | Șef Departament Tehnic | Art. 7 |
| `head_nontech` | Șef Departament Non-Tehnic | Art. 8 |
| `member` | Membru | Art. 9 |
| `volunteer` | Voluntar | Art. 10 |
| `mentor` | Mentor | Art. 11 |
| `alumni` | Alumni / Îndrumător | Art. 12, 41.4 |

Grupuri derivate (în `policy.js`, nicăieri altundeva):
- `LEADERS` = team_leader, co_leader
- `MANAGERS` = LEADERS + head_tech, head_nontech
- `OVERSIGHT` = MANAGERS + mentor (citire largă, fără decizii operative — Art. 11.2)

Migrare date existente: `auth_role` → `role` (team_leader→team_leader, mentor→mentor, member→member).
Co-Leader-ul existent → `co_leader` (după telefon; pas specific echipei, scos din versiunea publică).
Adaugă fără telefon (de completat): „” `head_tech`, „” `head_nontech`.

## 3. Statusuri membru — `members.status`
`activ` · `pauza` (Art. 61: fără obligații de prezență, max 8 săptămâni, `pause_until`) · `iesit` (Art. 16–17, `left_at`) · `alumni`.
Login permis pentru `activ`, `pauza`, `alumni`. Istoric în `member_status_history`.

## 4. Matrice de permisiuni (singura definiție: `policy.can(actor, action, target)`)

| Acțiune | Cine |
|---|---|
| `members.manage` (creare, editare, rol, status, reset parolă, import) | LEADERS |
| `members.view_contacts` (telefon, email, părinți, școală, dată naștere ale ALTORA) | OVERSIGHT |
| `members.view_directory` (nume, rol, departament, echipe, status) | toți autentificații |
| propriul profil + propriile contacte | oricine |
| `attendance.mark` / creare sesiuni | MANAGERS |
| `attendance.view_all` (statistici + semnale pentru toți) | OVERSIGHT |
| prezența proprie | oricine |
| `absence.request` (pentru sine) | oricine activ |
| `absence.decide` | MANAGERS (Art. 21.1: TL sau Șef Departament) |
| `warnings.record` (avertisment verbal/scris, suspendare) | LEADERS (Art. 30.1) |
| `warnings.view` | OVERSIGHT + membrul vizat |
| `tasks.create` pentru sine | oricine |
| `tasks.assign` altora, editare/ștergere orice task | MANAGERS |
| task propriu: editare/ștergere; task primit: schimbare status | creator / asignat |
| `events.manage` | MANAGERS; mentorii pot crea doar tip `urgenta` (Art. 55.1) |
| `reminders.create` pentru sine | oricine |
| `reminders.create` pentru alt membru **activ** (niciodată numere din afară) | MANAGERS |
| `whatsapp.send` (mesaj în numele echipei) | LEADERS, **cu confirmare explicită** |
| `messages.view` (log WhatsApp grupuri urmărite) | LEADERS |
| `wa_groups.manage` (ce grupuri urmărește botul) | LEADERS |
| `documents.upload` propriu | oricine |
| `documents.review` (aprobare/respingere, vizualizare toți) | LEADERS |
| fișa medicală (Art. 62.3) a altcuiva | **doar team_leader** |
| `ai_usage.view` | LEADERS |
| regulament | toți |

## 5. Reguli (`domain/rules.js`, fiecare cu `article`)
- `seasonFor(date)`: **sezon activ** sep–feb (`prag 75%`), **extra-sezon** mar–aug (`prag 50%`) — Art. 20.1. ID sezon: `2026-2027` (sep→aug).
- Sesiuni care contează la procent: tip `sedinta` și `urgenta` (Art. 19, 55.4). `competitie` separat (Art. 22). `antrenament`/`eveniment`: informativ.
- Statusuri prezență: `prezent` · `absent` (nemotivat) · `motivat` · `scutit` (pauză Art. 61 → exclus complet).
- Procent = prezent / (prezent + absent) pe sesiunile care contează, în sezonul curent — **decizia lui Luca (2026-10-01): absențele motivate NU scad procentul**; se afișează separat. Constantă `MOTIVATED_COUNTS_AS_ABSENCE = false` (un singur loc).
- Semnale (NU sancțiuni automate — decid TL + Co-Leader, Art. 30.1):
  - `avertisment_nemotivate_sezon`: >= 3 nemotivate în sezon, consecutive sau nu → „Avertisment scris recomandat” (Art. 20.2; revizuit 2026-10-16, înlocuiește `streak_nemotivate`)
  - `total_nemotivate_sezon >= 5` → „Discuție TL + mentor” (Art. 20.3)
  - procent < prag sezon (cu ≥ 4 sesiuni) → „Sub pragul minim de prezență” (Art. 20.1)
  - pauză > 8 săptămâni → „Pauza depășește maximul” (Art. 61.3); revenire după > 4 săpt. → onboarding (Art. 61.5)
- Motivare absență: cerere cu ≥ **24h** înainte de sesiune (Art. 21.1); competiție ≥ **7 zile** (Art. 22.1). Cererea târzie se acceptă, marcată `tardiva`, decide MANAGERS.
- Minor = vârstă < 18 la data curentă (din `birthdate`; necunoscut → tratat ca minor pentru documente).
- Toate mesajele de semnal includ articolul. Platforma și agentul afișează **textul generat de rules.js**, nu reformulat.

## 6. Model de date (migrații noi, numerotate; backup automat al DB înainte de migrare)
- `members`: + `role`, `status`, `pause_until`, `birthdate`, `joined_at`, `left_at`, `class`, `school`, `email`, `department` (`tehnic`/`non-tehnic`/`ambele`), `notes` (doar LEADERS), `token_version` (invalidare sesiuni la schimbare parolă/dezactivare). Telefon normalizat (vezi §9).
- `guardians(id, member_id, name, relation, phone, email)`.
- `member_status_history(member_id, from_status, to_status, reason, changed_by, changed_at)`.
- `seasons` derivate din dată (fără tabel) — rules.js.
- `attendance_sessions(id, date, start_time, type, title, team_id NULL, event_id NULL, created_by, created_at)`, UNIQUE(date, start_time, type, COALESCE(team_id,0)).
- `attendance_records(session_id, member_id, status, note, marked_by, marked_at)`, PK(session_id, member_id), CHECK status.
- `absence_requests(id, member_id, session_id NULL, date, reason, status pending|aprobata|respinsa, tardiva, decided_by, decided_at, created_at)`. La aprobare + sesiune existentă → record `motivat`.
- `warnings(id, member_id, level verbal|scris|suspendare|excludere, article, reason, recorded_by, created_at)`.
- `tasks.assigned_member_id`, `reminders.target_member_id` (FK, nu telefon); `events.type`, `events.recurrence` (`weekly` + `until`) → generează sesiuni `sedinta`.
- `document_types` (seed, §7) + `member_documents(id, member_id, type_key, event_id NULL, file_path, original_name, mime, size, status incarcat|aprobat|respins, review_note, reviewed_by, reviewed_at, uploaded_at)`.
- `wa_groups.tracked` default **0**; doar grupurile urmărite sunt procesate/logate.
- `wa_pending_actions(id, member_id, chat_id, action json, expires_at)` — confirmări.
- `ai_usage(id, member_id, channel wa|web, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, tool_calls, created_at)`.
- Indexuri: notifications(member_id, read, created_at), messages(chat_id), reminders(sent, remind_at), tasks(assigned_member_id, status), events(start_time), attendance_records(member_id).
- Retenție (job zilnic): mesaje grup > 180 zile, notificări citite > 90 zile.

## 7. Documente (pagina nouă „Documente”)
Tipuri (seed în `document_types`; `required_for`: `toti` | `minori` | `majori` | `deplasare_minori`):

| key | Titlu | Sursă șablon | required_for | Cine semnează | Articol |
|---|---|---|---|---|---|
| `anexa5_confidentialitate` | Acord de confidențialitate (Anexa 5) | anexe.md → HTML printabil precompletat | toti | membru (+părinte dacă minor) | Art. 14.2 |
| `anexa6_regulament` | Formular acceptare regulament (Anexa 6) | anexe.md | toti | membru (+părinte dacă minor) | Art. 14.2 |
| `anexa13_foto_video` | Acord consimțământ foto/video (Anexa 13) | anexe.md | toti | **părinte/tutore dacă minor** | Art. 63, 49.4 |
| `fisa_medicala` | Fișă medicală sumară | șablon HTML nou (alergii, medicație, contact urgență) | toti | membru / părinte | Art. 62.3 — **vizibil doar membru + team_leader** |
| `first_policies` | Declarație FIRST Policies (minor și major) | `perpetuum-docs/declaratii/Declaratie-FIRST-POLICIES 2024-minor_si_major.pdf` | toti | conform formular | program FTC România |
| `consimtamant_participanti_majori` | Consimțământ participanți (majori) | PDF `Declaratie-consimtamant_participanti-majori-2024.pdf` | majori | membru | program FTC |
| `consimtamant_imagine_majori` | Consimțământ prelucrare imagine (majori) | PDF `Declaratie-consimtamant-prelucrare-imagine_majori-2024.pdf` | majori | membru | program FTC |
| `acord_parental_deplasare` | Acord parental deplasare | șablon HTML nou, legat de `event_id` (competiție) | deplasare_minori | părinte/tutore, ≥ 7 zile înainte | Art. 54.3 |

Flux: membrul vede lista **cerută pentru el** (calculată de `documents.requiredFor(member)`), descarcă șablonul
(PDF oficial sau anexa HTML precompletată cu numele lui, printabilă/salvabilă PDF), încarcă scanul/poza
(PDF/JPG/PNG/HEIC, ≤ 15 MB, verificare tip după conținut, nu doar extensie) → `incarcat` → LEADERS aprobă/resping cu notă
→ notificare (platformă + WhatsApp). Re-încărcare după respingere. Fișierele: `/app/data/documents/<member_id>/<uuid>.<ext>`,
servite DOAR prin endpoint autorizat (niciodată static). Câmpurile „acord GDPR / foto” din profil sunt **derivate**
din documentele aprobate (nu bife separate). Vedere LEADERS: matrice membri × documente, filtru „lipsă”.
Agentul răspunde la „ce documente îmi lipsesc?” din același `documents.requiredFor` + status.

## 8. Agentul AI (WhatsApp + chat web)
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) cu tool-uri proprii in-process (MCP SDK server), FĂRĂ tool-urile built-in
  (Bash/Read/Write etc. interzise), `settingSources: []`, fără persistență de sesiune, model din `AI_MODEL` (implicit `claude-sonnet-5` din 2026-10-16; inițial haiku).
  Autentificare doar prin env: **temporar `CLAUDE_CODE_OAUTH_TOKEN` (abonament Max — decizia lui Luca, risc asumat până la API key)**,
  apoi `ANTHROPIC_API_KEY` — **trecerea = schimbare de env, zero cod**. Fără nicio credențială → AI dezactivat elegant:
  comenzile deterministe merg, restul primește „Asistentul AI nu e configurat încă”.
- **Tool use** (scheme stricte) — fiecare tool = wrapper subțire peste un service, cu `actor` = membrul care scrie:
  `profilul_meu`, `taskurile_mele`, `creeaza_task`, `actualizeaza_task`, `evenimente_urmatoare`, `prezenta`
  (proprie sau a altuia dacă `attendance.view_all`), `cere_motivare_absenta`, `decide_motivare` (MANAGERS),
  `creeaza_reminder`, `documentele_mele` / `documente_lipsa_echipa` (LEADERS), `cauta_membru` (câmpuri filtrate de policy),
  `cauta_regulament` (returnează articolele potrivite, text exact + număr articol), `trimite_whatsapp` (LEADERS → creează
  `wa_pending_actions`, botul cere „Confirmi? Răspunde DA”; execuția doar la „DA” al aceluiași membru, în 10 minute).
- Erorile `DomainError` se întorc modelului ca `tool_result` cu `is_error` și mesajul exact → răspunsul agentului = refuzul platformei.
- System prompt stabil (fără dată/oră — acestea în mesajul user): identitate CrocoAI, română, concis (WhatsApp), **răspunde
  doar din tool-uri; pentru orice regulă cheamă `cauta_regulament` și citează articolul; nu promite acțiuni pe care un tool nu le-a confirmat**.
- **Comenzi deterministe fără LLM** (parser în `ai/commands.js`, folosind aceleași services): `ajutor`, `taskuri`,
  `sedinta`/`evenimente`, `prezenta`, `documente`, plus mulțumiri/„ok”/emoji-only → răspuns scurt. Formatarea textului
  pentru acestea e aceeași funcție folosită de tool-uri (`ai/format.js`).
- Context: ultimele 8 mesaje ale chatului **fără mesajul curent**, fiecare trunchiat la 500 caractere; în grupuri doar dacă botul e menționat/citat.
- Plafoane: `max_tokens` 400; max 8 iterații tool; limită/membru/zi (`AI_DAILY_LIMIT_MEMBER`=30, LEADERS ×3); buget global zilnic
  `AI_DAILY_TOKEN_BUDGET`; peste limită → mesaj clar. Fiecare apel → `ai_usage` (cost estimat cu prețurile modelului din config).
- Idempotență: `msgId` deja procesat → ignorat.
- Ownership WA (păstrat): grup urmărit → CrocoAI; DM membru activ/pauză → CrocoAI; DM Luca → LUCID, cu excepția prefixului `croco`.

## 9. Corectitudine (bug-uri din audit)
- Telefon: `normalizePhone()` unic: `07xxxxxxxx`→`407xxxxxxxx`, `+40…`/`0040…`→`40…`, alte țări păstrate cu prefix; folosit la import, admin, WA, login.
- Scheduler: fără suprapunere (flag `running`), `sent=1` doar la succes (cu `attempts`, max 5, apoi `failed`), mesaj „mâine/azi/în curând” corect, evenimentul creat cu < 1h → un singur mesaj.
- Anunțuri eveniment: doar pe grupul `TEAM_GROUP_ID` + notificări în platformă (fără DM în masă).
- Istoric chat web: ultimele N în ordine cronologică.
- Confirmările „am setat/am creat” vin din rezultatul tool-ului, nu din textul modelului.

## 10. Operare
Node 22 LTS, dependențe fixate, multi-stage build, fără Claude CLI în imagine. `/api/health` real (DB, ultimul tick scheduler,
gateway, AI configurat). Alertă (LUCID notify / Telegram) la: scheduler blocat, gateway deconectat > 10 min, erori AI repetate, backup eșuat.
Backup: local zilnic + off-site criptat (restic → Cloudflare R2), include DB + documente; `PRAGMA integrity_check`; test de restaurare documentat.
CI GitHub Actions: `npm ci && npm test`. Teste pe rute + **teste de coerență platformă↔agent** (§11).

## 11. Teste de coerență (obligatorii)
Pentru fiecare rol × fiecare acțiune din matricea §4: ruta HTTP și tool-ul AI echivalent dau **același** rezultat
(succes sau aceeași eroare). Pentru date seed: `prezenta` (tool) == `/api/attendance/stats` (rută), `documentele_mele` ==
`/api/documents/me`, semnalele == aceleași texte, `cauta_regulament("prezenta minima")` conține Art. 20.1.
