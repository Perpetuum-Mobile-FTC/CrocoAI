// Pachet B (docs/design-pachet-b.md): announcements + deadlines + Acasă (B1), team chat removed (B2),
// audit fixes (B3). Route and AI tool go through the same services (golden rule) - parity checked here.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const sharp = require("sharp");
const { initEnv, makeMembers, actorOf, login } = require("./_assign-env");
const env = initEnv("pachet_b");
process.env.MEETINGS_AUDIO_DIR = path.join(__dirname, "._pachet_b_audio");
process.env.ANTHROPIC_API_KEY = "test-anthropic-key"; // generateDraftText is mocked below - no model is ever called
process.env.TEAM_GROUP_ID = "team-group@g.us";

const { server } = require("../server");
const db = require("../src/db");
const { can } = require("../src/domain/policy");
const { buildToolList } = require("../src/ai/tools");
const announcements = require("../src/services/announcements");
const deadlines = require("../src/services/deadlines");
const events = require("../src/services/events");
const attendance = require("../src/services/attendance");
const meetings = require("../src/services/meetings");
const googleMeet = require("../src/services/google-meet");
const photos = require("../src/services/photos");
const tasks = require("../src/services/tasks");
const scheduler = require("../src/services/reminder-scheduler");
const migration = require("../src/db/migrations/024_pachet_b.js");

let BASE, M;
const cookies = {};
async function req(key, method, url, body) {
  const r = await fetch(`${BASE}${url}`, {
    method, headers: { "Content-Type": "application/json", Cookie: cookies[key] }, body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("json") ? await r.json() : null, headers: r.headers, raw: r };
}
async function tools(key) {
  const actor = actorOf(db, M[key].id);
  const list = await buildToolList({ actor, channel: "web", chatId: `web:${actor.id}` });
  const out = {};
  for (const t of list) out[t.name] = async (args) => (await t.handler(args || {}, {})).content[0].text;
  return out;
}
const actor = (key) => actorOf(db, M[key].id);

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "mentor", role: "mentor" },
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "hn", role: "head_nontech", department: "non-tehnic" },
    { key: "mt", role: "member", department: "tehnic" },
    { key: "mn", role: "member", department: "non-tehnic" },
    { key: "ma", role: "member", department: "ambele" },
    { key: "unv", role: "member", department: "tehnic", unverified: true },
    { key: "pz", role: "member", department: "tehnic", status: "pauza" },
    { key: "pzn", role: "member", department: "non-tehnic", status: "pauza" },
  ]);
  for (const k of Object.keys(M)) cookies[k] = await login(BASE, M[k].phone);
});

after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  env.cleanup();
  fs.rmSync(process.env.MEETINGS_AUDIO_DIR, { recursive: true, force: true });
});

