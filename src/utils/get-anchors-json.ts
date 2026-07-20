/** Default certrelay for chain proofs and certificate validation fallback queries. */
export const CERTRELAY_BASE_URL = 'https://certrelay.spacesops.com';

const BOOTSTRAP_SERVERS = [
  'https://relay-cosmos.spacesprotocol.org/',
  'https://relay-atlas.spacesprotocol.org/',
  'http://70.251.209.207:47778/',
] as const;

const PEERS_PATH = '/peers';
const ANCHORS_PATH = '/anchors';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PEER_SAMPLES = 5;
export const MAX_QUERY_PEERS = 3;

export type SpacesPeer = {
  source_ip: string;
  url: string;
  capabilities: number;
};

export type AnchorBlock = {
  hash: string;
  height: number;
};

export type AnchorEntry = {
  spaces_root: string;
  nums_root: string;
  block: AnchorBlock;
};

export type AnchorsResponse = {
  entries: AnchorEntry[];
};

export type GetAnchorsResult = {
  anchors: AnchorsResponse;
  serverHostname: string;
  peerUrl: string;
  /** Up to {@link MAX_QUERY_PEERS} relay URLs ranked by freshest anchors. */
  peerUrls: string[];
};

export type GetAnchorsJSONOptions = {
  /** When true, only use bootstrap nodes and peers whose URL hostname is an IP address. */
  noDns?: boolean;
};

/**
 * libveritas expects the /anchors entries array, not the wrapped API object.
 */
export function formatAnchorsJsonForLibveritas(anchors: AnchorsResponse): string {
  return JSON.stringify(anchors.entries);
}

/**
 * Accept either the wrapped /anchors response or a pre-formatted entries array.
 */
export function normalizeAnchorsJsonForLibveritas(anchorsJsonString: string): string {
  const parsed = JSON.parse(anchorsJsonString) as unknown;
  if (Array.isArray(parsed)) {
    return anchorsJsonString;
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as AnchorsResponse).entries)
  ) {
    return JSON.stringify((parsed as AnchorsResponse).entries);
  }
  return anchorsJsonString;
}

type PeerAnchorsResult = {
  peerUrl: string;
  anchors: AnchorsResponse | null;
  dnsCertError: boolean;
  error?: unknown;
};

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function normalizePeerUrl(url: string): string {
  return normalizeBaseUrl(url).toLowerCase();
}

function joinUrl(base: string, path: string): string {
  return `${normalizeBaseUrl(base)}${path.startsWith('/') ? path : `/${path}`}`;
}

function isHttpIpPeerUrl(url: string): boolean {
  return /^http:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\/?$/i.test(url.trim());
}

function isIpAddressUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url.trim());
    return isIpv4Host(hostname);
  } catch {
    return false;
  }
}

function isDnsOrCertError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes('network request failed') ||
    msg.includes('cert') ||
    msg.includes('certificate') ||
    msg.includes('ssl') ||
    msg.includes('tls') ||
    msg.includes('hostname') ||
    msg.includes('dns') ||
    msg.includes('unable to resolve') ||
    msg.includes('handshake')
  );
}

function pickRandomItems<T>(items: T[], max: number): T[] {
  if (items.length <= max) {
    return [...items];
  }
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, max);
}

function parsePeersBody(body: unknown): SpacesPeer[] {
  if (!Array.isArray(body)) {
    return [];
  }
  const peers: SpacesPeer[] = [];
  for (const item of body) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const row = item as Record<string, unknown>;
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    if (!url) {
      continue;
    }
    peers.push({
      source_ip: typeof row.source_ip === 'string' ? row.source_ip : '',
      url,
      capabilities: typeof row.capabilities === 'number' ? row.capabilities : 0,
    });
  }
  return peers;
}

function parseAnchorsBody(body: unknown): AnchorsResponse | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const entriesRaw = (body as { entries?: unknown }).entries;
  if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
    return null;
  }
  const entries: AnchorEntry[] = [];
  for (const item of entriesRaw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const row = item as Record<string, unknown>;
    const blockRaw = row.block;
    if (!blockRaw || typeof blockRaw !== 'object') {
      continue;
    }
    const block = blockRaw as Record<string, unknown>;
    const height = block.height;
    const hash = block.hash;
    if (typeof height !== 'number' || typeof hash !== 'string') {
      continue;
    }
    const spacesRoot = row.spaces_root;
    const numsRoot = row.nums_root;
    if (typeof spacesRoot !== 'string' || typeof numsRoot !== 'string') {
      continue;
    }
    entries.push({
      spaces_root: spacesRoot,
      nums_root: numsRoot,
      block: { hash, height },
    });
  }
  if (entries.length === 0) {
    return null;
  }
  return { entries };
}

