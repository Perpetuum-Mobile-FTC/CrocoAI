// Cleanup package F1: permissions on /api/auth/me, per-row rights (photos, documents matrix), dead routes gone.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers, login } = require("./_assign-env");

const env = initEnv("curatenie_f1");
const AUDIO_DIR = path.join(__dirname, "._curatenie_f1_audio");
process.env.MEETINGS_AUDIO_DIR = AUDIO_DIR;
const { server } = require("../server");
const db = require("../src/db");
const { UI_ACTIONS } = require("../src/domain/policy");

let BASE;
let M;
before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "co", role: "co_leader" },
    { key: "mentor", role: "mentor" },
    { key: "head", role: "head_tech", department: "tehnic" },
    { key: "a", role: "member" },
    { key: "b", role: "member" },
    { key: "pausedTl", role: "team_leader", status: "pauza" },
  ]);
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  env.cleanup();
  fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
});

const getJson = async (p, cookie) => {
  const res = await fetch(`${BASE}${p}`, { headers: { Cookie: cookie } });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

test("GET /api/auth/me carries a flat permissions map (UI_ACTIONS), computed by policy incl. status", async () => {
  const tl = (await getJson("/api/auth/me", await login(BASE, M.tl.phone))).body;
  assert.deepEqual(Object.keys(tl.permissions).sort(), [...UI_ACTIONS].sort());
  assert.ok(Object.values(tl.permissions).every((v) => typeof v === "boolean"));
  assert.equal(tl.permissions["members.manage"], true);
  assert.equal(tl.permissions["audit_log.view"], true);
  assert.equal(tl.permissions["events.manage_urgenta"], true);

  const member = (await getJson("/api/auth/me", await login(BASE, M.a.phone))).body;
  assert.ok(Object.values(member.permissions).every((v) => v === false), "a plain member has none of the UI rights");

  const mentor = (await getJson("/api/auth/me", await login(BASE, M.mentor.phone))).body.permissions;
  assert.equal(mentor["events.manage"], false);
  assert.equal(mentor["events.manage_urgenta"], true);
  assert.equal(mentor["documents.medical_other"], true);
  assert.equal(mentor["documents.review"], false);

  // A paused Team Leader keeps the role label but none of the rights (A5) - the UI now follows that too.
  const paused = (await getJson("/api/auth/me", await login(BASE, M.pausedTl.phone))).body;
  assert.equal(paused.role, "team_leader");
  assert.equal(paused.permissions["members.manage"], false);
});

test("photo list carries per-photo rights: uploader / MANAGERS tag, uploader / LEADERS delete and download the original", async () => {
  const album = db.prepare("INSERT INTO albums (title, created_by) VALUES ('F1', ?)").run(M.a.id).lastInsertRowid;
  const ins = db.prepare("INSERT INTO photos (album_id, file_path, mime, media_type, size, uploaded_by) VALUES (?, 'x.jpg', 'image/jpeg', 'image', 1, ?)");
  const own = ins.run(album, M.a.id).lastInsertRowid;
  const other = ins.run(album, M.b.id).lastInsertRowid;
  const flags = async (who) => {
    const list = (await getJson(`/api/photos/albums/${album}/photos`, await login(BASE, who.phone))).body;
    const pick = (id) => { const p = list.find((x) => x.id === id); return [p.can_tag, p.can_delete, p.can_download_original]; };
    return { own: pick(own), other: pick(other) };
  };
  assert.deepEqual(await flags(M.a), { own: [true, true, true], other: [false, false, false] });
  assert.deepEqual(await flags(M.head), { own: [true, false, false], other: [true, false, false] });
  assert.deepEqual(await flags(M.co), { own: [true, true, true], other: [true, true, true] });
});

test("documents matrix: can_open per document - someone else's medical sheet only for TL (mentor is not LEADERS)", async () => {
  const ins = db.prepare("INSERT INTO member_documents (member_id, type_key, file_path, original_name, mime, size) VALUES (?, ?, 'f.pdf', 'f.pdf', 'application/pdf', 1)");
  ins.run(M.b.id, "fisa_medicala");
  ins.run(M.b.id, "anexa5_confidentialitate");
  const cell = (matrix, key) => matrix.find((r) => r.member_id === M.b.id).documents.find((d) => d.key === key);
  const tlMatrix = (await getJson("/api/documents/matrix", await login(BASE, M.tl.phone))).body;
  assert.equal(cell(tlMatrix, "fisa_medicala").can_open, true);
  assert.equal(cell(tlMatrix, "anexa5_confidentialitate").can_open, true);
  const coMatrix = (await getJson("/api/documents/matrix", await login(BASE, M.co.phone))).body;
  assert.equal(cell(coMatrix, "fisa_medicala").can_open, false, "Art. 41.4: co-leader sees the status, not the file");
  assert.equal(cell(coMatrix, "anexa5_confidentialitate").can_open, true);
  assert.equal(cell(coMatrix, "first_policies").can_open, false, "nothing uploaded -> nothing to open");
});

test("dead routes are gone: /api/members/overview, /api/drive/*", async () => {
  const cookie = await login(BASE, M.tl.phone);
  for (const p of ["/api/members/overview", "/api/drive/health", "/api/drive/folders", "/api/drive/files"]) {
    assert.equal((await getJson(p, cookie)).status, 404, p);
  }
});

test("GET /api/admin/members stays LEADERS only (now through services/members.adminList)", async () => {
  assert.equal((await getJson("/api/admin/members", await login(BASE, M.a.phone))).status, 403);
  const rows = (await getJson("/api/admin/members", await login(BASE, M.co.phone))).body;
  assert.ok(rows.some((r) => r.id === M.b.id && r.phone === M.b.phone && "last_login" in r));
});

// ─── GDPR: persistent access log for medical sheets (Art. 41.2, 41.4) ───

test("opening someone else's medical sheet writes an audit_log row (owner's own open does not); only the TL lists it", async () => {
  const documents = require("../src/services/documents");
  const auditLog = require("../src/services/audit-log");
  db.prepare("DELETE FROM audit_log").run();
  const doc = db.prepare(`INSERT INTO member_documents (member_id, type_key, file_path, original_name, mime, size)
    VALUES (?, 'fisa_medicala', 'm.pdf', 'm.pdf', 'application/pdf', 1)`).run(M.a.id).lastInsertRowid;
  const orig = console.log;
  console.log = () => {};
  try {
    documents.authorizedFilePath(M.mentor, doc);
    documents.authorizedFilePath(M.a, doc); // owner: not logged
    assert.throws(() => documents.authorizedFilePath(M.co, doc), (e) => e.code === "FORBIDDEN"); // refused: nothing opened
  } finally { console.log = orig; }
  const rows = db.prepare("SELECT * FROM audit_log").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_id, M.mentor.id);
  assert.equal(rows[0].actor_role, "mentor");
  assert.equal(rows[0].action, "fisa_medicala.open");
  assert.equal(rows[0].member_id, M.a.id);
  assert.equal(rows[0].object_id, Number(doc));

  const list = auditLog.list(M.tl);
  assert.equal(list[0].actor_name, M.mentor.full_name);
  assert.equal(list[0].member_name, M.a.full_name);
  for (const who of [M.co, M.mentor, M.a, M.pausedTl]) {
    assert.throws(() => auditLog.list(who), (e) => e.code === "FORBIDDEN");
  }
  const http = await getJson("/api/admin/audit-log", await login(BASE, M.tl.phone));
  assert.equal(http.status, 200);
  assert.equal(http.body.length, 1);
  assert.equal((await getJson("/api/admin/audit-log", await login(BASE, M.co.phone))).status, 403);
});

