#!/usr/bin/env node
/**
 * pear's worklet links libbare-performance.*.so. If bare-performance lands with an
 * empty prebuilds/ (seen after some npm installs), bare-kit link skips it and
 * initializeWDK fails with ADDON_NOT_FOUND. Reinstall when Android prebuilds missing.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const pkgDir = path.join(projectRoot, 'node_modules', 'bare-performance');
const marker = path.join(pkgDir, 'prebuilds', 'android-arm64', 'bare-performance.bare');
const VERSION = '2.1.1';

function main() {
  if (fs.existsSync(marker)) {
    return;
  }

  console.warn(
    '[ensure-bare-performance-prebuilds] Android prebuilds missing; reinstalling bare-performance@' +
      VERSION
  );

  if (fs.existsSync(pkgDir)) {
    fs.rmSync(pkgDir, { recursive: true, force: true });
  }

  execFileSync(
    'npm',
    ['install', `bare-performance@${VERSION}`, '--ignore-scripts', '--no-save'],
    { cwd: projectRoot, stdio: 'inherit' }
  );

  if (!fs.existsSync(marker)) {
    console.error(
      '[ensure-bare-performance-prebuilds] Still missing after reinstall:',
      marker
    );
    process.exitCode = 1;
  }
}

main();
