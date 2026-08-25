import type { BalanceFetchResult, TokenConfigs } from '@spacesops/wdk-react-native-core';

function sameTokenAddress(a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function isPositiveBalance(result: BalanceFetchResult | undefined): boolean {
  if (!result?.success || result.balance == null) return false;
  const raw = Number(result.balance);
  return Number.isFinite(raw) && raw > 0;
}

function findBalance(
  balanceResults: BalanceFetchResult[] | undefined,
  network: string,
  tokenAddress: string | null
): BalanceFetchResult | undefined {
  return balanceResults?.find(
    (result) =>
      result.network === network && sameTokenAddress(result.tokenAddress, tokenAddress)
  );
}

function isIndexerNative(token: { symbol: string; indexerToken?: string }): boolean {
  return Boolean(token.indexerToken) || token.symbol.toLowerCase() === 'btc';
}

/**
 * Restrict token configs to indexer networks/tokens that currently have a non-zero balance.
 * Used so Activity only queries token-transfers for holdings the wallet actually has.
 */
export function filterTokenConfigsByNonZeroBalance(
  tokenConfigs: TokenConfigs,
  balanceResults: BalanceFetchResult[] | undefined
): TokenConfigs {
  const filtered: TokenConfigs = {};

  for (const [network, networkTokens] of Object.entries(tokenConfigs)) {
    if (!networkTokens?.indexerBlockchain) {
      continue;
    }

    const tokens = networkTokens.tokens.filter((token) =>
      isPositiveBalance(findBalance(balanceResults, network, token.address))
    );
    const nativeHasBalance = isPositiveBalance(
      findBalance(balanceResults, network, networkTokens.native.address)
    );
    const queryNative = nativeHasBalance && isIndexerNative(networkTokens.native);

    if (!queryNative && tokens.length === 0) {
      continue;
    }

    filtered[network] = {
      ...networkTokens,
      tokens,
    };
  }

  return filtered;
}

/** Stable fingerprint for query keys / refetch when the held-token set changes. */
export function tokenConfigsFingerprint(tokenConfigs: TokenConfigs): string {
  return Object.keys(tokenConfigs)
    .sort()
    .map((network) => {
      const config = tokenConfigs[network];
      const tokens = [config.native, ...config.tokens]
        .map((t) => `${t.symbol}:${t.address ?? 'native'}`)
        .join(',');
      return `${network}[${tokens}]`;
    })
    .join('|');
}
