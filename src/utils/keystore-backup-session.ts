import type { SpacesKeystoreBackup } from '@/services/keystore-backup';

/** In-memory backup between import-keystore and confirm (avoids large URL params). */
let pendingBackup: SpacesKeystoreBackup | null = null;

export function setPendingKeystoreBackup(backup: SpacesKeystoreBackup): void {
  pendingBackup = backup;
}

export function consumePendingKeystoreBackup(): SpacesKeystoreBackup | null {
  const backup = pendingBackup;
  pendingBackup = null;
  return backup;
}

export function peekPendingKeystoreBackup(): SpacesKeystoreBackup | null {
  return pendingBackup;
}

export function clearPendingKeystoreBackup(): void {
  pendingBackup = null;
}
