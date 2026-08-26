/** Convert a P2TR (bc1p / tb1p) address to a Taproot scriptPubKey without the worklet. */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    if (top & 1) chk ^= 0x3b6a57b2;
    if (top & 2) chk ^= 0x26508e6d;
    if (top & 4) chk ^= 0x1ea119fa;
    if (top & 8) chk ^= 0x3d4233dd;
    if (top & 16) chk ^= 0x2a1462b3;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return ret;
}

/**
 * P2TR scriptPubKey: OP_1 (0x51) + push32 (0x20) + 32-byte x-only output key.
 * Returns lowercase hex, or null if the address is not a Taproot bech32m address.
 */
export function taprootAddressToScriptPubKeyHex(address: string): string | null {
  const raw = address.trim();
  const sep = raw.lastIndexOf('1');
  if (sep < 1) return null;
  const hrp = raw.slice(0, sep).toLowerCase();
  if (hrp !== 'bc' && hrp !== 'tb' && hrp !== 'bcrt') return null;
  const dataPart = raw.slice(sep + 1).toLowerCase();
  const values: number[] = [];
  for (const ch of dataPart) {
    const idx = CHARSET.indexOf(ch);
    if (idx < 0) return null;
    values.push(idx);
  }
  if (values.length < 7) return null;
  if (polymod(hrpExpand(hrp).concat(values)) !== BECH32M_CONST) return null;

  const decoded5 = values.slice(0, -6);
  const version = decoded5[0];
  const program = convertBits(decoded5.slice(1), 5, 8, false);
  if (version !== 1 || !program || program.length !== 32) return null;

  const programHex = program.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `5120${programHex}`;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ BECH32M_CONST;
  const ret: number[] = [];
  for (let i = 0; i < 6; i++) {
    ret.push((mod >> (5 * (5 - i))) & 31);
  }
  return ret;
}

export function taprootHrpForBitcoinNetwork(network?: string): 'bc' | 'tb' {
  const n = (network ?? 'bitcoin').toLowerCase();
  if (n === 'testnet' || n === 'regtest' || n === 'signet') return 'tb';
  return 'bc';
}

/**
 * Inverse of taprootAddressToScriptPubKeyHex. P2TR scriptPubKey → bech32m address.
 */
export function scriptPubKeyHexToTaprootAddress(
  scriptPubKeyHex: string,
  network?: string
): string | null {
  const h = scriptPubKeyHex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^5120[0-9a-f]{64}$/.test(h)) return null;
  const program: number[] = [];
  for (let i = 4; i < h.length; i += 2) {
    program.push(Number.parseInt(h.slice(i, i + 2), 16));
  }
  if (program.length !== 32) return null;
  const converted = convertBits(program, 8, 5, true);
  if (!converted) return null;
  const data = [1, ...converted];
  const hrp = taprootHrpForBitcoinNetwork(network);
  const combined = data.concat(createChecksum(hrp, data));
  return `${hrp}1${combined.map((v) => CHARSET[v]).join('')}`;
}
