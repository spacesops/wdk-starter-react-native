#!/bin/bash
# Script to patch iOS DEVELOPMENT_TEAM in project.pbxproj after rebuild

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Get the project root (parent of scripts directory)
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Change to project root
cd "$PROJECT_ROOT"

ENV_FILE=".env"

# Expo prebuild names the Xcode project after expo.name in app.json (e.g. SpacesWallet).
APP_NAME="$(node -p "require('./app.json').expo.name" 2>/dev/null || true)"
if [ -z "$APP_NAME" ]; then
  XCODEPROJ="$(find ios -maxdepth 1 -name '*.xcodeproj' -print -quit 2>/dev/null || true)"
  if [ -n "$XCODEPROJ" ]; then
    APP_NAME="$(basename "$XCODEPROJ" .xcodeproj)"
  fi
fi

if [ -z "$APP_NAME" ]; then
  echo "Error: Could not determine iOS app name. Run 'expo prebuild' first."
  exit 1
fi

PROJECT_FILE="ios/${APP_NAME}.xcodeproj/project.pbxproj"

# Check if IOS_DEVELOPMENT_TEAM is already in .env
if [ -f "$ENV_FILE" ] && grep -q "^IOS_DEVELOPMENT_TEAM=" "$ENV_FILE"; then
  echo "IOS_DEVELOPMENT_TEAM already exists in $ENV_FILE"
else
  # Extract current DEVELOPMENT_TEAM from project.pbxproj
  if [ -f "$PROJECT_FILE" ]; then
    CURRENT_TEAM=$(grep -m 1 "DEVELOPMENT_TEAM = " "$PROJECT_FILE" | sed 's/.*DEVELOPMENT_TEAM = \([^;]*\);.*/\1/')
    if [ -n "$CURRENT_TEAM" ]; then
      # Append to existing .env or create new one
      if [ ! -f "$ENV_FILE" ]; then
        echo "# iOS Development Team ID" > "$ENV_FILE"
        echo "# This value is used to patch project.pbxproj after iOS folder rebuilds" >> "$ENV_FILE"
      else
        echo "" >> "$ENV_FILE"
        echo "# iOS Development Team ID" >> "$ENV_FILE"
        echo "# This value is used to patch project.pbxproj after iOS folder rebuilds" >> "$ENV_FILE"
      fi
      echo "IOS_DEVELOPMENT_TEAM=$CURRENT_TEAM" >> "$ENV_FILE"
      echo "Added IOS_DEVELOPMENT_TEAM=$CURRENT_TEAM to $ENV_FILE"
    else
      echo "Error: Could not find DEVELOPMENT_TEAM in $PROJECT_FILE"
      exit 1
    fi
  else
    echo "Warning: $PROJECT_FILE not found. Cannot extract DEVELOPMENT_TEAM."
    echo "Please set IOS_DEVELOPMENT_TEAM manually in $ENV_FILE"
  fi
fi

# Load .env file
if [ -f "$ENV_FILE" ]; then
  # Source the .env file to load variables
  set -a
  source "$ENV_FILE"
  set +a
fi

# Check if IOS_DEVELOPMENT_TEAM is set
if [ -z "$IOS_DEVELOPMENT_TEAM" ]; then
  echo "Error: IOS_DEVELOPMENT_TEAM not found in $ENV_FILE"
  echo "Contents of $ENV_FILE:"
  cat "$ENV_FILE" 2>/dev/null || echo "File does not exist"
  exit 1
fi

# Check if project.pbxproj exists
if [ ! -f "$PROJECT_FILE" ]; then
  echo "Error: $PROJECT_FILE not found. Run 'expo prebuild' first."
  exit 1
fi

# Patch all occurrences of DEVELOPMENT_TEAM in project.pbxproj
# Use perl for cross-platform in-place editing
perl -i -pe "s/DEVELOPMENT_TEAM = [^;]*;/DEVELOPMENT_TEAM = $IOS_DEVELOPMENT_TEAM;/g" "$PROJECT_FILE"

echo "✓ Patched DEVELOPMENT_TEAM to $IOS_DEVELOPMENT_TEAM in $PROJECT_FILE"
