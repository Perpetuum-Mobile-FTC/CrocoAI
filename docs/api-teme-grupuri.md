# CrocoAI — Teme și grupuri (API)

Owner: `src/services/groups.js`, `src/services/assignments.js`, `src/services/submissions.js` (+ `assignment-files.js`, `assignment-notify.js`), `src/routes/groups.js`, `src/routes/assignments.js`, `src/routes/submissions.js`, `src/ai/tools-assignments.js`, `public/js/pages/teme.js`, `public/js/pages/grupuri.js`. Design: `docs/design-teme-grupuri.md`. Permisiuni: `src/domain/policy.js` `groups.*`, `assignments.*`, `submissions.*`. Reguli: `src/domain/rules.js` (dacă e necesar).

Toate endpoint-urile de mai jos necesită cookie-ul `crocoai_token` (`requireAuth`), la fel ca restul API-ului v2. Erorile sunt `DomainError` → `{error, article?, code}` (design-v2 §1).

---

## Grupuri — `/api/groups`

Departamente: `tehnic`, `non-tehnic`, `mixt`. Lideri de grup: membri cu `role='leader'` în `team_members`.

### GET /
`groups.view` (GLOBAL + HEADS → toate; alții → doar din care fac parte). `[{id, name, description, department, created_by, members: [{id, name, department, role}], can_manage}]`.

### GET /departments
Departamentele în care cel care întreabă poate crea un grup (`groups.manage` per departament; butonul „+ Grup nou” din UI).
Răspuns: `{departments: ["tehnic", "non-tehnic", "mixt"]}` (TL/co-leader/mentori activi), `["tehnic"]` (șef tehnic), `[]` (ceilalți).

### POST /
`groups.manage`. Body: `{name, description?, department?}`. Răspuns: `Group`.

### GET /:id
`groups.view` + membru. Răspuns: `Group`.

### PATCH /:id
`groups.manage`. Body: `{name?, description?, department?}`. Răspuns: `Group`.

### DELETE /:id
`groups.manage`. Răspuns: `{ok: true}`.

### PUT /:id/members
`groups.manage`. Body: `{members: [{member_id, role: "leader"|"member"}]}`. Răspuns: `Group`.

---

## Teme — `/api/assignments`

Mode: `individual` (fiecare membru predă a lui) | `grup` (sarcină comună, un to-do). Target: `departament` (`tehnic`/`non-tehnic`) | `grup`.

### GET /targets
`assignments.create` (verificare permisiuni). Răspuns: `{departments: [string], groups: [{id, name, department}]}`.

### GET /my-todos
Nicio permisiune (utilizatorul curent). Toate punctele de to-do asignate mie în teme de grup active. Răspuns: `[{submission_id, todo_id, text, assignment_id, assignment_title, due_at}]`.

### GET /
`assignments.view` (implicit prin destinație). Query: `scope` (`mine`|`given`|`all`|`review`, def `mine`; `review` = „De verificat”: temele cu predări pe care actorul
le poate verifica, fiecare cu `waiting` — aceeași listă ca rândul „predări de verificat” de pe Acasă), `status` (`activa`|`inchisa`). Răspuns: `[Summary]`.

### POST /
`assignments.create`. Multipart: `title`, `description?`, `due_at?` (ISO), `mode`, `target_type`, `target_dept?` (dacă departament), `target_team_id?` (dacă grup), `todos` (JSON string) `[string]`, `materials` (fișiere). Max **25 MB/fișier**, 10 fișiere. Răspuns: `Detail`.

### GET /:id
`assignments.view`. Răspuns: `Detail` (include `my_submission` și `submissions` dacă can_manage).

### PATCH /:id
`assignments.manage`. Body: `{title?, description?, due_at?, todos?}`. Răspuns: `Detail`.

### POST /:id/close
`assignments.manage`. Răspuns: `Detail` (status → `inchisa`).

