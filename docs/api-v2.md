# CrocoAI API v2

Source of truth for Phase B (frontend rebuild + AI tool layer). Every endpoint is a thin wrapper
over `src/domain/` + `src/services/*` — permission checks happen in the service, not the route.
A `DomainError` thrown by a service becomes:

```json
{ "error": "Mesaj în română", "article": "Art. 20.1", "code": "FORBIDDEN" }
```
with HTTP status `FORBIDDEN=403`, `NOT_FOUND=404`, `INVALID=400`, `LATE=409`, `LIMIT=429`.
`article` is only present when the domain rule has one. Every `/api/*` route that doesn't match
any router returns `404 {"error":"Rută inexistentă"}` (JSON, never HTML). Any other uncaught error
returns `500 {"error":"Eroare internă de server"}`.

All endpoints below require the `crocoai_token` httpOnly cookie (`requireAuth`) unless noted.
Login accepts **username or phone** (any phone format, normalized server-side).

Roles: `team_leader`, `co_leader`, `head_tech`, `head_nontech`, `member`, `volunteer`, `mentor`,
`alumni`. Groups: `LEADERS` = team_leader+co_leader. `MANAGERS` = LEADERS+head_tech+head_nontech.
`OVERSIGHT` = MANAGERS+mentor. Full matrix: `src/domain/policy.js`.

Member statuses: `activ`, `pauza`, `iesit`, `alumni`. Login allowed for `activ`/`pauza`/`alumni`.

---

## Auth — `/api/auth`

### POST /api/auth/login
Body: `{ phone, password }` (`phone` = username or any phone format). No auth required.
200: `{ user: { id, name, role, status, must_change_password } }` (sets cookie).
401: wrong credentials or inactive/iesit account. 429: rate-limited (10/15min per IP, env
`LOGIN_RATE_LIMIT_MAX`).

### GET /api/auth/me
200: `{ id, name, role, status, must_change_password, meetings_section, permissions }`.
`permissions` is a flat map `{ "<policy action>": boolean }` for `policy.UI_ACTIONS` (actor-only checks,
status included - a paused Team Leader gets `false` everywhere). The SPA shows/hides controls only from it
(`app.can(action)`), never from role lists; the server still re-checks every action with its real target.
Per-row rights travel with the rows instead: photos (`can_tag`, `can_delete`, `can_download_original`),
documents matrix (`can_open`), tasks (`can_edit`, `can_delete`), meetings (`can_organize`, `can_manage`, `can_approve`), announcements (`can_delete`).

### POST /api/auth/logout
200: `{ ok: true }`. Bumps `token_version` (the token itself is invalid, not just the cookie - A1) and clears the cookie.

### POST /api/auth/change-password
Body: `{ new_password, current_password }` - 8-72 chars (`rules.passwordError`, same policy everywhere),
must differ from the current one. `current_password` is required unless `must_change_password=1`
(403 if wrong). Bumps `token_version` (invalidates all sessions) and clears the current cookie, forcing re-login.
200: `{ ok: true }`.

**`must_change_password=1` is enforced on the server (A1):** every authenticated route except
`GET /api/auth/me`, `POST /api/auth/change-password`, `POST /api/auth/logout` answers
403 `{ error, code: "MUST_CHANGE_PASSWORD" }` until the password is changed.

---

## Members — `/api/members*`, `/api/guardians/:id`

### GET /api/members
Directory (any authenticated user). 200: `[{ id, name, role, department, status, class, school,
team_ids: [teamId, ...] }]`.

### GET /api/members/:id
Full profile. Base fields (`id, name, first_name, last_name, username, role, department, status, pause_until, joined_at,
left_at`) always included (`first_name`/`last_name` are NULL until the name is split - `name` = full_name); `notes` only if actor has `members.manage`. Contact fields (`phone,
email, birthdate, school, class, guardians`) only if actor is OVERSIGHT or the member themself.
Also includes `attendance_stats`, `documents`, `warnings` (each omitted if actor lacks permission)
and `tasks` (tasks assigned to this member, visible to anyone who can see the profile).

### PATCH /api/members/me
„Contul meu” (2026-10-19): the logged-in member edits their own `first_name` + `last_name` (sent together, 2026-10-22),
`email`, `school`, `class` (`profile.OWN_EDITABLE`, validated by `profile.validateOwnEdit`, policy `members.edit_account`;
audit `profile.self_edit`). Partial; other keys (full_name, phone, birthdate, department, role) are ignored. 200: the profile; 400 with `errors` per field. Password: `POST /api/auth/change-password`.

### GET /api/members/:id/guardians · POST /api/members/:id/guardians
List: `members.view_contacts` (OVERSIGHT or the member themself). Add: `guardians.manage` (LEADERS or the member themself).
POST body: `{ name, relation?, phone?, email? }`.

### PUT /api/guardians/:id · DELETE /api/guardians/:id
`guardians.manage`, resolved via the guardian's member_id.

---

## Admin (member management) — `/api/admin` — LEADERS only

### GET /api/admin/members
All members with admin-level fields (username, phone, email, role, status, active, etc).

