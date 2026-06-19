#!/usr/bin/env node

/**
 * Prevents unlock from silently generating a new seed when keychain/biometric read fails.
 * Patches @tetherto/wdk-react-native-provider after install (idempotent).
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const wdkServiceIndex = path.join(
  projectRoot,
  'node_modules',
  '@tetherto',
  'wdk-react-native-provider',
  'lib',
  'module',
  'services',
  'wdk-service',
  'index.js'
);

const PATCH_MARKER = 'spaces-wallet-unlock-guard';

const RETRIEVE_SEED_OLD = `    async retrieveSeed(passkey) {
        let encryptedEntropy = null;
        let encryptedSeed = null;
        let salt = null;
        if (await WdkSecretManagerStorage.hasKey(WDK_STORAGE_ENTROPY)) {
            encryptedEntropy =
                await WdkSecretManagerStorage.retrieveData(WDK_STORAGE_ENTROPY);
        }
        if (await WdkSecretManagerStorage.hasKey(WDK_STORAGE_SEED)) {
            encryptedSeed =
                await WdkSecretManagerStorage.retrieveData(WDK_STORAGE_SEED);
        }
        if (await WdkSecretManagerStorage.hasKey(WDK_STORAGE_SALT)) {
            salt = await WdkSecretManagerStorage.retrieveData(WDK_STORAGE_SALT);
        }
        if (!encryptedSeed || !encryptedEntropy || !salt) {
            return null;
        }`;

const RETRIEVE_SEED_NEW = `    async retrieveSeed(passkey) {
        let encryptedEntropy = null;
        let encryptedSeed = null;
        let salt = null;
        const hasEntropy = await WdkSecretManagerStorage.hasKey(WDK_STORAGE_ENTROPY);
        const hasSeed = await WdkSecretManagerStorage.hasKey(WDK_STORAGE_SEED);
        const hasSalt = await WdkSecretManagerStorage.hasKey(WDK_STORAGE_SALT);
        if (hasEntropy) {
            encryptedEntropy =
                await WdkSecretManagerStorage.retrieveData(WDK_STORAGE_ENTROPY);
        }
        if (hasSeed) {
            encryptedSeed =
                await WdkSecretManagerStorage.retrieveData(WDK_STORAGE_SEED);
        }
        if (hasSalt) {
            salt = await WdkSecretManagerStorage.retrieveData(WDK_STORAGE_SALT);
        }
        if (!encryptedSeed || !encryptedEntropy || !salt) {
            if (hasEntropy || hasSeed || hasSalt) {
                throw new Error('Could not read wallet from secure storage. Authenticate with biometrics and try again.');
            }
            return null;
        }`;

const CREATE_WALLET_OLD = `        if (!seed) {
            seed = await this.createSeed(params);
        }`;

const CREATE_WALLET_NEW = `        if (!seed) {
            throw new Error('Could not load wallet seed from secure storage. Check biometrics and try again.');
        }`;

function applyPatch() {
  if (!fs.existsSync(wdkServiceIndex)) {
    console.warn('[patch-wdk-unlock-guard] WDK provider not installed; skipping.');
    return;
  }

  let source = fs.readFileSync(wdkServiceIndex, 'utf8');

  if (source.includes(PATCH_MARKER)) {
    console.log('[patch-wdk-unlock-guard] Already patched.');
    return;
  }

  if (!source.includes(RETRIEVE_SEED_OLD)) {
    if (
      source.includes('Could not read wallet from secure storage') &&
      source.includes('Could not load wallet seed from secure storage')
    ) {
      console.log('[patch-wdk-unlock-guard] Patch content present (unmarked); marking.');
      source = `/* ${PATCH_MARKER} */\n${source}`;
      fs.writeFileSync(wdkServiceIndex, source);
      return;
    }
    throw new Error(
      '[patch-wdk-unlock-guard] retrieveSeed block not found — provider version may have changed.'
    );
  }

  if (!source.includes(CREATE_WALLET_OLD)) {
    throw new Error(
      '[patch-wdk-unlock-guard] createWallet fallback not found — provider version may have changed.'
    );
  }

  source = source.replace(RETRIEVE_SEED_OLD, RETRIEVE_SEED_NEW);
  source = source.replace(CREATE_WALLET_OLD, CREATE_WALLET_NEW);
  source = `/* ${PATCH_MARKER} */\n${source}`;

  fs.writeFileSync(wdkServiceIndex, source);
  console.log('[patch-wdk-unlock-guard] Applied unlock guard patch.');
}

applyPatch();
