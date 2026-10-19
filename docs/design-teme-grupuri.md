# CrocoAI — Teme și grupuri (design)

Extinde v2 + Faza 2 (`docs/design-v2.md`, `docs/design-phase2.md` rămân sursa de adevăr pentru tot ce nu e aici).
**Aceeași regulă de aur:** platforma și agentul AI nu au logică proprie — totul trece prin `app/src/services/*`
cu `actor`, permisiunile DOAR în `src/domain/policy.js`.

Decizii Luca (2026-10-11):
- Mod temă **la alegere per temă**: `individual` (fiecare membru predă a lui) sau `grup` (sarcină comună, un to-do).
- Grupuri **pe departament**; TL/co-leader fac grupuri cu oricine; managerii pot numi un **lider de grup**
  care dă teme doar grupului lui.
- Predare → verificare **„acceptat” / „de refăcut” + comentariu**, re-încărcare cu istoric de versiuni. Fără note.
- WhatsApp: **notificări + interogări** („ce teme am?”). Predarea fișierelor doar pe platformă.
- **Mentorii pot da teme** (ca TL: oricărui departament/grup) și verifică temele date de ei.
- Abordare: **modul nou** (tabele proprii); `tasks` rămâne neatins.

## 1. Model de date — migrația `011_assignments.sql`

### 1.1 Grupuri (extindem `teams` / `team_members`)
```sql
ALTER TABLE teams ADD COLUMN department TEXT NOT NULL DEFAULT 'mixt'; -- tehnic | non-tehnic | mixt
ALTER TABLE teams ADD COLUMN created_by INTEGER REFERENCES members(id);
-- team_members.role = 'leader' există deja → „lider de grup”
```
Grupurile existente (0 în prod la 2026-10-11) devin `mixt`.

