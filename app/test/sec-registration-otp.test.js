// Security package A3 (docs/design-securitate-2026-10.md): self-registration confirmed with a 6-digit
// WhatsApp code (pending_registrations), limits, WhatsApp reminders only to verified phones, task caps.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initEnv, makeMembers } = require("./_assign-env");
const env = initEnv("sec_otp");
const { server } = require("../server");
const db = require("../src/db");
const tasks = require("../src/services/tasks");
const reminders = require("../src/services/reminders");
const scheduler = require("../src/services/reminder-scheduler");
const { DomainError } = require("../src/domain/errors");

let BASE, M, seq = 0, ipN = 0;
const nextIp = () => { ipN++; return `10.77.${Math.floor(ipN / 250)}.${ipN % 250}`; };
function yearsAgo(n) { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); }
function student(over = {}) {
  seq++;
  return {
    role_choice: "membru", full_name: "Ana Popescu", phone: `4074${String(1000000 + seq)}`,
    username: `otp.user${seq}`, password: "parola1234", password_confirm: "parola1234",
    email: `otp${seq}@eminescusm.ro`, school: "CN Mihai Eminescu", class: "a XI-a B",
    birthdate: yearsAgo(18), department: "tehnic", gdpr_ack: true, regulament_ack: true, ...over,
  };
}
const post = (url, body, ip) => fetch(`${BASE}/api/public${url}`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip || "10.77.250.1" }, body: JSON.stringify(body),
});
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];
const codeFor = (phone) => {
  const msg = [...env.waSent].reverse().find((m) => m.to === phone);
  return msg && (msg.text.match(/\b(\d{6})\b/) || [])[1];
};
const pendingRow = (id) => db.prepare("SELECT * FROM pending_registrations WHERE id = ?").get(id);
const memberByUsername = (u) => db.prepare("SELECT * FROM members WHERE username = ?").get(u);
const ago = (ms) => new Date(Date.now() - ms).toISOString();

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [{ key: "tl", role: "team_leader" }, { key: "mem", role: "member" }, { key: "unv", role: "member", unverified: true }]);
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

test("A3: step 1 creates NO account, stores a pending registration and sends a 6-digit code on WhatsApp", async () => {
  const body = student();
  const res = await post("/register", body, nextIp());
  assert.equal(res.status, 200, await res.clone().text());
  const data = await res.json();
  assert.ok(data.pending_id);
  assert.equal(cookieOf(res), ""); // not logged in yet
  assert.equal(memberByUsername(body.username), undefined);
  const row = pendingRow(data.pending_id);
  assert.equal(row.phone, body.phone);
  assert.ok(!row.data.includes("parola1234"), "password never stored in clear");
  const sent = env.waSent.find((m) => m.to === body.phone);
  assert.match(sent.text, /^Codul tău CrocoAI: \d{6} \(valabil 10 minute\)$/);
  assert.ok(!row.code_hash.includes(codeFor(body.phone)), "code never stored in clear");
});

test("A3: wrong code -> refused with remaining attempts; correct code -> account created, logged in, phone verified", async () => {
  const body = student({ role_choice: "recrut", motivation: "Vreau robotică.", department: "non-tehnic" });
  const { pending_id } = await (await post("/register", body, nextIp())).json();
  const code = codeFor(body.phone);
  const wrong = await post("/register/verify", { pending_id, code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /Cod greșit/);
  assert.equal(pendingRow(pending_id).attempts, 1);

  const ok = await post("/register/verify", { pending_id, code });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual(await ok.json(), { ok: true, redirect: "/" });
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookieOf(ok) } })).json();
  assert.equal(me.role, "volunteer");
  const m = memberByUsername(body.username);
  assert.equal(m.status, "activ");
  assert.ok(m.phone_verified_at);
  assert.equal(pendingRow(pending_id), undefined); // consumed
  // same follow-ups as before: onboarding checklist + audit row
  assert.equal(db.prepare("SELECT COUNT(*) c FROM onboarding WHERE member_id = ?").get(m.id).c, 1);
  assert.equal(db.prepare("SELECT status FROM applications WHERE created_member_id = ?").get(m.id).status, "inregistrat");
  // a used pending id can't be replayed
  assert.equal((await post("/register/verify", { pending_id, code })).status, 404);
});

