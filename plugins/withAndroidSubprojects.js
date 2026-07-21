const { withProjectBuildGradle } = require('@expo/config-plugins');

const PATCH_MARKER = 'spaces-wallet-android-subprojects';

const withAndroidSubprojects = (config) => {
  return withProjectBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== 'groovy') {
      return modConfig;
    }

    const subprojectsBlock = `
subprojects {
  afterEvaluate { project ->
    if (project.hasProperty('android')) {
      project.android {
        compileSdkVersion rootProject.ext.has('compileSdkVersion')
          ? rootProject.ext.compileSdkVersion
          : compileSdkVersion

        defaultConfig {
          externalNativeBuild {
            cmake {
              arguments "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON"
            }
          }
        }
      }
    }
  }
}
`;

    let contents = modConfig.modResults.contents;

    if (contents.includes(PATCH_MARKER)) {
      contents = contents.replace(
        /\/\* spaces-wallet-android-subprojects[\s\S]*?\*\/\s*subprojects \{[\s\S]*?\n\}/,
        `/* ${PATCH_MARKER} */\n${subprojectsBlock.trim()}`
      );
    } else if (!contents.includes('subprojects {')) {
      const allProjectsEndIndex = contents.indexOf(
        '}',
        contents.indexOf('allprojects {')
      );
      if (allProjectsEndIndex !== -1) {
        contents =
          contents.slice(0, allProjectsEndIndex + 1) +
          `\n\n/* ${PATCH_MARKER} */\n` +
          subprojectsBlock +
          contents.slice(allProjectsEndIndex + 1);
      } else {
        contents += `\n\n/* ${PATCH_MARKER} */\n${subprojectsBlock}\n`;
      }
    }

    modConfig.modResults.contents = contents;
    return modConfig;
  });
};

module.exports = withAndroidSubprojects;
