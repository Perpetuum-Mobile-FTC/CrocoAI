const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");

process.env.DB_PATH = path.join(os.tmpdir(), `crocoai-wagroups-${process.pid}.db`);
const db = require("../src/db");
const gateway = require("../src/services/wa-gateway");
const waGroups = require("../src/services/wa-groups");

const leader = { id: 1, role: "team_leader", status: "activ" };
const member = { id: 2, role: "member", status: "activ" };

test("sync pulls gateway groups as untracked and keeps existing tracking", async () => {
  db.prepare("INSERT INTO wa_groups (group_id, name, tracked) VALUES ('g1@g.us', 'Vechi', 1)").run();
  gateway.fetchGroups = async () => [{ id: "g1@g.us", name: "Perpetuum Mobile" }, { id: "g2@g.us", name: "Crocorobo" }];
  const list = await waGroups.list(leader, { sync: true });
  const byId = Object.fromEntries(list.map((g) => [g.group_id, g]));
  assert.equal(byId["g1@g.us"].tracked, 1);
  assert.equal(byId["g1@g.us"].name, "Perpetuum Mobile");
  assert.equal(byId["g2@g.us"].tracked, 0);
});

test("members cannot list groups", async () => {
  await assert.rejects(() => waGroups.list(member, { sync: true }), { code: "FORBIDDEN" });
});

// Cheia gateway-ului (X-Lucid-Key) pleacă pe toate apelurile când e în env, şi lipseşte când nu e.
test("wa-gateway trimite X-Lucid-Key pe toate apelurile când LUCID_INTERNAL_KEY e setat", async () => {
  // copie proaspătă: alte teste din fişier înlocuiesc funcţii pe modulul din cache
  delete require.cache[require.resolve("../src/services/wa-gateway")];
  const gw = require("../src/services/wa-gateway");
  const vazute = [];
  const fetchVechi = global.fetch;
  global.fetch = async (url, opt = {}) => { vazute.push((opt.headers || {})["X-Lucid-Key"]); return { ok: true, json: async () => ({}) }; };
  try {
    process.env.LUCID_INTERNAL_KEY = "k-test";
    await gw.sendWhatsApp("40700000000", "x"); await gw.resolve("40700000000"); await gw.fetchGroups();
    await gw.groupParticipants({ groupId: "g", phone: "p", action: "add" }); await gw.groupInvite("g");
    assert.deepEqual(vazute, ["k-test", "k-test", "k-test", "k-test", "k-test"]);
    delete process.env.LUCID_INTERNAL_KEY; vazute.length = 0;
    await gw.sendWhatsApp("40700000000", "x"); await gw.fetchGroups();
    assert.deepEqual(vazute, [undefined, undefined]);
  } finally { global.fetch = fetchVechi; delete process.env.LUCID_INTERNAL_KEY; }
});
