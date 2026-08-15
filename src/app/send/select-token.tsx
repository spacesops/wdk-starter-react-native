import { assetConfig, AssetTicker, ENABLED_ASSET_TICKERS } from '@/config/assets';
import getTokenConfigs from '@/config/get-token-configs';
import { useLocalSearchParams } from 'expo-router';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/constants/colors';

import {
  useBalancesForWallet,
  useWallet,
  useWalletManager,
} from '@spacesops/wdk-react-native-core';
import { AssetSelector, type Token } from '@tetherto/wdk-uikit-react-native';
import { FiatCurrency, pricingService } from '@/services/pricing-service';
import formatAmount from '@/utils/format-amount';
import getDisplaySymbol from '@/utils/get-display-symbol';
import { getRecentTokens, addToRecentTokens } from '@/utils/recent-tokens';
import formatTokenAmount from '@/utils/format-token-amount';
import Header from '@/components/header';
import { createLegacyBalances } from '@/utils/legacy-balances';
import { resolveCurrentWalletId } from '@/utils/resolve-current-wallet-id';

export default function SelectTokenScreen() {
  const insets = useSafeAreaInsets();
  const router = useDebouncedNavigation();
  const params = useLocalSearchParams();
  const { wallets, activeWalletId } = useWalletManager();
  const currentWalletId = resolveCurrentWalletId(activeWalletId, wallets);
  const { isInitialized } = useWallet(
    currentWalletId ? { walletId: currentWalletId } : undefined
  );
  const tokenConfigs = useMemo(() => getTokenConfigs(), []);
  const { data: balanceResults, isLoading } = useBalancesForWallet(0, tokenConfigs, {
    enabled: isInitialized,
  });
  const balances = useMemo(
    () => createLegacyBalances(balanceResults, tokenConfigs, isLoading),
    [balanceResults, tokenConfigs, isLoading]
  );

  const { scannedAddress } = params as { scannedAddress?: string };
  const [recentTokens, setRecentTokens] = useState<string[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);

  useEffect(() => {
    const loadRecentTokens = async () => {
      const recent = await getRecentTokens('send');
      setRecentTokens(recent);
    };
    loadRecentTokens();
  }, []);

  useEffect(() => {
    const calculateTokensWithFiatValues = async () => {
      if (!balances.list) {
        setTokens([]);
        return;
      }

      const balanceMap = new Map<string, { totalBalance: number }>();

      balances.list.forEach(balance => {
        const current = balanceMap.get(balance.denomination) || { totalBalance: 0 };
        balanceMap.set(balance.denomination, {
          totalBalance: current.totalBalance + parseFloat(balance.value),
        });
      });

      const tokensWithBalances: Token[] = [];

      for (const assetSymbol of ENABLED_ASSET_TICKERS) {
        const config = assetConfig[assetSymbol];
        if (!config) continue;

        const totalBalance = balanceMap.get(assetSymbol)?.totalBalance || 0;

        let usdValue = 0;
        try {
          usdValue = await pricingService.getFiatValue(
            totalBalance,
            assetSymbol as AssetTicker,
            FiatCurrency.USD
          );
        } catch (error) {
          console.error(`Error calculating fiat value for ${assetSymbol}:`, error);
          usdValue = 0;
        }

        tokensWithBalances.push({
          id: assetSymbol,
          symbol: getDisplaySymbol(assetSymbol),
          name: config.name,
          balance: formatTokenAmount(totalBalance, assetSymbol as AssetTicker, false),
          balanceUSD: `${formatAmount(usdValue)} USD`,
          icon: config.icon,
          color: config.color,
          hasBalance: totalBalance > 0,
        });
      }

      const sortedTokens = tokensWithBalances.sort((a, b) => {
        const aValue = parseFloat(a.balanceUSD.replace(/[$,]/g, ''));
        const bValue = parseFloat(b.balanceUSD.replace(/[$,]/g, ''));

        if (aValue === 0 && bValue === 0) {
          return a.name.localeCompare(b.name);
        }

        if (aValue === 0) return 1;
        if (bValue === 0) return -1;

        return bValue - aValue;
      });

      setTokens(sortedTokens);
    };

    calculateTokensWithFiatValues();
  }, [balances.list]);

  const handleSelectToken = useCallback(
    async (token: Token) => {
      if (!token.hasBalance) {
        return;
      }

      const updatedRecent = await addToRecentTokens(token.name, 'send');
      setRecentTokens(updatedRecent);

      router.push({
        pathname: '/send/select-network',
        params: {
          tokenId: token.id,
          tokenSymbol: token.symbol,
          tokenName: token.name,
          tokenBalance: token.balance,
          tokenBalanceUSD: token.balanceUSD,
          ...(scannedAddress && { scannedAddress }),
        },
      });
    },
    [router, scannedAddress]
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Header title="Send funds" style={styles.header} />
      <AssetSelector
        tokens={tokens}
        recentTokens={recentTokens}
        onSelectToken={handleSelectToken}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    marginBottom: 16,
  },
});
