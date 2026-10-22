// NOTICE.md (AGPL-3.0 §7(b)): the login page keeps the attribution to Perpetuum Mobile #17870.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

test("login page keeps the CrocoAI attribution", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "login.html"), "utf8");
  assert.match(html, /Bazat pe <a href="https:\/\/github\.com\/Perpetuum-Mobile-FTC\/CrocoAI"[^>]*>CrocoAI<\/a> de Perpetuum Mobile #17870/);
});

test("the attribution sits inside <main> (body is a centering flex row: a sibling would squeeze the login form)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "login.html"), "utf8");
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  assert.match(main, /<footer class="credit">/);
});
