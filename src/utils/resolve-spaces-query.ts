import {
  getQueryRelayUrls,
  normalizeAnchorsJsonForLibveritas,
  querySpacesFromAnchorServer,
} from '@/utils/get-anchors-json';
import type { VerifiedZoneSummary } from '@/utils/extract-zone-attributes';
import type { Zone } from '@spacesprotocol/react-native-libveritas';

export type ResolveSpacesQueryResult = {
  zones: VerifiedZoneSummary[];
  requestedHandle: string;
  requestedHandleFound: boolean;
  queryUrlParts: string[];
  raw: unknown;
  warning?: string;
};

type ZoneRecord = Zone;

type CachedRootZone = {
  bytes: ArrayBuffer;
  epochHint?: { root: string; height: number };
};

type LibveritasModule = typeof import('@spacesprotocol/react-native-libveritas');

const rootZoneCache = new Map<string, CachedRootZone>();

function parseSpacesHandle(handle: string): { space: string; label: string; full: string } {
  const full = handle.trim();
  let sepIdx = full.indexOf('@');
  if (sepIdx < 0) {
    sepIdx = full.indexOf('#');
  }
  if (sepIdx < 0) {
    throw new Error(`invalid handle: ${full}`);
  }
  if (sepIdx === 0) {
    return { space: full, label: '', full };
  }
  return {
    space: full.substring(sepIdx),
    label: full.substring(0, sepIdx),
    full,
  };
}

/** e.g. abc@swifty → @swifty,abc@swifty */
export function buildRelayQueryString(handle: string): string {
  const { space, label, full } = parseSpacesHandle(handle);
  if (!label) {
    return space;
  }
  return `${space},${full}`;
}

function buildRelayQueryStringForSpace(space: string, labels: string[]): string {
  if (labels.length === 0) {
    return space;
  }
  return [space, ...labels.map((label) => `${label}${space}`)].join(',');
}

function isRootHandle(handle: string): boolean {
  return handle.startsWith('@') || handle.startsWith('#');
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function uniqueZonesByCanonical<T extends { canonical: string }>(zones: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const zone of zones) {
    if (seen.has(zone.canonical)) {
      continue;
    }
    seen.add(zone.canonical);
    unique.push(zone);
  }
  return unique;
}

function getVerifyErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'inner' in error) {
    const inner = (error as { inner?: { msg?: string } }).inner;
    if (inner?.msg) {
      return inner.msg;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function formatSpacesVerifyError(error: unknown, handle: string): string {
  const msg = getVerifyErrorMessage(error);
  const receiptMatch = msg.match(/receipt required for (.+)/i);
  if (receiptMatch) {
    const parent = receiptMatch[1].trim();
    return `Relay proof incomplete for ${parent}. Certrelay has not yet provided the ZK receipt needed to verify ${handle}. The parent space may be known, but this sub-handle cannot be cryptographically verified until relays gossip the full chain.`;
  }
  if (msg.includes('VeritasError.VerificationFailed') || msg.toLowerCase().includes('verification')) {
    return `Could not verify ${handle}: ${msg}`;
  }
  return msg;
}

function isReceiptRequiredError(error: unknown): boolean {
  return /receipt required for/i.test(getVerifyErrorMessage(error));
}

function parseEpochHint(zoneJson: unknown): CachedRootZone['epochHint'] | undefined {
  if (!zoneJson || typeof zoneJson !== 'object') {
    return undefined;
  }
  const commitment = (zoneJson as { commitment?: { onchain?: { state_root?: string; block_height?: number } } })
    .commitment;
  const onchain = commitment?.onchain;
  if (!onchain?.state_root || onchain.block_height == null) {
    return undefined;
  }
  return { root: onchain.state_root, height: onchain.block_height };
}

function cacheRootZone(
  lib: LibveritasModule,
  zone: ZoneRecord
): void {
  if (!isRootHandle(zone.handle)) {
    return;
  }
  let epochHint: CachedRootZone['epochHint'];
  try {
    const zoneJson = JSON.parse(lib.zoneToJson(zone));
    epochHint = parseEpochHint(zoneJson);
  } catch {
    epochHint = undefined;
  }
  rootZoneCache.set(zone.handle, {
    bytes: lib.zoneToBytes(zone).slice(0),
    epochHint,
  });
}

type FlatQuery = {
  space: string;
  labels: string[];
  q: string;
  hints?: string;
};

function buildFlatQueries(handles: string[]): FlatQuery[] {
  const bySpace = new Map<string, string[]>();

  for (const handle of handles) {
    const { space, label } = parseSpacesHandle(handle);
    const labels = bySpace.get(space) ?? [];
    if (label) {
      labels.push(label);
    }
    bySpace.set(space, labels);
  }

  const queries: FlatQuery[] = [];
  for (const [space, labels] of bySpace) {
    const cached = rootZoneCache.get(space);
    const hints =
      cached?.epochHint != null
        ? `${space}:${cached.epochHint.root}:${cached.epochHint.height}`
        : undefined;
    queries.push({
      space,
      labels,
      q: buildRelayQueryStringForSpace(space, labels),
      hints,
    });
  }
  return queries;
}

function buildQueryContext(
  lib: LibveritasModule,
  queries: FlatQuery[],
  priorZones: ZoneRecord[]
): InstanceType<LibveritasModule['QueryContext']> {
  const ctx = new lib.QueryContext();

  for (const query of queries) {
    const cached = rootZoneCache.get(query.space);
    if (cached) {
      ctx.addZone(cached.bytes.slice(0));
    }
  }
  for (const zone of priorZones) {
    ctx.addZone(lib.zoneToBytes(zone).slice(0));
  }
  for (const query of queries) {
    ctx.addRequest(query.space);
    for (const label of query.labels) {
      ctx.addRequest(`${label}${query.space}`);
    }
  }

  return ctx;
}

function buildCombinedQuery(queries: FlatQuery[]): { q: string; hints?: string } {
  const qParts: string[] = [];
  const hintParts: string[] = [];

  for (const query of queries) {
    qParts.push(query.space);
    for (const label of query.labels) {
      qParts.push(`${label}${query.space}`);
    }
    if (query.hints) {
      hintParts.push(query.hints);
    }
  }

  return {
    q: qParts.join(','),
    hints: hintParts.length > 0 ? hintParts.join(',') : undefined,
  };
}

function maxZoneAnchor(lib: LibveritasModule, zones: ZoneRecord[]): number {
  let maxAnchor = 0;
  for (const zone of zones) {
    try {
      const zoneJson = JSON.parse(lib.zoneToJson(zone)) as { anchor?: number };
      if (typeof zoneJson.anchor === 'number' && zoneJson.anchor > maxAnchor) {
        maxAnchor = zoneJson.anchor;
      }
    } catch {
      // ignore malformed zone json
    }
  }
  return maxAnchor;
}

function compareVerifiedQueryResults(
  lib: LibveritasModule,
  a: {
    verified: { zones(): Zone[] };
    peerUrl: string;
    byteLength: number;
  },
  b: {
    verified: { zones(): Zone[] };
    peerUrl: string;
    byteLength: number;
  }
): number {
  const aZones = a.verified.zones();
  const bZones = b.verified.zones();
  if (bZones.length !== aZones.length) {
    return bZones.length - aZones.length;
  }

  const anchorDiff = maxZoneAnchor(lib, bZones) - maxZoneAnchor(lib, aZones);
  if (anchorDiff !== 0) {
    return anchorDiff;
  }

  return b.byteLength - a.byteLength;
}

async function verifyQueryAcrossRelays(
  lib: LibveritasModule,
  veritas: InstanceType<LibveritasModule['Veritas']>,
  ctx: InstanceType<LibveritasModule['QueryContext']>,
  queries: FlatQuery[],
  relayUrls: string[]
): Promise<{ verified: { zones(): Zone[] }; peerUrl: string; q: string }> {
  const { q, hints } = buildCombinedQuery(queries);
  if (relayUrls.length === 0) {
    throw new Error('no relays available');
  }

  const attempts = await Promise.all(
    relayUrls.map(async (peerUrl) => {
      try {
        const queryResult = await querySpacesFromAnchorServer(peerUrl, q, hints);
        const verified = veritas.verify(ctx, new lib.Message(queryResult.data.slice(0)));
        return {
          ok: true as const,
          verified,
          peerUrl,
          byteLength: queryResult.byteLength,
        };
      } catch (error) {
        console.warn(
          `[Spaces] resolveSpacesQuery: verify failed peer=${peerUrl} q=${q}: ${getVerifyErrorMessage(error)}`
        );
        return { ok: false as const, peerUrl, error };
      }
    })
  );

  const successful = attempts.filter((attempt) => attempt.ok);
  if (successful.length === 0) {
    const lastError = attempts.find((attempt) => !attempt.ok)?.error;
    throw lastError ?? new Error('all relay queries failed');
  }

  const best = successful.reduce((currentBest, candidate) =>
    compareVerifiedQueryResults(lib, candidate, currentBest) > 0 ? candidate : currentBest
  );

  console.log(
    `[Spaces] resolveSpacesQuery: selected peer=${best.peerUrl} from ${successful.length}/${relayUrls.length} responses (zones=${best.verified.zones().length}, bytes=${best.byteLength})`
  );

  return { verified: best.verified, peerUrl: best.peerUrl, q };
}

async function warmRootSpaceCache(
  lib: LibveritasModule,
  veritas: InstanceType<LibveritasModule['Veritas']>,
  space: string,
  relayUrls: string[]
): Promise<void> {
  if (rootZoneCache.has(space)) {
    return;
  }

  const ctx = new lib.QueryContext();
  ctx.addRequest(space);

  const { verified } = await verifyQueryAcrossRelays(
    lib,
    veritas,
    ctx,
    [{ space, labels: [], q: space }],
    relayUrls
  );

  for (const zone of verified.zones()) {
    cacheRootZone(lib, zone);
  }
}

/**
 * Resolve and verify a handle using Fabric-compatible relay queries.
 */
export async function resolveSpacesQuery(
  peerUrls: string | string[],
  anchorsJsonString: string,
  queryName: string,
  options: { noDns?: boolean } = {}
): Promise<ResolveSpacesQueryResult> {
  const trimmed = queryName.trim();
  const selectedPeerUrls = (Array.isArray(peerUrls) ? peerUrls : [peerUrls]).filter(Boolean);
  const relayUrls =
    selectedPeerUrls.length > 0
      ? selectedPeerUrls
      : getQueryRelayUrls(null, options.noDns ?? false);

  console.log(
    `[Spaces] resolveSpacesQuery: handle=${trimmed} q=${buildRelayQueryString(trimmed)} peers=${relayUrls.length}`
  );

  const [lib, { summarizeVerifiedZones, sortZonesForQuery }] = await Promise.all([
    import('@spacesprotocol/react-native-libveritas'),
    import('@/utils/extract-zone-attributes'),
  ]);

  const libveritasAnchorsJson = normalizeAnchorsJsonForLibveritas(anchorsJsonString);
  const anchors = lib.Anchors.fromJson(libveritasAnchorsJson);
  const veritas = new lib.Veritas(anchors);
  const lookup = new lib.Lookup([trimmed]);

  const { space: parentSpace, label } = parseSpacesHandle(trimmed);
  if (label) {
    try {
      await warmRootSpaceCache(lib, veritas, parentSpace, relayUrls);
      console.log(`[Spaces] resolveSpacesQuery: warmed cache for ${parentSpace}`);
    } catch (error) {
      console.warn(
        `[Spaces] resolveSpacesQuery: could not warm ${parentSpace} cache: ${getVerifyErrorMessage(error)}`
      );
    }
  }

  let prevBatch: string[] = [];
  let batch = lookup.start();
  const allZones: ZoneRecord[] = [];
  const queryUrlParts: string[] = [];
  let lastVerified: unknown = null;
  let lastVerifyError: unknown = null;

  while (batch.length > 0) {
    if (arraysEqual(batch, prevBatch)) {
      console.warn('[Spaces] resolveSpacesQuery: lookup batch repeated, stopping', batch);
      break;
    }

    const queries = buildFlatQueries(batch);
    const { q } = buildCombinedQuery(queries);
    queryUrlParts.push(q);
    console.log(`[Spaces] resolveSpacesQuery: batch=${JSON.stringify(batch)} q=${q}`);

    const ctx = buildQueryContext(lib, queries, allZones);

    try {
      const result = await verifyQueryAcrossRelays(lib, veritas, ctx, queries, relayUrls);
      lastVerified = result.verified;
      lastVerifyError = null;
      const roundZones = result.verified.zones();
      console.log(
        `[Spaces] resolveSpacesQuery: verified zones=${roundZones.map((zone) => zone.handle).join(', ')} (peer=${result.peerUrl})`
      );

      for (const zone of roundZones) {
        cacheRootZone(lib, zone);
      }
      allZones.push(...roundZones);
      prevBatch = batch;
      batch = lookup.advance(roundZones);
    } catch (error) {
      lastVerifyError = error;
      console.warn(
        `[Spaces] resolveSpacesQuery: round failed batch=${JSON.stringify(batch)}: ${getVerifyErrorMessage(error)}`
      );
      break;
    }
  }

  const expanded = lookup.expandZones(uniqueZonesByCanonical(allZones));
  const zoneSummaries = await summarizeVerifiedZones(expanded);
  const zones = sortZonesForQuery(zoneSummaries, trimmed);
  const requestedHandleFound = zones.some(
    (zone) => zone.handle.toLowerCase() === trimmed.toLowerCase()
  );

  if (lastVerifyError && zones.length === 0) {
    throw new Error(formatSpacesVerifyError(lastVerifyError, trimmed));
  }

  let warning: string | undefined;
  if (!requestedHandleFound) {
    if (lastVerifyError && isReceiptRequiredError(lastVerifyError)) {
      warning = formatSpacesVerifyError(lastVerifyError, trimmed);
    } else if (zones.length > 0) {
      warning = `Verified parent chain only. ${trimmed} is not yet available from this relay with a full certificate chain.`;
    } else {
      warning = `${trimmed} was not found in verified relay data.`;
    }
    console.warn(`[Spaces] resolveSpacesQuery: ${warning}`);
  }

  return {
    zones,
    requestedHandle: trimmed,
    requestedHandleFound,
    queryUrlParts,
    raw: lastVerified,
    warning,
  };
}
