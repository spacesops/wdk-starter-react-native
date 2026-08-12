#!/usr/bin/env node

/**
 * Some Expo npm packages ship duplicate sources under android/bin/ in addition to
 * android/src/. Autolinking scans both and emits duplicate Package classes in
 * ExpoModulesPackageList.java, which double-initializes DevLauncher and crashes
 * on startup with "DevelopmentClientController was initialized."
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

const PACKAGES_WITH_BIN_MIRROR = [
  'expo-dev-launcher',
  'expo-dev-menu',
  'expo-modules-core',
];

function main() {
  let removed = 0;

  for (const pkg of PACKAGES_WITH_BIN_MIRROR) {
    const binDir = path.join(projectRoot, 'node_modules', pkg, 'android', 'bin');
    if (!fs.existsSync(binDir)) {
      continue;
    }
    fs.rmSync(binDir, { recursive: true, force: true });
    console.log(`[patch-expo-android-bin] removed ${pkg}/android/bin`);
    removed += 1;
  }

  if (removed === 0) {
    console.log('[patch-expo-android-bin] no android/bin mirrors found (already clean)');
    return;
  }

  const generatedList = path.join(
    projectRoot,
    'node_modules',
    'expo',
    'android',
    'build',
    'generated',
    'expo',
    'src',
    'main',
    'java',
    'expo',
    'modules',
    'ExpoModulesPackageList.java'
  );
  if (fs.existsSync(generatedList)) {
    fs.rmSync(generatedList, { force: true });
    console.log('[patch-expo-android-bin] deleted stale ExpoModulesPackageList.java (Gradle will regenerate)');
  }
}

main();
