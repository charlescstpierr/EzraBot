#!/usr/bin/env bash
# Compile Mino into a separate root without touching the served dist/.
# Usage: tools/build-isolated.sh /path/to/empty-or-previous-build-root
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:?Indiquez un dossier de build isolé.}"
case "$(realpath -m "$out")" in "$repo"|"$repo"/*) echo "Le build isolé doit être hors du dépôt." >&2; exit 1;; esac
mkdir -p "$out"
for name in assets web test src node_modules package.json mobile docs tools; do
  [ -e "$out/$name" ] || ln -s "$repo/$name" "$out/$name"
done
rm -rf "$out/dist"
"$repo/node_modules/.bin/tsc" -p "$repo/tsconfig.json" --outDir "$out/dist"
"$repo/node_modules/.bin/tsc" -p "$repo/web/tsconfig.json"
"$repo/node_modules/.bin/esbuild" "$repo/web/app.ts" "$repo/web/device-admin.ts" --bundle --format=esm --target=es2022 --legal-comments=eof --log-level=warning --outdir="$out/dist/web"
echo "$out"
