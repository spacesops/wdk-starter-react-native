import AsyncStorage from '@react-native-async-storage/async-storage';
import * as bip39 from 'bip39';
import {
  getAvatar,
  getWalletName,
  setAvatar,
  setWalletName,
} from '@/config/avatar-options';
import { TWELVE_WORD_COUNT } from '@/utils/parse-twelve-word-mnemonic';

export const KEYSTORE_BACKUP_VERSION = 1 as const;

const MY_SPACES_KEY = 'mySpaces';

export type SpacesKeystoreBackup = {
  version: typeof KEYSTORE_BACKUP_VERSION;
  createdAt: string;
  mnemonic: string;
  walletName: string;
  avatarId: number;
  spaces?: {
    mySpaces?: unknown;
  };
};

export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 0)
    .join(' ');
}

export function mnemonicsMatch(a: string, b: string): boolean {
  return normalizeMnemonic(a) === normalizeMnemonic(b);
}

function isTwelveWordBip39Mnemonic(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normalized = normalizeMnemonic(value);
  const words = normalized.split(' ');
  if (words.length !== TWELVE_WORD_COUNT) return false;
  return bip39.validateMnemonic(normalized);
}

export function isSpacesKeystoreBackup(obj: unknown): obj is SpacesKeystoreBackup {
  if (!obj || typeof obj !== 'object') return false;
  const candidate = obj as Record<string, unknown>;
  if (candidate.version !== KEYSTORE_BACKUP_VERSION) return false;
  if (typeof candidate.createdAt !== 'string' || !candidate.createdAt) return false;
  if (!isTwelveWordBip39Mnemonic(candidate.mnemonic)) return false;
  if (typeof candidate.walletName !== 'string') return false;
  if (typeof candidate.avatarId !== 'number' || !Number.isFinite(candidate.avatarId)) {
    return false;
  }
  if (candidate.spaces !== undefined) {
    if (!candidate.spaces || typeof candidate.spaces !== 'object') return false;
  }
  return true;
}

/**
 * Build a plaintext keystore backup from the unlocked mnemonic and local app metadata.
 * Certificates are omitted — they can be downloaded again after restore.
 */
export async function buildKeystoreBackup(mnemonic: string): Promise<SpacesKeystoreBackup> {
  const normalized = normalizeMnemonic(mnemonic);
  if (!bip39.validateMnemonic(normalized)) {
    throw new Error('Invalid mnemonic');
  }

  const [walletName, avatar, mySpacesRaw] = await Promise.all([
    getWalletName(),
    getAvatar(),
    AsyncStorage.getItem(MY_SPACES_KEY),
  ]);

  let mySpaces: unknown;
  if (mySpacesRaw) {
    try {
      mySpaces = JSON.parse(mySpacesRaw);
    } catch {
      mySpaces = undefined;
    }
  }

  return {
    version: KEYSTORE_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    mnemonic: normalized,
    walletName,
    avatarId: avatar.id,
    ...(mySpaces !== undefined ? { spaces: { mySpaces } } : {}),
  };
}

/**
 * Restore non-secret metadata from a validated backup after wallet init.
 * Certificates in older backups are ignored.
 */
export async function applyKeystoreMetadata(backup: SpacesKeystoreBackup): Promise<void> {
  await setWalletName(backup.walletName || 'My Wallet');
  await setAvatar(backup.avatarId || 1);

  if (backup.spaces?.mySpaces !== undefined) {
    await AsyncStorage.setItem(MY_SPACES_KEY, JSON.stringify(backup.spaces.mySpaces));
  }
}

export function keystoreBackupFileName(createdAt = new Date()): string {
  return `spaces_keystore_${createdAt.getTime()}.json`;
}
