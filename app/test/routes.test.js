// Route-level tests: starts the real app on an ephemeral port with a temp DB.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._routes_test.db");
const DOCS_DIR = path.join(__dirname, "._routes_test_documents");
process.env.DB_PATH = DB_FILE;
process.env.DOCUMENTS_DIR = DOCS_DIR;
process.env.ADMIN_INITIAL_PASSWORD = "admintest123";
process.env.ADMIN_PHONE = "40700000999";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.WA_SHARED_SECRET = "test-wa-secret";
process.env.LOGIN_RATE_LIMIT_MAX = "1000";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
fs.rmSync(DOCS_DIR, { recursive: true, force: true });

const { server } = require("../server");
const db = require("../src/db");

let BASE;
let coLeader, member, otherMember;

function cookieFrom(res) {
  const raw = res.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

async function login(phone, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  assert.equal(res.status, 200, `login failed for ${phone}: ${await res.text()}`);
  return cookieFrom(res);
}

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const hash = bcrypt.hashSync("test1234", 10);
  const insert = db.prepare(`
    INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, 'activ', ?, 0)
  `);
  // The seeded admin starts with must_change_password=1, enforced server-side since security package A1;
  // these tests act as an admin who already changed the initial password.
  db.prepare("UPDATE members SET must_change_password = 0 WHERE username = 'admin'").run();
  coLeader = insert.run("Co Leader", "coleader", "40700000010", "co_leader", "co_leader", hash).lastInsertRowid;
  member = insert.run("Membru Unu", "membru1", "40700000011", "member", "member", hash).lastInsertRowid;
  otherMember = insert.run("Membru Doi", "membru2", "40700000012", "member", "member", hash).lastInsertRowid;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  const backupDir = path.join(__dirname, "backups");
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(DOCS_DIR, { recursive: true, force: true }); } catch {}
});

test("login with wrong password fails", async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "admin", password: "wrong" }),
  });
  assert.equal(res.status, 401);
});

test("login accepts username or normalized phone", async () => {
  const cookie1 = await login("admin", "admintest123");
  assert.ok(cookie1);
  const cookie2 = await login("0700000999", "admintest123"); // local format, should normalize
  assert.ok(cookie2);
});

test("unauthenticated request -> 401 JSON", async () => {
  const res = await fetch(`${BASE}/api/tasks`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.ok(body.error);
});

test("unknown /api route -> 404 JSON, not HTML", async () => {
  const cookie = await login("admin", "admintest123");
  const res = await fetch(`${BASE}/api/does-not-exist`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /json/);
});

test("member cannot access admin member management (FORBIDDEN with Romanian message)", async () => {
  const cookie = await login("membru1", "test1234");
  const res = await fetch(`${BASE}/api/admin/members`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.ok(body.error);
});

test("member cannot create an attendance session, co_leader can", async () => {
  const memberCookie = await login("membru1", "test1234");
  const r1 = await fetch(`${BASE}/api/attendance/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: memberCookie },
    body: JSON.stringify({ date: "2026-09-10", type: "sedinta" }),
  });
  assert.equal(r1.status, 403);

  const leaderCookie = await login("coleader", "test1234");
  const r2 = await fetch(`${BASE}/api/attendance/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ date: "2026-09-10", start_time: "18:00", type: "sedinta" }),
  });
  assert.equal(r2.status, 200);
  const session = await r2.json();

  const r3 = await fetch(`${BASE}/api/attendance/sessions/${session.id}/records`, {
    method: "PUT", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ records: [{ member_id: member, status: "prezent" }, { member_id: otherMember, status: "absent" }] }),
  });
  assert.equal(r3.status, 200);

  const r4 = await fetch(`${BASE}/api/attendance/stats?member_id=${member}&from=2026-09-01&to=2026-09-30`, { headers: { Cookie: leaderCookie } });
  assert.equal(r4.status, 200);
  const stats = await r4.json();
  assert.equal(stats.present, 1);
});

