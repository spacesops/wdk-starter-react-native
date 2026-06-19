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
 * First BIP-86 scan path whose script pubkey is off-chain and not reserved by another space row.
 * Used after PUT confirm so first-time purchases can send script_pubkey with watch-payment.
 */
export async function resolveNextAvailableTaprootPath(params: {
  baseUrl: string;
  /** Lowercase hex spks already assigned to other handles in My Spaces. */
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

  const reserved = new Set<string>();
  if (params.reservedScriptPubKeys) {
    for (const spk of params.reservedScriptPubKeys) {
      const n = normalizeSpk(spk);
      if (n) {
        reserved.add(n);
      }
    }
  }

  for (let i = 0; i < rels.length; i++) {
    const entry = entries[i];
    const spk = entry?.scriptPubKeyHex?.trim();
    const address = entry?.address?.trim();
    if (!spk || !address) {
      continue;
    }
    if (reserved.has(normalizeSpk(spk))) {
      continue;
    }
    const onChain = await isScriptPubKeyOnChain(params.baseUrl, spk);
    if (onChain) {
      continue;
    }
    const fullPath = fullPaths[i] ?? `m/${bip}'/${coinType}'/${rels[i]}`;
    return {
      fullPath,
      relativePath: rels[i],
      scriptPubKeyHex: spk,
      address,
    };
  }

  return null;
}
