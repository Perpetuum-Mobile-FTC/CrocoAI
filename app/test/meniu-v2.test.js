// Simplified menu + tasks with reminder (docs/design-meniu-v2.md §3): legacy URLs redirect (server-side
// 302) to the new sections/tabs, section/tab visibility per role, a task's remind_at fires once at the
// right local instant (also across DST), migration 018 moves unsent reminders into tasks, the AI tool
// creeaza_reminder creates a task, /api/reminders stays compatible.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { initEnv, makeMembers, login } = require("./_assign-env");

const env = initEnv("meniu_v2");
const { server } = require("../server");
const db = require("../src/db");
const { uiPermissions } = require("../src/domain/policy");
const tasksSvc = require("../src/services/tasks");
const scheduler = require("../src/services/reminder-scheduler");
const { buildToolList } = require("../src/ai/tools");

let BASE;
let M;
before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "head", role: "head_tech", department: "tehnic" },
    { key: "a", role: "member" },
    { key: "b", role: "member" },
    { key: "nophone", role: "member" },
  ]);
  db.prepare("UPDATE members SET phone = ? WHERE id = ?").run(`pending-${Date.now()}`, M.nophone.id);
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  env.cleanup();
});
beforeEach(() => {
  env.waSent.length = 0;
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM notifications").run();
});

