// Unit tests for the source-of-truth FTC manual parser (src/services/ftc-pdf-extract.js), on a
// small synthetic `pdftotext -layout`-like fixture - rule ids, numbered sections, header/footer
// and TOC dot-leader stripping.
const { test } = require("node:test");
const assert = require("node:assert");
const { parseRules, parseNumbered, sectionsFromMarkdown } = require("../src/services/ftc-pdf-extract");

test("parseRules extracts rule code + title + body, strips page footers", () => {
  const lines = [
    "11   Game Rules (G) .................................................... 99",
    "",
    "                                                                               2 of 173",
    "G101 *Humans, stay off the FIELD during the MATCH. A team member may not enter the FIELD",
    "during a MATCH except as allowed by the rules.",
    "Page | 100",
    "G301 *Don't delay MATCHES. DRIVE TEAM members may not cause significant delays to the start",
    "of their MATCH.",
  ];
  const md = parseRules(lines);
  assert.match(md, /\*\*G101 — Humans, stay off the FIELD during the MATCH\*\*/);
  assert.match(md, /\*\*G301 — Don't delay MATCHES\*\*/);
  assert.doesNotMatch(md, /2 of 173/);
  assert.doesNotMatch(md, /Page \| 100/);
  assert.doesNotMatch(md, /\.{4,}/); // TOC dot-leader line dropped
});

test("parseRules merges wrapped body lines into the current rule, not a new section", () => {
  const lines = ["R101 *It is your team's ROBOT.", "The ROBOT must be built by the team."];
  const md = parseRules(lines);
  const sections = sectionsFromMarkdown(md);
  assert.equal(sections.length, 1);
  assert.match(sections[0].text, /must be built by the team/);
});

test("parseNumbered extracts numbered headings (Regulament NpE style)", () => {
  const lines = ["6.1 Reguli de comunicare", "Membrii comunică prin canalele oficiale."];
  const md = parseNumbered(lines);
  const sections = sectionsFromMarkdown(md);
  assert.equal(sections[0].code, "6.1");
  assert.equal(sections[0].title, "Reguli de comunicare");
});

test("sectionsFromMarkdown round-trips what parseRules produces", () => {
  const md = parseRules(["E101 *Personal safety comes first. All team members must observe safety."]);
  const sections = sectionsFromMarkdown(md);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].code, "E101");
});
