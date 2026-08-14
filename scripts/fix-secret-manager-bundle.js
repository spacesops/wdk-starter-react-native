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

const pearWrkPathTetherto = path.join(projectRoot, 'node_modules', '@tetherto', 'pear-wrk-wdk');
const pearWrkPathSpacesops = path.join(projectRoot, 'node_modules', '@spacesops', 'pear-wrk-wdk');
const pearWrkPath = fs.existsSync(pearWrkPathTetherto)
  ? pearWrkPathTetherto
  : pearWrkPathSpacesops;
const pearWrkImportsFile = path.join(pearWrkPath, 'pack.imports.json');

const BARE_ADDONS = ['bare-crypto', 'bare-tcp', 'bare-tls', 'bare-url'];
// Nested copies of these must be removed before bare-pack; otherwise wallet-btc's
// own node_modules wins and packs a native binding the worklet cannot load.
const NESTED_BARE_TO_REMOVE = [...BARE_ADDONS, 'bare-performance'];

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

function getBarePackPlatform () {
  const explicit = process.env.BARE_PACK_PLATFORM;
  if (explicit === 'android' || explicit === 'ios') {
    return explicit;
  }

  const easPlatform = process.env.EAS_BUILD_PLATFORM;
  if (easPlatform === 'android' || easPlatform === 'ios') {
    return easPlatform;
  }

  if (process.platform === 'darwin') {
    return 'ios';
  }

  return 'android';
}

function getBarePackTargetFlags () {
  const platform = getBarePackPlatform();
  const targets =
    platform === 'android' ? ANDROID_BARE_PACK_TARGETS : IOS_BARE_PACK_TARGETS;

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
      const addon = `bare-${match[1]}`;
      const version = match[2];
      if (!linked.has(addon)) linked.set(addon, new Set());
      linked.get(addon).add(version);
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

    const linkedVersions = linked.get(addon);
    if (!linkedVersions || linkedVersions.size === 0) continue;

    const versions = [...linkedVersions];
    if (versions.length !== 1 || versions[0] !== installed) {
      skew.push({
        addon,
        installed,
        linked: versions.join(', '),
      });
    }
  }

  return skew;
}

function bundleHasIosLinkedFrameworks (bundlePath) {
  if (!fs.existsSync(bundlePath)) return false;
  try {
    return /\.framework\//.test(fs.readFileSync(bundlePath, 'utf8'));
  } catch (_) {
    return false;
  }
}

function bundleHasAndroidLinkedSo (bundlePath) {
  if (!fs.existsSync(bundlePath)) return false;
  try {
    return /linked:libbare-[a-z-]+\.\d+\.\d+\.\d+\.so/.test(fs.readFileSync(bundlePath, 'utf8'));
  } catch (_) {
    return false;
  }
}

function bundleNeedsPlatformLinkedFormat (bundlePath) {
  const platform = getBarePackPlatform();

  if (platform === 'ios') {
    return !bundleHasIosLinkedFrameworks(bundlePath);
  }

  return !bundleHasAndroidLinkedSo(bundlePath);
}

/** Only rewrite bundles for platform mismatch during explicit platform builds. */
function shouldRegenerateForPlatformMismatch (bundlePath) {
  if (!(process.env.BARE_PACK_PLATFORM || process.env.EAS_BUILD_PLATFORM)) {
    return false;
  }

  const platform = getBarePackPlatform();

  if (platform === 'android') {
    // Mixed .framework + .so bundles can still resolve iOS addons first on Android.
    return !bundleHasAndroidLinkedSo(bundlePath) || bundleHasIosLinkedFrameworks(bundlePath);
  }

  return !bundleHasIosLinkedFrameworks(bundlePath);
}

function getBarePackBin () {
  const barePackBin = path.join(projectRoot, 'node_modules', '.bin', 'bare-pack');
  if (!fs.existsSync(barePackBin)) {
    throw new Error(
      `bare-pack not found at ${barePackBin}. Ensure bare-pack is installed (production EAS builds need it in dependencies).`,
    );
  }
  return barePackBin;
}

