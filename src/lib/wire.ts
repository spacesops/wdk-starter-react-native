/**
 * Spaces wire record encoding (SEQ / TXT / BLOB).
 * Ported from spaces-hex-tool; base64 helpers are RN-safe (no global btoa/atob).
 */

const TYPE_SEQ = 0x00;
const TYPE_TXT = 0x01;
const TYPE_BLOB = 0x02;
const TYPE_ADDR = 0x03;
/** SIP-7 signature record — internal; stripped in the hex tool UI. */
export const TYPE_SIG = 0x04;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Encode(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < len ? bytes[i + 1]! : 0;
    const c = i + 2 < len ? bytes[i + 2]! : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64[(triple >> 18) & 63];
    out += B64[(triple >> 12) & 63];
    out += i + 1 < len ? B64[(triple >> 6) & 63] : '=';
    out += i + 2 < len ? B64[triple & 63] : '=';
  }
  return out;
}

function base64Decode(str: string): Uint8Array {
  const clean = str.replace(/\s/g, '');
  if (clean.length % 4 !== 0) {
    throw new Error('invalid base64 length');
  }
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c1 = B64.indexOf(clean[i]!);
    const c2 = B64.indexOf(clean[i + 1]!);
    const c3 = clean[i + 2] === '=' ? -1 : B64.indexOf(clean[i + 2]!);
    const c4 = clean[i + 3] === '=' ? -1 : B64.indexOf(clean[i + 3]!);
    if (c1 < 0 || c2 < 0 || c3 < -1 || c4 < -1) {
      throw new Error('invalid base64 character');
    }
    const bitmap =
      (c1 << 18) | (c2 << 12) | (c3 >= 0 ? c3 << 6 : 0) | (c4 >= 0 ? c4 : 0);
    bytes.push((bitmap >> 16) & 255);
    if (clean[i + 2] !== '=') bytes.push((bitmap >> 8) & 255);
    if (clean[i + 3] !== '=') bytes.push(bitmap & 255);
  }
  return new Uint8Array(bytes);
}

export type RecordType = 'seq' | 'txt' | 'blob' | 'addr' | 'sig' | 'unknown';

export type RecordRow = {
  id: string;
  recordType: RecordType;
  version?: number;
  key?: string;
  value?: string;
  rtype?: number;
  rdata?: string;
};

export const RECOMMENDED_KEYS: Record<string, { label: string; placeholder: string; category: string }> = {
  space: { label: 'Top Level Space', placeholder: '@space', category: 'Spaces Protocol' },
  handle: { label: 'Subspace Handle', placeholder: 'user@space', category: 'Spaces Protocol' },
  btc: { label: 'Bitcoin Address', placeholder: 'bc1q...', category: 'Payment Addresses' },
  eth: { label: 'Ethereum Address', placeholder: '0x...', category: 'Payment Addresses' },
  ln: { label: 'Lightning (BOLT 12)', placeholder: 'lno1...', category: 'Payment Addresses' },
  nostr: { label: 'Nostr Pubkey', placeholder: 'npub1...', category: 'Identity & Keys' },
  tor: { label: 'Tor Onion', placeholder: 'pg6mm...d.onion', category: 'Identity & Keys' },
  ssh: { label: 'SSH Key', placeholder: 'ssh-ed25519 AAAA...', category: 'Identity & Keys' },
  pgp: { label: 'PGP Fingerprint', placeholder: '3e7ba00a1b47...', category: 'Identity & Keys' },
  age: { label: 'Age Key', placeholder: 'age1...', category: 'Identity & Keys' },
  did: { label: 'DID', placeholder: 'did:key:z6Mk...', category: 'Identity & Keys' },
  hyper: { label: 'HyperDHT Key', placeholder: 'a1b2c3...', category: 'Identity & Keys' },
  bep44: { label: 'BEP 44 Key', placeholder: 'd4e5f6...', category: 'Identity & Keys' },
  website: { label: 'Website', placeholder: 'https://example.com', category: 'General' },
  email: { label: 'Email', placeholder: 'alice@example.com', category: 'General' },
  matrix: { label: 'Matrix', placeholder: '@alice:matrix.org', category: 'General' },
  xmpp: { label: 'XMPP', placeholder: 'alice@jabber.org', category: 'General' },
};

export function isValidHex(text: string): boolean {
  if (text.length === 0) return true;
  return /^[0-9A-Fa-f]*$/.test(text);
}

export function validateKey(key: string): boolean {
  return /^[a-z0-9-]+$/.test(key);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('');
}

