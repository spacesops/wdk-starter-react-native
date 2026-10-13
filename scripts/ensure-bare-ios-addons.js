#!/usr/bin/env node
/**
 * CocoaPods prepare_command runs ios/link.mjs only during pod install. If that was
 * skipped or Pods are stale, ios/addons/*.xcframework is missing and the worklet
 * fails with ADDON_NOT_FOUND for bare-crypto at runtime.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const bareKitRoot = path.join(projectRoot, 'node_modules', '@spacesops', 'react-native-bare-kit');
const linkScript = path.join(bareKitRoot, 'ios', 'link.mjs');
const addonsDir = path.join(bareKitRoot, 'ios', 'addons');

function findBareCryptoFramework() {
  if (!fs.existsSync(addonsDir)) {
    return null;
  }
  const entries = fs.readdirSync(addonsDir);
  const match = entries.find((name) => name.startsWith('bare-crypto.') && name.endsWith('.xcframework'));
  return match ? path.join(addonsDir, match) : null;
}

function main() {
  if (!fs.existsSync(linkScript)) {
    console.error('[ensure-bare-ios-addons] Missing react-native-bare-kit:', linkScript);
    process.exitCode = 1;
    return;
  }

  const existing = findBareCryptoFramework();
  if (existing) {
    console.log('[ensure-bare-ios-addons] OK', path.relative(projectRoot, existing));
    return;
  }

  console.log('[ensure-bare-ios-addons] Running ios/link.mjs…');
  execFileSync(process.execPath, [linkScript], {
    cwd: bareKitRoot,
    stdio: 'inherit',
    env: { ...process.env },
  });

  const linked = findBareCryptoFramework();
  if (!linked) {
    console.error(
      '[ensure-bare-ios-addons] bare-crypto xcframework still missing under',
      path.relative(projectRoot, addonsDir)
    );
    process.exitCode = 1;
    return;
  }

  console.log('[ensure-bare-ios-addons] Wrote', path.relative(projectRoot, linked));
}

main();
