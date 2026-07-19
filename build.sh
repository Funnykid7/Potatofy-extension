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
#
# The stripped popup.html is produced in a throwaway staging directory rather
# than by editing popup/popup.html in place: the working tree's popup.html is
# never modified, so a hard kill (e.g. `kill -9`, OOM-kill, power loss) at any
# point during the build cannot leave it corrupted. Only the disposable
# staging dir is at risk, and it's recreated from source on the next run.
STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT
OUTDIR="$(pwd)"

cp -R "${MANIFEST}" content-script.js main-throttle.js service-worker.js icons popup lib rules "${STAGE}/"
python3 -c "
with open('${STAGE}/popup/popup.html') as f:
    lines = f.readlines()
with open('${STAGE}/popup/popup.html', 'w') as f:
    f.writelines(l for l in lines if 'tests.js' not in l)
"

(cd "${STAGE}" && zip -r "${OUTDIR}/${ZIP}" \
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
  -x "*.orig")

echo ""
echo "Contents:"
# `head -n -2` (drop the last 2 lines) is a GNU-ism — BSD/macOS head rejects
# negative counts. `sed '$d'` run twice is portable across both.
unzip -l "${ZIP}" | tail -n +4 | sed '$d' | sed '$d'

echo ""
echo "Done → ${ZIP}"
echo "Upload at: https://chrome.google.com/webstore/devconsole"