// ── Migration ────────────────────────────────────────────────────────────────────────────────
test("migration 024 copies only the old Anunțuri channel posts, seeds the two deadlines", () => {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE members (id INTEGER PRIMARY KEY, full_name TEXT);
    CREATE TABLE photos (id INTEGER PRIMARY KEY);
    CREATE TABLE chat_conversations (id INTEGER PRIMARY KEY, type TEXT, name TEXT);
    CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, conversation_id INTEGER, sender_id INTEGER, body TEXT, created_at TEXT);
    INSERT INTO members VALUES (1, 'TL');
    INSERT INTO chat_conversations VALUES (1, 'announce', 'Anunțuri'), (2, 'direct', NULL);
    INSERT INTO chat_messages VALUES (1, 1, 1, 'Ședință vineri' || char(10) || 'La ora 18, sala S03', '2026-09-01T10:00:00.000Z'),
      (2, 2, 1, 'mesaj privat', '2026-09-02T10:00:00.000Z'), (3, 1, 1, 'Scurt', '2026-09-03T10:00:00.000Z');
  `);
  migration.up(mem);
  const rows = mem.prepare("SELECT title, body, audience, author_id, created_at FROM announcements ORDER BY id").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { title: "Ședință vineri", body: "La ora 18, sala S03", audience: "echipa", author_id: 1, created_at: "2026-09-01T10:00:00.000Z" },
    { title: "Scurt", body: "", audience: "echipa", author_id: 1, created_at: "2026-09-03T10:00:00.000Z" },
  ]);
  assert.deepEqual(mem.prepare("SELECT title, date, date_text FROM deadlines ORDER BY id").all().map((r) => ({ ...r })), [
    { title: "Termen înscriere membri pe natie.ro", date: "2027-01-17", date_text: null },
    { title: "Etapa Regională", date: null, date_text: "ianuarie–februarie 2027" },
  ]);
  const long = migration.splitPost("x".repeat(300));
  assert.equal(long.title.length, 101);
  assert.equal(long.body.length, 300);
});

// ── B2: chat removed ─────────────────────────────────────────────────────────────────────────
test("team chat is gone: no routes, no chat.* actions, the AI has anunturi_recente from announcements", async () => {
  assert.equal((await req("mt", "GET", "/api/chat/conversations")).status, 404);
  assert.throws(() => can(actor("tl"), "chat.use"), /unknown action/);
  const names = Object.keys(await tools("mt"));
  assert.ok(names.includes("anunturi_recente"));
  for (const f of ["src/routes/chat.js", "src/services/chat.js", "src/ai/tools-chat.js"]) assert.ok(!fs.existsSync(path.join(__dirname, "..", f)), f);
  const r = await fetch(`${BASE}/chat-echipa`, { redirect: "manual" });
  assert.equal(r.headers.get("location"), "/anunturi");
});

// ── B1: deadlines ────────────────────────────────────────────────────────────────────────────
test("deadlines: seeded, countdown in Bucharest days, past ones disappear, managed only by TL/co-leader/heads", async () => {
  const at = (iso) => deadlines.list(actor("mt"), { nowMs: Date.parse(iso) });
  let list = at("2027-01-15T10:00:00Z");
  assert.deepEqual(list.map((d) => [d.title, d.countdown]), [
    ["Termen înscriere membri pe natie.ro", "Mai sunt 2 zile"], ["Etapa Regională", "dată neanunțată"],
  ]);
  assert.equal(list[1].date_text, "ianuarie–februarie 2027");
  assert.equal(at("2027-01-16T12:00:00Z")[0].countdown, "Mai este o zi");
  assert.equal(at("2027-01-16T22:30:00Z")[0].countdown, "azi"); // 00:30 on the 17th in Bucharest
  list = at("2027-01-17T22:30:00Z"); // 00:30 on the 18th in Bucharest -> gone
  assert.deepEqual(list.map((d) => d.title), ["Etapa Regională"]);

  assert.equal((await req("mt", "POST", "/api/deadlines", { title: "x", date: "2027-02-01" })).status, 403);
  assert.equal((await req("mentor", "POST", "/api/deadlines", { title: "x", date: "2027-02-01" })).status, 403);
  assert.equal((await req("ht", "POST", "/api/deadlines", { title: "Bad", date: "2027-02-30" })).status, 400);
  const created = await req("ht", "POST", "/api/deadlines", { title: "Inspecție robot", date: "2099-02-01" });
  assert.equal(created.status, 200);
  const upd = await req("tl", "PUT", `/api/deadlines/${created.body.id}`, { date: null, date_text: "februarie" });
  assert.equal(upd.body.countdown, "dată neanunțată");
  assert.equal((await req("mt", "DELETE", `/api/deadlines/${created.body.id}`)).status, 403);
  assert.equal((await req("hn", "DELETE", `/api/deadlines/${created.body.id}`)).status, 200);
});

// ── B1: announcements ────────────────────────────────────────────────────────────────────────
test("announcements.publish: leaders/mentors -> any audience, heads -> only their department", () => {
  for (const audience of ["echipa", "tehnic", "non-tehnic"]) {
    assert.equal(can(actor("tl"), "announcements.publish", { audience }), true);
    assert.equal(can(actor("mentor"), "announcements.publish", { audience }), true);
    assert.equal(can(actor("mt"), "announcements.publish", { audience }), false);
  }
  assert.equal(can(actor("ht"), "announcements.publish", { audience: "tehnic" }), true);
  assert.equal(can(actor("ht"), "announcements.publish", { audience: "echipa" }), false);
  assert.equal(can(actor("ht"), "announcements.publish", { audience: "non-tehnic" }), false);
  assert.equal(can({ ...actor("tl"), status: "pauza" }, "announcements.publish", { audience: "echipa" }), false);
});

test("publishing: department audience, notifications to recipients only, WhatsApp only for the whole team when asked", async () => {
  env.waSent.length = 0;
  assert.equal((await req("mt", "POST", "/api/announcements", { title: "Nu am voie", audience: "tehnic" })).status, 403);
  assert.equal((await req("ht", "POST", "/api/announcements", { title: "Nu am voie", audience: "echipa" })).status, 403);
  assert.equal((await req("tl", "POST", "/api/announcements", { title: "x", audience: "tehnic", send_whatsapp: true })).status, 400);

  const tech = await req("ht", "POST", "/api/announcements", { title: "Antrenament CAD", body: "Joi la 17:00", audience: "tehnic" });
  assert.equal(tech.status, 200);
  assert.equal(tech.body.audience_label, "Departamentul tehnic");
  assert.equal(tech.body.whatsapp, null);
  assert.equal(env.waSent.length, 0);

  const team = await req("tl", "POST", "/api/announcements", { title: "Ședință generală", body: "Vineri, ora 18", audience: "echipa", send_whatsapp: true });
  assert.equal(team.status, 200);
  assert.equal(team.body.whatsapp, "sent");
  assert.deepEqual(env.waSent, [{ to: "team-group@g.us", text: "📢 Ședință generală\nVineri, ora 18" }]);
  assert.ok(db.prepare("SELECT sent_whatsapp_at FROM announcements WHERE id = ?").get(team.body.id).sent_whatsapp_at);

  const quiet = await req("tl", "POST", "/api/announcements", { title: "Fără WhatsApp", audience: "echipa" });
  assert.equal(quiet.body.whatsapp, null);
  assert.equal(env.waSent.length, 1);

  const notified = (key, title) => !!db.prepare("SELECT 1 FROM notifications WHERE member_id = ? AND title = ? AND link = '/anunturi'").get(M[key].id, `Anunț: ${title}`);
  for (const k of ["mt", "ma", "tl", "mentor", "unv"]) assert.ok(notified(k, "Antrenament CAD"), `${k} notified`);
  for (const k of ["mn", "hn", "ht"]) assert.ok(!notified(k, "Antrenament CAD"), `${k} not notified`);
  for (const k of ["mn", "hn", "mt", "ht"]) assert.ok(notified(k, "Ședință generală"), `${k} notified (team)`);
});

test("visibility: department announcements only for that department, 'ambele' and its leadership; route = AI tool", async () => {
  const titles = async (key) => (await req(key, "GET", "/api/announcements")).body.map((a) => a.title);
  assert.ok((await titles("mt")).includes("Antrenament CAD"));
  assert.ok((await titles("ma")).includes("Antrenament CAD"));
  assert.ok((await titles("mentor")).includes("Antrenament CAD"));
  assert.ok(!(await titles("mn")).includes("Antrenament CAD"));
  assert.ok(!(await titles("hn")).includes("Antrenament CAD"));
  assert.ok((await titles("mn")).includes("Ședință generală"));

  for (const key of ["mt", "mn"]) {
    const route = (await req(key, "GET", "/api/announcements?limit=10")).body;
    const text = await (await tools(key)).anunturi_recente({ numar: 10 });
    for (const a of route) assert.ok(text.includes(a.title), `${key}: tool lists ${a.title}`);
    assert.equal(text.split("\n").filter((l) => l.startsWith("- [")).length, route.length);
    assert.equal(text.includes("Antrenament CAD"), key === "mt");
  }
});

test("delete: author or TL/co-leader; the FTC manual announcement is a system post by CrocoAI", async () => {
  const mine = await req("ht", "POST", "/api/announcements", { title: "Greșit", audience: "tehnic" });
  assert.equal((await req("mt", "DELETE", `/api/announcements/${mine.body.id}`)).status, 403);
  assert.equal((await req("mn", "DELETE", `/api/announcements/${mine.body.id}`)).status, 404); // cannot even see it
  assert.equal((await req("ht", "DELETE", `/api/announcements/${mine.body.id}`)).status, 200);

  const sys = announcements.publishSystem("📘 Manualul FTC (BIOBUZZ) a fost actualizat: TU02 → TU03.", "Reguli noi: G101");
  const seen = (await req("mn", "GET", "/api/announcements")).body.find((a) => a.id === sys.id);
  assert.equal(seen.author_name, "CrocoAI");
  assert.equal(seen.audience, "echipa");
  assert.equal(seen.can_delete, false);
});

// ── B1: Acasă ────────────────────────────────────────────────────────────────────────────────
test("GET /api/home: personal cards for a member, no „De verificat”", async () => {
  tasks.create(actor("mt"), { title: "Cu reminder", remind_at: "2099-01-01T10:00" });
  tasks.create(actor("mt"), { title: "Fără reminder" });
  const r = await req("mt", "GET", "/api/home");
  assert.equal(r.status, 200);
  const h = r.body;
  assert.equal(h.review, null);
  assert.equal(h.can_publish, false);
  assert.ok(h.deadlines.some((d) => d.title === "Etapa Regională"));
  assert.ok(h.announcements.length <= 3 && h.announcements.length > 0);
  const todo = h.todos.find((t) => t.title === "Cu reminder");
  assert.ok(todo.remind_at);
  assert.equal(h.todos.find((t) => t.title === "Fără reminder").remind_at, null);
  assert.ok(Array.isArray(h.assignments));
  assert.ok(Array.isArray(h.meetings));
  assert.ok(h.attendance && h.attendance.stats);
  assert.ok(Array.isArray(h.documents));
});

test("„De verificat”: only what the viewer may decide (submissions by department, absences, role requests)", async () => {
  const created = await req("ht", "POST", "/api/assignments", { title: "Schiță CAD", mode: "individual", target_type: "departament", target_dept: "tehnic" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  db.prepare("UPDATE submissions SET status = 'predat' WHERE assignment_id = ? AND member_id = ?").run(created.body.id, M.mt.id);
  db.prepare("UPDATE members SET requested_role = 'head_tech' WHERE id = ?").run(M.ma.id);
  db.prepare("INSERT INTO absence_requests (member_id, date, reason) VALUES (?, '2099-01-01', 'test')").run(M.mn.id);

  const mt = (await req("mt", "GET", "/api/home")).body;
  assert.ok(mt.assignments.some((a) => a.title === "Schiță CAD") === false); // handed in -> not „de făcut” anymore
  const ht = (await req("ht", "GET", "/api/home")).body.review;
  assert.deepEqual(ht.find((i) => i.key === "predari"), { key: "predari", label: "predare de verificat", count: 1, link: `/teme/${created.body.id}` });
  assert.ok(ht.some((i) => i.key === "motivari"));
  assert.ok(!ht.some((i) => i.key === "roluri"));
  const hn = (await req("hn", "GET", "/api/home")).body.review;
  assert.ok(!hn.some((i) => i.key === "predari"));
  const tl = (await req("tl", "GET", "/api/home")).body.review;
  assert.ok(tl.some((i) => i.key === "predari"));
  assert.ok(tl.some((i) => i.key === "roluri" && i.link === "/admin?tab=cereri-rol"));
  assert.ok(tl.some((i) => i.key === "motivari" && i.count >= 1));
  const mentor = (await req("mentor", "GET", "/api/home")).body.review;
  assert.ok(!mentor.some((i) => i.key === "motivari" || i.key === "roluri")); // mentors don't decide those
  db.prepare("UPDATE members SET requested_role = NULL WHERE id = ?").run(M.ma.id);
});

// ── B3: calendar ─────────────────────────────────────────────────────────────────────────────
test("events.list expands weekly series per occurrence (DST-aware); route = service = bot", async () => {
  const series = events.create(actor("tl"), {
    title: "Atelier săptămânal", type: "antrenament", start_time: "2027-03-01T16:00:00.000Z", end_time: "2027-03-01T18:00:00.000Z",
    recurrence: "weekly", recurrence_until: "2027-03-29",
  });
  const r = await req("mt", "GET", "/api/events?from=2027-03-01&to=2027-03-31T23:59:59");
  const occ = r.body.filter((e) => e.id === series.id);
  assert.deepEqual(occ.map((e) => e.start_time), [
    "2027-03-01T16:00:00.000Z", "2027-03-08T16:00:00.000Z", "2027-03-15T16:00:00.000Z", "2027-03-22T16:00:00.000Z",
    "2027-03-29T15:00:00.000Z", // after the switch to summer time: still 18:00 in Bucharest
  ]);
  assert.deepEqual(occ.map((e) => e.end_time.slice(11, 16)), ["18:00", "18:00", "18:00", "18:00", "17:00"]);
  assert.ok(occ.every((e) => e.series_start_time === "2027-03-01T16:00:00.000Z" && e.meeting_id === null));
  assert.deepEqual(events.list(actor("mt"), { from: "2027-03-01", to: "2027-03-31T23:59:59" }).filter((e) => e.id === series.id), occ);

  // the bot: same occurrences in its window
  const now = new Date().toISOString();
  const to = new Date(Date.now() + 400 * 86400000).toISOString();
  const viaRoute = (await req("mt", "GET", `/api/events?from=${encodeURIComponent(now)}&to=${encodeURIComponent(to)}`)).body.filter((e) => e.title === "Atelier săptămânal");
  const text = await (await tools("mt")).evenimente_urmatoare({ zile: 400 });
  assert.equal(text.split("\n").filter((l) => l.includes("Atelier săptămânal")).length, viaRoute.length);
  assert.equal(viaRoute.length, 5);
});

test("meeting events cannot be edited or deleted from the Calendar (only from Ședințe)", async () => {
  const m = await meetings.schedule(actor("tl"), { title: "Ședința de calendar", type: "sedinta", date: "2027-04-10", time: "18:00", duration: 60, mode: "fizic", location: "S03", agenda: [] });
  const ev = (await req("ht", "GET", "/api/events?from=2027-04-10&to=2027-04-10T23:59:59")).body.find((e) => e.title === "Ședința de calendar");
  assert.equal(ev.meeting_id, m.id);
  const put = await req("ht", "PUT", `/api/events/${ev.id}`, { title: "Schimbat" });
  assert.equal(put.status, 400);
  assert.match(put.body.error, /Ședințe/);
  assert.equal((await req("tl", "DELETE", `/api/events/${ev.id}`)).status, 400);
  assert.throws(() => events.update(actor("tl"), ev.id, { title: "x" }), /Ședințe/);
  // a plain calendar event stays editable
  const plain = events.create(actor("tl"), { title: "Vizită sponsor", type: "eveniment", start_time: "2027-04-11T09:00:00.000Z" });
  assert.equal((await req("ht", "PUT", `/api/events/${plain.id}`, { title: "Vizită sponsor (mutată)" })).status, 200);
});

test("reminders re-armed when the time of an event / meeting / occurrence changes", async () => {
  const plain = events.create(actor("tl"), { title: "Re-arm", type: "eveniment", start_time: "2027-05-20T09:00:00.000Z" });
  db.prepare("UPDATE events SET reminded_24h = 1, reminded_1h = 1 WHERE id = ?").run(plain.id);
  events.update(actor("tl"), plain.id, { title: "Re-arm (titlu)" });
  assert.equal(db.prepare("SELECT reminded_24h FROM events WHERE id = ?").get(plain.id).reminded_24h, 1); // same time: stays
  events.update(actor("tl"), plain.id, { start_time: "2027-05-21T09:00:00.000Z" });
  assert.deepEqual({ ...db.prepare("SELECT reminded_24h, reminded_1h FROM events WHERE id = ?").get(plain.id) }, { reminded_24h: 0, reminded_1h: 0 });

  const m = await meetings.schedule(actor("tl"), { title: "Ședința re-arm", type: "sedinta", date: "2027-05-22", time: "18:00", duration: 60, mode: "fizic", location: "S03", agenda: [] });
  const evId = m.session.event_id;
  db.prepare("UPDATE events SET reminded_24h = 1, reminded_1h = 1 WHERE id = ?").run(evId);
  await meetings.reschedule(actor("tl"), m.id, { time: "19:00" });
  assert.deepEqual({ ...db.prepare("SELECT reminded_24h, reminded_1h FROM events WHERE id = ?").get(evId) }, { reminded_24h: 0, reminded_1h: 0 });

  const s = attendance.insertSession(M.tl.id, { date: "2027-05-23", start_time: "18:00", type: "sedinta", title: "Sesiune" });
  db.prepare("UPDATE attendance_sessions SET reminded_24h = 1, reminded_1h = 1 WHERE id = ?").run(s.id);
  attendance.patchSession(s.id, { start_time: "19:00" });
  assert.deepEqual({ ...db.prepare("SELECT reminded_24h, reminded_1h FROM attendance_sessions WHERE id = ?").get(s.id) }, { reminded_24h: 0, reminded_1h: 0 });
});

// ── B3: Google Meet ──────────────────────────────────────────────────────────────────────────
test("Meet auto link: Bucharest time + real duration; Google event moved / deleted on reschedule, to-physical, cancel", async () => {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", GOOGLE_TEAM_REFRESH_TOKEN: "rt" });
  const orig = { ...googleMeet };
  const calls = [];
  let n = 0;
  googleMeet.createMeetingEvent = async (a) => { calls.push(["create", a]); n += 1; return { link: `https://meet.google.com/x-${n}`, eventId: `g${n}` }; };
  googleMeet.updateMeetingEvent = async (a) => { calls.push(["update", a]); return true; };
  googleMeet.deleteMeetingEvent = async (id) => { calls.push(["delete", id]); return true; };
  try {
    const m = await meetings.schedule(actor("tl"), { title: "Online vara", type: "sedinta", date: "2027-07-01", time: "18:00", duration: 90, mode: "fizic", location: "S03", agenda: [] });
    const r = await meetings.createMeetLinkAuto(actor("tl"), m.id);
    assert.equal(r.meet_link, "https://meet.google.com/x-1");
    assert.deepEqual(calls[0], ["create", { title: "Online vara", startTime: "2027-07-01T15:00:00.000Z", endTime: "2027-07-01T16:30:00.000Z" }]);

    await meetings.reschedule(actor("tl"), m.id, { time: "19:00" });
    assert.deepEqual(calls[1], ["update", { eventId: "g1", title: "Online vara", startTime: "2027-07-01T16:00:00.000Z", endTime: "2027-07-01T17:30:00.000Z" }]);

    await meetings.reschedule(actor("tl"), m.id, { mode: "fizic", location: "S05" });
    assert.deepEqual(calls[2], ["delete", "g1"]);
    assert.equal(meetings.get(actor("tl"), m.id).meet_link, null);

    const m2 = await meetings.schedule(actor("tl"), { title: "Online iarna", type: "sedinta", date: "2027-12-01", time: "18:00", duration: 60, mode: "online", agenda: [] });
    assert.deepEqual(calls[3], ["create", { title: "Online iarna", startTime: "2027-12-01T16:00:00.000Z", endTime: "2027-12-01T17:00:00.000Z" }]);
    await meetings.cancel(actor("tl"), m2.id);
    assert.deepEqual(calls[4], ["delete", "g2"]);
    assert.equal(calls.length, 5);
  } finally {
    Object.assign(googleMeet, orig);
    for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_TEAM_REFRESH_TOKEN"]) delete process.env[k];
  }
});

