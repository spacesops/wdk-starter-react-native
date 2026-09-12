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

/** Eclipse/Java-LS copies of the included Gradle plugin projects. Packaging from these yields a JAR that has the plugin descriptor but not DevLauncherPlugin / ExpoModulesGradlePlugin. */
const GRADLE_PLUGIN_BIN_MIRRORS = [
  path.join('expo-dev-launcher', 'expo-dev-launcher-gradle-plugin'),
  path.join('expo-modules-core', 'expo-module-gradle-plugin'),
];

function removeDir(relParts, label) {
  const dir = path.join(projectRoot, 'node_modules', ...relParts);
  if (!fs.existsSync(dir)) {
    return false;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[patch-expo-android-bin] removed ${label}`);
  return true;
}

function main() {
  let removed = 0;

  for (const pkg of PACKAGES_WITH_BIN_MIRROR) {
    if (removeDir([pkg, 'android', 'bin'], `${pkg}/android/bin`)) {
      removed += 1;
    }
  }

  for (const rel of GRADLE_PLUGIN_BIN_MIRRORS) {
    if (removeDir([rel, 'bin'], `${rel}/bin`)) {
      removed += 1;
      // Force Kotlin to recompile into the plugin JAR (bin copies yield a descriptor-only JAR).
      removeDir([rel, 'build'], `${rel}/build`);
    }
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
