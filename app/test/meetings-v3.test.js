// Ședințe v3 (docs/design-sedinte-v3.md §5): audience permissions per role, invited list, rotating QR
// token (window, previous window, expired / before / after / closed), scan (invited -> P, extra -> P
// extra, idempotent), organizer auto-present, close -> A/M, reopen, stats (extras never lower a
// percentage; team- and department-scoped sessions count only for the invited), announcement with
// the audience, notifications only to the invited, members without the section but with scanning.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers, login } = require("./_assign-env");

const env = initEnv("sedinte_v3");
const AUDIO_DIR = path.join(__dirname, "._sedinte_v3_audio");
fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
process.env.MEETINGS_AUDIO_DIR = AUDIO_DIR;

const { server } = require("../server");
const db = require("../src/db");
const meetingsSvc = require("../src/services/meetings");
const attendanceSvc = require("../src/services/attendance");
const { can } = require("../src/domain/policy");
const eventsSvc = require("../src/services/events");

let M, BASE, C, G, N;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "co", role: "co_leader" },
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "hn", role: "head_nontech", department: "non-tehnic" },
    { key: "mentor", role: "mentor" },
    { key: "gl", role: "member", department: "tehnic" }, // leader of group G
    { key: "a", role: "member", department: "tehnic" },
    { key: "b", role: "member", department: "non-tehnic" },
    { key: "c", role: "member", department: "ambele" },
    { key: "p", role: "member", department: "tehnic", status: "pauza" },
    { key: "gone", role: "member", department: "tehnic", status: "iesit" },
  ]);
  G = db.prepare("INSERT INTO teams (name, department) VALUES ('Robot', 'tehnic')").run().lastInsertRowid;
  N = db.prepare("INSERT INTO teams (name, department) VALUES ('Marketing', 'non-tehnic')").run().lastInsertRowid;
  db.prepare("INSERT INTO team_members (team_id, member_id, role) VALUES (?, ?, 'leader')").run(G, M.gl.id);
  db.prepare("INSERT INTO team_members (team_id, member_id, role) VALUES (?, ?, 'member')").run(G, M.a.id);
  db.prepare("INSERT INTO team_members (team_id, member_id, role) VALUES (?, ?, 'member')").run(N, M.b.id);
  C = {};
  for (const k of ["ht", "a", "b", "gl"]) C[k] = await login(BASE, M[k].phone);
});

after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  env.cleanup();
  fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
  delete process.env.MEETINGS_AUDIO_DIR;
  delete process.env.TEAM_GROUP_ID;
});

beforeEach(() => { env.waSent.length = 0; process.env.TEAM_GROUP_ID = "120363000000@g.us"; });

function req(cookie, method, url, body) {
  return fetch(BASE + url, {
    method, redirect: "manual",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), Cookie: cookie || "" },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

let day = 0; // every meeting gets its own date so slots never clash
function nextDate() { day += 1; return `2027-05-${String(day).padStart(2, "0")}`; }
const base = (over) => ({ title: "Ședință", type: "sedinta", date: nextDate(), time: "18:00", duration: 60, mode: "fizic", location: "Sala S03", agenda: [], ...over });
const team = (id) => {
  const t = db.prepare("SELECT * FROM teams WHERE id = ?").get(id);
  return { ...t, leader_ids: db.prepare("SELECT member_id FROM team_members WHERE team_id = ? AND role = 'leader'").all(id).map((r) => r.member_id) };
};
const startMs = (m) => new Date(db.prepare("SELECT start_time FROM events WHERE id = ?").get(m.session.event_id).start_time).getTime();
const rec = (m, memberId) => db.prepare("SELECT * FROM attendance_records WHERE session_id = ? AND member_id = ?").get(m.session.id, memberId);
const notifCount = (id) => db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND type = 'meeting'").get(id).c;

// ─── Migration 016 ─────────────────────────────────────────────────────────────────────────────
test("migration 016 adds target_dept, extra, attendance_closed_at; two departments can share a slot", async () => {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols("attendance_sessions").includes("target_dept"));
  assert.ok(cols("attendance_records").includes("extra"));
  assert.ok(cols("meetings").includes("attendance_closed_at"));
  const date = nextDate();
  const t = await meetingsSvc.schedule(M.tl, base({ date, target_type: "departament", target_dept: "tehnic" }));
  const n = await meetingsSvc.schedule(M.tl, base({ date, target_type: "departament", target_dept: "non-tehnic" }));
  assert.equal(t.session.target_dept, "tehnic");
  assert.equal(n.session.target_dept, "non-tehnic");
  await assert.rejects(() => meetingsSvc.schedule(M.tl, base({ date, target_type: "departament", target_dept: "tehnic" })), (e) => e.code === "INVALID");
});

