// Department heads can do everything the Team Leader can for their department and its groups;
// mixed groups: both heads see everything, act only as creator / TL / co-leader (decision 2026-10-13).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers } = require("./_assign-env");
const env = initEnv("sefi_tl_dept");
const AUDIO_DIR = path.join(__dirname, "._sefi_tl_dept_audio");
fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
process.env.MEETINGS_AUDIO_DIR = AUDIO_DIR;
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

const db = require("../src/db");
const groups = require("../src/services/groups");
const assignments = require("../src/services/assignments");
const subs = require("../src/services/submissions");
const meetingsSvc = require("../src/services/meetings");
const recordings = require("../src/services/meeting-recordings");
const attendanceSvc = require("../src/services/attendance");
const { can } = require("../src/domain/policy");

let M, gNT, gT, gMX;
const subOf = (a, memberId) => db.prepare("SELECT * FROM submissions WHERE assignment_id = ? AND member_id IS ?").get(a.id, memberId);
const setPredat = (s) => db.prepare("UPDATE submissions SET status='predat', current_version=1 WHERE id = ?").run(s.id);

before(() => {
  M = makeMembers(db, [
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "hn", role: "head_nontech", department: "non-tehnic" },
    { key: "tl", role: "team_leader" },
    { key: "n1", role: "member", department: "non-tehnic" },
    { key: "n2", role: "member", department: "non-tehnic" },
    { key: "t1", role: "member", department: "tehnic" },
  ]);
  gNT = groups.create(M.tl, { name: "GNT", department: "non-tehnic" });
  groups.setMembers(M.tl, gNT.id, [{ member_id: M.n1.id }, { member_id: M.n2.id }]);
  gT = groups.create(M.tl, { name: "GT", department: "tehnic" });
  groups.setMembers(M.tl, gT.id, [{ member_id: M.t1.id }]);
  gMX = groups.create(M.tl, { name: "GMX", department: "mixt" });
  groups.setMembers(M.tl, gMX.id, [{ member_id: M.n1.id }, { member_id: M.t1.id }]);
});
after(() => {
  db.close();
  env.cleanup();
  fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
  delete process.env.MEETINGS_AUDIO_DIR;
  delete process.env.ANTHROPIC_API_KEY;
});

// ─── Policy helpers ───
test("policy: assignments.manage/review include the head of the resolved department only", () => {
  const head = (role, extra) => ({ id: 1, role, status: "activ", ...extra });
  const row = (dept, created_by = 99) => ({ created_by, dept });
  assert.ok(can(head("head_nontech"), "assignments.manage", row("non-tehnic")));
  assert.equal(can(head("head_tech"), "assignments.manage", row("non-tehnic")), false);
  assert.equal(can(head("head_tech"), "assignments.manage", row("mixt")), false);
  assert.ok(can(head("head_tech"), "assignments.manage", row("mixt", 1)), "creator keeps manage on a mixed group");
  assert.equal(can(head("head_tech", { status: "pauza" }), "assignments.manage", row("tehnic")), false);
  assert.equal(can(head("head_tech"), "assignments.review", row("mixt")), false);
  assert.ok(can(head("head_tech"), "assignments.view_dept", { dept: "mixt" }));
  assert.ok(can(head("head_nontech"), "assignments.view_dept", { dept: "mixt" }));
  assert.equal(can(head("member"), "assignments.view_dept", { dept: "mixt" }), false);
});

test("policy: meetings.approve = LEADERS or head of the meeting department; no target -> LEADERS", () => {
  const ht = { id: 1, role: "head_tech", status: "activ" };
  assert.ok(can(ht, "meetings.approve", { dept: "tehnic" }));
  assert.equal(can(ht, "meetings.approve", { dept: "non-tehnic" }), false);
  assert.equal(can(ht, "meetings.approve", { dept: "mixt" }), false);
  assert.equal(can(ht, "meetings.approve", { dept: null }), false);
  assert.equal(can(ht, "meetings.approve"), false);
  assert.ok(can({ id: 2, role: "co_leader", status: "activ" }, "meetings.approve"));
});

