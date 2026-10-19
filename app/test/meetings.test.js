// Meetings + minutes service tests (design-phase2.md §4): permissions, draft generation (AI
// mocked, attendance read from the session - never from the transcript), approval immutability
// and action->task conversion. No network calls.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "._meetings_test.db");
const AUDIO_DIR = path.join(__dirname, "._meetings_test_audio");
process.env.DB_PATH = DB_FILE;
process.env.MEETINGS_AUDIO_DIR = AUDIO_DIR;
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
fs.rmSync(AUDIO_DIR, { recursive: true, force: true });

const db = require("../src/db");
const { DomainError } = require("../src/domain/errors");
const attendanceSvc = require("../src/services/attendance");
const tasksSvc = require("../src/services/tasks");
const meetingsSvc = require("../src/services/meetings");

let tl, coLeader, headTech, mentor, member1, member2;
let session, meeting;

before(() => {
  const insert = db.prepare("INSERT INTO members (full_name, phone, role, auth_role, status) VALUES (?, ?, ?, ?, 'activ')");
  tl = { id: insert.run("Team Leader M", "40700010001", "team_leader", "team_leader").lastInsertRowid, role: "team_leader", status: "activ", full_name: "Team Leader M" };
  coLeader = { id: insert.run("Co Leader M", "40700010002", "co_leader", "co_leader").lastInsertRowid, role: "co_leader", status: "activ", full_name: "Co Leader M" };
  headTech = { id: insert.run("Sef Tehnic M", "40700010003", "head_tech", "head_tech").lastInsertRowid, role: "head_tech", status: "activ", full_name: "Sef Tehnic M" };
  mentor = { id: insert.run("Mentor M", "40700010004", "mentor", "mentor").lastInsertRowid, role: "mentor", status: "activ", full_name: "Mentor M" };
  member1 = { id: insert.run("Ana Member", "40700010005", "member", "member").lastInsertRowid, role: "member", status: "activ", full_name: "Ana Member" };
  member2 = { id: insert.run("Ion Member", "40700010006", "member", "member").lastInsertRowid, role: "member", status: "activ", full_name: "Ion Member" };

  session = attendanceSvc.createSession(tl, { date: "2026-09-08", start_time: "18:00", type: "sedinta", title: "Ședința săptămânală" });
  attendanceSvc.markRecords(tl, session.id, [
    { member_id: member1.id, status: "prezent" },
    { member_id: member2.id, status: "motivat" },
  ]);
});

after(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
  const backupDir = path.join(__dirname, "backups");
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
  delete process.env.DB_PATH;
  delete process.env.MEETINGS_AUDIO_DIR;
  delete process.env.ANTHROPIC_API_KEY;
});

test("meetings.manage is MANAGERS only - a member cannot create/open a meeting for a session", () => {
  assert.throws(() => meetingsSvc.getOrCreateForSession(member1, session.id), DomainError);
});

test("MANAGERS can create the meeting row for an existing session", () => {
  meeting = meetingsSvc.getOrCreateForSession(tl, session.id);
  assert.ok(meeting.id);
  assert.equal(meeting.status, "draft");
  assert.deepEqual(meeting.agenda, []);
});

test("getOrCreateForSession is idempotent (same meeting on a second call)", () => {
  const again = meetingsSvc.getOrCreateForSession(coLeader, session.id);
  assert.equal(again.id, meeting.id);
});

test("agenda can only be edited by MANAGERS, not by a plain member", () => {
  assert.throws(() => meetingsSvc.updateAgenda(member1, meeting.id, ["Punct 1"]), DomainError);
  const updated = meetingsSvc.updateAgenda(tl, meeting.id, ["Robot - progres", "Buget sezon"]);
  assert.deepEqual(updated.agenda, ["Robot - progres", "Buget sezon"]);
});

test("draft (unapproved) meetings are visible to OVERSIGHT (mentor) but not to a plain member", () => {
  assert.throws(() => meetingsSvc.get(member1, meeting.id), DomainError);
  const seen = meetingsSvc.get(mentor, meeting.id);
  assert.equal(seen.id, meeting.id);
});

test("list(): a plain member only sees sessions with an APPROVED PV", () => {
  const rows = meetingsSvc.list(member1, {});
  assert.ok(rows.every((r) => r.meeting_status === "approved"));
});

