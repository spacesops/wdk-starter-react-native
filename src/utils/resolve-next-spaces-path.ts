import { deriveBip86TaprootFromMnemonic } from '@/utils/derive-bip86-taproot';
import getChainsConfig from '@/config/get-chains-config';
import {
  buildSpacesScanDerivationPaths,
  fullPathToWalletRelativePath,
  getBitcoinTaprootPathPrefix,
  getSpacesAccountNumber,
  parseSpacesScanPathIndex,
} from '@/utils/spaces-scan-paths';
import { WDKSpaces, type DerivedTaprootAddressEntry } from '@/utils/wdk-spaces';

export type NextAvailableTaprootPath = {
  fullPath: string;
  relativePath: string;
  scriptPubKeyHex: string;
  address: string;
  internalPubKeyHex?: string;
  privateKeyHex?: string;
  tweakedPrivateKeyHex?: string;
};

function normalizeSpk(spk: string): string {
  return spk.trim().toLowerCase();
}

/** Last `/0/{index}` segment of a Spaces taproot scan path. */
export function parseTaprootPathAddressIndex(fullPath: string): number | null {
  return parseSpacesScanPathIndex(fullPath);
}

export function maxUsedTaprootPathIndex(params: {
  reservedDerivationPaths?: Iterable<string>;
  reservedScriptPubKeys?: Iterable<string>;
  pathEntries?: { scriptPubKeyHex?: string }[];
}): number {
  let max = -1;

  for (const path of params.reservedDerivationPaths ?? []) {
    const idx = parseSpacesScanPathIndex(path);
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

/**
 * Next Spaces scan path: `m/86'/0'/{account}'/0/{max+1}` where `max` is the
 * highest address index already assigned to a handle.
 *
 * When `mnemonic` is provided, derivation is local (no worklet). Use that on
 * the free-coupon path — `getAccountByPath` hangs during checkout.
 */
export async function resolveNextAvailableTaprootPath(params: {
  /** Unused; kept so callers can pass the Spaces API base URL. */
  baseUrl?: string;
  /** Full BIP-86 Spaces-account paths already assigned in My Spaces — never reuse. */
  reservedDerivationPaths?: Iterable<string>;
  /** Kept for callers; index is taken from reserved derivation paths only. */
  reservedScriptPubKeys?: Iterable<string>;
  /** Wallet mnemonic — derive BIP-86 locally instead of the Bare worklet. */
  mnemonic?: string;
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

  const maxFromPaths = maxUsedTaprootPathIndex({
    reservedDerivationPaths: params.reservedDerivationPaths,
  });
  const nextIndex = maxFromPaths + 1;
  if (nextIndex < 0 || nextIndex >= fullPaths.length) {
    console.warn('[Spaces] resolveNextAvailableTaprootPath: no unused path after index', maxFromPaths);
    return null;
  }

  const rel = rels[nextIndex];
  const fullPath = fullPaths[nextIndex] ?? `m/${bip}'/${coinType}'/${rel}`;
  if (!rel) {
    return null;
  }

  const mnemonic = params.mnemonic?.trim();
  if (mnemonic) {
    try {
      const bitcoinNetwork = (getChainsConfig().bitcoin as { network?: string } | undefined)?.network;
      const derived = deriveBip86TaprootFromMnemonic({
        mnemonic,
        account: getSpacesAccountNumber(),
        index: nextIndex,
        coinType,
        network: bitcoinNetwork,
      });
      console.log('[Spaces] resolveNextAvailableTaprootPath: local BIP-86 derive', {
        maxFromPaths,
        fullPath: derived.fullPath,
        address: derived.address,
      });
      return derived;
    } catch (e) {
      console.error('[Spaces] local BIP-86 derive failed:', e);
      return null;
    }
  }

  let entry: DerivedTaprootAddressEntry | undefined;
  try {
    const { addressesJson } = await WDKSpaces.deriveTaprootAddressesFromPaths([rel], {
      includeKeyMaterial: true,
    });
    entry = (JSON.parse(addressesJson) as DerivedTaprootAddressEntry[])[0];
  } catch (e) {
    console.error('[Spaces] deriveTaprootAddressesFromPaths failed:', e);
    return null;
  }

  const spk = entry?.scriptPubKeyHex?.trim();
  const address = entry?.address?.trim();
  if (!spk || !address) {
    console.warn('[Spaces] resolveNextAvailableTaprootPath: missing address/spk at index', nextIndex);
    return null;
  }

  console.log('[Spaces] resolveNextAvailableTaprootPath: selected index', nextIndex, {
    maxFromPaths,
    fullPath,
    address,
    hasPrivateKey: Boolean(entry.privateKeyHex),
    hasTweakedPrivateKey: Boolean(entry.tweakedPrivateKeyHex),
    hasInternalPubKey: Boolean(entry.internalPubKeyHex),
  });

  return {
    fullPath,
    relativePath: rel,
    scriptPubKeyHex: spk,
    address,
    internalPubKeyHex: entry.internalPubKeyHex,
    privateKeyHex: entry.privateKeyHex,
    tweakedPrivateKeyHex: entry.tweakedPrivateKeyHex,
  };
}
