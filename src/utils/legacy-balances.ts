import type { BalanceFetchResult, TokenConfigs } from '@spacesops/wdk-react-native-core';

/** Shape previously exposed by useWallet().balances.list */
export type LegacyBalanceRow = {
  denomination: string;
  networkType: string;
  value: string;
};

function resolveDenomination(
  network: string,
  tokenAddress: string | null,
  tokenConfigs: TokenConfigs
): string | null {
  const networkTokens = tokenConfigs[network];
  if (!networkTokens) {
    return null;
  }

  if (tokenAddress === null) {
    return networkTokens.native.symbol.toLowerCase();
  }

  const token = networkTokens.tokens.find(
    t => t.address?.toLowerCase() === tokenAddress?.toLowerCase()
  );
  return token?.symbol.toLowerCase() ?? null;
}

function resolveDecimals(
  network: string,
  tokenAddress: string | null,
  tokenConfigs: TokenConfigs
): number {
  const networkTokens = tokenConfigs[network];
  if (!networkTokens) {
    return 18;
  }
  if (tokenAddress === null) {
    return networkTokens.native.decimals;
  }
  return (
    networkTokens.tokens.find(t => t.address?.toLowerCase() === tokenAddress?.toLowerCase())
      ?.decimals ?? 6
  );
}

/**
 * Convert useBalancesForWallet results into the old balances.list rows
 * (human units as decimal strings, denomination + networkType).
 */
export function balanceResultsToLegacyList(
  balanceResults: BalanceFetchResult[] | undefined,
  tokenConfigs: TokenConfigs
): LegacyBalanceRow[] {
  if (!balanceResults?.length) {
    return [];
  }

  const rows: LegacyBalanceRow[] = [];

  for (const result of balanceResults) {
    if (!result.success || result.balance == null) {
      continue;
    }

    const denomination = resolveDenomination(
      result.network,
      result.tokenAddress,
      tokenConfigs
    );
    if (!denomination) {
      continue;
    }

    const decimals = resolveDecimals(result.network, result.tokenAddress, tokenConfigs);
    const raw = parseFloat(result.balance);
    if (!Number.isFinite(raw)) {
      continue;
    }
    const human = raw / Math.pow(10, decimals);

    rows.push({
      denomination,
      networkType: result.network,
      value: String(human),
    });
  }

  return rows;
}

export function createLegacyBalances(
  balanceResults: BalanceFetchResult[] | undefined,
  tokenConfigs: TokenConfigs,
  isLoading: boolean
): { list: LegacyBalanceRow[]; isLoading: boolean } {
  return {
    list: balanceResultsToLegacyList(balanceResults, tokenConfigs),
    isLoading,
  };
}
