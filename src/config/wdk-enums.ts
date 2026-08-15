/**
 * Local replacements for enums previously exported by
 * @tetherto/wdk-react-native-provider. Values match the old provider so
 * Spaces / send / receive call sites keep working.
 */

export enum NetworkType {
  ETHEREUM = 'ethereum',
  POLYGON = 'polygon',
  ARBITRUM = 'arbitrum',
  TON = 'ton',
  TRON = 'tron',
  SOLANA = 'solana',
  /** Bitcoin (Taproot / SegWit) — chain config key is `bitcoin`. */
  SEGWIT = 'bitcoin',
  LIGHTNING = 'lightning',
}

export enum AssetTicker {
  BTC = 'btc',
  USDT = 'usdt',
  XAUT = 'xaut',
  USAT = 'usat',
}
