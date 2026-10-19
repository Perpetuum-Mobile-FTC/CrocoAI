// Security package A - review fix round 2: onboarding restart of privileged accounts, migration 023 (old
// completion links of privileged accounts), IPv6 /64 grouping for IP limits, global OTP cap alert, honest texts.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers } = require("./_assign-env");
const env = initEnv("sec_fix2");
const { server } = require("../server");
const db = require("../src/db");
const onboarding = require("../src/services/onboarding");
const { ipKey } = require("../src/domain/ip");
const { DomainError } = require("../src/domain/errors");

let BASE, M, seq = 0, ipN = 0;
const nextIp = () => { ipN++; return `10.99.${Math.floor(ipN / 250)}.${ipN % 250}`; };
function form(over = {}) {
  seq++;
  return {
    role_choice: "mentor", full_name: "Mihai Mentor", phone: `4076${String(1000000 + seq)}`, username: `fix2.user${seq}`,
    password: "parola1234", password_confirm: "parola1234", email: `fix2${seq}@gmail.com`, gdpr_ack: true, ...over,
  };
}
const post = (body, ip) => fetch(`${BASE}/api/public/register`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip || nextIp() }, body: JSON.stringify(body),
});

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  db.prepare("UPDATE members SET status = 'alumni' WHERE username = 'admin'").run(); // seeded admin out of the way
  M = makeMembers(db, [
    { key: "tl", role: "team_leader" }, { key: "co", role: "co_leader" }, { key: "ht", role: "head_tech", department: "tehnic" },
    { key: "mentor", role: "mentor" }, { key: "mem", role: "member" },
  ]);
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); env.cleanup(); });

test("onboarding.restart of a TL / co-leader / mentor account is Team Leader only", () => {
  for (const [actor, target] of [[M.co, M.tl], [M.ht, M.mentor], [M.ht, M.co]]) {
    assert.throws(() => onboarding.restart(actor, target.id), (e) => e instanceof DomainError && e.code === "FORBIDDEN");
  }
  assert.equal(db.prepare("SELECT onboarding_step FROM members WHERE id = ?").get(M.mentor.id).onboarding_step, 0);
  assert.ok(onboarding.restart(M.tl, M.mentor.id));
  assert.ok(onboarding.restart(M.ht, M.mem.id)); // ordinary members: unchanged
});

test("migration 023 deletes unused completion links of privileged accounts (made before the fix), keeps the rest", () => {
  const ins = db.prepare("INSERT INTO completion_tokens (member_id, token_hash, created_by, expires_at, used_at) VALUES (?, ?, ?, '2099-01-01T00:00:00.000Z', ?)");
  const tlOpen = ins.run(M.tl.id, "h-tl", M.co.id, null).lastInsertRowid;
  const mentorOpen = ins.run(M.mentor.id, "h-mentor", M.co.id, null).lastInsertRowid;
  const coUsed = ins.run(M.co.id, "h-co-used", M.co.id, "2026-10-01T00:00:00.000Z").lastInsertRowid;
  const memOpen = ins.run(M.mem.id, "h-mem", M.co.id, null).lastInsertRowid;
  const file = fs.readdirSync(path.join(__dirname, "..", "src", "db", "migrations")).find((f) => f.startsWith("023_"));
  assert.ok(file, "migration 023 exists");
  assert.ok(db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get(file), "applied on startup");
  db.exec(fs.readFileSync(path.join(__dirname, "..", "src", "db", "migrations", file), "utf8"));
  const left = db.prepare("SELECT id FROM completion_tokens").all().map((r) => r.id);
  assert.ok(!left.includes(tlOpen) && !left.includes(mentorOpen));
  assert.ok(left.includes(coUsed) && left.includes(memOpen));
});

test("ipKey groups IPv6 by /64 (and unwraps IPv4-mapped addresses)", () => {
  assert.equal(ipKey("2001:db8:1:2:aaaa::1"), ipKey("2001:0db8:0001:0002:ffff:1:2:3"));
  assert.notEqual(ipKey("2001:db8:1:2::1"), ipKey("2001:db8:1:3::1"));
  assert.equal(ipKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipKey("::ffff:10.1.2.3"), "10.1.2.3");
  assert.equal(ipKey("10.1.2.3"), "10.1.2.3");
});

test("per-IP OTP cap counts a whole IPv6 /64 as one address", async () => {
  process.env.OTP_MAX_PER_IP_HOUR = "2";
  try {
    assert.equal((await post(form(), "2001:db8:aa:bb::1")).status, 200);
    assert.equal((await post(form(), "2001:db8:aa:bb::2")).status, 200);
    const third = await post(form(), "2001:db8:aa:bb:ffff:ffff:ffff:ffff");
    assert.equal(third.status, 429);
    assert.match((await third.json()).error, /scrie-i unui lider/);
    assert.equal((await post(form(), "2001:db8:aa:bc::1")).status, 200); // another /64
  } finally { delete process.env.OTP_MAX_PER_IP_HOUR; }
});

test("global OTP cap: the active Team Leader is alerted once per hour (in-app + WhatsApp), the user gets a fallback", async () => {
  const sentLastHour = () => db.prepare("SELECT COUNT(*) c FROM otp_sends WHERE sent_at > ?").get(new Date(Date.now() - 3600000).toISOString()).c;
  process.env.OTP_MAX_GLOBAL_HOUR = String(sentLastHour());
  env.waSent.length = 0;
  try {
    for (let i = 0; i < 2; i++) {
      const r = await post(form());
      assert.equal(r.status, 429);
      assert.match((await r.json()).error, /scrie-i unui lider/);
    }
  } finally { delete process.env.OTP_MAX_GLOBAL_HOUR; }
  const alerts = db.prepare("SELECT * FROM notifications WHERE type = 'otp_global_cap'").all();
  assert.equal(alerts.length, 1, "once per hour, to the active TL only");
  assert.equal(alerts[0].member_id, M.tl.id);
  assert.match(alerts[0].body, /OTP_MAX_GLOBAL_HOUR/);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(env.waSent.filter((m) => m.to === M.tl.phone).length, 1);
});

test("409 for an existing pending registration explains the fallback", async () => {
  const body = form();
  assert.equal((await post(body)).status, 200);
  const r = await post({ ...body, username: "altcineva2", email: "alt2@gmail.com" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "Există deja o înregistrare în curs pentru acest număr. Dacă ai închis pagina, încearcă din nou peste 30 de minute sau scrie-i unui lider.");
});
