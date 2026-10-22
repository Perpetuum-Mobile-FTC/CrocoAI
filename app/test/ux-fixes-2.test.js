// UI/UX audit batch 2 (2026-10-19): „De verificat” list, Contul meu, WhatsApp gateway states, weekly series
// session types, meeting phase, motivation reason, home cards, team identity in one file.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { initEnv, makeMembers, actorOf, login } = require("./_assign-env");
const env = initEnv("ux_fixes_2");
const { server } = require("../server");
const db = require("../src/db");
const rules = require("../src/domain/rules");
const profile = require("../src/domain/profile");
const { TEAM } = require("../src/domain/team");
const events = require("../src/services/events");
const meetings = require("../src/services/meetings");
const meetingCore = require("../src/services/meeting-core");
const waGroups = require("../src/services/wa-groups");
const waGateway = require("../src/services/wa-gateway");
const { buildToolList } = require("../src/ai/tools");
const { migrate } = require("../src/db/migrate");
const { bucharestToUtcMs } = require("../src/domain/time");

let BASE, M;
const cookies = {};
async function req(key, method, url, body, headers = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method, headers: { "Content-Type": "application/json", Cookie: cookies[key] || "", ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text() };
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
    { key: "mt2", role: "member", department: "tehnic" },
    { key: "mn", role: "member", department: "non-tehnic" },
  ]);
  for (const k of Object.keys(M)) cookies[k] = await login(BASE, M[k].phone);
});
after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  env.cleanup();
});

// ── 2: „De verificat” ────────────────────────────────────────────────────────────────────────
test("„De verificat”: GET /api/assignments?scope=review = the Acasă count, per reviewer", async () => {
  const a1 = (await req("ht", "POST", "/api/assignments", { title: "Schiță A", mode: "individual", target_type: "departament", target_dept: "tehnic" })).body;
  const a2 = (await req("tl", "POST", "/api/assignments", { title: "Schiță B", mode: "individual", target_type: "departament", target_dept: "tehnic" })).body;
  const a3 = (await req("hn", "POST", "/api/assignments", { title: "Afiș", mode: "individual", target_type: "departament", target_dept: "non-tehnic" })).body;
  const hand = (a, key) => db.prepare("UPDATE submissions SET status = 'predat' WHERE assignment_id = ? AND member_id = ?").run(a.id, M[key].id);
  hand(a1, "mt"); hand(a1, "mt2"); hand(a2, "mt"); hand(a3, "mn");

  for (const key of ["tl", "ht", "hn", "mentor", "mt"]) {
    const list = await req(key, "GET", "/api/assignments?scope=review");
    assert.equal(list.status, 200);
    const home = (await req(key, "GET", "/api/home")).body;
    const card = home.review && home.review.find((i) => i.key === "predari");
    const listed = list.body.reduce((n, a) => n + a.waiting, 0);
    assert.equal(card ? card.count : 0, listed, `${key}: Acasă and the list agree`);
    if (card) assert.equal(card.link, list.body.length === 1 ? `/teme/${list.body[0].id}` : "/teme?filtru=de-verificat");
    assert.ok(list.body.every((a) => a.can_review), `${key}: only what they may review`);
  }
  const tl = (await req("tl", "GET", "/api/assignments?scope=review")).body;
  assert.deepEqual(tl.map((a) => a.waiting).sort(), [1, 1, 2]);
  const ht = (await req("ht", "GET", "/api/assignments?scope=review")).body;
  assert.deepEqual(ht.map((a) => a.id).sort(), [a1.id, a2.id].sort()); // department head: their department
  assert.deepEqual((await req("mt", "GET", "/api/assignments?scope=review")).body, []);
  assert.deepEqual((await req("mentor", "GET", "/api/assignments?scope=review")).body, []); // reviews only their own
});

