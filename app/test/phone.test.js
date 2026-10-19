const { test } = require("node:test");
const assert = require("node:assert");
const { normalizePhone } = require("../src/domain/phone");

test("normalizePhone: 07xxxxxxxx -> 407xxxxxxxx", () => {
  assert.equal(normalizePhone("0712345678"), "40712345678");
});

test("normalizePhone: +40... -> 40...", () => {
  assert.equal(normalizePhone("+40712345678"), "40712345678");
});

test("normalizePhone: 0040... -> 40...", () => {
  assert.equal(normalizePhone("0040712345678"), "40712345678");
});

test("normalizePhone: already normalized stays the same", () => {
  assert.equal(normalizePhone("40712345678"), "40712345678");
});

test("normalizePhone: strips spaces/dashes", () => {
  assert.equal(normalizePhone("+40 712 345 678"), "40712345678");
  assert.equal(normalizePhone("0712-345-678"), "40712345678");
});

test("normalizePhone: 07... vs 407... normalize to the same value (audit bug fix)", () => {
  assert.equal(normalizePhone("0712345678"), normalizePhone("40712345678"));
});

test("normalizePhone: other country prefixes kept", () => {
  assert.equal(normalizePhone("+33612345678"), "33612345678");
});

test("normalizePhone: invalid/empty -> null", () => {
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone("abc"), null);
});
