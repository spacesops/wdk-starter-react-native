#!/usr/bin/env node

/**
 * RN 0.81+ ships React-Core as prebuilt Debug/Release tarballs. The Xcode script
 * that swaps them skips the first Debug build when no marker file exists, so a
 * stale Release binary can remain and Debug simulator builds fail to link
 * (RCTPackagerConnection, Fabric DebugStringConvertible, etc.).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const podsRoot = path.join(projectRoot, 'ios', 'Pods');
const reactNativePkg = path.join(projectRoot, 'node_modules', 'react-native', 'package.json');
const replaceScript = path.join(
  projectRoot,
  'node_modules',
  'react-native',
  'scripts',
  'replace-rncore-version.js'
);

function findSimulatorReactBinary() {
  const xcframeworkRoot = path.join(podsRoot, 'React-Core-prebuilt', 'React.xcframework');
  if (!fs.existsSync(xcframeworkRoot)) {
    return null;
  }

  const simulatorSlice = path.join(
    xcframeworkRoot,
    'ios-arm64_x86_64-simulator',
    'React.framework',
    'React'
  );
  if (fs.existsSync(simulatorSlice)) {
    return simulatorSlice;
  }

  for (const entry of fs.readdirSync(xcframeworkRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.includes('simulator')) {
      continue;
    }
    const candidate = path.join(xcframeworkRoot, entry.name, 'React.framework', 'React');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function hasDebugCoreSymbols(binaryPath) {
  const result = spawnSync('nm', ['-gU', binaryPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    return false;
  }
  return result.stdout.includes('_OBJC_CLASS_$_RCTPackagerConnection');
}

function runReplace(configuration, version) {
  const args = ['-c', configuration, '-r', version, '-p', podsRoot];
  const result = spawnSync(process.execPath, [replaceScript, ...args], {
    cwd: podsRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  if (!fs.existsSync(podsRoot) || !fs.existsSync(replaceScript)) {
    return;
  }

  const reactBinary = findSimulatorReactBinary();
  if (!reactBinary) {
    return;
  }

  if (hasDebugCoreSymbols(reactBinary)) {
    return;
  }

  const version = JSON.parse(fs.readFileSync(reactNativePkg, 'utf8')).version;
  console.log(
    `[ios] React-Core-prebuilt is missing Debug symbols; swapping to Debug (${version})...`
  );

  // Seed the marker so the Debug swap is not skipped on first run.
  runReplace('Release', version);
  runReplace('Debug', version);
}

main();
