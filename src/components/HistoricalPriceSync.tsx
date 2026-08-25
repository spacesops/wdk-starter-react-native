import {
  useBalancesForWallet,
  useWallet,
  useWalletManager,
  useWalletTransactions,
} from '@spacesops/wdk-react-native-core';
import React, { useEffect, useMemo, useRef } from 'react';
import getTokenConfigs from '@/config/get-token-configs';
import { pricingService } from '@/services/pricing-service';
import {
  clearAllHistoricalPriceData,
  syncHistoricalPrices,
} from '@/services/historical-price-storage';
import { resolveCurrentWalletId } from '@/utils/resolve-current-wallet-id';
import { filterTokenConfigsByNonZeroBalance } from '@/utils/filter-token-configs-by-balance';

const shouldClearPrices =
  typeof process !== 'undefined' && process.env.EXPO_PUBLIC_CLEAR_PRICES === 'true';

/**
 * When the wallet is initialized, optionally clears stored prices and syncs
 * historical price series using indexer-backed transaction history.
 */
export function HistoricalPriceSync() {
  const { wallets, activeWalletId } = useWalletManager();
  const currentWalletId = resolveCurrentWalletId(activeWalletId, wallets);
  const tokenConfigs = useMemo(() => getTokenConfigs(), []);
  const { isInitialized } = useWallet(
    currentWalletId ? { walletId: currentWalletId } : undefined
  );
  const {
    data: balanceResults,
    isLoading: isLoadingBalances,
  } = useBalancesForWallet(0, tokenConfigs, { enabled: isInitialized });
  const activityTokenConfigs = useMemo(
    () => filterTokenConfigsByNonZeroBalance(tokenConfigs, balanceResults),
    [tokenConfigs, balanceResults]
  );
  const balancesReady = !isLoadingBalances && Boolean(balanceResults);
  const { data: walletTransactionList = [] } = useWalletTransactions(0, activityTokenConfigs, {
    enabled:
      isInitialized &&
      Boolean(currentWalletId) &&
      balancesReady &&
      Object.keys(activityTokenConfigs).length > 0,
    walletId: currentWalletId,
  });
  const lastSyncKeyRef = useRef<string>('');

  useEffect(() => {
    if (!isInitialized) {
      return;
    }

    const syncKey = walletTransactionList
      .map((tx) => `${tx.transactionHash}:${tx.timestamp}`)
      .join('|');
    if (syncKey === lastSyncKeyRef.current) {
      return;
    }

    const run = async () => {
      try {
        if (shouldClearPrices && lastSyncKeyRef.current === '') {
          await clearAllHistoricalPriceData();
          console.log(
            '[HistoricalPriceSync] Cleared historical price data (EXPO_PUBLIC_CLEAR_PRICES=true), reloading from API'
          );
        }
        await pricingService.initialize();
        const txLike = walletTransactionList.map((tx) => ({
          token: tx.token,
          timestamp: tx.timestamp,
        }));
        await syncHistoricalPrices(txLike, pricingService);
        lastSyncKeyRef.current = syncKey;
      } catch (err) {
        console.warn('[HistoricalPriceSync]', err);
      }
    };

    run();
  }, [isInitialized, walletTransactionList]);

  return null;
}
