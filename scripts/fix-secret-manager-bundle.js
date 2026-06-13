#!/usr/bin/env node

/**
 * Post-install script to fix WDK worklet bundles for native addon resolution.
 * Ensures prebuilt bundles link the same bare-* .so versions as root node_modules.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const providerPath = path.join(projectRoot, 'node_modules', '@tetherto', 'wdk-react-native-provider');
const providerImportsFile = path.join(providerPath, 'pack.imports.json');
const providerPackageJsonPath = path.join(providerPath, 'package.json');

const pearWrkPathTetherto = path.join(projectRoot, 'node_modules', '@tetherto', 'pear-wrk-wdk');
const pearWrkPathSpacesops = path.join(projectRoot, 'node_modules', '@spacesops', 'pear-wrk-wdk');
const pearWrkPath = fs.existsSync(pearWrkPathTetherto)
  ? pearWrkPathTetherto
  : pearWrkPathSpacesops;
const pearWrkImportsFile = path.join(pearWrkPath, 'pack.imports.json');

const BARE_ADDONS = ['bare-crypto', 'bare-tcp', 'bare-tls', 'bare-url', 'bare-performance'];

const ANDROID_BARE_PACK_TARGETS = [
  'android-arm',
  'android-arm64',
  'android-ia32',
  'android-x64',
];
const IOS_BARE_PACK_TARGETS = [
  'ios-arm64',
  'ios-arm64-simulator',
  'ios-x64-simulator',
];

function getBarePackTargetFlags () {
  const easPlatform = process.env.EAS_BUILD_PLATFORM;
  let targets;

  if (easPlatform === 'android') {
    targets = ANDROID_BARE_PACK_TARGETS;
  } else if (easPlatform === 'ios') {
    targets = IOS_BARE_PACK_TARGETS;
  } else if (process.platform === 'darwin') {
    targets = [...IOS_BARE_PACK_TARGETS, ...ANDROID_BARE_PACK_TARGETS];
  } else {
    // EAS/Linux local CI: iOS bare targets are unavailable outside macOS
    targets = ANDROID_BARE_PACK_TARGETS;
  }

  return targets.map((target) => `--target ${target}`).join(' ');
}

const WORKER_BUNDLE_PATH = path.join(
  providerPath,
  'lib',
  'module',
  'services',
  'wdk-service',
  'wdk-worklet.mobile.bundle.js',
);
const SECRET_MANAGER_BUNDLE_PATH = path.join(
  providerPath,
  'lib',
  'module',
  'services',
  'wdk-service',
  'wdk-secret-manager-worklet.bundle.js',
);

/**
 * pear-wrk-wdk postinstall runs create-ws-stubs across hoisted node_modules and
 * drops empty bufferutil/utf-8-validate stubs. ws requires these only when they
 * export real functions; empty stubs load successfully but crash at runtime
 * (bu.unmask is not a function), breaking Expo CLI dev middleware.
 */
function isPearWsStub (pkgDir) {
  const pkgJson = path.join(pkgDir, 'package.json');
  const indexJs = path.join(pkgDir, 'index.js');
  if (!fs.existsSync(pkgJson)) return false;
  try {
    const meta = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const body = fs.existsSync(indexJs) ? fs.readFileSync(indexJs, 'utf8').trim() : '';
    return meta.version === '1.0.0' && meta.main === 'index.js' && body === 'module.exports = {}';
  } catch (_) {
    return false;
  }
}

function removePearWsStub (pkgDir, label) {
  if (!fs.existsSync(pkgDir) || !isPearWsStub(pkgDir)) return false;
  fs.rmSync(pkgDir, { recursive: true, force: true });
  console.log(`Removed pear ws stub (${label}): ${path.basename(pkgDir)}`);
  return true;
}

function removePearWsStubs () {
  const nodeModulesRoot = path.join(projectRoot, 'node_modules');
  const stubNames = new Set(['bufferutil', 'utf-8-validate']);

  function walk (dir) {
    if (!fs.existsSync(dir)) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.name === 'shims') continue;

      if (stubNames.has(entry.name)) {
        const label = path.relative(nodeModulesRoot, fullPath) || 'root';
        removePearWsStub(fullPath, label);
        continue;
      }

      walk(fullPath);
    }
  }

  walk(nodeModulesRoot);
}

function getInstalledVersion (packageName) {
  const pkgJson = path.join(projectRoot, 'node_modules', packageName, 'package.json');
  if (!fs.existsSync(pkgJson)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
  } catch (_) {
    return null;
  }
}

function getLinkedAddonVersions (bundlePath) {
  const linked = new Map();
  if (!fs.existsSync(bundlePath)) return linked;

  try {
    const content = fs.readFileSync(bundlePath, 'utf8');
    const re = /libbare-([a-z-]+)\.(\d+\.\d+\.\d+)\.so/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      linked.set(`bare-${match[1]}`, match[2]);
    }
  } catch (_) {
    // ignore
  }

  return linked;
}

function getBundleSkew (bundlePath, addons = BARE_ADDONS) {
  const linked = getLinkedAddonVersions(bundlePath);
  const skew = [];

  for (const addon of addons) {
    const installed = getInstalledVersion(addon);
    if (!installed) continue;

    const shortName = addon.replace(/^bare-/, '');
    const linkedVersion = linked.get(addon);
    if (!linkedVersion) continue;

    if (linkedVersion !== installed) {
      skew.push({ addon, installed, linked: linkedVersion });
    }
  }

  return skew;
}

