#!/usr/bin/env bash
# Re-vendors the regulament + anexe from moldluca/perpetuum-docs into app/knowledge/.
# Run manually whenever the source regulament changes; commit the result.
set -euo pipefail

SRC_REPO="${PERPETUUM_DOCS_PATH:-$HOME/Codes/perpetuum-docs}"
SRC_DIR="$SRC_REPO/regulament"
DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/knowledge"
DATE="$(date +%Y-%m-%d)"

if [ ! -d "$SRC_DIR" ]; then
  echo "Nu gasesc $SRC_DIR. Seteaza PERPETUUM_DOCS_PATH catre checkout-ul local al moldluca/perpetuum-docs." >&2
  exit 1
fi

for name in regulament-intern.md anexe.md; do
  src="$SRC_DIR/$name"
  dest="$DEST_DIR/$name"
  if [ ! -f "$src" ]; then
    echo "Lipseste $src, sar peste." >&2
    continue
  fi
  {
    echo "<!-- Vendorizat din moldluca/perpetuum-docs:regulament/$name la $DATE. Nu edita direct -- ruleaza scripts/sync-regulament.sh. -->"
    echo
    cat "$src"
  } > "$dest"
  echo "Actualizat $dest"
done
