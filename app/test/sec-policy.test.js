// Security package A (docs/design-securitate-2026-10.md): A5 status counts for rights, A7 task/reminder
// visibility + photo thumbnail never falls back to the original.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("sec_policy");
const { server } = require("../server");
const db = require("../src/db");
const { can, ROLES } = require("../src/domain/policy");
const tasks = require("../src/services/tasks");
const reminders = require("../src/services/reminders");

let BASE, M;
const getJson = async (cookie, url) => {
  const r = await fetch(`${BASE}${url}`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200, `${url}: ${await r.clone().text()}`);
  return r.json();
};

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "a", role: "member" },
    { key: "b", role: "member" },
  ]);
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

// ── A5 ─────────────────────────────────────────────────────────────────────────────────────────
test("A5: privileged roles lose their rights when not 'activ' (pauza / iesit / alumni)", () => {
  const privileged = {
    team_leader: ["members.manage", "warnings.record", "tasks.assign", "attendance.view_all", "members.manage_privileged", "documents.medical_other"],
    co_leader: ["members.manage", "announcements.publish", "deadlines.manage", "tasks.assign"],
    head_tech: ["tasks.assign", "events.manage", "groups.view_all", "assignments.view_dept"],
    head_nontech: ["absence.decide", "groups.manage", "announcements.publish", "deadlines.manage"],
    mentor: ["attendance.view_all", "assignments.view_all", "events.manage_urgenta", "documents.medical_other", "groups.view_all"],
  };
  for (const [role, actions] of Object.entries(privileged)) {
    for (const action of actions) {
      assert.equal(can({ id: 9, role, status: "activ" }, action), true, `${role} activ -> ${action}`);
      for (const status of ["pauza", "iesit", "alumni"]) {
        assert.equal(can({ id: 9, role, status }, action), false, `${role} ${status} -> ${action}`);
      }
    }
  }
  assert.ok(ROLES.team_leader);
});

test("A5: a paused leader is refused over HTTP too", async () => {
  const [pl] = Object.values(makeMembers(db, [{ key: "pl", role: "co_leader", status: "pauza" }]));
  const cookie = await login(BASE, pl.phone);
  assert.equal((await fetch(`${BASE}/api/admin/members`, { headers: { Cookie: cookie } })).status, 403);
});

// ── A7 ─────────────────────────────────────────────────────────────────────────────────────────
test("A7: members see only their own tasks (assigned to or created by them); managers see all", async () => {
  const tA = tasks.create(M.a, { title: "Taskul lui A" });
  const tB = tasks.create(M.b, { title: "Taskul lui B" });
  const tForA = tasks.create(M.tl, { title: "De la TL pentru A", assigned_member_id: M.a.id });
  const tForB = tasks.create(M.tl, { title: "De la TL pentru B", assigned_member_id: M.b.id });

  const a = await login(BASE, M.a.phone);
  const ids = (await getJson(a, "/api/tasks")).map((t) => t.id);
  assert.ok(ids.includes(tA.id) && ids.includes(tForA.id));
  assert.ok(!ids.includes(tB.id) && !ids.includes(tForB.id));

  const tl = await login(BASE, M.tl.phone);
  const all = (await getJson(tl, "/api/tasks")).map((t) => t.id);
  for (const t of [tA, tB, tForA, tForB]) assert.ok(all.includes(t.id));
  const ht = await login(BASE, M.ht.phone);
  assert.ok((await getJson(ht, "/api/tasks")).some((t) => t.id === tB.id));

  // the profile page goes through the same filter
  const prof = await getJson(a, `/api/members/${M.b.id}`);
  assert.deepEqual(prof.tasks, []);
});

test("A7: /api/reminders follows the same rule", async () => {
  const when = new Date(Date.now() + 86400000).toISOString();
  const rB = reminders.create(M.b, { message: "Reminder B", remind_at: when });
  const rA = reminders.create(M.a, { message: "Reminder A", remind_at: when });
  const a = await login(BASE, M.a.phone);
  const ids = (await getJson(a, "/api/reminders")).map((r) => r.id);
  assert.ok(ids.includes(rA.id));
  assert.ok(!ids.includes(rB.id));
  const tl = await login(BASE, M.tl.phone);
  assert.ok((await getJson(tl, "/api/reminders")).some((r) => r.id === rB.id));
});

test("A7: /api/photos/:id/thumb serves a placeholder, never the original, when there is no thumbnail", async () => {
  const album = db.prepare("INSERT INTO albums (title, created_by) VALUES ('Album', ?)").run(M.tl.id).lastInsertRowid;
  const dir = process.env.PHOTOS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "orig.heic"), "ORIGINAL-BYTES");
  const photo = db.prepare("INSERT INTO photos (album_id, file_path, thumb_path, mime, media_type, size, uploaded_by) VALUES (?, 'orig.heic', NULL, 'image/heic', 'image', 14, ?)")
    .run(album, M.tl.id).lastInsertRowid;
  const a = await login(BASE, M.a.phone);
  const r = await fetch(`${BASE}/api/photos/${photo}/thumb`, { headers: { Cookie: a } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /image\/svg\+xml/);
  assert.ok(!(await r.text()).includes("ORIGINAL-BYTES"));
});