const get = (p, cookie) => fetch(`${BASE}${p}`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
const at = (iso) => new Date(iso);
const taskReminders = (title) => env.waSent.filter((m) => m.text === `Reminder: ${title}`);

// ─── Legacy URLs + SPA routes ───

const LEGACY = {
  "/prezenta": "/sedinte?tab=prezenta",
  "/taskuri": "/teme?tab=taskuri",
  "/remindere": "/teme?tab=taskuri",
  "/membri": "/echipa?tab=membri",
  "/grupuri": "/echipa?tab=grupuri",
  "/regulament": "/documente?tab=regulament",
  "/poze": "/documente?tab=poze",
  "/chat-echipa": "/anunturi", // pachet B: the team chat is gone, its Anunțuri channel lives on
  "/mesaje": "/admin",
};

test("every legacy URL redirects (302) to its section/tab, with or without a session", async () => {
  const cookie = await login(BASE, M.a.phone);
  for (const [from, to] of Object.entries(LEGACY)) {
    for (const c of [cookie, null]) {
      const res = await get(from, c);
      assert.equal(res.status, 302, from);
      assert.equal(res.headers.get("location"), to, from);
    }
  }
});

test("new sections and kept deep links are served to a logged-in user; logged out -> login with the full next", async () => {
  const cookie = await login(BASE, M.a.phone);
  for (const p of ["/", "/sedinte", "/teme", "/teme/3", "/calendar", "/echipa", "/documente", "/chat", "/admin",
    "/membri/5", "/prezenta/sesiune/7", "/p/abc", "/teme?tab=taskuri"]) {
    const res = await get(p, cookie);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get("content-type"), /text\/html/);
  }
  const res = await get("/teme?tab=taskuri");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/login?next=${encodeURIComponent("/teme?tab=taskuri")}`);
});

// ─── Menu model per role (public/js/sections.js, pure ES module) ───

async function sectionsModule() {
  const tmp = path.join(os.tmpdir(), `crocoai-sections-${process.pid}.mjs`);
  fs.copyFileSync(path.join(__dirname, "..", "public", "js", "sections.js"), tmp);
  try { return await import(pathToFileURL(tmp).href); } finally { fs.unlinkSync(tmp); }
}

test("sections, tabs and the mobile bar per role", async () => {
  const S = await sectionsModule();
  // /api/auth/me shape: permissions from policy (F2: sections.js has no role lists).
  const me = (role, meetings_section) => ({ role, status: "activ", meetings_section, permissions: uiPermissions({ id: 1, role, status: "activ" }) });
  const tl = me("team_leader", true);
  const head = me("head_tech", true);
  const member = me("member", false);
  const groupLeader = me("member", true);
  const keys = (u) => S.visibleSections(u).map((s) => s.key);
  const tabs = (key, u) => S.visibleTabs(S.SECTIONS.find((s) => s.key === key), u).map((t) => t.key);

  assert.deepEqual(keys(tl), ["acasa", "sedinte", "teme", "calendar", "echipa", "documente", "chat", "admin"]);
  assert.deepEqual(keys(head), ["acasa", "sedinte", "teme", "calendar", "echipa", "documente", "chat", "admin"]); // Admin → Termene (pachet B)
  assert.deepEqual(keys(member), ["acasa", "teme", "calendar", "echipa", "documente", "chat"]);
  assert.deepEqual(keys(groupLeader), ["acasa", "sedinte", "teme", "calendar", "echipa", "documente", "chat"]);

  assert.deepEqual(tabs("sedinte", tl), ["sedinte", "prezenta"]);
  assert.deepEqual(tabs("sedinte", member), ["prezenta"], "attendance stays reachable (legacy /prezenta) as today");
  assert.deepEqual(tabs("teme", member), ["teme", "taskuri"]);
  assert.deepEqual(tabs("echipa", member), ["membri", "grupuri"]);
  assert.deepEqual(tabs("documente", member), ["documente", "resurse", "regulament", "poze"]);
  assert.deepEqual(tabs("admin", tl), ["admin", "cereri-rol", "termene"]);
  assert.deepEqual(tabs("admin", head), ["termene"]);
  assert.equal(S.activeTab(S.SECTIONS.find((s) => s.key === "admin"), head, "admin"), "termene");
  assert.equal(S.sectionForPath("/anunturi"), "acasa");

  assert.deepEqual(S.bottomKeys(tl), ["acasa", "sedinte", "teme", "chat"]);
  assert.deepEqual(S.bottomKeys(member), ["acasa", "teme", "calendar", "chat"]);

  const teme = S.SECTIONS.find((s) => s.key === "teme");
  assert.equal(S.activeTab(teme, member, "taskuri"), "taskuri");
  assert.equal(S.activeTab(teme, member, "nope"), "teme");
  assert.equal(S.activeTab(S.SECTIONS.find((s) => s.key === "sedinte"), member, "sedinte"), "prezenta");

  assert.equal(S.sectionForPath("/membri/5"), "echipa");
  assert.equal(S.sectionForPath("/prezenta/sesiune/3"), "sedinte");
  assert.equal(S.sectionForPath("/teme/9"), "teme");
  assert.equal(S.sectionForPath("/"), "acasa");
});

// ─── Tasks with reminder: scheduler ───

test("a task reminder is sent once (WhatsApp + in-app) at remind_at, Bucharest local time", async () => {
  const t = tasksSvc.create(M.tl, { title: "Adu bateriile", assigned_member_id: M.a.id, remind_at: "2026-10-20T17:00" });
  assert.equal(t.remind_at, "2026-10-20T14:00:00.000Z", "EEST = UTC+3");
  assert.equal(t.reminded, 0);
  assert.equal(t.created_by, M.tl.id);

  await scheduler.tick(at("2026-10-20T13:59:00Z"));
  assert.equal(taskReminders("Adu bateriile").length, 0);
  await scheduler.tick(at("2026-10-20T14:00:30Z"));
  assert.deepEqual(taskReminders("Adu bateriile").map((m) => m.to), [M.a.phone]);
  await scheduler.tick(at("2026-10-20T14:05:00Z"));
  assert.equal(taskReminders("Adu bateriile").length, 1, "only once");
  assert.equal(tasksSvc.requireTask(t.id).reminded, 1);
  const notif = db.prepare("SELECT * FROM notifications WHERE member_id = ? AND type = 'reminder'").all(M.a.id);
  assert.equal(notif.length, 1);
  assert.equal(notif[0].body, "Adu bateriile");
  assert.equal(notif[0].link, "/teme?tab=taskuri");
});

test("across DST end (2026-10-25 04:00 local): 10:00 local is 08:00Z after, 07:00Z the day before", async () => {
  const after_ = tasksSvc.create(M.a, { title: "Dupa DST", remind_at: "2026-10-25T10:00" });
  const before_ = tasksSvc.create(M.a, { title: "Inainte de DST", remind_at: "2026-10-24T10:00" });
  assert.equal(after_.remind_at, "2026-10-25T08:00:00.000Z");
  assert.equal(before_.remind_at, "2026-10-24T07:00:00.000Z");
  await scheduler.tick(at("2026-10-24T06:59:00Z"));
  assert.equal(taskReminders("Inainte de DST").length, 0);
  await scheduler.tick(at("2026-10-24T07:00:00Z"));
  assert.equal(taskReminders("Inainte de DST").length, 1);
  await scheduler.tick(at("2026-10-25T07:59:00Z"));
  assert.equal(taskReminders("Dupa DST").length, 0, "not an hour early");
  await scheduler.tick(at("2026-10-25T08:00:00Z"));
  assert.equal(taskReminders("Dupa DST").length, 1);
});

test("done tasks are not reminded; pending-* phone -> in-app only; ISO with offset kept as the same instant", async () => {
  const done = tasksSvc.create(M.a, { title: "Gata deja", remind_at: "2026-11-02T10:00" });
  tasksSvc.updateStatus(M.a, done.id, "done");
  const np = tasksSvc.create(M.tl, { title: "Fara telefon", assigned_member_id: M.nophone.id, remind_at: "2026-11-02T10:00:00+02:00" });
  assert.equal(np.remind_at, "2026-11-02T08:00:00.000Z");
  await scheduler.tick(at("2026-11-02T09:00:00Z"));
  assert.equal(taskReminders("Gata deja").length, 0);
  assert.equal(tasksSvc.requireTask(done.id).reminded, 0);
  assert.equal(taskReminders("Fara telefon").length, 0);
  assert.equal(tasksSvc.requireTask(np.id).reminded, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND type = 'reminder'").get(M.nophone.id).c, 1);
});

test("gateway down: attempts counted, failed after 5, never marked reminded", async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => (String(url).startsWith(process.env.WA_GATEWAY_URL) ? new Response("x", { status: 500 }) : realFetch(url, opts));
  const errLog = console.error;
  console.error = () => {};
  try {
    const t = tasksSvc.create(M.a, { title: "Gateway jos", remind_at: "2026-11-03T10:00" });
    for (let i = 0; i < 6; i++) await scheduler.tick(at("2026-11-03T09:00:00Z"));
    const row = tasksSvc.requireTask(t.id);
    assert.equal(row.reminded, 0);
    assert.equal(row.remind_attempts, 5);
    assert.equal(row.remind_failed, 1);
  } finally {
    global.fetch = realFetch;
    console.error = errLog;
  }
});

test("editing remind_at re-arms the reminder; invalid dates are refused", () => {
  const t = tasksSvc.create(M.a, { title: "Re-arm", remind_at: "2026-11-04T10:00" });
  db.prepare("UPDATE tasks SET reminded = 1 WHERE id = ?").run(t.id);
  const u = tasksSvc.update(M.tl, t.id, { remind_at: "2026-11-05T09:30" });
  assert.equal(u.remind_at, "2026-11-05T07:30:00.000Z");
  assert.equal(u.reminded, 0);
  assert.equal(tasksSvc.update(M.tl, t.id, { remind_at: null }).remind_at, null);
  assert.throws(() => tasksSvc.create(M.a, { title: "x", remind_at: "mâine" }), (e) => e.code === "INVALID");
});

// ─── /api/reminders compatibility + AI tool ───

test("/api/reminders: POST creates a task with remind_at, GET lists it reminder-shaped, DELETE removes the task", async () => {
  const cookie = await login(BASE, M.head.phone);
  const post = await fetch(`${BASE}/api/reminders`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ target_member_id: M.a.id, message: "Compat", remind_at: "2026-11-06T18:00" }),
  });
  assert.equal(post.status, 200);
  const r = await post.json();
  assert.equal(r.message, "Compat");
  assert.equal(r.remind_at, "2026-11-06T16:00:00.000Z");
  assert.equal(r.target_member_id, M.a.id);
  assert.equal(r.sent, 0);
  const task = tasksSvc.requireTask(r.task_id);
  assert.equal(task.title, "Compat");
  assert.equal(task.assigned_member_id, M.a.id);

  const list = await (await fetch(`${BASE}/api/reminders?sent=0`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(list.map((x) => x.message), ["Compat"]);
  const tasks = await (await fetch(`${BASE}/api/tasks`, { headers: { Cookie: cookie } })).json();
  assert.equal(tasks.find((x) => x.id === r.task_id).remind_at, "2026-11-06T16:00:00.000Z");

  const del = await fetch(`${BASE}/api/reminders/${r.id}`, { method: "DELETE", headers: { Cookie: cookie } });
  assert.equal(del.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tasks WHERE id = ?").get(r.task_id).c, 0);

  const memberCookie = await login(BASE, M.a.phone);
  const forbidden = await fetch(`${BASE}/api/reminders`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: memberCookie },
    body: JSON.stringify({ target_member_id: M.b.id, message: "x", remind_at: "2026-11-06T18:00" }),
  });
  assert.equal(forbidden.status, 403);
});

test("AI creeaza_reminder creates the same task as POST /api/reminders (local time, not UTC)", async () => {
  const list = await buildToolList({ actor: M.a, channel: "web", chatId: `web:${M.a.id}` });
  const tool = list.find((t) => t.name === "creeaza_reminder");
  const out = await tool.handler({ mesaj: "Sună la sponsor", cand: "2026-11-07T17:00" }, {});
  assert.equal(out.isError, undefined, out.content[0].text);
  assert.match(out.content[0].text, /07\.11\.2026.*17:00/);
  const viaTool = db.prepare("SELECT * FROM tasks WHERE title = 'Sună la sponsor'").get();

  const cookie = await login(BASE, M.a.phone);
  const viaHttp = await (await fetch(`${BASE}/api/reminders`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message: "Sună la sponsor (http)", remind_at: "2026-11-07T17:00" }),
  })).json();
  const httpTask = tasksSvc.requireTask(viaHttp.task_id);
  for (const k of ["remind_at", "assigned_member_id", "created_by", "status", "reminded"]) assert.equal(viaTool[k], httpTask[k], k);
  assert.equal(viaTool.remind_at, "2026-11-07T15:00:00.000Z");
});

// ─── Migration 018 ───

test("migration 018 moves unsent member reminders into tasks; phone-only, sent and failed stay in reminders", async () => {
  const Database = require("better-sqlite3");
  const file = path.join(__dirname, "._meniu_v2_migr.db");
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(file + ext); } catch {} }
  const old = new Database(file);
  const dir = path.join(__dirname, "..", "src", "db", "migrations");
  const files = fs.readdirSync(dir).filter((f) => /\.(sql|js)$/.test(f)).sort();
  const idx = files.findIndex((f) => f.startsWith("018_"));
  assert.ok(idx > 0, "migration 018 exists");
  for (const f of files.slice(0, idx)) {
    if (f.endsWith(".sql")) old.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    else require(path.join(dir, f)).up(old);
  }
  const mid = old.prepare("INSERT INTO members (full_name, phone, role, status) VALUES ('Ana', '40711111113', 'member', 'activ')").run().lastInsertRowid;
  const ins = old.prepare("INSERT INTO reminders (target_phone, target_name, target_member_id, message, remind_at, sent, failed) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const local = ins.run("40711111113", "Ana", mid, "Local", "2026-10-26T17:00", 0, 0).lastInsertRowid; // platform form (EET)
  const utc = ins.run("40711111113", "Ana", mid, "UTC", "2026-10-20T10:00:00.000Z", 0, 0).lastInsertRowid; // AI tool
  const phoneOnly = ins.run("40722222222", "Extern", null, "Telefon", "2026-10-20T10:00:00.000Z", 0, 0).lastInsertRowid;
  const sent = ins.run("40711111113", "Ana", mid, "Trimis", "2026-10-01T10:00:00.000Z", 1, 0).lastInsertRowid;
  const failed = ins.run("40711111113", "Ana", mid, "Esuat", "2026-10-01T10:00:00.000Z", 0, 1).lastInsertRowid;
  const oldTask = old.prepare("INSERT INTO tasks (title, assigned_member_id, status) VALUES ('Vechi', ?, 'pending')").run(mid).lastInsertRowid;

  require(path.join(dir, files[idx])).up(old);
  const rem = (id) => old.prepare("SELECT * FROM reminders WHERE id = ?").get(id);
  const task = (id) => old.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  const tLocal = task(rem(local).migrated_task_id);
  assert.deepEqual([tLocal.title, tLocal.assigned_member_id, tLocal.assigned_name, tLocal.remind_at, tLocal.reminded, tLocal.status],
    ["Local", mid, "Ana", "2026-10-26T15:00:00.000Z", 0, "pending"]);
  assert.equal(task(rem(utc).migrated_task_id).remind_at, "2026-10-20T10:00:00.000Z");
  for (const id of [phoneOnly, sent, failed]) assert.equal(rem(id).migrated_task_id, null);
  assert.equal(old.prepare("SELECT COUNT(*) c FROM reminders").get().c, 5, "reminders table kept as history");
  assert.deepEqual([task(oldTask).remind_at, task(oldTask).reminded, task(oldTask).created_by], [null, 0, null]);
  old.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(file + ext); } catch {} }
});

test("scheduler: a migrated reminder is sent once (as a task); a phone-only legacy reminder still goes the old path", async () => {
  const t = tasksSvc.create(M.a, { title: "Migrat", remind_at: "2026-11-08T10:00" });
  const ins = db.prepare("INSERT INTO reminders (target_phone, target_name, target_member_id, message, remind_at, migrated_task_id) VALUES (?, ?, ?, ?, ?, ?)");
  ins.run(M.a.phone, "A", M.a.id, "Migrat", "2026-11-08T08:00:00.000Z", t.id);
  ins.run("40733333333", "Extern", null, "Legacy telefon", "2026-11-08T08:00:00.000Z", null);
  await scheduler.tick(at("2026-11-08T09:00:00Z"));
  assert.equal(taskReminders("Migrat").length, 1);
  assert.deepEqual(env.waSent.filter((m) => m.text === "Reminder: Legacy telefon").map((m) => m.to), ["40733333333"]);
  db.prepare("DELETE FROM reminders").run();
});

// ─── Fix round 1 ───

test("a rejected edit (invalid remind_at) changes nothing; re-saving the same instant doesn't re-arm", () => {
  const t = tasksSvc.create(M.a, { title: "Atomic", due_date: "2026-11-10", remind_at: "2026-11-09T10:00" });
  assert.throws(() => tasksSvc.update(M.tl, t.id, { title: "Schimbat", due_date: "2026-12-01", remind_at: "2026-02-30T10:00" }), (e) => e.code === "INVALID");
  const row = tasksSvc.requireTask(t.id);
  assert.deepEqual([row.title, row.due_date, row.remind_at], ["Atomic", "2026-11-10", "2026-11-09T08:00:00.000Z"]);

  db.prepare("UPDATE tasks SET reminded = 1 WHERE id = ?").run(t.id);
  // same instant, different spelling (local form vs ISO with offset) -> stays reminded
  assert.equal(tasksSvc.update(M.tl, t.id, { remind_at: "2026-11-09T10:00:00+02:00" }).reminded, 1);
  assert.equal(tasksSvc.update(M.tl, t.id, { remind_at: "2026-11-09T10:00" }).reminded, 1);
});

test("toUtcIso rejects impossible calendar dates", () => {
  const { toUtcIso } = require("../src/domain/time");
  for (const v of ["2026-02-30T10:00", "2026-04-31T08:00", "2027-02-29T12:00"]) assert.equal(toUtcIso(v), null, v);
  assert.equal(toUtcIso("2028-02-29T12:00"), "2028-02-29T10:00:00.000Z");
});

test("members edit tasks they created for themselves; not others' tasks, not tasks assigned to them by a manager", async () => {
  const own = tasksSvc.create(M.a, { title: "Al meu", remind_at: "2026-11-11T10:00" });
  const u = tasksSvc.update(M.a, own.id, { title: "Al meu (2)", due_date: "2026-11-12", remind_at: "2026-11-11T12:00" });
  assert.deepEqual([u.title, u.due_date, u.remind_at], ["Al meu (2)", "2026-11-12", "2026-11-11T10:00:00.000Z"]);
  assert.equal(tasksSvc.updateStatus(M.a, own.id, "done").status, "done");
  // assigning it to someone else stays MANAGERS-only
  assert.throws(() => tasksSvc.update(M.a, own.id, { assigned_member_id: M.b.id }), (e) => e.code === "FORBIDDEN");
  assert.equal(tasksSvc.requireTask(own.id).assigned_member_id, M.a.id);

  const fromManager = tasksSvc.create(M.tl, { title: "De la TL", assigned_member_id: M.a.id });
  assert.throws(() => tasksSvc.update(M.a, fromManager.id, { title: "x" }), (e) => e.code === "FORBIDDEN");
  const othersOwn = tasksSvc.create(M.b, { title: "Al lui B" });
  assert.throws(() => tasksSvc.update(M.a, othersOwn.id, { title: "x" }), (e) => e.code === "FORBIDDEN");

  // same rule through the route (PUT /api/tasks/:id)
  const cookie = await login(BASE, M.a.phone);
  const put = (id) => fetch(`${BASE}/api/tasks/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ title: "via HTTP" }) });
  assert.equal((await put(own.id)).status, 200);
  assert.equal((await put(fromManager.id)).status, 403);
});

