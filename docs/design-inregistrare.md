# CrocoAI — Înregistrare directă (design, aprobat de Luca 2026-10-11)

Înlocuiește, pentru formularul public `/inscriere`, fluxul „cerere → aprobare → parolă temporară pe WhatsApp”
din `docs/design-formular-date.md` §2. Regula de aur rămâne: validarea în `src/domain/profile.js`, permisiunile în
`src/domain/policy.js`, logica în servicii.

Decizii Luca (2026-10-11):
- Un singur link pentru toată echipa (recruți, membri vechi, șefi, TL, co-leader, mentori). **Contul e activ imediat**,
  cu username + parolă alese de ei; după trimitere sunt logați direct.
- Rolurile de conducere (șef tehnic, șef non-tehnic, co-leader, TL, mentor) **nu** se aplică imediat: contul intră ca
  `member` cu `requested_role`, iar TL/co-leader confirmă dintr-un click (Admin → „Cereri de rol”).
- Recrut nou → `volunteer` (Art. 10); membru vechi → `member`.
- Școala: listă „CN Mihai Eminescu” / „CN Ioan Slavici” / „Altă școală”. Mail `@eminescusm.ro` obligatoriu doar
  pentru elevii de la Eminescu; restul orice adresă validă.

## 1. Câmpuri (mode `register` în `validateProfile`)

| Câmp | Elevi (toate rolurile în afară de mentor) | Mentor |
|---|---|---|
| `role_choice` ∈ recrut, membru, head_tech, head_nontech, co_leader, team_leader, mentor | * | * |
| `full_name` (2+ cuvinte), `phone` (unic) | * | * |
| `username` `^[a-z0-9.-]{3,30}$`, unic (case-insensitive) | * | * |
| `password` ≥ 8 caractere, `password_confirm` identic | * | * |
| `email` valid, unic; `@eminescusm.ro` dacă școala = CN Mihai Eminescu | * | * (orice) |
| `school` ∈ listă; „Altă școală” → `school_other` text obligatoriu | * | — |
| `class`, `birthdate` (vârstă 10–25) | * | — |
| `department` ∈ tehnic/non-tehnic/ambele — implicit `tehnic` pt head_tech, `non-tehnic` pt head_nontech | * | — (`ambele`) |
| Părinte/tutore (ca acum) | doar minori | — |
| `motivation` ≤ 1000 | doar recruți | — |
| `gdpr_ack`, `guardian_ack` (minori) | * | `gdpr_ack` |

## 2. Flux
- **Din 2026-10-16 (pachet securitate A3, `docs/design-securitate-2026-10.md`) în doi pași:**
  1. `POST /api/public/register` (fără login): honeypot `website`, validare (+ unicitate) → numărul trebuie să fie
     pe WhatsApp (`wa-gateway.resolve`, altfel 400 „Numărul nu are WhatsApp — scrie-i unui lider.”) → rând în
     `pending_registrations` (date validate fără parolă, hash parolă, hash cod; expiră în 30 min) → cod de 6 cifre
     trimis imediat pe WhatsApp („Codul tău CrocoAI: 123456 (valabil 10 minute)”). Răspuns
     `{ ok, pending_id, phone_hint, resend_after_sec, code_ttl_min }`. Contul NU există încă.
  2. `POST /api/public/register/verify` `{ pending_id, code }`: max 5 încercări/cod, codul expiră în 10 min →
     unicitatea se reverifică → creare membru (`password_hash` bcrypt, `must_change_password=0`, `status='activ'`,
     `phone_verified_at`) + părinte + rând de audit în `applications` (`status='inregistrat'`, consimțăminte,
     `ip_hash`, `created_member_id`) → `setAuthCookie` → `{ ok, redirect: "/" }`.
  - `POST /api/public/register/resend` `{ pending_id }`: după 60 s; codul vechi nu mai e valabil, încercările se resetează.
  - Limite coduri (tabela `otp_sends`, rezervare sincronă înainte de orice `await`, eliberată dacă trimiterea
    eșuează): 3 / telefon / oră, 6 / telefon / zi, `OTP_MAX_PER_IP_HOUR` (implicit 30) / IP / oră,
    `OTP_MAX_GLOBAL_HOUR` (implicit 60) / oră în total.
  - O singură înregistrare în așteptare per telefon: un nou `/register` pentru același număr e refuzat (409) până
    expiră, cu excepția proprietarului, care trimite `pending_id` (formular corectat). Expiratele se șterg și la
    fiecare tick al `reminder-scheduler`.
    Înregistrări reușite: **30/oră + 60/zi per IP** (Wi-Fi-ul școlii); orice cerere: 300/oră per IP.
- Recruți: checklist-ul de integrare (ca la acceptare) + notificare șefilor de departament.
- Roluri de conducere: `members.requested_role`; notificare către TL/co-leader activi („X cere rolul Y”).
- Admin → „Cereri de rol” (permisiune `members.manage`): Confirmă (setează `role`/`auth_role`, golește cererea) /
  Respinge (golește cererea, rămâne `member`). Acasă (LEADERS): „N cereri de rol”.
- Fluxul vechi de aprobare rămâne în cod, dar `/inscriere` nu-l mai folosește.

## 3. Migrație `012_self_registration.sql`
`ALTER TABLE members ADD COLUMN requested_role TEXT;` (+ status `inregistrat` în `applications`, coloana e TEXT liber).
