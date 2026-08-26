import { AccountService } from '@spacesops/wdk-react-native-core';
import { WDKService } from '@/services/wdk-service';

export type UpdateOnchainHexParams = {
  network: string;
  fundingAccountIndex: number;
  options: {
    to: string;
    hex: string;
    priorTx: string;
    priorAccountRelativePath: string;
    value?: string;
    feeRate?: string;
    confirmationTarget?: number;
  };
};

export type DerivedTaprootAddressEntry = {
  address: string;
  scriptPubKeyHex: string;
  internalPubKeyHex?: string;
  privateKeyHex?: string;
  tweakedPrivateKeyHex?: string;
};

type TaprootKeyMaterialHex = {
  internalPubKeyHex?: string;
  privateKeyHex?: string;
  tweakedPrivateKeyHex?: string;
} | null;

const derivedByRelativePath = new Map<string, DerivedTaprootAddressEntry>();

function hasKeyMaterial(entry: DerivedTaprootAddressEntry | undefined): boolean {
  return Boolean(
    entry?.internalPubKeyHex && entry.privateKeyHex && entry.tweakedPrivateKeyHex
  );
}

/**
 * Derive Taproot addresses / scriptPubKeys / optional key material for BIP-relative paths
 * via worklet `callMethodByPath` → `getAccountByPath`.
 */
async function deriveTaprootAddressesFromPaths(
  relativePaths: string[],
  options?: { includeKeyMaterial?: boolean }
): Promise<{ addressesJson: string }> {
  if (!Array.isArray(relativePaths)) {
    throw new Error('relativePaths must be an array of path suffix strings');
  }

  const wantKeys = Boolean(options?.includeKeyMaterial);
  const entries: DerivedTaprootAddressEntry[] = [];

  for (const rel of relativePaths) {
    if (typeof rel !== 'string' || rel.trim().length === 0) {
      throw new Error('Each relative path must be a non-empty string');
    }
    const path = rel.trim();
    const cached = derivedByRelativePath.get(path);
    if (cached && (!wantKeys || hasKeyMaterial(cached))) {
      entries.push(cached);
      continue;
    }

    const entry: DerivedTaprootAddressEntry = { ...(cached ?? { address: '', scriptPubKeyHex: '' }) };

    if (!entry.address) {
      const address = await AccountService.callAccountMethodByPath<string>(
        'bitcoin',
        path,
        'getAddress'
      );
      if (typeof address !== 'string' || address.length === 0) {
        throw new Error(`getAddress returned no address for path ${path}`);
      }
      entry.address = address;
    }

    if (!entry.scriptPubKeyHex) {
      const scriptPubKeyHex = await AccountService.callAccountMethodByPath<string>(
        'bitcoin',
        path,
        'getScriptPubKeyHex',
        entry.address
      );
      if (typeof scriptPubKeyHex !== 'string' || scriptPubKeyHex.length === 0) {
        throw new Error(`getScriptPubKeyHex returned empty for path ${path}`);
      }
      entry.scriptPubKeyHex = scriptPubKeyHex;
    }

    if (wantKeys && !hasKeyMaterial(entry)) {
      try {
        const keys = await AccountService.callAccountMethodByPath<TaprootKeyMaterialHex>(
          'bitcoin',
          path,
          'getTaprootKeyMaterialHex'
        );
        if (keys && typeof keys === 'object') {
          if (keys.internalPubKeyHex) entry.internalPubKeyHex = keys.internalPubKeyHex;
          if (keys.privateKeyHex) entry.privateKeyHex = keys.privateKeyHex;
          if (keys.tweakedPrivateKeyHex) {
            entry.tweakedPrivateKeyHex = keys.tweakedPrivateKeyHex;
          }
        }
      } catch (e) {
        console.warn('[Spaces] getTaprootKeyMaterialHex failed for', path, e);
      }
    }

    derivedByRelativePath.set(path, entry);
    entries.push(entry);
  }

  return { addressesJson: JSON.stringify(entries) };
}

function missingOnchainUpdate(method: string): never {
  throw new Error(
    `${method} is not available in @spacesops/wdk-react-native-core yet — needs a dedicated pear HRPC method`
  );
}

/**
 * Spaces helpers on top of WDKService / AccountService.
 */
export const WDKSpaces = {
  ...WDKService,

  deriveTaprootAddressesFromPaths,

  async quoteUpdateTransactionWithHexTX(
    _params: UpdateOnchainHexParams
  ): Promise<{ txHex: string; fee?: string }> {
    return missingOnchainUpdate('quoteUpdateTransactionWithHexTX');
  },

  async updateTransactionWithHex(
    _params: UpdateOnchainHexParams
  ): Promise<{ hash: string; fee: string }> {
    return missingOnchainUpdate('updateTransactionWithHex');
  },
};