### DELETE /:id
`assignments.manage` (doar dacă nicio predare e `predat`+). Răspuns: `{ok: true}`.

### POST /:id/add-new-members
`assignments.manage`. Adaugă noi membri (crează submissions-urile lipsă pentru mode=individual). Răspuns: `Detail`.

### GET /:id/materials/:fileId
`assignments.view`. File download.

---

## Interfață de răspuns pentru teme

**Summary**: `{id, title, due_at?, mode, target_type, target_label, target_team_id?, status, created_by, created_by_name, created_at, can_manage, my_submission?: {id, status, submitted_at?, late}, progress?: {total, de_facut, predat, de_refacut, acceptat}}`.

**Detail**: Extinde Summary cu `{description?, materials: [{id, filename, size, created_at}], todos: [{id, text, position}], my_submission?: SubmissionDetail, submissions?: [SubmissionDetail]}`.

---

## Predări — `/api/submissions`

Status: `de_facut` | `predat` | `de_refacut` | `acceptat`. Versiuni: `current_version` = ultima predare; fișierele încărcate după sunt draft (versiune `current_version+1`).

### PATCH /:id/todos/:todoId
`submissions.work`. Body: `{done?, assignee_member_id?}` (doar pentru mode=grup). Răspuns: `SubmissionDetail`.

### POST /:id/files
`submissions.work`. Multipart: `files` (1–10 fișiere). Max **25 MB/fișier**. În draft → versiunea `current_version+1`; cât e `predat` (neverificat) → se adaugă la versiunea predată; `acceptat` → refuz. Răspuns: `SubmissionDetail`.

### DELETE /:id/files/:fileId
`submissions.work` (doar din draft). Răspuns: `SubmissionDetail`.

### POST /:id/submit
`submissions.work`. Cere ≥1 fișier SAU toate bifele făcute. Răspuns: `SubmissionDetail`.

### POST /:id/unsubmit
`submissions.work`. Doar din `predat` (neverificat): versiunea predată redevine ciornă, status → `de_facut` (sau `de_refacut` dacă a mai fost verificată). Răspuns: `SubmissionDetail`.

### POST /:id/review
`assignments.manage`. Body: `{decision: "acceptat"|"de_refacut", comment?}` (obligatoriu la `de_refacut`). Răspuns: `SubmissionDetail`.

### GET /:id/files/:fileId
`submissions.work` sau `assignments.manage`. File download.

---

## Interfață de răspuns pentru predări

**SubmissionDetail**: `{id, status, member_id?, member_name?, current_version, submitted_at?, submitted_by_name?, late, review_comment?, reviewed_at?, reviewed_by_name?, todos: [{todo_id, text, done, done_at?, done_by_name?, assignee_name?}], files: [{id, version, filename, size, created_at, uploaded_by_name?}]}`.

---

## Tool-uri AI (`src/ai/tools-assignments.js`)

- `temele_mele` — Temele active primite de cel care scrie (individual/grup, departament/grup), cu termen și status.
- `detalii_tema` — Detaliile unei teme după ID: descriere, materiale, to-do-ul meu, status, comentarii de verificare.
- `status_predari_tema` — Pentru creatorul temei (LEADERS/mentori): cine n-a predat și ce e de verificat.

Teste de paritate tool ↔ rută: `app/test/assignments-ai-consistency.test.js`.

---

## Decizii / abateri

- Fișierele materiale și predări sunt servite **doar prin endpoint autorizat** (nu static), stocate în `app/data/assignments/<id>/{materials,submissions/<sub_id>}/`.
- Limitele de fișier: **25 MB/fișier**, max 10 fișiere per upload. Error: `"Fișier prea mare (max 25 MB)."`.
- Nicio nouă cheie în `policy.js` și `rules.js` — doar `groups.*`, `assignments.*`, `submissions.*` și `photoPublication()` existau din design.
- Remindere și rezumate sunt generate de `services/reminder-scheduler.js` (task async, fără endpoint).
