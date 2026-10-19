// Curățenie F2 item 2: web chat and WhatsApp share services/conversation.js -> same answer for the
// same message (commands, pending "DA", agent), each channel keeps its own persistence.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { initEnv, makeMembers, login } = require("./_assign-env");
const env = initEnv("f2_conversation");

const agent = require("../src/ai/agent");
const calls = [];
let agentImpl = async (args) => ({ reply: `echo:${args.text}` });
agent.runAgent = async (args) => { calls.push(args); return agentImpl(args); };

const { server } = require("../server");
const db = require("../src/db");
const pending = require("../src/ai/pending");

let BASE, M, cookie;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [{ key: "m", role: "member", department: "tehnic" }]);
  cookie = await login(BASE, M.m.phone);
});
after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  env.cleanup();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let msgN = 0;

async function web(text) {
  const res = await fetch(`${BASE}/api/ai/web-chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ message: text }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function wa(text, from = M.m.phone) {
  const sentBefore = env.waSent.length;
  const res = await fetch(`${BASE}/wa/incoming`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-wa-secret": "test-wa-secret" },
    body: JSON.stringify({ msgId: `f2-${++msgN}`, from, pushName: "X", text }),
  });
  const body = await res.json();
  for (let i = 0; i < 50 && env.waSent.length === sentBefore; i++) await wait(10);
  const out = env.waSent.slice(sentBefore).filter((s) => (s.to || s.chatId) === from || JSON.stringify(s).includes(from));
  return { body, reply: out.length ? (out[out.length - 1].message || out[out.length - 1].text) : null };
}

test("deterministic command: same reply on web and WhatsApp", async () => {
  const w = await web("ajutor");
  const p = await wa("ajutor");
  assert.ok(w.reply.startsWith("Comenzi disponibile"));
  assert.equal(p.reply, w.reply);
  assert.equal(w.pending_confirmation, null);
});

test("agent: same args except channel/chatId, history excludes the current message", async () => {
  calls.length = 0;
  const w = await web("ce face robotul?");
  const p = await wa("ce face robotul?");
  assert.equal(w.reply, "echo:ce face robotul?");
  assert.equal(p.reply, w.reply);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].channel, "web");
  assert.equal(calls[0].chatId, `web:${M.m.id}`);
  assert.equal(calls[1].channel, "wa");
  assert.equal(calls[1].chatId, M.m.phone);
  for (const c of calls) {
    assert.equal(c.actor.id, M.m.id);
    assert.equal(c.isGroup, false);
    assert.ok(!c.history.some((h) => h.from === "user" && h.body === "ce face robotul?"), "current message not in history");
    assert.ok(c.history.some((h) => h.body === "ajutor"), "earlier lines are in history");
  }
  // persistence: web line pair + WhatsApp line pair
  const webRows = db.prepare("SELECT message_type, body FROM web_chat_messages WHERE member_id = ? ORDER BY id DESC LIMIT 2").all(M.m.id);
  assert.deepEqual(webRows.map((r) => r.message_type), ["web-ai", "web-user"]);
  const waRows = db.prepare("SELECT from_me, body FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 2").all(M.m.phone);
  assert.deepEqual(waRows.map((r) => r.from_me), [1, 0]);
});

test("pending confirmation: 'DA' sends on both channels, anything else cancels", async () => {
  pending.create(M.m, `web:${M.m.id}`, { to: "40700000001", message: "salut" });
  pending.create(M.m, M.m.phone, { to: "40700000001", message: "salut" });
  const w = await web("DA");
  const p = await wa("DA");
  assert.equal(w.reply, "Am trimis mesajul.");
  assert.equal(w.pending_confirmation, null);
  assert.equal(p.reply, w.reply);
  pending.create(M.m, `web:${M.m.id}`, { to: "40700000001", message: "x" });
  pending.create(M.m, M.m.phone, { to: "40700000001", message: "x" });
  const w2 = await web("nu");
  const p2 = await wa("nu");
  assert.equal(w2.reply, "Am anulat trimiterea (nu ai confirmat cu DA).");
  assert.equal(p2.reply, w2.reply);
});

test("agent failure: fixed technical reply on each channel, logged", async () => {
  agentImpl = async () => { throw new Error("boom"); };
  try {
    const w = await web("întrebare grea");
    assert.deepEqual(w, { reply: "Scuze, am o problemă tehnică momentan. Încearcă din nou în câteva minute." });
    const p = await wa("întrebare grea");
    assert.equal(p.reply, "Scuze, am o problemă tehnică momentan.");
  } finally {
    agentImpl = async (args) => ({ reply: `echo:${args.text}` });
  }
});

test("routes ai.js / wa-incoming.js / auth.js contain no SQL", () => {
  for (const f of ["ai.js", "wa-incoming.js", "auth.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", f), "utf8");
    assert.doesNotMatch(src, /require\("\.\.\/db"\)|db\.prepare/, f);
  }
});
