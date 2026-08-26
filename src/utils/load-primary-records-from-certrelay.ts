import type { VerifiedZoneSummary, ZoneAttribute } from '@/utils/extract-zone-attributes';
import {
  CERTRELAY_BASE_URL,
  formatAnchorsJsonForLibveritas,
  getAnchorsJSON,
} from '@/utils/get-anchors-json';
import { resolveSpacesQuery } from '@/utils/resolve-spaces-query';

export type LoadPrimaryRecordsFromCertrelayResult = {
  recordsHex?: string;
  attributes: ZoneAttribute[];
  requestedHandleFound: boolean;
  warning?: string;
};

function zoneMatchesHandle(entry: VerifiedZoneSummary, handle: string): boolean {
  const needle = handle.toLowerCase();
  return (
    entry.handle.toLowerCase() === needle ||
    (entry.alias != null && entry.alias.toLowerCase() === needle)
  );
}

/**
 * Query certrelay for a handle and return primary-zone SIP-7 wire bytes (hex) when present.
 */
export async function loadPrimaryRecordsFromCertrelay(
  handle: string,
  options: { noDns?: boolean } = {}
): Promise<LoadPrimaryRecordsFromCertrelayResult> {
  const handleTrimmed = handle.trim();
  if (!handleTrimmed) {
    throw new Error('Handle is required.');
  }

  const anchorsResult = await getAnchorsJSON({ noDns: options.noDns ?? false });
  if (!anchorsResult) {
    throw new Error('Trust anchors are unavailable. Check your network connection and try again.');
  }

  const anchorsJson = formatAnchorsJsonForLibveritas(anchorsResult.anchors);
  const resolved = await resolveSpacesQuery(CERTRELAY_BASE_URL, anchorsJson, handleTrimmed, options);
  const zone = resolved.zones.find((entry) => zoneMatchesHandle(entry, handleTrimmed));

  return {
    recordsHex: zone?.recordsHex,
    attributes: zone?.attributes ?? [],
    requestedHandleFound: resolved.requestedHandleFound,
    warning: resolved.warning,
  };
}