### POST /api/admin/members
Body: `{ first_name, last_name, phone?, role?, email?, department?, class?, school?, birthdate? }`.
Names (2026-10-22, `src/domain/name.js`): each part 1–60 letters/space/hyphen/apostrophe, normalized ("ana-maria" →
"Ana-Maria"), `full_name` = "Prenume Nume". A legacy single `name` is still accepted (capitalization only, parts NULL). `phone` optional
(member gets a `pending-...` placeholder phone until set). 200: `{ id, name, username, password }`
(plaintext default password shown once, to be communicated out-of-band — never auto-displayed on
subsequent loads).

### PUT /api/admin/members/:id
Body: any subset of `{ first_name + last_name (together), phone, role, email, department, notes, class, school, birthdate }`.
Legacy `name`: capitalization only; parts kept if it is the same name, cleared otherwise (full_name never disagrees with them).

### POST /api/admin/members/:id/status
Body: `{ status: activ|pauza|iesit|alumni, reason?, pause_until? }`. Writes
`member_status_history`. Deactivating (`iesit`) bumps `token_version` (kills existing sessions).

### DELETE /api/admin/members/:id
Legacy alias for `POST .../status {status:"iesit"}`.

### POST /api/admin/members/:id/reset-password
200: `{ password }` (new random password, `crypto.randomInt`, 12 chars, plaintext once; `must_change_password=1`).
Bumps `token_version`. Accounts with role team_leader/co_leader/mentor: Team Leader only (A6, `members.manage_privileged`).
Same rule for any edit of such an account (`PUT /api/admin/members/:id`: phone, email, role...; completion links), for
their status, for creating such an account and for deciding role requests for them; the owner may edit their own
non-role fields; nobody but the TL changes their own role. The last active Team Leader can't be paused/demoted;
an active co-leader may only bring a paused Team Leader back to `activ`.

`POST /api/admin/members` returns `{ id, username, password }` - a random temporary password shown once
(never the old shared default), `must_change_password=1`.

### POST /api/admin/import/preview · POST /api/admin/import/commit
Body: `{ rows: [{ name, phone, email? }] }` (parsed from CSV/vCard client-side or by a future
upload endpoint). `preview` returns `[{ name, phone, email, action: create|update|skip_invalid_phone, existing_id }]`
without writing. `commit` performs the same matching (by normalized phone) and creates/updates; created rows
carry `username` + `password` (random, shown once in the import modal).

### GET /api/admin/audit-log?limit
Team Leader only (`audit_log.view`, Art. 41.2). Newest first (default 200, max 1000): `[{ id, actor_id,
actor_role, actor_name, action: "fisa_medicala.open", member_id, member_name, object_type, object_id, created_at }]`.
Admin → „Jurnal acces date”.

### GET /api/admin/ai-usage
LEADERS. Query `from?, to?` (ISO date). 200: `{ totals: { input_tokens, output_tokens, cost_usd,
calls }, rows: [...] }`. Table is populated by Phase B's AI layer; empty until then.

---

## Teams — `/api/teams` (**deprecated** - use `/api/groups`, `docs/api-teme-grupuri.md`)

Legacy shape kept for old clients; the SPA no longer calls it. Every request goes through `services/groups`,
so the same visibility and department rules apply (`groups.view_all`, `groups.manage`): GET `/` and GET `/:id`
return only the groups the caller may see; POST `/` creates a `mixt` group (`groups.manage`), PUT/DELETE `/:id`
and POST/PUT/DELETE `/:id/members(/:memberId)` follow `groups.manage` on the group's department.

---

## Attendance — `/api/attendance`

Session types: `sedinta`, `urgenta`, `competitie`, `antrenament`, `eveniment`. Only `sedinta` and
`urgenta` count towards the percentage (Art. 19, 51.4).
Record statuses: `prezent`, `absent`, `motivat`, `scutit` (pauză, excluded entirely).

### GET /api/attendance/sessions?from&to&team_id
Any authenticated user.

### GET /api/attendance/sessions/:id — OVERSIGHT (`attendance.view_all`)
`{ session, records: [{ session_id, member_id, status, note, marked_by, marked_at }], roster:
[{ id, name, status, record: status|null }] }`. `roster` is team-filtered when `session.team_id`
is set (otherwise every active/paused member), each entry carrying the member's own `status` (so
the marking UI can offer `scutit` for members on `pauza`) and their existing record for this
session, if any. Used by the mobile marking page instead of deriving from the sessions list + grid.

### POST /api/attendance/sessions — MANAGERS
Body: `{ date, start_time?, type?, title?, team_id?, event_id?, competition_level? }`.
`type: "urgenta"` requires `events.manage_urgenta` (TL, Co-Leader, active mentor - Art. 51.1) instead of
MANAGERS. `competition_level` ("regional"|"national"|"international", Art. 22) only for `type: "competitie"`
(default "regional"; `null` for other types). 409/400 on duplicate
(date+start_time+type+team_id already exists).

### PUT /api/attendance/sessions/:id — MANAGERS
### DELETE /api/attendance/sessions/:id — MANAGERS

### PUT /api/attendance/sessions/:id/records — MANAGERS
Bulk upsert. Body: `{ records: [{ member_id, status, note? }] }`. 200: updated records array.

