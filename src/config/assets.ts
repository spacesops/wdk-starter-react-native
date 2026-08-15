import { FiatCurrency } from '@/services/pricing-service';
import { AssetTicker, NetworkType } from './wdk-enums';

export { AssetTicker } from './wdk-enums';

export interface AssetConfig {
  name: string;
  symbol: string;
  icon: any;
  color: string;
  supportedNetworks: NetworkType[];
}

export interface Asset {
  id: string;
  name: string;
  symbol: string;
  amount: string;
  fiatValue: number;
  fiatCurrency: FiatCurrency;
  icon: string | any;
  color: string;
}

/** Assets enabled in the wallet UI (replaces old wallet.enabledAssets). */
export const ENABLED_ASSET_TICKERS: AssetTicker[] = [
  AssetTicker.BTC,
  AssetTicker.USDT,
  AssetTicker.XAUT,
  AssetTicker.USAT,
];

export const assetConfig: Record<string, AssetConfig> = {
  btc: {
    name: 'Bitcoin',
    symbol: 'BTC',
    icon: require('../../assets/images/tokens/bitcoin-btc-logo.png'),
    color: '#ffffff',
    supportedNetworks: [NetworkType.SEGWIT],
  },
  usdt: {
    name: 'USD₮',
    symbol: 'USD₮',
    icon: require('../../assets/images/tokens/tether-usdt-logo.png'),
    color: '#ffffff',
    // supportedNetworks: [NetworkType.ETHEREUM],
    supportedNetworks: [
      NetworkType.ETHEREUM,
      NetworkType.POLYGON,
      NetworkType.ARBITRUM,
      NetworkType.TON,
      NetworkType.TRON,
      NetworkType.SOLANA,
    ],
  },
  xaut: {
    name: 'XAU₮',
    symbol: 'XAU₮',
    icon: require('../../assets/images/tokens/tether-xaut-logo.png'),
    color: '#ffffff',
    supportedNetworks: [NetworkType.ETHEREUM],
  },
  usat: {
    name: 'USA₮',
    symbol: 'USA₮',
    icon: require('../../assets/images/tokens/tether-usat-logo.png'),
    color: '#ffffff',
    supportedNetworks: [NetworkType.ETHEREUM],
  },
};
