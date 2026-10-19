const { test } = require("node:test");
const assert = require("node:assert");
const regulament = require("../src/services/regulament");

test("search('prezenta minima') contains Art. 20.1", () => {
  const results = regulament.search("prezenta minima");
  assert.ok(results.length > 0);
  assert.equal(results[0].number, 20);
  assert.ok(results[0].text.includes("20.1"));
});

test("get(20) returns the exact article text with chapter", () => {
  const art = regulament.get(20);
  assert.equal(art.title, "Cerințe de prezență");
  assert.ok(art.chapter.includes("CAPITOLUL"));
  assert.ok(art.text.includes("75%"));
});

test("get() on unknown article -> null", () => {
  assert.equal(regulament.get(9999), null);
});

test("full() returns the raw vendored markdown", () => {
  assert.ok(regulament.full().includes("REGULAMENT INTERN"));
});

test("search is diacritic-insensitive", () => {
  const withDiacritics = regulament.search("cerinte de prezenta");
  assert.ok(withDiacritics.some((a) => a.number === 20));
});
