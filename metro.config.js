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
};

if (exists(localPearWrk)) {
  extraNodeModules['@tetherto/pear-wrk-wdk'] = resolveLocal(localPearWrk);
}
if (exists(localWalletBtc)) {
  extraNodeModules['@wdk/wallet-btc'] = resolveLocal(localWalletBtc);
  extraNodeModules['@spacesops/wdk-wallet-btc'] = resolveLocal(localWalletBtc);
}

wdkConfig.resolver.extraNodeModules = extraNodeModules;

const wdkResolveRequest = wdkConfig.resolver.resolveRequest;

const SINGLETON_MODULES = {
  react: path.resolve(appNodeModules, 'react/index.js'),
  'react/jsx-runtime': path.resolve(appNodeModules, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': path.resolve(appNodeModules, 'react/jsx-dev-runtime.js'),
  'react-native': path.resolve(appNodeModules, 'react-native/index.js'),
};

wdkConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  if (Object.prototype.hasOwnProperty.call(SINGLETON_MODULES, moduleName)) {
    return { type: 'sourceFile', filePath: SINGLETON_MODULES[moduleName] };
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
