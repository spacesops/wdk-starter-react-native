#!/usr/bin/env bash
# Build a Release iOS app with an embedded JS bundle (main.jsbundle) and install on a
# physical device — no Metro required at runtime.
#
# Usage:
#   npm run ios:release:embedded                   # IOS_DEVICE or iPhone8 (USB)
#   npm run ios:release:embedded:iphone8
#   IOS_DEVICE="My iPhone" ./scripts/ios-release-embedded.sh
#   IOS_DEVICE=iPhone16 ./scripts/ios-release-embedded.sh   # Release simulator smoke test
#
# CLEAN=0 skips xcodebuild clean. Requires a connected device (or simulator name) for --device.
#
# Requires: Xcode, CocoaPods (ios/Pods), signing team in ios project / .env IOS_DEVELOPMENT_TEAM

set -euo pipefail

export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

DEVICE="${1:-${IOS_DEVICE:-iPhone8}}"
# Set CLEAN=0 to skip DerivedData cleanup for this app.
CLEAN="${CLEAN:-1}"

if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  . "$HOME/.nvm/nvm.sh"
  if [[ -f .nvmrc ]]; then
    nvm use
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node not found. Use nvm (see .nvmrc) or set PATH." >&2
  exit 1
fi

NODE_BINARY="$(command -v node)"
mkdir -p ios
echo "export NODE_BINARY=${NODE_BINARY}" > ios/.xcode.env.local

APP_NAME="$(node -p "require('./app.json').expo.name")"
WORKSPACE="ios/${APP_NAME}.xcworkspace"

if [[ ! -d "$WORKSPACE" ]]; then
  echo "→ No $WORKSPACE — running expo prebuild (ios)…"
  npx expo prebuild --platform ios
  if [[ -x scripts/patch-ios-dev-team.sh ]]; then
    scripts/patch-ios-dev-team.sh
  fi
fi

echo "→ Postinstall patches (bare addons, libveritas, …)…"
npm run postinstall

echo "→ Linking Bare iOS addon xcframeworks…"
node scripts/ensure-bare-ios-addons.js

echo "→ CocoaPods install (react-native-bare-kit prepare_command)…"
(cd ios && pod install)

echo "→ Libveritas iOS linker libraries…"
node scripts/patch-react-native-libveritas.js

if [[ "$CLEAN" == "1" ]]; then
  echo "→ Cleaning Xcode build products for ${APP_NAME}…"
  xcodebuild \
    -workspace "$WORKSPACE" \
    -scheme "$APP_NAME" \
    -configuration Release \
    clean \
    >/dev/null 2>&1 || true
fi

echo "→ Ensuring WDK worklet bundle…"
npm run gen:bundle

echo "→ Building Release with embedded JS (Xcode export:embed) for device: ${DEVICE}"
export CI=1
npx expo run:ios --configuration Release --device "$DEVICE" --no-bundler

DERIVED_APP="$(
  {
    find "$HOME/Library/Developer/Xcode/DerivedData" -path "*/Build/Products/Release-iphoneos/${APP_NAME}.app" -type d 2>/dev/null
    find "$HOME/Library/Developer/Xcode/DerivedData" -path "*/Build/Products/Release-iphonesimulator/${APP_NAME}.app" -type d 2>/dev/null
  } | xargs ls -td 2>/dev/null | head -1
)"

if [[ -n "$DERIVED_APP" && -f "$DERIVED_APP/main.jsbundle" ]]; then
  BUNDLE_SIZE="$(du -h "$DERIVED_APP/main.jsbundle" | cut -f1)"
  echo ""
  echo "✓ Embedded bundle present: ${DERIVED_APP}/main.jsbundle (${BUNDLE_SIZE})"
  echo "✓ Installed on device (${DEVICE}). Launch ${APP_NAME} without Metro."
else
  echo ""
  echo "⚠ Build finished but main.jsbundle was not found under DerivedData." >&2
  echo "  Release builds should run export:embed in the Xcode bundle phase." >&2
  exit 1
fi