// ── 8: Contul meu ─────────────────────────────────────────────────────────────────────────────
test("Contul meu: PATCH /api/members/me edits only the own fields, validated", async () => {
  const r = await req("mt", "PATCH", "/api/members/me", { email: "ana@example.com", school: "Liceul X", class: "a X-a", birthdate: "2010-05-04", full_name: "Alt Nume", phone: "0744000999", role: "team_leader", department: "non-tehnic" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = actor("mt");
  assert.equal(m.email, "ana@example.com");
  assert.equal(m.school, "Liceul X");
  assert.notEqual(m.birthdate, "2010-05-04", "birthdate stays with the leaders (decides the minor documents)");
  assert.equal(m.full_name, "Test mt"); // identity fields stay with the leaders
  assert.equal(m.phone, M.mt.phone);
  assert.equal(m.role, "member");
  assert.equal(m.department, "tehnic");
  const bad = await req("mt", "PATCH", "/api/members/me", { email: "nu-e-email" });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.email);
  const school = Object.keys(TEAM.schoolEmailDomains)[0];
  const wrongDomain = await req("mt", "PATCH", "/api/members/me", { school, email: "ana@example.com" });
  assert.equal(wrongDomain.status, 400, "a school with an email domain requires that domain");
  assert.ok(wrongDomain.body.errors.email);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'profile.self_edit' AND member_id = ?").get(m.id), "self edits are audited");
  assert.deepEqual(profile.validateOwnEdit({ email: "" }).value, { email: null });
  // the TL edits their own account too (members.edit_account: self)
  assert.equal((await req("tl", "PATCH", "/api/members/me", { class: "-" })).status, 200);
  // /cont is an SPA route (200 shell when logged in, login redirect otherwise)
  assert.equal((await fetch(`${BASE}/cont`, { headers: { Cookie: cookies.mt } })).status, 200);
  assert.equal((await fetch(`${BASE}/cont`, { redirect: "manual" })).headers.get("location"), `/login?next=${encodeURIComponent("/cont")}`);
});

// ── 9 / 12: gateway states ───────────────────────────────────────────────────────────────────
test("wa-gateway.resolve: { wid } / { notOnWhatsApp } / { unavailable }; fetchGroups: [] vs null", async () => {
  assert.deepEqual(await waGateway.resolve("40712345678"), { wid: "40712345678@c.us" });
  env.notOnWhatsApp.add("40712345679");
  assert.deepEqual(await waGateway.resolve("40712345679"), { notOnWhatsApp: true });
  env.gateway.resolveDown = true;
  assert.deepEqual(await waGateway.resolve("40712345678"), { unavailable: true });
  env.gateway.resolveDown = false;
  const realFetch = global.fetch;
  global.fetch = async () => new Response("{}", { status: 404 }); // other gateways: 404 = not on WhatsApp
  assert.deepEqual(await waGateway.resolve("40712345678"), { notOnWhatsApp: true });
  global.fetch = async () => { throw new Error("ECONNREFUSED"); };
  try {
    assert.deepEqual(await waGateway.resolve("40712345678"), { unavailable: true });
    assert.equal(await waGateway.fetchGroups(), null);
  } finally { global.fetch = realFetch; }
  assert.deepEqual(await waGateway.fetchGroups(), []);
});

test("/inscriere: gateway down -> 'nu este disponibilă', no quota used; not on WhatsApp -> the phone field", async () => {
  let n = 0;
  const body = () => {
    n++;
    const d = new Date(); d.setFullYear(d.getFullYear() - 18);
    return { role_choice: "membru", full_name: "Ana Popescu", phone: `4074${String(2000000 + n)}`, username: `ux2.user${n}`,
      password: "parola1234", password_confirm: "parola1234", email: `ux2${n}@eminescusm.ro`, school: "CN Mihai Eminescu",
      class: "a XI-a B", birthdate: d.toISOString().slice(0, 10), department: "tehnic", gdpr_ack: true, regulament_ack: true };
  };
  const sends = () => db.prepare("SELECT COUNT(*) c FROM otp_sends").get().c;
  const before = sends();
  env.gateway.resolveDown = true;
  const b = body();
  for (let i = 0; i < rules.OTP_MAX_PER_PHONE_HOUR + 1; i++) {
    const r = await req(null, "POST", "/api/public/register", b, { "X-Forwarded-For": "10.88.0.1" });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "Verificarea prin WhatsApp nu este disponibilă acum. Încearcă din nou mai târziu sau scrie-i unui lider.");
    assert.equal(r.body.errors, undefined);
  }
  assert.equal(sends(), before, "a gateway outage never uses the code quota");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pending_registrations WHERE phone = ?").get(b.phone).c, 0);
  env.gateway.resolveDown = false;
  const ok = await req(null, "POST", "/api/public/register", b, { "X-Forwarded-For": "10.88.0.1" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); // the same phone can register once it's back

  const c = body();
  env.notOnWhatsApp.add(c.phone);
  const r = await req(null, "POST", "/api/public/register", c, { "X-Forwarded-For": "10.88.0.2" });
  assert.equal(r.status, 400);
  assert.match(r.body.errors.phone, /nu are WhatsApp/);
});

test("Admin → Grupuri WhatsApp: a sync with the gateway down is an error, not an empty list", async () => {
  env.gateway.groupsDown = true;
  await assert.rejects(() => waGroups.list(actor("tl"), { sync: true }), { code: "UNAVAILABLE" });
  const r = await req("tl", "GET", "/api/wa-groups?sync=1");
  assert.equal(r.status, 503);
  assert.match(r.body.error, /nu răspunde/);
  assert.equal((await req("tl", "GET", "/api/wa-groups")).status, 200); // known groups still listed
  const ov = await req("tl", "GET", "/api/wa-groups/overview"); // the Admin page: 200 + the reason
  assert.equal(ov.status, 200);
  assert.match(ov.body.gateway_error, /nu răspunde/);
  assert.ok(Array.isArray(ov.body.groups));
  assert.equal((await req("mt", "GET", "/api/wa-groups/overview")).status, 403);
  env.gateway.groupsDown = false;
  assert.deepEqual((await req("tl", "GET", "/api/wa-groups?sync=1")).body, []);
  assert.deepEqual((await req("tl", "GET", "/api/wa-groups/overview")).body, { groups: [], gateway_error: null });
});

// ── 10: weekly series ────────────────────────────────────────────────────────────────────────
test("a weekly series generates sessions of its own type: a training is not a meeting", async () => {
  const start = new Date(Date.now() + 2 * 86400000).toISOString();
  const until = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const tr = events.create(actor("tl"), { title: "Antrenament joi", type: "antrenament", start_time: start, recurrence: "weekly", recurrence_until: until });
  const types = () => db.prepare("SELECT DISTINCT type FROM attendance_sessions WHERE event_id = ?").all(tr.id).map((r) => r.type);
  assert.deepEqual(types(), ["antrenament"]);
  const n = db.prepare("SELECT COUNT(*) c FROM attendance_sessions WHERE event_id = ?").get(tr.id).c;
  assert.ok(n >= 4);
  assert.ok(!meetings.list(actor("tl")).some((r) => r.title === "Antrenament joi"), "not in Ședințe");
  assert.ok(!rules.COUNTING_SESSION_TYPES.includes("antrenament"), "not counted in the percentage");
  // the calendar still expands the series per occurrence
  assert.equal(events.list(actor("tl")).filter((e) => e.id === tr.id).length, n);
  // a meeting series stays 'sedinta'; changing the series type retypes its sessions (no duplicates)
  const sd = events.create(actor("tl"), { title: "Ședință săptămânală", type: "sedinta", start_time: start, recurrence: "weekly", recurrence_until: until });
  assert.deepEqual(db.prepare("SELECT DISTINCT type FROM attendance_sessions WHERE event_id = ?").all(sd.id).map((r) => r.type), ["sedinta"]);
  events.update(actor("tl"), tr.id, { type: "eveniment" });
  assert.deepEqual(types(), ["eveniment"]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attendance_sessions WHERE event_id = ?").get(tr.id).c, n);
});

test("migration 028 retypes old 'sedinta' sessions of non-meeting series; keeps those with a PV", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crocoai-028-"));
  const old = new Database(path.join(dir, "old.db"));
  try {
    migrate(old, { until: "027_audit_log_detail.sql", log: () => {} });
    const ev = (type) => old.prepare("INSERT INTO events (title, start_time, type, recurrence, recurrence_until) VALUES ('S', '2026-10-01T15:00:00.000Z', ?, 'weekly', '2026-10-30')").run(type).lastInsertRowid;
    const ses = (date, type, eventId) => old.prepare("INSERT INTO attendance_sessions (date, start_time, type, event_id) VALUES (?, '18:00', ?, ?)").run(date, type, eventId).lastInsertRowid;
    const training = ev("antrenament"), meeting = ev("sedinta");
    const s1 = ses("2026-10-01", "sedinta", training);
    const s2 = ses("2026-10-08", "sedinta", training);
    const withPv = ses("2026-10-15", "sedinta", training);
    old.prepare("INSERT INTO meetings (session_id) VALUES (?)").run(withPv);
    const real = ses("2026-10-02", "sedinta", meeting);
    ses("2026-10-22", "antrenament", null); // a manual training already holds this slot
    const clash = ses("2026-10-22", "sedinta", training);
    old.prepare("INSERT INTO members (id, full_name, phone, role) VALUES (90, 'X', '40700000090', 'member')").run();
    old.prepare("INSERT INTO attendance_records (session_id, member_id, status) VALUES (?, 90, 'prezent')").run(s1);
    migrate(old, { log: () => {} });
    const type = (id) => old.prepare("SELECT type FROM attendance_sessions WHERE id = ?").get(id).type;
    assert.equal(type(s1), "antrenament");
    assert.equal(type(s2), "antrenament");
    assert.equal(type(withPv), "sedinta");
    assert.equal(type(real), "sedinta");
    assert.equal(type(clash), "sedinta");
    assert.equal(old.prepare("SELECT COUNT(*) c FROM attendance_records WHERE session_id = ?").get(s1).c, 1, "records kept");
  } finally { old.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 17: meeting phase ────────────────────────────────────────────────────────────────────────
test("meeting phase: programată before the start, în desfășurare until start + duration, then încheiată", () => {
  const start = bucharestToUtcMs("2026-10-20", "18:00");
  assert.equal(meetingCore.meetingPhase("2026-10-20", "18:00", 90, start - 60000), "programata");
  assert.equal(meetingCore.meetingPhase("2026-10-20", "18:00", 90, start), "in_desfasurare");
  assert.equal(meetingCore.meetingPhase("2026-10-20", "18:00", 90, start + 89 * 60000), "in_desfasurare");
  assert.equal(meetingCore.meetingPhase("2026-10-20", "18:00", 90, start + 90 * 60000), "incheiata");
  assert.equal(meetingCore.meetingPhase("2026-10-20", "18:00", null, start + 119 * 60000), "in_desfasurare"); // default 120 min
});

test("meeting list rows carry the phase", async () => {
  const s = await meetings.schedule(actor("tl"), { title: "Ședință viitoare", date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), time: "18:00", duration: 60, mode: "fizic", location: "Sala", target_type: "echipa" });
  const row = meetings.list(actor("tl")).find((r) => r.meeting_id === s.id);
  assert.equal(row.phase, "programata");
  assert.equal(meetings.get(actor("tl"), s.id).phase, "programata");
});

// ── 24: motivation reason ────────────────────────────────────────────────────────────────────
test("Cere motivare: a reason of at least ABSENCE_REASON_MIN characters, same rule for the route and the AI tool", async () => {
  assert.ok(rules.absenceReasonError(""));
  assert.ok(rules.absenceReasonError("  a "));
  assert.equal(rules.absenceReasonError("Boală"), null);
  const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const empty = await req("mt", "POST", "/api/absences", { date, reason: "  " });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, rules.absenceReasonError(""));
  assert.ok(empty.body.errors.reason);
  const tools = await buildToolList({ actor: actor("mt"), channel: "web", chatId: `web:${M.mt.id}` });
  const tool = tools.find((t) => t.name === "cere_motivare_absenta");
  const res = await tool.handler({ data: date }, {});
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.startsWith(rules.absenceReasonError("")));
  const ok = await req("mt", "POST", "/api/absences", { date, reason: "  Concurs la școală " });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.reason, "Concurs la școală");
});

