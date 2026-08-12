/**
 * Resolved install path for @spacesprotocol/react-native-libveritas.
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_NAME = '@spacesprotocol/react-native-libveritas';
const XCFRAMEWORK_NAME = 'SpacesprotocolReactNativeLibveritasFramework.xcframework';

const projectRoot = path.join(__dirname, '..');
const packageRoot = path.join(
  projectRoot,
  'node_modules',
  '@spacesprotocol',
  'react-native-libveritas'
);

function libveritasAndroidBuildGradleRelative() {
  return path.join('node_modules', '@spacesprotocol', 'react-native-libveritas', 'android', 'build.gradle');
}

function isLibveritasInstalled() {
  return fs.existsSync(path.join(packageRoot, 'package.json'));
}

module.exports = {
  PACKAGE_NAME,
  XCFRAMEWORK_NAME,
  projectRoot,
  packageRoot,
  libveritasAndroidBuildGradleRelative,
  isLibveritasInstalled,
};
