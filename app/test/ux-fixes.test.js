// UI/UX audit batch (2026-10-19): link rendering in notifications, the Cereri tab, /sedinte/:id, login probe hint.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const DB_FILE = path.join(__dirname, "._ux_fixes_test.db");
process.env.DB_PATH = DB_FILE;
process.env.JWT_SECRET = "test-jwt-secret";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const { server } = require("../server");
const db = require("../src/db");
const { uiPermissions } = require("../src/domain/policy");
const PUBLIC = path.join(__dirname, "..", "public");

let BASE;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  try { db.close(); } catch {}
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
});

async function esm(rel) {
  const tmp = path.join(__dirname, `._ux_${path.basename(rel)}.mjs`);
  fs.copyFileSync(path.join(PUBLIC, rel), tmp);
  try { return await import(pathToFileURL(tmp).href); } finally { fs.unlinkSync(tmp); }
}

test("linkifyUrls: only http(s) URLs become anchors, everything else is escaped", async () => {
  const { linkifyUrls } = await esm("js/ui.js");
  assert.equal(
    linkifyUrls("Meet: https://meet.google.com/abc-defg-hij."),
    'Meet: <a href="https://meet.google.com/abc-defg-hij" target="_blank" rel="noopener noreferrer">https://meet.google.com/abc-defg-hij</a>.');
  assert.equal(linkifyUrls("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
  assert.doesNotMatch(linkifyUrls("javascript:alert(1) data:text/html,x"), /<a /);
  const q = linkifyUrls('https://x.test/?a=1&b="2"');
  assert.match(q, /href="https:\/\/x\.test\/\?a=1&amp;b=/);
  assert.doesNotMatch(q, /href="[^"]*"[^>]*"[^>]*>.*onerror/);
  assert.equal(linkifyUrls(null), "");
});

test("Echipă has a single tab row: Cereri is a section tab for leaders only", async () => {
  const S = await esm("js/sections.js");
  const echipa = S.SECTIONS.find((s) => s.key === "echipa");
  const user = (role) => ({ role, status: "activ", permissions: uiPermissions({ id: 1, role, status: "activ" }) });
  assert.deepEqual(S.visibleTabs(echipa, user("team_leader")).map((t) => t.key), ["membri", "grupuri", "cereri"]);
  assert.deepEqual(S.visibleTabs(echipa, user("member")).map((t) => t.key), ["membri", "grupuri"]);
  assert.equal(S.sectionForPath("/sedinte/7"), "sedinte");
});

test("/sedinte/:id is an SPA route (login redirect keeps the deep link)", async () => {
  const res = await fetch(`${BASE}/sedinte/12`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/login?next=${encodeURIComponent("/sedinte/12")}`);
});

test("login sets a readable session hint cookie (no secret) so /login can skip the probe", async () => {
  const bcrypt = require("bcryptjs");
  const hash = bcrypt.hashSync("Parola-test-123", 4);
  db.prepare("INSERT INTO members (full_name, phone, username, password_hash, role, status) VALUES ('Ux Test', '40700000099', 'ux.test', ?, 'member', 'activ')").run(hash);
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "ux.test", password: "Parola-test-123" }), // gitleaks:allow (test fixture)
  });
  assert.equal(res.status, 200);
  const cookies = res.headers.getSetCookie();
  const hint = cookies.find((c) => c.startsWith("crocoai_session="));
  assert.ok(hint && !/httponly/i.test(hint));
  assert.ok(cookies.find((c) => c.startsWith("crocoai_token=") && /httponly/i.test(c)));
  assert.match(fs.readFileSync(path.join(PUBLIC, "js", "login.js"), "utf8"), /crocoai_session=1/);
});