// ── 25: home cards ───────────────────────────────────────────────────────────────────────────
test("Acasă: the mentor gets no student cards (attendance, motivation, documents) - decided by the server", async () => {
  assert.equal(rules.hasAttendanceDuty({ role: "mentor" }), false);
  assert.equal(rules.hasAttendanceDuty({ role: "member" }), true);
  const mentor = (await req("mentor", "GET", "/api/home")).body;
  assert.deepEqual(mentor.cards, { attendance: false, absence_request: false, documents: false });
  assert.equal(mentor.attendance, null);
  assert.equal(mentor.documents, null);
  const member = (await req("mt", "GET", "/api/home")).body;
  assert.deepEqual(member.cards, { attendance: true, absence_request: true, documents: true });
  assert.ok(member.attendance && Array.isArray(member.documents));
});

// ── 23: team identity in one file ────────────────────────────────────────────────────────────
test("team identity: pages and manifest are filled from domain/team.js, no placeholder leaks", async () => {
  for (const url of ["/login", "/inscriere", "/manifest.json"]) {
    const r = await fetch(`${BASE}${url}`);
    const text = await r.text();
    assert.equal(r.status, 200, url);
    assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/, url);
    assert.ok(text.includes(TEAM.name), url);
  }
  const manifest = await (await fetch(`${BASE}/manifest.json`)).json();
  assert.equal(manifest.name, `CrocoAI — ${TEAM.name}`);
  const login = await (await fetch(`${BASE}/login`)).text();
  assert.match(login, /placeholder="username sau telefon"/);
  assert.doesNotMatch(login, /luca\.moldovan/);
  const inscriere = await (await fetch(`${BASE}/inscriere`)).text();
  for (const s of TEAM.schools) assert.ok(inscriere.includes(`<option value="${s}"`), s);
  assert.match(inscriere, /data-email-domain="@eminescusm\.ro"/);
  assert.equal((await fetch(`${BASE}/login.html`, { redirect: "manual" })).status, 302); // raw template never served
  // the profile rules use the same list
  assert.deepEqual(profile.SCHOOLS, [...TEAM.schools, profile.OTHER_SCHOOL]);
  for (const f of fs.readdirSync(path.join(__dirname, "..", "public", "js"))) {
    if (f.endsWith(".js")) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", "public", "js", f), "utf8"), /Eminescu|eminescusm|Perpetuum/, f);
  }
});

// ── front-end wiring (no DOM): shared helpers used where the audit asked ─────────────────────
test("front-end: one-time passwords via the shared dialog, Cereri badge goes to 0, Contul meu link", () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, "..", "public", "js", rel), "utf8");
  for (const f of ["pages/membri.js", "pages/membri-profil.js", "pages/membri-cereri.js"]) {
    const src = read(f);
    assert.match(src, /showOneTimePassword\(/, f);
    assert.doesNotMatch(src, /toast\([^)]*password/, `${f}: no password in a toast`);
  }
  assert.match(read("ui.js"), /export function showOneTimePassword/);
  assert.match(read("pages/membri-cereri.js"), /classList\.toggle\("hidden", !\(count > 0\)\)/);
  const app = read("app.js");
  assert.match(app, /href="\/cont"[^>]*>[\s\S]*?Contul meu/);
  assert.match(app, /router\.register\("\/cont"/);
  assert.match(read("pages/membri-profil.js"), /\/api\/auth\/change-password/);
});
