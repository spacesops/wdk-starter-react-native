const { withPodfile } = require('@expo/config-plugins');

const PATCH_START = '## >>> spaces-wallet libveritas iOS linker fix';
const PATCH_END = '## <<< spaces-wallet libveritas iOS linker fix';

const XCFRAMEWORKS_HOOK_MARKER = 'spaces-wallet libveritas linker alias';

/**
 * @spacesops/react-native-libveritas ships liblibveritas_uniffi.a but CocoaPods
 * links -lveritas_uniffi (expects libveritas_uniffi.a). Hard-copy the alias in
 * node_modules and after each [CP] Copy XCFrameworks run so ld always finds it.
 */
function buildPatch() {
  return [
    PATCH_START,
    '  libveritas_xcframework = File.expand_path(',
    "    '../node_modules/@spacesops/react-native-libveritas/SpacesopsReactNativeLibveritasFramework.xcframework',",
    '    __dir__',
    '  )',
    "  ['ios-arm64', 'ios-arm64-simulator'].each do |slice|",
    '    slice_dir = File.join(libveritas_xcframework, slice)',
    "    src = File.join(slice_dir, 'liblibveritas_uniffi.a')",
    "    dest = File.join(slice_dir, 'libveritas_uniffi.a')",
    '    next unless File.exist?(src)',
    '',
    '    FileUtils.rm_f(dest)',
    '    FileUtils.cp(src, dest)',
    "    Pod::UI.puts '[spaces-wallet] libveritas linker alias: #{slice}/libveritas_uniffi.a'.green",
    '  end',
    '',
    '  xcframeworks_sh = File.join(',
    "    installer.sandbox.root, 'Target Support Files/ReactNativeLibveritas/ReactNativeLibveritas-xcframeworks.sh'",
    '  )',
    '  if File.exist?(xcframeworks_sh)',
    '    contents = File.read(xcframeworks_sh)',
    `    unless contents.include?('${XCFRAMEWORKS_HOOK_MARKER}')`,
    '      contents = contents.gsub(',
    '        \'copy_dir "$source/" "$destination"\',',
    '        \'copy_dir "$source/" "$destination"\' + "\\n" +',
    `        '  # ${XCFRAMEWORKS_HOOK_MARKER}' + "\\n" +`,
    '        \'  if [ -f "${destination}/liblibveritas_uniffi.a" ]; then\' + "\\n" +',
    '        \'    cp -f "${destination}/liblibveritas_uniffi.a" "${destination}/libveritas_uniffi.a"\' + "\\n" +',
    "        '  fi'",
    '      )',
    '      File.write(xcframeworks_sh, contents)',
    "      Pod::UI.puts '[spaces-wallet] patched ReactNativeLibveritas-xcframeworks.sh'.green",
    '    end',
    '  end',
    PATCH_END,
  ].join('\n');
}

module.exports = function withLibveritasIosLinkerFix(config) {
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
