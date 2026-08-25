import { useWallet } from '@spacesops/wdk-react-native-core';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
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

/** Derivation is seed-local work; a call slower than this is starved, not busy. */
const DERIVE_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2;
/** The worklet is single threaded — a stampede starves every call at once. */
const MAX_CONCURRENT = 2;

const inflight = new Set<string>();
const failed = new Set<string>();
const attempts = new Map<string, number>();
const listeners = new Set<() => void>();

let version = 0;
let activeCount = 0;
const waiting: (() => void)[] = [];

/**
 * Wallet identity is not the walletId: delete + import reuses "default" with a
 * different seed, so derivation state must reset when the worklet reinitializes.
 */
let lastSignature: string | null = null;

function networkKey(walletId: string, network: string): string {
  return `${walletId}:${network}`;
}

function notify(): void {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function resetIfWalletChanged(signature: string): void {
  if (lastSignature === signature) {
    return;
  }
  lastSignature = signature;
  inflight.clear();
  failed.clear();
  attempts.clear();
}

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeCount >= MAX_CONCURRENT) {
    await new Promise<void>(resolve => waiting.push(resolve));
  }
  activeCount += 1;
  try {
    return await task();
  } finally {
    activeCount -= 1;
    waiting.shift()?.();
  }
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${DERIVE_TIMEOUT_MS}ms`)),
      DERIVE_TIMEOUT_MS
    );
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Prefetch receive addresses from the seed. Derivation needs no balance, and
 * must not compete with balance RPCs for the worklet, so callers should hold
 * balance queries until `addressesSettled`.
 */
export function useEnsureWalletAddresses(
  networks: readonly string[],
  walletId?: string
) {
  const { addresses: nestedAddresses, getAddress, isInitialized } = useWallet(
    walletId ? { walletId } : undefined
  );
  const addresses = useMemo(
    () => flattenWalletAddresses(nestedAddresses),
    [nestedAddresses]
  );

  useSyncExternalStore(subscribe, () => version);

  useEffect(() => {
    if (!isInitialized || !walletId) {
      return;
    }

    resetIfWalletChanged(`${walletId}|${isInitialized}`);

    for (const network of networks) {
      const key = networkKey(walletId, network);
      if (addresses[network] || inflight.has(key) || failed.has(key)) {
        continue;
      }

      const attempt = (attempts.get(key) ?? 0) + 1;
      if (attempt > MAX_ATTEMPTS) {
        failed.add(key);
        notify();
        continue;
      }

      attempts.set(key, attempt);
      inflight.add(key);

      void withSlot(() => withTimeout(getAddress(network, 0), network))
        .catch(error => {
          console.warn(`[useEnsureWalletAddresses] Failed to load ${network}:`, error);
          if (attempt >= MAX_ATTEMPTS) {
            failed.add(key);
          }
        })
        .finally(() => {
          inflight.delete(key);
          notify();
        });
    }
  }, [addresses, getAddress, isInitialized, networks, walletId]);

  const { failedNetworks, pendingCount } = useMemo(() => {
    if (!isInitialized || !walletId) {
      return { failedNetworks: [] as string[], pendingCount: 0 };
    }
    const failures = networks.filter(network => failed.has(networkKey(walletId, network)));
    const pending = networks.filter(
      network => !addresses[network] && !failed.has(networkKey(walletId, network))
    );
    return { failedNetworks: failures, pendingCount: pending.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses, isInitialized, networks, walletId, version]);

  return {
    addresses,
    isInitialized,
    isLoading: pendingCount > 0,
    // Nothing to derive is settled: callers must not block balances forever.
    addressesSettled: pendingCount === 0,
    failedNetworks,
  };
}
