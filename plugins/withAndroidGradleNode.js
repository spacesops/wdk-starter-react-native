const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = 'spaces-wallet-node-executable';

/** Same logic as scripts/patch-android-settings-node.js, applied at prebuild time. */
const withAndroidGradleNode = (config) =>
  withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const settingsPath = path.join(modConfig.modRequest.platformProjectRoot, 'settings.gradle');
      if (!fs.existsSync(settingsPath)) {
        return modConfig;
      }

      const nodeExecutable = process.execPath;
      let contents = fs.readFileSync(settingsPath, 'utf8');
      const preamble = `  // ${MARKER}
  def spacesWalletNodeExecutable = ${JSON.stringify(nodeExecutable)}
`;

      if (contents.includes(MARKER)) {
        contents = contents.replace(
          /def spacesWalletNodeExecutable = ".*?"/,
          `def spacesWalletNodeExecutable = ${JSON.stringify(nodeExecutable)}`
        );
      } else {
        contents = contents.replace('pluginManagement {', `pluginManagement {\n${preamble}`);
      }

      contents = contents.replace(/commandLine\("node",/g, 'commandLine(spacesWalletNodeExecutable,');
      fs.writeFileSync(settingsPath, contents, 'utf8');
      return modConfig;
    },
  ]);

module.exports = withAndroidGradleNode;