function patchProviderBundleScripts () {
  if (!fs.existsSync(providerPackageJsonPath)) return;

  const packageJson = JSON.parse(fs.readFileSync(providerPackageJsonPath, 'utf8'));
  if (!packageJson.scripts) return;

  const pearWrkImportsAbs = pearWrkImportsFile;
  const pearWrkSrcAbs = path.join(pearWrkPath, 'src', 'wdk-worklet.js');
  const secretManagerSrc = path.join(providerPath, 'src', 'worklet', 'wdk-secret-manager-worklet.js');

  const barePackTargets = getBarePackTargetFlags();
  const targetSummary = process.env.EAS_BUILD_PLATFORM || process.platform;

  packageJson.scripts['gen:worker-bundle'] =
    `npx bare-pack ${barePackTargets} --linked --imports "${pearWrkImportsAbs}" --out "${WORKER_BUNDLE_PATH}" "${pearWrkSrcAbs}"`;

  packageJson.scripts['gen:secret-manager-bundle'] =
    `npx bare-pack ${barePackTargets} --linked --imports "${providerImportsFile}" --out "${SECRET_MANAGER_BUNDLE_PATH}" "${secretManagerSrc}"`;

  fs.writeFileSync(providerPackageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`Patched provider gen:*-bundle scripts (${targetSummary}, absolute paths, --target flags)`);
}

function updatePackImports () {
  const secretManagerImportsConfig = {
    http: 'bare-http1',
    http2: 'bare-http1',
    bufferutil: 'bufferutil',
    'utf-8-validate': 'utf-8-validate',
    'sodium-native': 'sodium-native',
    'bare-crypto': 'bare-crypto',
    'bare-tcp': 'bare-tcp',
    'bare-performance': 'bare-performance',
  };

  if (fs.existsSync(providerPath)) {
    const existing = fs.existsSync(providerImportsFile)
      ? JSON.parse(fs.readFileSync(providerImportsFile, 'utf8'))
      : {};
    fs.writeFileSync(
      providerImportsFile,
      JSON.stringify({ ...existing, ...secretManagerImportsConfig }, null, 2) + '\n',
    );
    console.log('Updated provider pack.imports.json');
  }

  if (fs.existsSync(pearWrkPath)) {
    const workerImportsConfig = {
      http: 'bare-http1',
      http2: 'bare-http1',
      bufferutil: 'bufferutil',
      'utf-8-validate': 'utf-8-validate',
      'bare-crypto': 'bare-crypto',
      'bare-performance': 'bare-performance',
      'bare-tcp': 'bare-tcp',
      'sodium-native': 'sodium-native',
    };
    const existing = fs.existsSync(pearWrkImportsFile)
      ? JSON.parse(fs.readFileSync(pearWrkImportsFile, 'utf8'))
      : {};
    fs.writeFileSync(
      pearWrkImportsFile,
      JSON.stringify({ ...existing, ...workerImportsConfig }, null, 2) + '\n',
    );
    console.log('Updated pear-wrk-wdk pack.imports.json');
  }
}

function removeNestedBareModules () {
  if (!fs.existsSync(pearWrkPath)) return;

  const nestedRoot = path.join(pearWrkPath, 'node_modules');
  for (const addon of BARE_ADDONS) {
    const nested = path.join(nestedRoot, addon);
    if (fs.existsSync(nested)) {
      fs.rmSync(nested, { recursive: true, force: true });
      console.log(`Removed nested ${addon} to use root version`);
    }
  }

  const pearWrkNodeModules = path.join(pearWrkPath, 'node_modules');
  if (!fs.existsSync(pearWrkNodeModules)) {
    try {
      execSync('npm install --no-save', {
        cwd: pearWrkPath,
        stdio: 'pipe',
      });
      console.log('Installed dependencies for pear-wrk-wdk (needed for create-ws-stubs)');
    } catch (error) {
      console.warn('Failed to install dependencies for pear-wrk-wdk:', error.message);
    }
  }
}

function regenerateBundle (label, scriptName, bundlePath, addons) {
  const skew = getBundleSkew(bundlePath, addons);
  if (skew.length === 0) {
    console.log(`${label} bundle bare-* versions match installed packages`);
    return;
  }

  console.log(
    `${label} bundle addon skew detected — regenerating:`,
    skew.map(({ addon, linked, installed }) => `${addon} ${linked} -> ${installed}`).join(', '),
  );

  try {
    execSync(`npm run ${scriptName}`, {
      cwd: providerPath,
      stdio: 'inherit',
      env: {
        ...process.env,
        PATH: `${path.join(projectRoot, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH || ''}`,
      },
    });
  } catch (error) {
    throw new Error(`${label} bundle regeneration failed: ${error.message}`);
  }

  const remainingSkew = getBundleSkew(bundlePath, addons);
  if (remainingSkew.length === 0) {
    console.log(`${label} bundle regenerated successfully`);
    return;
  }

  throw new Error(
    `${label} bundle still skewed after regen: ${remainingSkew
      .map(({ addon, linked, installed }) => `${addon} ${linked} vs ${installed}`)
      .join(', ')}`,
  );
}

removePearWsStubs();

if (!fs.existsSync(providerPath)) {
  console.log('@tetherto/wdk-react-native-provider not found, skipping bundle fixes');
  process.exit(0);
}

updatePackImports();
removeNestedBareModules();
patchProviderBundleScripts();

regenerateBundle('Worker', 'gen:worker-bundle', WORKER_BUNDLE_PATH, BARE_ADDONS);
regenerateBundle('Secret manager', 'gen:secret-manager-bundle', SECRET_MANAGER_BUNDLE_PATH, ['bare-crypto']);

console.log('Bundle configuration fixes applied');
