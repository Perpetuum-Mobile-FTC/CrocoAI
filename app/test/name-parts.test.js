// Prenume + Nume de familie (migration 029, src/domain/name.js): helper, every path that sets a name
// (registration, Contul meu, leader create/edit, onboarding, application accept, completion link, import, seed)
// (scripts/apply-name-mapping.js: test/name-mapping-script.test.js).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("name_parts");
process.env.OTP_MAX_GLOBAL_HOUR = "1000";
const { server } = require("../server");
const db = require("../src/db");
const name = require("../src/domain/name");
const profile = require("../src/domain/profile");
const applications = require("../src/services/applications");
const { adminName } = require("../src/db/seed");

let BASE, M, seq = 0;
const cookies = {};
async function req(key, method, url, body, headers = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method, headers: { "Content-Type": "application/json", Cookie: cookies[key] || "", ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}
const row = (id) => db.prepare("SELECT * FROM members WHERE id = ?").get(id);
const yearsAgo = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); };

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [{ key: "tl", role: "team_leader" }, { key: "mem", role: "member" }]);
  for (const k of Object.keys(M)) cookies[k] = await login(BASE, M[k].phone);
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

// ── helper ──────────────────────────────────────────────────────────────────────────────────────
test("normalizeNamePart: Romanian capitalization, hyphen/apostrophe pieces, spaces collapsed", () => {
  const cases = {
    IOANA: "Ioana", "ana-maria": "Ana-Maria", "mihai-ionuț": "Mihai-Ionuț", "o'neil": "O'Neil",
    "radu  andrei": "Radu Andrei", "  ȘTEFAN  ": "Ștefan", "IONUȚ-ALEXANDRU": "Ionuț-Alexandru", "ana - maria": "Ana-Maria",
    "maria ţuţuianu": "Maria Ţuţuianu", "": "",
  };
  for (const [input, out] of Object.entries(cases)) assert.equal(name.normalizeNamePart(input), out, input);
  assert.equal(name.composeFullName("ana-maria", "POPESCU"), "Ana-Maria Popescu");
});

test("validateNameParts: both required, 1-60 chars, letters/space/hyphen/apostrophe only", () => {
  assert.deepEqual(name.validateNameParts({}).errors, { first_name: "Completează prenumele.", last_name: "Completează numele de familie." });
  assert.equal(name.validateNameParts({ first_name: "Ana2", last_name: "Pop" }).errors.first_name, "Prenumele poate conține doar litere, spațiu, cratimă și apostrof.");
  assert.equal(name.validateNameParts({ first_name: "Ana", last_name: "-" }).errors.last_name, "Numele de familie poate conține doar litere, spațiu, cratimă și apostrof.");
  assert.match(name.validateNameParts({ first_name: "A".repeat(61), last_name: "Pop" }).errors.first_name, /cel mult 60/);
  const ok = name.validateNameParts({ first_name: " ana-maria ", last_name: "o'neil" });
  assert.deepEqual(ok, { errors: {}, value: { first_name: "Ana-Maria", last_name: "O'Neil", full_name: "Ana-Maria O'Neil" } });
});

test("legacyNameColumns keeps the parts only for the same name; splitForPrefill guesses last word", () => {
  const cur = { first_name: "Ana", last_name: "Pop" };
  assert.deepEqual(name.legacyNameColumns("ANA POP", cur), { full_name: "Ana Pop", first_name: "Ana", last_name: "Pop" });
  assert.deepEqual(name.legacyNameColumns("ana maria pop", cur), { full_name: "Ana Maria Pop", first_name: null, last_name: null });
  assert.deepEqual(name.splitForPrefill("Ana Maria Pop"), { first_name: "Ana Maria", last_name: "Pop" });
  assert.deepEqual(name.splitForPrefill("Ana"), { first_name: "Ana", last_name: "" });
});

test("seed: ADMIN_FULL_NAME split on the last space, normalized", () => {
  assert.deepEqual(adminName("luca-bogdan MOLDOVAN"), { full_name: "Luca-Bogdan Moldovan", first_name: "Luca-Bogdan", last_name: "Moldovan" });
  assert.deepEqual(adminName("ana maria pop"), { full_name: "Ana Maria Pop", first_name: "Ana Maria", last_name: "Pop" });
  assert.deepEqual(adminName("admin"), { full_name: "Admin", first_name: null, last_name: null });
  assert.equal(adminName(undefined).full_name, "Team Leader");
});

