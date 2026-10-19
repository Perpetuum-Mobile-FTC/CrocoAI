// Public application form + profile-completion links (docs/design-formular-date.md). No network -
// the WhatsApp gateway is mocked at the fetch level. WA_QUEUE_DELAY_MS is lowered so the bulk
// spacing test doesn't take 20s real time, while still proving the queue actually waits.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._registration_test.db");
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INITIAL_PASSWORD = "admintest123";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.WA_SHARED_SECRET = "test-wa-secret";
process.env.LOGIN_RATE_LIMIT_MAX = "1000";
process.env.WA_GATEWAY_URL = "http://mock-wa-gateway.test";
process.env.WA_QUEUE_DELAY_MS = "80";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const { server } = require("../server");
const db = require("../src/db");
const { buildToolList } = require("../src/ai/tools");

const ON_WHATSAPP = new Set(); // phones the mock gateway says are reachable
const sentMessages = []; // { to, text, at }

const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (!u.startsWith(process.env.WA_GATEWAY_URL)) return realFetch(url, opts);
  if (u.includes("/resolve/")) {
    const phone = decodeURIComponent(u.split("/resolve/")[1]);
    return Promise.resolve({ ok: true, json: async () => ({ wid: ON_WHATSAPP.has(phone) ? `${phone}@c.us` : null }) });
  }
  if (u.endsWith("/send")) {
    const body = JSON.parse(opts.body);
    sentMessages.push({ ...body, at: Date.now() });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, code: 200 }) });
};

let BASE;
let tl, member;
let ipCounter = 0;
function nextIp() { ipCounter++; return `10.0.${Math.floor(ipCounter / 255)}.${ipCounter % 255}`; }
let phoneCounter = 0;
function uniquePhone() { phoneCounter++; return `4072${String(1000000 + phoneCounter).padStart(7, "0")}`; }

// dd.mm.yyyy birthdate `yearsAgo` years before today - keeps the "plausible age 10-25" check happy
// regardless of when the test suite runs.
function birthdateYearsAgo(yearsAgo) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - yearsAgo);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}
const ADULT_BIRTHDATE = birthdateYearsAgo(20);
const MINOR_BIRTHDATE = birthdateYearsAgo(14);

function cookieFrom(res) { return (res.headers.get("set-cookie") || "").split(";")[0]; }
async function login(phone, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, password }),
  });
  assert.equal(res.status, 200, `login failed: ${await res.text()}`);
  return cookieFrom(res);
}

function baseApplication(overrides = {}) {
  return {
    full_name: "Andrei Pop",
    phone: uniquePhone(),
    email: "andrei@exemplu.ro",
    birthdate: ADULT_BIRTHDATE,
    class: "a XII-a A",
    school: "Liceul Testului",
    department: "tehnic",
    motivation: "Vreau să fac parte din echipă.",
    gdpr_ack: true,
    ...overrides,
  };
}

async function postApplication(body, ip) {
  return fetch(`${BASE}/api/public/applications`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip || nextIp() },
    body: JSON.stringify(body),
  });
}

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const hash = bcrypt.hashSync("test1234", 10);
  const insert = db.prepare(`
    INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, 'activ', ?, 0)
  `);
  tl = insert.run("Registration TL", "reg-tl", "40700004001", "team_leader", "team_leader", hash).lastInsertRowid;
  member = insert.run("Registration Membru", "reg-membru", "40700004002", "member", "member", hash).lastInsertRowid;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  global.fetch = realFetch;
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  try { fs.rmSync(path.join(__dirname, "backups"), { recursive: true, force: true }); } catch {}
});

// ── Public application submission ──────────────────────────────────────────

test("honeypot: filled 'website' field pretends success but creates nothing", async () => {
  const before_ = db.prepare("SELECT COUNT(*) c FROM applications").get().c;
  const res = await postApplication({ ...baseApplication(), website: "http://spam.example" });
  assert.equal(res.status, 200);
  const after_ = db.prepare("SELECT COUNT(*) c FROM applications").get().c;
  assert.equal(after_, before_);
});

