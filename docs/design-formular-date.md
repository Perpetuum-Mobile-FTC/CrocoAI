# CrocoAI — Formular de date + cont (design)

Decizii Luca (2026-10-02): formular pentru **ambele** fluxuri; contul pentru înscrierile publice se creează
**după aprobare** (Art. 14.2); credențialele se trimit pe **WhatsApp**. Regula de aur rămâne (`docs/design-v2.md`):
câmpurile, validările și permisiunile sunt definite O SINGURĂ DATĂ în domain și folosite de formular, de editarea
din Admin/Membri și de agentul AI.

## 1. Schema unică de profil — `src/domain/profile.js` (nou)
Câmpuri (etichete RO, validare, obligativitate):
- Persoană: `first_name`* + `last_name`* (2026-10-22, `domain/name.js`; `full_name` = „Prenume Nume”; un `full_name` singur de la clienți vechi e acceptat, doar cu majusculele normalizate), `phone`* (normalizat cu `domain/phone`, unic), `email`* (format valid),
  `birthdate`* (dd.mm.yyyy sau ISO; vârstă 10–25 plauzibilă), `class`* (ex. „a IX-a B”), `school`*, `department`* (`tehnic|non-tehnic|ambele`).
- Părinte/tutore — **obligatoriu dacă minor** (`rules.isMinor`): `guardian_name`*, `guardian_relation`* (mamă/tată/tutore/altul),
  `guardian_phone`*, `guardian_email` (opțional). Se salvează în `guardians`.
- Doar înscriere publică: `motivation`* (≤ 1000 caractere, „De ce vrei să intri în echipă?”), `source` (opțional, „Cum ai aflat de noi?”).
- Consimțăminte: `gdpr_ack`* („Am citit informarea privind prelucrarea datelor”), iar pentru minori `guardian_ack`*
  („Părintele/tutorele meu a citit informarea și este de acord”). Se stochează cu dată/oră (audit). NU înlocuiesc documentele
  semnate (Anexa 5/6/13 rămân obligatorii — formularul o spune explicit și arată lista din `documents.requiredFor`).
Export: `validateProfile(input, { mode: "public"|"completion"|"admin" })` → `{ ok, errors: {field: mesaj RO}, value }`.
`members.update` (Admin) folosește aceeași validare pentru câmpurile comune.

## 2. Flux A — înscriere publică `/inscriere` (fără login)
- Pagină publică (fără nav-ul aplicației, același look), legată din login („Vrei să intri în echipă? Înscrie-te”) — înlocuiește
  formularul din Art. 14.1. Afișează informarea GDPR (`app/knowledge/informare-date.md`, servită prin API).
- Anti-abuz: honeypot ascuns, limită 3 trimiteri/oră/IP + 5/zi/IP, un telefon nu poate avea două cereri `in_asteptare`,
  telefonul existent ca membru → mesaj „ai deja cont, intră în platformă”. Fără niciun mesaj WhatsApp la trimitere.
- `applications` (migrație `008_applications_completion.sql`): toate câmpurile + `status in_asteptare|acceptata|respinsa`,
  `decided_by/at`, `decision_note`, `ip_hash`, `created_at`. Notificare în platformă pentru LEADERS + linie pe Acasă.
- Revizuire: Membri → tab „Cereri” (LEADERS: `onboarding.start`): detalii, Acceptă / Respinge (cu notă).
  **Acceptă** = creează membrul `volunteer` cu toate datele + părinte, parolă temporară (`must_change_password`),
  trimite pe WhatsApp: bun venit + utilizator + parolă + link platformă + lista documentelor de semnat (text din `rules.documentGuidance`),
  pornește integrarea (`services/onboarding`) **fără** dialogul WhatsApp de colectare (datele există deja) — doar checklist-ul Art. 47.2,
  cu `platforma` bifat la primul login, notifică Șeful de Departament. **Respinge** = mesaj WhatsApp politicos opțional (bifă).
- Telefonul se verifică la acceptare prin gateway `GET /resolve/:number` (există) — dacă nu e pe WhatsApp, acceptarea creează contul
  dar avertizează liderul să trimită credențialele altfel (le afișează o singură dată).

## 3. Flux B — completare date pentru membri existenți `/completare/:token`
- LEADERS: în Membri, „Trimite link de completare” (individual sau „toți cu date lipsă”) → token aleator (32 bytes, hash stocat),
  valabil 14 zile, un membru, folosibil până la trimitere. Mesaj WhatsApp cu link-ul, **coadă cu pauză 20 s între mesaje**
  (număr partajat — risc de blocare). Membri fără telefon → link afișat liderului ca să-l trimită manual.
- Formularul e precompletat cu ce știm; după trimitere se actualizează profilul + părinții (aceeași validare).
  Dacă membrul nu s-a logat niciodată (`must_change_password=1` și fără login) → parolă temporară nouă + utilizator trimise pe WhatsApp.
  Dacă are deja parolă proprie → doar confirmare „Datele au fost actualizate” (nu se resetează nimic).
- `completion_tokens` în aceeași migrație 008. „Date lipsă” pe profil = calculat de `profile.missingFields(member)` — același cod
  pentru badge-ul din Membri, Acasă (pentru lideri: „N membri cu date incomplete”) și agent.

## 4. Agent AI
- Tool `datele_mele_lipsa` (fiecare: ce câmpuri lipsesc din profil + cum le completează), pentru LEADERS `membri_date_incomplete`;
  `cereri_inscriere` (LEADERS: câte cereri așteaptă). În `ai/tools-registration.js`, înregistrat în `tools.js`.
- Comandă deterministă `date` / `profil` → câmpurile lipsă (fără LLM).

## 5. Informare GDPR — `app/knowledge/informare-date.md` (ciornă, **de verificat de Luca**)
Operator: echipa FTC Perpetuum Mobile (contact Team Leader); ce date (cele din formular + documentele încărcate + prezență);
scop (organizarea activității echipei, comunicare, participare la competiții FTC, siguranță — Art. 62); temei (consimțământ, iar
pentru minori al părintelui); cine are acces (conform permisiunilor: date de contact doar conducere + mentori; fișa medicală doar TL);
unde se stochează (server propriu, backup criptat); cât timp (Art. 53.2 — ex. 3 ani după ieșire pentru Anexa 5; restul la cerere);
drepturi (acces, rectificare, ștergere, retragerea consimțământului — Art. 63.3 pentru foto) și cum se exercită (Team Leader).
Marcaj clar în fișier: „CIORNĂ — de verificat înainte de publicare”, versiune + dată afișate pe formular.
