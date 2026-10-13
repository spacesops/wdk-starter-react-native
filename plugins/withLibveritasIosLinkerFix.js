const { withPodfile } = require('@expo/config-plugins');

const PATCH_START = '## >>> spaces-wallet libveritas iOS linker fix';
const PATCH_END = '## <<< spaces-wallet libveritas iOS linker fix';

const XCFRAMEWORKS_HOOK_MARKER = 'spaces-wallet libveritas linker alias';

/**
 * @spacesprotocol/react-native-libveritas ships liblibveritas_uniffi.a but CocoaPods
 * links -lveritas_uniffi (expects libveritas_uniffi.a). Hard-copy the alias in
 * node_modules and after each [CP] Copy XCFrameworks run so ld always finds it.
 */
function buildPatch() {
  return [
    PATCH_START,
    '  libveritas_xcframework = File.expand_path(',
    "    '../node_modules/@spacesprotocol/react-native-libveritas/SpacesprotocolReactNativeLibveritasFramework.xcframework',",
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
    '    Pod::UI.puts "[spaces-wallet] libveritas linker alias: #{slice}/libveritas_uniffi.a".green',
    '  end',
    '',
    "  libveritas_device_lib = File.join(libveritas_xcframework, 'ios-arm64')",
    "  libveritas_sim_lib = File.join(libveritas_xcframework, 'ios-arm64-simulator')",
    '',
    '  installer.aggregate_targets.each do |agg|',
    '    next unless agg.user_project',
    '',
    '    agg.user_project.native_targets.each do |target|',
    '      target.build_configurations.each do |cfg|',
    "        device_paths = cfg.build_settings['LIBRARY_SEARCH_PATHS[sdk=iphoneos*]'] || '$(inherited)'",
    '        device_paths = [device_paths] unless device_paths.is_a?(Array)',
    '        device_paths << libveritas_device_lib unless device_paths.include?(libveritas_device_lib)',
    "        cfg.build_settings['LIBRARY_SEARCH_PATHS[sdk=iphoneos*]'] = device_paths",
    '',
    "        sim_paths = cfg.build_settings['LIBRARY_SEARCH_PATHS[sdk=iphonesimulator*]'] || '$(inherited)'",
    '        sim_paths = [sim_paths] unless sim_paths.is_a?(Array)',
    '        sim_paths << libveritas_sim_lib unless sim_paths.include?(libveritas_sim_lib)',
    "        cfg.build_settings['LIBRARY_SEARCH_PATHS[sdk=iphonesimulator*]'] = sim_paths",
    '      end',
    '    end',
    '    agg.user_project.save',
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
    '',
    '  excluded_sim_archs = \'i386 x86_64\'',
    '  installer.pods_project.targets.each do |target|',
    '    target.build_configurations.each do |config|',
    '      config.build_settings[\'EXCLUDED_ARCHS[sdk=iphonesimulator*]\'] = excluded_sim_archs',
    '    end',
    '  end',
    '  installer.aggregate_targets.each do |agg|',
    '    next unless agg.user_project',
    '    agg.user_project.native_targets.each do |target|',
    '      target.build_configurations.each do |config|',
    '        config.build_settings[\'EXCLUDED_ARCHS[sdk=iphonesimulator*]\'] = excluded_sim_archs',
    '      end',
    '    end',
    '    agg.user_project.save',
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
