# CrocoAI — Faza 2 (design)

Extinde v2 (`docs/design-v2.md` rămâne sursa de adevăr pentru tot ce nu e aici). **Aceeași regulă de aur:**
platforma și agentul AI nu au logică proprie — totul trece prin `app/src/services/*` cu `actor`,
permisiunile DOAR în `src/domain/policy.js`, regulile DOAR în `src/domain/rules.js` (cu articol).
Permisiunile și regulile Fazei 2 sunt **deja adăugate** (vezi §2, §3) — se folosesc, nu se redefinesc.

Decizii Luca (2026-10-02): toate 4 module; cont Google **dedicat echipei** (token OAuth propriu, se obține separat —
codul trebuie să meargă și fără el); transcriere **Groq Whisper** cu cheia `GROQ_API_KEY`.

## 1. Module și proprietari (agenți paraleli, worktree-uri separate)

| Modul | Agent | Migrație | Fișiere proprii |
|---|---|---|---|
| Ședințe + proces-verbal | C1 | `005_meetings.sql` | `services/meetings.js`, `services/transcription.js`, `services/google-meet.js`, `routes/meetings.js`, `ai/tools-meetings.js`, `public/js/pages/sedinte.js`, `docs/api-phase2-meetings.md`, Dockerfile (ffmpeg) |
| Poze cu consimțământ | C2 | `006_photos.sql` | `services/photos.js`, `services/wa-media.js`, `routes/photos.js`, `ai/tools-photos.js`, `public/js/pages/poze.js`, `docs/api-phase2-photos.md` |
| Onboarding WhatsApp + ~~chat echipă~~ (chat eliminat în pachet B, `docs/design-pachet-b.md`) | C3 | `007_onboarding_chat.sql` | `services/onboarding.js`, `routes/onboarding.js`, `ai/tools-onboarding.js`, `docs/api-phase2-onboarding-chat.md` |

Fișiere comune — **modificări minime, doar punctele marcate**: `server.js` (montare rută), `public/js/app.js`
(intrarea de navigare a modulului tău înlocuiește placeholder-ul „În curând”), `routes/wa-incoming.js` (C2: hook media;
C3: hook onboarding), `services/members.js`/`documents.js` (doar dacă e strict necesar, raportează).
Nu atinge `policy.js`/`rules.js` (dacă lipsește ceva, adaugă minim și raportează). Teste în fișiere proprii
`test/<modul>*.test.js`, inclusiv paritate tool AI ↔ rută (ca `ai-consistency.test.js`).

## 2. Permisiuni (deja în `policy.js`)
`meetings.manage` MANAGERS · `meetings.approve` LEADERS · `meetings.view_drafts` OVERSIGHT · `meetings.view_final` activi/pauză/alumni (Art. 53.3)
`photos.view` activi/pauză/alumni · `photos.upload` activi · `photos.tag_any` MANAGERS (uploaderul își etichetează pozele) ·
`photos.delete_any` LEADERS (uploaderul își șterge pozele) · `photos.publish` LEADERS (Art. 63.5)
`onboarding.start` LEADERS · `onboarding.manage` MANAGERS (Art. 47.1) · `wa_groups.manage_participants` LEADERS
~~`chat.use` · `chat.announce` · `chat.moderate`~~ — eliminate în pachet B; anunțurile: `announcements.publish/view/delete` (`docs/design-pachet-b.md`)

## 3. Reguli (deja în `rules.js`)
`MINUTES_RETENTION_SEASONS`=3 + `minutesRetentionUntil()` (Art. 53.2) · `MAJOR_DECISION_NOTICE_DAYS`=3 (Art. 51.3) ·
`BUDDY_SESSIONS`=3, `ONBOARDING_CHECK_DAYS`=30, `ONBOARDING_STEPS` (Art. 47.2–47.3) · `photoPublication(consents)` (Art. 63, 49.4).

## 4. Ședințe + proces-verbal (C1)
- Ședința = sesiunea de prezență existentă (`attendance_sessions`) + `meetings` (1:1): agendă (puncte), link Meet, audio, transcript, PV.
- **Link Meet:** dacă există `GOOGLE_CLIENT_ID/SECRET` + `GOOGLE_TEAM_REFRESH_TOKEN` → eveniment Calendar cu `conferenceData` (scope `calendar.events`); altfel câmp manual. Niciodată blocant.
- **Audio → transcript:** upload (≤ 300 MB; mp3/m4a/wav/webm/ogg) → ffmpeg (mono, 16 kHz, segmente ~10 min) → Groq `whisper-large-v3`, `language=ro`; job în fundal cu status; fără cheie → mesaj clar, PV manual.
- **Ciornă PV (Anexa 7)** generată cu un singur apel AI (Agent SDK, fără tool-uri, aceeași izolare ca `ai/agent.js`, înregistrat în `ai_usage`) din: transcript + agendă + **prezențele reale din sesiune** (niciodată din transcript) + ședința următoare din calendar. Structura exactă Anexa 7: prezențe, ordine de zi, discuții și decizii per punct (cu flag **decizie majoră** Art. 51.2/51.4), anunțuri, acțiuni (acțiune/responsabil/termen), ședința următoare, redactat de / verificat de TL.
- Editare ciornă (MANAGERS) → **aprobare** (LEADERS) = PV final imuabil (versiune + `approved_by/at`), vizibil membrilor (Art. 53.3); acțiunile devin taskuri (prin `services/tasks`) la aprobare; export HTML printabil cu layout Anexa 7; retenție afișată (`minutesRetentionUntil`).
- Tool-uri AI: `ultimul_proces_verbal`, `cauta_procese_verbale(text)`, `deciziile_sedintei(data)` — doar PV aprobate (sau ciorne pentru OVERSIGHT).

