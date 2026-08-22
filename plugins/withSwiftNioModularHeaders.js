const { withPodfile } = require('@expo/config-plugins');

const MARKER = 'spaces-wallet-swiftnio-modular-headers';

/**
 * gRPC-Swift / SwiftNIO C targets (CNIO*) need module maps when linked statically.
 * Must be set before pod resolution — post_install is too late.
 */
module.exports = function withSwiftNioModularHeaders(config) {
  return withPodfile(config, (modConfig) => {
    let podfile = modConfig.modResults.contents;
    const injection = `  use_modular_headers!  # ${MARKER}`;

    if (podfile.includes(MARKER)) {
      podfile = podfile.replace(
        new RegExp(`\\s*use_modular_headers!\\s*# ${MARKER}`),
        `\n${injection}`
      );
    } else {
      podfile = podfile.replace(
        /(^\s*use_expo_modules!\s*$)/m,
        `$1\n\n${injection}`
      );
    }

    // Remove legacy post_install DEFINES_MODULE block if present from an earlier attempt.
    podfile = podfile.replace(
      /\n## >>> spaces-wallet SwiftNIO modular headers[\s\S]*?## <<< spaces-wallet SwiftNIO modular headers\n?/,
      '\n'
    );

    modConfig.modResults.contents = podfile;
    return modConfig;
  });
};