test("google-meet update/delete: PATCH / DELETE on the event, never throw (mocked fetch)", async () => {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", GOOGLE_TEAM_REFRESH_TOKEN: "rt" });
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push([opts.method, String(url)]);
    if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    if (opts.method === "DELETE" && String(url).endsWith("/gone")) return new Response("", { status: 410 });
    if (String(url).endsWith("/boom")) return new Response("", { status: 500 });
    return new Response("{}", { status: 200 });
  };
  try {
    assert.equal(await googleMeet.updateMeetingEvent({ eventId: "e1", title: "t", startTime: "a", endTime: "b" }), true);
    assert.equal(await googleMeet.deleteMeetingEvent("gone"), true);
    assert.equal(await googleMeet.deleteMeetingEvent("boom"), false);
    assert.deepEqual(seen.filter(([, u]) => !u.includes("oauth2")), [
      ["PATCH", "https://www.googleapis.com/calendar/v3/calendars/primary/events/e1"],
      ["DELETE", "https://www.googleapis.com/calendar/v3/calendars/primary/events/gone"],
      ["DELETE", "https://www.googleapis.com/calendar/v3/calendars/primary/events/boom"],
    ]);
  } finally {
    global.fetch = realFetch;
    for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_TEAM_REFRESH_TOKEN"]) delete process.env[k];
  }
});

