// Security package A - review fix round 1: OTP reservation race + caps, pending registration not
// replaceable by a third party, server-rendered print pages without inline script, privileged accounts
// edited only by the Team Leader, last-TL protection, AI drafts through the schema, crisis recipients.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("sec_fix1");
const { server } = require("../server");
const db = require("../src/db");
const members = require("../src/services/members");
const completion = require("../src/services/completion");
const templates = require("../src/services/doc-templates");
const meetings = require("../src/services/meetings");
const attendanceSvc = require("../src/services/attendance");
const notifications = require("../src/services/notifications");
const scheduler = require("../src/services/reminder-scheduler");
const aiPolicy = require("../src/domain/ai-policy");
const { DomainError } = require("../src/domain/errors");

let BASE, M, seq = 0, ipN = 0;
const nextIp = () => { ipN++; return `10.88.${Math.floor(ipN / 250)}.${ipN % 250}`; };
function form(over = {}) {
  seq++;
  return {
    role_choice: "membru", full_name: "Ana Popescu", phone: `4075${String(1000000 + seq)}`, username: `fix.user${seq}`,
    password: "parola1234", password_confirm: "parola1234", email: `fix${seq}@eminescusm.ro`, school: "CN Mihai Eminescu",
    class: "a XI-a B", birthdate: "2008-01-01", department: "tehnic", gdpr_ack: true, regulament_ack: true, ...over,
  };
}
const post = (url, body, ip) => fetch(`${BASE}/api/public${url}`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip || nextIp() }, body: JSON.stringify(body),
});
const sentTo = (phone) => env.waSent.filter((m) => m.to === phone).length;
const FORBIDDEN = (e) => e instanceof DomainError && e.code === "FORBIDDEN";

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" }, { key: "co", role: "co_leader" }, { key: "mentor", role: "mentor" },
    { key: "mem", role: "member" }, { key: "mentorPause", role: "mentor", status: "pauza" },
  ]);
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

// ── OTP ────────────────────────────────────────────────────────────────────────────────────────
test("OTP race: 20 parallel /register for one phone (slow gateway) send exactly one code", async () => {
  const realFetch = global.fetch;
  global.fetch = async (u, o) => { if (String(u).includes("/resolve/")) await new Promise((r) => setTimeout(r, 200)); return realFetch(u, o); };
  try {
    const phone = "40741234567";
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => post("/register", form({ phone, username: `race.u${i}`, email: `race${i}@eminescusm.ro` }))));
    assert.equal(res.filter((r) => r.status === 200).length, 1, res.map((r) => r.status).join(","));
    assert.equal(sentTo(phone), 1);
  } finally { global.fetch = realFetch; }
});

test("OTP race: parallel resend calls send at most one new code", async () => {
  const body = form();
  const { pending_id } = await (await post("/register", body)).json();
  db.prepare("UPDATE pending_registrations SET last_sent_at = ? WHERE id = ?").run(new Date(Date.now() - 61000).toISOString(), pending_id);
  const realFetch = global.fetch;
  global.fetch = async (u, o) => { if (String(u).endsWith("/send")) await new Promise((r) => setTimeout(r, 200)); return realFetch(u, o); };
  try {
    const res = await Promise.all(Array.from({ length: 10 }, () => post("/register/resend", { pending_id })));
    assert.equal(res.filter((r) => r.status === 200).length, 1);
  } finally { global.fetch = realFetch; }
  assert.equal(sentTo(body.phone), 2);
});

test("OTP: a failed send gives the reservation back (no count, no pending)", async () => {
  const body = form();
  env.gateway.failSend = true;
  try { assert.equal((await post("/register", body)).status, 503); } finally { env.gateway.failSend = false; }
  assert.equal(db.prepare("SELECT COUNT(*) c FROM otp_sends WHERE phone = ?").get(body.phone).c, 0);
  assert.equal((await post("/register", body)).status, 200);
});

