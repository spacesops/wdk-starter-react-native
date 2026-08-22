const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = 'spaces-wallet-r8-dontwarn';

const EXTRA_RULES = `
# ${MARKER} — Guava j2objc annotations + JNA desktop stubs (not on Android)
-dontwarn com.google.j2objc.annotations.**
-dontwarn java.awt.**
`;

/** Append R8 dontwarn rules required for release minify with bare-kit / Guava deps. */
const withAndroidProguardRules = (config) =>
  withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const proguardPath = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app',
        'proguard-rules.pro'
      );
      if (!fs.existsSync(proguardPath)) {
        return modConfig;
      }

      let contents = fs.readFileSync(proguardPath, 'utf8');
      if (contents.includes(MARKER)) {
        contents = contents.replace(
          new RegExp(`# ${MARKER}[\\s\\S]*?(?=\\n# |\\n*$)`, 'm'),
          EXTRA_RULES.trim()
        );
      } else {
        contents += `\n${EXTRA_RULES}\n`;
      }

      fs.writeFileSync(proguardPath, contents, 'utf8');
      return modConfig;
    },
  ]);

module.exports = withAndroidProguardRules;
