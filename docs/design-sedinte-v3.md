# CrocoAI — Ședințe v3: destinatari, prezență cu cod QR (design, aprobat de Luca 2026-10-12)

Extinde `docs/design-sedinte-v2.md`. Regula de aur: permisiuni doar în `src/domain/policy.js`, logică în servicii.

## 1. Destinatari („Pentru”)
- La programare: Toată echipa / Departament Tehnic / Departament Non-Tehnic / un grup (teams).
- Permisiuni (politica „ca la teme”): TL, co-leader, mentori → orice; șef de departament → departamentul lui și grupurile
  din departamentul lui; lider de grup (★) → doar grupul lui. „Toată echipa” → TL, co-leader, mentori și șefii de departament
  (ca înainte). Modificare/anulare: aceeași regulă pe destinatarul ședinței + creatorul ei.
- Stocare: `attendance_sessions.team_id` (există) pentru grup; coloană nouă `target_dept` pentru departament.
- Cei chemați (o singură regulă: `invitedMemberIds(session)` în `services/attendance.js`; decizie 2026-10-12 — TL,
  co-leader și mentorii au `department = ambele`): departament d → membri activi cu rol `member`/`volunteer` și
  `department` = d sau `ambele`, plus șeful departamentului d; grup → membrii activi ai grupului (orice rol);
  toată echipa → toți membrii activi, mai puțin rolurile `mentor` și `alumni`. Oricine altcineva scanează = participant extra.
- Anunț: tot pe grupul de Anunțuri (`TEAM_GROUP_ID`), cu destinatarul în text („📅 Ședință Departament Tehnic — …”);
  notificare în platformă doar pentru cei chemați.

## 2. Prezență cu cod QR
- Pe pagina ședinței, organizatorul apasă „Prezență cu cod QR” → afișare mare (ecran întreg) a unui cod QR.
- Codul QR conține un link `https://<app>/p/<token>`; tokenul **se schimbă la fiecare 30 s** (HMAC peste meeting_id +
  fereastra de timp, secret din env/JWT_SECRET; acceptat și tokenul din fereastra anterioară, pentru scanări la limită).
- Valabil **doar în timpul ședinței**: de la 15 min înainte de oră până la sfârșit (ora + durata) sau până la „Închide prezența”.
- Scanare: membrul deschide linkul pe telefon → dacă nu e logat, login și revenire automată → „✅ Prezent la <ședință>”.
  Oricine are cont activ poate scana — cei din afara destinatarilor apar ca **participant extra**.
- Organizatorul — cine conduce prezența (deschide codul QR sau o închide) — e marcat automat prezent (extra dacă nu e chemat).
- Lista de pe pagina ședinței se actualizează automat (polling ~5 s) și permite marcare manuală P / A / M (fără telefon);
  cineva din afara destinatarilor poate fi marcat doar P (extra).
- „Închide prezența” (doar după începerea ședinței): toți chemații fără marcaj → A; cei cu absență aprobată pentru acea dată → M; codul QR nu mai merge.
  Se poate redeschide de organizator (greșeli).
- Statistici: ședința contează doar pentru cei chemați; participanții extra primesc doar „prezent” (nu le scade procentul).

## 3. Vizibilitate
- Secțiunea Ședințe (lista, pagina ședinței, înregistrare, PV, situația prezenței) e vizibilă doar pentru TL, co-leader,
  șefi de departament și mentori (+ liderii de grup pentru ședințele grupului lor).
- Membrii văd pe Acasă un card „Ședințele tale viitoare” (doar cele la care sunt chemați: dată, oră, loc, ordinea de zi)
  și primesc anunțul; pagina de scanare (`/p/<token>`) e accesibilă oricărui membru logat.
- PV-urile aprobate rămân consultabile de membri prin botul AI (ca acum).

## 3.1 Drepturi șef de departament (decizie 2026-10-13)
- Departamentul unei ședințe (`audience.ofSession(...).dept` în `services/meeting-audience.js`; pentru prezența legacy
  `sessionDept` în `services/attendance.js`): `target_dept`, altfel `teams.department` al grupului (`mixt` pentru grupuri
  mixte); ședințele pentru toată echipa n-au departament.
- Șeful departamentului (`headOf` în `policy.js`) poate tot ce poate TL pe ședințele departamentului lui și ale grupurilor
  lui: programare / modificare / anulare / prezență (regula de programare), înregistrare, audio, transcriere, ciornă PV
  (`meetings.manage`, deja MANAGERS) și **aprobarea PV** (`meetings.approve` cu target `{ dept }`).
- Grupuri mixte: ambii șefi văd tot (ciorne, prezență — sunt OVERSIGHT), dar nu aprobă și nu organizează decât ca creator.
- Toată echipa: neschimbat — șefii au drepturile MANAGERS, fără aprobare (doar LEADERS).
- UI: butonul „Aprobă PV” apare din `can_approve` (răspunsul `GET /api/meetings/:id`), nu din rol; ciorna și linkul Meet
  din `can_manage`.

## 4. Pagina ședinței (ordine)
Detalii → Ordinea de zi → **Prezență** (cod QR, lista chemați + extra, marcare manuală, Închide prezența) →
**Înregistrare** (live sau încarcă fișier) → Proces-verbal.

## 5. Teste
Permisiuni pe destinatari (fiecare rol), lista chemaților, tokenul QR (valid în fereastră, respins expirat/înainte/după
ședință/după închidere, fereastra anterioară acceptată), scanare: chemat → P, extra → P extra, scanare dublă idempotentă,
organizator auto-P, închidere → A/M corecte, redeschidere, statistici (extra nu afectează procentul), anunț cu destinatarul,
notificări doar chemaților, membri fără acces la secțiunea Ședințe dar cu acces la scanare.