// ─── Assignments ───
let deptNT, grpNT, mixed;
test("setup assignments (all created by TL)", () => {
  deptNT = assignments.create(M.tl, { title: "DeptNT", mode: "individual", target_type: "departament", target_dept: "non-tehnic" });
  grpNT = assignments.create(M.tl, { title: "GrupNT", mode: "grup", target_type: "grup", target_team_id: gNT.id });
  mixed = assignments.create(M.tl, { title: "Mixt", mode: "individual", target_type: "grup", target_team_id: gMX.id });
});

test("head_nontech has TL rights on a non-tehnic assignment: flags, edit, add members, review, close", () => {
  const d = assignments.get(M.hn, deptNT.id);
  assert.equal(d.can_manage, true);
  assert.equal(d.can_review, true);
  assert.equal(assignments.update(M.hn, deptNT.id, { title: "DeptNT2" }).title, "DeptNT2");
  assert.deepEqual(assignments.addNewMembers(M.hn, deptNT.id), { added: 0 });
  const s = subOf(deptNT, M.n1.id);
  setPredat(s);
  assert.equal(subs.review(M.hn, s.id, { decision: "acceptat" }).status, "acceptat");
  assert.equal(assignments.close(M.hn, deptNT.id).status, "inchisa");
  assert.equal(assignments.get(M.hn, grpNT.id).can_manage, true);
});

test("head_nontech deletes a non-tehnic group assignment without submissions", () => {
  const tmp = assignments.create(M.tl, { title: "Tmp", mode: "grup", target_type: "grup", target_team_id: gNT.id });
  assignments.remove(M.hn, tmp.id);
  assert.equal(db.prepare("SELECT 1 FROM assignments WHERE id = ?").get(tmp.id), undefined);
});

test("head_tech is denied all of it on non-tehnic assignments", () => {
  const a = assignments.create(M.tl, { title: "DeptNT-b", mode: "individual", target_type: "departament", target_dept: "non-tehnic" });
  assert.throws(() => assignments.get(M.ht, a.id), /acces/);
  assert.throws(() => assignments.update(M.ht, a.id, { title: "x" }), /Doar/);
  assert.throws(() => assignments.close(M.ht, a.id), /Doar/);
  assert.throws(() => assignments.remove(M.ht, a.id), /Doar/);
  assert.throws(() => assignments.addNewMembers(M.ht, a.id), /Doar/);
  const s = subOf(a, M.n2.id);
  setPredat(s);
  assert.throws(() => subs.review(M.ht, s.id, { decision: "acceptat" }), /FORBIDDEN|Doar/);
});

test("mixed-group assignment: both heads see submissions; neither can manage or review", () => {
  const s = subOf(mixed, M.t1.id);
  setPredat(s);
  const a = assignments.requireAssignment(mixed.id);
  for (const h of [M.ht, M.hn]) {
    const d = assignments.get(h, mixed.id);
    assert.ok(d.submissions && d.progress, h.role);
    assert.equal(d.can_manage, false);
    assert.equal(d.can_review, false);
    assert.equal(assignments.canSeeSubmission(h, s, a), true);
    assert.throws(() => subs.review(h, s.id, { decision: "acceptat" }), /Doar/);
    assert.throws(() => assignments.update(h, mixed.id, { title: "x" }), /Doar/);
    assert.ok(assignments.list(h, { scope: "all" }).some((x) => x.id === mixed.id), h.role);
  }
  assert.ok(!assignments.list(M.ht, { scope: "all" }).some((x) => x.id === deptNT.id));
});

test("groups: both heads view the mixed group (read-only)", () => {
  for (const h of [M.ht, M.hn]) {
    const g = groups.get(h, gMX.id);
    assert.equal(g.can_manage, false);
    assert.ok(groups.list(h).some((x) => x.id === gMX.id));
  }
});

