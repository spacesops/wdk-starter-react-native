/** In-memory mnemonic between import-wallet and import-name-wallet (avoids long URL params). */
let pendingMnemonic: string | null = null;

export function setPendingImportMnemonic(mnemonic: string): void {
  pendingMnemonic = mnemonic;
}

export function consumePendingImportMnemonic(): string | null {
  const mnemonic = pendingMnemonic;
  pendingMnemonic = null;
  return mnemonic;
}

export function clearPendingImportMnemonic(): void {
  pendingMnemonic = null;
}
