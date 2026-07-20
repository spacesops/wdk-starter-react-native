import { bytesToHex, type RecordRow } from '@/lib/wire';

const PREFIX = '[Publish]';

/** Enabled unless EXPO_PUBLIC_PUBLISH_DEBUG=0|false|no. Defaults on in __DEV__. */
export function isPublishDebugEnabled(): boolean {
  const flag = process.env.EXPO_PUBLIC_PUBLISH_DEBUG?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no') {
    return false;
  }
  if (flag === '1' || flag === 'true' || flag === 'yes') {
    return true;
  }
  return __DEV__;
}

export function publishDebug(step: string, detail?: Record<string, unknown>): void {
  if (!isPublishDebugEnabled()) {
    return;
  }
  if (detail) {
    console.log(`${PREFIX} ${step}`, detail);
  } else {
    console.log(`${PREFIX} ${step}`);
  }
}

export function publishDebugWarn(step: string, detail?: unknown): void {
  if (!isPublishDebugEnabled()) {
    return;
  }
  console.warn(`${PREFIX} ${step}`, detail ?? '');
}

export function hexPreview(bytes: Uint8Array, maxBytes = 48): string {
  if (bytes.length === 0) {
    return '(empty)';
  }
  const slice = bytes.subarray(0, maxBytes);
  const hex = bytesToHex(slice);
  return bytes.length > maxBytes ? `${hex}… (+${bytes.length - maxBytes} bytes)` : hex;
}

export function summarizeWireRows(rows: RecordRow[]): string {
  return rows
    .map((row) => {
      if (row.recordType === 'seq') {
        return `seq=${row.version ?? 0}`;
      }
      if (row.recordType === 'unknown') {
        return `unknown(rtype=${row.rtype ?? 0})`;
      }
      return `${row.recordType}:${row.key ?? ''}=${(row.value ?? '').slice(0, 40)}`;
    })
    .join('; ');
}

export function formatHttpFailure(
  step: string,
  peerUrl: string,
  status: number,
  body: string,
  maxChars = 500
): string {
  const trimmed = body.trim();
  const bodyNote = trimmed
    ? trimmed.slice(0, maxChars)
    : '(empty response body)';
  return `${step}: HTTP ${status} from ${peerUrl}: ${bodyNote}`;
}