function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function readCompactSize(data: Uint8Array, pos: { offset: number }): number {
  if (pos.offset >= data.length) throw new Error('unexpected eof');
  const first = data[pos.offset]!;
  pos.offset += 1;

  if (first <= 0xfc) return first;

  if (first === 0xfd) {
    if (pos.offset + 2 > data.length) throw new Error('unexpected eof');
    const v = data[pos.offset]! | (data[pos.offset + 1]! << 8);
    pos.offset += 2;
    return v;
  }

  if (first === 0xfe) {
    if (pos.offset + 4 > data.length) throw new Error('unexpected eof');
    const v =
      data[pos.offset]! |
      (data[pos.offset + 1]! << 8) |
      (data[pos.offset + 2]! << 16) |
      ((data[pos.offset + 3]! << 24) >>> 0);
    pos.offset += 4;
    return v;
  }

  if (pos.offset + 8 > data.length) throw new Error('unexpected eof');
  let v = 0;
  for (let i = 0; i < 8; i++) {
    v += data[pos.offset + i]! * 2 ** (8 * i);
  }
  pos.offset += 8;
  if (v > Number.MAX_SAFE_INTEGER) {
    console.warn('CompactSize value exceeds Number.MAX_SAFE_INTEGER');
  }
  return v;
}

