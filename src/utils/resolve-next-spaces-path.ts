import {
  buildSpacesScanDerivationPaths,
  fullPathToWalletRelativePath,
  getBitcoinTaprootPathPrefix,
} from '@/utils/spaces-scan-paths';
import { WDKSpaces } from '@/utils/wdk-spaces';

export type NextAvailableTaprootPath = {
  fullPath: string;
  relativePath: string;
  scriptPubKeyHex: string;
  address: string;
};

function normalizeSpk(spk: string): string {
  return spk.trim().toLowerCase();
}

/** Last `/0/{index}` segment of a Spaces taproot scan path. */
export function parseTaprootPathAddressIndex(fullPath: string): number | null {
  const match = fullPath.trim().match(/\/0\/(\d+)$/);
  if (!match) {
    return null;
  }
  const idx = Number.parseInt(match[1]!, 10);
  return Number.isFinite(idx) && idx >= 0 ? idx : null;
}

export function maxUsedTaprootPathIndex(params: {
  reservedDerivationPaths?: Iterable<string>;
  reservedScriptPubKeys?: Iterable<string>;
  pathEntries?: { scriptPubKeyHex?: string }[];
}): number {
  let max = -1;

  for (const path of params.reservedDerivationPaths ?? []) {
    const idx = parseTaprootPathAddressIndex(path);
    if (idx !== null && idx > max) {
      max = idx;
    }
  }

  if (params.reservedScriptPubKeys && params.pathEntries) {
    for (const spk of params.reservedScriptPubKeys) {
      const normalized = normalizeSpk(spk);
      if (!normalized) {
        continue;
      }
      const idx = params.pathEntries.findIndex(
        (entry) => entry.scriptPubKeyHex && normalizeSpk(entry.scriptPubKeyHex) === normalized
      );
      if (idx >= 0 && idx > max) {
        max = idx;
      }
    }
  }

  return max;
}

async function isScriptPubKeyOnChain(baseUrl: string, scriptPubKeyHex: string): Promise<boolean> {
  const b = baseUrl.replace(/\/$/, '');
  const url = `${b}/api/listnums-by-spk?script_pubkey=${encodeURIComponent(scriptPubKeyHex.trim())}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('[Spaces] listnums-by-spk (path scan)', { status: res.status, url });
      return false;
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const nums = (body as { nums?: unknown[] } | null)?.nums;
    return Array.isArray(nums) && nums.length > 0;
  } catch (e) {
    console.warn('[Spaces] listnums-by-spk (path scan) failed', e);
    return false;
  }
}

/**
 * Next BIP-86 scan path: index one greater than the largest already used in My Spaces.
 * Never reuses a reserved derivation path or script pubkey from another row.
 */
export async function resolveNextAvailableTaprootPath(params: {
  baseUrl: string;
  /** Full BIP-86 paths already assigned in My Spaces — never reuse. */
  reservedDerivationPaths?: Iterable<string>;
  /** Lowercase hex spks already assigned when derivation path is missing on a row. */
  reservedScriptPubKeys?: Iterable<string>;
}): Promise<NextAvailableTaprootPath | null> {
  const fullPaths = buildSpacesScanDerivationPaths();
  if (fullPaths.length === 0) {
    console.warn(
      '[Spaces] resolveNextAvailableTaprootPath: no scan paths (check EXPO_PUBLIC_SPACES_ACCOUNT_NUMBER / GAP)'
    );
    return null;
  }

  const { bip, coinType } = getBitcoinTaprootPathPrefix();
  const rels: string[] = [];
  for (const p of fullPaths) {
    const rel = fullPathToWalletRelativePath(p, bip, coinType);
    if (rel) {
      rels.push(rel);
    }
  }
  if (rels.length === 0) {
    return null;
  }

  let entries: { address?: string; scriptPubKeyHex?: string }[];
  try {
    const { addressesJson } = await WDKSpaces.deriveTaprootAddressesFromPaths(rels);
    entries = JSON.parse(addressesJson) as { address?: string; scriptPubKeyHex?: string }[];
  } catch (e) {
    console.error('[Spaces] deriveTaprootAddressesFromPaths failed:', e);
    return null;
  }

  const maxUsedIndex = maxUsedTaprootPathIndex({
    reservedDerivationPaths: params.reservedDerivationPaths,
    reservedScriptPubKeys: params.reservedScriptPubKeys,
    pathEntries: entries,
  });
  const nextIndex = maxUsedIndex + 1;

  if (nextIndex >= fullPaths.length) {
    console.warn('[Spaces] resolveNextAvailableTaprootPath: no paths left after index', maxUsedIndex);
    return null;
  }

  const entry = entries[nextIndex];
  const spk = entry?.scriptPubKeyHex?.trim();
  const address = entry?.address?.trim();
  if (!spk || !address) {
    console.warn('[Spaces] resolveNextAvailableTaprootPath: missing address/spk at index', nextIndex);
    return null;
  }

  const onChain = await isScriptPubKeyOnChain(params.baseUrl, spk);
  if (onChain) {
    console.warn(
      '[Spaces] resolveNextAvailableTaprootPath: next path index already on-chain',
      nextIndex
    );
    return null;
  }

  const fullPath = fullPaths[nextIndex] ?? `m/${bip}'/${coinType}'/${rels[nextIndex]}`;
  console.log('[Spaces] resolveNextAvailableTaprootPath: selected index', nextIndex, {
    maxUsedIndex,
    fullPath,
  });

  return {
    fullPath,
    relativePath: rels[nextIndex]!,
    scriptPubKeyHex: spk,
    address,
  };
}
