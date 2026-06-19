#!/bin/bash
# Verify local config for Play Internal testing + EAS submit integration.
# Usage: ./scripts/verify-play-eas-integration.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

PASS=0
WARN=0
FAIL=0

ok() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
warn() { echo "  ⚠ $1"; WARN=$((WARN + 1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

echo "Play Internal Testing + EAS integration checks"
echo "Project: @koine/spaces-wallet (com.lcfx.spaceswallet)"
echo ""

echo "1. Service account key"
SA_PATH="$ROOT/google-service-account.json"
if [[ ! -f "$SA_PATH" ]]; then
  bad "Missing google-service-account.json at repo root"
else
  ok "google-service-account.json exists"
  if node -e "
    const k = require('$SA_PATH');
    if (!k.client_email || !k.private_key || !k.project_id) process.exit(1);
    console.log(k.client_email);
    console.log(k.project_id);
  " > /tmp/spaces-sa-check.txt 2>/dev/null; then
    CLIENT_EMAIL=$(sed -n '1p' /tmp/spaces-sa-check.txt)
    PROJECT_ID=$(sed -n '2p' /tmp/spaces-sa-check.txt)
    ok "JSON valid — client_email: $CLIENT_EMAIL"
    ok "JSON valid — project_id: $PROJECT_ID"
  else
    bad "google-service-account.json is missing client_email, private_key, or project_id"
  fi
fi
echo ""

echo "2. eas.json submit profile (beta → Play Internal testing)"
TRACK=$(node -pe "JSON.parse(require('fs').readFileSync('eas.json','utf8')).submit.beta.android.track")
STATUS=$(node -pe "JSON.parse(require('fs').readFileSync('eas.json','utf8')).submit.beta.android.releaseStatus")
KEY_PATH=$(node -pe "JSON.parse(require('fs').readFileSync('eas.json','utf8')).submit.beta.android.serviceAccountKeyPath")
BUILD_TYPE=$(node -pe "JSON.parse(require('fs').readFileSync('eas.json','utf8')).build.beta.android.buildType")
DIST=$(node -pe "JSON.parse(require('fs').readFileSync('eas.json','utf8')).build.beta.distribution")

if [[ "$TRACK" == "internal" ]]; then
  ok "submit.beta.android.track = internal (Play Internal testing)"
else
  warn "submit.beta.android.track = $TRACK (expected internal for Internal testing)"
fi

if [[ "$STATUS" == "completed" ]]; then
  ok "submit.beta.android.releaseStatus = completed (auto-available on track)"
else
  warn "submit.beta.android.releaseStatus = $STATUS (draft = manual promote in Play Console)"
fi

if [[ "$KEY_PATH" == "./google-service-account.json" ]]; then
  ok "serviceAccountKeyPath matches repo root key file"
else
  warn "serviceAccountKeyPath = $KEY_PATH"
fi

if [[ "$BUILD_TYPE" == "app-bundle" && "$DIST" == "store" ]]; then
  ok "build.beta → store AAB (required for Play)"
else
  bad "build.beta must be distribution=store and buildType=app-bundle (got dist=$DIST type=$BUILD_TYPE)"
fi
echo ""

echo "2b. eas.json submit profile (open → Play Open testing)"
OPEN_TRACK=$(node -pe "JSON.parse(require('fs').readFileSync('eas.json','utf8')).submit.open.android.track")
OPEN_STATUS=$(node -pe "JSON.parse(require('fs').readFileSync('eas.json','utf8')).submit.open.android.releaseStatus")
if [[ "$OPEN_TRACK" == "beta" ]]; then
  ok "submit.open.android.track = beta (Play Open testing)"
else
  warn "submit.open.android.track = $OPEN_TRACK (expected beta for Open testing)"
fi
if [[ "$OPEN_STATUS" == "completed" ]]; then
  ok "submit.open.android.releaseStatus = completed (auto-available on track)"
else
  warn "submit.open.android.releaseStatus = $OPEN_STATUS (draft = manual promote in Play Console)"
fi
echo ""

echo "3. app.json package"
PKG=$(node -pe "JSON.parse(require('fs').readFileSync('app.json','utf8')).expo.android.package")
if [[ "$PKG" == "com.lcfx.spaceswallet" ]]; then
  ok "android.package = com.lcfx.spaceswallet"
else
  bad "android.package = $PKG (expected com.lcfx.spaceswallet)"
fi
echo ""

echo "4. EAS CLI / account"
if npx eas whoami >/tmp/eas-whoami.txt 2>&1; then
  ok "EAS logged in: $(head -1 /tmp/eas-whoami.txt)"
  if grep -q "koine" /tmp/eas-whoami.txt; then
    ok "Account has access to org koine"
  else
    warn "Confirm you have access to expo.dev/accounts/koine/projects/spaces-wallet"
  fi
else
  bad "Not logged in — run: npx eas login"
fi
echo ""

echo "5. Recent Android builds (beta profile)"
if npx eas build:list --platform android --limit 3 --non-interactive >/tmp/eas-builds.txt 2>&1; then
  if grep -q "Profile.*beta" /tmp/eas-builds.txt || grep -q "Profile                  beta" /tmp/eas-builds.txt; then
    ok "Recent beta Android builds found on EAS"
    grep -E "^(ID|Status|Version code|Application Archive URL)" /tmp/eas-builds.txt | head -20 || true
  else
    warn "No beta Android builds yet — run: npm run android:beta:build"
  fi
else
  warn "Could not list EAS builds (network or auth)"
fi
echo ""

echo "6. Play Console (manual — confirm in browser)"
echo "  • Setup → API access: Cloud project linked; $CLIENT_EMAIL active"
echo "  • Users and permissions: same email has App permissions on Spaces"
echo "  • Permissions: Release apps to testing tracks (+ View app information)"
echo "  • Testing → Internal testing: testers list + opt-in URL"
echo "  • After submit: Internal testing → Releases shows version available"
echo ""

echo "Summary: $PASS passed, $WARN warnings, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

echo ""
echo "Next:"
echo "  npm run android:beta:submit   # Internal testing (latest build)"
echo "  npm run android:beta          # build + submit to Internal"
echo "  npm run android:open:submit   # Open testing (latest build)"
echo "  npm run android:open          # build + submit to Open testing"
