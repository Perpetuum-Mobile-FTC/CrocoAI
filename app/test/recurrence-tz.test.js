// Weekly recurrence in Europe/Bucharest wall-clock time (fix round 2 of ședințe v3): sessions keep the
// local date/time across DST (2026-10-25), the QR window and the 24h/1h reminders follow each local
// occurrence, meeting reminders go only to the invited, and migration 017 repairs UTC-stored sessions.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers } = require("./_assign-env");

const env = initEnv("recurrence_tz");
process.env.MEETINGS_AUDIO_DIR = path.join(__dirname, "._recurrence_tz_audio");

const db = require("../src/db");
const eventsSvc = require("../src/services/events");
const meetingsSvc = require("../src/services/meetings");
const scheduler = require("../src/services/reminder-scheduler");

let M;
before(() => {
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "mentor", role: "mentor" },
    { key: "a", role: "member", department: "tehnic" },
  ]);
});
after(() => {
  db.close();
  env.cleanup();
  fs.rmSync(process.env.MEETINGS_AUDIO_DIR, { recursive: true, force: true });
  delete process.env.MEETINGS_AUDIO_DIR;
});
beforeEach(() => { delete process.env.TEAM_GROUP_ID; });

// 18:00 local on Wed 2026-10-14 (EEST, UTC+3) = 15:00Z; 2 h; weekly until 2026-10-28 (DST ends 10-25).
function series(title = "Ședința de miercuri") {
  return eventsSvc.create(M.tl, {
    title, type: "sedinta", start_time: "2026-10-14T15:00:00.000Z", end_time: "2026-10-14T17:00:00.000Z",
    recurrence: "weekly", recurrence_until: "2026-10-28",
  });
}
const sessionsOf = (ev) => db.prepare("SELECT * FROM attendance_sessions WHERE event_id = ? ORDER BY date").all(ev.id);
const at = (iso) => Date.parse(iso);
const drop = (ev) => { // sessions first (their meetings cascade), then the series
  db.prepare("DELETE FROM attendance_sessions WHERE event_id = ?").run(ev.id);
  db.prepare("DELETE FROM events WHERE id = ?").run(ev.id);
};

test("weekly sessions keep the local date and time across DST", () => {
  const ev = series();
  assert.deepEqual(sessionsOf(ev).map((s) => [s.date, s.start_time]), [
    ["2026-10-14", "18:00"], ["2026-10-21", "18:00"], ["2026-10-28", "18:00"],
  ]);
  // regenerating the series (any update) creates no duplicates
  eventsSvc.update(M.tl, ev.id, { title: "Ședința de miercuri (2)" });
  assert.equal(sessionsOf(ev).length, 3);
  drop(ev);
});

test("QR window of the 10-28 occurrence = 17:45-20:00 local (15:45Z-18:00Z after DST)", () => {
  const ev = series("QR");
  const s = sessionsOf(ev).find((x) => x.date === "2026-10-28");
  const m = meetingsSvc.getOrCreateForSession(M.tl, s.id);
  const tok = (iso) => meetingsSvc.qrToken(m.id, at(iso));
  assert.throws(() => meetingsSvc.scan(M.a, tok("2026-10-28T15:44:00Z"), at("2026-10-28T15:44:00Z")), (e) => e.code === "INVALID");
  assert.equal(meetingsSvc.scan(M.a, tok("2026-10-28T15:46:00Z"), at("2026-10-28T15:46:00Z")).status, "prezent");
  assert.equal(meetingsSvc.scan(M.tl, tok("2026-10-28T17:59:00Z"), at("2026-10-28T17:59:00Z")).status, "prezent");
  assert.throws(() => meetingsSvc.scan(M.mentor, tok("2026-10-28T18:01:00Z"), at("2026-10-28T18:01:00Z")), (e) => e.code === "INVALID");
  drop(ev);
});

