# API — Onboarding WhatsApp + Chat echipă (Faza 2, C3)

> **Pachet B (2026-10-16, `docs/design-pachet-b.md` B2): Chat echipă a fost ELIMINAT.** Secțiunile despre chat de mai jos
> (rute `/api/chat/*`, `services/chat.js`, tool-ul vechi `anunturi_recente`, acțiunile `chat.*`) sunt doar istoric.
> Tabelele `chat_*` rămân în DB fără UI; postările canalului „Anunțuri” au fost copiate în `announcements` (migrația 024).
> Anunțurile: `/api/announcements`, `services/announcements.js`, `ai/tools-announcements.js`. Onboarding-ul rămâne valabil.

Extinde `docs/api-v2.md`. Regula de aur rămâne: rutele sunt wrappere subțiri peste
`src/services/onboarding.js` / `src/services/chat.js`, cu `actor = req.user`. Permisiunile sunt
în `src/domain/policy.js` (`onboarding.start`, `onboarding.manage`, `chat.use`, `chat.announce`,
`chat.moderate`, `wa_groups.manage_participants`), pragurile în `src/domain/rules.js`
(`ONBOARDING_STEPS`, `BUDDY_SESSIONS`, `ONBOARDING_CHECK_DAYS`).

## Migrație `007_onboarding_chat.sql`

- `onboarding` (member_id, buddy_id, started_by, status activ|complet|anulat, draft JSON, started_at, completed_at)
- `onboarding_checklist` (onboarding_id, step_key din `ONBOARDING_STEPS`, done, done_by, done_at)
- `chat_conversations` (type direct|group|announce, name, created_by) — rândul `announce` ("Anunțuri") e creat o singură dată, la migrație
- `chat_participants` (conversation_id, member_id, last_read_message_id)
- `chat_messages` (conversation_id, sender_id, body, reported)
- `chat_reports` (message_id, reported_by, reason)
- `wa_groups.invite_link` (coloană nouă, nullable) — link de invitație WhatsApp setat manual de LEADERS,
  folosit ca fallback (vezi mai jos, ops update design-phase2.md §7)

## Onboarding (Art. 14, 43)

Dialogul WhatsApp e un **state machine determinist** (`members.onboarding_step`, 1–7), separat de
checklist-ul Art. 43.2 (`onboarding_checklist`). Fără LLM — niciun apel către agent în timpul
dialogului (lecție v1).

Pași dialog: 1 nume complet → 2 clasă → 3 școală → 4 email (validat) → 5 data nașterii
(`zz.ll.aaaa`) → 6 departament (`tehnic`/`non-tehnic`/`ambele`) → 7 confirmare (`DA` sau
`corectez <câmp>`, câmpuri: `nume`, `clasa`, `scoala`, `email`, `data`, `departament`).

La finalizare (`DA` pe pasul 7):
- actualizează datele membrului, generează parolă temporară nouă (`must_change_password=1`)
- bifează automat `platforma`
- adaugă pe membru în fiecare grup WhatsApp **urmărit** via gateway `POST /group/participants`;
  dacă reușește măcar unul → bifează `grup_whatsapp`. Dacă eșuează (ex. 403 lipsă drepturi admin):
  fallback `GET /group/:id/invite` (dacă răspunde 200) → link manual stocat în `wa_groups.invite_link`
  (setat de LEADERS din Admin → Grupuri WhatsApp) → dacă niciuna nu există, notifică toți LEADERS
  să adauge manual; checklist-ul rămâne nebifat.
- trimite pe WhatsApp username + parolă temporară + lista documentelor necesare (`documents.requiredFor`)
- notifică Șeful de Departament (după `department`) + buddy (dacă a fost alocat la pornire)

`documents.review()` apelează `onboarding.onDocumentApproved(memberId)` (lazy require, fără
dependință circulară) — când TOATE documentele necesare sunt aprobate, bifează `documente`.

### Rute (`requireAuth` pe toate)

| Rută | Actor | Descriere |
|---|---|---|
| `POST /api/onboarding` | `onboarding.start` (LEADERS) | `{ name, phone, department?, buddy_id? }` → creează membru `volunteer` + pornește dialogul |
| `GET /api/onboarding` | `onboarding.manage` (MANAGERS) | toate procesele, cu checklist + `overdue` (Art. 43.3, 30 zile) |
| `GET /api/onboarding/signals/overdue` | `onboarding.manage` | doar cele depășite și incomplete — folosit de Acasă |
| `GET /api/onboarding/:memberId` | `onboarding.manage` sau membrul însuși | checklist + stare |
| `POST /api/onboarding/:memberId/checklist/:stepKey` | `onboarding.manage` | `{ done }` — bifare manuală (prezentare, siguranta rămân mereu manuale) |
| `POST /api/onboarding/:memberId/restart` | `onboarding.manage` | anulează procesul activ, pornește unul nou, retrimite mesajul de bun venit |
| `POST /api/onboarding/:memberId/cancel` | `onboarding.manage` | marchează `anulat` |

