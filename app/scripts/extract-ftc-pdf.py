#!/usr/bin/env python3
"""Converts a pdftotext -layout dump of an FTC source document into the vendored markdown format
used by app/knowledge/ftc/ (and parsed by src/services/ftc-docs.js): `**<CODE> — <title>**` blocks,
one per rule/section, so rule numbers survive and can be cited in AI answers.

Usage: extract-ftc-pdf.py <raw.txt> <mode> > out.md
  mode = rules      (Competition Manual: segments on FTC rule codes like G301, R101, I201, T206, A1, E101)
  mode = numbered   (Regulament NpE: segments on numbered headings like "6.1 Reguli de comunicare")
  mode = raw        (award descriptions / checklists: strips boilerplate only, kept mostly as-is)

Called by scripts/sync-ftc-docs.sh - not meant to be run standalone except for re-extraction.
"""
import re
import sys

RULE_RE = re.compile(r"^([A-Z]{1,3}\d{2,4})\s*\*?\s*(.*)$")
NUMBERED_RE = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+([A-ZĂÂÎȘȚ].{2,90})$")
# Boilerplate lines to drop anywhere (page headers/footers, TOC dot-leaders).
NOISE_RES = [
    re.compile(r"^\s*\d+\s+of\s+\d+\s*$"),
    re.compile(r"^\s*Page\s*\|\s*\d+\s*$", re.I),
    re.compile(r"^Section \d+ .* \d+ of \d+\s*$"),
    re.compile(r"^\s*Revision\s+[\d.]+.*\d{4}\s*$", re.I),
    re.compile(r"\.{4,}\s*\d+\s*$"),  # TOC dot-leader lines "Title .......... 12"
    re.compile(r"^\s*$"),
]


def is_noise(line):
    return any(r.search(line) for r in NOISE_RES)


def clean_lines(lines):
    return [l.rstrip() for l in lines if not is_noise(l)]


def mode_rules(lines):
    out = []
    current = None
    for line in clean_lines(lines):
        m = RULE_RE.match(line)
        if m and len(m.group(1)) <= 4:
            if current:
                out.append(current)
            title = m.group(2).split(".")[0][:100].strip() or m.group(1)
            current = {"head": f"**{m.group(1)} — {title}**", "body": [m.group(2)]}
            continue
        if current:
            current["body"].append(line)
    if current:
        out.append(current)
    return "\n\n".join(f"{c['head']}\n{' '.join(c['body']).strip()}" for c in out)


def mode_numbered(lines):
    out = []
    current = None
    for line in clean_lines(lines):
        m = NUMBERED_RE.match(line)
        if m:
            if current:
                out.append(current)
            current = {"head": f"**{m.group(1)} — {m.group(2).strip()}**", "body": []}
            continue
        if current:
            current["body"].append(line)
    if current:
        out.append(current)
    return "\n\n".join(f"{c['head']}\n{' '.join(c['body']).strip()}" for c in out)


def mode_raw(lines):
    return "\n".join(clean_lines(lines))


def main():
    path, mode = sys.argv[1], sys.argv[2]
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    if mode == "rules":
        print(mode_rules(lines))
    elif mode == "numbered":
        print(mode_numbered(lines))
    else:
        print(mode_raw(lines))


if __name__ == "__main__":
    main()