test("reminders fire for each local occurrence across DST; meeting reminders only to the invited", async () => {
  const ev = series("Rem");
  const s28 = sessionsOf(ev).find((x) => x.date === "2026-10-28");
  meetingsSvc.getOrCreateForSession(M.tl, s28.id); // 10-28 is a meeting: whole team without mentors
  const count = (id) => db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND type = 'reminder' AND body LIKE 'Rem%'").get(id).c;

  await scheduler.tick(new Date("2026-10-27T15:30:00Z")); // 24.5 h before 16:00Z -> nothing yet
  assert.equal(count(M.a.id), 0);
  await scheduler.tick(new Date("2026-10-27T16:30:00Z")); // 23.5 h before -> the 24 h reminder
  assert.equal(count(M.a.id), 1);
  assert.equal(count(M.mentor.id), 0, "mentors are not invited to a whole-team meeting");
  await scheduler.tick(new Date("2026-10-28T14:55:00Z")); // 65 min before 16:00Z: no 1 h reminder yet (UTC+3 bug would fire here)
  assert.equal(count(M.a.id), 1);
  await scheduler.tick(new Date("2026-10-28T15:05:00Z")); // 55 min before -> 1 h reminder
  assert.equal(count(M.a.id), 2);
  await scheduler.tick(new Date("2026-10-28T15:10:00Z"));
  assert.equal(count(M.a.id), 2, "each reminder only once");

  // the 10-21 occurrence (no meeting) reminds every active member, mentors included (as before)
  await scheduler.tick(new Date("2026-10-21T14:30:00Z")); // EEST: 18:00 local = 15:00Z -> 30 min before
  assert.equal(count(M.mentor.id), 1);
  drop(ev);
});

test("whole-team scheduled meeting: event reminder excludes mentors", async () => {
  const m = await meetingsSvc.schedule(M.tl, { title: "Plen", type: "sedinta", date: "2026-11-04", time: "18:00", duration: 60, mode: "fizic", location: "S03", agenda: [] });
  const count = (id) => db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND type = 'reminder' AND body = 'Plen'").get(id).c;
  await scheduler.tick(new Date("2026-11-04T15:30:00Z")); // 30 min before 16:00Z
  assert.equal(count(M.a.id), 1);
  assert.equal(count(M.mentor.id), 0);
  assert.ok(m.id);
});

test("migration 017 rewrites UTC-stored recurring sessions to the series' local time (and leaves the rest)", () => {
  const Database = require("better-sqlite3");
  const file = path.join(__dirname, "._recurrence_tz_migr.db");
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(file + ext); } catch {} }
  const old = new Database(file);
  const dir = path.join(__dirname, "..", "src", "db", "migrations");
  const files = fs.readdirSync(dir).filter((f) => /\.(sql|js)$/.test(f)).sort();
  const idx = files.findIndex((f) => f.startsWith("017_"));
  assert.ok(idx > 0, "migration 017 exists");
  for (const f of files.slice(0, idx)) {
    if (f.endsWith(".sql")) old.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    else require(path.join(dir, f)).up(old);
  }
  // what the old UTC generator produced for an 18:00-local series: "15:00" every week (17:00 local after DST)
  const ev = old.prepare("INSERT INTO events (title, start_time, end_time, type, recurrence, recurrence_until, reminded_24h, reminded_1h) VALUES ('S', '2026-10-14T15:00:00.000Z', '2026-10-14T17:00:00.000Z', 'sedinta', 'weekly', '2026-10-28', 1, 0)").run().lastInsertRowid;
  const ins = old.prepare("INSERT INTO attendance_sessions (date, start_time, type, event_id) VALUES (?, ?, 'sedinta', ?)");
  const s14 = ins.run("2026-10-14", "15:00", ev).lastInsertRowid;
  const s28 = ins.run("2026-10-28", "15:00", ev).lastInsertRowid;
  const edited = ins.run("2026-10-21", "19:30", ev).lastInsertRowid; // edited by hand: not the generator's UTC time
  const single = old.prepare("INSERT INTO events (title, start_time, type) VALUES ('Unic', '2026-10-15T15:00:00.000Z', 'sedinta')").run().lastInsertRowid;
  const sSingle = ins.run("2026-10-15", "18:00", single).lastInsertRowid;
  const sManual = old.prepare("INSERT INTO attendance_sessions (date, start_time, type) VALUES ('2026-10-16', '15:00', 'sedinta')").run().lastInsertRowid;
  // a series at 01:30 local (22:30Z the day before): the stored UTC date differs from the local date
  const night = old.prepare("INSERT INTO events (title, start_time, type, recurrence, recurrence_until) VALUES ('N', '2026-10-13T22:30:00.000Z', 'sedinta', 'weekly', '2026-10-30')").run().lastInsertRowid;
  const sNight = ins.run("2026-10-13", "22:30", night).lastInsertRowid;
  old.prepare("INSERT INTO event_exceptions (event_id, date) VALUES (?, '2026-10-20')").run(night);

  // UNIQUE collisions with an existing local-time row: an empty duplicate is deleted, one with data is kept
  const dupEmpty = ins.run("2026-11-04", "15:00", ev).lastInsertRowid;
  ins.run("2026-11-04", "18:00", ev);
  const dupData = ins.run("2026-11-11", "15:00", ev).lastInsertRowid;
  ins.run("2026-11-11", "18:00", ev);
  const mid = old.prepare("INSERT INTO members (full_name, phone, role, status) VALUES ('X', '40711111112', 'member', 'activ')").run().lastInsertRowid;
  old.prepare("INSERT INTO attendance_records (session_id, member_id, status) VALUES (?, ?, 'prezent')").run(dupData, mid);

  require(path.join(dir, files[idx])).up(old);
  assert.equal(old.prepare("SELECT COUNT(*) c FROM attendance_sessions WHERE id = ?").get(dupEmpty).c, 0, "empty duplicate deleted");
  assert.equal(old.prepare("SELECT start_time FROM attendance_sessions WHERE id = ?").get(dupData).start_time, "15:00", "duplicate with records kept");
  const get = (id) => old.prepare("SELECT date, start_time, reminded_24h, reminded_1h FROM attendance_sessions WHERE id = ?").get(id);
  assert.deepEqual(get(s14), { date: "2026-10-14", start_time: "18:00", reminded_24h: 1, reminded_1h: 0 }, "first occurrence inherits the event flags");
  assert.deepEqual(get(s28), { date: "2026-10-28", start_time: "18:00", reminded_24h: 0, reminded_1h: 0 });
  assert.equal(get(edited).start_time, "19:30");
  assert.equal(get(sSingle).start_time, "18:00");
  assert.equal(get(sManual).start_time, "15:00");
  assert.deepEqual([get(sNight).date, get(sNight).start_time], ["2026-10-14", "01:30"]);
  assert.deepEqual(old.prepare("SELECT date FROM event_exceptions WHERE event_id = ?").all(night).map((r) => r.date), ["2026-10-21"]);
  old.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(file + ext); } catch {} }
});

