// Route-level permission check for the FTC manual force-check/status endpoints (LEADERS only).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._ftc_manual_routes_test.db");
const FTC_DOCS_DIR = path.join(os.tmpdir(), `crocoai-ftc-manual-routes-${process.pid}`);
process.env.DB_PATH = DB_FILE;
process.env.FTC_DOCS_DIR = FTC_DOCS_DIR; // never touch the real app/data/ftc-docs/ from tests
process.env.ADMIN_INITIAL_PASSWORD = "admintest123";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.WA_SHARED_SECRET = "test-wa-secret";
process.env.LOGIN_RATE_LIMIT_MAX = "1000";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }

const { server } = require("../server");
const db = require("../src/db");

// Only intercept calls to the FTC manual URL (not our own test server's requests, e.g. login).
const originalFetch = global.fetch;
const MANUAL_URL = "https://ftc-resources.firstinspires.org/ftc/game/manual";
global.fetch = (url, opts) => {
  if (String(url) === MANUAL_URL) return Promise.resolve({ status: 304 }); // unchanged -> cheap, deterministic
  return originalFetch(url, opts);
};

let BASE, tl, member;

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
  tl = insert.run("Manual TL", "ftc-tl", "40700004001", "team_leader", "team_leader", hash).lastInsertRowid;
  member = insert.run("Manual Membru", "ftc-membru", "40700004002", "member", "member", hash).lastInsertRowid;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  global.fetch = originalFetch;
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  fs.rmSync(FTC_DOCS_DIR, { recursive: true, force: true });
});

test("POST /api/ftc-docs/check is LEADERS only", async () => {
  const memberCookie = await login("ftc-membru", "test1234");
  const res = await fetch(`${BASE}/api/ftc-docs/check`, { method: "POST", headers: { Cookie: memberCookie } });
  assert.equal(res.status, 403);
});

test("GET /api/ftc-docs/manual-status is LEADERS only", async () => {
  const memberCookie = await login("ftc-membru", "test1234");
  const res = await fetch(`${BASE}/api/ftc-docs/manual-status`, { headers: { Cookie: memberCookie } });
  assert.equal(res.status, 403);
});

test("a Team Leader can force-check and read manual-status", async () => {
  const tlCookie = await login("ftc-tl", "test1234");
  const checkRes = await fetch(`${BASE}/api/ftc-docs/check`, { method: "POST", headers: { Cookie: tlCookie } });
  assert.equal(checkRes.status, 200);
  const statusRes = await fetch(`${BASE}/api/ftc-docs/manual-status`, { headers: { Cookie: tlCookie } });
  assert.equal(statusRes.status, 200);
  const body = await statusRes.json();
  assert.ok("current" in body && "history" in body);
});

test("GET /api/ftc-docs/manual-version is readable by any member", async () => {
  const memberCookie = await login("ftc-membru", "test1234");
  const res = await fetch(`${BASE}/api/ftc-docs/manual-version`, { headers: { Cookie: memberCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.season, "BIOBUZZ");
});