test("absence request lifecycle: on-time request, decided by manager", async () => {
  const memberCookie = await login("membru1", "test1234");
  const future = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const r1 = await fetch(`${BASE}/api/absences`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: memberCookie },
    body: JSON.stringify({ date: future, reason: "Examen" }),
  });
  assert.equal(r1.status, 200);
  const request = await r1.json();
  assert.equal(request.tardiva, 0);

  const leaderCookie = await login("coleader", "test1234");
  const r2 = await fetch(`${BASE}/api/absences/${request.id}/decide`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ status: "aprobata" }),
  });
  assert.equal(r2.status, 200);
  const decided = await r2.json();
  assert.equal(decided.status, "aprobata");

  // a member cannot decide their own request
  const r3 = await fetch(`${BASE}/api/absences`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: memberCookie },
    body: JSON.stringify({ date: future, reason: "Alta cerere" }),
  });
  const req2 = await r3.json();
  const r4 = await fetch(`${BASE}/api/absences/${req2.id}/decide`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: memberCookie },
    body: JSON.stringify({ status: "aprobata" }),
  });
  assert.equal(r4.status, 403);
});

test("import preview then commit, matched by normalized phone", async () => {
  const leaderCookie = await login("coleader", "test1234");
  const rows = [{ name: "Noul Membru", phone: "0788888888" }, { name: "Membru Unu Actualizat", phone: "40700000011" }];
  const r1 = await fetch(`${BASE}/api/admin/import/preview`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ rows }),
  });
  assert.equal(r1.status, 200);
  const preview = await r1.json();
  assert.equal(preview[0].action, "create");
  assert.equal(preview[1].action, "update");

  const r2 = await fetch(`${BASE}/api/admin/import/commit`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ rows }),
  });
  assert.equal(r2.status, 200);
  const committed = await r2.json();
  assert.equal(committed.length, 2);
});

test("document upload + review authorization: member A cannot download member B's file", async () => {
  const cookieA = await login("membru1", "test1234");
  const cookieB = await login("membru2", "test1234");
  const leaderCookie = await login("coleader", "test1234");

  const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(100)]);
  const form = new FormData();
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "test.pdf");

  const up = await fetch(`${BASE}/api/documents/anexa5_confidentialitate/upload`, {
    method: "POST", headers: { Cookie: cookieA }, body: form,
  });
  const doc = await up.json();
  assert.equal(up.status, 200, JSON.stringify(doc));

  const dlOwn = await fetch(`${BASE}/api/documents/file/${doc.id}`, { headers: { Cookie: cookieA } });
  assert.equal(dlOwn.status, 200);

  const dlOther = await fetch(`${BASE}/api/documents/file/${doc.id}`, { headers: { Cookie: cookieB } });
  assert.equal(dlOther.status, 403);

  const dlLeader = await fetch(`${BASE}/api/documents/file/${doc.id}`, { headers: { Cookie: leaderCookie } });
  assert.equal(dlLeader.status, 200);

  const review = await fetch(`${BASE}/api/documents/${doc.id}/review`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ status: "aprobat" }),
  });
  assert.equal(review.status, 200);
});

test("medical sheet (fisa_medicala) download: only the owner or team_leader, NOT co_leader", async () => {
  const cookieA = await login("membru1", "test1234");
  const leaderTLCookie = await login("admin", "admintest123");
  const coLeaderCookie = await login("coleader", "test1234");

  const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(50)]);
  const form = new FormData();
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "fisa.pdf");
  const up = await fetch(`${BASE}/api/documents/fisa_medicala/upload`, { method: "POST", headers: { Cookie: cookieA }, body: form });
  assert.equal(up.status, 200);
  const doc = await up.json();

  const dlTL = await fetch(`${BASE}/api/documents/file/${doc.id}`, { headers: { Cookie: leaderTLCookie } });
  assert.equal(dlTL.status, 200);

  const dlCoLeader = await fetch(`${BASE}/api/documents/file/${doc.id}`, { headers: { Cookie: coLeaderCookie } });
  assert.equal(dlCoLeader.status, 403);
});