// ── B3: PV ───────────────────────────────────────────────────────────────────────────────────
test("PV draft: real place (Meet link / room) and the next meeting of the SAME audience", async () => {
  meetings.generateDraftText = async () => ({ text: JSON.stringify({ discussions: [], announcements: "", actions: [], next_meeting_note: "" }), usage: null, cost: 0, model: "mock" });
  const tech = await meetings.schedule(actor("tl"), { title: "Tehnic 1", type: "sedinta", target_type: "departament", target_dept: "tehnic", date: "2027-08-02", time: "18:00", duration: 60, mode: "online", meet_link: "https://meet.example.com/abc", agenda: [] });
  await meetings.schedule(actor("tl"), { title: "Toată echipa", type: "sedinta", date: "2027-08-04", time: "18:00", duration: 60, mode: "fizic", location: "Aula", agenda: [] });
  await meetings.schedule(actor("tl"), { title: "Tehnic 2", type: "sedinta", target_type: "departament", target_dept: "tehnic", date: "2027-08-09", time: "18:00", duration: 60, mode: "fizic", location: "S05", agenda: [] });
  const d = (await meetings.generateDraft(actor("tl"), tech.id)).draft;
  assert.equal(d.location, "Online (Google Meet): https://meet.example.com/abc");
  assert.equal(d.next_meeting.date, "2027-08-09");
  const room = await meetings.schedule(actor("tl"), { title: "Fizic", type: "sedinta", date: "2027-08-11", time: "18:00", duration: 60, mode: "fizic", location: "Sala 12", agenda: [] });
  assert.equal((await meetings.generateDraft(actor("tl"), room.id)).draft.location, "Sala 12");
  assert.doesNotMatch(meetings.exportHtml(actor("tl"), room.id), /S03/);
});

