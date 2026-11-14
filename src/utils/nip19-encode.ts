import * as ecc from '@bitcoinerlab/secp256k1';
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

/**
 * Bech32 encode (npub / nsec) from a 32-byte secp256k1 key hex string.
 * Matches `spaces` wallet / `space-cli getnsec` (raw 32-byte payload, no NIP-19 type byte).
 */
function encodeNip19(prefix: 'npub' | 'nsec', keyHex: string): string | null {
  const keyBytes = hexToBytes(keyHex);
  if (!keyBytes || keyBytes.length !== 32) {
    return null;
  }
  return bech32.encode(prefix, bech32.toWords(keyBytes));
}

export function encodeNpubFromPubKeyHex(pubKeyHex: string | undefined): string | null {
  if (!pubKeyHex?.trim()) return null;
  return encodeNip19('npub', pubKeyHex);
}

export function encodeNsecFromPrivKeyHex(privKeyHex: string | undefined): string | null {
  if (!privKeyHex?.trim()) return null;
  return encodeNip19('nsec', privKeyHex);
}

/** X-only secp256k1 pubkey hex (32 bytes) for NIP-19 npub, from a 32-byte secret key. */
export function xOnlyPubKeyHexFromPrivKeyHex(privKeyHex: string | undefined): string | null {
  const priv = hexToBytes(privKeyHex ?? '');
  if (!priv || priv.length !== 32) return null;
  const compressed = ecc.pointFromScalar(priv, true);
  if (!compressed || compressed.length !== 33) return null;
  const xOnly = compressed.subarray(1, 33);
  return Array.from(xOnly, (b) => b.toString(16).padStart(2, '0')).join('');
}
