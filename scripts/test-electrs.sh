#!/bin/bash
# Back-compat wrapper — runs scripts/test-electrum-connection.mjs with project .env
#
# Usage:
#   ./scripts/test-electrs.sh
#   ./scripts/test-electrs.sh [path-to-env]
#   ./scripts/test-electrs.sh --address bc1p...
#   ./scripts/test-electrs.sh --env .env --address bc1p...

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ARGS=()
if [[ $# -eq 0 ]]; then
  ARGS=(--env "$PROJECT_ROOT/.env")
else
  for arg in "$@"; do
    if [[ "$arg" == --address || "$arg" == --env || "$arg" == -h || "$arg" == --help ]]; then
      ARGS+=("$arg")
    elif [[ -f "$arg" ]]; then
      ARGS+=(--env "$arg")
    else
      ARGS+=("$arg")
    fi
  done
fi

exec node "$SCRIPT_DIR/test-electrum-connection.mjs" "${ARGS[@]}"
