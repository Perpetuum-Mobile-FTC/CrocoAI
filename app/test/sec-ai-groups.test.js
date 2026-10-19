// Security package A4 (docs/design-securitate-2026-10.md): in WhatsApp groups the bot has only the public
// tools (regulament, manual FTC, events, resources); anything personal gets the fixed "Îți răspund în
// privat la asta." with no data. Members who are not activ/pauza can't use the bot in groups either.
process.env.ANTHROPIC_API_KEY = "test-key"; // AI "configured"; the model call itself is always mocked
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initEnv, makeMembers } = require("./_assign-env");
const env = initEnv("sec_ai_groups");
const { server } = require("../server");
const db = require("../src/db");
const { buildToolList } = require("../src/ai/tools");
const agent = require("../src/ai/agent");
const commands = require("../src/ai/commands");
const aiPolicy = require("../src/domain/ai-policy");
const { decideOwnership } = require("../src/services/wa-ownership");
const tasks = require("../src/services/tasks");

const PUBLIC = ["cauta_manual_ftc", "cauta_regulament", "cauta_resurse", "evenimente_urmatoare"];
const PRIVATE_TEXT = "Scrie-mi în privat pentru asta.";
const GROUP = "120363000000000001@g.us";
let BASE, M;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  M = makeMembers(db, [
    { key: "mem", role: "member" },
    { key: "out", role: "member", status: "iesit" },
    { key: "alum", role: "member", status: "alumni" },
    { key: "pz", role: "member", status: "pauza" },
  ]);
  db.prepare("INSERT INTO wa_groups (group_id, name, tracked) VALUES (?, 'Echipa', 1)").run(GROUP);
});
after(async () => {
  await new Promise((r) => server.close(r)); db.close(); env.cleanup();
  delete process.env.ANTHROPIC_API_KEY;
});

const names = (list) => list.map((t) => t.name).sort();

test("A4: buildToolList in a group exposes only the public tools", async () => {
  const group = await buildToolList({ actor: M.mem, channel: "wa", chatId: GROUP, isGroup: true });
  assert.deepEqual(names(group), PUBLIC);
  const priv = names(await buildToolList({ actor: M.mem, channel: "wa", chatId: M.mem.phone }));
  assert.ok(priv.includes("taskurile_mele") && priv.includes("profilul_meu") && priv.length > PUBLIC.length);
});

test("A4: the private-answer text is fixed in ai-policy and replaces a [REFUZ:privat] reply", () => {
  assert.equal(aiPolicy.GROUP_PRIVATE_TEXT, PRIVATE_TEXT);
  assert.equal(aiPolicy.applyTags("[REFUZ:privat]").text, PRIVATE_TEXT);
  const turn = agent.buildUserTurn({ actor: M.mem, text: "ce taskuri am?", history: [], isGroup: true });
  assert.ok(turn.includes("[REFUZ:privat]"), turn);
  assert.ok(!agent.buildUserTurn({ actor: M.mem, text: "x", history: [] }).includes("[REFUZ:privat]"));
});

test("A4: deterministic commands with personal data answer privately-only in a group", () => {
  tasks.create(M.mem, { title: "Secretul meu" });
  for (const cmd of ["taskuri", "prezenta", "documente", "profil", "date"]) {
    assert.equal(commands.tryHandle(M.mem, cmd, { isGroup: true }), PRIVATE_TEXT, cmd);
  }
  assert.ok(commands.tryHandle(M.mem, "taskuri").includes("Secretul meu")); // private chat unchanged
  assert.notEqual(commands.tryHandle(M.mem, "evenimente", { isGroup: true }), PRIVATE_TEXT);
  assert.notEqual(commands.tryHandle(M.mem, "ajutor", { isGroup: true }), PRIVATE_TEXT);
});

test("A4: in groups only activ/pauza members get replies", () => {
  const base = { isGroup: true, mentioned: true, text: "@croco salut" };
  assert.equal(decideOwnership({ ...base, member: { status: "activ" } }).shouldReply, true);
  assert.equal(decideOwnership({ ...base, member: { status: "pauza" } }).shouldReply, true);
  for (const member of [{ status: "iesit" }, { status: "alumni" }, null]) {
    const d = decideOwnership({ ...base, member });
    assert.equal(d.handled, true); // still logged
    assert.equal(d.shouldReply, false, JSON.stringify(member));
  }
});

async function groupMessage(member, text, msgId) {
  const r = await fetch(`${BASE}/wa/incoming`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-wa-secret": process.env.WA_SHARED_SECRET },
    body: JSON.stringify({ msgId, from: member.phone, pushName: member.full_name, text, isGroup: true, groupId: GROUP, groupName: "Echipa", mentioned: true }),
  });
  assert.equal(r.status, 200);
}
async function waitForSend(n) {
  for (let i = 0; i < 100 && env.waSent.filter((m) => m.to === GROUP).length < n; i++) await new Promise((r) => setTimeout(r, 20));
  return env.waSent.filter((m) => m.to === GROUP);
}

test("A4: /wa/incoming group flow - command answered privately-only, agent called in group mode", async () => {
  env.waSent.length = 0;
  const original = agent.callModel; // the real SDK never runs in tests
  let seen = null;
  agent.callModel = async (args) => { seen = args; return { finalText: "[REFUZ:privat]", resultUsage: null, costUsd: 0, toolCalls: 0, model: "mock" }; };
  try {
    await groupMessage(M.mem, "taskuri", "g-1");
    let sent = await waitForSend(1);
    assert.equal(sent[0].text, PRIVATE_TEXT);
    assert.equal(seen, null); // deterministic command, no model call

    await groupMessage(M.mem, "@croco ce prezență am?", "g-2");
    sent = await waitForSend(2);
    assert.equal(seen.isGroup, true);
    assert.equal(sent[1].text, PRIVATE_TEXT);

    // an ex-member mentioning the bot gets nothing
    await groupMessage(M.out, "@croco taskuri", "g-3");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(env.waSent.filter((m) => m.to === GROUP).length, 2);
  } finally { agent.callModel = original; }
});
