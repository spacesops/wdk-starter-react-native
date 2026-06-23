export const TWELVE_WORD_COUNT = 12;

/** Parse QR/clipboard text into exactly 12 lowercase BIP39-style words, or null if invalid. */
export function parseTwelveWordMnemonic(raw: string): string[] | null {
  const words = raw
    .trim()
    .split(/\s+/)
    .map(word => word.toLowerCase().trim())
    .filter(word => word.length > 0);

  if (words.length !== TWELVE_WORD_COUNT) {
    return null;
  }

  const validWords = words.every(
    word => word.length >= 3 && /^[a-z]+$/.test(word)
  );

  return validWords ? words : null;
}
