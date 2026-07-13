import { bech32 } from 'bech32';

function hexToBytes(hex: string): Uint8Array | null {
  const h = hex.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(h) || h.length % 2 !== 0) {
    return null;
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** NIP-19 bech32 encode (npub / nsec) from a 32-byte secp256k1 key hex string. */
function encodeNip19(prefix: 'npub' | 'nsec', keyHex: string): string | null {
  const keyBytes = hexToBytes(keyHex);
  if (!keyBytes || keyBytes.length !== 32) {
    return null;
  }
  const data = new Uint8Array(1 + keyBytes.length);
  data[0] = 0;
  data.set(keyBytes, 1);
  return bech32.encode(prefix, bech32.toWords(data));
}

export function encodeNpubFromPubKeyHex(pubKeyHex: string | undefined): string | null {
  if (!pubKeyHex?.trim()) return null;
  return encodeNip19('npub', pubKeyHex);
}

export function encodeNsecFromPrivKeyHex(privKeyHex: string | undefined): string | null {
  if (!privKeyHex?.trim()) return null;
  return encodeNip19('nsec', privKeyHex);
}
