const { getDefaultConfig } = require('expo/metro-config');
const fs = require('fs');
const path = require('path');
const { configureMetroForWDK } = require('@tetherto/wdk-react-native-provider/metro-polyfills');

const projectRoot = __dirname;
const appNodeModules = path.resolve(projectRoot, 'node_modules');

function resolveLocal(relativePath) {
  return path.resolve(projectRoot, relativePath);
}

function exists(relativePath) {
  return fs.existsSync(resolveLocal(relativePath));
}

function existingPaths(...relativePaths) {
  return relativePaths.filter(exists).map(resolveLocal);
}

const localProvider = '../wdk-react-native-provider';
const localWalletBtc = '../wdk-wallet-btc';
const localPearWrk = '../pear-wrk-wdk';

const config = getDefaultConfig(projectRoot);

// Optional local monorepo paths for development; omitted on EAS/npm installs.
config.watchFolders = [
  ...(config.watchFolders || []),
  ...existingPaths(localProvider, localWalletBtc, localPearWrk),
];

const { transformer, resolver } = config;

config.transformer = {
  ...transformer,
  babelTransformerPath: require.resolve('react-native-svg-transformer'),
};

config.resolver = {
  ...resolver,
  assetExts: resolver.assetExts.filter(ext => ext !== 'svg'),
  sourceExts: [...resolver.sourceExts, 'svg'],
  nodeModulesPaths: [
    appNodeModules,
    ...existingPaths(
      `${localProvider}/node_modules`,
      `${localPearWrk}/node_modules`,
    ),
  ],
  alias: {
    '@': path.resolve(projectRoot, 'src'),
  },
};

// Apply WDK polyfills configuration first (handles Node.js core module polyfills)
const wdkConfig = configureMetroForWDK(config);

wdkConfig.watchFolders = [
  ...(wdkConfig.watchFolders || []),
  ...(config.watchFolders || []),
];

const extraNodeModules = {
  ...(wdkConfig.resolver.extraNodeModules || {}),
  react: path.resolve(appNodeModules, 'react'),
  'react-native': path.resolve(appNodeModules, 'react-native'),
  'react/jsx-runtime': path.resolve(appNodeModules, 'react/jsx-runtime'),
  'react/jsx-dev-runtime': path.resolve(appNodeModules, 'react/jsx-dev-runtime'),
  zod: path.resolve(appNodeModules, 'zod'),
};

if (exists(localPearWrk)) {
  extraNodeModules['@tetherto/pear-wrk-wdk'] = resolveLocal(localPearWrk);
}
if (exists(localWalletBtc)) {
  extraNodeModules['@wdk/wallet-btc'] = resolveLocal(localWalletBtc);
  extraNodeModules['@spacesops/wdk-wallet-btc'] = resolveLocal(localWalletBtc);
}

wdkConfig.resolver.extraNodeModules = extraNodeModules;

// Optional: nested deps under pear-wrk-wdk (local npm layout). Omitted on EAS when hoisted.
const pearWrkNestedModules = path.join(appNodeModules, '@tetherto/pear-wrk-wdk/node_modules');
if (fs.existsSync(pearWrkNestedModules)) {
  wdkConfig.resolver.useWatchman = false;
  wdkConfig.watchFolders = [...(wdkConfig.watchFolders || []), pearWrkNestedModules];
}

const wdkResolveRequest = wdkConfig.resolver.resolveRequest;

const SINGLETON_MODULES = {
  react: path.resolve(appNodeModules, 'react/index.js'),
  'react/jsx-runtime': path.resolve(appNodeModules, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': path.resolve(appNodeModules, 'react/jsx-dev-runtime.js'),
  'react-native': path.resolve(appNodeModules, 'react-native/index.js'),
};

function findPackageRoot(originModulePath, packageName) {
  let dir = path.dirname(originModulePath);
  for (let i = 0; i < 25; i++) {
    const candidate = path.join(dir, 'node_modules', packageName);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const fallbackPaths = [
    path.join(appNodeModules, packageName),
    path.join(appNodeModules, '@tetherto/pear-wrk-wdk/node_modules', packageName),
  ];
  for (const candidate of fallbackPaths) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }

  return null;
}

function findEthersRoot(originModulePath) {
  return findPackageRoot(originModulePath, 'ethers');
}

function resolveViemCommonJs(context, moduleName) {
  if (moduleName !== 'viem' && !moduleName.startsWith('viem/')) {
    return null;
  }

  const viemRoot = findPackageRoot(context.originModulePath, 'viem');
  if (!viemRoot) {
    return null;
  }

  if (moduleName === 'viem') {
    const filePath = path.join(viemRoot, '_cjs/index.js');
    return fs.existsSync(filePath) ? { type: 'sourceFile', filePath } : null;
  }

  const subpath = moduleName.slice('viem/'.length);
  const candidates = [
    path.join(viemRoot, '_cjs', subpath, 'index.js'),
    path.join(viemRoot, '_cjs', `${subpath}.js`),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return { type: 'sourceFile', filePath };
    }
  }

  return null;
}

function resolveEthersCommonJs(context, moduleName) {
  if (moduleName !== 'ethers' && !moduleName.startsWith('ethers/')) {
    return null;
  }

  const ethersRoot = findEthersRoot(context.originModulePath);
  if (!ethersRoot) {
    return null;
  }

  if (moduleName === 'ethers') {
    const bundled = path.join(ethersRoot, 'dist', 'ethers.js');
    if (fs.existsSync(bundled)) {
      return { type: 'sourceFile', filePath: bundled };
    }
  }

  const subpath =
    moduleName === 'ethers' ? 'index.js' : `${moduleName.slice('ethers/'.length)}/index.js`;
  const filePath = path.join(ethersRoot, 'lib.commonjs', subpath);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return { type: 'sourceFile', filePath };
}

function resolveZodCommonJs(moduleName) {
  if (moduleName !== 'zod' && !moduleName.startsWith('zod/')) {
    return null;
  }

  const zodRoot = path.join(appNodeModules, 'zod');
  const rel =
    moduleName === 'zod' ? 'index.cjs' : `${moduleName.slice('zod/'.length)}/index.cjs`;
  const filePath = path.join(zodRoot, rel);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return { type: 'sourceFile', filePath };
}

wdkConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  if (Object.prototype.hasOwnProperty.call(SINGLETON_MODULES, moduleName)) {
    return { type: 'sourceFile', filePath: SINGLETON_MODULES[moduleName] };
  }

  const ethersResolution = resolveEthersCommonJs(context, moduleName);
  if (ethersResolution) {
    return ethersResolution;
  }

  const viemResolution = resolveViemCommonJs(context, moduleName);
  if (viemResolution) {
    return viemResolution;
  }

  const zodResolution = resolveZodCommonJs(moduleName);
  if (zodResolution) {
    return zodResolution;
  }

  if (moduleName.startsWith('@/')) {
    const resolvedPath = moduleName.replace('@/', path.resolve(projectRoot, 'src') + '/');
    try {
      return context.resolveRequest(context, resolvedPath, platform);
    } catch (e) {
      // fall through to WDK resolver
    }
  }

  if (
    (moduleName === '@wdk/wallet-btc' || moduleName === '@spacesops/wdk-wallet-btc') &&
    exists(localWalletBtc)
  ) {
    const indexPath = path.join(resolveLocal(localWalletBtc), 'index.js');
    if (fs.existsSync(indexPath)) {
      return { type: 'sourceFile', filePath: indexPath };
    }
  }

  return wdkResolveRequest(context, moduleName, platform);
};

module.exports = wdkConfig;