test("attendance stats include the member's last sessions (for the Acasă card)", () => {
  const attendanceSvc = require("../src/services/attendance");
  const ins = db.prepare("INSERT INTO attendance_sessions (date, start_time, type, title) VALUES (?, '18:00', 'sedinta', ?)");
  const ids = ["2026-10-01", "2026-10-05", "2026-10-08"].map((d, i) => ins.run(d, `S${i}`).lastInsertRowid);
  const rec = db.prepare("INSERT INTO attendance_records (session_id, member_id, status) VALUES (?, ?, ?)");
  rec.run(ids[0], M.b.id, "prezent"); rec.run(ids[1], M.b.id, "absent"); rec.run(ids[2], M.b.id, "motivat");
  const s = attendanceSvc.statsFor(M.b, M.b.id);
  assert.deepEqual(s.recent.map((r) => [r.date, r.title, r.status]), [["2026-10-08", "S2", "motivat"], ["2026-10-05", "S1", "absent"], ["2026-10-01", "S0", "prezent"]]);
  assert.throws(() => attendanceSvc.statsFor(M.a, M.b.id), (e) => e.code === "FORBIDDEN");
});

test("notification links: role request -> Admin/Cereri de rol tab", () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", "services", f), "utf8");
  assert.match(src("registration.js"), /"role_request"[^\n]*"\/admin\?tab=cereri-rol"/);
  // pachet B: links that pointed to pages which do not exist in the SPA
  assert.match(src("absences.js"), /'absence_decided', \?, \?, '\/#prezenta-mea'\)/);
  assert.match(src("documents.js"), /'document_reviewed', \?, \?, '\/documente'\)/);
  assert.match(src("warnings.js"), /`\/membri\/\$\{member_id\}`/);
  assert.match(src("announcements.js"), /const LINK = "\/anunturi"/);
});
