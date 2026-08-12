import { bytesToHex } from '@/lib/wire';

/** Minimal zone shape from libveritas — avoids static import of native module. */
export type ZoneLike = {
  handle: string;
  sovereignty: string;
  canonical: string;
  alias?: string;
  records: ArrayBuffer;
  fallbackRecords: ArrayBuffer;
};

export type ZoneAttribute = {
  type: 'txt' | 'addr';
  key: string;
  values: string[];
};

export type VerifiedZoneSummary = {
  handle: string;
  sovereignty: string;
  canonical: string;
  alias?: string;
  attributes: ZoneAttribute[];
  fallbackAttributes: ZoneAttribute[];
  /** Primary zone SIP-7 wire bytes as hex (includes Seq; may include Sig). */
  recordsHex?: string;
  /** Fallback zone SIP-7 wire bytes as hex. */
  fallbackRecordsHex?: string;
};

const PREFERRED_ATTRIBUTE_KEYS = ['website', 'nostr', 'btc'] as const;

async function extractAttributesFromRecordBytes(
  recordsBytes: ArrayBuffer
): Promise<ZoneAttribute[]> {
  if (recordsBytes.byteLength === 0) {
    return [];
  }

  const { RecordSet } = await import('@spacesprotocol/react-native-libveritas');
  const recordSet = new RecordSet(recordsBytes);
  if (recordSet.isEmpty()) {
    return [];
  }

  const attributes: ZoneAttribute[] = [];
  for (const record of recordSet.unpack()) {
    if (record.tag === 'Txt') {
      attributes.push({
        type: 'txt',
        key: record.inner.key,
        values: record.inner.value,
      });
    } else if (record.tag === 'Addr') {
      attributes.push({
        type: 'addr',
        key: record.inner.key,
        values: record.inner.value,
      });
    }
  }
  return attributes;
}

export async function summarizeVerifiedZone(zone: ZoneLike): Promise<VerifiedZoneSummary> {
  const [attributes, fallbackAttributes] = await Promise.all([
    extractAttributesFromRecordBytes(zone.records),
    extractAttributesFromRecordBytes(zone.fallbackRecords),
  ]);

  return {
    handle: zone.handle,
    sovereignty: zone.sovereignty,
    canonical: zone.canonical,
    alias: zone.alias,
    attributes,
    fallbackAttributes,
    recordsHex:
      zone.records.byteLength > 0 ? bytesToHex(new Uint8Array(zone.records)) : undefined,
    fallbackRecordsHex:
      zone.fallbackRecords.byteLength > 0
        ? bytesToHex(new Uint8Array(zone.fallbackRecords))
        : undefined,
  };
}

export async function summarizeVerifiedZones(zones: ZoneLike[]): Promise<VerifiedZoneSummary[]> {
  return Promise.all(zones.map((zone) => summarizeVerifiedZone(zone)));
}

export function sortZonesForQuery(
  zones: VerifiedZoneSummary[],
  queryName: string
): VerifiedZoneSummary[] {
  const normalizedQuery = queryName.trim().toLowerCase();
  return [...zones].sort((a, b) => {
    const aExact = a.handle.toLowerCase() === normalizedQuery ? 0 : 1;
    const bExact = b.handle.toLowerCase() === normalizedQuery ? 0 : 1;
    if (aExact !== bExact) {
      return aExact - bExact;
    }
    return a.handle.localeCompare(b.handle);
  });
}

export function orderZoneAttributes(attributes: ZoneAttribute[]): ZoneAttribute[] {
  const byKey = new Map(attributes.map((attr) => [attr.key, attr]));
  const ordered: ZoneAttribute[] = [];

  for (const key of PREFERRED_ATTRIBUTE_KEYS) {
    const attr = byKey.get(key);
    if (attr) {
      ordered.push(attr);
      byKey.delete(key);
    }
  }

  const remaining = Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
  return [...ordered, ...remaining];
}

export function formatZoneAttributeLabel(attr: ZoneAttribute): string {
  return attr.type === 'txt' ? attr.key : attr.key.toUpperCase();
}

export function formatZoneAttributeValue(attr: ZoneAttribute): string {
  return attr.values.join(', ');
}
