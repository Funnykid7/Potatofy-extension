#!/usr/bin/env bash
# build.sh — packages Potatofy for Chrome Web Store submission.
# Produces a clean ZIP excluding docs, README, dev scripts, and the
# diagnostics test suite (which is hidden in packaged builds anyway).
#
# Usage:
#   chmod +x build.sh
#   ./build.sh
#
# Output: potatofy-v<version>.zip in the repo root.

set -euo pipefail

# Run from the repo root regardless of the caller's cwd — MANIFEST and every
# path below are relative, so running this from anywhere else previously
# crashed on the very first python3 read.
cd "$(dirname "$0")"

MANIFEST="manifest.json"
for cmd in python3 zip unzip; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required to build/verify the extension package" >&2
    exit 1
  fi
done

VERSION=$(python3 -c "import json; print(json.load(open('${MANIFEST}'))['version'])")
ZIP="potatofy-v${VERSION}.zip"

echo "Building ${ZIP}..."
rm -f "${ZIP}"

# Strip the dev-only tests.js script tag from popup.html before packaging.
# Unpacked installs need the tag so the diagnostics button works; the packaged
# ZIP excludes tests.js, so the tag would produce a broken resource reference
# that CWS review automation flags as a policy violation.
cp popup/popup.html popup/popup.html.orig
# Guard with `[ -f ... ] && ...` and the trailing `|| true`: on the normal
# success path popup.html.orig has already been moved back by the explicit
# `mv` below, so this trap's own mv would fail with .orig missing — and
# under `set -e`, a failing command inside a trap makes the WHOLE script
# report a non-zero exit code even though the build fully succeeded. The
# `|| true` keeps the trap a no-op (exit 0) whenever there's nothing to
# restore, while still protecting the interrupted/failed-mid-build case.
trap '{ [ -f popup/popup.html.orig ] && mv popup/popup.html.orig popup/popup.html; } || true' EXIT
python3 -c "
with open('popup/popup.html') as f:
    lines = f.readlines()
with open('popup/popup.html', 'w') as f:
    f.writelines(l for l in lines if 'tests.js' not in l)
"

zip -r "${ZIP}" \
  "${MANIFEST}" \
  content-script.js \
  main-throttle.js \
  service-worker.js \
  icons/ \
  popup/ \
  lib/ \
  rules/ \
  -x "*/.*" \
  -x "popup/tests.js" \
  -x "*.orig"

mv popup/popup.html.orig popup/popup.html

echo ""
echo "Contents:"
# `head -n -2` (drop the last 2 lines) is a GNU-ism — BSD/macOS head rejects
# negative counts. `sed '$d'` run twice is portable across both.
unzip -l "${ZIP}" | tail -n +4 | sed '$d' | sed '$d'

echo ""
echo "Done → ${ZIP}"
echo "Upload at: https://chrome.google.com/webstore/devconsole"
