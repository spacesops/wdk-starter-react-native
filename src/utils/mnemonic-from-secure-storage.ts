/**
 * Recover the BIP-39 mnemonic from secure storage without the Bare worklet.
 * `getMnemonic()` uses getMnemonicFromEntropy on the worklet, which hangs during
 * free-coupon checkout the same way getAccountByPath does.
 */

import { gcm } from '@noble/ciphers/aes';
import { WalletSetupService } from '@spacesops/wdk-react-native-core';
import { entropyToMnemonic } from 'bip39';

function bytesFromBase64(value: string): Uint8Array {
  const buf = Buffer.from(value, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** pear-wrk-wdk encrypt(): 12-byte IV + ciphertext + 16-byte GCM tag, all base64. */
export function decryptPearAesGcm(encryptedBase64: string, keyBase64: string): Uint8Array {
  const blob = bytesFromBase64(encryptedBase64);
  const key = bytesFromBase64(keyBase64);
  if (key.length !== 32) {
    throw new Error('Encryption key must be 32 bytes');
  }
  if (blob.length < 12 + 16) {
    throw new Error('Encrypted payload is too short');
  }
  const nonce = blob.subarray(0, 12);
  const ciphertextAndTag = blob.subarray(12);
  return gcm(key, nonce).decrypt(ciphertextAndTag);
}

export async function getMnemonicWithoutWorklet(walletId?: string): Promise<string | null> {
  const encryptedEntropy = await WalletSetupService.getEncryptedEntropy(walletId);
  const encryptionKey = await WalletSetupService.getEncryptionKey(walletId);
  if (!encryptedEntropy || !encryptionKey) {
    return null;
  }
  const entropy = decryptPearAesGcm(encryptedEntropy, encryptionKey);
  return entropyToMnemonic(hex(entropy));
}
