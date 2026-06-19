import AsyncStorage from '@react-native-async-storage/async-storage';

/** Matches @tetherto/wdk-react-native-provider wallet-context storage key. */
export const WDK_WALLET_ADDRESSES_KEY = 'wdk_wallet_addresses';

/** Networks used to detect unexpected address drift between unlocks. */
const GUARD_NETWORKS = ['bitcoin', 'ethereum'] as const;

export type StoredWalletAddresses = Record<string, string | null | undefined>;

export async function loadStoredWalletAddresses(): Promise<StoredWalletAddresses | null> {
  try {
    const raw = await AsyncStorage.getItem(WDK_WALLET_ADDRESSES_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as StoredWalletAddresses;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('[WalletAddressGuard] Failed to read stored addresses:', error);
    return null;
  }
}

function normalizeAddress(network: string, address: string | null | undefined): string | null {
  if (typeof address !== 'string' || address.trim() === '') {
    return null;
  }
  const trimmed = address.trim();
  if (network === 'ethereum' || network === 'polygon' || network === 'arbitrum') {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

export type AddressDrift = {
  network: string;
  previous: string;
  current: string;
};

/**
 * Returns networks whose addresses changed vs the last persisted snapshot.
 * Empty when there is no prior snapshot (first unlock) or all guarded networks match.
 */
export function findAddressDrift(
  previous: StoredWalletAddresses | null,
  current: StoredWalletAddresses | null
): AddressDrift[] {
  if (!previous || !current) {
    return [];
  }

  const drift: AddressDrift[] = [];

  for (const network of GUARD_NETWORKS) {
    const prevNorm = normalizeAddress(network, previous[network]);
    const currNorm = normalizeAddress(network, current[network]);

    if (prevNorm == null || currNorm == null) {
      continue;
    }

    if (prevNorm !== currNorm) {
      drift.push({
        network,
        previous: previous[network] as string,
        current: current[network] as string,
      });
    }
  }

  return drift;
}

export function formatAddressDriftMessage(drift: AddressDrift[]): string {
  if (drift.length === 0) {
    return '';
  }

  const lines = drift.map(
    (d) => `${d.network}: ${shortAddress(d.previous)} → ${shortAddress(d.current)}`
  );

  return (
    'Wallet addresses changed since your last unlock.\n\n' +
    lines.join('\n') +
    '\n\nIf this is unexpected, do not send funds — re-import your recovery phrase from Settings after backing it up.'
  );
}

function shortAddress(address: string): string {
  if (address.length <= 16) {
    return address;
  }
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}
