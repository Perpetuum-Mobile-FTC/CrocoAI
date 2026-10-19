// Tool <-> route parity for the 3 meetings AI tools (design-phase2.md §4), same pattern as
// test/ai-consistency.test.js: starts the real app, calls both the HTTP route and the tool
// handler directly, and checks they agree.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._meetings_ai_consistency_test.db");
const DOCS_DIR = path.join(__dirname, "._meetings_ai_consistency_test_documents");
const AUDIO_DIR = path.join(__dirname, "._meetings_ai_consistency_test_audio");
process.env.DB_PATH = DB_FILE;
process.env.DOCUMENTS_DIR = DOCS_DIR;
process.env.MEETINGS_AUDIO_DIR = AUDIO_DIR;
process.env.ADMIN_INITIAL_PASSWORD = "admintest123";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.WA_SHARED_SECRET = "test-wa-secret";
process.env.LOGIN_RATE_LIMIT_MAX = "1000";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
fs.rmSync(DOCS_DIR, { recursive: true, force: true });
fs.rmSync(AUDIO_DIR, { recursive: true, force: true });

const { server } = require("../server");
const db = require("../src/db");
const { buildToolList } = require("../src/ai/tools");
const attendanceSvc = require("../src/services/attendance");
const meetingsSvc = require("../src/services/meetings");

let BASE;
let leader, member;
let meetingId;

function cookieFrom(res) {
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
async function login(phone, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  assert.equal(res.status, 200, `login failed for ${phone}: ${await res.text()}`);
  return cookieFrom(res);
}
async function toolsFor(memberId) {
  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(memberId);
  const list = await buildToolList({ actor, channel: "web", chatId: `web:${actor.id}` });
  const byName = {};
  for (const t of list) byName[t.name] = (args) => t.handler(args, {});
  return { actor, tools: byName };
}
function toolText(result) { return result.content[0].text; }

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const hash = bcrypt.hashSync("test1234", 10);
  const insert = db.prepare(`
    INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, 'activ', ?, 0)
  `);
  leader = insert.run("Team Leader PV", "pv-leader", "40700030001", "team_leader", "team_leader", hash).lastInsertRowid;
  member = insert.run("Membru PV", "pv-membru", "40700030002", "member", "member", hash).lastInsertRowid;

  const leaderActor = db.prepare("SELECT * FROM members WHERE id = ?").get(leader);
  const session = attendanceSvc.createSession(leaderActor, { date: "2026-09-10", start_time: "18:00", type: "sedinta", title: "Ședința PV" });
  attendanceSvc.markRecords(leaderActor, session.id, [{ member_id: member, status: "prezent" }]);
  let meeting = meetingsSvc.getOrCreateForSession(leaderActor, session.id);
  meeting = meetingsSvc.updateAgenda(leaderActor, meeting.id, ["Discuție buget"]);

  meetingsSvc.generateDraftText = async () => ({
    text: JSON.stringify({
      discussions: [{ point: "Discuție buget", discussion: "S-a discutat bugetul sezonului.", decision: "Se aprobă achiziția de senzori.", majora: false }],
      announcements: "",
      actions: [],
      next_meeting_note: "",
    }),
    usage: null, cost: 0, model: "mock",
  });
  meeting = await meetingsSvc.generateDraft(leaderActor, meeting.id);
  meeting = meetingsSvc.approve(leaderActor, meeting.id);
  meetingId = meeting.id;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  try { fs.rmSync(path.join(__dirname, "backups"), { recursive: true, force: true }); } catch {}
  fs.rmSync(DOCS_DIR, { recursive: true, force: true });
  fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
  delete process.env.DOCUMENTS_DIR;
  delete process.env.MEETINGS_AUDIO_DIR;
  delete process.env.ANTHROPIC_API_KEY;
});

test("ultimul_proces_verbal (tool) matches GET /api/meetings/last-approved", async () => {
  const cookie = await login("pv-membru", "test1234");
  const httpRes = await fetch(`${BASE}/api/meetings/last-approved`, { headers: { Cookie: cookie } });
  const httpBody = await httpRes.json();

  const { tools } = await toolsFor(member);
  const toolOut = toolText(await tools.ultimul_proces_verbal({}));
  assert.ok(toolOut.includes(httpBody.session.date));
  assert.ok(toolOut.includes("Se aprobă achiziția de senzori."));
});

test("cauta_procese_verbale (tool) matches GET /api/meetings/search", async () => {
  const cookie = await login("pv-membru", "test1234");
  const httpRes = await fetch(`${BASE}/api/meetings/search?q=buget`, { headers: { Cookie: cookie } });
  const httpBody = await httpRes.json();
  assert.ok(httpBody.length >= 1);

  const { tools } = await toolsFor(member);
  const toolOut = toolText(await tools.cauta_procese_verbale({ text: "buget" }));
  for (const r of httpBody) assert.ok(toolOut.includes(r.session_date));
});

test("deciziile_sedintei (tool) matches GET /api/meetings/decisions", async () => {
  const cookie = await login("pv-membru", "test1234");
  const httpRes = await fetch(`${BASE}/api/meetings/decisions?date=2026-09-10`, { headers: { Cookie: cookie } });
  const httpBody = await httpRes.json();
  assert.equal(httpBody.decisions[0].decision, "Se aprobă achiziția de senzori.");

  const { tools } = await toolsFor(member);
  const toolOut = toolText(await tools.deciziile_sedintei({ data: "2026-09-10" }));
  assert.ok(toolOut.includes("Se aprobă achiziția de senzori."));
});

test("PUT /api/meetings/:id/agenda rejects a plain member (FORBIDDEN, meetings.manage is MANAGERS-only)", async () => {
  const cookie = await login("pv-membru", "test1234");
  const httpRes = await fetch(`${BASE}/api/meetings/${meetingId}/agenda`, {
    method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ agenda: ["x"] }),
  });
  assert.equal(httpRes.status, 403);
});

test("PUT /api/meetings/:id/agenda rejects editing an approved PV even for MANAGERS (immutable, Art. 49.2)", async () => {
  const cookie = await login("pv-leader", "test1234");
  const httpRes = await fetch(`${BASE}/api/meetings/${meetingId}/agenda`, {
    method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ agenda: ["x"] }),
  });
  assert.equal(httpRes.status, 400);
  const body = await httpRes.json();
  assert.match(body.error, /imuabil/);
});