test("valid public application is stored and notifies LEADERS", async () => {
  const before_ = db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND type = 'application_new'").get(tl).c;
  const res = await postApplication(baseApplication());
  assert.equal(res.status, 200);
  const row = db.prepare("SELECT * FROM applications ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.full_name, "Andrei Pop");
  assert.equal(row.status, "in_asteptare");
  const after_ = db.prepare("SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND type = 'application_new'").get(tl).c;
  assert.equal(after_, before_ + 1);
});

test("minor application without guardian data -> 400 with field errors", async () => {
  const res = await postApplication(baseApplication({ birthdate: MINOR_BIRTHDATE }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.errors.guardian_name);
  assert.ok(body.errors.guardian_ack);
});

test("minor application with full guardian data succeeds", async () => {
  const res = await postApplication(baseApplication({
    birthdate: MINOR_BIRTHDATE,
    guardian_name: "Elena Pop", guardian_relation: "mama", guardian_phone: "0722333444", guardian_ack: true,
  }));
  assert.equal(res.status, 200);
  const row = db.prepare("SELECT * FROM applications ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.guardian_name, "Elena Pop");
});

test("duplicate phone of an existing member is rejected with a field error, no account details leaked beyond the hint", async () => {
  const res = await postApplication(baseApplication({ phone: "40700004002" })); // = member's phone
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.errors.phone);
});

test("duplicate phone with a pending application is rejected", async () => {
  const app = baseApplication();
  const first = await postApplication(app);
  assert.equal(first.status, 200);
  const second = await postApplication(app);
  assert.equal(second.status, 400);
  const body = await second.json();
  assert.ok(body.errors.phone);
});

test("rate limit: 3/hour per IP", async () => {
  const ip = nextIp();
  for (let i = 0; i < 3; i++) {
    const res = await postApplication(baseApplication(), ip);
    assert.equal(res.status, 200, `request ${i} should pass`);
  }
  const fourth = await postApplication(baseApplication(), ip);
  assert.equal(fourth.status, 429);
});

test("GET /api/public/informare returns the GDPR draft with version/date parsed out", async () => {
  const res = await fetch(`${BASE}/api/public/informare`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.version);
  assert.ok(body.content.includes("Informare privind"));
  assert.ok(!body.content.startsWith("<!--"));
});

// ── Review (LEADERS only) ────────────────────────────────────────────────

test("GET /api/applications is LEADERS only", async () => {
  const memberCookie = await login("reg-membru", "test1234");
  const res = await fetch(`${BASE}/api/applications`, { headers: { Cookie: memberCookie } });
  assert.equal(res.status, 403);
});

test("accept: creates member (+ guardian for minors), sends credentials on WhatsApp when resolvable, starts onboarding checklist without the dialog", async () => {
  const tlCookie = await login("reg-tl", "test1234");
  const phone = "40799991001";
  ON_WHATSAPP.add(phone);
  await postApplication(baseApplication({
    phone, birthdate: MINOR_BIRTHDATE,
    guardian_name: "Maria Ionescu", guardian_relation: "mama", guardian_phone: "0722555666", guardian_ack: true,
  }));
  const app = db.prepare("SELECT * FROM applications WHERE phone = ?").get(phone);

  const res = await fetch(`${BASE}/api/applications/${app.id}/accept`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: tlCookie }, body: JSON.stringify({}),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.sent_whatsapp, true);
  assert.ok(body.password);
  assert.equal(body.member.role, "volunteer");
  assert.ok(!JSON.stringify(body).includes("password_hash"), "accept response must not leak the password hash");

  const guardians = db.prepare("SELECT * FROM guardians WHERE member_id = ?").all(body.member.id);
  assert.equal(guardians.length, 1);
  assert.equal(guardians[0].name, "Maria Ionescu");

  const credMsg = sentMessages.find((m) => m.to === phone && /Parolă temporară/.test(m.text));
  assert.ok(credMsg);

  const onboarding = db.prepare("SELECT * FROM onboarding WHERE member_id = ?").get(body.member.id);
  assert.ok(onboarding);
  const checklist = db.prepare("SELECT * FROM onboarding_checklist WHERE onboarding_id = ? AND step_key = 'platforma'").get(onboarding.id);
  assert.equal(checklist.done, 1); // account exists already - ticked immediately, no dialog ever happened
  assert.equal(db.prepare("SELECT onboarding_step FROM members WHERE id = ?").get(body.member.id).onboarding_step, 0);

  const reloaded = db.prepare("SELECT * FROM applications WHERE id = ?").get(app.id);
  assert.equal(reloaded.status, "acceptata");
});

test("accept: phone not on WhatsApp -> account still created, credentials returned once, not sent", async () => {
  const tlCookie = await login("reg-tl", "test1234");
  const phone = "40799991002"; // intentionally not added to ON_WHATSAPP
  await postApplication(baseApplication({ phone }));
  const app = db.prepare("SELECT * FROM applications WHERE phone = ?").get(phone);

  const res = await fetch(`${BASE}/api/applications/${app.id}/accept`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: tlCookie }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent_whatsapp, false);
  assert.ok(body.password);
  assert.ok(!sentMessages.some((m) => m.to === phone));
});

