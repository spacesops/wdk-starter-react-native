#!/bin/bash
# Push local .env variables to all EAS environments (development, preview, production).
# Usage: ./scripts/push-env-to-eas.sh [path-to-env-file]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${1:-$PROJECT_ROOT/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE"
  echo "Copy .env.example to .env and fill in your values first."
  exit 1
fi

echo "Pushing environment variables from $ENV_FILE to EAS..."
echo "  Environments: development, preview, production"
echo ""

npx eas-cli env:push \
  --path "$ENV_FILE" \
  --environment development \
  --environment preview \
  --environment production \
  --force

echo ""
echo "Done. Variables are synced to all EAS build profile environments."
