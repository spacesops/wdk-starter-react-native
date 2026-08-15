import { AssetTicker } from '@/config/assets';
import getChainsConfig from '@/config/get-chains-config';
import { NetworkType } from '@/config/networks';
import { WDKService } from '@/services/wdk-service';

export interface GasFeeEstimate {
  fee?: number;
  error?: string;
}

const QUOTE_RECIPIENTS = {
  [AssetTicker.BTC]: {
    networks: {
      // [NetworkType.SEGWIT]: 'bc1qh96eg54ddu4q2cmn0n6g8uymuqlw402jndphu9',
      [NetworkType.SEGWIT]: 'bc1pcp2p7nzg8kknr42w6yel8k7hpy5tedjpacnwlvtfhzgmaq6u4qnq06nhac',
    },
  },
  [AssetTicker.USDT]: {
    networks: {
      [NetworkType.ETHEREUM]: '0x8d42eb95360bf68d65e5a810986b2ebd88c5e606',
      [NetworkType.POLYGON]: '0x8d42eb95360bf68d65e5a810986b2ebd88c5e606',
      [NetworkType.ARBITRUM]: '0x8d42eb95360bf68d65e5a810986b2ebd88c5e606',
      [NetworkType.TON]: 'EQD5mxRgCuRNLxKxeOjG6r14iSroLF5FtomPnet-sgP5xNJb',
      [NetworkType.TRON]: 'TLDCVJBtvYXJb2fEEk5pPoApHZbyuf2TyG',
      [NetworkType.SOLANA]: '74xb5G9LTr1J45HPcLqz6VF4NHVQtRqrTDD1MQ8D7zer',
    },
  },
  [AssetTicker.XAUT]: {
    networks: {
      [NetworkType.ETHEREUM]: '0x8d42eb95360bf68d65e5a810986b2ebd88c5e606',
      [NetworkType.POLYGON]: '0x8d42eb95360bf68d65e5a810986b2ebd88c5e606',
      [NetworkType.ARBITRUM]: '0x8d42eb95360bf68d65e5a810986b2ebd88c5e606',
      [NetworkType.TON]: 'EQD5mxRgCuRNLxKxeOjG6r14iSroLF5FtomPnet-sgP5xNJb',
    },
  },
  [AssetTicker.USAT]: {
    networks: {
      [NetworkType.ETHEREUM]: '0x8d42eb95360bf68d65e5a810986b2ebd88c5e606',
    },
  },
};

// Network type mapping
export const getNetworkType = (networkId: string): NetworkType => {
  const networkMap: Record<string, NetworkType> = {
    ethereum: NetworkType.ETHEREUM,
    polygon: NetworkType.POLYGON,
    arbitrum: NetworkType.ARBITRUM,
    bitcoin: NetworkType.SEGWIT,
    lightning: NetworkType.LIGHTNING,
    ton: NetworkType.TON,
    tron: NetworkType.TRON,
    solana: NetworkType.SOLANA,
  };
  return networkMap[networkId] || NetworkType.ETHEREUM;
};

// Asset ticker mapping
export const getAssetTicker = (tokenId: string): AssetTicker => {
  const assetMap: Record<string, AssetTicker> = {
    btc: AssetTicker.BTC,
    usdt: AssetTicker.USDT,
    xaut: AssetTicker.XAUT,
    usat: AssetTicker.USAT,
  };
  return assetMap[tokenId?.toLowerCase()] || AssetTicker.USDT;
};

/**
 * Pre-calculates gas fee using dummy values
 * This is useful for showing an estimated fee before the user enters transaction details
 */
export const calculateGasFee = async (
  networkId: string,
  tokenId: string,
  amount?: number
): Promise<GasFeeEstimate> => {
  try {
    const networkType = getNetworkType(networkId);
    const assetTicker = getAssetTicker(tokenId);
    // @ts-expect-error
    const quoteRecipient = QUOTE_RECIPIENTS[assetTicker].networks[networkType];

    if (!amount && networkType === NetworkType.SEGWIT) {
      return {
        fee: undefined,
        error: 'Insufficient balance for fee calculation',
      };
    }

    // For Bitcoin, WDKService.quoteSendByNetwork expects amount in BTC and will multiply by 100000000
    // to convert to satoshis internally. The amount parameter should be in BTC (e.g., 0.0003), not satoshis.
    // If the amount is already in satoshis (e.g., 30000), we need to divide by 100000000 to convert to BTC.
    // We check if the amount is > 1 (likely satoshis) and divide if needed, otherwise assume it's already in BTC.
    let btcAmount = assetTicker === AssetTicker.BTC ? parseFloat(amount!.toFixed(8)) : 1;
    if (assetTicker === AssetTicker.BTC && amount! > 1) {
      // Amount appears to be in satoshis, convert to BTC
      btcAmount = amount! / 100000000;
    }

    // Check if Bitcoin script_type is P2TR, and use memo method if so
    let gasFee: number;
    if (assetTicker === AssetTicker.BTC && networkType === NetworkType.SEGWIT) {
      const chainsConfig = getChainsConfig();
      const bitcoinConfig = chainsConfig.bitcoin;
      const scriptType = bitcoinConfig?.script_type;

      if (scriptType === 'P2TR') {
        const memoHex = process.env.EXPO_PUBLIC_BITCOIN_P2TR_MEMO;
        if (!memoHex) {
          throw new Error(
            'EXPO_PUBLIC_BITCOIN_P2TR_MEMO environment variable is required for P2TR transactions'
          );
        }
        // Pass hex string directly as memo (environment variable is already a string)
        const memo = memoHex;
        gasFee = await WDKService.quoteSendByNetworkWithMemo(
          networkType,
          0, // account index
          btcAmount,
          quoteRecipient,
          assetTicker,
          memo
        );
      } else {
        gasFee = await WDKService.quoteSendByNetwork(
          networkType,
          0, // account index
          btcAmount,
          quoteRecipient,
          assetTicker
        );
      }
    } else {
      gasFee = await WDKService.quoteSendByNetwork(
        networkType,
        0, // account index
        btcAmount,
        quoteRecipient,
        assetTicker
      );
    }

    return { fee: gasFee };
  } catch (error) {
    console.error('Gas fee pre-calculation failed:', error);
    const networkType = getNetworkType(networkId);
    const isBitcoinNetwork =
      networkType === NetworkType.SEGWIT || networkType === NetworkType.LIGHTNING;

    if (
      isBitcoinNetwork &&
      error instanceof Error &&
      error.message.includes('Insufficient balance')
    ) {
      return {
        fee: undefined,
        error: 'Insufficient balance for fee calculation',
      };
    } else if (
      isBitcoinNetwork &&
      error instanceof Error &&
      error.message.includes('amount must be bigger than the dust limit')
    ) {
      return {
        fee: undefined,
        error: `The amount must be bigger than the dust limit`,
      };
    } else {
      return {
        fee: undefined,
        error: error instanceof Error ? error.message : 'Failed to calculate fee',
      };
    }
  }
};