// ── registration (/inscriere) ──────────────────────────────────────────────────────────────────
function student(over = {}) {
  seq++;
  return {
    role_choice: "membru", phone: `4073${String(2000000 + seq)}`, username: `nume.parti${seq}`, password: "parola1234", password_confirm: "parola1234",
    email: `np${seq}@eminescusm.ro`, school: "CN Mihai Eminescu", class: "a XI-a B", birthdate: yearsAgo(19), department: "tehnic", gdpr_ack: true, regulament_ack: true, ...over,
  };
}
async function register(body) {
  const ip = `10.77.0.${++seq % 250}`;
  const post = (url, b) => fetch(`${BASE}/api/public${url}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify(b) });
  const first = await post("/register", body);
  if (first.status !== 200) return { status: first.status, body: await first.json() };
  const { pending_id } = await first.json();
  const code = [...env.waSent].reverse().find((m) => m.to === body.phone).text.match(/\b(\d{6})\b/)[1];
  const r = await post("/register/verify", { pending_id, code });
  return { status: r.status, body: await r.json() };
}

test("registration with Prenume + Nume de familie: normalized parts, composed full_name, audit row too", async () => {
  const body = student({ first_name: "  ANA-maria ", last_name: "popescu" });
  const r = await register(body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = db.prepare("SELECT * FROM members WHERE username = ?").get(body.username);
  assert.deepEqual([m.first_name, m.last_name, m.full_name], ["Ana-Maria", "Popescu", "Ana-Maria Popescu"]);
  const app = db.prepare("SELECT * FROM applications WHERE created_member_id = ?").get(m.id);
  assert.deepEqual([app.first_name, app.last_name, app.full_name], ["Ana-Maria", "Popescu", "Ana-Maria Popescu"]);
});

test("registration: missing / invalid name parts give Romanian field errors", async () => {
  const r = await register(student({ first_name: "", last_name: "Pop3scu" }));
  assert.equal(r.status, 400);
  assert.equal(r.body.errors.first_name, "Completează prenumele.");
  assert.equal(r.body.errors.last_name, "Numele de familie poate conține doar litere, spațiu, cratimă și apostrof.");
  const none = await register(student());
  assert.equal(none.status, 400);
  assert.equal(none.body.errors.last_name, "Completează numele de familie.");
});

test("registration from an old cached page (single full_name): capitalization only, parts NULL", async () => {
  const body = student({ full_name: "ion POPESCU" });
  const r = await register(body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = db.prepare("SELECT * FROM members WHERE username = ?").get(body.username);
  assert.deepEqual([m.full_name, m.first_name, m.last_name], ["Ion Popescu", null, null]);
});

// ── Contul meu ─────────────────────────────────────────────────────────────────────────────────
test("Contul meu: the member edits Prenume + Nume de familie (normalized, full_name recomposed, audited)", async () => {
  assert.ok(profile.OWN_EDITABLE.includes("first_name") && profile.OWN_EDITABLE.includes("last_name"));
  const r = await req("mem", "PATCH", "/api/members/me", { first_name: "maria-ioana", last_name: "IONESCU" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.first_name, r.body.last_name, r.body.name], ["Maria-Ioana", "Ionescu", "Maria-Ioana Ionescu"]);
  const m = row(M.mem.id);
  assert.equal(m.full_name, "Maria-Ioana Ionescu");
  const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'profile.self_edit' AND member_id = ? ORDER BY id DESC").get(m.id);
  assert.equal(audit.detail, "first_name,last_name");

  const bad = await req("mem", "PATCH", "/api/members/me", { first_name: "Maria", last_name: "" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errors.last_name, "Completează numele de familie.");
  const junk = await req("mem", "PATCH", "/api/members/me", { first_name: "M@ria", last_name: "Pop" });
  assert.equal(junk.status, 400);
  assert.equal(junk.body.errors.first_name, "Prenumele poate conține doar litere, spațiu, cratimă și apostrof.");
  assert.equal(row(M.mem.id).full_name, "Maria-Ioana Ionescu", "a refused edit writes nothing");
  // a single full_name is not an own-editable field
  await req("mem", "PATCH", "/api/members/me", { full_name: "Alt Nume" });
  assert.equal(row(M.mem.id).full_name, "Maria-Ioana Ionescu");
});

// ── leaders: Membru nou / Editează membru / onboarding / import ───────────────────────────────
test("leader creates and edits a member with the name parts", async () => {
  const c = await req("tl", "POST", "/api/admin/members", { first_name: "radu", last_name: "ŢEPEŞ-vodă", role: "member" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  let m = row(c.body.id);
  assert.deepEqual([m.first_name, m.last_name, m.full_name], ["Radu", "Ţepeş-Vodă", "Radu Ţepeş-Vodă"]);

  const missing = await req("tl", "POST", "/api/admin/members", { first_name: "Radu", role: "member" });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.errors.last_name, "Completează numele de familie.");

  const u = await req("tl", "PUT", `/api/admin/members/${m.id}`, { first_name: "radu andrei", last_name: "pop" });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  m = row(m.id);
  assert.deepEqual([m.first_name, m.last_name, m.full_name], ["Radu Andrei", "Pop", "Radu Andrei Pop"]);

  const bad = await req("tl", "PUT", `/api/admin/members/${m.id}`, { first_name: "R4du", last_name: "Pop" });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.first_name);

  // other fields only: the name stays
  await req("tl", "PUT", `/api/admin/members/${m.id}`, { class: "a X-a" });
  assert.equal(row(m.id).full_name, "Radu Andrei Pop");
  // legacy single name (API client): same name keeps the parts, a different one clears them
  await req("tl", "PUT", `/api/admin/members/${m.id}`, { name: "RADU ANDREI POP" });
  assert.deepEqual([row(m.id).first_name, row(m.id).full_name], ["Radu Andrei", "Radu Andrei Pop"]);
  await req("tl", "PUT", `/api/admin/members/${m.id}`, { name: "radu pop" });
  assert.deepEqual([row(m.id).first_name, row(m.id).last_name, row(m.id).full_name], [null, null, "Radu Pop"]);
});

test("onboarding start takes the name parts", async () => {
  const r = await req("tl", "POST", "/api/onboarding", { first_name: "elena", last_name: "DRAGOMIR", phone: "0744555111" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.member.first_name, r.body.member.last_name, r.body.member.full_name], ["Elena", "Dragomir", "Elena Dragomir"]);
  const none = await req("tl", "POST", "/api/onboarding", { phone: "0744555112" });
  assert.equal(none.status, 400);
  assert.equal(none.body.error, "Completează prenumele.");
});

test("CSV/vCard import (one name column): capitalization only, parts NULL", async () => {
  const rows = [{ name: "VLAD  ionescu", phone: "0744555222" }];
  const preview = await req("tl", "POST", "/api/admin/import/preview", { rows });
  assert.equal(preview.body[0].name, "Vlad Ionescu");
  const commit = await req("tl", "POST", "/api/admin/import/commit", { rows });
  const m = row(commit.body[0].id);
  assert.deepEqual([m.full_name, m.first_name, m.last_name], ["Vlad Ionescu", null, null]);
});

test("public application with parts -> accepted member keeps them", async () => {
  const { id } = applications.create({
    first_name: "cristina", last_name: "o'brien", phone: "0744555333", email: "cris@exemplu.ro", birthdate: yearsAgo(19),
    class: "a XII-a", school: "Liceul X", department: "tehnic", motivation: "Robotică.", gdpr_ack: true, regulament_ack: true,
  }, "10.1.1.1");
  const appRow = db.prepare("SELECT * FROM applications WHERE id = ?").get(id);
  assert.deepEqual([appRow.first_name, appRow.last_name, appRow.full_name], ["Cristina", "O'Brien", "Cristina O'Brien"]);
  const res = await applications.accept(row(M.tl.id), id);
  assert.deepEqual([res.member.first_name, res.member.last_name, res.member.full_name], ["Cristina", "O'Brien", "Cristina O'Brien"]);
});

test("completion link: prefill from parts (or a guess), submit writes the parts", async () => {
  const id = makeMembers(db, [{ key: "comp", role: "member" }]).comp.id;
  db.prepare("UPDATE members SET full_name = 'Ana Maria Pop' WHERE id = ?").run(id);
  const link = await req("tl", "POST", `/api/completion-links/link/${id}`);
  const token = link.body.url.split("/completare/")[1];
  const prefill = await (await fetch(`${BASE}/api/public/completion/${token}`)).json();
  assert.deepEqual([prefill.first_name, prefill.last_name], ["Ana Maria", "Pop"]);
  const r = await fetch(`${BASE}/api/public/completion/${token}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ first_name: "ana-maria", last_name: "pop", phone: "0744555444", email: "am@exemplu.ro", birthdate: yearsAgo(19), class: "a XII-a", school: "Liceul X", department: "ambele", gdpr_ack: true, regulament_ack: true }),
  });
  assert.equal(r.status, 200, await r.text());
  assert.deepEqual([row(id).first_name, row(id).last_name, row(id).full_name], ["Ana-Maria", "Pop", "Ana-Maria Pop"]);
});
