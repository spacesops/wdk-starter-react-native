/**
 * BIP-86 P2TR derivation in JS (no Bare worklet, no Node crypto).
 * Path: m/86'/{coinType}'/{account}'/0/{index}
 */

import * as ecc from '@bitcoinerlab/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { mnemonicToSeedSync } from 'bip39';
import { scriptPubKeyHexToTaprootAddress } from '@/utils/taproot-address-to-spk';

const HARDENED = 0x80000000;
const SEED_KEY = new TextEncoder().encode('Bitcoin seed');

export type DerivedBip86Taproot = {
  fullPath: string;
  relativePath: string;
  address: string;
  scriptPubKeyHex: string;
  internalPubKeyHex: string;
  privateKeyHex: string;
  tweakedPrivateKeyHex: string;
};

function toBytes(value: Uint8Array | ArrayBuffer | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha512, key, data);
}

function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  const payload = new Uint8Array(tagHash.length * 2 + msg.length);
  payload.set(tagHash, 0);
  payload.set(tagHash, tagHash.length);
  payload.set(msg, tagHash.length * 2);
  return sha256(payload);
}

function ser32(index: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (index >>> 24) & 0xff;
  out[1] = (index >>> 16) & 0xff;
  out[2] = (index >>> 8) & 0xff;
  out[3] = index & 0xff;
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

type HdNode = { key: Uint8Array; chain: Uint8Array };

function masterFromSeed(seed: Uint8Array): HdNode {
  const I = hmacSha512(SEED_KEY, seed);
  return { key: I.slice(0, 32), chain: I.slice(32) };
}

function deriveChild(node: HdNode, index: number): HdNode {
  let data: Uint8Array;
  if (index >= HARDENED) {
    data = concatBytes(new Uint8Array([0]), node.key, ser32(index));
  } else {
    const pub = ecc.pointFromScalar(node.key, true);
    if (!pub) {
      throw new Error('BIP32: invalid parent private key');
    }
    data = concatBytes(pub, ser32(index));
  }
  const I = hmacSha512(node.chain, data);
  const IL = I.slice(0, 32);
  const IR = I.slice(32);
  const childKey = ecc.privateAdd(node.key, IL);
  if (!childKey) {
    throw new Error(`BIP32: invalid child key at index ${index}`);
  }
  return { key: childKey, chain: IR };
}

function derivePath(node: HdNode, indices: number[]): HdNode {
  let current = node;
  for (const index of indices) {
    current = deriveChild(current, index);
  }
  return current;
}

export type Bip86ReceiveDeriver = (index: number) => DerivedBip86Taproot;

/**
 * Runs the expensive steps (PBKDF2 seed + hardened path to `m/86'/coin'/account'/0`) once,
 * and returns a function that derives each receive index with a single child step.
 */
export function createBip86ReceiveDeriver(params: {
  mnemonic: string;
  account: number;
  coinType?: number;
  network?: string;
}): Bip86ReceiveDeriver {
  const coinType = params.coinType ?? 0;
  const { account, network } = params;
  if (!Number.isInteger(account) || account < 0) {
    throw new Error('BIP-86 account must be a non-negative integer');
  }

  const seed = toBytes(mnemonicToSeedSync(params.mnemonic.trim()));
  const receiveChain = derivePath(masterFromSeed(seed), [
    HARDENED + 86,
    HARDENED + coinType,
    HARDENED + account,
    0,
  ]);

  return (index: number) => {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('BIP-86 index must be a non-negative integer');
    }
    const privateKey = deriveChild(receiveChain, index).key;
    return taprootFromPrivateKey({ privateKey, account, index, coinType, network });
  };
}

/**
 * Derive a BIP-86 receive address and Taproot key material from a mnemonic.
 * When deriving several indices, use `createBip86ReceiveDeriver` instead.
 */
export function deriveBip86TaprootFromMnemonic(params: {
  mnemonic: string;
  account: number;
  index: number;
  coinType?: number;
  network?: string;
}): DerivedBip86Taproot {
  return createBip86ReceiveDeriver(params)(params.index);
}

function taprootFromPrivateKey(params: {
  privateKey: Uint8Array;
  account: number;
  index: number;
  coinType: number;
  network?: string;
}): DerivedBip86Taproot {
  const { privateKey, account, index, coinType } = params;
  const compressed = ecc.pointFromScalar(privateKey, true);
  if (!compressed || compressed.length !== 33) {
    throw new Error('Failed to derive secp256k1 public key');
  }
  const internalPubKey = compressed.slice(1);
  const tapTweak = taggedHash('TapTweak', internalPubKey);
  const tweaked = ecc.xOnlyPointAddTweak(internalPubKey, tapTweak);
  if (!tweaked) {
    throw new Error('Failed to apply Taproot tweak');
  }

  let evenPriv = privateKey;
  if ((compressed[0]! & 1) === 1) {
    evenPriv = ecc.privateNegate(privateKey);
  }
  let tweakedPriv = ecc.privateAdd(evenPriv, tapTweak);
  if (!tweakedPriv) {
    throw new Error('Failed to tweak Taproot private key');
  }
  if (tweaked.parity === 1) {
    tweakedPriv = ecc.privateNegate(tweakedPriv);
  }

  const scriptPubKeyHex = `5120${hex(tweaked.xOnlyPubkey)}`;
  const address = scriptPubKeyHexToTaprootAddress(scriptPubKeyHex, params.network);
  if (!address) {
    throw new Error('Failed to encode Taproot address');
  }

  const relativePath = `${account}'/0/${index}`;
  return {
    fullPath: `m/86'/${coinType}'/${relativePath}`,
    relativePath,
    address,
    scriptPubKeyHex,
    internalPubKeyHex: hex(internalPubKey),
    privateKeyHex: hex(privateKey),
    tweakedPrivateKeyHex: hex(tweakedPriv),
  };
}
