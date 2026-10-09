import React, { useEffect } from 'react';
import { pricingService } from '@/services/pricing-service';
import {
  runOneShotHistoricalPriceReloadIfRequested,
  syncHistoricalPrices,
} from '@/services/historical-price-storage';

/**
 * Starts the 100-day BTC/XAU₮ price sync when the app mounts.
 * Chart prices do not depend on wallet activity, so this does not wait for
 * addresses, balances, or transactions.
 */
export function HistoricalPriceSync() {
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        await runOneShotHistoricalPriceReloadIfRequested(pricingService);
        if (cancelled) return;

        const spotPrices = pricingService.initialize().catch((err) => {
          console.warn('[HistoricalPriceSync] spot prices', err);
        });
        await syncHistoricalPrices([], pricingService);
        await spotPrices;
      } catch (err) {
        if (!cancelled) console.warn('[HistoricalPriceSync]', err);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