test("OTP: a third party cannot replace someone's pending registration; the owner (pending_id) can resubmit", async () => {
  const body = form();
  const { pending_id } = await (await post("/register", body)).json();
  const attacker = await post("/register", { ...body, username: "atacator1", email: "atac@eminescusm.ro" });
  assert.equal(attacker.status, 409);
  assert.match((await attacker.json()).error, /înregistrare în curs/);
  assert.ok(db.prepare("SELECT 1 FROM pending_registrations WHERE id = ?").get(pending_id), "victim's pending kept");
  // the owner corrects the form: same phone, carries the pending id
  const again = await post("/register", { ...body, username: `${body.username}b`, pending_id });
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal(db.prepare("SELECT 1 FROM pending_registrations WHERE id = ?").get(pending_id), undefined);
});

test("OTP: max 6 codes per phone per day, max OTP_MAX_GLOBAL_HOUR (60) per hour overall", async () => {
  const { OTP_MAX_PER_PHONE_DAY, otpMaxGlobalHour } = require("../src/domain/rules");
  assert.equal(OTP_MAX_PER_PHONE_DAY, 6);
  assert.equal(otpMaxGlobalHour(), 60);
  const body = form();
  const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString(); // older than an hour, same day
  for (let i = 0; i < 6; i++) db.prepare("INSERT INTO otp_sends (phone, ip_hash, sent_at) VALUES (?, 'x', ?)").run(body.phone, old);
  const r = await post("/register", body);
  assert.equal(r.status, 429);

  process.env.OTP_MAX_GLOBAL_HOUR = String(db.prepare("SELECT COUNT(*) c FROM otp_sends WHERE sent_at > ?").get(new Date(Date.now() - 3600000).toISOString()).c);
  try {
    const g = await post("/register", form());
    assert.equal(g.status, 429);
  } finally { delete process.env.OTP_MAX_GLOBAL_HOUR; }
});