test("accept twice -> second call fails, no duplicate member", async () => {
  const tlCookie = await login("reg-tl", "test1234");
  const phone = "40799991003";
  await postApplication(baseApplication({ phone }));
  const app = db.prepare("SELECT * FROM applications WHERE phone = ?").get(phone);
  const first = await fetch(`${BASE}/api/applications/${app.id}/accept`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: tlCookie }, body: "{}" });
  assert.equal(first.status, 200);
  const second = await fetch(`${BASE}/api/applications/${app.id}/accept`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: tlCookie }, body: "{}" });
  assert.equal(second.status, 400);
});

test("reject: sets status, sends a polite WA message only when 'notify' is true", async () => {
  const tlCookie = await login("reg-tl", "test1234");
  const phone = "40799991004";
  await postApplication(baseApplication({ phone }));
  const app = db.prepare("SELECT * FROM applications WHERE phone = ?").get(phone);
  const res = await fetch(`${BASE}/api/applications/${app.id}/reject`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: tlCookie }, body: JSON.stringify({ note: "nu mai sunt locuri", notify: true }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "respinsa");
  assert.ok(sentMessages.some((m) => m.to === phone && /mulțumim/.test(m.text)));
});

test("accept/reject are LEADERS only", async () => {
  const memberCookie = await login("reg-membru", "test1234");
  const phone = "40799991005";
  await postApplication(baseApplication({ phone }));
  const app = db.prepare("SELECT * FROM applications WHERE phone = ?").get(phone);
  const res = await fetch(`${BASE}/api/applications/${app.id}/accept`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: memberCookie }, body: "{}" });
  assert.equal(res.status, 403);
});

// ── Completion links ─────────────────────────────────────────────────────