test("migration 016 on a pre-v3 database keeps existing sessions/records (whole team, extra = 0)", () => {
  const Database = require("better-sqlite3");
  const file = path.join(__dirname, "._sedinte_v3_migr.db");
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(file + ext); } catch {} }
  const old = new Database(file);
  const dir = path.join(__dirname, "..", "src", "db", "migrations");
  const files = fs.readdirSync(dir).filter((f) => /\.(sql|js)$/.test(f)).sort();
  const v3 = files.indexOf("016_sedinte_v3.sql");
  for (const f of files.slice(0, v3)) {
    if (f.endsWith(".sql")) old.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    else require(path.join(dir, f)).up(old);
  }
  const mid = old.prepare("INSERT INTO members (full_name, phone, role, status) VALUES ('Vechi', '40711111111', 'member', 'activ')").run().lastInsertRowid;
  const sid = old.prepare("INSERT INTO attendance_sessions (date, start_time, type) VALUES ('2026-01-10', '18:00', 'sedinta')").run().lastInsertRowid;
  old.prepare("INSERT INTO attendance_records (session_id, member_id, status) VALUES (?, ?, 'prezent')").run(sid, mid);
  old.exec(fs.readFileSync(path.join(dir, files[v3]), "utf8"));
  assert.equal(old.prepare("SELECT target_dept FROM attendance_sessions WHERE id = ?").get(sid).target_dept, null);
  assert.equal(old.prepare("SELECT extra FROM attendance_records WHERE session_id = ?").get(sid).extra, 0);
  assert.throws(() => old.prepare("INSERT INTO attendance_sessions (date, start_time, type) VALUES ('2026-01-10', '18:00', 'sedinta')").run(), /UNIQUE/);
  old.prepare("INSERT INTO attendance_sessions (date, start_time, type, target_dept) VALUES ('2026-01-10', '18:00', 'sedinta', 'tehnic')").run();
  old.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(file + ext); } catch {} }
});

// ─── Permisiuni pe destinatari ─────────────────────────────────────────────────────────────────
test("meetings.schedule: who may schedule for which audience (every role)", () => {
  const echipa = { target_type: "echipa" };
  const tehnic = { target_type: "departament", target_dept: "tehnic" };
  const nontehnic = { target_type: "departament", target_dept: "non-tehnic" };
  const g = { target_type: "grup", team: team(G) };
  const n = { target_type: "grup", team: team(N) };
  const cases = {
    tl: [true, true, true, true, true],
    co: [true, true, true, true, true],
    mentor: [true, true, true, true, true],
    ht: [true, true, false, true, false],
    hn: [true, false, true, false, true],
    gl: [false, false, false, true, false],
    a: [false, false, false, false, false],
  };
  for (const [k, expected] of Object.entries(cases)) {
    const got = [echipa, tehnic, nontehnic, g, n].map((t) => can(M[k], "meetings.schedule", t));
    assert.deepEqual(got, expected, `role ${k}`);
  }
  assert.equal(can(M.p, "meetings.schedule", g), false, "inactive members schedule nothing");
});