test("generateDraft: attendance in the PV comes from the session records, not from any transcript text", async () => {
  // Mock the single AI call (same pattern as test/ai-context.test.js: monkey-patch the exported
  // function before it's invoked - generateDraft calls it via module.exports).
  meetingsSvc.generateDraftText = async (prompt) => {
    assert.ok(prompt.includes("Robot - progres")); // agenda made it into the prompt
    return {
      text: JSON.stringify({
        discussions: [{ point: "Robot - progres", discussion: "S-a discutat brațul robotului.", decision: "Se continuă cu designul actual.", majora: false }],
        announcements: "Competiția se apropie.",
        actions: [{ action: "Finalizează CAD-ul brațului", responsible_name: "Ana Member", due_date: "2026-09-15" }],
        next_meeting_note: "Revizuire buget.",
      }),
      usage: { input_tokens: 10, output_tokens: 5 },
      cost: 0.001,
      model: "mock-model",
    };
  };

  const updated = await meetingsSvc.generateDraft(tl, meeting.id);
  assert.ok(updated.draft);
  // Attendance assembled from attendance_records (Ana prezent, Ion motivat), never from the AI text.
  assert.equal(updated.draft.attendance.total_present, 1);
  assert.equal(updated.draft.attendance.absent_motivated_names.length, 1);
  assert.ok(updated.draft.attendance.present_names.includes("Ana Member"));
  assert.equal(updated.draft.discussions[0].decision, "Se continuă cu designul actual.");
  assert.equal(updated.draft.actions[0].responsible_member_id, member1.id); // matched by name
  meeting = updated;
});

test("generateDraft refuses when the AI isn't configured", async () => {
  require("./_ai-env").clearAiProviderEnv();
  await assert.rejects(() => meetingsSvc.generateDraft(tl, meeting.id), DomainError);
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
});

test("updateDraft lets MANAGERS edit the draft manually before approval", () => {
  const draft = { ...meeting.draft, announcements: "Anunț modificat manual." };
  const updated = meetingsSvc.updateDraft(tl, meeting.id, draft);
  assert.equal(updated.draft.announcements, "Anunț modificat manual.");
  meeting = updated;
});

test("meetings.approve is LEADERS only - a head of department cannot approve", () => {
  assert.throws(() => meetingsSvc.approve(headTech, meeting.id), DomainError);
});

test("approve() freezes the PV, records redactat_de/verificat_de and creates a task from the resolved action", () => {
  const before = tasksSvc.list(tl, { mine: false }).filter((t) => t.assigned_member_id === member1.id).length;
  const approved = meetingsSvc.approve(tl, meeting.id);
  assert.equal(approved.status, "approved");
  assert.equal(approved.approved_by, tl.id);
  assert.equal(approved.draft.verificat_de, "Team Leader M");

  const after = tasksSvc.list(tl, { mine: false }).filter((t) => t.assigned_member_id === member1.id);
  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1].title, "Finalizează CAD-ul brațului");
});

test("an approved PV is immutable: agenda/draft edits and re-approval are rejected", () => {
  assert.throws(() => meetingsSvc.updateAgenda(tl, meeting.id, ["Alt punct"]), DomainError);
  assert.throws(() => meetingsSvc.updateDraft(tl, meeting.id, { ...meeting.draft }), DomainError);
  assert.throws(() => meetingsSvc.approve(tl, meeting.id), DomainError);
});

test("an approved PV becomes visible to a plain active member (Art. 49.3)", () => {
  const seen = meetingsSvc.get(member1, meeting.id);
  assert.equal(seen.status, "approved");
  const rows = meetingsSvc.list(member1, {});
  assert.ok(rows.some((r) => r.meeting_id === meeting.id));
});

test("exportHtml renders the Anexa 7 layout with decisions and the retention date", () => {
  const html = meetingsSvc.exportHtml(tl, meeting.id);
  assert.ok(html.includes("PROCES VERBAL"));
  assert.ok(html.includes("Se continuă cu designul actual."));
  assert.ok(html.includes(meetingsSvc.get(tl, meeting.id).retention.until));
});

test("decisionsFor/lastApproved/search (AI tool helpers) return the approved PV's content", () => {
  const dec = meetingsSvc.decisionsFor(tl, "2026-09-08");
  assert.equal(dec.decisions[0].decision, "Se continuă cu designul actual.");

  const last = meetingsSvc.lastApproved(member1);
  assert.equal(last.id, meeting.id);

  const found = meetingsSvc.search(member1, "bratul robotului");
  assert.ok(found.some((r) => r.session_date === "2026-09-08"));
});
