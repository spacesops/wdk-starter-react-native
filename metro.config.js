const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const { configureMetroForWDK } = require('@tetherto/wdk-react-native-provider/metro-polyfills');

const config = getDefaultConfig(__dirname);

// Add watchFolders to watch the local wdk-wallet-btc package directory
// This is required for Metro to properly watch files outside the project root
config.watchFolders = [
  ...(config.watchFolders || []),
  path.resolve(__dirname, '../wdk-react-native-provider'),
  path.resolve(__dirname, '../wdk-wallet-btc'),
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
  // Ensure module paths include root node_modules
  nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  alias: {
    '@': path.resolve(__dirname, 'src'),
  },
};

// Apply WDK polyfills configuration first (handles Node.js core module polyfills)
const wdkConfig = configureMetroForWDK(config);

// Ensure watchFolders is preserved after WDK config
// This is critical for Metro to watch the local wdk-wallet-btc package
wdkConfig.watchFolders = [
  ...(wdkConfig.watchFolders || []),
  ...(config.watchFolders || []),
];

// Override node_modules resolution AFTER WDK config to use local wdk-wallet-btc package
// This ensures our override isn't overwritten by WDK's config
const appNodeModules = path.resolve(__dirname, 'node_modules');
wdkConfig.resolver.extraNodeModules = {
  ...(wdkConfig.resolver.extraNodeModules || {}),
  '@wdk/wallet-btc': path.resolve(__dirname, '../wdk-wallet-btc'),
  '@spacesops/wdk-wallet-btc': path.resolve(__dirname, '../wdk-wallet-btc'),
  react: path.resolve(appNodeModules, 'react'),
  'react-native': path.resolve(appNodeModules, 'react-native'),
  'react/jsx-runtime': path.resolve(appNodeModules, 'react/jsx-runtime'),
  'react/jsx-dev-runtime': path.resolve(appNodeModules, 'react/jsx-dev-runtime'),
};

// Now wrap the WDK's resolveRequest with our custom alias logic
const wdkResolveRequest = wdkConfig.resolver.resolveRequest;

// Modules that must always resolve to the app's single copy to avoid duplicate instance bugs
const SINGLETON_MODULES = {
  react: path.resolve(appNodeModules, 'react/index.js'),
  'react/jsx-runtime': path.resolve(appNodeModules, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': path.resolve(appNodeModules, 'react/jsx-dev-runtime.js'),
  'react-native': path.resolve(appNodeModules, 'react-native/index.js'),
};

wdkConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  // Force singleton React/RN — prevents duplicate-instance hook crashes from
  // locally-linked packages (e.g. wdk-react-native-provider) that carry their own node_modules/react
  if (Object.prototype.hasOwnProperty.call(SINGLETON_MODULES, moduleName)) {
    return { type: 'sourceFile', filePath: SINGLETON_MODULES[moduleName] };
  }

  // Handle @/ alias
  if (moduleName.startsWith('@/')) {
    const resolvedPath = moduleName.replace('@/', path.resolve(__dirname, 'src') + '/');
    try {
      return context.resolveRequest(context, resolvedPath, platform);
    } catch (e) {
      // fall through to WDK resolver
    }
  }

  // Handle local wdk-wallet-btc override for Metro bundler
  if (moduleName === '@wdk/wallet-btc' || moduleName === '@spacesops/wdk-wallet-btc') {
    const localPackagePath = path.resolve(__dirname, '../wdk-wallet-btc');
    const indexPath = path.join(localPackagePath, 'index.js');
    const fs = require('fs');
    if (fs.existsSync(indexPath)) {
      return { type: 'sourceFile', filePath: indexPath };
    }
  }

  // Delegate to WDK's resolveRequest
  return wdkResolveRequest(context, moduleName, platform);
};

module.exports = wdkConfig;
