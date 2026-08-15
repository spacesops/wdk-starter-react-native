const { getDefaultConfig } = require('expo/metro-config');
const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;
const appNodeModules = path.resolve(projectRoot, 'node_modules');
const localWalletBtc = path.resolve(projectRoot, '../wdk-wallet-btc');
const localWdkCore = path.resolve(projectRoot, '../wdk-react-native-core');

/**
 * Node core-module polyfills previously provided by
 * @spacesops/wdk-react-native-provider/metro-polyfills (not shipped by wdk-react-native-core).
 */
function getMetroPolyfills() {
  return {
    stream: require.resolve('stream-browserify'),
    buffer: require.resolve('@craftzdog/react-native-buffer'),
    crypto: require.resolve('react-native-crypto'),
    net: require.resolve('react-native-tcp-socket'),
    tls: require.resolve('react-native-tcp-socket'),
    url: require.resolve('react-native-url-polyfill'),
    http: require.resolve('stream-http'),
    https: require.resolve('https-browserify'),
    http2: require.resolve('http2-wrapper'),
    zlib: require.resolve('browserify-zlib'),
    path: require.resolve('path-browserify'),
    querystring: require.resolve('querystring-es3'),
    events: require.resolve('events'),
    'nice-grpc': require.resolve('nice-grpc-web'),
    'sodium-universal': require.resolve('sodium-javascript'),
  };
}

const config = getDefaultConfig(projectRoot);

const { transformer, resolver } = config;
const existingResolveRequest = resolver.resolveRequest;

config.transformer = {
  ...transformer,
  babelTransformerPath: require.resolve('react-native-svg-transformer'),
};

config.resolver = {
  ...resolver,
  assetExts: resolver.assetExts.filter((ext) => ext !== 'svg'),
  sourceExts: [...resolver.sourceExts, 'svg'],
  extraNodeModules: {
    ...(resolver.extraNodeModules || {}),
    ...getMetroPolyfills(),
    react: path.resolve(appNodeModules, 'react'),
    'react-native': path.resolve(appNodeModules, 'react-native'),
  },
  resolveRequest: (context, moduleName, platform) => {
    if (moduleName === 'stream') {
      return {
        filePath: require.resolve('stream-browserify'),
        type: 'sourceFile',
      };
    }
    if (moduleName === 'url') {
      return {
        filePath: require.resolve('react-native-url-polyfill'),
        type: 'sourceFile',
      };
    }
    if (existingResolveRequest) {
      return existingResolveRequest(context, moduleName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
  },
};

if (fs.existsSync(localWdkCore)) {
  config.watchFolders = [...(config.watchFolders || []), localWdkCore];
  config.resolver.extraNodeModules = {
    ...config.resolver.extraNodeModules,
    '@spacesops/wdk-react-native-core': localWdkCore,
  };
}

if (fs.existsSync(localWalletBtc)) {
  config.watchFolders = [...(config.watchFolders || []), localWalletBtc];
  config.resolver.extraNodeModules = {
    ...config.resolver.extraNodeModules,
    '@wdk/wallet-btc': localWalletBtc,
    '@spacesops/wdk-wallet-btc': localWalletBtc,
  };
}

module.exports = config;