test("A3: 5 wrong attempts burn the code (even the right one is refused afterwards)", async () => {
  const body = student();
  const { pending_id } = await (await post("/register", body, nextIp())).json();
  const code = codeFor(body.phone);
  const bad = code === "123456" ? "654321" : "123456";
  for (let i = 0; i < 5; i++) assert.equal((await post("/register/verify", { pending_id, code: bad })).status, 400);
  const locked = await post("/register/verify", { pending_id, code });
  assert.equal(locked.status, 429);
  assert.match((await locked.json()).error, /cod nou/);
  assert.equal(memberByUsername(body.username), undefined);
});

test("A3: an expired code (10 min) is refused; an expired registration (30 min) is gone", async () => {
  const body = student();
  const { pending_id } = await (await post("/register", body, nextIp())).json();
  const code = codeFor(body.phone);
  db.prepare("UPDATE pending_registrations SET code_expires_at = ? WHERE id = ?").run(ago(1000), pending_id);
  const r = await post("/register/verify", { pending_id, code });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /expirat/);

  db.prepare("UPDATE pending_registrations SET expires_at = ? WHERE id = ?").run(ago(1000), pending_id);
  const gone = await post("/register/verify", { pending_id, code });
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /completează formularul din nou/);
});

test("A3: resend only after 60 s, new code replaces the old one and resets the attempts", async () => {
  const body = student();
  const ip = nextIp();
  const { pending_id } = await (await post("/register", body, ip)).json();
  const first = codeFor(body.phone);
  const early = await post("/register/resend", { pending_id }, ip);
  assert.equal(early.status, 429);
  assert.match((await early.json()).error, /secunde/);

  await post("/register/verify", { pending_id, code: first === "000000" ? "111111" : "000000" });
  db.prepare("UPDATE pending_registrations SET last_sent_at = ? WHERE id = ?").run(ago(61000), pending_id);
  const again = await post("/register/resend", { pending_id }, ip);
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal(pendingRow(pending_id).attempts, 0);
  const second = codeFor(body.phone);
  if (second !== first) assert.equal((await post("/register/verify", { pending_id, code: first })).status, 400);
  assert.equal((await post("/register/verify", { pending_id, code: second })).status, 200);
});

test("A3: max 3 codes per phone per hour (form re-submitted by its owner, or resend)", async () => {
  const body = student();
  let pending_id;
  for (let i = 0; i < 3; i++) {
    const r = await post("/register", { ...body, username: `${body.username}x${i}`, pending_id }, nextIp());
    assert.equal(r.status, 200, `send ${i + 1}`);
    pending_id = (await r.json()).pending_id;
  }
  const fourth = await post("/register", { ...body, username: `${body.username}x4`, pending_id }, nextIp());
  assert.equal(fourth.status, 429);
  assert.match((await fourth.json()).error, /Prea multe coduri/);
});

test("A3: per-IP cap on codes per hour (OTP_MAX_PER_IP_HOUR)", async () => {
  process.env.OTP_MAX_PER_IP_HOUR = "2";
  try {
    const ip = nextIp();
    assert.equal((await post("/register", student(), ip)).status, 200);
    assert.equal((await post("/register", student(), ip)).status, 200);
    assert.equal((await post("/register", student(), ip)).status, 429);
  } finally { delete process.env.OTP_MAX_PER_IP_HOUR; }
});

test("A3: number not on WhatsApp -> clear message, nothing stored, nothing sent", async () => {
  const body = student();
  env.notOnWhatsApp.add(body.phone);
  const r = await post("/register", body, nextIp());
  assert.equal(r.status, 400);
  const data = await r.json();
  assert.equal(data.error, "Numărul nu are WhatsApp — scrie-i unui lider.");
  assert.ok(data.errors.phone);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pending_registrations WHERE phone = ?").get(body.phone).c, 0);
  assert.ok(!env.waSent.some((m) => m.to === body.phone));
});

test("A3: gateway down while sending -> error, no pending row left behind", async () => {
  const body = student();
  env.gateway.failSend = true;
  try {
    const r = await post("/register", body, nextIp());
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /Nu am putut trimite codul/);
  } finally { env.gateway.failSend = false; }
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pending_registrations WHERE phone = ?").get(body.phone).c, 0);
});

