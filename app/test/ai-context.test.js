// Verifies the context passed to the AI agent excludes the current message (audit fix: the
// current message used to be logged before history was read, so it appeared twice).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "._ai_context_test.db");
const DOCS_DIR = path.join(__dirname, "._ai_context_test_documents");
process.env.DB_PATH = DB_FILE;
process.env.DOCUMENTS_DIR = DOCS_DIR;
process.env.ADMIN_INITIAL_PASSWORD = "admintest123";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.WA_SHARED_SECRET = "test-wa-secret";
process.env.LOGIN_RATE_LIMIT_MAX = "1000";
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
fs.rmSync(DOCS_DIR, { recursive: true, force: true });

// Mock the agent BEFORE routes/ai.js (and server.js) are required, so the destructured
// `runAgent` import inside routes/ai.js resolves to this mock.
const agentModule = require("../src/ai/agent");
let lastCall = null;
agentModule.runAgent = async (args) => {
  lastCall = args;
  return { reply: `echo:${args.text}` };
};

const { server } = require("../server");
const db = require("../src/db");

let BASE;

function cookieFrom(res) {
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const hash = bcrypt.hashSync("test1234", 10);
  db.prepare(`INSERT INTO members (full_name, username, phone, role, auth_role, status, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?, 'activ', ?, 0)`)
    .run("Context Tester", "ctx-tester", "40700003001", "member", "member", hash);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_FILE + ext); } catch {} }
  try { fs.rmSync(path.join(__dirname, "backups"), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(DOCS_DIR, { recursive: true, force: true }); } catch {}
});

test("web-chat: history passed to the agent never includes the message currently being answered", async () => {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "ctx-tester", password: "test1234" }),
  });
  const cookie = cookieFrom(loginRes);

  await fetch(`${BASE}/api/ai/web-chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message: "primul mesaj unic xyz1" }),
  });
  assert.deepEqual(lastCall.history, []); // nothing before the first message

  await fetch(`${BASE}/api/ai/web-chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message: "al doilea mesaj unic xyz2" }),
  });
  const bodies = lastCall.history.map((h) => h.body);
  assert.ok(bodies.includes("primul mesaj unic xyz1"));
  assert.ok(bodies.includes("echo:primul mesaj unic xyz1"));
  assert.ok(!bodies.includes("al doilea mesaj unic xyz2"), "current message must not appear in its own history");
});
