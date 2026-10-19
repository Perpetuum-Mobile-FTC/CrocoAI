// wa-groups invite_link fallback field (ops update, design-phase2.md §7). The team chat tests that lived
// here were removed with the chat itself (pachet B, docs/design-pachet-b.md B2).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._wa_groups_invite_test.db");
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INITIAL_PASSWORD = "admintest123";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.WA_SHARED_SECRET = "test-wa-secret";
process.env.LOGIN_RATE_LIMIT_MAX = "1000";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const { server } = require("../server");
const db = require("../src/db");

let BASE;
let tl, alice;

function cookieFrom(res) { return (res.headers.get("set-cookie") || "").split(";")[0]; }
async function login(phone, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, password }),
  });
  assert.equal(res.status, 200, `login failed: ${await res.text()}`);
  return cookieFrom(res);
}

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const hash = bcrypt.hashSync("test1234", 10);
  const insert = db.prepare(`
    INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, 'activ', ?, 0)
  `);
  tl = insert.run("Chat TL", "chat-tl", "40700004001", "team_leader", "team_leader", hash).lastInsertRowid;
  alice = insert.run("Chat Alice", "chat-alice", "40700004002", "member", "member", hash).lastInsertRowid;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  try { fs.rmSync(path.join(__dirname, "backups"), { recursive: true, force: true }); } catch {}
});

test("wa-groups invite_link: LEADERS can set it, validated, used by the Admin UI payload shape", async () => {
  db.prepare("INSERT INTO wa_groups (group_id, name, tracked) VALUES ('chat-test-group@g.us', 'Grup Test', 1)").run();
  const tlCookie = await login("chat-tl", "test1234");

  const invalid = await fetch(`${BASE}/api/wa-groups/chat-test-group@g.us/invite-link`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: tlCookie }, body: JSON.stringify({ link: "https://evil.example.com" }),
  });
  assert.equal(invalid.status, 400);

  const valid = await fetch(`${BASE}/api/wa-groups/chat-test-group@g.us/invite-link`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: tlCookie }, body: JSON.stringify({ link: "https://chat.whatsapp.com/abc123" }),
  });
  assert.equal(valid.status, 200);
  const updated = await valid.json();
  assert.equal(updated.invite_link, "https://chat.whatsapp.com/abc123");

  const aliceCookie = await login("chat-alice", "test1234");
  const forbidden = await fetch(`${BASE}/api/wa-groups/chat-test-group@g.us/invite-link`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: aliceCookie }, body: JSON.stringify({ link: "https://chat.whatsapp.com/xyz" }),
  });
  assert.equal(forbidden.status, 403);
});