test("OTP: the reminder scheduler tick removes expired pending registrations", async () => {
  const body = form();
  const { pending_id } = await (await post("/register", body)).json();
  db.prepare("UPDATE pending_registrations SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), pending_id);
  await scheduler.tick(new Date());
  assert.equal(db.prepare("SELECT 1 FROM pending_registrations WHERE id = ?").get(pending_id), undefined);
});

// ── Print pages without inline script (CSP script-src 'self') ──────────────────────────────────
function assertNoInline(html, what) {
  assert.ok(!/\son[a-z]+\s*=/i.test(html), `${what}: inline handler`);
  assert.ok(![...html.matchAll(/<script\b([^>]*)>/g)].some((m) => !/\bsrc=/.test(m[1])), `${what}: inline <script>`);
  assert.ok(html.includes('src="/js/print.js"') && html.includes("data-print"), `${what}: print button wiring`);
}
test("print pages: attendance HTML export and every document template use /js/print.js, no inline script", async () => {
  for (const key of Object.keys(templates.RENDERERS)) {
    assertNoInline(templates.render(key, { full_name: "Ana", role: "member", birthdate: "2010-01-01", class: "IX" }), key);
  }
  const cookie = await login(BASE, M.tl.phone);
  const r = await fetch(`${BASE}/api/attendance/export/html`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assertNoInline(await r.text(), "attendance export");
  const js = await fetch(`${BASE}/js/print.js`);
  assert.equal(js.status, 200);
});

// ── Privileged accounts ────────────────────────────────────────────────────────────────────────
test("privileged accounts: only the TL edits phone/email of a TL/co-leader/mentor; self may edit own non-role fields", () => {
  assert.throws(() => members.update(M.co, M.tl.id, { phone: "0744000777" }), FORBIDDEN);
  assert.throws(() => members.update(M.co, M.mentor.id, { email: "x@y.ro" }), FORBIDDEN);
  assert.throws(() => members.update(M.co, M.mentor.id, { name: "Alt Nume" }), FORBIDDEN);
  assert.throws(() => completion.createLink(M.co, M.tl.id), FORBIDDEN); // public link = phone change by proxy
  assert.equal(members.update(M.co, M.co.id, { email: "co.nou@exemplu.ro" }).email, "co.nou@exemplu.ro");
  assert.equal(members.update(M.tl, M.mentor.id, { email: "mentor@exemplu.ro" }).email, "mentor@exemplu.ro");
  assert.equal(members.update(M.co, M.mem.id, { email: "mem@exemplu.ro" }).email, "mem@exemplu.ro");
  assert.ok(completion.createLink(M.co, M.mem.id).url);
});

test("last active Team Leader cannot pause / alumni / leave / demote themselves", () => {
  db.prepare("UPDATE members SET status = 'alumni' WHERE role = 'team_leader' AND id != ?").run(M.tl.id); // the seeded admin
  for (const status of ["pauza", "alumni", "iesit"]) {
    assert.throws(() => members.changeStatus(M.tl, M.tl.id, status), (e) => e instanceof DomainError && /singurul Team Leader activ/.test(e.message), status);
  }
  assert.throws(() => members.update(M.tl, M.tl.id, { role: "member" }), /singurul Team Leader activ/);
  // with a second active TL it's allowed
  const [tl2] = Object.values(makeMembers(db, [{ key: "tl2", role: "team_leader" }]));
  assert.equal(members.changeStatus(M.tl, tl2.id, "pauza").status, "pauza");
});

test("an active co-leader may restore a paused Team Leader to 'activ' (and nothing else)", () => {
  const [tl3, tl4] = Object.values(makeMembers(db, [{ key: "tl3", role: "team_leader", status: "pauza" }, { key: "tl4", role: "team_leader", status: "pauza" }]));
  assert.equal(members.changeStatus(M.co, tl3.id, "activ").status, "activ");
  assert.throws(() => members.changeStatus(M.co, tl3.id, "pauza"), FORBIDDEN);
  assert.throws(() => members.changeStatus(M.co, tl4.id, "alumni"), FORBIDDEN);
  const [paused] = Object.values(makeMembers(db, [{ key: "coP", role: "co_leader", status: "pauza" }]));
  assert.throws(() => members.changeStatus(paused, tl4.id, "activ"), FORBIDDEN);
});

// ── AI drafts, crisis, group text ──────────────────────────────────────────────────────────────
test("AI-generated PV drafts go through the draft schema (coerced, unknown keys dropped)", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const session = attendanceSvc.createSession(M.tl, { date: "2026-09-15", start_time: "18:00", type: "sedinta", title: "Ședința" });
  const meeting = meetings.getOrCreateForSession(M.tl, session.id);
  const original = meetings.generateDraftText;
  meetings.generateDraftText = async () => ({
    text: JSON.stringify({
      discussions: [{ point: { html: "<b>x</b>" }, discussion: null, decision: 42, majora: "da", evil: "<script>" }],
      announcements: ["a", "b"], actions: [{ action: 123, responsible_name: null, due_date: 20260920 }], next_meeting_note: null,
    }),
    usage: null, cost: 0, model: "mock",
  });
  try {
    const d = (await meetings.generateDraft(M.tl, meeting.id)).draft;
    const disc = d.discussions[0];
    assert.equal(typeof disc.point, "string");
    assert.equal(disc.discussion, "");
    assert.equal(disc.decision, "42");
    assert.equal(typeof disc.majora, "boolean");
    assert.equal(disc.evil, undefined);
    assert.equal(typeof d.announcements, "string");
    assert.equal(d.actions[0].action, "123");
    assert.equal(typeof d.actions[0].due_date, "string");
  } finally { meetings.generateDraftText = original; delete process.env.ANTHROPIC_API_KEY; }
});

test("crisis signal: active TL + active mentors (policy), WhatsApp only to verified phones", async () => {
  const [unvMentor, pausedTl] = Object.values(makeMembers(db, [
    { key: "mU", role: "mentor", unverified: true }, { key: "tlP", role: "team_leader", status: "pauza" },
  ]));
  env.waSent.length = 0;
  notifications.notifyCrisisSignal(M.mem);
  await new Promise((r) => setTimeout(r, 50));
  const notified = db.prepare("SELECT member_id FROM notifications WHERE type = 'ai_crisis'").all().map((r) => r.member_id);
  assert.ok(notified.includes(M.tl.id) && notified.includes(M.mentor.id) && notified.includes(unvMentor.id));
  assert.ok(!notified.includes(pausedTl.id) && !notified.includes(M.mentorPause.id));
  assert.ok(env.waSent.some((m) => m.to === M.tl.phone));
  assert.ok(!env.waSent.some((m) => m.to === unvMentor.phone));
});

test("group private-answer text is 'Scrie-mi în privat pentru asta.'", () => {
  assert.equal(aiPolicy.GROUP_PRIVATE_TEXT, "Scrie-mi în privat pentru asta.");
});
