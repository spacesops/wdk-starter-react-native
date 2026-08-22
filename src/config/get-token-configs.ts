import type { TokenConfigs } from '@spacesops/wdk-react-native-core';

/**
 * Token configs for Spaces Wallet balance queries (bitcoin + EVM + TON + Tron + Solana).
 * Parent may refine; values match get-chains-config paymaster / known mainnet tokens.
 */
const ALL_TOKEN_CONFIGS: TokenConfigs = {
  bitcoin: {
    indexerBlockchain: 'bitcoin',
    native: { address: null, symbol: 'BTC', name: 'Bitcoin', decimals: 8, indexerToken: 'btc' },
    tokens: [],
  },
  ethereum: {
    indexerBlockchain: 'ethereum',
    native: { address: null, symbol: 'ETH', name: 'Ethereum', decimals: 18 },
    tokens: [
      {
        address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        symbol: 'USDT',
        name: 'Tether USD',
        decimals: 6,
      },
      {
        address: '0x68749665FF8D2d112Fa859AA293F07A622782F38',
        symbol: 'XAUT',
        name: 'Tether Gold',
        decimals: 6,
      },
      {
        address: '0x07041776f5007ACa2A54844F50503a18A72A8b68',
        symbol: 'USAT',
        name: 'Tether America USD',
        decimals: 6,
      },
    ],
  },
  polygon: {
    indexerBlockchain: 'polygon',
    native: { address: null, symbol: 'MATIC', name: 'Polygon', decimals: 18 },
    tokens: [
      {
        address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
        symbol: 'USDT',
        name: 'Tether USD',
        decimals: 6,
      },
    ],
  },
  arbitrum: {
    indexerBlockchain: 'arbitrum',
    native: { address: null, symbol: 'ETH', name: 'Ethereum', decimals: 18 },
    tokens: [
      {
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        symbol: 'USDT',
        name: 'Tether USD',
        decimals: 6,
      },
    ],
  },
  ton: {
    native: { address: null, symbol: 'TON', name: 'Toncoin', decimals: 9 },
    tokens: [
      {
        address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
        symbol: 'USDT',
        name: 'Tether USD',
        decimals: 6,
      },
    ],
  },
  tron: {
    native: { address: null, symbol: 'TRX', name: 'TRON', decimals: 6 },
    tokens: [
      {
        address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        symbol: 'USDT',
        name: 'Tether USD',
        decimals: 6,
      },
    ],
  },
  solana: {
    native: { address: null, symbol: 'SOL', name: 'Solana', decimals: 9 },
    tokens: [
      {
        address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        symbol: 'USDT',
        name: 'Tether USD',
        decimals: 6,
      },
    ],
  },
};

const getTokenConfigs = (): TokenConfigs => ALL_TOKEN_CONFIGS;

/** Networks that have WDK Indexer transaction history enabled. */
export const INDEXER_WALLET_NETWORKS = (
  Object.entries(ALL_TOKEN_CONFIGS) as [string, TokenConfigs[string]][]
)
  .filter(([, config]) => config.indexerBlockchain)
  .map(([network]) => network);

export default getTokenConfigs;