test("schedule enforces the audience rule; reschedule/cancel = same rule on the audience + the creator", async () => {
  const g = await meetingsSvc.schedule(M.gl, base({ target_type: "grup", target_team_id: G }));
  assert.equal(g.session.team_id, G);
  await assert.rejects(() => meetingsSvc.schedule(M.gl, base({ target_type: "grup", target_team_id: N })), (e) => e.code === "FORBIDDEN");
  await assert.rejects(() => meetingsSvc.schedule(M.gl, base()), (e) => e.code === "FORBIDDEN");
  await assert.rejects(() => meetingsSvc.schedule(M.ht, base({ target_type: "departament", target_dept: "non-tehnic" })), (e) => e.code === "FORBIDDEN");
  await assert.rejects(() => meetingsSvc.schedule(M.a, base({ target_type: "grup", target_team_id: G })), (e) => e.code === "FORBIDDEN");

  const nt = await meetingsSvc.schedule(M.hn, base({ target_type: "departament", target_dept: "non-tehnic" }));
  await assert.rejects(() => meetingsSvc.reschedule(M.ht, nt.id, { time: "19:00" }), (e) => e.code === "FORBIDDEN");
  await assert.rejects(() => meetingsSvc.cancel(M.ht, nt.id), (e) => e.code === "FORBIDDEN");
  const moved = await meetingsSvc.reschedule(M.hn, nt.id, { time: "19:00" });
  assert.equal(moved.session.start_time, "19:00");
  await meetingsSvc.reschedule(M.mentor, nt.id, { time: "19:30" });
  // the group leader (creator) and the head of the group's department can both modify a group meeting
  await meetingsSvc.reschedule(M.gl, g.id, { time: "17:00" });
  await meetingsSvc.reschedule(M.ht, g.id, { time: "17:30" });
  await assert.rejects(() => meetingsSvc.reschedule(M.hn, g.id, { time: "16:00" }), (e) => e.code === "FORBIDDEN");
  assert.deepEqual(await meetingsSvc.cancel(M.gl, g.id), { ok: true });
});

// ─── Lista chemaților ──────────────────────────────────────────────────────────────────────────
test("invited: department = members/volunteers of d or 'ambele' + head of d; group = its active members; team = all active except mentors/alumni", async () => {
  const ours = new Set(Object.values(M).map((x) => x.id)); // ignore the seeded admin account
  const ids = (m) => attendanceSvc.invitedMemberIds(m.session).filter((id) => ours.has(id)).sort((x, y) => x - y);
  const sorted = (keys) => keys.map((k) => M[k].id).sort((x, y) => x - y);
  const t = await meetingsSvc.schedule(M.ht, base({ target_type: "departament", target_dept: "tehnic" }));
  assert.deepEqual(ids(t), sorted(["ht", "gl", "a", "c"]));
  const nt = await meetingsSvc.schedule(M.hn, base({ target_type: "departament", target_dept: "non-tehnic" }));
  assert.deepEqual(ids(nt), sorted(["hn", "b", "c"]));
  const g = await meetingsSvc.schedule(M.gl, base({ target_type: "grup", target_team_id: G }));
  assert.deepEqual(ids(g), sorted(["gl", "a"]));
  const all = await meetingsSvc.schedule(M.tl, base());
  assert.deepEqual(ids(all), sorted(["tl", "co", "ht", "hn", "gl", "a", "b", "c"]));
  // a mentor added to a group is invited to that group's meetings
  db.prepare("INSERT INTO team_members (team_id, member_id, role) VALUES (?, ?, 'member')").run(N, M.mentor.id);
  const gn = await meetingsSvc.schedule(M.hn, base({ target_type: "grup", target_team_id: N }));
  assert.deepEqual(ids(gn), sorted(["b", "mentor"]));
  db.prepare("DELETE FROM team_members WHERE team_id = ? AND member_id = ?").run(N, M.mentor.id);
});

// ─── Anunț + notificări ────────────────────────────────────────────────────────────────────────
test("announcement names the audience; in-app notifications only for the invited", async () => {
  const before = Object.fromEntries(["a", "b", "c", "hn"].map((k) => [k, notifCount(M[k].id)]));
  await meetingsSvc.schedule(M.ht, base({ title: "Mecanică", target_type: "departament", target_dept: "tehnic" }));
  assert.equal(env.waSent.length, 1);
  assert.match(env.waSent[0].text, /^📅 Ședință Departament Tehnic — Mecanică, .*ora 18:00, Sala S03\./);
  assert.equal(notifCount(M.a.id), before.a + 1);
  assert.equal(notifCount(M.c.id), before.c + 1);
  assert.equal(notifCount(M.b.id), before.b, "non-tehnic member not notified");
  assert.equal(notifCount(M.hn.id), before.hn, "non-tehnic head not notified");
  const link = (id) => db.prepare("SELECT link FROM notifications WHERE member_id = ? AND type = 'meeting' ORDER BY id DESC LIMIT 1").get(id).link;
  assert.equal(link(M.ht.id), "/sedinte", "recipients with the Ședințe section get a link to it");
  assert.equal(link(M.a.id), "/", "members get Acasă (their upcoming-meetings card)");

  env.waSent.length = 0;
  await meetingsSvc.schedule(M.gl, base({ title: "Sprint", target_type: "grup", target_team_id: G }));
  assert.match(env.waSent[0].text, /^📅 Ședință Grupul Robot — Sprint, /);
  assert.equal(notifCount(M.c.id), before.c + 1, "not in the group -> no notification");
});

