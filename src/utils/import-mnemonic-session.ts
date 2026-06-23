/** In-memory mnemonic between import-wallet and import-name-wallet (avoids long URL params). */
let pendingMnemonic: string | null = null;

/** Words returned from QR scan on import-wallet (never passed via route params). */
let scannedImportWords: string[] | null = null;

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

export function setScannedImportWords(words: string[]): void {
  scannedImportWords = words;
}

export function consumeScannedImportWords(): string[] | null {
  const words = scannedImportWords;
  scannedImportWords = null;
  return words;
}