test("changing a series' time moves future empty sessions in place: one reminder per occurrence, at the new time", async () => {
  process.env.TEAM_GROUP_ID = "120363000000@g.us";
  // 18:00 local Wednesdays (EET, 16:00Z), 2027-01-06 .. 2027-01-27
  const ev = eventsSvc.create(M.tl, {
    title: "Serie", type: "sedinta", start_time: "2027-01-06T16:00:00.000Z", end_time: "2027-01-06T18:00:00.000Z",
    recurrence: "weekly", recurrence_until: "2027-01-27",
  });
  const byDate = () => Object.fromEntries(sessionsOf(ev).map((x) => [x.date, x]));
  const before = byDate();
  assert.deepEqual(Object.keys(before), ["2027-01-06", "2027-01-13", "2027-01-20", "2027-01-27"]);
  db.prepare("INSERT INTO attendance_records (session_id, member_id, status) VALUES (?, ?, 'prezent')").run(before["2027-01-20"].id, M.a.id);
  db.prepare("UPDATE attendance_sessions SET reminded_24h = 1 WHERE id = ?").run(before["2027-01-27"].id);

  // 18:00 -> 19:00 local, decided on 2027-01-10 (the 01-06 session is past)
  const updated = eventsSvc.update(M.tl, ev.id, { start_time: "2027-01-06T17:00:00.000Z", end_time: "2027-01-06T19:00:00.000Z" }, Date.parse("2027-01-10T12:00:00Z"));
  const after = byDate();
  assert.deepEqual(Object.keys(after), ["2027-01-06", "2027-01-13", "2027-01-20", "2027-01-27"], "no duplicates");
  assert.equal(after["2027-01-06"].start_time, "18:00", "past session untouched");
  assert.equal(after["2027-01-13"].id, before["2027-01-13"].id, "moved in place");
  assert.equal(after["2027-01-13"].start_time, "19:00");
  assert.equal(after["2027-01-20"].start_time, "18:00", "session with records untouched");
  assert.deepEqual(updated.stale_sessions.map((x) => x.id), [before["2027-01-20"].id], "reported");
  assert.equal(after["2027-01-27"].start_time, "19:00");
  assert.equal(after["2027-01-27"].reminded_24h, 0, "reminder flags reset");

  env.waSent.length = 0;
  await scheduler.tick(new Date("2027-01-12T17:30:00Z")); // 23.5 h before 17:00Z (and 22.5 h before the old 16:00Z)
  await scheduler.tick(new Date("2027-01-13T16:30:00Z")); // 30 min before the new time
  const forThe13th = env.waSent.filter((m) => /13\.01\.2027/.test(m.text));
  assert.equal(forThe13th.length, 2, "one 24 h + one 1 h reminder");
  assert.ok(forThe13th.every((m) => /19:00/.test(m.text)), forThe13th.map((m) => m.text).join(" | "));
  drop(ev);
});

