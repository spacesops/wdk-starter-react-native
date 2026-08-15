/**
 * Runtime polyfills for React Native / Hermes.
 * Mirrors the old @spacesops/wdk-react-native-provider polyfills that core no longer ships.
 * Must load before bip39 / crypto helpers.
 */
import { Buffer } from '@craftzdog/react-native-buffer';
import 'react-native-get-random-values';

const g = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  process?: NodeJS.Process;
  crypto?: unknown;
};

if (g.Buffer == null) {
  g.Buffer = Buffer;
}

if (g.process == null) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  g.process = require('process');
}

if (g.crypto == null) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    g.crypto = require('react-native-crypto');
  } catch (e) {
    console.warn('Failed to load crypto polyfill:', e);
  }
}