function isIpv4Host(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function hostnameFromPeerUrl(peerUrl: string): string {
  try {
    const parsed = new URL(peerUrl);
    const { hostname, port } = parsed;
    if (isIpv4Host(hostname) && port) {
      return `${hostname}:${port}`;
    }
    return hostname;
  } catch {
    return peerUrl;
  }
}

function firstEntryHeight(anchors: AnchorsResponse): number | null {
  const height = anchors.entries[0]?.block?.height;
  return typeof height === 'number' && Number.isFinite(height) ? height : null;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPeersFromBootstrap(baseUrl: string): Promise<SpacesPeer[]> {
  const url = joinUrl(baseUrl, PEERS_PATH);
  try {
    const body = await fetchJson(url);
    const peers = parsePeersBody(body);
    console.log(`[getAnchorsJSON] peers from ${url}: ${peers.length}`);
    return peers;
  } catch (error) {
    console.warn(`[getAnchorsJSON] peers fetch failed for ${url}`, error);
    return [];
  }
}

async function fetchDedupedPeers(noDns = false): Promise<SpacesPeer[]> {
  const bootstrapServers = noDns
    ? BOOTSTRAP_SERVERS.filter((server) => isIpAddressUrl(server))
    : [...BOOTSTRAP_SERVERS];

  if (bootstrapServers.length === 0) {
    console.warn('[getAnchorsJSON] No IP-address bootstrap servers available for No-DNS mode');
    return [];
  }

  const peerLists = await Promise.all(
    bootstrapServers.map((server) => fetchPeersFromBootstrap(server))
  );
  const byUrl = new Map<string, SpacesPeer>();
  for (const peers of peerLists) {
    for (const peer of peers) {
      if (noDns && !isIpAddressUrl(peer.url)) {
        continue;
      }
      const key = normalizePeerUrl(peer.url);
      if (!byUrl.has(key)) {
        byUrl.set(key, peer);
      }
    }
  }
  return Array.from(byUrl.values());
}

async function fetchAnchorsFromPeer(peer: SpacesPeer): Promise<PeerAnchorsResult> {
  const url = joinUrl(peer.url, ANCHORS_PATH);
  try {
    const body = await fetchJson(url);
    const anchors = parseAnchorsBody(body);
    if (!anchors) {
      return {
        peerUrl: peer.url,
        anchors: null,
        dnsCertError: false,
        error: new Error(`Invalid anchors payload from ${url}`),
      };
    }
    console.log(
      `[getAnchorsJSON] anchors from ${url}: entries=${anchors.entries.length}, firstHeight=${firstEntryHeight(anchors)}`
    );
    return { peerUrl: peer.url, anchors, dnsCertError: false };
  } catch (error) {
    return {
      peerUrl: peer.url,
      anchors: null,
      dnsCertError: isDnsOrCertError(error),
      error,
    };
  }
}

async function fetchAnchorsFromPeers(peers: SpacesPeer[]): Promise<PeerAnchorsResult[]> {
  return Promise.all(peers.map((peer) => fetchAnchorsFromPeer(peer)));
}

function selectTopAnchorsResponses(
  results: PeerAnchorsResult[],
  maxPeers = MAX_QUERY_PEERS
): GetAnchorsResult | null {
  const successful = results
    .filter((result) => result.anchors != null)
    .sort(
      (a, b) =>
        (firstEntryHeight(b.anchors!) ?? -1) - (firstEntryHeight(a.anchors!) ?? -1)
    );

  if (successful.length === 0) {
    return null;
  }

  const topResults = successful.slice(0, maxPeers);
  const bestResult = topResults[0];
  const peerUrls = topResults.map((result) => result.peerUrl);
  const serverHostname = peerUrls.map((url) => hostnameFromPeerUrl(url)).join(', ');

  return {
    anchors: bestResult.anchors!,
    serverHostname,
    peerUrl: bestResult.peerUrl,
    peerUrls,
  };
}

/**
 * Discover peers from bootstrap relays, sample peer /anchors responses,
 * and return up to three relay URLs with the freshest anchor payloads.
 */
export async function getAnchorsJSON(
  options: GetAnchorsJSONOptions = {}
): Promise<GetAnchorsResult | null> {
  const { noDns = false } = options;
  const peers = await fetchDedupedPeers(noDns);
  if (peers.length === 0) {
    console.warn(
      `[getAnchorsJSON] No peers discovered from bootstrap servers${noDns ? ' (No-DNS mode)' : ''}`
    );
    return null;
  }

  const httpIpPeers = peers.filter((peer) => isHttpIpPeerUrl(peer.url));
  const selectedPeers = pickRandomItems(peers, MAX_PEER_SAMPLES);
  let results = await fetchAnchorsFromPeers(selectedPeers);

  const hadDnsCertFailures = results.some((result) => result.dnsCertError);
  const hasSuccessfulAnchors = results.some((result) => result.anchors != null);

  if (hadDnsCertFailures && httpIpPeers.length > 0) {
    const triedUrls = new Set(results.map((result) => normalizePeerUrl(result.peerUrl)));
    const fallbackPeers = httpIpPeers.filter((peer) => !triedUrls.has(normalizePeerUrl(peer.url)));
    if (fallbackPeers.length > 0) {
      console.log(
        `[getAnchorsJSON] DNS/cert issues detected; preferring ${fallbackPeers.length} HTTP IP peer(s)`
      );
      const fallbackResults = await fetchAnchorsFromPeers(pickRandomItems(fallbackPeers, MAX_PEER_SAMPLES));
      results = [...results, ...fallbackResults];
    }
  }

  if (!hasSuccessfulAnchors && !results.some((result) => result.anchors != null)) {
    console.warn('[getAnchorsJSON] No successful /anchors responses');
    return null;
  }

  const best = selectTopAnchorsResponses(results);
  if (best) {
    console.log(
      `[getAnchorsJSON] Selected ${best.peerUrls.length} peer(s): ${best.serverHostname} (first-entry height ${firstEntryHeight(best.anchors)})`
    );
  }
  return best;
}

export type QuerySpacesResult = {
  data: ArrayBuffer;
  byteLength: number;
};

/**
 * GET {peerUrl}/query?q={spacesName} — binary octet-stream response from anchor relay.
 * Relay URLs to try for /query, preferring the anchors peer then bootstrap seeds.
 */
export function getQueryRelayUrls(
  primaryPeerUrl?: string | null,
  noDns = false
): string[] {
  const urls = new Set<string>();
  if (primaryPeerUrl && (!noDns || isIpAddressUrl(primaryPeerUrl))) {
    urls.add(normalizeBaseUrl(primaryPeerUrl));
  }
  for (const seed of BOOTSTRAP_SERVERS) {
    if (!noDns || isIpAddressUrl(seed)) {
      urls.add(normalizeBaseUrl(seed));
    }
  }
  return [...urls];
}

/**
 * libveritas chainProofRequest() returns a JSON string on native; Node may return an object.
 */
export function serializeChainProofRequest(chainProofRequest: unknown): string {
  if (typeof chainProofRequest === 'string') {
    return chainProofRequest;
  }
  return JSON.stringify(chainProofRequest);
}

/**
 * POST {peerUrl}/chain-proof — binary chain proof for MessageBuilder.build().
 * Tries relays in order until one succeeds.
 */
export async function fetchChainProofFromRelays(
  chainProofRequest: unknown,
  relayUrls: string[]
): Promise<{ data: ArrayBuffer; peerUrl: string }> {
  const body = serializeChainProofRequest(chainProofRequest);
  const urls = relayUrls.filter(Boolean).map(normalizeBaseUrl);
  if (urls.length === 0) {
    throw new Error('No relays available for chain proof.');
  }

  let lastError = 'No relays available for chain proof.';
  for (const peerUrl of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${peerUrl}/chain-proof`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/octet-stream',
          'Content-Type': 'application/json',
        },
        body,
      });
      if (!response.ok) {
        const text = await response.text();
        lastError = text.trim()
          ? `HTTP ${response.status} from ${peerUrl}: ${text.trim().slice(0, 500)}`
          : `HTTP ${response.status} from ${peerUrl} (empty response body)`;
        continue;
      }
      const data = await response.arrayBuffer();
      if (data.byteLength === 0) {
        lastError = `Empty chain proof from ${peerUrl}`;
        continue;
      }
      return { data, peerUrl };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(lastError);
}

export async function querySpacesFromAnchorServer(
  peerUrl: string,
  spacesName: string,
  hints?: string
): Promise<QuerySpacesResult> {
  const trimmed = spacesName.trim();
  if (!trimmed) {
    throw new Error('spaces name is required');
  }

  let url = `${normalizeBaseUrl(peerUrl)}/query?q=${encodeURIComponent(trimmed)}`;
  if (hints) {
    url += `&hints=${encodeURIComponent(hints)}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/octet-stream' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const data = await response.arrayBuffer();
    return { data, byteLength: data.byteLength };
  } finally {
    clearTimeout(timer);
  }
}