### 1.2 Teme
```sql
CREATE TABLE assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  due_at TEXT,                                   -- ISO, opțional
  mode TEXT NOT NULL,                            -- individual | grup
  target_type TEXT NOT NULL,                     -- departament | grup
  target_dept TEXT,                              -- tehnic | non-tehnic (target_type=departament)
  target_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL, -- target_type=grup
  target_label TEXT NOT NULL,                    -- „Departament Tehnic” / numele grupului (rămâne și dacă grupul e șters)
  created_by INTEGER NOT NULL REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'activa',         -- activa | inchisa
  reminded_due INTEGER NOT NULL DEFAULT 0,
  summarized_due INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- mode='grup' cere target_type='grup' (un departament întreg nu e „grup de lucru”).

CREATE TABLE assignment_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE assignment_todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id),      -- NULL pentru mode='grup'
  status TEXT NOT NULL DEFAULT 'de_facut',       -- de_facut | predat | de_refacut | acceptat
  current_version INTEGER NOT NULL DEFAULT 0,
  submitted_by INTEGER REFERENCES members(id),
  submitted_at TEXT,
  reviewed_by INTEGER REFERENCES members(id),
  review_comment TEXT,
  reviewed_at TEXT,
  UNIQUE (assignment_id, member_id)
);

CREATE TABLE submission_todos (
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  todo_id INTEGER NOT NULL REFERENCES assignment_todos(id) ON DELETE CASCADE,
  done INTEGER NOT NULL DEFAULT 0,
  done_by INTEGER REFERENCES members(id),
  done_at TEXT,
  assignee_member_id INTEGER REFERENCES members(id), -- doar la mode='grup', opțional
  PRIMARY KEY (submission_id, todo_id)
);

CREATE TABLE submission_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,                      -- = current_version+1 până la „Predau”, apoi înghețat
  filename TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

### 1.3 Fișiere
Pe disc în `app/data/assignments/<assignment_id>/{materials,submissions/<submission_id>}/`, nume generat
(`<uuid>.<ext>`), numele original în DB. Limită **25 MB/fișier**, max 10 fișiere per upload. Servite **doar prin
endpoint cu verificare de drept** (fără static). Intră în backup-ul criptat existent (`data/`).

### 1.4 Destinatari
La creare, pentru `mode='individual'`: câte un `submission` per membru cu `status='activ'` din destinație —
departament: doar rolurile `member`/`volunteer` cu `department = target_dept OR department = 'ambele'` (liderii,
șefii și mentorii au de obicei `ambele`, dar ei dau teme, nu primesc); grup: toți membrii din `team_members`,
indiferent de rol. Creatorul nu primește niciodată propria temă.
Pentru `mode='grup'`: un singur `submission` (`member_id NULL`). Lista e **înghețată**; acțiunea
„Adaugă membrii noi” (cine poate edita tema) creează submission-urile lipsă.

## 2. Permisiuni (adăugate în `policy.js`)

Notații: LEADERS = team_leader, co_leader; HEADS = head_tech (→ `tehnic`), head_nontech (→ `non-tehnic`);
GLOBAL = LEADERS + mentor; `groupLeader(actor, team)` = `team_members.role='leader'` pentru actor.

| Acțiune | Cine |
|---|---|
| `groups.view` | GLOBAL + HEADS: toate; ceilalți: grupurile din care fac parte |
| `groups.manage` (creare/editare/ștergere, membri, lider) | GLOBAL: orice grup, orice membri (`mixt` permis). HEAD: doar `teams.department` = departamentul lui, membri doar din acel departament sau `ambele` |
| `assignments.create` | GLOBAL: orice destinație. HEAD: departamentul lui + grupurile din departamentul lui. Lider de grup: doar grupul lui |
| `assignments.edit` / `close` / `delete` / `add-new-members` (`assignments.manage`) | creatorul + LEADERS + HEAD-ul departamentului temei; `delete` doar dacă nicio predare nu e `predat`+ |
| `assignments.review` | = `assignments.manage` (creatorul + LEADERS + HEAD-ul departamentului temei) |
| `assignments.view` (predări, fișiere, materiale, progres, lista „all”) | destinatarii, creatorul, LEADERS + mentor (tot); HEAD: departamentul lui + grupurile `mixt` (ambii șefi) |
| `submissions.work` (bife, upload, predare) | individual: titularul; grup: orice membru curent al grupului; doar cât tema e `activa` |

Toate în `CHECKS` cu `target` (tema / grupul), cu teste de matrice.

**Șefii de departament = TL pe departamentul lor** (decizie 2026-10-13). Departamentul unei teme (`assignmentDept` în
`services/assignments.js`, singurul helper): `target_dept`, altfel `teams.department` al grupului (`mixt` pentru grupuri
mixte). În `policy.js`: `headOf(actor, dept)` = șef activ al lui `dept`; `headSees(actor, dept)` = `headOf` sau (`dept` =
`mixt` și actorul e un șef activ). `manage`/`review` folosesc `headOf`, vizualizarea `headSees` — pe grupurile mixte ambii
șefi văd tot, dar acționează doar ca creator / TL / co-leader. Flag-urile `can_manage` / `can_review` din răspunsuri vin
din aceleași reguli. Grupurile mixte sunt vizibile ambilor șefi prin `groups.view_all` (editare doar GLOBAL).

## 3. Fluxuri

**Creare:** titlu, descriere, termen, mod, destinație (doar cele permise apar în UI), materiale, to-do →
tranzacție: `assignments` + `assignment_todos` + `submissions` + `submission_todos` → notificare „temă nouă”.

**Lucru:** bife pe `submission_todos`; upload în versiunea curentă (`current_version+1`); la grup, to-do-ul poate
primi `assignee_member_id` → notificare. **„Predau”** (cere ≥1 fișier SAU toate bifele făcute): `status='predat'`,
`current_version++`, `submitted_by/at`. Din `de_refacut` → „Predau” din nou → versiune nouă. După termen:
permis, marcat „întârziat” (`submitted_at > due_at`), afișat ca atare.

**Verificare:** doar pe `predat`. „Acceptat” sau „De refăcut” + comentariu (obligatoriu la „De refăcut”) →
notificare membrului / grupului. Versiunile vechi rămân vizibile (read-only).

**Închidere:** `status='inchisa'` → fără bife/upload/predare; rămâne vizibilă în arhivă.
**Ștergere:** doar fără predări; șterge și fișierele de pe disc.

**Remindere** (în `reminder-scheduler.js` existent):
- `due_at - 24h`: către submission-urile `de_facut`/`de_refacut` (o dată, `reminded_due`).
- `due_at` trecut: rezumat către creator „X din Y n-au predat” (o dată, `summarized_due`).

**Cazuri limită:** membru scos din grup → submission-ul lui individual rămâne al lui; la grup, își pierde accesul de
lucru. Grup șters → tema rămâne (`target_team_id NULL`, `target_label` păstrat). Membru trecut în `pauza`/`alumni`
→ submission-ul rămâne, fără remindere. Fișier > 25 MB → `INVALID` „Fișier prea mare (max 25 MB).”

## 4. API (`docs/api-teme-grupuri.md`)

```
GET    /api/groups                     POST /api/groups
GET    /api/groups/:id                 PATCH/DELETE /api/groups/:id
PUT    /api/groups/:id/members         { members:[{member_id, role}] }