// Fix round 4: a shift by whole weeks (or any shift) keeps every future session - the old in-place loop
// collided each moved row with its not-yet-moved sibling and deleted it.
function seriesFrom(title, startIso, untilDate) {
  const s = Date.parse(startIso);
  return eventsSvc.create(M.tl, { title, type: "sedinta", start_time: new Date(s).toISOString(), end_time: new Date(s + 2 * 3600000).toISOString(), recurrence: "weekly", recurrence_until: untilDate });
}
for (const [label, shiftDays, expected] of [
  ["+7 days", 7, ["2027-02-10", "2027-02-17", "2027-02-24", "2027-03-03"]],
  ["-7 days", -7, ["2027-01-27", "2027-02-03", "2027-02-10", "2027-02-17", "2027-02-24"]], // 02-24: still inside `until`, generated
  ["+1 day", 1, ["2027-02-04", "2027-02-11", "2027-02-18", "2027-02-25"]],
]) {
  test(`series shifted ${label} with the same time: all future sessions preserved and moved`, () => {
    const ev = seriesFrom(`Shift ${label}`, "2027-02-03T16:00:00.000Z", "2027-02-24"); // Wed 18:00 local x4
    const ids = sessionsOf(ev).map((x) => x.id);
    assert.equal(ids.length, 4);
    const newStart = Date.parse("2027-02-03T16:00:00.000Z") + shiftDays * 86400000;
    const res = eventsSvc.update(M.tl, ev.id, { start_time: new Date(newStart).toISOString(), end_time: new Date(newStart + 2 * 3600000).toISOString() }, Date.parse("2027-01-20T12:00:00Z"));
    const after = sessionsOf(ev);
    assert.deepEqual(after.map((x) => x.date), expected);
    assert.deepEqual(after.slice(0, 4).map((x) => x.id).sort((p, q) => p - q), [...ids].sort((p, q) => p - q), "the 4 original rows moved, none lost");
    assert.deepEqual(after.slice(0, 4).map((x) => x.id), ids, "each row moved by the shift (order kept)");
    assert.ok(after.every((x) => x.start_time === "18:00"));
    assert.deepEqual(res.stale_sessions, []);
    drop(ev);
  });
}

test("series move onto a genuinely pre-existing identical session: the moving empty row is dropped, with a log line", () => {
  const ev = seriesFrom("Dup", "2027-03-03T16:00:00.000Z", "2027-03-17"); // 03-03, 03-10, 03-17
  const ids = sessionsOf(ev).map((x) => x.id);
  const other = db.prepare("INSERT INTO attendance_sessions (date, start_time, type, title) VALUES ('2027-03-11', '18:00', 'sedinta', 'Manual')").run().lastInsertRowid;
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    eventsSvc.update(M.tl, ev.id, { start_time: "2027-03-04T16:00:00.000Z", end_time: "2027-03-04T18:00:00.000Z" }, Date.parse("2027-02-20T12:00:00Z"));
  } finally { console.warn = realWarn; }
  assert.deepEqual(sessionsOf(ev).map((x) => x.date), ["2027-03-04", "2027-03-18"]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attendance_sessions WHERE id = ?").get(ids[1]).c, 0, "the 03-10 row that would duplicate 03-11 is removed");
  assert.ok(db.prepare("SELECT 1 FROM attendance_sessions WHERE id = ?").get(other), "pre-existing session kept");
  assert.ok(warnings.some((w) => /duplicate/.test(w) && w.includes(String(ids[1]))), warnings.join(" | "));
  db.prepare("DELETE FROM attendance_sessions WHERE id = ?").run(other);
  drop(ev);
});
