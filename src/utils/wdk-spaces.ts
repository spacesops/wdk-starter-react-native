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

/**
 * Derive Taproot addresses / scriptPubKeys / optional key material for BIP-relative paths
 * via worklet `callMethodByPath` → `getAccountByPath`.
 */
async function deriveTaprootAddressesFromPaths(
  relativePaths: string[]
): Promise<{ addressesJson: string }> {
  if (!Array.isArray(relativePaths)) {
    throw new Error('relativePaths must be an array of path suffix strings');
  }

  const entries: DerivedTaprootAddressEntry[] = [];

  for (const rel of relativePaths) {
    if (typeof rel !== 'string' || rel.trim().length === 0) {
      throw new Error('Each relative path must be a non-empty string');
    }
    const path = rel.trim();

    const address = await AccountService.callAccountMethodByPath<string>(
      'bitcoin',
      path,
      'getAddress'
    );
    if (typeof address !== 'string' || address.length === 0) {
      throw new Error(`getAddress returned no address for path ${path}`);
    }

    const scriptPubKeyHex = await AccountService.callAccountMethodByPath<string>(
      'bitcoin',
      path,
      'getScriptPubKeyHex',
      address
    );
    if (typeof scriptPubKeyHex !== 'string' || scriptPubKeyHex.length === 0) {
      throw new Error(`getScriptPubKeyHex returned empty for path ${path}`);
    }

    const entry: DerivedTaprootAddressEntry = { address, scriptPubKeyHex };

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
    } catch {
      // Key material is optional for Find Spaces / path reservation.
    }

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