// ─── Token QR ──────────────────────────────────────────────────────────────────────────────────
test("QR token: valid in the window, previous 30 s window accepted, older/before/after/closed refused", async () => {
  const m = await meetingsSvc.schedule(M.ht, base({ target_type: "departament", target_dept: "tehnic", duration: 60 }));
  const s = startMs(m);
  const now = s + 5 * 60000;
  const tok = meetingsSvc.qrToken(m.id, now);
  assert.match(tok, /^\d+\.[A-Za-z0-9_-]{16}$/);
  assert.notEqual(meetingsSvc.qrToken(m.id, now + 30000), tok, "rotates every 30 s");

  const r1 = meetingsSvc.scan(M.a, tok, now);
  assert.equal(r1.status, "prezent");
  assert.equal(r1.meeting_title, "Ședință");
  // previous window still accepted
  assert.equal(meetingsSvc.scan(M.c, meetingsSvc.qrToken(m.id, now - 30000), now).status, "prezent");
  // two windows old -> refused
  assert.throws(() => meetingsSvc.scan(M.gl, meetingsSvc.qrToken(m.id, now - 60000), now), (e) => e.code === "INVALID");
  // forged / malformed
  assert.throws(() => meetingsSvc.scan(M.gl, `${m.id}.AAAAAAAAAAAAAAAA`, now), (e) => e.code === "INVALID");
  assert.throws(() => meetingsSvc.scan(M.gl, "garbage", now), (e) => e.code === "INVALID");
  // before the window (opens 15 min before the start) and after the end
  const early = s - 16 * 60000;
  assert.throws(() => meetingsSvc.scan(M.gl, meetingsSvc.qrToken(m.id, early), early), (e) => e.code === "INVALID");
  const okEarly = s - 14 * 60000;
  assert.equal(meetingsSvc.scan(M.mentor, meetingsSvc.qrToken(m.id, okEarly), okEarly).status, "prezent");
  const late = s + 61 * 60000;
  assert.throws(() => meetingsSvc.scan(M.gl, meetingsSvc.qrToken(m.id, late), late), (e) => e.code === "INVALID");
  // after closing
  meetingsSvc.closeAttendance(M.ht, m.id, now);
  assert.throws(() => meetingsSvc.scan(M.gl, meetingsSvc.qrToken(m.id, now), now), (e) => e.code === "INVALID" && /închis/.test(e.message));
  await assert.rejects(() => meetingsSvc.attendanceQr(M.ht, m.id, now), (e) => e.code === "INVALID");
});

// ─── Scanare ───────────────────────────────────────────────────────────────────────────────────
test("scan: invited -> P, outsider -> P extra, double scan idempotent; organizer auto-present", async () => {
  const m = await meetingsSvc.schedule(M.ht, base({ target_type: "departament", target_dept: "tehnic" }));
  const now = startMs(m) + 60000;
  const qr = await meetingsSvc.attendanceQr(M.ht, m.id, now);
  assert.match(qr.svg, /^<svg/);
  assert.ok(qr.url.endsWith(`/p/${qr.token}`));
  assert.ok(qr.seconds_left > 0 && qr.seconds_left <= 30);
  assert.equal(rec(m, M.ht.id).status, "prezent", "organizer auto-present once the QR is shown");

  assert.equal(meetingsSvc.scan(M.a, qr.token, now).status, "prezent");
  assert.equal(rec(m, M.a.id).extra, 0);
  const extra = meetingsSvc.scan(M.b, qr.token, now);
  assert.equal(extra.status, "prezent");
  assert.equal(extra.extra, true);
  assert.equal(rec(m, M.b.id).status, "prezent");
  assert.equal(rec(m, M.b.id).extra, 1);
  assert.equal(meetingsSvc.scan(M.a, qr.token, now).status, "deja marcat");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attendance_records WHERE session_id = ?").get(m.session.id).c, 3);
  assert.throws(() => meetingsSvc.scan(M.p, qr.token, now), (e) => e.code === "FORBIDDEN", "only active accounts scan");

  const view = meetingsSvc.attendanceRoster(M.ht, m.id);
  assert.deepEqual(view.extras.map((x) => x.id), [M.b.id]);
  assert.ok(view.invited.some((x) => x.id === M.a.id && x.record === "prezent"));
});

