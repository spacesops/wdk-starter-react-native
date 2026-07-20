import {
  CERTRELAY_BASE_URL,
  formatAnchorsJsonForLibveritas,
  getAnchorsJSON,
} from '@/utils/get-anchors-json';
import { resolveSpacesQuery } from '@/utils/resolve-spaces-query';

export type LoadPrimaryRecordsFromCertrelayResult = {
  recordsHex?: string;
  requestedHandleFound: boolean;
  warning?: string;
};

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
  const zone = resolved.zones.find(
    (entry) => entry.handle.toLowerCase() === handleTrimmed.toLowerCase()
  );

  return {
    recordsHex: zone?.recordsHex,
    requestedHandleFound: resolved.requestedHandleFound,
    warning: resolved.warning,
  };
}
