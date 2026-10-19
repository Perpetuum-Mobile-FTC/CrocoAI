// Security package A (docs/design-securitate-2026-10.md): A1 passwords + server-side must_change,
// A6 role hierarchy (only the Team Leader touches team_leader/co_leader/mentor).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("sec_auth");
const { server } = require("../server");
const db = require("../src/db");
const members = require("../src/services/members");
const registration = require("../src/services/registration");
const { DomainError } = require("../src/domain/errors");

let BASE, M;
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];
const req = (cookie, method, url, body) => fetch(`${BASE}${url}`, {
  method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
async function loginWith(identifier, password) {
  const res = await req(null, "POST", "/api/auth/login", { phone: identifier, password });
  return { res, cookie: cookieOf(res) };
}
const fresh = (id) => db.prepare("SELECT * FROM members WHERE id = ?").get(id);

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "co", role: "co_leader" },
    { key: "co2", role: "co_leader" },
    { key: "mentor", role: "mentor" },
    { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "mem", role: "member" },
    { key: "mem2", role: "member" },
  ]);
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

// ── A1. Passwords ───────────────────────────────────────────────────────────────────────────────

test("A1: members.create gives a random (crypto) temporary password, never the old default", async () => {
  const a = members.create(M.tl, { name: "Nou Unu", phone: "0744100001" });
  const b = members.create(M.tl, { name: "Nou Doi", phone: "0744100002" });
  assert.notEqual(a.password, "perpetuum2026");
  assert.ok(a.password.length >= 10, a.password);
  assert.notEqual(a.password, b.password);
  assert.equal(fresh(a.id).must_change_password, 1);
  assert.equal((await loginWith(a.username, "perpetuum2026")).res.status, 401);
  assert.equal((await loginWith(a.username, a.password)).res.status, 200);
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "username.js"), "utf8");
  assert.ok(!/Math\.random/.test(src), "temporary passwords must not use Math.random");
});

test("A1: import returns each created account's username + one-time password", () => {
  const out = members.commitImport(M.tl, [{ name: "Import Unu", phone: "0744100003" }]);
  const row = out.find((r) => r.action === "create");
  assert.ok(row.username);
  assert.ok(row.password && row.password.length >= 10);
  assert.ok(bcrypt.compareSync(row.password, fresh(row.id).password_hash));
});

test("A1: must_change_password is enforced on the server - only me/change-password/logout work", async () => {
  const a = members.create(M.tl, { name: "Schimba Parola", phone: "0744100004" });
  const { cookie } = await loginWith(a.username, a.password);
  const blocked = await req(cookie, "GET", "/api/tasks");
  assert.equal(blocked.status, 403);
  const body = await blocked.json();
  assert.equal(body.code, "MUST_CHANGE_PASSWORD");
  assert.match(body.error, /schimbi parola/);
  assert.equal((await req(cookie, "GET", "/api/members")).status, 403);
  assert.equal((await req(cookie, "GET", "/api/auth/me")).status, 200);

  // too short, and identical to the temporary one -> refused
  assert.equal((await req(cookie, "POST", "/api/auth/change-password", { new_password: "1234567" })).status, 400);
  assert.equal((await req(cookie, "POST", "/api/auth/change-password", { new_password: a.password })).status, 400);
  // no current password needed while must_change=1
  const ok = await req(cookie, "POST", "/api/auth/change-password", { new_password: "parolaNoua1" });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(fresh(a.id).must_change_password, 0);
  assert.equal((await req(cookie, "GET", "/api/auth/me")).status, 401); // old session invalidated
  const again = await loginWith(a.username, "parolaNoua1");
  assert.equal((await req(again.cookie, "GET", "/api/tasks")).status, 200);
});

