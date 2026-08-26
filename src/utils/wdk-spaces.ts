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
 * Derive Taproot addresses / scriptPubKeys / optional key material for BIP-relative paths.
 * Prefers the worklet batch HRPC; falls back to per-path callMethodByPath.
 */
async function deriveTaprootAddressesFromPaths(
  relativePaths: string[],
  options?: { includeKeyMaterial?: boolean }
): Promise<{ addressesJson: string }> {
  if (!Array.isArray(relativePaths)) {
    throw new Error('relativePaths must be an array of path suffix strings');
  }

  const batch = (
    AccountService as {
      deriveTaprootAddressesFromPaths?: (
        paths: string[],
        opts?: { network?: string; includeKeyMaterial?: boolean }
      ) => Promise<{ addressesJson: string }>;
    }
  ).deriveTaprootAddressesFromPaths;

  if (typeof batch === 'function') {
    try {
      return await batch(relativePaths, {
        network: 'bitcoin',
        includeKeyMaterial: options?.includeKeyMaterial,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/deriveTaprootAddressesFromPaths is not available/.test(msg)) {
        throw e;
      }
    }
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

/**
 * Spaces helpers on top of WDKService / AccountService.
 */
export const WDKSpaces = {
  ...WDKService,

  deriveTaprootAddressesFromPaths,

  async quoteUpdateTransactionWithHexTX(
    params: UpdateOnchainHexParams
  ): Promise<{ txHex: string; fee?: string }> {
    const result = await AccountService.callAccountMethod<
      { hex?: string; txHex?: string; fee?: string | number } | string
    >(
      params.network,
      params.fundingAccountIndex,
      'quoteUpdateTransactionWithHexTX',
      params.options
    );
    const txHex =
      typeof result === 'string' ? result : result?.txHex || result?.hex || '';
    if (!txHex) {
      throw new Error('quoteUpdateTransactionWithHexTX returned no transaction hex');
    }
    const fee =
      typeof result === 'object' && result?.fee != null ? String(result.fee) : undefined;
    return fee != null ? { txHex, fee } : { txHex };
  },

  async updateTransactionWithHex(
    params: UpdateOnchainHexParams
  ): Promise<{ hash: string; fee: string }> {
    const result = await AccountService.callAccountMethod<{
      hash?: string;
      fee?: string | number;
    }>(
      params.network,
      params.fundingAccountIndex,
      'updateTransactionWithHex',
      params.options
    );
    const hash = result?.hash ? String(result.hash) : '';
    if (!hash) {
      throw new Error('updateTransactionWithHex returned no transaction hash');
    }
    return { hash, fee: result?.fee != null ? String(result.fee) : '0' };
  },
};