## 5. Poze cu consimțământ (C2)
- Stocare pe platformă (Art. 63.5): `/app/data/photos/<yyyy>/<mm>/<uuid>.<ext>` + thumbnail (sharp; HEIC fără thumbnail e OK). Albume: pe eveniment/sesiune sau pe lună.
- Upload din platformă (multi, ≤ 25 MB/fișier, imagini + video scurt) și **automat din grupurile WhatsApp urmărite** (vezi §7: `want_media`).
- Etichetare membri pe poză. Starea de publicare = `rules.photoPublication()` calculată din documentul `anexa13_foto_video` al fiecărui etichetat (aprobat și neretras). **Retragere acord** (Art. 63.3): membrul o face din profil/Documente → toate pozele lui devin nepublicabile (de acum înainte).
- Galeria e internă (membri activi). „Publicabil/Aprobat pentru social media” = LEADERS, permis doar dacă `publishable`. Descărcare originală pentru LEADERS; ceilalți văd în platformă.
- Interzis: fotografii etichetate „context privat” (Art. 63.4) — flag de raportare către TL.
- Tool-uri AI: `pozele_mele`, `acordul_meu_foto` (status + articol), pentru LEADERS `poze_nepublicabile`.

## 6. Onboarding WhatsApp + chat echipă (C3)
- **Onboarding** (Art. 14, 47): LEADERS pornesc din platformă (nume, telefon, departament, buddy opțional) → membru `volunteer` cu onboarding activ → botul trimite mesaj de bun venit și conduce un **dialog determinist, fără LLM** (lecția v1): nume complet → clasă → școală → email (validare) → data nașterii → departament → confirmare. La final: username + parolă temporară, lista documentelor de semnat (din `documents.requiredFor`), adăugare în grupurile urmărite (gateway `POST /group/participants`; dacă WhatsApp refuză din cauza confidențialității → trimite link de invitație `GET /group/:id/invite`), notificare Șef Departament + buddy.
- Checklist Art. 47.2 (`ONBOARDING_STEPS`) pe profil (tab nou), bifat de MANAGERS (unele automat: platformă, grup, documente); semnal la 30 de zile dacă nu e complet (Art. 47.3) pe Acasă pentru MANAGERS și în răspunsurile agentului.
- `wa-incoming`: dacă expeditorul are onboarding activ → mesajul merge la `services/onboarding.handleReply` ÎNAINTE de agent (hook marcat).
- **[ELIMINAT în pachet B, 2026-10-16 — înlocuit de Anunțuri, `docs/design-pachet-b.md`]** **Chat echipă** (`/chat-echipa`): conversații 1-la-1 și de grup între membri activi + canal **Anunțuri** (doar `chat.announce` scrie; opțional oglindit în `TEAM_GROUP_ID` pe WhatsApp). Polling 5 s cât pagina e vizibilă (fără websocket). Necitite în badge. Raportare mesaj → coadă de moderare LEADERS (Art. 24). DM-urile nu sunt vizibile altora.
- Tool-uri AI: `stare_onboarding` (pentru MANAGERS: cine e în onboarding și ce lipsește), `anunturi_recente` (din pachet B citește `announcements`, nu chat-ul).

## 7. Contract gateway WhatsApp (implementat de Luca/ops în `moldfix-wa`, nu de agenți)
- `POST /wa/incoming` primește în plus: `hasMedia` (bool), `mediaType` (`image|video|audio|document|sticker`), `caption`.
  Mesajele doar-media (fără text) ajung acum și ele. Răspunsul CrocoAI poate conține `want_media: true`.
- Dacă `want_media` → gateway descarcă media și face `POST /wa/media` pe CrocoAI (header `x-wa-secret`):
  `{ msgId, from, groupId, mediaType, mimetype, filename, caption, data /* base64 */ }`, max 25 MB.
- `POST /group/participants` `{ groupId, phone, action: "add"|"remove" }` → `{ ok, code, message }` (code 200/403/404/408/409 ca în WA).
- `GET /group/:groupId/invite` → `{ link }`.
- Client în CrocoAI: extinde `services/wa-gateway.js` cu `groupParticipants()` și `groupInvite()` (C3).

## 8. Operare (ops)
`.env` nou: `GROQ_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TEAM_REFRESH_TOKEN` (opțional).
Backup: `app/data/photos` și `app/data/meetings` (audio) incluse în sync-ul criptat. Audio-ul brut se poate șterge după
aprobarea PV (configurabil, implicit păstrat 1 sezon).
