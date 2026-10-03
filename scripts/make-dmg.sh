#!/bin/bash
# Builds drag-to-install DMGs from the already-signed apps with Apple's hdiutil, straight from a
# folder (no mount/eject cycle, which flakes on CI when macOS scanners keep the volume busy).
set -euo pipefail
VERSION="$(node -p "require('./package.json').version")"
for pair in "arm64:release/mac-arm64" "x64:release/mac"; do
  ARCH="${pair%%:*}"; DIR="${pair#*:}"
  APP="$DIR/Dial TV.app"
  [ -d "$APP" ] || { echo "missing $APP"; exit 1; }
  STAGE="$(mktemp -d)/Dial TV"
  mkdir -p "$STAGE"
  ditto "$APP" "$STAGE/Dial TV.app"          # ditto keeps the code signature intact
  ln -s /Applications "$STAGE/Applications"   # drag-to-install target
  OUT="release/Dial-TV-$VERSION-mac-$ARCH.dmg"
  rm -f "$OUT"
  hdiutil create -volname "Dial TV" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$OUT"
  hdiutil verify "$OUT"
  echo "built $OUT ($(du -h "$OUT" | cut -f1))"
done
