import { useWallet } from '@spacesops/wdk-react-native-core';
import { useEffect, useMemo, useRef } from 'react';
import { flattenWalletAddresses } from '@/utils/wallet-addresses';

/** User-facing networks shown in Settings and preloaded for receive flows. */
export const DISPLAY_WALLET_NETWORKS = [
  'bitcoin',
  'ethereum',
  'polygon',
  'arbitrum',
  'ton',
  'tron',
  'solana',
] as const;

/**
 * Core lazy-loads addresses via getAddress(). This hook prefetches missing
 * network addresses so screens can read them from the wallet store.
 */
export function useEnsureWalletAddresses(
  networks: readonly string[],
  walletId?: string
) {
  const { addresses: nestedAddresses, getAddress, isInitialized } = useWallet(
    walletId ? { walletId } : undefined
  );
  const flatAddresses = useMemo(
    () => flattenWalletAddresses(nestedAddresses),
    [nestedAddresses]
  );
  const inFlightRef = useRef(new Set<string>());

  useEffect(() => {
    if (!isInitialized || !walletId) {
      return;
    }

    for (const network of networks) {
      if (flatAddresses[network] || inFlightRef.current.has(network)) {
        continue;
      }

      inFlightRef.current.add(network);
      getAddress(network, 0)
        .catch(error => {
          console.warn(`[useEnsureWalletAddresses] Failed to load ${network}:`, error);
        })
        .finally(() => {
          inFlightRef.current.delete(network);
        });
    }
  }, [flatAddresses, getAddress, isInitialized, networks, walletId]);

  const isLoading =
    isInitialized &&
    networks.some(network => !flatAddresses[network] && inFlightRef.current.has(network));

  return {
    addresses: flatAddresses,
    isInitialized,
    isLoading,
  };
}