test("A3: username/phone taken between step 1 and step 2 -> refused at verify, no duplicate", async () => {
  const body = student();
  const { pending_id } = await (await post("/register", body, nextIp())).json();
  makeMembers(db, [{ key: "squat", role: "member" }]);
  db.prepare("UPDATE members SET username = ? WHERE username LIKE 't-squat-%'").run(body.username);
  const r = await post("/register/verify", { pending_id, code: codeFor(body.phone) });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).errors.username);
});

test("A3: WhatsApp task reminders go only to verified phones (in-app always)", async () => {
  env.waSent.length = 0;
  const past = new Date(Date.now() - 60000).toISOString();
  const tv = tasks.create(M.mem, { title: "Reminder verificat", remind_at: past });
  const tu = tasks.create(M.unv, { title: "Reminder neverificat", remind_at: past });
  await scheduler.tick(new Date());
  assert.ok(env.waSent.some((m) => m.to === M.mem.phone && m.text.includes("Reminder verificat")));
  assert.ok(!env.waSent.some((m) => m.to === M.unv.phone));
  for (const t of [tv, tu]) assert.equal(db.prepare("SELECT reminded FROM tasks WHERE id = ?").get(t.id).reminded, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND body = 'Reminder neverificat'").get(M.unv.id).c, 1);
});

test("A3: task title <= 200 characters; max 20 active reminders per member", () => {
  assert.throws(() => tasks.create(M.mem, { title: "x".repeat(201) }), (e) => e instanceof DomainError && /200/.test(e.message));
  const t = tasks.create(M.mem, { title: "ok" });
  assert.throws(() => tasks.update(M.mem, t.id, { title: "y".repeat(201) }), DomainError);

  const [cap] = Object.values(makeMembers(db, [{ key: "cap", role: "member" }]));
  const future = new Date(Date.now() + 86400000).toISOString();
  for (let i = 0; i < 20; i++) tasks.create(cap, { title: `r${i}`, remind_at: future });
  assert.throws(() => tasks.create(cap, { title: "r21", remind_at: future }), (e) => e instanceof DomainError && e.code === "LIMIT");
  assert.throws(() => reminders.create(cap, { message: "r21", remind_at: future }), DomainError);
  const plain = tasks.create(cap, { title: "fără reminder" }); // tasks without a reminder are not capped
  assert.throws(() => tasks.update(cap, plain.id, { remind_at: future }), DomainError);
  // finishing one frees a slot
  const one = db.prepare("SELECT id FROM tasks WHERE assigned_member_id = ? AND remind_at IS NOT NULL LIMIT 1").get(cap.id);
  tasks.updateStatus(cap, one.id, "done");
  assert.ok(tasks.create(cap, { title: "r21", remind_at: future }).id);
});

test("A3: a phone changed through a public completion link is no longer verified (in-app only until a leader sets it)", async () => {
  const completion = require("../src/services/completion");
  const [m] = Object.values(makeMembers(db, [{ key: "cmp", role: "member" }]));
  const { url } = completion.createLink(M.tl, m.id);
  const token = url.split("/completare/")[1];
  const form = { full_name: "Ana Completare", email: "ana.c@exemplu.ro", birthdate: yearsAgo(19), class: "a XII-a", school: "Liceu", department: "tehnic", gdpr_ack: true, regulament_ack: true };
  await completion.submit(token, { ...form, phone: m.phone }); // same phone -> stays verified
  assert.ok(db.prepare("SELECT phone_verified_at FROM members WHERE id = ?").get(m.id).phone_verified_at);
  const { url: url2 } = completion.createLink(M.tl, m.id);
  await completion.submit(url2.split("/completare/")[1], { ...form, phone: "0744999111" });
  assert.equal(db.prepare("SELECT phone_verified_at FROM members WHERE id = ?").get(m.id).phone_verified_at, null);
  // a leader setting the phone vouches for it
  require("../src/services/members").update(M.tl, m.id, { phone: "0744999112" });
  assert.ok(db.prepare("SELECT phone_verified_at FROM members WHERE id = ?").get(m.id).phone_verified_at);
});