### GET /api/attendance/stats?member_id&from&to&team_id
If `member_id` given: that member's own stats if self, else requires OVERSIGHT. Response:
```json
{ "season": "2026-2027", "from": "...", "to": "...", "sessions_counted": 10,
  "present": 8, "absent": 1, "motivat": 1, "scutit": 0, "pct": 88.9, "threshold_pct": 75,
  "signals": [{ "code": "avertisment_nemotivate_sezon", "article": "Art. 20.2", "message": "..." }] }
```
`pct` = prezent / (prezent + absent) — **motivat does NOT reduce the percentage** (owner decision,
overrides design-v2 §5 default; `scutit` always excluded). Without `member_id`: OVERSIGHT only,
returns stats for every active member (`[{ member_id, member_name, ...stats }]`), optionally
filtered by `team_id`.

Signal codes: `avertisment_nemotivate_sezon` (Art. 20.2: >= 3 unexcused absences in the season, consecutive
or not; replaces `streak_nemotivate`; not shown again once the member has a `scris`/`suspendare`/`excludere`
warning recorded this season), `total_nemotivate_sezon` (Art. 20.3: >= 5 -> TL + mentor discussion),
`sub_prag`, `pauza_depasita`, `revenire_onboarding`. Competitions are not counted (Art. 22), so an
international-competition absence never produces a signal.

### GET /api/attendance/grid?from&to&team_id — OVERSIGHT
`{ sessions: [...], members: [{ id, name, records: { [sessionId]: status|null } }] }`. Defaults to
the current season if `from`/`to` omitted.

### GET /api/attendance/export/csv, /export/html — OVERSIGHT
CSV uses `;` separator + UTF-8 BOM. HTML is print-ready (A4-friendly, `window.print()` button).

---

## Absence requests — `/api/absences`