test("WA ingress: untracked group is dropped (handled:true, not logged)", async () => {
  const res = await fetch(`${BASE}/wa/incoming`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({ msgId: "m1", isGroup: true, groupId: "untracked@g.us", groupName: "Alt grup", text: "salut" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.handled, true);
  const count = db.prepare("SELECT COUNT(*) c FROM messages WHERE chat_id = 'untracked@g.us'").get().c;
  assert.equal(count, 0);
  const group = db.prepare("SELECT tracked FROM wa_groups WHERE group_id = 'untracked@g.us'").get();
  assert.equal(group.tracked, 0);
});

test("WA ingress: tracked group is logged", async () => {
  db.prepare("INSERT INTO wa_groups (group_id, name, tracked) VALUES ('tracked@g.us', 'Grup Echipa', 1)").run();
  const res = await fetch(`${BASE}/wa/incoming`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({ msgId: "m2", isGroup: true, groupId: "tracked@g.us", groupName: "Grup Echipa", text: "salut echipa" }),
  });
  assert.equal(res.status, 200);
  const count = db.prepare("SELECT COUNT(*) c FROM messages WHERE chat_id = 'tracked@g.us'").get().c;
  assert.equal(count, 1);
});

test("WA ingress: duplicate msgId is ignored (idempotency)", async () => {
  const before = db.prepare("SELECT COUNT(*) c FROM messages WHERE chat_id = 'tracked@g.us'").get().c;
  const res = await fetch(`${BASE}/wa/incoming`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({ msgId: "m2", isGroup: true, groupId: "tracked@g.us", groupName: "Grup Echipa", text: "salut echipa din nou" }),
  });
  assert.equal(res.status, 200);
  const after = db.prepare("SELECT COUNT(*) c FROM messages WHERE chat_id = 'tracked@g.us'").get().c;
  assert.equal(after, before);
});

test("WA ingress: wrong shared secret -> 403", async () => {
  const res = await fetch(`${BASE}/wa/incoming`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wa-secret": "wrong" },
    body: JSON.stringify({ msgId: "m3", from: "40711111111", text: "salut" }),
  });
  assert.equal(res.status, 403);
});

test("health endpoint returns checks object", async () => {
  const res = await fetch(`${BASE}/api/health`);
  const body = await res.json();
  assert.ok("db" in body.checks);
  assert.ok("scheduler" in body.checks);
  assert.ok("gateway" in body.checks);
  assert.ok("ai_configured" in body.checks);
});

test("attendance stats-all and absences list include member_name (API gap #1)", async () => {
  const leaderCookie = await login("coleader", "test1234");
  const r1 = await fetch(`${BASE}/api/attendance/stats`, { headers: { Cookie: leaderCookie } });
  assert.equal(r1.status, 200);
  const stats = await r1.json();
  assert.ok(stats.length > 0);
  assert.ok(stats.every((s) => typeof s.member_name === "string" && s.member_name.length > 0));

  const r2 = await fetch(`${BASE}/api/absences`, { headers: { Cookie: leaderCookie } });
  assert.equal(r2.status, 200);
  const absences = await r2.json();
  assert.ok(absences.length > 0);
  assert.ok(absences.every((a) => typeof a.member_name === "string" && a.member_name.length > 0));
});

test("documents matrix exposes document_id/uploaded_at/review_note so the leaders' UI can open+review from a cell (API gap #2)", async () => {
  const leaderCookie = await login("coleader", "test1234");
  const r = await fetch(`${BASE}/api/documents/matrix`, { headers: { Cookie: leaderCookie } });
  assert.equal(r.status, 200);
  const matrix = await r.json();
  const row = matrix.find((m) => m.documents.some((d) => d.document_id));
  assert.ok(row, "expected at least one uploaded document in the matrix (previous tests uploaded some)");
  const cell = row.documents.find((d) => d.document_id);
  assert.ok(cell.document_id);
  assert.ok(cell.uploaded_at);

  // the matrix-provided document_id works directly against the download + review endpoints
  const dl = await fetch(`${BASE}/api/documents/file/${cell.document_id}`, { headers: { Cookie: leaderCookie } });
  assert.equal(dl.status, 200);
  const review = await fetch(`${BASE}/api/documents/${cell.document_id}/review`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ status: "aprobat", note: "ok" }),
  });
  assert.equal(review.status, 200);

  const r2 = await fetch(`${BASE}/api/documents/matrix`, { headers: { Cookie: leaderCookie } });
  const matrix2 = await r2.json();
  const cell2 = matrix2.find((m) => m.member_id === row.member_id).documents.find((d) => d.document_id === cell.document_id);
  assert.equal(cell2.status, "aprobat");
  assert.equal(cell2.review_note, "ok");
});

