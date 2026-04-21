import { WDKService } from '@tetherto/wdk-react-native-provider';

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

/**
 * Local extension of WDKService for Spaces (Taproot path helpers + on-chain update quote/broadcast).
 * Align with @tetherto/wdk-react-native-provider when published types include these methods.
 */
export const WDKSpaces = WDKService as typeof WDKService & {
  deriveTaprootAddressesFromPaths(
    relativePaths: string[]
  ): Promise<{ addressesJson: string }>;
  quoteUpdateTransactionWithHexTX(
    params: UpdateOnchainHexParams
  ): Promise<{ txHex: string; fee?: string }>;
  updateTransactionWithHex(
    params: UpdateOnchainHexParams
  ): Promise<{ hash: string; fee: string }>;
};