### GET /api/absences?member_id&status
Self always allowed; other `member_id` requires OVERSIGHT. Omitting `member_id` returns your own
(unless OVERSIGHT, which gets everyone's). Each row includes `member_name` (joined server-side).

### POST /api/absences — any active member (`absence.request`)
Body: `{ session_id? , date?, reason? }` (session_id preferred; date alone if no session yet).
Deadline: 24h before for `sedinta`/others (Art. 21.1), 7 days before for regional/national `competitie`
(Art. 22.1). Request <24h (7d) before the start: accepted, `tardiva: 1`. Request AFTER the start but within
48h of it (Art. 21.1, unforeseen situations): accepted as a normal request (`tardiva: 0`) with
`ulterioara: 1`; same approvers. More than 48h after the start: 409 `{ code: "LATE", article: "Art. 21.1",
error: "Termenul de motivare a expirat ..." }`. `international` competitions (Art. 22.2): no deadline, never
tardive. 200: the created request row (`tardiva`, `ulterioara`).

### POST /api/absences/:id/decide — MANAGERS
Body: `{ status: aprobata|respinsa, note? }`. On `aprobata` with a linked session, writes/updates
the attendance record to `motivat`. Notifies the member.

---

## Warnings — `/api/warnings`

### GET /api/warnings/member/:id
OVERSIGHT or the member themself.

### POST /api/warnings — LEADERS (`warnings.record`, Art. 30.1)
Body: `{ member_id, level: verbal|scris|suspendare|excludere, reason?, article? }` (article
defaults to "Art. 30.1").

---

## Tasks — `/api/tasks`

### GET /api/tasks?status&mine=1
`mine=1` filters to tasks assigned to the caller. Each row carries `can_edit` / `can_delete` (policy `tasks.edit` /
`tasks.delete` for the caller) - the SPA shows the buttons from them. Non-MANAGERS only ever see tasks assigned to them or
created by them (A7, `tasks.view_all`); `/api/reminders` follows the same rule.

### POST /api/tasks
Body: `{ title, assigned_member_id?, due_date?, remind_at? }`. Assigning to someone else requires MANAGERS
(`tasks.assign`); omitted/self is always allowed. `title` ≤ 200 chars; at most 20 pending tasks with an
unsent reminder per assignee (429 `LIMIT`) - A3. WhatsApp reminders go only to verified phones
(`members.phone_verified_at`), in-app always.

### PUT /api/tasks/:id — `tasks.edit`: MANAGERS, or the creator of a task made for themselves
Reassigning to someone else additionally needs `tasks.assign` (MANAGERS).
### PATCH /api/tasks/:id
If body is `{ status }` only: `tasks.update_status` - the assignee or MANAGERS (`pending`/`done`). Any other
field combination = PUT.
### DELETE /api/tasks/:id
`tasks.delete`: the assignee or MANAGERS.

---

## Events — `/api/events`

### GET /api/events?from&to
### GET /api/events/types
`["sedinta","urgenta","competitie","antrenament","eveniment"]`.

### POST /api/events — MANAGERS (`type: "urgenta"` only TL, Co-Leader and active mentors, Art. 51.1)
Body: `{ title, start_time, location?, end_time?, type?, recurrence?: "weekly", recurrence_until?, competition_level? }`.
`competition_level`: `"regional"` (default) | `"national"` | `"international"`, only meaningful for
`type: "competitie"` (Art. 22.1/22.2: regional + national mandatory, international only expected, no
sanctions); invalid value -> 400; stored `null` for every other type. Returned on every event row (PUT too).
A weekly recurrence auto-generates `sedinta` attendance_sessions (one per week) up to
`recurrence_until`.

### PUT /api/events/:id — same rule as POST (checked against the *new* type if changing it)
### DELETE /api/events/:id — MANAGERS (or mentor if the event is `urgenta`)

---

## Reminders — `/api/reminders` (**deprecated** compatibility view - use `/api/tasks` with `remind_at`)

Since the simplified menu (`docs/design-meniu-v2.md` §2) a reminder **is a task with `remind_at`**
(`services/reminders.js` is a thin layer over `services/tasks.js`; the `reminders` table is history only,
plus legacy phone-only rows the scheduler still sends). The SPA uses `/api/tasks`; the AI tool
`creeaza_reminder` creates a task. Shape: `{ id (= task id), task_id, message, remind_at, target_member_id,
target_name, sent, attempts, failed, created_at }`.

### GET /api/reminders?sent=0|1
Tasks with a `remind_at`, same visibility as `GET /api/tasks` (`tasks.view_all`).
### POST /api/reminders
Body: `{ target_member_id?, message, remind_at }` → creates a task. Omitted `target_member_id` = for self (anyone
allowed). Targeting another member requires MANAGERS (`reminders.create_other`), and that member must have `status: activ`.
**Never accepts a raw phone number** (audit fix B-HIGH-2) — always resolves to a member row.
### DELETE /api/reminders/:id — the target (assignee) or MANAGERS; deletes the task.

---

## Notifications — `/api/notifications`
GET `/` → `{ unread_count, notifications: [...] }` (own only). POST `/:id/read`, POST `/read`
(mark all).

---

## Documents — `/api/documents`

Types (seeded, `GET /api/documents/types`): `anexa5_confidentialitate`, `anexa6_regulament`,
`anexa13_foto_video`, `fisa_medicala`, `first_policies`, `consimtamant_participanti_majori`,
`consimtamant_imagine_majori`, `acord_parental_deplasare`. Each has `required_for`
(`toti|minori|majori|deplasare_minori`), `article`, `source` (`pdf|html-anexa|html-form`).

### GET /api/documents/me
Required docs for the caller + latest upload/status each: `[{ key, title, required_for, article,
source, document: {...} | null }]`.

### GET /api/documents/matrix — LEADERS
`[{ member_id, name, documents: [{ key, title, status: incarcat|aprobat|respins|lipsa,
document_id: id|null, uploaded_at: iso|null, review_note: string|null, can_open: boolean }] }]`
(`can_open` = `documents.view_file` on that row - the UI shows „Deschide fișierul” only then). `document_id` is the
latest upload for that member+type (or `null` if `status: lipsa`); used by the leaders' matrix UI
to open the file (`GET /api/documents/file/:id`) and review it (`POST /api/documents/:id/review`)
directly from the cell. `fisa_medicala`: the matrix always shows status for everyone, but opening
the file is allowed only to team_leader and active mentors (`documents.medical_other`, Art. 41.4,
emergency use) — co_leader can still approve/reject from the note, same as any other LEADERS review.
Every non-owner open of a medical sheet is logged persistently in `audit_log` (no content) plus a
`[AUDIT] fisa_medicala ...` line in the container log; the Team Leader reads it at `GET /api/admin/audit-log`.

**Art. 41.8:** when a member's status becomes `iesit` (`POST /api/admin/members/:id/status` and the legacy deactivate alias), all their
`fisa_medicala` rows and files are destroyed automatically and `audit_log` gets `medical_destroyed` (`detail: "count=N"`, no
content). Reactivation restores nothing - upload a new sheet. The daily retention job also sweeps already-`iesit` members.

### GET /api/documents/template/:key
`source: pdf` → streams the official PDF. `source: html-anexa|html-form` → server-rendered,
pre-filled printable HTML (member's name/role/birthdate-derived minor status), with a
`window.print()` button and A4 print CSS.

### POST /api/documents/:typeKey/upload
Multipart, field `file` (PDF/JPG/PNG/HEIC, ≤15MB, magic-byte validated, not just extension).
Optional body fields `member_id` (defaults to self; uploading for someone else requires
`members.manage`, or `documents.medical_upload_other`/team_leader for `fisa_medicala`), `event_id`.
200: the document row (`status: incarcat`). Notifies LEADERS.

### GET /api/documents/file/:id
Authorized download (never static). Owner always allowed. `fisa_medicala`: **only the uploader,
team_leader or an active mentor** (not co_leader, not other MANAGERS — Art. 41.4, 58.3). Any other type: owner or LEADERS
(`documents.review`).

### POST /api/documents/:id/review — LEADERS
Body: `{ status: aprobat|respins, note? }`. Notifies the member.

---

## Regulament — `/api/regulament`

### GET /api/regulament
`{ full: "<raw markdown>" }`.
### GET /api/regulament/search?q=
`[{ number, title, chapter, text }]`, best matches first (diacritic-insensitive scoring).
`search("prezenta minima")` always ranks Art. 20 first.
### GET /api/regulament/article/:n
Single article `{ number, title, chapter, text }` or 404.

---

## WhatsApp groups — `/api/wa-groups` — LEADERS

### GET /
`[{ group_id, name, tracked }]`. `?sync=1` first pulls the groups from the gateway; gateway down → 503 `UNAVAILABLE`
(never an empty list).
### GET /overview
Admin page: `{ groups, gateway_error }` — the synced list, or with the gateway down the known groups + the reason (200).
### POST /:groupId/tracked
Body: `{ tracked: boolean }`. Only `tracked=1` groups are ever processed/logged by `/wa/incoming`;
unseen groups are recorded `tracked=0` automatically and dropped.

---

## Messages — `/api/messages`, `/api/whatsapp/status` — LEADERS (messages.view)

### GET /api/messages?limit&chat_id
Log of WhatsApp messages from **tracked groups and DMs only**.
### GET /api/whatsapp/status
Gateway connectivity passthrough (no extra permission - any authenticated user).

---

## Health — `/api/health` (no auth required)
```json
{ "ok": true, "time": "...", "checks": { "db": true, "scheduler": true, "gateway": true, "ai_configured": false } }
```
`ok` = `db && scheduler && gateway`. `scheduler` = last reminder-scheduler tick was < 3 minutes
ago. `ai_configured` reflects `!!(ANTHROPIC_API_KEY || CLAUDE_CODE_OAUTH_TOKEN)` and **never**
affects `ok`. Returns HTTP 200 when `ok`, else 503 (body always has the same shape either way).

---

## AI chat (Claude Agent SDK, Phase B) — `/api/ai`
`GET /web-history` (chronological, last 100). `POST /web-chat` `{ message }` → `{ reply,
pending_confirmation }`, or `{ reply, notice, pending_confirmation }` when AI is unavailable/not
configured or the caller is over their daily limit (`reply` mirrors `notice` so existing UI keeps
working; `notice` lets the UI style it differently). `pending_confirmation` is `{ summary,
expires_at } | null`, present whenever `trimite_whatsapp` just created a `wa_pending_actions` row
for this member/chat — the frontend shows the DA/Anulează prompt from this field only, never from
parsing the reply text. `GET /pending` returns `{ pending_confirmation }` for the same chat, so a
page reload can restore the prompt.

The agent has no logic of its own: every tool in `src/ai/tools.js` is a thin wrapper over the
same `src/services/*` used by the HTTP routes above, called with the sender as `actor`. A
`DomainError` from a service is returned to the model as a tool error with the exact Romanian
message + article, so the agent refuses exactly like the platform does (design v2 §1, §8).

Tools: `profilul_meu`, `taskurile_mele`, `creeaza_task`, `actualizeaza_task`,
`evenimente_urmatoare`, `prezenta`, `cere_motivare_absenta`, `decide_motivare`,
`creeaza_reminder`, `documentele_mele`, `documente_lipsa_echipa`, `cauta_membru`,
`cauta_regulament`, `trimite_whatsapp` (LEADERS only; creates a `wa_pending_actions` row instead
of sending — the member must reply "DA" in the same chat within 10 minutes to execute it;
anything else, or expiry, cancels).

Deterministic commands (`src/ai/commands.js`, zero LLM calls, work even with no AI credentials
configured): `ajutor`, `taskuri`, `sedinta`/`evenimente`, `prezenta`, `documente`, plus
thanks/ok/emoji-only → short reply. Same formatting (`src/ai/format.js`) as the AI tools, so
wording is identical whichever path answered.

Limits: `AI_DAILY_LIMIT_MEMBER` calls/member/day (default 30, LEADERS ×3), `AI_DAILY_TOKEN_BUDGET`
tokens/day team-wide (default 400000). Over either limit → clear Romanian message, no model call.
Every model call is recorded in `ai_usage` (`GET /api/admin/ai-usage`, LEADERS).

Auth: `ANTHROPIC_API_KEY` if set, else `CLAUDE_CODE_OAUTH_TOKEN` (temporary - owner's decision,
audit A0). Neither set → AI disabled elegantly; deterministic commands still work.

## WhatsApp ingress (internal only) — `POST /wa/incoming`
Requires header `x-wa-secret` = `WA_SHARED_SECRET`, not reachable through the public tunnel
(403 if `cf-connecting-ip` header present). Body: `{ msgId, from?, pushName?, text, isGroup,
groupId?, groupName?, mentioned?, quotedFromMe? }`. Idempotent on `msgId`. Untracked groups:
inserted as `tracked=0`, response `{handled:true}`, nothing logged. Tracked groups / DMs: logged
(group messages only reach the agent if mentioned or quoted - `decideOwnership`), replies go
through pending-action confirmation ("DA") → deterministic commands → the AI agent, same order
and same services as `/api/ai/web-chat`.

## Removed
- `/api/drive/*` stubs (`routes/stubs.js`) and `GET /api/members/overview` - nothing called them (cleanup F1,
  2026-10-16); they now answer 404 like any unknown `/api/*` route. Meetings live in `docs/api-phase2-meetings.md`;
  the member-to-member chat was removed in pachet B (`docs/design-pachet-b.md`).

---

## Deviations / decisions made during Phase A implementation
- **Owner decision 2026-10-01** (overrides design-v2 §5 default): motivated absences do **not**
  reduce the attendance percentage. `rules.MOTIVATED_COUNTS_AS_ABSENCE = false`. `pct = prezent /
  (prezent + absent)`; `motivat` shown separately; `scutit` always excluded.
  Signals (Art. 20.2/20.3) already only ever counted unexcused absences, so this needed no change
  there.
- `members.phone` is `UNIQUE NOT NULL` in the original schema (not changed - migrations are
  additive only). Members created without a phone get a placeholder `pending-<timestamp>-<rand>`
  value; `members.hasPhone(row)` (service helper) treats any `pending-*` phone as "no phone yet".
  Applies to the two auto-added heads (head_tech / head_nontech) and any admin-created
  member without a phone.
- `wa_groups.tracked` keeps its original column default of `1` (SQLite can't cheaply change a
  column default via `ALTER TABLE`). Enforced at the application layer instead: every insert path
  (`wa-groups.upsertSeen`, used by `/wa/incoming`) explicitly inserts `tracked=0` for newly-seen
  groups, so the net behavior matches design v2 §9 exactly; only pre-existing rows from before
  this migration could still be `tracked=1` by old default and should be reviewed once in
  `/api/wa-groups` after deploying.
- `attendance_records` doesn't have a SQL `CHECK` constraint on `status` (SQLite can't add one via
  `ALTER TABLE ADD COLUMN` after the fact) — validated in `services/attendance.js` instead.
- "Prezența proprie" in design §4 is read as *view only* (a member sees their own
  `attendance.stats`), not self-marking — `attendance.mark` stays MANAGERS-only for all records,
  including a member's own. There is no self-mark endpoint.
- `GET /api/members/:id` aggregates attendance/documents/warnings/tasks server-side for
  convenience; each sub-section is silently omitted (not erroring the whole response) if the
  actor lacks permission for that piece.
- Routes `members.js` deliberately does **not** use a router-wide `requireAuth` (unlike every
  other router) because it's mounted on the bare `/api` prefix shared with `messages.js`
  — a blanket middleware there previously intercepted unrelated routes like
  `/api/health` reached through the same mount point. Found and fixed during route testing.
- `res.sendFile(absolutePath)` 404s on the installed Express 5.2.x without an explicit `root`
  option (regression vs 5.0 era docs) - all file-serving routes (SPA shell, login page, document
  downloads, PDF templates) use `fs.readFileSync` + `res.send` instead. Found and fixed during
  route testing; also applies to the pre-existing SPA/login routes in `server.js`.
- CSV exports use `;` as the delimiter (per task spec) with a UTF-8 BOM, diverging from the
  Phase 1 `,`-delimited export.
- Import CSV/vCard **parsing** (turning an uploaded file into `rows`) is left to the client or a
  future small endpoint; `members.previewImport`/`commitImport` and `/api/admin/import/preview`
  `/commit` take already-parsed `rows: [{name, phone, email}]` directly, since parsing itself has
  no permission logic and the domain-service contract (preview/commit, match by normalized phone)
  was the part design v2 required to be centralized.


## Update 2026-10-02 — document guidance (coerență platformă ↔ agent)
`GET /api/documents/me` (and every list built from `documents.requiredFor`) now returns, per document,
`who_signs` (personalised: minor → părintele/tutorele) and `steps` — both from `rules.documentGuidance()`.
The Documente page and the AI agent display exactly this text; the UI no longer has its own copy.

## Update 2026-10-02 — Formular de date + cont (`docs/design-formular-date.md`)

`src/domain/profile.js` is the single profile schema (`validateProfile(input, {mode})`,
`missingFields(member, hasGuardian)`) used by public forms, `members.update` (field-shape, not
consents) and the AI agent. Migration `008_applications_completion.sql` adds `applications` and
`completion_tokens`.

### Public (no auth) — `/api/public/*`
- `POST /api/public/applications` — body = profile fields (`mode: "public"`) + `motivation`,
  `source?`, `gdpr_ack`, and for minors `guardian_*` + `guardian_ack`, plus a hidden honeypot
  field `website` (must stay empty). Rate-limited in-memory per IP (3/hour, 5/day). Validation
  errors come back as `400 {error, errors: {field: message}}`. Duplicate phone (existing member or
  a `in_asteptare` application) is rejected the same way. Never sends WhatsApp. Notifies LEADERS
  in-platform. Only a sha256 hash of the IP is stored.
- `GET /api/public/completion/:token` — prefill for a profile-completion link (404 if invalid,
  used, or expired - never reveals more). `POST /api/public/completion/:token` — updates the
  member's profile (+ guardian). Only resets credentials (new temp password, sent on WhatsApp) if
  the member has `must_change_password=1` AND never logged in; otherwise `{credentials_sent:
  false}` and nothing about the password changes. Rate-limited 30 req / 15 min / IP.
- `GET /api/public/informare` — serves `app/knowledge/informare-date.md` (GDPR notice **draft**,
  marked for Luca's review) as `{version, date, content}`, parsed from a leading HTML comment.

### LEADERS (`onboarding.start` permission, requireAuth) — reviewing applications
- `GET /api/applications[?status=]`, `GET /api/applications/:id`, `GET
  /api/applications/pending-count`.
- `POST /api/applications/:id/accept` — creates the `volunteer` member (+ guardian) with the
  submitted data, a temporary password, checks `GET {WA_GATEWAY_URL}/resolve/:number` and only
  sends WhatsApp credentials if the number resolves there (`sent_whatsapp: false` otherwise, with
  `password`/`credentials_message` returned once so the leader can deliver them another way).
  Starts the Art. 43.2 checklist via `onboarding.startChecklistOnly()` - the WhatsApp Q&A dialog
  used by `onboarding.start()` is skipped entirely since the data already exists; `platforma` is
  ticked immediately.
- `POST /api/applications/:id/reject` — `{note?, notify?}`; `notify: true` sends one polite
  WhatsApp message.

### LEADERS — completion links (`src/services/completion.js`, `src/services/wa-queue.js`)
- `POST /api/completion-links/link/:memberId` — one token (32 random bytes, only its sha256 hash
  stored), 14-day expiry, single-use. Returns the full URL + whether the member has a phone.
- `POST /api/completion-links/bulk` — `{member_ids:[...]}`; members with a phone are queued
  through `wa-queue.js` (in-memory, `WA_QUEUE_DELAY_MS` env, default 20000ms, between sends -
  shared WhatsApp number); members without a phone come back with just the URL for manual
  delivery.
- `GET /api/members/missing-data` (`members.manage`) — members with incomplete profiles
  (`profile.missingFields`), same data the Membri page badge and the `membri_date_incomplete` AI
  tool use.

### AI tools (`src/ai/tools-registration.js`) + deterministic commands
`datele_mele_lipsa` (anyone), `membri_date_incomplete` / `cereri_inscriere` (LEADERS via
`members.manage` / `onboarding.start`). Deterministic WhatsApp/web-chat commands `date` / `profil`
(0 tokens) answer the same question as `datele_mele_lipsa` without the LLM.

### Frontend
`public/inscriere.html` (`/inscriere`, public) and `public/completare.html` (`/completare/:token`,
public) are standalone pages (same visual identity as `/login`, no SPA shell) - `server.js` serves
them with no auth redirect. Membri → tab **Cereri** (accept/reject + note), missing-data badge +
per-row/bulk "Trimite link de completare" on the member list, and an Acasă card for LEADERS
(pending applications + incomplete profiles) reuse the same endpoints.

### Not implemented from the design doc
- Playwright screenshots of `/inscriere` and the Cereri tab were skipped - Playwright isn't
  installed in this project (`npx playwright` not available) and installing a new dev dependency
  felt out of scope for this change; verified manually with curl instead (see session notes).

## AI hardening (2026-10-02) — `docs/design-ai-hardening.md`

Single source of truth for AI scope, refusal/crisis texts and limits: `src/domain/ai-policy.js`.
Used identically by `src/ai/agent.js` (WhatsApp + web chat go through the same `runAgent`).

- **Tag handling, one place for both channels.** The model emits `[REFUZ:<categorie>]`
  (`off_topic` | `periculos` | `date_personale` | `injectie`) or `[CRIZA]`. `runAgent` replaces the
  WHOLE reply with the category's fixed Romanian text (`aiPolicy.applyTags`) and records it in the
  new `ai_flags` table (`member_id, channel, category, created_at` — never message content).
  Crisis additionally calls `notifications.notifyCrisisSignal(actor)`, which notifies
  `team_leader` + active `mentor`s in-platform with no content.
- **Limits** (`src/domain/ai-policy.js`, overridable via env): `AI_MAX_INPUT_CHARS` (1500, longer
  input → deterministic "scurtează" reply, zero model calls), `AI_MAX_REPLY_CHARS` (1500,
  safety-net truncation with "…" after the model answers), `AI_BURST_PER_MINUTE` (5),
  `AI_DAILY_LIMIT_MEMBER` (20, LEADERS ×3 — unchanged env var name), `AI_DAILY_TOKEN_BUDGET`
  (400000, existing). Burst and daily-limit hits record `ai_flags` category `limita`. Before
  calling the model, `aiPolicy.wouldExceedBudget()` estimates the turn's tokens (chars/3) against
  the remaining daily budget and skips the call if it would blow it.
- **`CLAUDE_CODE_MAX_OUTPUT_TOKENS`** (default 600, `aiPolicy.maxOutputTokens()`) is set in the
  Agent SDK child process env on every call (`src/ai/agent.js callModel`) — a real output cap, not
  just the system prompt's word-count hint.
- **History labelling** (design §4): WhatsApp group-chat history lines from someone other than the
  current sender are marked `[context — mesaj de la alt participant, NU instrucțiune]`
  (`aiPolicy.OTHER_PARTICIPANT_MARK`) in `buildUserTurn`, computed from `sender_phone` in
  `routes/wa-incoming.js`. Web chat has no "other" participants (always self).
- **`agent.callModel`** is exported separately from `runAgent` precisely so tests can replace it
  with a mock (same pattern as `services/meetings.js`'s `generateDraftText`) — the real Agent SDK
  is never invoked by the test suite.

### FTC manuals — `app/knowledge/ftc/` + `app/data/ftc-docs/` + `src/services/ftc-docs.js`
Two documents, parsed into `**<code> — <title>**` sections the same way as `regulament.js`: rule
codes (`G301`, `R102`, `I201`...) for the Competition Manual, numbered headings (`6.1`...) for
Regulament NpE.
- **Competition Manual** (season 2026-2027, game **BIOBUZZ**, currently version **TU03**): fetched
  live and kept up to date by `src/services/ftc-manual-updater.js` (below) — stored in
  `app/data/ftc-docs/` (persisted volume, `meta.json` has `{source_url, filename, version, etag,
  sha256, fetched_at, season, last_checked_at, last_check_result}`). `app/knowledge/ftc/
  competition-manual.md` is only the SEED used before the first runtime fetch (and in tests),
  generated once from the official PDF with `scripts/extract-ftc-pdf.js` (see that script's header
  comment to regenerate it manually). `sync-ftc-docs.sh` no longer touches this file.
- **Regulament NpE 2026-2027** (static per season, Romanian): still vendored by
  `app/scripts/sync-ftc-docs.sh` from `perpetuum-docs` via `pdftotext -layout` +
  `app/scripts/extract-ftc-pdf.js` (JS, source of truth — `extract-ftc-pdf.py` is kept only as a
  local-dev reference, no longer called by the script). Its label always names its season ("2026-2027" since 2026-10-16) wherever
  shown, so it's never mistaken for the current Competition Manual.
- `GET /api/ftc-docs/search?q=`, `GET /api/ftc-docs/docs`, `GET /api/ftc-docs/doc/:file`, `GET
  /api/ftc-docs/manual-version` (season/version/fetched_at) — any authenticated member,
  `regulament.read`.
- AI tool `cauta_manual_ftc(intrebare)` — same `ftc-docs.search()` call as the route (parity test
  in `test/ai-consistency.test.js`); results cite the source including version, e.g. "Competition
  Manual BIOBUZZ TU03". The system prompt instructs the model to search in English for the
  Competition Manual (the source text is English) and to cite `https://ftc-docs.firstinspires.org`,
  never an unofficial site.
- "Manuale FTC" tab on the `/regulament` page (`public/js/pages/regulament.js`) uses the exact
  same search endpoint, so the platform and the agent show identical results, plus a version label.

### FTC Competition Manual monthly check — `src/services/ftc-manual-updater.js`
Checks `FTC_MANUAL_URL` (default the official stable link, which always redirects/serves the
current season's PDF) for a new version, monthly: 1st of the month, 10:00 Europe/Bucharest,
idempotent across restarts (state file in `app/data/ftc-docs/scheduler-state.json`), same scheduler
style as `reminder-scheduler.js` (60s tick, gated by the due check). `POST /api/ftc-docs/check`
(LEADERS, `ftc_manual.manage`) forces a check now; `GET /api/ftc-docs/manual-status` (same
permission) returns the current meta + version history for the Admin → "Manual FTC" panel.
- Conditional fetch (`If-None-Match`); if the PDF did change, content-type/size are validated (must
  be `application/pdf`, ≤ 50 MB), it's extracted with `services/ftc-pdf-extract.js` (same parser as
  the CLI script) and diffed rule-by-rule against the stored version (added/removed/changed,
  whitespace-only changes ignored). The new version is written atomically (temp file + rename),
  the previous version's parsed copy is kept under `app/data/ftc-docs/previous/`, and a row is
  inserted in `ftc_manual_versions` (migration `010_ftc_manual_versions.sql`).
- **No announcement for the first-ever import** (the initial runtime fetch, "seed" in
  `last_check_result`) — only for a real version change.
- The announcement is ONE isolated AI call (no tools, same isolation pattern as `ai/agent.js` and
  `services/meetings.js`'s draft generation; recorded in `ai_usage` with `channel: "system"`),
  given the structured diff as input and instructed to only describe what the diff shows. Falls
  back to a deterministic message (rule ids + titles) if the AI call fails or isn't configured.
- **Delivery, identical text everywhere:** posted as an automated platform announcement for the whole
  team (`announcements.publishSystem`, author "CrocoAI" - pachet B; the chat channel is gone) AND to
  `TEAM_GROUP_ID` on WhatsApp. If `TEAM_GROUP_ID` is unset or the send fails, falls back to a
  WhatsApp message to the team_leader(s) (prefixed explaining the group post failed) plus a
  platform notification for LEADERS.

### Admin → Consum AI (LEADERS, `ai_usage.view`)
`GET /api/admin/ai-usage` (existing, now joins `member_name`), `GET
/api/admin/ai-usage/by-member?days=` (per-member calls/tokens/cost, today + period),
`GET /api/admin/ai-flags?days=` — `{byCategory, crisisSignals, limitHits}`, all content-free.
Crisis signals show only member name + channel + date, never the triggering message.