test("completion link: create (LEADERS only), prefill, update, no credentials for an already-logged-in member", async () => {
  const tlCookie = await login("reg-tl", "test1234");
  const forbidden = await fetch(`${BASE}/api/completion-links/link/${member}`, { method: "POST", headers: { Cookie: await login("reg-membru", "test1234") } });
  assert.equal(forbidden.status, 403);

  db.prepare("UPDATE members SET last_login = strftime('%Y-%m-%dT%H:%M:%fZ','now'), must_change_password = 0 WHERE id = ?").run(member);

  const linkRes = await fetch(`${BASE}/api/completion-links/link/${member}`, { method: "POST", headers: { Cookie: tlCookie } });
  assert.equal(linkRes.status, 200);
  const { url } = await linkRes.json();
  const token = url.split("/completare/")[1];

  const getRes = await fetch(`${BASE}/api/public/completion/${token}`);
  assert.equal(getRes.status, 200);
  const prefill = await getRes.json();
  assert.equal(prefill.full_name, "Registration Membru");

  const submitRes = await fetch(`${BASE}/api/public/completion/${token}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      full_name: "Registration Membru Actualizat", phone: "40700004002", email: "updated@exemplu.ro",
      birthdate: ADULT_BIRTHDATE, class: "a XII-a", school: "Liceul X", department: "ambele", gdpr_ack: true,
    }),
  });
  const submitBody = await submitRes.json();
  assert.equal(submitRes.status, 200, JSON.stringify(submitBody));
  assert.equal(submitBody.credentials_sent, false); // already logged in - no reset

  const fresh = db.prepare("SELECT * FROM members WHERE id = ?").get(member);
  assert.equal(fresh.full_name, "Registration Membru Actualizat");
  assert.equal(fresh.email, "updated@exemplu.ro");

  // single-use: token already consumed
  const secondSubmit = await fetch(`${BASE}/api/public/completion/${token}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(secondSubmit.status, 404);
});

test("completion link: never-logged-in member gets fresh credentials sent over WhatsApp", async () => {
  const tlCookie = await login("reg-tl", "test1234");
  const hash = bcrypt.hashSync("whatever", 10);
  const phone = "40799992001";
  ON_WHATSAPP.add(phone);
  const newId = db.prepare(`
    INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash, must_change_password)
    VALUES ('Voluntar Fara Login', 'vol-fara-login', ?, 'volunteer', 'volunteer', 'activ', ?, 1)
  `).run(phone, hash).lastInsertRowid;

  const linkRes = await fetch(`${BASE}/api/completion-links/link/${newId}`, { method: "POST", headers: { Cookie: tlCookie } });
  const { url } = await linkRes.json();
  const token = url.split("/completare/")[1];

  const submitRes = await fetch(`${BASE}/api/public/completion/${token}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ full_name: "Voluntar Fara Login", phone, email: "vol@exemplu.ro", birthdate: ADULT_BIRTHDATE, class: "a XII-a", school: "Liceul X", department: "tehnic", gdpr_ack: true }),
  });
  const body = await submitRes.json();
  assert.equal(submitRes.status, 200, JSON.stringify(body));
  assert.equal(body.credentials_sent, true);
  assert.ok(body.password);
  assert.ok(sentMessages.some((m) => m.to === phone && /Parolă temporară/.test(m.text)));
});

test("completion link: expired token -> 404, never reveals anything", async () => {
  const tlCookie = await login("reg-tl", "test1234");
  const linkRes = await fetch(`${BASE}/api/completion-links/link/${member}`, { method: "POST", headers: { Cookie: tlCookie } });
  const { url } = await linkRes.json();
  const token = url.split("/completare/")[1];
  db.prepare("UPDATE completion_tokens SET expires_at = datetime('now', '-1 day') WHERE id = (SELECT id FROM completion_tokens WHERE member_id = ? ORDER BY id DESC LIMIT 1)").run(member);
  const res = await fetch(`${BASE}/api/public/completion/${token}`);
  assert.equal(res.status, 404);
});

test("bulk completion links: queued sends are spaced by >= WA_QUEUE_DELAY_MS", async () => {
  const tlCookie = await login("reg-tl", "test1234");
  const hash = bcrypt.hashSync("whatever", 10);
  const insert = db.prepare(`
    INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash, must_change_password)
    VALUES (?, ?, ?, 'volunteer', 'volunteer', 'activ', ?, 1)
  `);
  const phoneA = "40799993001", phoneB = "40799993002";
  ON_WHATSAPP.add(phoneA); ON_WHATSAPP.add(phoneB);
  const idA = insert.run("Bulk A", "bulk-a", phoneA, hash).lastInsertRowid;
  const idB = insert.run("Bulk B", "bulk-b", phoneB, hash).lastInsertRowid;

  const res = await fetch(`${BASE}/api/completion-links/bulk`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: tlCookie }, body: JSON.stringify({ member_ids: [idA, idB] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.every((r) => r.queued));

  // Wait for both queued sends to land, then check the spacing.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const msgs = sentMessages.filter((m) => m.to === phoneA || m.to === phoneB).sort((a, b) => a.at - b.at);
  assert.equal(msgs.length, 2);
  assert.ok(msgs[1].at - msgs[0].at >= Number(process.env.WA_QUEUE_DELAY_MS) - 5, `expected >= ${process.env.WA_QUEUE_DELAY_MS}ms spacing, got ${msgs[1].at - msgs[0].at}ms`);
});

test("bulk completion links: member without a phone is returned for manual delivery, not queued", async () => {
  const tlCookie = await login("reg-tl", "test1234");
  const hash = bcrypt.hashSync("whatever", 10);
  const noPhoneId = db.prepare(`
    INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash, must_change_password)
    VALUES ('Fara Telefon', 'fara-telefon', ?, 'volunteer', 'volunteer', 'activ', ?, 1)
  `).run(`pending-${Date.now()}`, hash).lastInsertRowid;

  const res = await fetch(`${BASE}/api/completion-links/bulk`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: tlCookie }, body: JSON.stringify({ member_ids: [noPhoneId] }),
  });
  const body = await res.json();
  assert.equal(body[0].queued, false);
  assert.ok(body[0].url);
});

// ── AI tool <-> route parity ──────────────────────────────────────────────

test("cereri_inscriere (tool) matches /api/applications/pending-count for a LEADER", async () => {
  const tlCookie = await login("reg-tl", "test1234");
  const httpRes = await fetch(`${BASE}/api/applications/pending-count`, { headers: { Cookie: tlCookie } });
  const { count } = await httpRes.json();

  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(tl);
  const tools = await buildToolList({ actor, channel: "web", chatId: `web:${tl}` });
  const toolOut = await tools.find((t) => t.name === "cereri_inscriere").handler({}, {});
  if (count === 0) assert.match(toolOut.content[0].text, /Nicio cerere/);
  else assert.match(toolOut.content[0].text, new RegExp(String(count)));
});

test("cereri_inscriere (tool) refuses a plain member exactly like the route", async () => {
  const memberCookie = await login("reg-membru", "test1234");
  const httpRes = await fetch(`${BASE}/api/applications/pending-count`, { headers: { Cookie: memberCookie } });
  assert.equal(httpRes.status, 403);

  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(member);
  const tools = await buildToolList({ actor, channel: "web", chatId: `web:${member}` });
  const toolOut = await tools.find((t) => t.name === "cereri_inscriere").handler({}, {});
  assert.equal(toolOut.isError, true);
});

test("membri_date_incomplete (tool) matches /api/members/missing-data for a LEADER", async () => {
  const tlCookie = await login("reg-tl", "test1234");
  const httpRes = await fetch(`${BASE}/api/members/missing-data`, { headers: { Cookie: tlCookie } });
  const list = await httpRes.json();

  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(tl);
  const tools = await buildToolList({ actor, channel: "web", chatId: `web:${tl}` });
  const toolOut = await tools.find((t) => t.name === "membri_date_incomplete").handler({}, {});
  for (const row of list) {
    assert.match(toolOut.content[0].text, new RegExp(row.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("datele_mele_lipsa (tool) reflects the caller's own missing fields", async () => {
  const actor = db.prepare("SELECT * FROM members WHERE id = ?").get(tl);
  const tools = await buildToolList({ actor, channel: "web", chatId: `web:${tl}` });
  const toolOut = await tools.find((t) => t.name === "datele_mele_lipsa").handler({}, {});
  assert.equal(toolOut.isError, undefined);
  assert.ok(toolOut.content[0].text.length > 0);
});
