const { test } = require("node:test");
const assert = require("node:assert");
const { scrub } = require("../src/middleware/scrub");

test("scrub removes credential fields at any depth and keeps everything else", () => {
  const out = scrub({ member: { id: 1, username: "a", password_hash: "$2a$x", token_version: 3, guardians: [{ name: "p", password_hash: "y" }] }, list: [{ password_hash: "z", ok: true }], n: 1, when: new Date(0) });
  const text = JSON.stringify(out);
  assert.ok(!text.includes("password_hash") && !text.includes("token_version"));
  assert.equal(out.member.username, "a");
  assert.equal(out.member.guardians[0].name, "p");
  assert.equal(out.list[0].ok, true);
  assert.ok(out.when instanceof Date);
});