### Hook `wa-incoming.js`

Dacă `member.onboarding_step > 0`, mesajul e rutat către `onboarding.handleReply()` **înainte**
de confirmările pending / comenzi deterministe / agentul AI — marcat explicit în cod cu comentariu.
`wa-ownership.decideOwnership` deja marchează `handled:true` pentru acești membri (regulă existentă
v2, neschimbată).

### Tool AI

- `stare_onboarding` (MANAGERS) — listă voluntari în integrare, ce lipsește, cine e depășit de 30 zile.

## Chat echipă (Art. 23.1, 24) — ELIMINAT în pachet B (istoric)

Conversații `direct` (1-la-1, deduplicate per pereche), `group` (membri aleși) și canalul unic
`announce` ("Anunțuri", creat o singură dată la migrație) — doar `chat.announce` (LEADERS) poate
posta acolo; opțional oglindit pe WhatsApp în `TEAM_GROUP_ID` (env) dacă e setat. Mesaje ≤ 4000
caractere. Un membru nu poate citi/scrie într-o conversație din care nu face parte — **inclusiv
LEADERS**, cu excepția canalului Anunțuri (vizibil tuturor cu `chat.use`) și a mesajelor raportate
(vizibile doar în coada de moderare, nu restul conversației).

### Rute (`requireAuth` pe toate, `/api/chat/*`)

| Rută | Actor | Descriere |
|---|---|---|
| `GET /conversations` | `chat.use` | lista proprie + Anunțuri, cu `unread_count`, `last_message`, `can_post` |
| `POST /conversations/direct` | `chat.use` | `{ member_id }` → creează sau reutilizează conversația 1-la-1 |
| `POST /conversations/group` | `chat.use` | `{ name, member_ids[] }` |
| `GET /conversations/:id/messages?after=<id>` | participant | polling — doar mesaje cu `id > after` |
| `POST /conversations/:id/messages` | participant (+ `chat.announce` pe Anunțuri) | `{ body }` |
| `POST /messages/:id/report` | orice participant al conversației | `{ reason? }` → notifică LEADERS |
| `GET /moderation` | `chat.moderate` (LEADERS) | doar mesajele raportate (sender, reporter, conținut) |

### Tool AI

- `anunturi_recente` — ultimele N mesaje de pe canalul Anunțuri (implicit 10).

## Ops update — `wa_groups.invite_link` (gateway §7)

`GET /group/:id/invite` de pe gateway e nesigur (modulul de invite WhatsApp Web nu se încarcă
headless → răspunde adesea 403). LEADERS pot seta manual un link de invitație per grup din
Admin → Grupuri WhatsApp:

| Rută | Actor | Descriere |
|---|---|---|
| `POST /api/wa-groups/:groupId/invite-link` | `wa_groups.manage` (LEADERS) | `{ link }`, validat `^https://chat.whatsapp.com/` |

## Frontend

- `public/js/pages/chat-echipa.js` — montat pe `/chat-echipa` ("Chat echipă" în nav, înlocuiește
  placeholder-ul „În curând"), listă conversații cu bife necitite, fir de discuție, compozitor,
  polling 5s doar cât pagina e vizibilă (`document.hidden`), modal conversație nouă/grup nou,
  raportare mesaj. Badge roșu în nav (`.nav-badge`) cu totalul de mesaje necitite, poll la 60s.
- `public/js/pages/membri.js` — tab „Integrare” pe profilul membrului (LEADERS + membrul însuși),
  checklist bifabil pentru LEADERS, buton „+ Voluntar nou (onboarding)” pe pagina Membri (LEADERS).
- `public/js/pages/acasa.js` — card „Integrare depășită (Art. 43.3)” pentru MANAGERS.
- `public/js/pages/admin.js` — câmp link invitație per grup WhatsApp.

## Fișiere

`src/db/migrations/007_onboarding_chat.sql`, `src/services/onboarding.js`, `src/services/chat.js`,
`src/routes/onboarding.js`, `src/routes/chat.js`, `src/ai/tools-onboarding.js`, `src/ai/tools-chat.js`,
`public/js/pages/chat-echipa.js`, teste `app/test/onboarding*.test.js`, `app/test/chat*.test.js`.

## Deviații față de atribuire inițială (raportate)

- `src/services/wa-gateway.js`, `src/services/wa-groups.js`, `src/routes/wa-groups.js`,
  `public/js/pages/admin.js` — extinse minimal pentru `groupParticipants`/`groupInvite` (§7) și
  câmpul `invite_link` (ops update ulterior din timpul implementării), nu erau în lista mea de
  fișiere proprii dar modificarea a fost cerută explicit de coordonator.
- `src/services/documents.js` — hook de un rând (`onDocumentApproved`, lazy require) în `review()`,
  conform permisiunii „doar dacă e strict necesar, raportează" din design-phase2.md §1.
- `server.js`, `public/js/app.js` — doar punctele marcate (montare rute, intrarea de navigare).
- `public/css/style.css` — adăugări minime, clase noi, fără a atinge stiluri existente.
