#!/usr/bin/env node

/**
 * bare-link copies prebuilds for every dependency with addon:true when linking
 * react-native-bare-kit for Android. bare-posix (via bare-process → pear-wrk-wdk)
 * has no android-* prebuilds — only unsupported.js on Android — so link fails with ENOENT.
 */

const fs = require('fs');
const path = require('path');

const PATCH_MARKER = 'spaces-wallet-bare-link-skip-non-android';
const androidPlatformPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'bare-link',
  'lib',
  'platform',
  'android.js'
);

const SKIP_BLOCK = `
  // ${PATCH_MARKER}
  const hasAndroidPrebuild = hosts.some((host) => {
    try {
      require('fs').accessSync(path.join(base, 'prebuilds', host, \`\${name}.bare\`));
      return true;
    } catch {
      return false;
    }
  });
  if (!hasAndroidPrebuild) {
    return [];
  }
`;

function main() {
  if (!fs.existsSync(androidPlatformPath)) {
    console.log('[patch-bare-link-android] bare-link not installed, skipping');
    return;
  }

  let contents = fs.readFileSync(androidPlatformPath, 'utf8');
  if (contents.includes(PATCH_MARKER)) {
    console.log('[patch-bare-link-android] already patched');
    return;
  }

  const replaced = contents.replace(
    /module\.exports = async function android\(base, pkg, name, version, opts = \{\}\) \{\n  const \{ hosts = \[\], needs = \[\], out = path\.resolve\('\.'\) \} = opts\n/,
    `module.exports = async function android(base, pkg, name, version, opts = {}) {
  const { hosts = [], needs = [], out = path.resolve('.') } = opts
${SKIP_BLOCK}
`
  );

  if (replaced === contents) {
    console.warn('[patch-bare-link-android] unexpected bare-link android.js shape, skipping');
    return;
  }

  fs.writeFileSync(androidPlatformPath, replaced, 'utf8');
  console.log('[patch-bare-link-android] skip addons without Android prebuilds');
}

main();