function runBarePack (bundlePath, importsPath, entryPath) {
  const barePackBin = getBarePackBin();
  const command = [
    `"${barePackBin}"`,
    getBarePackTargetFlags(),
    '--linked',
    `--imports "${importsPath}"`,
    `--out "${bundlePath}"`,
    `"${entryPath}"`,
  ].join(' ');

  execSync(command, {
    stdio: 'inherit',
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${path.join(projectRoot, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH || ''}`,
    },
  });
}

function getLedgerBitcoinShimPath () {
  return path.join(pearWrkPath, 'shims', 'ledger-bitcoin', 'index.js');
}

function ensureBarePerformanceShim () {
  const src = path.join(projectRoot, 'node_modules', 'bare-performance');
  const dest = path.join(pearWrkPath, 'shims', 'bare-performance');
  if (!fs.existsSync(src)) {
    throw new Error(`bare-performance not found at ${src}`);
  }

  fs.mkdirSync(path.join(pearWrkPath, 'shims'), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (entry) => {
      const base = path.basename(entry);
      return (
        base !== 'prebuilds'
        && base !== 'binding.c'
        && base !== 'CMakeLists.txt'
        && !entry.includes(`${path.sep}prebuilds${path.sep}`)
      );
    },
  });

  fs.copyFileSync(
    path.join(__dirname, 'bare-performance-binding-stub.js'),
    path.join(dest, 'binding.js'),
  );

  const pkgJsonPath = path.join(dest, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  delete pkg.addon;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');

  return dest;
}

function replaceHoistedBarePerformanceWithShim () {
  const shim = ensureBarePerformanceShim();
  const target = path.join(projectRoot, 'node_modules', 'bare-performance');
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(shim, target, { recursive: true });
  console.log('Replaced hoisted bare-performance with JS shim');
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
    const ledgerBitcoinShim = getLedgerBitcoinShimPath();
    if (!fs.existsSync(ledgerBitcoinShim)) {
      throw new Error(`ledger-bitcoin shim not found at ${ledgerBitcoinShim}`);
    }

    const barePerformanceShim = ensureBarePerformanceShim();

    const workerImportsConfig = {
      http: 'bare-http1',
      http2: 'bare-http1',
      bufferutil: 'bufferutil',
      'utf-8-validate': 'utf-8-validate',
      'bare-crypto': 'bare-crypto',
      'bare-tcp': 'bare-tcp',
      'bare-tls': 'bare-tls',
      'bare-url': 'bare-url',
      'sodium-native': 'sodium-native',
      // descriptors-core require()'s the scoped package name; map both so bare-pack
      // can resolve without installing @ledgerhq/ledger-bitcoin on mobile.
      'ledger-bitcoin': ledgerBitcoinShim,
      '@ledgerhq/ledger-bitcoin': ledgerBitcoinShim,
      'bare-performance': path.join(barePerformanceShim, 'index.js'),
    };
    const existing = fs.existsSync(pearWrkImportsFile)
      ? JSON.parse(fs.readFileSync(pearWrkImportsFile, 'utf8'))
      : {};
    // Drop any prior absolute bare-* remaps that break bare-module-traverse.
    for (const addon of BARE_ADDONS) {
      if (
        typeof existing[addon] === 'string' &&
        path.isAbsolute(existing[addon])
      ) {
        delete existing[addon];
      }
    }
    fs.writeFileSync(
      pearWrkImportsFile,
      JSON.stringify({ ...existing, ...workerImportsConfig }, null, 2) + '\n',
    );
    console.log(
      `Updated pear-wrk-wdk pack.imports.json (ledger-bitcoin, bare-performance shims)`,
    );
  }
}

function removeNestedBareModules () {
  if (!fs.existsSync(pearWrkPath)) return;

  const nestedRoot = path.join(pearWrkPath, 'node_modules');
  if (!fs.existsSync(nestedRoot)) return;

  // Remove every nested copy of NESTED_BARE_TO_REMOVE under pear-wrk-wdk (any
  // depth), including through package symlinks into local checkouts such as
  // ../wdk-wallet-btc. Leaving those packs a second bare-crypto/tcp version
  // beside the root override, or a native bare-performance instead of the JS shim.
  const stack = [nestedRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(full).isDirectory();
        } catch (_) {
          continue;
        }
      }
      if (!isDir) continue;

      if (NESTED_BARE_TO_REMOVE.includes(entry.name)) {
        // Always remove nested addon copies, even when reached via a package
        // symlink into a local checkout (e.g. ../wdk-wallet-btc). Leaving them
        // packs a second bare-crypto/tcp version beside the root override.
        fs.rmSync(full, { recursive: true, force: true });
        console.log(`Removed nested ${entry.name} to use root version (${path.relative(projectRoot, full)})`);
        continue;
      }

      if (entry.name === 'node_modules' || entry.name.startsWith('@')) {
        stack.push(full);
      } else {
        const nested = path.join(full, 'node_modules');
        if (fs.existsSync(nested)) stack.push(nested);
      }
    }
  }
}

function regenerateBundle (label, bundlePath, importsPath, entryPath, addons) {
  const skew = getBundleSkew(bundlePath, addons);
  const wrongLinkedFormat = shouldRegenerateForPlatformMismatch(bundlePath);
  if (!fs.existsSync(bundlePath)) {
    console.log(`${label} bundle missing — regenerating`);
  } else if (skew.length === 0 && !wrongLinkedFormat) {
    console.log(`${label} bundle bare-* versions match installed packages`);
    return;
  } else if (wrongLinkedFormat) {
    console.log(
      `${label} bundle linked-addon format does not match ${getBarePackPlatform()} — regenerating`,
    );
  } else {
    console.log(
      `${label} bundle addon skew detected — regenerating:`,
      skew.map(({ addon, linked, installed }) => `${addon} ${linked} -> ${installed}`).join(', '),
    );
  }

  try {
    runBarePack(bundlePath, importsPath, entryPath);
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

try {
  if (!fs.existsSync(providerPath)) {
    console.log('@tetherto/wdk-react-native-provider not found, skipping bundle fixes');
    process.exit(0);
  }

  updatePackImports();
  replaceHoistedBarePerformanceWithShim();
  removeNestedBareModules();

  regenerateBundle(
    'Worker',
    WORKER_BUNDLE_PATH,
    pearWrkImportsFile,
    path.join(pearWrkPath, 'src', 'wdk-worklet.js'),
    BARE_ADDONS,
  );
  regenerateBundle(
    'Secret manager',
    SECRET_MANAGER_BUNDLE_PATH,
    providerImportsFile,
    path.join(providerPath, 'src', 'worklet', 'wdk-secret-manager-worklet.js'),
    ['bare-crypto'],
  );

  console.log('Bundle configuration fixes applied');
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