test("A1: a voluntary password change needs the current password and >= 8 characters", async () => {
  const cookie = await login(BASE, M.mem.phone);
  assert.equal((await req(cookie, "POST", "/api/auth/change-password", { new_password: "altaParola1" })).status, 400);
  assert.equal((await req(cookie, "POST", "/api/auth/change-password", { current_password: "gresit", new_password: "altaParola1" })).status, 403);
  assert.equal((await req(cookie, "POST", "/api/auth/change-password", { current_password: "test1234", new_password: "scurt" })).status, 400);
  const ok = await req(cookie, "POST", "/api/auth/change-password", { current_password: "test1234", new_password: "altaParola1" });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.ok(bcrypt.compareSync("altaParola1", fresh(M.mem.id).password_hash));
  db.prepare("UPDATE members SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync("test1234", 4), M.mem.id);
});

test("A1: reset password -> random temporary (>= 10 chars), must_change=1", () => {
  const { password } = members.resetPassword(M.tl, M.mem2.id);
  assert.ok(password.length >= 10);
  assert.equal(fresh(M.mem2.id).must_change_password, 1);
  db.prepare("UPDATE members SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(bcrypt.hashSync("test1234", 4), M.mem2.id);
});

test("A1: logout invalidates the session token (token_version++)", async () => {
  const cookie = await login(BASE, M.mem2.phone);
  const tvBefore = fresh(M.mem2.id).token_version;
  assert.equal((await req(cookie, "POST", "/api/auth/logout")).status, 200);
  assert.equal(fresh(M.mem2.id).token_version, tvBefore + 1);
  assert.equal((await req(cookie, "GET", "/api/auth/me")).status, 401); // a copied cookie is dead too
});

// ── A6. Role hierarchy ─────────────────────────────────────────────────────────────────────────

test("A6: only the Team Leader grants or removes team_leader / co_leader / mentor", () => {
  for (const role of ["team_leader", "co_leader", "mentor"]) {
    assert.throws(() => members.update(M.co, M.mem.id, { role }), (e) => e instanceof DomainError && e.code === "FORBIDDEN", role);
  }
  assert.throws(() => members.update(M.co, M.mentor.id, { role: "member" }), DomainError); // removing mentor
  assert.throws(() => members.update(M.co, M.co2.id, { role: "member" }), DomainError); // demoting another co-leader
  assert.throws(() => members.create(M.co, { name: "Alt Lider", role: "co_leader" }), DomainError);
  // co-leader still manages the other roles
  assert.equal(members.update(M.co, M.mem.id, { role: "head_nontech" }).role, "head_nontech");
  assert.equal(members.update(M.co, M.mem.id, { role: "member" }).role, "member");
  // Team Leader may
  assert.equal(members.update(M.tl, M.mem.id, { role: "mentor" }).role, "mentor");
  assert.equal(members.update(M.tl, M.mem.id, { role: "member" }).role, "member");
});

test("A6: a co-leader cannot change their own role", () => {
  assert.throws(() => members.update(M.co, M.co.id, { role: "team_leader" }), DomainError);
  assert.throws(() => members.update(M.co, M.co.id, { role: "member" }), DomainError);
  assert.equal(fresh(M.co.id).role, "co_leader");
  // other fields of one's own row stay editable
  assert.equal(members.update(M.co, M.co.id, { email: "co@exemplu.ro" }).email, "co@exemplu.ro");
});

test("A6: password reset of an equal-or-higher account is Team Leader only", () => {
  for (const target of [M.tl, M.co2, M.mentor]) {
    assert.throws(() => members.resetPassword(M.co, target.id), (e) => e instanceof DomainError && e.code === "FORBIDDEN");
  }
  assert.ok(members.resetPassword(M.co, M.ht.id).password);
  assert.ok(members.resetPassword(M.tl, M.co2.id).password);
  db.prepare("UPDATE members SET password_hash = ?, must_change_password = 0 WHERE id IN (?, ?)").run(bcrypt.hashSync("test1234", 4), M.ht.id, M.co2.id);
});

test("A6: a co-leader cannot pause/remove the Team Leader or a mentor; role requests for those roles are TL-only", async () => {
  assert.throws(() => members.changeStatus(M.co, M.tl.id, "pauza"), DomainError);
  assert.throws(() => members.changeStatus(M.co, M.mentor.id, "iesit"), DomainError);
  assert.equal(fresh(M.tl.id).status, "activ");

  const [req1] = Object.values(makeMembers(db, [{ key: "rq", role: "member" }]));
  db.prepare("UPDATE members SET requested_role = 'co_leader' WHERE id = ?").run(req1.id);
  assert.throws(() => registration.decideRoleRequest(M.co, req1.id, true), DomainError);
  assert.equal(registration.decideRoleRequest(M.tl, req1.id, true).role, "co_leader");

  // HTTP: same rule through the admin route
  const co = await login(BASE, M.co.phone);
  const r = await req(co, "POST", `/api/admin/members/${M.tl.id}/reset-password`);
  assert.equal(r.status, 403);
});
