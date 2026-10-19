#!/usr/bin/env node
// CLI wrapper around src/services/ftc-pdf-extract.js (the source-of-truth parser, also used at
// runtime by src/services/ftc-manual-updater.js). Replaces extract-ftc-pdf.py for anything that
// ships in the vendored docs - the Python script is kept only as a standalone reference, it is NOT
// called by sync-ftc-docs.sh anymore (docs/design-ai-hardening.md §2 update, BIOBUZZ 2026-2027).
//
// Usage: extract-ftc-pdf.js <raw.txt> <mode> > out.md
//   mode = rules      (Competition Manual: segments on FTC rule codes like G301, R101, I201, A1, E101)
//   mode = numbered   (Regulament NpE: segments on numbered headings like "6.1 Reguli de comunicare")
//   mode = raw        (strips boilerplate only, kept mostly as-is)
const fs = require("fs");
const { parseRules, parseNumbered, parseRaw } = require("../src/services/ftc-pdf-extract");

function main() {
  const [, , filePath, mode] = process.argv;
  if (!filePath || !mode) {
    console.error("Usage: extract-ftc-pdf.js <raw.txt> <rules|numbered|raw>");
    process.exit(1);
  }
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const fn = mode === "rules" ? parseRules : mode === "numbered" ? parseNumbered : parseRaw;
  process.stdout.write(fn(lines) + "\n");
}

main();
