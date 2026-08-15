#!/usr/bin/env node

/**
 * Android 16 KB page size fixes for Play Store compliance:
 * - Regenerate @spacesops/react-native-bare-kit addon .so files (drop stale unaligned copies)
 * - Add ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON to native CMake builds
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { projectRoot, libveritasAndroidBuildGradleRelative } = require('./libveritas-package-root');
const CMAKE_FLAG = '-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON';
const CMAKE_PATCH_MARKER = 'spaces-wallet-16kb-page-size';

const BARE_KIT_ANDROID_REL = 'node_modules/@spacesops/react-native-bare-kit/android';

function patchCmakeArguments(relativeGradlePath) {
  const gradlePath = path.join(projectRoot, relativeGradlePath);
  if (!fs.existsSync(gradlePath)) {
    console.log(`[16kb] skip missing ${relativeGradlePath}`);
    return;
  }

  let contents = fs.readFileSync(gradlePath, 'utf8');
  if (contents.includes(CMAKE_PATCH_MARKER)) {
    console.log(`[16kb] already patched ${relativeGradlePath}`);
    return;
  }

  const cmakeBlockPattern = /(externalNativeBuild\s*\{\s*cmake\s*\{\s*arguments\s+)(['"][^'"]*['"])/;
  if (cmakeBlockPattern.test(contents)) {
    contents = contents.replace(
      cmakeBlockPattern,
      `$1$2, "${CMAKE_FLAG}" /* ${CMAKE_PATCH_MARKER} */`
    );
  } else {
    console.warn(`[16kb] no cmake arguments block in ${relativeGradlePath}`);
    return;
  }

  fs.writeFileSync(gradlePath, contents, 'utf8');
  console.log(`[16kb] patched ${relativeGradlePath}`);
}

function regenerateBareKitAddons() {
  const bareKitAndroidDir = path.join(projectRoot, BARE_KIT_ANDROID_REL);
  const addonsDir = path.join(bareKitAndroidDir, 'src', 'main', 'addons');
  const linkScript = path.join(bareKitAndroidDir, 'link.mjs');

  if (!fs.existsSync(linkScript)) {
    console.log('[16kb] @spacesops/react-native-bare-kit not installed, skipping addon relink');
    return;
  }

  execFileSync(process.execPath, [path.join(projectRoot, 'scripts', 'patch-bare-link-android.js')], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  fs.rmSync(addonsDir, { recursive: true, force: true });
  execFileSync(process.execPath, [linkScript], {
    cwd: bareKitAndroidDir,
    stdio: 'inherit',
  });
  console.log('[16kb] regenerated @spacesops/react-native-bare-kit Android addons');
}

function main() {
  patchCmakeArguments(libveritasAndroidBuildGradleRelative());
  patchCmakeArguments(`${BARE_KIT_ANDROID_REL}/build.gradle`);
  regenerateBareKitAddons();
}

main();
