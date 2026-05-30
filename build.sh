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

MANIFEST="manifest.json"
if ! command -v python3 &>/dev/null; then
  echo "Error: python3 is required to read the version from manifest.json" >&2
  exit 1
fi

VERSION=$(python3 -c "import json; print(json.load(open('${MANIFEST}'))['version'])")
ZIP="potatofy-v${VERSION}.zip"

echo "Building ${ZIP}..."
rm -f "${ZIP}"

zip -r "${ZIP}" \
  "${MANIFEST}" \
  content-script-main.js \
  service-worker.js \
  icons/ \
  popup/ \
  lib/ \
  rules/ \
  -x "*/.*" \
  -x "popup/tests.js"

echo ""
echo "Contents:"
unzip -l "${ZIP}" | tail -n +4 | head -n -2

echo ""
echo "Done → ${ZIP}"
echo "Upload at: https://chrome.google.com/webstore/devconsole"