export function writeCompactSize(value: number): Uint8Array {
  if (value < 0) throw new Error('CompactSize value must be non-negative');

  if (value <= 0xfc) {
    return new Uint8Array([value]);
  }
  if (value <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    buf[1] = value & 0xff;
    buf[2] = (value >> 8) & 0xff;
    return buf;
  }
  if (value <= 0xffffffff) {
    const buf = new Uint8Array(5);
    buf[0] = 0xfe;
    buf[1] = value & 0xff;
    buf[2] = (value >> 8) & 0xff;
    buf[3] = (value >> 16) & 0xff;
    buf[4] = (value >> 24) & 0xff;
    return buf;
  }

  const buf = new Uint8Array(9);
  buf[0] = 0xff;
  let rem = value;
  for (let i = 1; i <= 8; i++) {
    buf[i] = rem & 0xff;
    rem = Math.floor(rem / 256);
  }
  return buf;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.length;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export function encodeRecordSet(rows: RecordRow[]): Uint8Array {
  const parts: Uint8Array[] = [];

  for (const row of rows) {
    let rtypeByte: number;
    let rdata: Uint8Array;

    switch (row.recordType) {
      case 'seq': {
        rtypeByte = TYPE_SEQ;
        rdata = writeCompactSize(row.version ?? 0);
        break;
      }
      case 'txt': {
        rtypeByte = TYPE_TXT;
        const keyBytes = encodeUtf8(row.key ?? '');
        const valueBytes = encodeUtf8(row.value ?? '');
        const valueLenPrefix = writeCompactSize(valueBytes.length);
        rdata = concatBytes(new Uint8Array([keyBytes.length]), keyBytes, valueLenPrefix, valueBytes);
        break;
      }
      case 'blob': {
        rtypeByte = TYPE_BLOB;
        const keyBytes = encodeUtf8(row.key ?? '');
        const valueBytes = row.value ? base64Decode(row.value) : new Uint8Array(0);
        rdata = concatBytes(new Uint8Array([keyBytes.length]), keyBytes, valueBytes);
        break;
      }
      case 'addr': {
        rtypeByte = TYPE_ADDR;
        const keyBytes = encodeUtf8(row.key ?? '');
        const valueBytes = encodeUtf8(row.value ?? '');
        const valueLenPrefix = writeCompactSize(valueBytes.length);
        rdata = concatBytes(new Uint8Array([keyBytes.length]), keyBytes, valueLenPrefix, valueBytes);
        break;
      }
      case 'unknown': {
        rtypeByte = row.rtype ?? 0;
        rdata = row.rdata ? base64Decode(row.rdata) : new Uint8Array(0);
        break;
      }
      default:
        continue;
    }

    parts.push(new Uint8Array([rtypeByte]), writeCompactSize(rdata.length), rdata);
  }

  return concatBytes(...parts);
}

export function decodeRecordSet(bytes: Uint8Array): RecordRow[] {
  const rows: RecordRow[] = [];
  const pos = { offset: 0 };
  let index = 0;
  let seenSeq = false;

  while (pos.offset < bytes.length) {
    const rtype = bytes[pos.offset]!;
    pos.offset += 1;

    const rdataLen = readCompactSize(bytes, pos);
    if (pos.offset + rdataLen > bytes.length) {
      throw new Error('data overflow');
    }
    const rdata = bytes.slice(pos.offset, pos.offset + rdataLen);
    pos.offset += rdataLen;

    const id = Date.now().toString() + index;

    switch (rtype) {
      case TYPE_SEQ: {
        if (seenSeq) throw new Error('duplicate seq');
        if (index > 0) throw new Error('seq must be first');
        seenSeq = true;
        const seqPos = { offset: 0 };
        const version = readCompactSize(rdata, seqPos);
        rows.push({ id, recordType: 'seq', version });
        break;
      }
      case TYPE_TXT: {
        const kv = parseKv(rdata);
        const values = parseTxtValues(kv.valueBytes);
        rows.push({ id, recordType: 'txt', key: kv.key, value: values.join('') });
        break;
      }
      case TYPE_BLOB: {
        const kv = parseKv(rdata);
        const value = base64Encode(kv.valueBytes);
        rows.push({ id, recordType: 'blob', key: kv.key, value });
        break;
      }
      case TYPE_ADDR: {
        const kv = parseKv(rdata);
        const values = parseTxtValues(kv.valueBytes);
        rows.push({ id, recordType: 'addr', key: kv.key, value: values.join('') });
        break;
      }
      case TYPE_SIG: {
        rows.push({ id, recordType: 'sig' });
        break;
      }
      default: {
        rows.push({
          id,
          recordType: 'unknown',
          rtype,
          rdata: base64Encode(rdata),
        });
        break;
      }
    }

    index += 1;
  }

  return rows;
}

function parseKv(data: Uint8Array): { key: string; valueBytes: Uint8Array } {
  if (data.length === 0) throw new Error('empty data');
  const keyLen = data[0]!;
  if (1 + keyLen > data.length) throw new Error('key length exceeds data');
  const keyBytes = data.slice(1, 1 + keyLen);
  const key = decodeUtf8(keyBytes);
  if (!validateKey(key)) {
    throw new Error('invalid key: must be lowercase ascii, digits, or hyphens');
  }
  const valueBytes = data.slice(1 + keyLen);
  return { key, valueBytes };
}

function parseTxtValues(data: Uint8Array): string[] {
  const values: string[] = [];
  const pos = { offset: 0 };
  while (pos.offset < data.length) {
    const len = readCompactSize(data, pos);
    if (pos.offset + len > data.length) throw new Error('value length exceeds data');
    const chunk = data.slice(pos.offset, pos.offset + len);
    values.push(decodeUtf8(chunk));
    pos.offset += len;
  }
  return values;
}

export type JsonRecord =
  | { type: 'seq'; version: number }
  | { type: 'txt'; key: string; value: string }
  | { type: 'blob'; key: string; value: string }
  | { type: 'unknown'; rtype: number; rdata: string };

export function rowsToJson(rows: RecordRow[]): JsonRecord[] {
  return rows.map((row): JsonRecord => {
    switch (row.recordType) {
      case 'seq':
        return { type: 'seq', version: row.version ?? 0 };
      case 'txt':
        return { type: 'txt', key: row.key ?? '', value: row.value ?? '' };
      case 'blob':
        return { type: 'blob', key: row.key ?? '', value: row.value ?? '' };
      case 'addr':
        return { type: 'txt', key: row.key ?? '', value: row.value ?? '' };
      case 'unknown':
        return { type: 'unknown', rtype: row.rtype ?? 0, rdata: row.rdata ?? '' };
      case 'sig':
        throw new Error('Internal sig record cannot be exported to JSON');
    }
  });
}

export function jsonToRows(records: JsonRecord[]): RecordRow[] {
  return records.map((rec, index): RecordRow => {
    const id = Date.now().toString() + index;
    switch (rec.type) {
      case 'seq':
        return { id, recordType: 'seq', version: rec.version };
      case 'txt':
        return { id, recordType: 'txt', key: rec.key, value: rec.value };
      case 'blob':
        return { id, recordType: 'blob', key: rec.key, value: rec.value };
      case 'unknown':
        return { id, recordType: 'unknown', rtype: rec.rtype, rdata: rec.rdata };
    }
  });
}

export function validateJsonRecords(data: unknown): JsonRecord[] {
  if (!Array.isArray(data)) {
    throw new Error('Expected a JSON array of records');
  }

  let seenSeq = false;
  const records: JsonRecord[] = [];

  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (!item || typeof item !== 'object' || !('type' in item)) {
      throw new Error(`Record ${i}: missing "type" field`);
    }

    const recType = (item as { type: unknown }).type;
    if (typeof recType !== 'string') {
      throw new Error(`Record ${i}: "type" must be a string`);
    }

    switch (recType) {
      case 'seq': {
        if (seenSeq) throw new Error(`Record ${i}: duplicate seq`);
        if (i > 0) throw new Error(`Record ${i}: seq must be first`);
        seenSeq = true;
        const version = (item as { version?: unknown }).version;
        if (typeof version !== 'number' || version < 0) {
          throw new Error(`Record ${i}: seq requires a non-negative "version" number`);
        }
        records.push({ type: 'seq', version });
        break;
      }
      case 'txt': {
        const { key, value } = item as { key?: unknown; value?: unknown };
        if (typeof key !== 'string') throw new Error(`Record ${i}: txt requires a "key" string`);
        if (typeof value !== 'string') throw new Error(`Record ${i}: txt requires a "value" string`);
        if (!validateKey(key)) throw new Error(`Record ${i}: invalid key "${key}"`);
        records.push({ type: 'txt', key, value });
        break;
      }
      case 'blob': {
        const { key, value } = item as { key?: unknown; value?: unknown };
        if (typeof key !== 'string') throw new Error(`Record ${i}: blob requires a "key" string`);
        if (typeof value !== 'string') throw new Error(`Record ${i}: blob requires a "value" (base64) string`);
        if (!validateKey(key)) throw new Error(`Record ${i}: invalid key "${key}"`);
        records.push({ type: 'blob', key, value });
        break;
      }
      case 'unknown': {
        const { rtype, rdata } = item as { rtype?: unknown; rdata?: unknown };
        if (typeof rtype !== 'number') throw new Error(`Record ${i}: unknown requires an "rtype" number`);
        if (typeof rdata !== 'string') throw new Error(`Record ${i}: unknown requires an "rdata" (base64) string`);
        records.push({ type: 'unknown', rtype, rdata });
        break;
      }
      case 'sig':
        // Internal signature record — ignored when loading JSON into the hex tool UI.
        break;
      default:
        throw new Error(`Record ${i}: unrecognized type "${recType}"`);
    }
  }

  return records;
}