// ─── GDPR: retention job (rules.RETENTION) ───

test("retention: deletes only what is past its period, keeps the rest and ai_usage aggregates; idempotent; logs counts", () => {
  const retention = require("../src/services/retention");
  const rules = require("../src/domain/rules");
  const now = new Date("2027-06-15T03:30:00Z");
  const daysAgo = (d) => new Date(now.getTime() - d * 86400000).toISOString();
  const R = rules.RETENTION;
  assert.equal(R.rejectedApplications.months, 6);
  assert.equal(R.messageLogs.days, 90);
  assert.equal(R.meetingAudio.daysAfterApproval, 30);
  assert.equal(R.oldTeamChat.days, 90);
  assert.equal(R.auditLog.years, 2);
  const auditOld = db.prepare("INSERT INTO audit_log (actor_id, action, member_id, created_at) VALUES (?, 'fisa_medicala.open', ?, ?)").run(M.tl.id, M.a.id, daysAgo(800)).lastInsertRowid;
  const auditNew = db.prepare("INSERT INTO audit_log (actor_id, action, member_id, created_at) VALUES (?, 'fisa_medicala.open', ?, ?)").run(M.tl.id, M.a.id, daysAgo(600)).lastInsertRowid;

  // Applications: rejected > 6 months -> deleted; recent rejected, pending, accepted -> kept.
  const app = db.prepare(`INSERT INTO applications (full_name, phone, email, birthdate, class, school, department, motivation,
    gdpr_ack_at, ip_hash, status, decided_at, created_at) VALUES ('X', ?, 'x@x.ro', '2010-01-01', '9', 'S', 'tehnic', 'm', ?, 'h', ?, ?, ?)`);
  const oldRejected = app.run("40711000001", daysAgo(400), "respinsa", daysAgo(200), daysAgo(400)).lastInsertRowid;
  const newRejected = app.run("40711000002", daysAgo(100), "respinsa", daysAgo(100), daysAgo(100)).lastInsertRowid;
  const oldPending = app.run("40711000003", daysAgo(400), "in_asteptare", null, daysAgo(400)).lastInsertRowid;
  const oldAccepted = app.run("40711000004", daysAgo(400), "acceptata", daysAgo(400), daysAgo(400)).lastInsertRowid;

  // Logs older than 90 days -> deleted; ai_usage untouched.
  db.prepare("INSERT INTO messages (chat_id, body, created_at) VALUES ('c', 'old', ?), ('c', 'new', ?)").run(daysAgo(91), daysAgo(10));
  db.prepare("INSERT INTO wa_message_log (msg_id, created_at) VALUES ('old-1', ?), ('new-1', ?)").run(daysAgo(91), daysAgo(10));
  db.prepare("INSERT INTO web_chat_messages (member_id, message_type, body, created_at) VALUES (?, 'web-user', 'old', ?), (?, 'web-user', 'new', ?)")
    .run(M.a.id, daysAgo(91), M.a.id, daysAgo(10));
  db.prepare("INSERT INTO ai_flags (member_id, channel, category, created_at) VALUES (?, 'web', 'off_topic', ?), (?, 'web', 'limita', ?)")
    .run(M.a.id, daysAgo(91), M.a.id, daysAgo(10));
  const usageBefore = db.prepare("SELECT COUNT(*) c FROM ai_usage").get().c;
  db.prepare("INSERT INTO ai_usage (member_id, channel, cost_usd, created_at) VALUES (?, 'web', 0.01, ?)").run(M.a.id, daysAgo(400));

  // Meeting audio: approved > 30 days ago -> files gone, transcript kept; approved recently / draft -> kept.
  const meeting = (date, status, approvedDaysAgo) => {
    const sid = db.prepare("INSERT INTO attendance_sessions (date, type, title) VALUES (?, 'sedinta', 'S')").run(date).lastInsertRowid;
    const id = db.prepare(`INSERT INTO meetings (session_id, audio_path, audio_status, transcript, status, approved_at)
      VALUES (?, ?, 'done', 'transcriere', ?, ?)`).run(sid, null, status, approvedDaysAgo === null ? null : daysAgo(approvedDaysAgo)).lastInsertRowid;
    const dir = path.join(AUDIO_DIR, String(id));
    fs.mkdirSync(path.join(dir, "rec-1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "audio.webm"), "x");
    fs.writeFileSync(path.join(dir, "rec-1", "0.part"), "x");
    db.prepare("UPDATE meetings SET audio_path = ? WHERE id = ?").run(`${id}/audio.webm`, id);
    return { id, dir };
  };
  const oldApproved = meeting("2027-04-01", "approved", 45);
  const newApproved = meeting("2027-06-01", "approved", 5);
  const draft = meeting("2027-03-01", "draft", null);

  // Old team chat history (pachet B removed the UI): messages > 90 days and conversations left empty -> deleted.
  const conv = db.prepare("INSERT INTO chat_conversations (type, name, created_at) VALUES ('group', 'vechi', ?)").run(daysAgo(200)).lastInsertRowid;
  const conv2 = db.prepare("INSERT INTO chat_conversations (type, name, created_at) VALUES ('group', 'mixt', ?)").run(daysAgo(200)).lastInsertRowid;
  db.prepare("INSERT INTO chat_participants (conversation_id, member_id) VALUES (?, ?)").run(conv, M.a.id);
  const oldMsg = db.prepare("INSERT INTO chat_messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, 'old', ?)").run(conv, M.a.id, daysAgo(150)).lastInsertRowid;
  db.prepare("INSERT INTO chat_reports (message_id, reported_by, created_at) VALUES (?, ?, ?)").run(oldMsg, M.b.id, daysAgo(150));
  db.prepare("INSERT INTO chat_messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, 'old2', ?)").run(conv2, M.a.id, daysAgo(150));
  db.prepare("INSERT INTO chat_messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, 'recent', ?)").run(conv2, M.a.id, daysAgo(20));

  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let counts;
  let again;
  try {
    counts = retention.run(now);
    again = retention.run(now);
  } finally { console.log = orig; }

  assert.deepEqual(counts, {
    rejected_applications: 1, messages: 1, wa_message_log: 1, web_chat_messages: 1, ai_flags: 1,
    meeting_audio: 1, chat_messages: 2, chat_conversations: 1, audit_log: 1, medical_destroyed: 0, medical_orphans_removed: 0, medical_file_failures: 0,
  });
  assert.equal(db.prepare("SELECT 1 FROM audit_log WHERE id = ?").get(auditOld), undefined, "audit rows > 2 years deleted");
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE id = ?").get(auditNew), "audit rows < 2 years kept");
  assert.ok(Object.values(again).every((n) => n === 0), "second run deletes nothing (idempotent)");
  assert.ok(logs.some((l) => l.startsWith("[RETENTION]") && l.includes("rejected_applications=1")), "counts are logged");

  const appIds = db.prepare("SELECT id FROM applications").all().map((r) => r.id);
  assert.ok(!appIds.includes(Number(oldRejected)));
  for (const id of [newRejected, oldPending, oldAccepted]) assert.ok(appIds.includes(Number(id)));
  assert.deepEqual(db.prepare("SELECT body FROM messages WHERE chat_id = 'c'").all().map((r) => r.body), ["new"]);
  assert.deepEqual(db.prepare("SELECT msg_id FROM wa_message_log WHERE msg_id IN ('old-1','new-1')").all().map((r) => r.msg_id), ["new-1"]);
  assert.deepEqual(db.prepare("SELECT body FROM web_chat_messages WHERE member_id = ?").all(M.a.id).map((r) => r.body), ["new"]);
  assert.deepEqual(db.prepare("SELECT category FROM ai_flags WHERE member_id = ?").all(M.a.id).map((r) => r.category), ["limita"]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM ai_usage").get().c, usageBefore + 1, "ai_usage aggregates are kept");

  assert.equal(fs.existsSync(oldApproved.dir), false);
  const oldRow = db.prepare("SELECT * FROM meetings WHERE id = ?").get(oldApproved.id);
  assert.equal(oldRow.audio_path, null);
  assert.equal(oldRow.transcript, "transcriere", "the transcript stays with the PV");
  assert.ok(fs.existsSync(path.join(newApproved.dir, "audio.webm")));
  assert.ok(fs.existsSync(path.join(draft.dir, "audio.webm")));

  assert.equal(db.prepare("SELECT 1 FROM chat_conversations WHERE id = ?").get(conv), undefined);
  assert.ok(db.prepare("SELECT 1 FROM chat_conversations WHERE id = ?").get(conv2));
  assert.deepEqual(db.prepare("SELECT body FROM chat_messages WHERE conversation_id = ?").all(conv2).map((r) => r.body), ["recent"]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM chat_reports").get().c, 0);
  assert.ok(db.prepare("SELECT 1 FROM chat_conversations WHERE type = 'announce'").get(), "the old announce channel row is not touched");
});

test("retention.runDaily: once per Bucharest day, from 03:00 local", () => {
  const retention = require("../src/services/retention");
  const orig = console.log;
  console.log = () => {};
  try {
    retention._resetDaily();
    assert.equal(retention.runDaily(new Date("2027-07-01T23:30:00Z")), null, "02:30 Bucharest: not yet");
    assert.ok(retention.runDaily(new Date("2027-07-02T00:30:00Z")), "03:30 Bucharest: runs");
    assert.equal(retention.runDaily(new Date("2027-07-02T10:00:00Z")), null, "same day: skipped");
    assert.ok(retention.runDaily(new Date("2027-07-03T01:00:00Z")), "next day: runs again");
  } finally { console.log = orig; }
});

test("retention.runDaily: a failing run logs [RETENTION] error=... and is retried on the next tick (same day)", () => {
  const retention = require("../src/services/retention");
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  retention._resetDaily();
  db.exec("ALTER TABLE ai_flags RENAME TO ai_flags_off");
  try {
    assert.equal(retention.runDaily(new Date("2027-08-01T01:00:00Z")), null, "failed run returns null");
    assert.ok(logs.some((l) => l.startsWith("[RETENTION] error=")), "the failure is logged");
  } finally {
    db.exec("ALTER TABLE ai_flags_off RENAME TO ai_flags");
  }
  try {
    assert.ok(retention.runDaily(new Date("2027-08-01T01:01:00Z")), "next tick, same day: retried and done");
    assert.equal(retention.runDaily(new Date("2027-08-01T01:02:00Z")), null, "then skipped for the rest of the day");
  } finally { console.log = orig; }
});

test("GET /api/tasks rows carry can_edit / can_delete from policy (tasks.edit / tasks.delete)", async () => {
  db.prepare("DELETE FROM tasks").run();
  const ins = db.prepare("INSERT INTO tasks (title, assigned_member_id, created_by) VALUES (?, ?, ?)");
  const own = ins.run("al meu", M.a.id, M.a.id).lastInsertRowid;
  const given = ins.run("primit", M.a.id, M.tl.id).lastInsertRowid;
  const flags = async (who) => Object.fromEntries((await getJson("/api/tasks", await login(BASE, who.phone))).body
    .map((t) => [t.id, [t.can_edit, t.can_delete]]));
  assert.deepEqual(await flags(M.a), { [own]: [true, true], [given]: [false, true] });
  assert.deepEqual(await flags(M.head), { [own]: [true, true], [given]: [true, true] });
});
