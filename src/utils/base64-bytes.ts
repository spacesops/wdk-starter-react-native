const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode standard base64 into bytes (RN-safe, no atob). */
export function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.replace(/\s/g, '');
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
  return Uint8Array.from(bytes);
}

/** Decode standard base64 into an ArrayBuffer (RN-safe, no atob). */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bytes = base64ToUint8Array(base64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
