#!/usr/bin/env bash
# Stream SpacesWallet app logs from a connected iOS device while reproducing import crash.
# Usage: ./scripts/watch-import-crash.sh
# Reproduce the crash on device, then Ctrl+C and inspect output for [ImportWallet] lines.

set -euo pipefail

DEVICE="${IOS_DEVICE_NAME:-iPhone8}"

echo "Streaming logs for process 'SpacesWallet' (device: ${DEVICE})..."
echo "Reproduce the import crash now. Look for [ImportWallet] step lines."
echo ""

log stream --style compact \
  --predicate 'process == "SpacesWallet" OR eventMessage CONTAINS "[ImportWallet]"' 2>&1