test("deciziile_sedintei / decisionsFor: every meeting of that day, route = tool", async () => {
  const mk = async (title, extra, time) => meetings.schedule(actor("tl"), { title, type: "sedinta", date: "2027-09-01", time, duration: 60, mode: "fizic", location: "S03", agenda: [], ...extra });
  const a = await mk("Dimineață", {}, "10:00");
  const b = await mk("Seară tehnic", { target_type: "departament", target_dept: "tehnic" }, "18:00");
  const draft = (decision) => ({ attendance: { total_present: 0, total_roster: 0 }, discussions: [{ point: "p", discussion: "d", decision, majora: false }] });
  meetings.updateDraft(actor("tl"), a.id, draft("Decizia A"));
  meetings.updateDraft(actor("tl"), b.id, draft("Decizia B"));
  const r = await req("tl", "GET", "/api/meetings/decisions?date=2027-09-01");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.meetings.map((m) => [m.title, m.time, m.decisions[0].decision]), [["Dimineață", "10:00", "Decizia A"], ["Seară tehnic", "18:00", "Decizia B"]]);
  const text = await (await tools("tl")).deciziile_sedintei({ data: "2027-09-01" });
  assert.match(text, /Dimineață \(ora 10:00\):\n- Decizia A/);
  assert.match(text, /Seară tehnic \(ora 18:00\):\n- Decizia B/);
  // a member can't read drafts: same refusal on both channels
  const refused = await req("mt", "GET", "/api/meetings/decisions?date=2027-09-01");
  assert.equal(refused.status, 403);
  assert.equal(await (await tools("mt")).deciziile_sedintei({ data: "2027-09-01" }), refused.body.error);
});