test("organizer is auto-present on close too, even if the QR was never shown", async () => {
  const m = await meetingsSvc.schedule(M.gl, base({ target_type: "grup", target_team_id: G }));
  meetingsSvc.closeAttendance(M.gl, m.id, startMs(m) + 60000);
  assert.equal(rec(m, M.gl.id).status, "prezent");
  assert.equal(rec(m, M.a.id).status, "absent");
});

// ─── Închidere / redeschidere ──────────────────────────────────────────────────────────────────
test("close: unmarked invited -> A, approved absence for the date -> M, existing marks kept; reopen allows scanning again", async () => {
  const m = await meetingsSvc.schedule(M.ht, base({ target_type: "departament", target_dept: "tehnic" }));
  const now = startMs(m) + 60000;
  db.prepare("INSERT INTO absence_requests (member_id, date, status) VALUES (?, ?, 'aprobata')").run(M.c.id, m.session.date);
  db.prepare("INSERT INTO absence_requests (member_id, date, status) VALUES (?, ?, 'respinsa')").run(M.gl.id, m.session.date);
  meetingsSvc.markAttendance(M.ht, m.id, [{ member_id: M.gl.id, status: "motivat" }]);
  db.prepare("INSERT INTO absence_requests (member_id, date, status) VALUES (?, ?, 'respinsa')").run(M.a.id, m.session.date);
  meetingsSvc.scan(M.a, meetingsSvc.qrToken(m.id, now), now);

  const closed = meetingsSvc.closeAttendance(M.ht, m.id, now);
  assert.ok(closed.closed_at);
  assert.equal(rec(m, M.a.id).status, "prezent");
  assert.equal(rec(m, M.c.id).status, "motivat");
  assert.equal(rec(m, M.gl.id).status, "motivat", "existing manual mark kept");
  assert.equal(rec(m, M.ht.id).status, "prezent", "organizer");
  assert.equal(rec(m, M.tl.id), undefined, "TL is not invited to a department meeting");
  assert.equal(rec(m, M.mentor.id), undefined, "mentors are not invited to a department meeting");
  assert.equal(rec(m, M.p.id), undefined, "members on pause are not marked absent");
  assert.equal(rec(m, M.b.id), undefined, "not invited -> nothing");
  assert.throws(() => meetingsSvc.closeAttendance(M.ht, m.id, now), (e) => e.code === "INVALID");
  assert.throws(() => meetingsSvc.reopenAttendance(M.a, m.id), (e) => e.code === "FORBIDDEN");

  const reopened = meetingsSvc.reopenAttendance(M.ht, m.id);
  assert.equal(reopened.closed_at, null);
  meetingsSvc.markAttendance(M.ht, m.id, [{ member_id: M.c.id, status: "absent" }]);
  assert.equal(meetingsSvc.scan(M.c, meetingsSvc.qrToken(m.id, now), now).status, "prezent", "absent -> present after reopening");
  assert.equal(rec(m, M.c.id).status, "prezent");
});

test("close is refused before the meeting starts", async () => {
  const m = await meetingsSvc.schedule(M.ht, base({ target_type: "departament", target_dept: "tehnic" }));
  assert.throws(() => meetingsSvc.closeAttendance(M.ht, m.id, startMs(m) - 5 * 60000),
    (e) => e.code === "INVALID" && /după începerea ședinței/.test(e.message));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attendance_records WHERE session_id = ?").get(m.session.id).c, 0);
});

test("manual marking: a non-invited member can only be marked present (extra); A/M only for the invited", async () => {
  const m = await meetingsSvc.schedule(M.ht, base({ target_type: "departament", target_dept: "tehnic" }));
  assert.throws(() => meetingsSvc.markAttendance(M.ht, m.id, [{ member_id: M.b.id, status: "absent" }]), (e) => e.code === "INVALID");
  assert.throws(() => meetingsSvc.markAttendance(M.ht, m.id, [{ member_id: M.b.id, status: "motivat" }]), (e) => e.code === "INVALID");
  const view = meetingsSvc.markAttendance(M.ht, m.id, [{ member_id: M.b.id, status: "prezent" }, { member_id: M.a.id, status: "absent" }]);
  assert.equal(rec(m, M.b.id).extra, 1);
  assert.deepEqual(view.extras.map((x) => x.id), [M.b.id]);
  assert.equal(rec(m, M.a.id).status, "absent");
});

