#!/usr/bin/env node
/**
 * Use the prebuilt worklet from @spacesops/pear-wrk-wdk (npm publish ships
 * generated/bundle/wdk-worklet.mobile.bundle.js, not scripts/).
 *
 * Rebuild only when pear is linked locally (file:../pear-wrk-wdk) with scripts/.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const pearRoot = path.join(projectRoot, 'node_modules', '@spacesops', 'pear-wrk-wdk');
const genScript = path.join(pearRoot, 'scripts', 'generate-wallet-modules.js');
const shippedBundle = path.join(
  pearRoot,
  'generated',
  'bundle',
  'wdk-worklet.mobile.bundle.js'
);

if (!fs.existsSync(pearRoot)) {
  console.error('Missing node_modules/@spacesops/pear-wrk-wdk — run npm install first.');
  process.exit(1);
}

if (fs.existsSync(genScript)) {
  console.log('Local pear-wrk-wdk with scripts/ — running gen:mobile-bundle…');
  execSync('npm run gen:mobile-bundle', { cwd: pearRoot, stdio: 'inherit' });
  process.exit(0);
}

if (!fs.existsSync(shippedBundle)) {
  console.error(
    'Published pear has no scripts/ and no prebuilt bundle at:\n  ' + shippedBundle
  );
  process.exit(1);
}

const stat = fs.statSync(shippedBundle);
console.log(
  'Using prebuilt worklet from npm (@spacesops/pear-wrk-wdk):\n  ' +
    shippedBundle +
    '\n  ' +
    (stat.size / (1024 * 1024)).toFixed(1) +
    ' MB — no local rebuild (scripts/ not shipped in tarball).'
);
console.log(
  'To rebuild: clone pear-wrk-wdk, publish, bump core, npm install — or npm overrides file:../pear-wrk-wdk.'
);
