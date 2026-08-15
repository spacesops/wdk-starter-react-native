#!/usr/bin/env node

/**
 * bare-link copies prebuilds for every dependency with addon:true when linking
 * react-native-bare-kit for Android. bare-posix has no android-* prebuilds —
 * only unsupported.js on Android — so older bare-link fails with ENOENT.
 *
 * Prefer @spacesops/react-native-bare-kit's nested bare-link; skip if the
 * platform module shape no longer matches (newer kits already tolerate this).
 */

const fs = require('fs');
const path = require('path');

const PATCH_MARKER = 'spaces-wallet-bare-link-skip-non-android';
const projectRoot = path.join(__dirname, '..');

const CANDIDATES = [
  path.join(projectRoot, 'node_modules', 'bare-link', 'lib', 'platform', 'android.js'),
  path.join(
    projectRoot,
    'node_modules',
    '@spacesops',
    'react-native-bare-kit',
    'node_modules',
    'bare-link',
    'lib',
    'platform',
    'android.js'
  ),
];

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

function patchFile(androidPlatformPath) {
  let contents = fs.readFileSync(androidPlatformPath, 'utf8');
  if (contents.includes(PATCH_MARKER)) {
    console.log(`[patch-bare-link-android] already patched (${path.relative(projectRoot, androidPlatformPath)})`);
    return true;
  }

  // Legacy bare-link shape (sync function returning array)
  const legacy = contents.replace(
    /module\.exports = async function android\(base, pkg, name, version, opts = \{\}\) \{\n  const \{ hosts = \[\], needs = \[\], out = path\.resolve\('\.'\) \} = opts\n/,
    `module.exports = async function android(base, pkg, name, version, opts = {}) {
  const { hosts = [], needs = [], out = path.resolve('.') } = opts
${SKIP_BLOCK}
`
  );

  if (legacy !== contents) {
    fs.writeFileSync(androidPlatformPath, legacy, 'utf8');
    console.log(`[patch-bare-link-android] skip addons without Android prebuilds (${path.relative(projectRoot, androidPlatformPath)})`);
    return true;
  }

  // Newer @spacesops bare-link is an async generator; kit link.mjs already
  // tolerates missing android prebuilds (e.g. bare-posix).
  console.log(
    `[patch-bare-link-android] newer bare-link shape at ${path.relative(projectRoot, androidPlatformPath)}; no patch needed`
  );
  return true;
}

function main() {
  let found = false;
  for (const candidate of CANDIDATES) {
    if (!fs.existsSync(candidate)) continue;
    found = true;
    patchFile(candidate);
  }
  if (!found) {
    console.log('[patch-bare-link-android] bare-link not installed, skipping');
  }
}

main();
