#!/usr/bin/env node

/**
 * Gradle's generated settings.gradle runs `commandLine("node", ...)` during
 * configuration. That fails when `node` is not on PATH (common with nvm if a
 * Gradle daemon was started from Android Studio, or from a minimal environment).
 *
 * Patch settings.gradle to use the absolute path of the Node running this script.
 */

const fs = require('fs');
const path = require('path');

const MARKER = 'spaces-wallet-node-executable';
const settingsPath = path.join(__dirname, '..', 'android', 'settings.gradle');

function main() {
  if (!fs.existsSync(settingsPath)) {
    console.log('[patch-android-settings-node] android/settings.gradle not found, skipping');
    return;
  }

  const nodeExecutable = process.execPath;
  let contents = fs.readFileSync(settingsPath, 'utf8');

  const preamble = `  // ${MARKER}
  def spacesWalletNodeExecutable = ${JSON.stringify(nodeExecutable)}
`;

  if (contents.includes(MARKER)) {
    contents = contents.replace(
      /def spacesWalletNodeExecutable = ".*?"/,
      `def spacesWalletNodeExecutable = ${JSON.stringify(nodeExecutable)}`
    );
  } else {
    contents = contents.replace('pluginManagement {', `pluginManagement {\n${preamble}`);
  }

  contents = contents.replace(/commandLine\("node",/g, 'commandLine(spacesWalletNodeExecutable,');

  fs.writeFileSync(settingsPath, contents, 'utf8');
  console.log(`[patch-android-settings-node] using ${nodeExecutable}`);
}

main();
