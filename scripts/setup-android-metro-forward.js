#!/usr/bin/env node

/**
 * USB-connected Android devices often cannot reach the Mac's LAN IP (8081).
 * Forward Metro through adb so the dev client can use http://127.0.0.1:8081.
 */

const { execFileSync } = require('child_process');

function main() {
  let devicesOutput;
  try {
    devicesOutput = execFileSync('adb', ['devices'], { encoding: 'utf8' });
  } catch (error) {
    console.warn('[setup-android-metro-forward] adb not available; skipping reverse');
    return;
  }

  const devices = devicesOutput
    .split('\n')
    .filter((line) => line.includes('\tdevice'))
    .map((line) => line.split('\t')[0])
    .filter(Boolean);

  if (devices.length === 0) {
    console.log('[setup-android-metro-forward] no adb device; skipping reverse');
    return;
  }

  for (const device of devices) {
    try {
      execFileSync('adb', ['-s', device, 'reverse', 'tcp:8081', 'tcp:8081'], {
        stdio: 'inherit',
      });
      console.log(`[setup-android-metro-forward] adb reverse tcp:8081 tcp:8081 (${device})`);
    } catch (error) {
      console.warn(
        `[setup-android-metro-forward] adb reverse failed for ${device}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

main();
