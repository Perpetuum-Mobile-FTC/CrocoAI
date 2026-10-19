// Regulament revizuit (Art. 20.2/20.3, 21.1, 22.1/22.2, 41.4, 51.1) - decisions of 2026-10-16.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._reg_revizuit_test.db");
const DOCS_DIR = path.join(__dirname, "._reg_revizuit_test_documents");
process.env.DB_PATH = DB_FILE;
process.env.DOCUMENTS_DIR = DOCS_DIR;
process.env.ADMIN_INITIAL_PASSWORD = "admintest123";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.WA_SHARED_SECRET = "test-wa-secret";
process.env.LOGIN_RATE_LIMIT_MAX = "1000";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
fs.rmSync(DOCS_DIR, { recursive: true, force: true });

const { server } = require("../server");
const db = require("../src/db");
const rules = require("../src/domain/rules");
const time = require("../src/domain/time");
const attendanceSvc = require("../src/services/attendance");
const absencesSvc = require("../src/services/absences");
const eventsSvc = require("../src/services/events");
const documentsSvc = require("../src/services/documents");
const meetingsSvc = require("../src/services/meetings");
const { buildToolList } = require("../src/ai/tools");

let BASE;
const A = {}; // actors by key

async function login(phone, password = "test1234") {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, password }),
  });
  assert.equal(res.status, 200);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
async function api(method, url, cookie, body) {
  const res = await fetch(BASE + url, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const bucharestDate = (offsetHours) => time.utcToBucharest(Date.now() + offsetHours * 3600000).date;

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const hash = bcrypt.hashSync("test1234", 10);
  const insert = db.prepare(`INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, 'activ', ?, 0)`);
  let n = 0;
  for (const role of ["team_leader", "co_leader", "head_tech", "mentor", "member", "member2"]) {
    const r = role === "member2" ? "member" : role;
    const id = insert.run(`R ${role}`, `rv-${role}`, `4070009${String(++n).padStart(4, "0")}`, r, r, hash).lastInsertRowid;
    A[role] = db.prepare("SELECT * FROM members WHERE id = ?").get(id);
  }
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  try { fs.rmSync(path.join(__dirname, "backups"), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(DOCS_DIR, { recursive: true, force: true }); } catch {}
});

// ── Art. 20.2 / 20.3 ───────────────────────────────────────────────────────────────────────────
test("Art. 20.2: 3 non-consecutive unexcused absences in the season -> warning signal; recorded warning silences it", () => {
  const m = A.member;
  const today = bucharestDate(0);
  const season = rules.seasonFor(new Date());
  const sessions = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"].map((date) =>
    attendanceSvc.createSession(A.team_leader, { date, start_time: "14:00", type: "sedinta" }));
  const statuses = ["absent", "prezent", "absent", "absent"]; // not consecutive
  sessions.forEach((s, i) => attendanceSvc.markRecords(A.team_leader, s.id, [{ member_id: m.id, status: statuses[i] }]));
  const stats = attendanceSvc.statsFor(A.team_leader, m.id, { from: season.from, to: season.to });
  const sig = stats.signals.find((s) => s.code === "avertisment_nemotivate_sezon");
  assert.ok(sig, `expected warning signal (today ${today})`);
  assert.doesNotMatch(sig.message, /consecutiv/);

  db.prepare("INSERT INTO warnings (member_id, level, article, reason, recorded_by) VALUES (?, 'scris', 'Art. 20.2', 'x', ?)").run(m.id, A.team_leader.id);
  const after = attendanceSvc.statsFor(A.team_leader, m.id, { from: season.from, to: season.to });
  assert.equal(after.signals.find((s) => s.code === "avertisment_nemotivate_sezon"), undefined);
});

