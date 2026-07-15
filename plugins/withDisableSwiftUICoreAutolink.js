const { withPodfile } = require('@expo/config-plugins');

const PATCH_START = '## >>> spaces-wallet disable SwiftUICore autolink';
const PATCH_END = '## <<< spaces-wallet disable SwiftUICore autolink';

/**
 * iOS 26 / Xcode 26 split SwiftUI into SwiftUI + private SwiftUICore.
 * Expo SwiftUI-based modules autolink SwiftUICore into the app binary, which
 * the linker rejects: "cannot link directly with SwiftUICore".
 *
 * @see https://github.com/streamyfin/streamyfin/pull/1613
 */
function buildPatch() {
  return [
    PATCH_START,
    "  # iOS 26: drop SwiftUICore autolink on pods; symbols resolve via SwiftUI.",
    "  if ENV['EXPO_TV'] != '1'",
    "    installer.pods_project.targets.each do |t|",
    "      t.build_configurations.each do |cfg|",
    "        cfg.build_settings['OTHER_SWIFT_FLAGS'] ||= '$(inherited)'",
    "        flags = cfg.build_settings['OTHER_SWIFT_FLAGS']",
    "        flags = flags.join(' ') if flags.is_a?(Array)",
    "        unless flags.include?('-disable-autolink-framework -Xfrontend SwiftUICore')",
    "          cfg.build_settings['OTHER_SWIFT_FLAGS'] = flags + ' -Xfrontend -disable-autolink-framework -Xfrontend SwiftUICore'",
    "        end",
    "      end",
    "    end",
    "  end",
    '',
    "  # iOS 26: ExpoModulesProvider.swift is compiled in the app target too.",
    "  if ENV['EXPO_TV'] != '1'",
    "    installer.aggregate_targets.each do |agg|",
    "      next unless agg.user_project",
    "      agg.user_project.native_targets.each do |target|",
    "        target.build_configurations.each do |cfg|",
    "          existing = cfg.build_settings['OTHER_SWIFT_FLAGS'] || '$(inherited)'",
    "          existing = existing.join(' ') if existing.is_a?(Array)",
    "          unless existing.include?('-disable-autolink-framework -Xfrontend SwiftUICore')",
    "            cfg.build_settings['OTHER_SWIFT_FLAGS'] = existing + ' -Xfrontend -disable-autolink-framework -Xfrontend SwiftUICore'",
    "          end",
    "        end",
    "      end",
    "      agg.user_project.save",
    "    end",
    "  end",
    PATCH_END,
  ].join("\n");
}

module.exports = function withDisableSwiftUICoreAutolink(config) {
  return withPodfile(config, (modConfig) => {
    let podfile = modConfig.modResults.contents;
    const patch = buildPatch();

    if (!/^\s*post_install\s+do\s+\|installer\|/m.test(podfile)) {
      podfile += `

post_install do |installer|
end
`;
    }

    if (podfile.includes(PATCH_START)) {
      podfile = podfile.replace(
        new RegExp(`${PATCH_START}[\\s\\S]*?${PATCH_END}`),
        patch
      );
    } else {
      podfile = podfile.replace(
        /^\s*post_install\s+do\s+\|installer\|.*$/m,
        (match) => `${match}\n\n${patch}`
      );
    }

    modConfig.modResults.contents = podfile;
    return modConfig;
  });
};
