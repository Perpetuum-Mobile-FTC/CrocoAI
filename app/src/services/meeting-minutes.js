// Minutes (procese verbale, Art. 49, Anexa 7): AI draft, manual edit, approval, printable export and the
// read helpers used by the AI tools. Attendance for the PV is ALWAYS read from attendance_records.
const { TEAM } = require("../domain/team");
const { z } = require("zod");
const db = require("../db");
const { DomainError } = require("../domain/errors");
const { assertCan, can } = require("../domain/policy");
const rules = require("../domain/rules");
const attendanceSvc = require("./attendance");
const tasksSvc = require("./tasks");
const aiUsageSvc = require("./ai-usage");
const { stripDiacritics, requireSession, requireMeetingRow, parseMeeting, assertNotApproved, targetOf, assertCanView, get } = require("./meeting-core");

// ─── PV draft generation (single AI call, no tools - design-phase2.md §4, §8) ─────────────────
// Goes through the AI fallback chain (ai/complete.js, docs/design-ai-fallback.md).
function aiConfigured() {
  return require("../ai/providers").isConfigured();
}

const DRAFT_SYSTEM_PROMPT = `Redactezi ciorne de proces verbal pentru ședințele echipei de robotică FTC
"${TEAM.name}", în română, respectând STRICT structura ANEXA 7 a regulamentului intern.
Răspunzi NUMAI cu un obiect JSON valid (fără text înainte/după, fără markdown) cu exact aceste chei:
{
  "discussions": [{ "point": string, "discussion": string, "decision": string, "majora": boolean }],
  "announcements": string,
  "actions": [{ "action": string, "responsible_name": string|null, "due_date": "YYYY-MM-DD"|null }],
  "next_meeting_note": string
}
"majora" e true DOAR pentru deciziile majore definite la Art. 47.2 (schimbare strategie, achiziții
majore, sponsori cu condiții speciale, modificarea structurii echipei). Nu inventa nume, decizii sau
acțiuni care nu reies din informațiile primite. Dacă nu există transcript, folosește doar agenda și
notele primite - discuțiile pot fi scurte sau goale.`;

// Real implementation - the shared no-tool call of the fallback chain (Claude isolated exactly like
// ai/agent.js). Exposed as `module.exports.generateDraftText` so tests can replace it.
async function generateDraftText(userPrompt) {
  const { complete } = require("../ai/complete");
  return complete({ system: DRAFT_SYSTEM_PROMPT, prompt: userPrompt, maxTokens: 4000, agentDir: "crocoai-agent-meetings" });
}

function buildAttendanceSnapshot(actor, sessionId) {
  const detail = attendanceSvc.getSessionDetail(actor, sessionId);
  const present = detail.roster.filter((r) => r.record === "prezent");
  const absentMotivated = detail.roster.filter((r) => r.record === "motivat");
  const absent = detail.roster.filter((r) => r.record === "absent");
  return {
    roster: detail.roster,
    present_count: present.length,
    total_roster: detail.roster.length,
    present_names: present.map((r) => r.name),
    absent_motivated_names: absentMotivated.map((r) => r.name),
    absent_names: absent.map((r) => r.name),
  };
}

// The next meeting for the SAME audience (whole team / department / group), design-pachet-b.md B3.
function findNextSession(session) {
  return db.prepare(`
    SELECT * FROM attendance_sessions
    WHERE type IN ('sedinta','urgenta') AND IFNULL(team_id,0) = IFNULL(?,0) AND IFNULL(target_dept,'') = IFNULL(?,'')
      AND (date > ? OR (date = ? AND IFNULL(start_time,'') > IFNULL(?,'')))
    ORDER BY date, start_time LIMIT 1
  `).get(session.team_id, session.target_dept, session.date, session.date, session.start_time);
}

// Where the meeting really takes place, for the PV: the room, or online with the Meet link.
function placeForMinutes(meeting) {
  if (meeting.meet_link) return `Online (Google Meet): ${meeting.meet_link}`;
  return meeting.location || null;
}

// Matches an AI-provided name to a roster member (diacritics/case-insensitive, substring match).
function matchRosterMember(name, roster) {
  if (!name) return null;
  const q = stripDiacritics(name);
  const found = roster.find((r) => stripDiacritics(r.name) === q) || roster.find((r) => stripDiacritics(r.name).includes(q) || q.includes(stripDiacritics(r.name)));
  return found ? found.id : null;
}

