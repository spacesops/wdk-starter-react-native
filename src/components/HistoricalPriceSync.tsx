import { useWallet, useWalletManager } from '@spacesops/wdk-react-native-core';
import React, { useEffect, useRef } from 'react';
import { pricingService } from '@/services/pricing-service';
import {
  clearAllHistoricalPriceData,
  syncHistoricalPrices,
} from '@/services/historical-price-storage';
import { resolveCurrentWalletId } from '@/utils/resolve-current-wallet-id';

const shouldClearPrices =
  typeof process !== 'undefined' && process.env.EXPO_PUBLIC_CLEAR_PRICES === 'true';

/**
 * When the wallet is initialized, optionally clears stored prices and syncs
 * historical price series. Transaction-based earliest-date sync is unavailable
 * until the new core exposes activity history.
 */
export function HistoricalPriceSync() {
  const { wallets, activeWalletId } = useWalletManager();
  const currentWalletId = resolveCurrentWalletId(activeWalletId, wallets);
  const { isInitialized } = useWallet(
    currentWalletId ? { walletId: currentWalletId } : undefined
  );
  const hasSyncedRef = useRef(false);

  useEffect(() => {
    if (!isInitialized) {
      return;
    }
    if (hasSyncedRef.current) return;
    hasSyncedRef.current = true;

    const run = async () => {
      try {
        if (shouldClearPrices) {
          await clearAllHistoricalPriceData();
          console.log(
            '[HistoricalPriceSync] Cleared historical price data (EXPO_PUBLIC_CLEAR_PRICES=true), reloading from API'
          );
        }
        await pricingService.initialize();
        // No transaction list in new core yet — sync default window from empty activity.
        await syncHistoricalPrices([], pricingService);
      } catch (err) {
        console.warn('[HistoricalPriceSync]', err);
        hasSyncedRef.current = false;
      }
    };

    run();
  }, [isInitialized]);

  return null;
}