test("the person who runs attendance is auto-present (QR opener / closer), not only the creator", async () => {
  const m = await meetingsSvc.schedule(M.ht, base({ target_type: "departament", target_dept: "tehnic" }));
  const now = startMs(m) + 60000;
  await meetingsSvc.attendanceQr(M.mentor, m.id, now);
  assert.equal(rec(m, M.mentor.id).status, "prezent");
  assert.equal(rec(m, M.mentor.id).extra, 1, "a mentor is not invited to a department meeting -> extra");
  assert.equal(rec(m, M.ht.id), undefined, "the creator is not marked just because someone else opened the QR");
  meetingsSvc.closeAttendance(M.tl, m.id, now);
  assert.equal(rec(m, M.tl.id).status, "prezent");
  assert.equal(rec(m, M.ht.id).status, "absent", "creator who did not attend and did not run attendance");
});

test("a creator who is no longer active cannot organize via the creator rule", async () => {
  const g = await meetingsSvc.schedule(M.gl, base({ target_type: "grup", target_team_id: G }));
  const target = { target_type: "echipa", created_by: M.gl.id }; // gl could not organize a team meeting except as creator
  assert.equal(can(M.gl, "meetings.organize", target), true);
  assert.equal(can({ ...M.gl, status: "pauza" }, "meetings.organize", target), false);
  assert.ok(g.id);
});

test("weekly recurring meeting: the QR window follows this week's occurrence, not the series' first one", () => {
  const first = Date.UTC(2027, 8, 7, 15, 0); // 2027-09-07 15:00Z, 2 h, weekly
  const ev = eventsSvc.create(M.tl, {
    title: "Ședință săptămânală", type: "sedinta", start_time: new Date(first).toISOString(), end_time: new Date(first + 2 * 3600000).toISOString(),
    recurrence: "weekly", recurrence_until: new Date(first + 21 * 86400000).toISOString(),
  });
  const s2 = db.prepare("SELECT * FROM attendance_sessions WHERE event_id = ? AND date = '2027-09-14'").get(ev.id);
  assert.ok(s2, "week-2 session generated");
  const m = meetingsSvc.getOrCreateForSession(M.tl, s2.id);
  const week2 = first + 7 * 86400000;
  assert.equal(meetingsSvc.scan(M.a, meetingsSvc.qrToken(m.id, week2 + 600000), week2 + 600000).status, "prezent");
  assert.throws(() => meetingsSvc.scan(M.b, meetingsSvc.qrToken(m.id, first + 600000), first + 600000), (e) => e.code === "INVALID", "week 1 slot refused");
  const after = week2 + 2 * 3600000 + 60000;
  assert.throws(() => meetingsSvc.scan(M.b, meetingsSvc.qrToken(m.id, after), after), (e) => e.code === "INVALID", "after week 2 end refused");
});

// ─── Statistici ────────────────────────────────────────────────────────────────────────────────
test("stats: extras never change a percentage; department- and team-scoped sessions count only for the invited", async () => {
  const pctOf = (k) => attendanceSvc.statsFor(M.tl, M[k].id, { from: "2027-01-01", to: "2027-12-31" });
  const bBefore = pctOf("b");
  const aBefore = pctOf("a");
  const cBefore = pctOf("c");

  const t = await meetingsSvc.schedule(M.ht, base({ target_type: "departament", target_dept: "tehnic" }));
  const now = startMs(t) + 60000;
  meetingsSvc.scan(M.b, meetingsSvc.qrToken(t.id, now), now); // extra
  meetingsSvc.closeAttendance(M.ht, t.id, now); // a, c -> A
  const bAfter = pctOf("b");
  assert.equal(bAfter.sessions_counted, bBefore.sessions_counted, "extra session not counted for b");
  assert.equal(bAfter.pct, bBefore.pct);
  assert.equal(bAfter.extra_present, bBefore.extra_present + 1);
  assert.equal(pctOf("a").sessions_counted, aBefore.sessions_counted + 1, "dept session counts for invited a");
  assert.equal(pctOf("a").absent, aBefore.absent + 1);
  assert.equal(pctOf("c").sessions_counted, cBefore.sessions_counted + 1, "'ambele' is invited to a dept meeting");

  const g = await meetingsSvc.schedule(M.gl, base({ target_type: "grup", target_team_id: G }));
  const cMid = pctOf("c");
  const aMid = pctOf("a");
  meetingsSvc.closeAttendance(M.gl, g.id, startMs(g) + 60000);
  assert.equal(pctOf("c").sessions_counted, cMid.sessions_counted, "team session: outsiders not counted");
  assert.equal(pctOf("a").sessions_counted, aMid.sessions_counted + 1);

  // the grid / roster of a department session lists only the invited (+ extras flagged)
  const detail = attendanceSvc.getSessionDetail(M.tl, t.session.id);
  assert.ok(!detail.roster.some((r) => r.id === M.hn.id));
  assert.ok(detail.roster.some((r) => r.id === M.b.id && r.extra === true));
});

