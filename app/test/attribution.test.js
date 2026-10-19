// NOTICE.md (AGPL-3.0 §7(b)): the login page keeps the attribution to Perpetuum Mobile #17870.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

test("login page keeps the CrocoAI attribution", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "login.html"), "utf8");
  assert.match(html, /Bazat pe <a href="https:\/\/github\.com\/Perpetuum-Mobile-FTC\/CrocoAI"[^>]*>CrocoAI<\/a> de Perpetuum Mobile #17870/);
});