// ── B3: photos ───────────────────────────────────────────────────────────────────────────────
test("photos: every viewer gets the ~1600px variant, the original stays for leaders / the uploader", async () => {
  const album = photos.createAlbum(actor("mt"), { title: "Album test" });
  const buffer = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#3a6" } }).jpeg().toBuffer();
  const p = await photos.upload(actor("mt"), album.id, { buffer, size: buffer.length, mimetype: "image/jpeg", originalname: "mare.jpg" });
  assert.ok(p.medium_path);
  const medium = await fetch(`${BASE}/api/photos/${p.id}/medium`, { headers: { Cookie: cookies.mn } });
  assert.equal(medium.status, 200);
  assert.equal(medium.headers.get("content-type"), "image/jpeg");
  const meta = await sharp(Buffer.from(await medium.arrayBuffer())).metadata();
  assert.equal(meta.width, 1600);
  assert.equal((await fetch(`${BASE}/api/photos/${p.id}/file`, { headers: { Cookie: cookies.mn } })).status, 403);
  assert.equal((await fetch(`${BASE}/api/photos/${p.id}/file`, { headers: { Cookie: cookies.mt } })).status, 200);

  // an older photo without a medium variant gets one on first view
  db.prepare("UPDATE photos SET medium_path = NULL WHERE id = ?").run(p.id);
  fs.rmSync(path.join(photos.PHOTOS_DIR, p.medium_path), { force: true });
  assert.equal((await fetch(`${BASE}/api/photos/${p.id}/medium`, { headers: { Cookie: cookies.mn } })).status, 200);
  assert.ok(db.prepare("SELECT medium_path FROM photos WHERE id = ?").get(p.id).medium_path);
});

