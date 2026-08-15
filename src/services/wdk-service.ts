/**
 * Compatibility facade for the old WDKService singleton API, backed by
 * @spacesops/wdk-react-native-core AccountService.callAccountMethod.
 */

import { AccountService } from '@spacesops/wdk-react-native-core';
import { AssetTicker } from '@/config/assets';
import { NetworkType } from '@/config/networks';

function toNetworkName(network: NetworkType | string): string {
  return String(network);
}

function toBtcValue(amount: number): number {
  // Account methods expect BTC units (not sats), matching previous WDKService.
  return Number(amount);
}

async function callBitcoin<T>(
  accountIndex: number,
  methodName: string,
  args: unknown
): Promise<T> {
  return AccountService.callAccountMethod<T>(
    'bitcoin',
    accountIndex,
    methodName,
    args
  );
}

function unwrapFee(result: unknown): number {
  if (typeof result === 'number') return result;
  if (result && typeof result === 'object' && 'fee' in result) {
    const fee = (result as { fee: string | number }).fee;
    return typeof fee === 'number' ? fee : Number(fee);
  }
  return Number(result);
}

function unwrapHash(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'hash' in result) {
    return String((result as { hash: string }).hash);
  }
  return String(result);
}

export const WDKService = {
  getDenominationValue(token: AssetTicker | string): number {
    switch (String(token).toLowerCase()) {
      case AssetTicker.BTC:
      case 'btc':
        return 1e8;
      case AssetTicker.USDT:
      case AssetTicker.XAUT:
      case AssetTicker.USAT:
      case 'usdt':
      case 'xaut':
      case 'usat':
        return 1e6;
      default:
        return 1e18;
    }
  },

  async sendByNetwork(
    network: NetworkType | string,
    accountIndex: number,
    amount: number,
    to: string,
    _asset: AssetTicker | string
  ): Promise<string> {
    const networkName = toNetworkName(network);
    const result = await AccountService.callAccountMethod(
      networkName,
      accountIndex,
      'sendTransaction',
      { to, value: toBtcValue(amount) }
    );
    return unwrapHash(result);
  },

  async sendByNetworkWithMemo(
    network: NetworkType | string,
    accountIndex: number,
    amount: number,
    to: string,
    _asset: AssetTicker | string,
    memo: string
  ): Promise<string> {
    const result = await callBitcoin(
      accountIndex,
      'sendTransactionWithMemo',
      { to, value: toBtcValue(amount), memo }
    );
    return unwrapHash(result);
  },

  async quoteSendByNetwork(
    network: NetworkType | string,
    accountIndex: number,
    amount: number,
    to: string,
    _asset: AssetTicker | string
  ): Promise<number> {
    const networkName = toNetworkName(network);
    const result = await AccountService.callAccountMethod(
      networkName,
      accountIndex,
      'quoteSendTransaction',
      { to, value: toBtcValue(amount) }
    );
    return unwrapFee(result);
  },

  async quoteSendByNetworkWithMemo(
    network: NetworkType | string,
    accountIndex: number,
    amount: number,
    to: string,
    _asset: AssetTicker | string,
    memo: string
  ): Promise<number> {
    const result = await callBitcoin(
      accountIndex,
      'quoteSendTransactionWithMemo',
      { to, value: toBtcValue(amount), memo }
    );
    return unwrapFee(result);
  },

  async quoteSendByNetworkTX(
    network: NetworkType | string,
    accountIndex: number,
    amount: number,
    to: string,
    _asset: AssetTicker | string
  ): Promise<string> {
    const networkName = toNetworkName(network);
    const result = await AccountService.callAccountMethod<{ txHex?: string; hex?: string } | string>(
      networkName,
      accountIndex,
      'quoteSendTransactionTX',
      { to, value: toBtcValue(amount) }
    );
    if (typeof result === 'string') return result;
    return result?.txHex || result?.hex || String(result);
  },

  async quoteSendByNetworkWithMemoTX(
    network: NetworkType | string,
    accountIndex: number,
    amount: number,
    to: string,
    _asset: AssetTicker | string,
    memo: string
  ): Promise<string> {
    const result = await callBitcoin<{ txHex?: string; hex?: string } | string>(
      accountIndex,
      'quoteSendTransactionWithMemoTX',
      { to, value: toBtcValue(amount), memo }
    );
    if (typeof result === 'string') return result;
    return result?.txHex || result?.hex || String(result);
  },
};
