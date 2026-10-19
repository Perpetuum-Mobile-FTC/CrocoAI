// Self-registration (docs/design-inregistrare.md): POST /api/public/register (+ /register/verify since A3) + role requests.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("registration_self");
process.env.OTP_MAX_GLOBAL_HOUR = "1000"; // this file registers far more than 60 accounts in an hour
const { server } = require("../server");
const db = require("../src/db");

let BASE, M, ipN = 0, seq = 0;
const nextIp = () => { ipN++; return `10.9.${Math.floor(ipN / 250)}.${ipN % 250}`; };

function yearsAgo(n) {
  const d = new Date(); d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}
function student(over = {}) {
  seq++;
  return {
    role_choice: "membru", full_name: "Ana Popescu", phone: `4073${String(1000000 + seq)}`,
    username: `ana.user${seq}`, password: "parola1234", password_confirm: "parola1234",
    email: `ana${seq}@eminescusm.ro`, school: "CN Mihai Eminescu", class: "a XI-a B",
    birthdate: yearsAgo(17 + 1), department: "tehnic", gdpr_ack: true, ...over,
  };
}
function mentor(over = {}) {
  seq++;
  return {
    role_choice: "mentor", full_name: "Mihai Mentor", phone: `4073${String(1000000 + seq)}`,
    username: `mentor.${seq}`, password: "parola1234", password_confirm: "parola1234",
    email: `mentor${seq}@gmail.com`, gdpr_ack: true, ...over,
  };
}
// Since security package A3 the account is created only after the WhatsApp code: this helper runs both
// steps (form -> code from the mocked gateway -> verify) and returns the final response, or the first
// step's response when the form is refused.
const postStep = (url, body, ip) => fetch(`${BASE}/api/public${url}`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify(body),
});
async function post(body, ip) {
  ip = ip || nextIp();
  const first = await postStep("/register", body, ip);
  if (first.status !== 200) return first;
  const data = await first.clone().json();
  if (!data.pending_id) return first; // honeypot
  const sent = [...env.waSent].reverse().find((m) => m.to === db.prepare("SELECT phone FROM pending_registrations WHERE id = ?").get(data.pending_id).phone);
  const code = sent.text.match(/\b(\d{6})\b/)[1];
  return postStep("/register/verify", { pending_id: data.pending_id, code }, ip);
}
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];
const getJson = (cookie, url) => fetch(`${BASE}${url}`, { headers: { Cookie: cookie } });
const postJson = (cookie, url, body) => fetch(`${BASE}${url}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
const memberBy = (username) => db.prepare("SELECT * FROM members WHERE username = ?").get(username);

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" },
    { key: "co", role: "co_leader" },
    { key: "mem", role: "member" },
    { key: "hn", role: "head_nontech", department: "non-tehnic" },
  ]);
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

test("Eminescu student registers, gets logged in, role member", async () => {
  const body = student();
  const res = await post(body);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { ok: true, redirect: "/" });
  const me = await (await getJson(cookieOf(res), "/api/auth/me")).json();
  assert.equal(me.role, "member");
  const m = memberBy(body.username);
  assert.equal(m.status, "activ");
  assert.equal(m.must_change_password, 0);
  assert.equal(m.requested_role, null);
  assert.equal(m.school, "CN Mihai Eminescu");
  // can log in again with the chosen password
  const l = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: body.username, password: body.password }) });
  assert.equal(l.status, 200);
});

test("recruit -> volunteer, needs motivation, checklist started, dept heads notified", async () => {
  const noMot = await post(student({ role_choice: "recrut" }));
  assert.equal(noMot.status, 400);
  assert.ok((await noMot.json()).errors.motivation);
  const body = student({ role_choice: "recrut", motivation: "Vreau robotică.", department: "non-tehnic" });
  const res = await post(body);
  assert.equal(res.status, 200);
  const m = memberBy(body.username);
  assert.equal(m.role, "volunteer");
  assert.equal(m.auth_role, "volunteer");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM onboarding WHERE member_id = ?").get(m.id).c, 1);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE member_id = ? AND type = 'onboarding_completed'").get(M.hn.id));
});

test("Eminescu requires @eminescusm.ro; Slavici and other accept any email", async () => {
  const bad = await post(student({ email: "ana@gmail.com" }));
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).errors.email);
  assert.equal((await post(student({ school: "CN Ioan Slavici", email: "x@gmail.com" }))).status, 200);
  assert.equal((await post(student({ school: "Altă școală", school_other: "Liceul X", email: "y@yahoo.com", username: "alt.scoala" }))).status, 200);
  assert.equal(memberBy("alt.scoala").school, "Liceul X");
  const noOther = await post(student({ school: "Altă școală", email: "z@yahoo.com" }));
  assert.equal(noOther.status, 400);
  assert.ok((await noOther.json()).errors.school_other);
});

test("mentor without class/birthdate: member + requested_role mentor, leaders notified", async () => {
  const body = mentor();
  const res = await post(body);
  assert.equal(res.status, 200, await res.clone().text());
  const m = memberBy(body.username);
  assert.equal(m.role, "member");
  assert.equal(m.requested_role, "mentor");
  assert.equal(m.department, "ambele");
  const n = db.prepare("SELECT * FROM notifications WHERE member_id = ? AND body LIKE ? ORDER BY id DESC").get(M.tl.id, `%${body.full_name}%`);
  assert.ok(n && /cere rolul Mentor/.test(n.body) && n.link === "/admin?tab=cereri-rol");
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE member_id = ? AND body LIKE ?").get(M.co.id, `%${body.full_name}%`));
});

test("mentor still needs gdpr_ack and valid email", async () => {
  const res = await post(mentor({ gdpr_ack: false, email: "nu-email" }));
  assert.equal(res.status, 400);
  const e = (await res.json()).errors;
  assert.ok(e.gdpr_ack && e.email);
});

test("head_tech gets department tehnic + requested_role head_tech", async () => {
  const body = student({ role_choice: "head_tech", department: undefined });
  const res = await post(body);
  assert.equal(res.status, 200, await res.clone().text());
  const m = memberBy(body.username);
  assert.equal(m.department, "tehnic");
  assert.equal(m.requested_role, "head_tech");
  assert.equal(m.role, "member");
  const b2 = student({ role_choice: "head_nontech", department: undefined });
  assert.equal((await post(b2)).status, 200);
  assert.equal(memberBy(b2.username).department, "non-tehnic");
});

test("duplicate username (case-insensitive), phone, email -> field errors", async () => {
  const first = student();
  assert.equal((await post(first)).status, 200);
  const u = await post(student({ username: first.username.toUpperCase() }));
  assert.equal(u.status, 400);
  assert.ok((await u.json()).errors.username);
  const p = await post(student({ phone: first.phone }));
  assert.ok((await p.json()).errors.phone);
  const e = await post(student({ email: first.email.toUpperCase() }));
  assert.ok((await e.json()).errors.email);
});

test("password mismatch / too short / bad username rejected", async () => {
  const a = await post(student({ password_confirm: "altceva1234" }));
  assert.equal(a.status, 400);
  assert.ok((await a.json()).errors.password_confirm);
  const b = await post(student({ password: "scurt", password_confirm: "scurt" }));
  assert.ok((await b.json()).errors.password);
  const c = await post(student({ username: "a b" }));
  assert.ok((await c.json()).errors.username);
});

test("minor without guardian rejected; with guardian accepted and stored", async () => {
  const bad = await post(student({ birthdate: yearsAgo(14) }));
  assert.equal(bad.status, 400);
  const errs = (await bad.json()).errors;
  assert.ok(errs.guardian_name && errs.guardian_ack);
  const body = student({ birthdate: yearsAgo(14), guardian_name: "Maria Popescu", guardian_relation: "mama", guardian_phone: "0722111222", guardian_ack: true });
  assert.equal((await post(body)).status, 200);
  const m = memberBy(body.username);
  assert.equal(db.prepare("SELECT name FROM guardians WHERE member_id = ?").get(m.id).name, "Maria Popescu");
});

test("honeypot pretends success but creates nothing", async () => {
  const body = student({ website: "http://spam" });
  const res = await post(body);
  assert.equal(res.status, 200);
  assert.equal(memberBy(body.username), undefined);
});

test("audit row in applications with status inregistrat", async () => {
  const body = mentor();
  await post(body);
  const m = memberBy(body.username);
  const a = db.prepare("SELECT * FROM applications WHERE created_member_id = ?").get(m.id);
  assert.equal(a.status, "inregistrat");
  assert.ok(a.gdpr_ack_at);
  assert.match(a.ip_hash, /^[0-9a-f]{64}$/);
  assert.equal(a.motivation, "");
});

test("rate limit counts only successes: 35 invalid then a valid one -> 200; 31st success -> 429", async () => {
  const ip = "10.250.0.1";
  for (let i = 0; i < 35; i++) assert.equal((await post({ role_choice: "membru" }, ip)).status, 400);
  assert.equal((await post(student(), ip)).status, 200);
  const ip2 = "10.250.0.2";
  for (let i = 0; i < 30; i++) assert.equal((await post(student(), ip2)).status, 200, `success ${i + 1}`);
  assert.equal((await post(student(), ip2)).status, 429);
});

test("overall attempt cap: 300/hour per IP regardless of outcome", async () => {
  const ip = "10.250.0.3";
  for (let i = 0; i < 300; i++) await post({ role_choice: "membru" }, ip);
  assert.equal((await post(student(), ip)).status, 429);
});

test("all-digit / phone-like username rejected", async () => {
  for (const u of ["0712345678", "40712345678", "ab0712345678"]) {
    const res = await post(student({ username: u }));
    assert.equal(res.status, 400, u);
    assert.ok((await res.json()).errors.username, u);
  }
  assert.equal((await post(student({ username: "12345" }))).status, 400); // no letter
});

test("phone login works for the owner even if another row's username equals that identifier", async () => {
  const [owner] = Object.values(makeMembers(db, [{ key: "own", role: "member" }]));
  db.prepare("INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash) VALUES ('Squatter X', ?, ?, 'member', 'member', 'activ', 'x')")
    .run(owner.phone, `pending-${Date.now()}`);
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: owner.phone, password: "test1234" }) });
  assert.equal(res.status, 200);
});

test("body role/auth_role/requested_role are ignored (privilege escalation)", async () => {
  const body = student({ role: "team_leader", auth_role: "team_leader", requested_role: "team_leader" });
  assert.equal((await post(body)).status, 200);
  const m = memberBy(body.username);
  assert.equal(m.role, "member");
  assert.equal(m.auth_role, "member");
  assert.equal(m.requested_role, null);
});

test("password max 72 characters", async () => {
  const res = await post(student({ password: "a".repeat(73), password_confirm: "a".repeat(73) }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errors.password, "Parola poate avea cel mult 72 de caractere.");
});

test("role requests: inactive members hidden and cannot be decided; manual role change clears request", async () => {
  const tl = await login(BASE, M.tl.phone);
  const b1 = mentor(); await post(b1);
  const m1 = memberBy(b1.username);
  db.prepare("UPDATE members SET status = 'iesit' WHERE id = ?").run(m1.id);
  const list = await (await getJson(tl, "/api/admin/role-requests")).json();
  assert.ok(!list.find((r) => r.id === m1.id));
  assert.equal((await postJson(tl, `/api/admin/role-requests/${m1.id}`, { approve: true })).status, 400);
  assert.equal(memberBy(b1.username).role, "member");

  const b2 = mentor(); await post(b2);
  const m2 = memberBy(b2.username);
  const up = await fetch(`${BASE}/api/admin/members/${m2.id}`, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: tl }, body: JSON.stringify({ role: "head_tech" }) });
  assert.equal(up.status, 200);
  const after = memberBy(b2.username);
  assert.equal(after.role, "head_tech");
  assert.equal(after.requested_role, null);
});

test("role requests: list/confirm/reject need members.manage", async () => {
  const body = mentor();
  await post(body);
  const m = memberBy(body.username);
  const tl = await login(BASE, M.tl.phone);
  const mem = await login(BASE, M.mem.phone);
  assert.equal((await getJson(mem, "/api/admin/role-requests")).status, 403);
  assert.equal((await postJson(mem, `/api/admin/role-requests/${m.id}`, { approve: true })).status, 403);
  const list = await (await getJson(tl, "/api/admin/role-requests")).json();
  const row = list.find((r) => r.id === m.id);
  assert.equal(row.requested_role, "mentor");
  assert.equal(row.requested_role_label, "Mentor");
  assert.equal(row.role, "member");

  const own = await post(mentor({ username: "mentor.own", phone: "0733000111" }));
  const ownCookie = cookieOf(own);
  const ok = await postJson(tl, `/api/admin/role-requests/${m.id}`, { approve: true });
  assert.equal(ok.status, 200);
  const after = memberBy(body.username);
  assert.equal(after.role, "mentor");
  assert.equal(after.auth_role, "mentor");
  assert.equal(after.requested_role, null);
  // role change visible on a session of the confirmed member
  const lg = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: body.username, password: body.password }) });
  const me = await (await getJson((lg.headers.get("set-cookie") || "").split(";")[0], "/api/auth/me")).json();
  assert.equal(me.role, "mentor");

  const own2 = memberBy("mentor.own");
  const rej = await postJson(tl, `/api/admin/role-requests/${own2.id}`, { approve: false });
  assert.equal(rej.status, 200);
  assert.equal(memberBy("mentor.own").role, "member");
  assert.equal(memberBy("mentor.own").requested_role, null);
  assert.equal((await (await getJson(ownCookie, "/api/auth/me")).json()).role, "member");
  // already decided -> 400
  assert.equal((await postJson(tl, `/api/admin/role-requests/${own2.id}`, { approve: true })).status, 400);
});