// ── B3: scheduler ────────────────────────────────────────────────────────────────────────────
test("scheduler: „scadent azi” at 09:00 Bucharest whatever the server TZ; WhatsApp only to verified phones", async () => {
  const prevTz = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    db.prepare("UPDATE tasks SET status = 'done'").run();
    const t1 = tasks.create(actor("tl"), { title: "Scadent verificat", assigned_member_id: M.mt.id, due_date: "2027-02-10" });
    const t2 = tasks.create(actor("tl"), { title: "Scadent neverificat", assigned_member_id: M.unv.id, due_date: "2027-02-10" });
    env.waSent.length = 0;
    await scheduler.tick(new Date("2027-02-10T06:30:00Z")); // 08:30 in Bucharest
    assert.equal(db.prepare("SELECT reminded_due FROM tasks WHERE id = ?").get(t1.id).reminded_due, 0);
    await scheduler.tick(new Date("2027-02-10T07:05:00Z")); // 09:05 in Bucharest (07:05 server time)
    assert.equal(db.prepare("SELECT reminded_due FROM tasks WHERE id = ?").get(t1.id).reminded_due, 1);
    assert.equal(db.prepare("SELECT reminded_due FROM tasks WHERE id = ?").get(t2.id).reminded_due, 1);
    const texts = env.waSent.filter((w) => /scadent azi/.test(w.text));
    assert.deepEqual(texts.map((w) => w.to), [M.mt.phone]);
    assert.ok(db.prepare("SELECT 1 FROM notifications WHERE member_id = ? AND title = 'Task scadent azi'").get(M.unv.id));
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

test("scheduler: legacy reminder to a placeholder number is never sent", async () => {
  env.waSent.length = 0;
  const id = db.prepare("INSERT INTO reminders (target_phone, message, remind_at) VALUES ('pending-123', 'Vechi', '2026-01-01T00:00:00Z')").run().lastInsertRowid;
  await scheduler.tick(new Date("2027-02-11T12:00:00Z"));
  assert.equal(env.waSent.filter((w) => /Vechi/.test(w.text)).length, 0);
  assert.equal(db.prepare("SELECT failed FROM reminders WHERE id = ?").get(id).failed, 1);
});

// ── front-end (no browser here; the browser check is manual/playwright) ─────────────────────────
test("front-end: no capture on file pickers, notifications show title/body and follow the link, meeting events read-only", () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", "public", "js", f), "utf8");
  assert.doesNotMatch(src("pages/documente.js"), /capture=/);
  assert.doesNotMatch(src("pages/poze.js"), /capture=/);
  assert.doesNotMatch(src("pages/poze.js"), /<img src="\/api\/photos\/\$\{photo\.id\}\/file"/);
  const app = src("app.js");
  assert.match(app, /n\.title/);
  assert.match(app, /n\.body/);
  assert.match(app, /router\.navigate\(/);
  assert.doesNotMatch(app, /n\.message \|\| n\.text/);
  assert.match(src("pages/calendar.js"), /meeting_id/);
  assert.doesNotMatch(src("pages/chat.js"), /api\/chat\//);
});

// ── Fix round 1 ──────────────────────────────────────────────────────────────────────────────
test("paused members see (and are notified of) team + own-department announcements: policy, route, home, AI", async () => {
  const team = await req("tl", "POST", "/api/announcements", { title: "Pentru toți (pauză inclusă)", audience: "echipa" });
  const tech = await req("ht", "POST", "/api/announcements", { title: "Doar tehnic (pauză inclusă)", audience: "tehnic" });
  assert.equal(team.status, 200);
  assert.equal(tech.status, 200);
  const notified = (key, title) => !!db.prepare("SELECT 1 FROM notifications WHERE member_id = ? AND title = ?").get(M[key].id, `Anunț: ${title}`);
  assert.ok(notified("pz", "Pentru toți (pauză inclusă)"));
  assert.ok(notified("pz", "Doar tehnic (pauză inclusă)"));
  assert.ok(notified("pzn", "Pentru toți (pauză inclusă)"));
  assert.ok(!notified("pzn", "Doar tehnic (pauză inclusă)"));
  const pzTitles = (await req("pz", "GET", "/api/announcements")).body.map((a) => a.title);
  assert.ok(pzTitles.includes("Pentru toți (pauză inclusă)") && pzTitles.includes("Doar tehnic (pauză inclusă)"));
  const pznTitles = (await req("pzn", "GET", "/api/announcements")).body.map((a) => a.title);
  assert.ok(pznTitles.includes("Pentru toți (pauză inclusă)") && !pznTitles.includes("Doar tehnic (pauză inclusă)"));
  const home = (await req("pz", "GET", "/api/home")).body;
  assert.ok(home.announcements.some((a) => a.title === "Doar tehnic (pauză inclusă)"));
  const text = await (await tools("pz")).anunturi_recente({ numar: 20 });
  assert.match(text, /Doar tehnic \(pauză inclusă\)/);
  assert.equal(can({ ...actor("mt"), status: "iesit" }, "announcements.view", { audience: "echipa" }), false);
  assert.equal(can(actor("pz"), "announcements.publish", { audience: "tehnic" }), false);
});

test("send_whatsapp must be exactly true", async () => {
  env.waSent.length = 0;
  const r = await req("tl", "POST", "/api/announcements", { title: "Fără WA (string)", audience: "echipa", send_whatsapp: "false" });
  assert.equal(r.status, 200);
  assert.equal(r.body.whatsapp, null);
  assert.equal(env.waSent.length, 0);
});

test("photos: /file and /medium answer Range requests with 206 (iOS Safari video)", async () => {
  const album = photos.createAlbum(actor("mt"), { title: "Video" });
  const buffer = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(5000, 7)]);
  const v = await photos.upload(actor("mt"), album.id, { buffer, size: buffer.length, mimetype: "video/mp4", originalname: "clip.mp4" });
  for (const [key, variant] of [["mn", "medium"], ["mt", "file"]]) {
    const r = await fetch(`${BASE}/api/photos/${v.id}/${variant}`, { headers: { Cookie: cookies[key], Range: "bytes=0-99" } });
    assert.equal(r.status, 206, variant);
    assert.equal(r.headers.get("content-type"), "video/mp4");
    assert.equal(r.headers.get("content-range"), `bytes 0-99/${buffer.length}`);
    assert.equal((await r.arrayBuffer()).byteLength, 100);
  }
  assert.equal((await fetch(`${BASE}/api/photos/${v.id}/file`, { headers: { Cookie: cookies.mn, Range: "bytes=0-99" } })).status, 403);
});

test("mediumFile: concurrent first views never leave a half-written variant", async () => {
  const album = photos.createAlbum(actor("mt"), { title: "Concurență" });
  const buffer = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#123" } }).jpeg().toBuffer();
  const p = await photos.upload(actor("mt"), album.id, { buffer, size: buffer.length, mimetype: "image/jpeg", originalname: "c.jpg" });
  db.prepare("UPDATE photos SET medium_path = NULL WHERE id = ?").run(p.id);
  fs.rmSync(path.join(photos.PHOTOS_DIR, p.medium_path), { force: true });
  const results = await Promise.all([1, 2, 3, 4].map(() => photos.mediumFile(actor("mn"), p.id)));
  for (const r of results) assert.equal((await sharp(r.absPath).metadata()).width, 1600);
  const dir = path.dirname(path.join(photos.PHOTOS_DIR, p.medium_path));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp")), []);
});

test("reschedule: a Google event created for a change that then fails is deleted again", async () => {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", GOOGLE_TEAM_REFRESH_TOKEN: "rt" });
  const orig = { ...googleMeet };
  const deleted = [];
  googleMeet.createMeetingEvent = async () => ({ link: "https://meet.google.com/new", eventId: "g-new" });
  googleMeet.deleteMeetingEvent = async (id) => { deleted.push(id); return true; };
  const origPatch = attendance.patchSession;
  try {
    const m = await meetings.schedule(actor("tl"), { title: "Va eșua", type: "sedinta", date: "2027-10-05", time: "18:00", duration: 60, mode: "fizic", location: "S03", agenda: [] });
    attendance.patchSession = () => { throw new Error("db down"); };
    await assert.rejects(meetings.reschedule(actor("tl"), m.id, { mode: "online" }), /db down/);
    assert.deepEqual(deleted, ["g-new"]);
  } finally {
    attendance.patchSession = origPatch;
    Object.assign(googleMeet, orig);
    for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_TEAM_REFRESH_TOKEN"]) delete process.env[k];
  }
});

test("a calendar series with auto-Meet meetings on future sessions can't be moved or deleted from the Calendar", async () => {
  const series = events.create(actor("tl"), { title: "Serie cu Meet", type: "sedinta", start_time: "2027-11-01T16:00:00.000Z", recurrence: "weekly", recurrence_until: "2027-11-29" });
  const s = db.prepare("SELECT * FROM attendance_sessions WHERE event_id = ? ORDER BY date LIMIT 1").get(series.id);
  db.prepare("INSERT INTO meetings (session_id, created_by, meet_link, meet_source, meet_event_id) VALUES (?, ?, 'https://meet.google.com/s', 'auto', 'g-series')").run(s.id, M.tl.id);
  const put = await req("tl", "PUT", `/api/events/${series.id}`, { start_time: "2027-11-02T16:00:00.000Z" });
  assert.equal(put.status, 400);
  assert.equal(put.body.error, "Seria are ședințe cu Meet automat — mută-le din Ședințe.");
  assert.equal((await req("tl", "DELETE", `/api/events/${series.id}`)).status, 400);
  assert.equal((await req("tl", "PUT", `/api/events/${series.id}`, { title: "Serie cu Meet (redenumită)" })).status, 200); // no move: fine
});

test("front-end fix round: notification markup has no <div> in <button>, legacy chat link, theme tokens", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  const notif = app.slice(app.indexOf("async function openNotifications"), app.indexOf("// Section tabs"));
  assert.doesNotMatch(notif, /<div class="notif-(title|text|time)/);
  assert.match(app, /"\/chat-echipa": "\/anunturi"/);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "css", "style.css"), "utf8");
  const pachetB = css.slice(css.indexOf("/* ─── Pachet B"));
  assert.doesNotMatch(pachetB, /#ccc/);
});