/** SEQ and SIG are managed internally — not shown as editable table rows. */
export function isInternalWireRow(row: RecordRow): boolean {
  return (
    row.recordType === 'seq' ||
    row.recordType === 'sig' ||
    (row.recordType === 'unknown' && row.rtype === TYPE_SIG)
  );
}

export function splitInternalWireRows(rows: RecordRow[]): {
  seqVersion: number;
  visibleRows: RecordRow[];
} {
  const seqRow = rows.find((row) => row.recordType === 'seq');
  return {
    seqVersion: seqRow?.version ?? 0,
    visibleRows: rows.filter((row) => !isInternalWireRow(row)),
  };
}

export function buildEditableWireRows(visibleRows: RecordRow[], seqVersion: number): RecordRow[] {
  const visible = visibleRows.filter((row) => !isInternalWireRow(row));
  if (visible.length === 0) {
    return [];
  }
  return [{ id: '__internal_seq__', recordType: 'seq', version: seqVersion }, ...visible];
}

/** Encode visible table rows plus internal SEQ (never SIG). */
export function encodeEditableRecordSet(visibleRows: RecordRow[], seqVersion: number): Uint8Array {
  return encodeRecordSet(buildEditableWireRows(visibleRows, seqVersion));
}

/** Next sequence version when publishing an update to certrelay. */
export function nextPublishSeqVersion(seqVersion: number): number {
  return seqVersion + 1;
}

/** Unsigned wire bytes for publish: visible rows + incremented SEQ (SIG added separately). */
export function encodePublishRecordSet(visibleRows: RecordRow[], seqVersion: number): Uint8Array {
  const visible = visibleRows.filter((row) => !isInternalWireRow(row));
  if (visible.length === 0) {
    throw new Error('Cannot publish without at least one attribute record.');
  }
  return encodeRecordSet(buildEditableWireRows(visible, nextPublishSeqVersion(seqVersion)));
}

/** Decode wire bytes, drop SEQ/SIG, and rebuild hex from editable records only. */
export function editableHexFromWireBytes(bytes: Uint8Array): string {
  const { seqVersion, visibleRows } = splitInternalWireRows(decodeRecordSet(bytes));
  return bytesToHex(encodeEditableRecordSet(visibleRows, seqVersion));
}

export function applyInternalWireSplit(rows: RecordRow[]): {
  seqVersion: number;
  visibleRows: RecordRow[];
  hex: string;
} {
  const { seqVersion, visibleRows } = splitInternalWireRows(rows);
  return {
    seqVersion,
    visibleRows,
    hex: bytesToHex(encodeEditableRecordSet(visibleRows, seqVersion)),
  };
}