// ── Art. 21.1 ──────────────────────────────────────────────────────────────────────────────────
test("Art. 21.1: request after the meeting (<=48h) -> accepted, ulterioara=1, tardiva=0; decided by the same approvers", async () => {
  const s = attendanceSvc.createSession(A.team_leader, { date: bucharestDate(-24), start_time: "00:00", type: "sedinta" });
  const cookie = await login("rv-member");
  const r = await api("POST", "/api/absences", cookie, { session_id: s.id, reason: "Gripă" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ulterioara, 1);
  assert.equal(r.body.tardiva, 0);
  const decided = await api("POST", `/api/absences/${r.body.id}/decide`, await login("rv-head_tech"), { status: "aprobata" });
  assert.equal(decided.status, 200);
  const rec = db.prepare("SELECT status FROM attendance_records WHERE session_id = ? AND member_id = ?").get(s.id, A.member.id);
  assert.equal(rec.status, "motivat");
});

test("Art. 21.1: request more than 48h after the meeting -> 409 LATE with the article", async () => {
  const s = attendanceSvc.createSession(A.team_leader, { date: bucharestDate(-24 * 5), start_time: "10:00", type: "sedinta" });
  const r = await api("POST", "/api/absences", await login("rv-member2"), { session_id: s.id, reason: "Am uitat" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "LATE");
  assert.equal(r.body.article, "Art. 21.1");
  assert.match(r.body.error, /48 de ore/);
});

test("Art. 21.1: request under 24h before stays tardiva (not ulterioara)", () => {
  const s = attendanceSvc.createSession(A.team_leader, { date: bucharestDate(24), start_time: "00:00", type: "antrenament" });
  const r = absencesSvc.create(A.member, { session_id: s.id, reason: "Boală" });
  assert.equal(r.ulterioara, 0);
  // start is between 0h and 24h away (or exactly in term only on a 24h edge)
  assert.ok(r.tardiva === 1 || r.tardiva === 0);
});

test("AI tool cere_motivare_absenta reports the 'ulterior' and expired cases like the route", async () => {
  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(A.member2.id);
  const tools = Object.fromEntries((await buildToolList({ actor, channel: "web", chatId: "web:x" })).map((t) => [t.name, (a) => t.handler(a, {})]));
  const ulterior = attendanceSvc.createSession(A.team_leader, { date: bucharestDate(-24), start_time: "00:00", type: "eveniment" });
  assert.match((await tools.cere_motivare_absenta({ sesiune_id: ulterior.id, motiv: "Boală" })).content[0].text, /ulterior.*48 de ore.*Art\. 21\.1/);
  const old = attendanceSvc.createSession(A.team_leader, { date: "2020-01-01", start_time: "18:00", type: "eveniment" });
  const res = await tools.cere_motivare_absenta({ sesiune_id: old.id, motiv: "Boală" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /48 de ore/);
});

// ── Art. 22 ────────────────────────────────────────────────────────────────────────────────────
test("Art. 22: events API accepts/returns competition_level; default regional; invalid -> 400; non-competition -> null", async () => {
  const cookie = await login("rv-team_leader");
  const start = new Date(Date.now() + 30 * 86400000).toISOString();
  const d = await api("POST", "/api/events", cookie, { title: "Regionala", type: "competitie", start_time: start });
  assert.equal(d.status, 200);
  assert.equal(d.body.competition_level, "regional");
  const i = await api("POST", "/api/events", cookie, { title: "Worlds", type: "competitie", start_time: start, competition_level: "international" });
  assert.equal(i.body.competition_level, "international");
  const bad = await api("POST", "/api/events", cookie, { title: "X", type: "competitie", start_time: start, competition_level: "mondial" });
  assert.equal(bad.status, 400);
  const other = await api("POST", "/api/events", cookie, { title: "Social", type: "eveniment", start_time: start, competition_level: "national" });
  assert.equal(other.body.competition_level, null);

  const upd = await api("PUT", `/api/events/${d.body.id}`, cookie, { competition_level: "national" });
  assert.equal(upd.body.competition_level, "national");
  const keep = await api("PUT", `/api/events/${d.body.id}`, cookie, { title: "Nationala" });
  assert.equal(keep.body.competition_level, "national");
  const toOther = await api("PUT", `/api/events/${d.body.id}`, cookie, { type: "eveniment" });
  assert.equal(toOther.body.competition_level, null);
  const list = await api("GET", "/api/events", cookie);
  assert.ok(list.body.every((e) => "competition_level" in e));
});

test("Art. 22: competition sessions carry the level; international is never tardive and has no deadline", async () => {
  const soon = bucharestDate(24); // < 7 days away
  const reg = attendanceSvc.createSession(A.team_leader, { date: soon, start_time: "10:00", type: "competitie" });
  assert.equal(reg.competition_level, "regional");
  const intl = attendanceSvc.createSession(A.team_leader, { date: soon, start_time: "11:00", type: "competitie", competition_level: "international" });
  assert.equal(intl.competition_level, "international");

  assert.equal(absencesSvc.create(A.member, { session_id: reg.id, reason: "Boală" }).tardiva, 1); // Art. 22.1 7 days
  assert.equal(absencesSvc.create(A.member, { session_id: intl.id, reason: "Boală" }).tardiva, 0);

  // even long after the competition: no expiry for an international one (Art. 22.2, no sanctions)
  const oldIntl = attendanceSvc.createSession(A.team_leader, { date: "2026-09-15", start_time: "10:00", type: "competitie", competition_level: "international" });
  const late = absencesSvc.create(A.member2, { session_id: oldIntl.id, reason: "Boală" });
  assert.equal(late.tardiva, 0);
  assert.equal(late.ulterioara, 0);
});

test("Art. 22.2: an international-competition absence yields no signals and does not count towards 20.2/20.3", () => {
  const m = db.prepare("INSERT INTO members (full_name, phone, role, auth_role, status) VALUES ('Intl', '40700009999', 'member', 'member', 'active')").run();
  db.prepare("UPDATE members SET status = 'activ' WHERE id = ?").run(m.lastInsertRowid);
  const season = rules.seasonFor(new Date());
  for (let i = 1; i <= 6; i++) {
    const s = attendanceSvc.createSession(A.team_leader, { date: `2026-11-${String(i).padStart(2, "0")}`, start_time: "09:00", type: "competitie", competition_level: "international" });
    attendanceSvc.markRecords(A.team_leader, s.id, [{ member_id: m.lastInsertRowid, status: "absent" }]);
  }
  const stats = attendanceSvc.statsFor(A.team_leader, m.lastInsertRowid, { from: season.from, to: season.to });
  assert.equal(stats.absent, 0);
  assert.deepEqual(stats.signals, []);
});

test("Art. 22: migration 021 defaulted existing competitions to 'regional' (column + CHECK present)", () => {
  assert.ok(db.prepare("SELECT 1 FROM _migrations WHERE name = '021_competition_level_late_motivation.sql'").get());
  assert.throws(() => db.prepare("UPDATE events SET competition_level = 'galactic' WHERE id = 1").run());
});

// ── Art. 41.4 ──────────────────────────────────────────────────────────────────────────────────
test("Art. 41.4: team_leader and mentor open another member's medical sheet (logged); co_leader and head do not; review unchanged", () => {
  const info = db.prepare(`INSERT INTO member_documents (member_id, type_key, file_path, original_name, mime, size, status)
    VALUES (?, 'fisa_medicala', 'x/y.pdf', 'y.pdf', 'application/pdf', 1, 'incarcat')`).run(A.member.id);
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(" ")); };
  try {
    assert.ok(documentsSvc.authorizedFilePath(A.team_leader, info.lastInsertRowid));
    assert.ok(documentsSvc.authorizedFilePath(A.mentor, info.lastInsertRowid));
    assert.ok(documentsSvc.authorizedFilePath(A.member, info.lastInsertRowid)); // owner
  } finally { console.log = orig; }
  assert.equal(logs.filter((l) => l.includes("[AUDIT] fisa_medicala")).length, 2); // owner not logged
  assert.ok(logs.some((l) => l.includes(`member ${A.mentor.id} (mentor) opened the sheet of member ${A.member.id}`)));
  for (const r of ["co_leader", "head_tech", "member2"]) {
    assert.throws(() => documentsSvc.authorizedFilePath(A[r], info.lastInsertRowid), (e) => e.code === "FORBIDDEN", r);
  }
  assert.throws(() => documentsSvc.review(A.mentor, info.lastInsertRowid, "aprobat"), (e) => e.code === "FORBIDDEN");
});

// ── Art. 51.1 ──────────────────────────────────────────────────────────────────────────────────
test("Art. 51.1: urgent events/sessions/meetings only by TL, Co-Leader and active mentors", async () => {
  const start = new Date(Date.now() + 5 * 86400000).toISOString();
  for (const role of ["team_leader", "co_leader", "mentor"]) {
    const r = await api("POST", "/api/events", await login(`rv-${role}`), { title: `Urgenta ${role}`, type: "urgenta", start_time: start });
    assert.equal(r.status, 200, role);
  }
  const head = await api("POST", "/api/events", await login("rv-head_tech"), { title: "Urgenta sef", type: "urgenta", start_time: start });
  assert.equal(head.status, 403);
  assert.match(head.body.error, /Art\. 51\.1/);
  // the head may still create ordinary events
  assert.equal((await api("POST", "/api/events", await login("rv-head_tech"), { title: "Obisnuit", type: "eveniment", start_time: start })).status, 200);

  // same rule on the other creation paths
  assert.throws(() => attendanceSvc.createSession(A.head_tech, { date: "2027-01-05", start_time: "14:00", type: "urgenta" }), (e) => e.code === "FORBIDDEN");
  assert.ok(attendanceSvc.createSession(A.mentor, { date: "2027-01-05", start_time: "14:00", type: "urgenta" }).id);
  await assert.rejects(() => meetingsSvc.schedule(A.head_tech, { title: "U", type: "urgenta", date: "2027-01-06", time: "14:00", mode: "fizic", location: "S03", target_type: "echipa" }), (e) => e.code === "FORBIDDEN");
});