GET    /api/assignments?scope=mine|given|all&status=activa|inchisa
POST   /api/assignments                (multipart: câmpuri + materials[])
GET    /api/assignments/:id            (+ submission-ul meu / lista de predări pentru verificator)
PATCH  /api/assignments/:id            POST /:id/close   DELETE /:id
POST   /api/assignments/:id/add-new-members
GET    /api/assignments/:id/materials/:fileId

PATCH  /api/submissions/:id/todos/:todoId     { done, assignee_member_id? }
POST   /api/submissions/:id/files             (multipart)
DELETE /api/submissions/:id/files/:fileId     (doar din versiunea încă nepredată)
POST   /api/submissions/:id/submit
POST   /api/submissions/:id/review            { decision: acceptat|de_refacut, comment }
GET    /api/submissions/:id/files/:fileId
```

## 5. Interfață (SPA, `public/js/pages/`)

- **`teme.js` — „Teme”** (meniu): tab-uri „De făcut” (termen roșu dacă a trecut), „Arhivă”; pentru cine poate da
  teme și „Date de mine” (progres 5/8) + „+ Temă nouă”.
- **Pagina temei:** descriere + materiale; to-do cu bife (la grup: cui e asignat), drag & drop upload, „Predau”,
  istoric versiuni + comentarii; tab „Predări” pentru verificator (tabel status → fișiere → Acceptat/De refăcut).
- **`grupuri.js` — „Grupuri”:** creare/editare, adăugare membri filtrați pe departament, marcare lider de grup.
- **Acasă:** card „Teme cu termen apropiat”. **Taskuri:** to-do-urile asignate mie în teme de grup, cu numele temei
  (read-only acolo, link spre temă).

## 6. WhatsApp + agent

Notificări prin `notifications` + `wa-queue` existente (cu întârziere): temă nouă (link), to-do asignat,
rezultat verificare, reminder 24h, rezumat la termen. **Nu** se trimit pe grupul echipei — doar DM-uri individuale
prin coadă.

Tool-uri noi `src/ai/tools-assignments.js` (aceleași servicii + `policy.can`):
- `list_my_assignments` — teme active ale mele, cu termen și status.
- `get_assignment` — detalii, to-do-ul meu, status, comentariul ultimei verificări.
- `assignment_status` — doar pentru cine poate verifica: cine n-a predat / ce e de verificat.
Fără tool-uri de scriere în această etapă.

## 7. Testare

- `test/assignments.test.js` — creare individual/grup + destinatari (inclusiv `ambele`, `pauza`), ciclu
  predat → de refăcut → v2 → acceptat, întârziere, închidere, ștergere blocată.
- `test/assignments-policy.test.js` — matricea §2 (head_tech → non-tehnic refuzat, lider de grup → alt grup refuzat,
  mentor → oriunde permis, membru → creare refuzată).
- `test/groups.test.js` — restricții pe departament, lider de grup.
- `test/assignments-routes.test.js` — upload/descărcare cu drepturi, limită 25 MB.
- `test/assignments-ai-consistency.test.js` — tool-urile AI văd exact ce vede ruta.
- E2E pe prod cu 3 conturi de test (head_tech, membru, lider de grup), șterse după.

## 8. Livrare

O migrație (`011`), backup automat pre-migrare (`VACUUM INTO`), deploy obișnuit pe Junioru
(`git pull && docker compose up -d --build`). Rollback: backup pre-migrare + commit anterior.
