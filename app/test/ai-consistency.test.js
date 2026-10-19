// Coherence tests (design v2 §11): the AI tool and the HTTP route for the same operation must
// give the SAME result (same data, or the same DomainError message+article) - no network, no
// model calls, tool handlers are invoked directly.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._ai_consistency_test.db");
const DOCS_DIR = path.join(__dirname, "._ai_consistency_test_documents");
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
const { buildToolList } = require("../src/ai/tools");
const { DomainError } = require("../src/domain/errors");
const tasksSvc = require("../src/services/tasks");
const attendanceSvc = require("../src/services/attendance");

let BASE;
let leader, member, otherMember;

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

function toolText(result) {
  return result.content[0].text;
}

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const hash = bcrypt.hashSync("test1234", 10);
  const insert = db.prepare(`
    INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, 'activ', ?, 0)
  `);
  leader = insert.run("Team Leader AI", "ai-leader", "40700001001", "team_leader", "team_leader", hash).lastInsertRowid;
  member = insert.run("Membru AI Unu", "ai-membru1", "40700001002", "member", "member", hash).lastInsertRowid;
  otherMember = insert.run("Membru AI Doi", "ai-membru2", "40700001003", "member", "member", hash).lastInsertRowid;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  try { fs.rmSync(path.join(__dirname, "backups"), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(DOCS_DIR, { recursive: true, force: true }); } catch {}
});

test("prezenta (tool) matches GET /api/attendance/stats for self", async () => {
  const cookie = await login("ai-membru1", "test1234");
  const httpRes = await fetch(`${BASE}/api/attendance/stats?member_id=${member}`, { headers: { Cookie: cookie } });
  const httpStats = await httpRes.json();

  const { tools } = await toolsFor(member);
  const toolOut = toolText(await tools.prezenta({}));
  assert.match(toolOut, new RegExp(`Sezon ${httpStats.season}`));
  assert.match(toolOut, new RegExp(`Prezent: ${httpStats.present}`));
});

test("prezenta (tool) refuses viewing another member's stats exactly like the route, for a plain member", async () => {
  const cookie = await login("ai-membru1", "test1234");
  const httpRes = await fetch(`${BASE}/api/attendance/stats?member_id=${otherMember}`, { headers: { Cookie: cookie } });
  assert.equal(httpRes.status, 403);
  const httpBody = await httpRes.json();

  const { tools } = await toolsFor(member);
  const toolOut = await tools.prezenta({ membru_id: otherMember });
  assert.equal(toolOut.isError, true);
  assert.ok(toolText(toolOut).startsWith(httpBody.error));
});

test("documentele_mele (tool) matches GET /api/documents/me", async () => {
  const cookie = await login("ai-membru1", "test1234");
  const httpRes = await fetch(`${BASE}/api/documents/me`, { headers: { Cookie: cookie } });
  const httpDocs = await httpRes.json();

  const { tools } = await toolsFor(member);
  const toolOut = toolText(await tools.documentele_mele({}));
  for (const d of httpDocs) {
    assert.match(toolOut, new RegExp(d.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("taskurile_mele (tool) matches GET /api/tasks?mine=1", async () => {
  tasksSvc.create({ id: member }, { title: "Task consistency test" });
  const cookie = await login("ai-membru1", "test1234");
  const httpRes = await fetch(`${BASE}/api/tasks?mine=1`, { headers: { Cookie: cookie } });
  const httpTasks = await httpRes.json();
  assert.ok(httpTasks.some((t) => t.title === "Task consistency test"));

  const { tools } = await toolsFor(member);
  const toolOut = toolText(await tools.taskurile_mele({}));
  assert.match(toolOut, /Task consistency test/);
});

test("creeaza_reminder for a non-member phone is rejected (NOT_FOUND, same as resolving a phone to a member elsewhere)", async () => {
  const { tools } = await toolsFor(leader);
  const r = await tools.creeaza_reminder({ mesaj: "test", cand: "2026-10-05T10:00", membru_telefon: "40799999999" });
  assert.equal(r.isError, true);
  assert.equal(toolText(r), "Membru negăsit.");
});

test("creeaza_reminder for another ACTIVE member works for a leader, mirrors POST /api/reminders permission", async () => {
  const { tools: leaderTools } = await toolsFor(leader);
  const r = await leaderTools.creeaza_reminder({ mesaj: "test", cand: "2026-10-05T10:00", membru_id: member });
  assert.equal(r.isError, undefined);

  const { tools: memberTools } = await toolsFor(member);
  const r2 = await memberTools.creeaza_reminder({ mesaj: "test", cand: "2026-10-05T10:00", membru_id: otherMember });
  assert.equal(r2.isError, true);

  const cookie = await login("ai-membru1", "test1234");
  const httpRes = await fetch(`${BASE}/api/reminders`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ target_member_id: otherMember, message: "test", remind_at: "2026-10-05T10:00:00.000Z" }),
  });
  assert.equal(httpRes.status, 403);
  const httpBody = await httpRes.json();
  assert.equal(toolText(r2), httpBody.error);
});

test("creeaza_reminder (tool) and POST /api/reminders both create a task with the same remind_at (design-meniu-v2 §2)", async () => {
  const { tools } = await toolsFor(member);
  const r = await tools.creeaza_reminder({ mesaj: "Paritate reminder tool", cand: "2026-12-01T18:30" });
  assert.equal(r.isError, undefined, toolText(r));
  const cookie = await login("ai-membru1", "test1234");
  const httpRes = await fetch(`${BASE}/api/reminders`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message: "Paritate reminder http", remind_at: "2026-12-01T18:30" }),
  });
  assert.equal(httpRes.status, 200);
  const tasks = await (await fetch(`${BASE}/api/tasks?mine=1`, { headers: { Cookie: cookie } })).json();
  const viaTool = tasks.find((t) => t.title === "Paritate reminder tool");
  const viaHttp = tasks.find((t) => t.title === "Paritate reminder http");
  assert.equal(viaTool.remind_at, "2026-12-01T16:30:00.000Z"); // 18:30 Bucharest (EET, UTC+2)
  assert.equal(viaHttp.remind_at, viaTool.remind_at);
  assert.equal(viaTool.created_by, member);
  assert.equal(viaHttp.created_by, member);
});