async function generateDraft(actor, id) {
  const row = requireMeetingRow(id);
  assertCan(actor, "meetings.manage");
  assertNotApproved(row);
  const session = requireSession(row.session_id);
  const agenda = row.agenda ? JSON.parse(row.agenda) : [];
  const attendance = buildAttendanceSnapshot(actor, row.session_id);
  const nextSession = findNextSession(session);

  if (!aiConfigured()) {
    throw new DomainError("INVALID", "Asistentul AI nu e configurat - completează ciorna manual.");
  }

  const promptLines = [
    `Ședința din ${session.date}${session.start_time ? ", ora " + session.start_time.slice(0, 5) : ""} (tip: ${session.type}).`,
    `Ordinea de zi: ${agenda.length ? agenda.map((a, i) => `${i + 1}. ${a}`).join(" ") : "(neprecizată)"}`,
    row.transcript ? `Transcript ședință:\n${row.transcript.slice(0, 15000)}` : "Nu există transcript audio pentru această ședință.",
    nextSession ? `Următoarea ședință programată: ${nextSession.date}${nextSession.start_time ? " ora " + nextSession.start_time.slice(0, 5) : ""}.` : "Nu există încă o ședință viitoare programată.",
  ];

  // Looked up on the facade at call time: tests replace `meetings.generateDraftText`.
  const { text, usage, cost, model } = await require("./meetings").generateDraftText(promptLines.join("\n\n"));
  aiUsageSvc.record({ member: actor, channel: "web", model, usage, cost_usd: cost, tool_calls: 0 });

  let parsed;
  try {
    const jsonMatch = text && text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (err) {
    throw new DomainError("INVALID", "Generarea ciornei a eșuat (răspuns AI invalid) - încearcă din nou sau completează manual.");
  }

  // The model's JSON is untrusted: coerce every field to its type, then the same DRAFT_SCHEMA as manual edits.
  const list = (v, max = 100) => (Array.isArray(v) ? v : []).filter((x) => x && typeof x === "object").slice(0, max);
  const actions = list(parsed.actions).map((a) => ({
    action: aiText(a.action),
    responsible_name: aiText(a.responsible_name) || null,
    responsible_member_id: matchRosterMember(aiText(a.responsible_name), attendance.roster),
    due_date: aiText(a.due_date, 20) || null,
  }));

  const result = DRAFT_SCHEMA.safeParse({
    session_date: session.date,
    start_time: session.start_time || null,
    location: placeForMinutes(parseMeeting(row)),
    agenda,
    attendance: {
      total_present: attendance.present_count,
      total_roster: attendance.total_roster,
      present_names: attendance.present_names,
      absent_motivated_names: attendance.absent_motivated_names,
      absent_names: attendance.absent_names,
    },
    discussions: list(parsed.discussions).map((d) => ({
      point: aiText(d.point), discussion: aiText(d.discussion), decision: aiText(d.decision), majora: !!d.majora,
    })),
    announcements: aiText(parsed.announcements),
    actions,
    next_meeting: { date: nextSession ? nextSession.date : null, note: aiText(parsed.next_meeting_note) },
    redactat_de: null,
  });
  if (!result.success) {
    throw new DomainError("INVALID", "Generarea ciornei a eșuat (răspuns AI invalid) - încearcă din nou sau completează manual.");
  }
  const draft = { ...result.data, verificat_de: null };

  db.prepare(`
    UPDATE meetings SET draft=?, draft_generated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(JSON.stringify(draft), id);
  return get(actor, id);
}

// Any AI value -> a string of at most `max` chars (arrays joined by lines, objects as JSON, null -> "").
function aiText(v, max = 10000) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => aiText(x, max)).join("\n").slice(0, max);
  return (typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, max);
}

// The PV draft schema (A2, design-securitate-2026-10.md): every field with its type, unknown keys dropped.
// Same shape generateDraft() produces; `verificat_de` is set only by approve().
const pvText = z.string().max(10000);
const names = z.array(pvText).max(500);
const DRAFT_SCHEMA = z.object({
  session_date: z.string().max(20).nullish(),
  start_time: z.string().max(10).nullish(),
  location: pvText.nullish(),
  agenda: z.array(pvText).max(100).default([]),
  attendance: z.object({
    total_present: z.number().int().min(0),
    total_roster: z.number().int().min(0),
    present_names: names.default([]),
    absent_motivated_names: names.default([]),
    absent_names: names.default([]),
  }),
  discussions: z.array(z.object({
    point: pvText.default(""), discussion: pvText.default(""), decision: pvText.default(""), majora: z.boolean().default(false),
  })).max(100).default([]),
  announcements: pvText.default(""),
  actions: z.array(z.object({
    action: pvText, responsible_name: pvText.nullish(), responsible_member_id: z.number().int().nullish(), due_date: z.string().max(20).nullish(),
  })).max(100).default([]),
  next_meeting: z.object({ date: z.string().max(20).nullish(), note: pvText.default("") }).default({ date: null, note: "" }),
  redactat_de: pvText.nullish(),
});

// Manual edit of the whole draft object (MANAGERS, before approval).
function updateDraft(actor, id, draft) {
  const row = requireMeetingRow(id);
  assertCan(actor, "meetings.manage");
  assertNotApproved(row);
  const parsed = DRAFT_SCHEMA.safeParse(draft);
  if (!parsed.success) {
    const where = (parsed.error.issues[0] && parsed.error.issues[0].path.join(".")) || "ciornă";
    throw new DomainError("INVALID", `Ciorna nu este validă (câmpul ${where}).`);
  }
  const clean = { ...parsed.data, verificat_de: null };
  db.prepare(`
    UPDATE meetings SET draft=?, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(JSON.stringify(clean), id);
  return get(actor, id);
}

// Approval (LEADERS + head of the meeting's department) = PV final, immutable, versioned; actions with a resolved member become
// tasks (services/tasks, design-phase2.md §4).
function approve(actor, id) {
  const row = requireMeetingRow(id);
  assertCan(actor, "meetings.approve", targetOf(row));
  assertNotApproved(row);
  if (!row.draft) throw new DomainError("INVALID", "Nu există o ciornă de PV pentru această ședință.");
  const draft = JSON.parse(row.draft);
  if (!draft.redactat_de) draft.redactat_de = actor.full_name;
  draft.verificat_de = actor.full_name;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE meetings SET status='approved', approved_by=?, approved_at=?, draft=?, updated_at=? WHERE id=?
  `).run(actor.id, now, JSON.stringify(draft), now, id);

  for (const action of draft.actions || []) {
    if (!action.responsible_member_id) continue;
    try {
      tasksSvc.create(actor, { title: String(action.action || "").slice(0, rules.TASK_TITLE_MAX), assigned_member_id: action.responsible_member_id, due_date: action.due_date || undefined });
    } catch (err) {
      console.error("[MEETINGS] task creation from PV action failed:", err.message);
    }
  }
  return get(actor, id);
}

// ─── Printable export (Anexa 7 layout) ────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escList = (v) => escHtml((Array.isArray(v) ? v : []).join(", ") || "—");

function exportHtml(actor, id) {
  const meeting = get(actor, id);
  const d = meeting.draft || {};
  const rows = (Array.isArray(d.discussions) ? d.discussions : []).map((disc, i) => `
    <p><strong>Punct ${i + 1}:</strong> ${escHtml(disc.point)}</p>
    <p>${escHtml(disc.discussion)}</p>
    <p><strong>Decizie${disc.majora ? " (majoră - Art. 47.2)" : ""}:</strong> ${escHtml(disc.decision)}</p>
  `).join("<hr>");
  const actionsRows = (Array.isArray(d.actions) ? d.actions : []).map((a) => `
    <tr><td>${escHtml(a.action)}</td><td>${escHtml(a.responsible_name || "")}</td><td>${escHtml(a.due_date || "")}</td></tr>
  `).join("");

  return `<!doctype html><html lang="ro"><head><meta charset="utf-8">
  <title>Proces verbal - ${escHtml(meeting.session.date)}</title>
  <style>
    body{font-family:Georgia,serif;max-width:800px;margin:2rem auto;padding:0 1rem;color:#111}
    h1{text-align:center;font-size:1.3rem}
    table{width:100%;border-collapse:collapse;margin:1rem 0}
    th,td{border:1px solid #333;padding:.4rem .6rem;text-align:left}
    hr{border:none;border-top:1px solid #ccc;margin:1rem 0}
    .meta{text-align:center;margin-bottom:1.5rem}
    .sign{margin-top:2rem;display:flex;justify-content:space-between}
  </style></head><body>
  <h1>PROCES VERBAL</h1>
  <p class="meta">Ședința din data de <strong>${escHtml(meeting.session.date)}</strong>
    ${d.start_time ? ` · ora ${escHtml(String(d.start_time).slice(0, 5))}` : ""}${d.location ? ` · ${escHtml(d.location)}` : ""}</p>

  <h3>Prezențe</h3>
  <p>Total prezenți: <strong>${escHtml(d.attendance ? d.attendance.total_present : "?")}</strong> din ${escHtml(d.attendance ? d.attendance.total_roster : "?")} membri activi.</p>
  <p><strong>Prezenți:</strong> ${escList(d.attendance && d.attendance.present_names)}</p>
  <p><strong>Absențe motivate:</strong> ${escList(d.attendance && d.attendance.absent_motivated_names)}</p>
  <p><strong>Absențe nemotivate:</strong> ${escList(d.attendance && d.attendance.absent_names)}</p>

  <h3>Ordinea de zi</h3>
  <ol>${(Array.isArray(d.agenda) ? d.agenda : []).map((a) => `<li>${escHtml(a)}</li>`).join("")}</ol>

  <h3>Discuții și decizii</h3>
  ${rows || "<p>—</p>"}

  <h3>Anunțuri și diverse</h3>
  <p>${escHtml(d.announcements) || "—"}</p>

  <h3>Acțiuni de urmărit</h3>
  <table><thead><tr><th>Acțiune</th><th>Responsabil</th><th>Termen</th></tr></thead>
    <tbody>${actionsRows || `<tr><td colspan="3">—</td></tr>`}</tbody></table>

  <h3>Ședința următoare</h3>
  <p>${d.next_meeting && d.next_meeting.date ? escHtml(d.next_meeting.date) : "Neprogramată"}${d.next_meeting && d.next_meeting.note ? " — " + escHtml(d.next_meeting.note) : ""}</p>

  <div class="sign">
    <p>Redactat de: <strong>${escHtml(d.redactat_de || "—")}</strong></p>
    <p>Verificat de: <strong>${escHtml(d.verificat_de || "—")}</strong></p>
  </div>
  <p class="muted" style="font-size:.85rem;color:#666">Retenție minimă (Art. 49.2): până la ${escHtml(meeting.retention.until)}.</p>
  </body></html>`;
}

// ─── AI tool helpers (ai/tools-meetings.js) ────────────────────────────────────────────────────
function lastApproved(actor) {
  assertCan(actor, "meetings.view_final");
  const row = db.prepare("SELECT * FROM meetings WHERE status='approved' ORDER BY approved_at DESC LIMIT 1").get();
  return row ? parseMeeting(row) : null;
}

// Every meeting of that day the actor may read (several meetings can share a date: departments, groups).
// `decisions` = all of them flattened (kept for older callers), `meetings` = per meeting.
function decisionsFor(actor, date) {
  const sessions = db.prepare("SELECT * FROM attendance_sessions WHERE date = ? AND type IN ('sedinta','urgenta') ORDER BY start_time, id").all(date);
  if (!sessions.length) throw new DomainError("NOT_FOUND", "Nicio ședință la această dată.");
  const rows = sessions.map((s) => db.prepare("SELECT * FROM meetings WHERE session_id = ?").get(s.id)).filter(Boolean);
  if (!rows.length) throw new DomainError("NOT_FOUND", "Nu există PV pentru această ședință.");
  const visible = rows.filter((r) => { try { assertCanView(actor, r); return true; } catch { return false; } });
  if (!visible.length) assertCanView(actor, rows[0]); // throws the same refusal as before
  const meetingsOut = visible.map(parseMeeting).map((m) => ({
    meeting_id: m.id, title: m.session.title || "Ședință", time: (m.session.start_time || "").slice(0, 5), status: m.status,
    decisions: (m.draft && m.draft.discussions) || [],
  }));
  return { date, meetings: meetingsOut, decisions: meetingsOut.flatMap((m) => m.decisions) };
}

// Substring search (diacritics/case-insensitive) across approved PVs (drafts too for OVERSIGHT).
function search(actor, text) {
  const q = stripDiacritics(text);
  const oversight = can(actor, "meetings.view_drafts"); // OVERSIGHT: drafts too
  let rows = db.prepare("SELECT * FROM meetings WHERE draft IS NOT NULL OR transcript IS NOT NULL").all();
  if (!oversight) {
    assertCan(actor, "meetings.view_final");
    rows = rows.filter((r) => r.status === "approved");
  }
  const results = [];
  for (const row of rows) {
    const haystack = stripDiacritics(`${row.draft || ""} ${row.transcript || ""}`);
    if (haystack.includes(q)) {
      const meeting = parseMeeting(row);
      results.push({ session_date: meeting.session.date, status: meeting.status, meeting_id: meeting.id });
    }
  }
  return results;
}

module.exports = { generateDraft, generateDraftText, updateDraft, approve, exportHtml, lastApproved, decisionsFor, search, DRAFT_SCHEMA };
