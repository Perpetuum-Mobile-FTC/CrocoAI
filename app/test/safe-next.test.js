// login.html redirect-back (design-sedinte-v3.md §2): ?next may only lead to a same-origin path.
const { test } = require("node:test");
const assert = require("node:assert");
const { safeNext } = require("../public/js/safe-next.js");

const ORIGIN = "https://crocoai.example";

test("safeNext keeps normal same-origin paths", () => {
  assert.equal(safeNext("/p/1.abcdefghijklmnop", ORIGIN), "/p/1.abcdefghijklmnop");
  assert.equal(safeNext("/sedinte?tab=x", ORIGIN), "/sedinte?tab=x");
  assert.equal(safeNext("/teme/3#top", ORIGIN), "/teme/3#top");
});

test("safeNext rejects open redirects (incl. paths that resolve to //host)", () => {
  for (const bad of [
    "/.//evil.com", "/..//evil.com", "/%2e//evil.com", "/a/..//evil.com",
    "//evil.com", "/\\evil.com", "/\t/evil.com", "https://evil.com", "javascript:alert(1)", "", null, undefined, "evil.com",
  ]) {
    const out = safeNext(bad, ORIGIN);
    assert.equal(out, "/", `${JSON.stringify(bad)} -> ${out}`);
  }
});
