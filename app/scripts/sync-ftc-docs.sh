#!/usr/bin/env bash
# Re-vendors the FTC source PDFs into app/knowledge/ftc/ as markdown, so src/services/ftc-docs.js
# and the AI tool `cauta_manual_ftc` can search them without a PDF dependency at runtime
# (docs/design-ai-hardening.md §2).
#
# Scope since BIOBUZZ 2026-2027 (docs/design-ftc-manual-updater.md):
#   - regulament-npe.md  : still vendored here from perpetuum-docs (static per season, Romanian).
#   - competition-manual.md : NO LONGER vendored by this script. The season's Competition Manual
#     is fetched/parsed live by src/services/ftc-manual-updater.js (monthly check + `POST
#     /api/ftc-docs/check`), stored in app/data/ftc-docs/ at runtime. The copy committed in
#     app/knowledge/ftc/competition-manual.md is only the SEED used before the first runtime fetch
#     (and in tests) - regenerate it manually when needed with:
#       pdftotext -layout <manual.pdf> /tmp/manual.txt
#       node scripts/extract-ftc-pdf.js /tmp/manual.txt rules > app/knowledge/ftc/competition-manual.md
#     (prepend the HTML comment + `#` title line by hand, see the existing file for the format).
#   - award-descriptions.md / field-inspection-checklist.md / robot-inspection-checklist.md were
#     removed (DECODE 2025-2026 only) - the BIOBUZZ Competition Manual covers awards (section A)
#     and inspection rules (section I) directly.
#
# Run manually whenever regulament-npe.md's source PDF changes; commit the result. Requires
# `pdftotext` (poppler, /opt/homebrew/bin on macOS).
set -euo pipefail

SRC_REPO="${PERPETUUM_DOCS_PATH:-$HOME/Codes/perpetuum-docs}"
SRC_DIR="$SRC_REPO/first-oficial"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="$ROOT_DIR/knowledge/ftc"
PDFTOTEXT="${PDFTOTEXT_BIN:-pdftotext}"
DATE="$(date +%Y-%m-%d)"

if [ ! -d "$SRC_DIR" ]; then
  echo "Nu gasesc $SRC_DIR. Seteaza PERPETUUM_DOCS_PATH catre checkout-ul local al moldluca/perpetuum-docs." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# name | source pdf | extraction mode | doc title (RO)
DOCS=(
  "regulament-npe.md|Regulament-NpE-2026-2027.pdf|numbered|Regulamentul Programului Național de Educație STEAM FTC România 2026-2027, sezonul #11"
)

for entry in "${DOCS[@]}"; do
  IFS="|" read -r out_name pdf_name mode title <<< "$entry"
  src_pdf="$SRC_DIR/$pdf_name"
  if [ ! -f "$src_pdf" ]; then
    echo "Lipseste $src_pdf, sar peste." >&2
    continue
  fi
  raw_txt="$TMP_DIR/$out_name.txt"
  "$PDFTOTEXT" -layout "$src_pdf" "$raw_txt"
  dest="$DEST_DIR/$out_name"
  {
    echo "<!-- Vendorizat din perpetuum-docs/first-oficial/$pdf_name prin scripts/sync-ftc-docs.sh la $DATE. Nu edita direct. -->"
    echo "# $title"
    echo
    node "$ROOT_DIR/scripts/extract-ftc-pdf.js" "$raw_txt" "$mode"
  } > "$dest"
  echo "Actualizat $dest"
done