test("trimite_whatsapp: forbidden for a plain member, creates a pending action for a leader", async () => {
  const { tools: memberTools } = await toolsFor(member);
  const r = await memberTools.trimite_whatsapp({ catre_telefon: "40700001003", mesaj: "bună" });
  assert.equal(r.isError, true);

  const { tools: leaderTools } = await toolsFor(leader);
  const r2 = await leaderTools.trimite_whatsapp({ catre_telefon: "40700001003", mesaj: "bună" });
  assert.equal(r2.isError, undefined);
  assert.match(toolText(r2), /Confirmi\? Răspunde DA/);
  const pendingRow = db.prepare("SELECT * FROM wa_pending_actions WHERE member_id = ?").get(leader);
  assert.ok(pendingRow);
});

test("cere_motivare_absenta: on time vs late (tardiva) carries the same flag/article as the domain rule", async () => {
  const session = attendanceSvc.createSession({ id: leader, role: "team_leader", status: "activ" }, { date: "2099-01-01", start_time: "18:00", type: "sedinta" });
  const { tools } = await toolsFor(member);

  const onTime = await tools.cere_motivare_absenta({ sesiune_id: session.id, motiv: "test" });
  assert.match(toolText(onTime), /în termen/);

  // under 24h before the start: tardiva (a session starting at 00:00 tomorrow is 0-24h away)
  const tomorrow = require("../src/domain/time").utcToBucharest(Date.now() + 24 * 3600 * 1000).date;
  const soonSession = attendanceSvc.createSession({ id: leader, role: "team_leader", status: "activ" }, { date: tomorrow, start_time: "00:00", type: "sedinta" });
  const { tools: tools2 } = await toolsFor(otherMember);
  const late = await tools2.cere_motivare_absenta({ sesiune_id: soonSession.id, motiv: "test" });
  assert.match(toolText(late), /târzie/);

  // long after the meeting (> 48h): refused by the tool and by the route with the same message (Art. 21.1)
  const pastSession = attendanceSvc.createSession({ id: leader, role: "team_leader", status: "activ" }, { date: "2020-01-01", start_time: "18:00", type: "sedinta" });
  const expiredTool = await tools2.cere_motivare_absenta({ sesiune_id: pastSession.id, motiv: "test" });
  assert.equal(expiredTool.isError, true);
  const cookie = await login("ai-membru2", "test1234");
  const http = await fetch(`${BASE}/api/absences`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ session_id: pastSession.id, reason: "test" }) });
  const httpBody = await http.json();
  assert.equal(http.status, 409);
  assert.ok(toolText(expiredTool).startsWith(httpBody.error));
});

test('cauta_regulament("prezenta minima") contains Art. 20.1', async () => {
  const { tools } = await toolsFor(member);
  const r = await tools.cauta_regulament({ intrebare: "prezenta minima" });
  assert.match(toolText(r), /Art\. 20/);
  assert.match(toolText(r), /20\.1/);
});

test("cauta_manual_ftc (tool) matches GET /api/ftc-docs/search for the same query (docs/design-ai-hardening.md §2, §6)", async () => {
  const cookie = await login("ai-membru1", "test1234");
  const httpRes = await fetch(`${BASE}/api/ftc-docs/search?q=${encodeURIComponent("robot size starting configuration")}`, { headers: { Cookie: cookie } });
  const httpResults = await httpRes.json();
  assert.ok(httpResults.some((r) => r.code === "R102")); // BIOBUZZ TU03: 18-inch starting cube is R102

  const { tools } = await toolsFor(member);
  const toolOut = toolText(await tools.cauta_manual_ftc({ intrebare: "robot size starting configuration" }));
  assert.match(toolOut, /R102/);
});