// ─── Vizibilitate ──────────────────────────────────────────────────────────────────────────────
test("members: no Ședințe section, only invited upcoming meetings (Acasă card), but can scan via HTTP", async () => {
  const me = async (k) => (await req(C[k], "GET", "/api/auth/me")).json();
  assert.equal((await me("a")).meetings_section, false);
  assert.equal((await me("b")).meetings_section, false);
  assert.equal((await me("gl")).meetings_section, true, "group leaders see their group's meetings");
  assert.equal((await me("ht")).meetings_section, true);

  const nowMs = Date.now();
  const d = new Date(nowMs).toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
  const t = new Date(nowMs).toLocaleTimeString("en-GB", { timeZone: "Europe/Bucharest", hour: "2-digit", minute: "2-digit" });
  const res = await req(C.ht, "POST", "/api/meetings/schedule", { ...base({ date: d, time: t, title: "Acum" }), target_type: "departament", target_dept: "tehnic" });
  assert.equal(res.status, 200);
  const m = await res.json();

  const mineA = await (await req(C.a, "GET", "/api/meetings/upcoming/mine")).json();
  assert.ok(mineA.some((x) => x.id === m.id && x.title === "Acum"));
  const mineB = await (await req(C.b, "GET", "/api/meetings/upcoming/mine")).json();
  assert.ok(!mineB.some((x) => x.id === m.id), "b is not invited");

  assert.equal((await req(C.a, "GET", `/api/meetings/${m.id}/qr`)).status, 403);
  assert.equal((await req(C.a, "GET", `/api/meetings/${m.id}/attendance`)).status, 403);
  assert.equal((await req(C.gl, "GET", `/api/meetings/${m.id}/attendance`)).status, 403, "dept meeting is not the group leader's");
  const qr = await (await req(C.ht, "GET", `/api/meetings/${m.id}/qr`)).json();
  assert.match(qr.svg, /^<svg/);

  const scan = await req(C.a, "POST", "/api/meetings/scan", { token: qr.token });
  assert.equal(scan.status, 200);
  assert.deepEqual(await scan.json(), { meeting_id: m.id, meeting_title: "Acum", status: "prezent", extra: false });
  const again = await (await req(C.a, "POST", "/api/meetings/scan", { token: qr.token })).json();
  assert.equal(again.status, "deja marcat");
  const bad = await req(C.a, "POST", "/api/meetings/scan", { token: `${m.id}.AAAAAAAAAAAAAAAA` });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).error);
  assert.equal((await req("", "POST", "/api/meetings/scan", { token: qr.token })).status, 401);

  const roster = await (await req(C.ht, "GET", `/api/meetings/${m.id}/attendance`)).json();
  assert.ok(roster.invited.some((x) => x.id === M.a.id && x.record === "prezent"));
});

test("scan page: /p/<token> is an SPA route; logged out -> /login?next=/p/<token>", async () => {
  const out = await req("", "GET", "/p/12.abcdefghijklmnop");
  assert.equal(out.status, 302);
  assert.equal(out.headers.get("location"), "/login?next=%2Fp%2F12.abcdefghijklmnop");
  const inn = await req(C.a, "GET", "/p/12.abcdefghijklmnop");
  assert.equal(inn.status, 200);
  assert.match(await inn.text(), /<html/i);
});
