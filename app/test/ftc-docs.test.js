// Unit tests for the vendored FTC manuals search (docs/design-ai-hardening.md §2, §6).
const { test } = require("node:test");
const assert = require("node:assert");
const ftcDocs = require("../src/services/ftc-docs");

test("search('robot size starting configuration') finds R102 (18-inch starting cube, BIOBUZZ TU03)", () => {
  const results = ftcDocs.search("robot size starting configuration 18 inch cube");
  assert.ok(results.length > 0);
  assert.ok(results.some((r) => r.code === "R102"));
});

test("search('TeleOp') finds relevant TELEOP sections", () => {
  const results = ftcDocs.search("teleop autonomous period");
  assert.ok(results.length > 0);
  assert.ok(results.some((r) => /TELEOP/i.test(r.code) || /TELEOP/i.test(r.title) || /TELEOP/i.test(r.text)));
});

test("search('R101') exact rule code match returns that rule first", () => {
  const results = ftcDocs.search("R101");
  assert.equal(results[0].code, "R101");
});

test("search('') returns no results", () => {
  assert.deepEqual(ftcDocs.search(""), []);
});

test("search includes the source document for citation", () => {
  const results = ftcDocs.search("R101");
  assert.ok(results[0].source && results[0].source.length > 0);
});

test("parse() preserves numbered sections from the Regulament NpE (not just FTC rule codes)", () => {
  const results = ftcDocs.search("penalizari sanctiuni organizatorii");
  assert.ok(results.some((r) => /^\d/.test(r.code)));
});

test("listDocs() lists both vendored documents (Competition Manual + Regulament NpE)", () => {
  const docs = ftcDocs.listDocs();
  assert.equal(docs.length, 2);
  assert.ok(docs.some((d) => d.file === "competition-manual.md"));
  assert.ok(docs.some((d) => d.file === "regulament-npe.md"));
});

test("full() returns the raw vendored markdown for a known file, null for unknown", () => {
  assert.ok(ftcDocs.full("competition-manual.md").includes("R101"));
  assert.equal(ftcDocs.full("not-a-real-file.md"), null);
});

test("manualVersionInfo() reports the BIOBUZZ TU03 seed before any runtime fetch", () => {
  const meta = ftcDocs.manualVersionInfo();
  assert.equal(meta.season, "BIOBUZZ");
  assert.equal(meta.version, "TU03");
});

test("listDocs() source label for the manual includes season + version", () => {
  const docs = ftcDocs.listDocs();
  const manual = docs.find((d) => d.file === "competition-manual.md");
  assert.match(manual.source, /BIOBUZZ TU03/);
});

// Tool output cap (fix round 1): long sections are trimmed so a manual search fits small-context
// providers (Groq on_demand: 8000 tokens/min) and costs less everywhere.
const format = require("../src/ai/format");

test("formatFtcSections: per-section ~1500 chars with a hint, total ~6000, single exact section up to ~4000", () => {
  const long = (code) => ({ code, title: `Titlu ${code}`, source: "Competition Manual", text: "x".repeat(10000) });
  const many = format.formatFtcSections([long("R1"), long("R2"), long("R3"), long("R4"), long("R5")]);
  assert.ok(many.length <= 6200, `total ${many.length}`);
  assert.match(many, /text trunchiat — cere regula exactă după cod, ex\. R102/);
  assert.match(many, /R1 — /);
  for (const part of many.split("\n\n")) assert.ok(part.length <= 1700, `section ${part.length}`);

  const single = format.formatFtcSections([long("R9")]);
  assert.ok(single.length > 3500 && single.length <= 4200, `single ${single.length}`);
  assert.match(single, /text trunchiat/);

  const short = { code: "R102", title: "t", source: "s", text: "STARTING CONFIGURATION is limited to an 18-inch Cube." };
  assert.equal(format.formatFtcSections([short]), "R102 — t (s)\nSTARTING CONFIGURATION is limited to an 18-inch Cube.");
});

test("formatFtcSections on the real manual: 'robot size starting configuration' stays small and keeps R102", () => {
  const out = format.formatFtcSections(ftcDocs.search("robot size starting configuration"));
  assert.ok(out.length <= 6200, `total ${out.length}`);
  assert.match(out, /R102/);
});