test("GET /api/members includes team_ids per member (API gap #3)", async () => {
  const leaderCookie = await login("coleader", "test1234");
  const teamRes = await fetch(`${BASE}/api/teams`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ name: "Echipa Test" }),
  });
  assert.equal(teamRes.status, 200);
  const team = await teamRes.json();
  const addRes = await fetch(`${BASE}/api/teams/${team.id}/members`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ member_id: member }),
  });
  assert.equal(addRes.status, 200);

  const r = await fetch(`${BASE}/api/members`, { headers: { Cookie: leaderCookie } });
  const list = await r.json();
  const withTeam = list.find((m) => m.id === member);
  const without = list.find((m) => m.id === otherMember);
  assert.ok(Array.isArray(withTeam.team_ids));
  assert.ok(withTeam.team_ids.includes(team.id));
  assert.ok(Array.isArray(without.team_ids));
  assert.ok(!without.team_ids.includes(team.id));
});

test("GET /api/attendance/sessions/:id returns session+records+team-filtered roster with status (API gap #4)", async () => {
  const leaderCookie = await login("coleader", "test1234");
  const teamRes = await fetch(`${BASE}/api/teams`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ name: "Echipa Sesiune" }),
  });
  const team = await teamRes.json();
  await fetch(`${BASE}/api/teams/${team.id}/members`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ member_id: member }),
  });
  db.prepare("UPDATE members SET status = 'pauza' WHERE id = ?").run(member);

  const sessRes = await fetch(`${BASE}/api/attendance/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ date: "2026-09-15", type: "sedinta", team_id: team.id }),
  });
  assert.equal(sessRes.status, 200);
  const session = await sessRes.json();

  const detailRes = await fetch(`${BASE}/api/attendance/sessions/${session.id}`, { headers: { Cookie: leaderCookie } });
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.session.id, session.id);
  assert.ok(Array.isArray(detail.records));
  const rosterMember = detail.roster.find((r) => r.id === member);
  assert.ok(rosterMember, "team member should be in the roster");
  assert.equal(rosterMember.status, "pauza"); // lets the marking UI offer 'scutit'
  assert.equal(rosterMember.record, null);
  assert.ok(!detail.roster.some((r) => r.id === otherMember), "non-team member excluded from team-linked session roster");

  // plain member lacks OVERSIGHT -> 403
  const memberCookie = await login("membru2", "test1234");
  const forbidden = await fetch(`${BASE}/api/attendance/sessions/${session.id}`, { headers: { Cookie: memberCookie } });
  assert.equal(forbidden.status, 403);

  db.prepare("UPDATE members SET status = 'activ' WHERE id = ?").run(member);
});

test("AI web-chat exposes pending_confirmation structurally, not via reply-text heuristics (API gap #5)", async () => {
  const leaderCookie = await login("coleader", "test1234");
  const leaderRow = db.prepare("SELECT * FROM members WHERE phone = '40700000010'").get();
  const pendingSvc = require("../src/ai/pending");
  const chatId = `web:${leaderRow.id}`;
  pendingSvc.create(leaderRow, chatId, { to: "40711112222", message: "Salut echipa" });

  const r1 = await fetch(`${BASE}/api/ai/pending`, { headers: { Cookie: leaderCookie } });
  assert.equal(r1.status, 200);
  const body1 = await r1.json();
  assert.ok(body1.pending_confirmation);
  assert.match(body1.pending_confirmation.summary, /40711112222/);
  assert.ok(body1.pending_confirmation.expires_at);

  const r2 = await fetch(`${BASE}/api/ai/web-chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: leaderCookie },
    body: JSON.stringify({ message: "DA" }),
  });
  assert.equal(r2.status, 200);
  const body2 = await r2.json();
  assert.equal(body2.pending_confirmation, null);

  const r3 = await fetch(`${BASE}/api/ai/pending`, { headers: { Cookie: leaderCookie } });
  const body3 = await r3.json();
  assert.equal(body3.pending_confirmation, null);
});

test("oversized and malformed JSON bodies are client errors (413/400), not 500", async () => {
  const big = JSON.stringify({ phone: "a".repeat(6 * 1024 * 1024), password: "x" });
  const r1 = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
  assert.equal(r1.status, 413);
  const r2 = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
  assert.equal(r2.status, 400);
});