// ─── Meetings ───
let day = 0;
const sched = (actor, over) => {
  day += 1;
  return meetingsSvc.schedule(actor, { title: "Ședință", type: "sedinta", date: `2027-09-${String(day).padStart(2, "0")}`, time: "18:00", duration: 60, mode: "fizic", location: "S03", agenda: [], ...over });
};
const withDraft = (m) => { db.prepare("UPDATE meetings SET draft = ? WHERE id = ?").run(JSON.stringify({ actions: [], discussions: [] }), m.id); return m; };

test("head_tech approves the PV of a tehnic meeting and of a tehnic-group meeting", async () => {
  const m1 = withDraft(await sched(M.tl, { target_type: "departament", target_dept: "tehnic" }));
  const m2 = withDraft(await sched(M.tl, { target_type: "grup", target_team_id: gT.id }));
  assert.equal(meetingsSvc.get(M.ht, m1.id).can_approve, true);
  assert.equal(meetingsSvc.approve(M.ht, m1.id).status, "approved");
  assert.equal(meetingsSvc.approve(M.ht, m2.id).status, "approved");
});

test("head_tech cannot approve a non-tehnic, mixed-group or whole-team meeting PV", async () => {
  const nt = withDraft(await sched(M.tl, { target_type: "departament", target_dept: "non-tehnic" }));
  const mx = withDraft(await sched(M.tl, { target_type: "grup", target_team_id: gMX.id }));
  const all = withDraft(await sched(M.tl, { target_type: "echipa" }));
  for (const m of [nt, mx, all]) {
    assert.equal(meetingsSvc.get(M.ht, m.id).can_approve, false);
    assert.throws(() => meetingsSvc.approve(M.ht, m.id), /permisiunea|Doar/);
  }
  assert.equal(meetingsSvc.get(M.tl, all.id).can_approve, true);
});

test("head_nontech generates + edits the draft and records audio for a non-tehnic meeting", async () => {
  const m = await sched(M.tl, { target_type: "grup", target_team_id: gNT.id });
  meetingsSvc.generateDraftText = async () => ({
    text: JSON.stringify({ discussions: [], announcements: "", actions: [], next_meeting_note: "" }),
    usage: { input_tokens: 1, output_tokens: 1 }, cost: 0, model: "mock",
  });
  const g = await meetingsSvc.generateDraft(M.hn, m.id);
  assert.ok(g.draft);
  assert.equal(g.can_manage, true);
  assert.equal(g.can_approve, true);
  assert.ok(meetingsSvc.updateDraft(M.hn, m.id, { ...g.draft, announcements: "x" }).draft.announcements === "x");
  assert.ok(recordings.startRecording(M.hn, m.id, { mime: "audio/webm" }).recording_id);
  const up = meetingsSvc.uploadAudio(M.hn, m.id, { buffer: Buffer.from("x"), size: 1, originalname: "a.webm" }, () => {});
  assert.equal(up.audio_status, "processing");
  assert.equal(meetingsSvc.approve(M.hn, m.id).status, "approved");
});

test("both heads see a mixed-group meeting draft; neither approves", async () => {
  const m = withDraft(await sched(M.tl, { target_type: "grup", target_team_id: gMX.id }));
  for (const h of [M.ht, M.hn]) {
    const d = meetingsSvc.get(h, m.id);
    assert.ok(d.draft, h.role);
    assert.equal(d.can_approve, false);
  }
});

test("attendance.mark: head of the session department (target) still allowed; members denied", async () => {
  const m = await sched(M.tl, { target_type: "departament", target_dept: "non-tehnic" });
  const recs = attendanceSvc.markRecords(M.hn, m.session.id, [{ member_id: M.n1.id, status: "prezent" }]);
  assert.ok(recs.some((r) => r.member_id === M.n1.id));
  assert.throws(() => attendanceSvc.markRecords(M.n1, m.session.id, []), /permisiunea/);
});
