import { Network, NetworkSelector } from '@/components/NetworkSelector';
import { assetConfig, AssetTicker } from '@/config/assets';
import getTokenConfigs from '@/config/get-token-configs';
import { networkConfigs } from '@/config/networks';
import formatAmount from '@/utils/format-amount';
import {
  useBalancesForWallet,
  useWallet,
  useWalletManager,
} from '@spacesops/wdk-react-native-core';
import { useLocalSearchParams } from 'expo-router';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FiatCurrency, pricingService } from '@/services/pricing-service';
import getDisplaySymbol from '@/utils/get-display-symbol';
import formatTokenAmount from '@/utils/format-token-amount';
import Header from '@/components/header';
import { colors } from '@/constants/colors';
import { createLegacyBalances } from '@/utils/legacy-balances';
import { resolveCurrentWalletId } from '@/utils/resolve-current-wallet-id';

export default function SelectNetworkScreen() {
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
  const { tokenId, tokenSymbol, tokenName, scannedAddress } = params as {
    tokenId: string;
    tokenSymbol: string;
    tokenName: string;
    scannedAddress?: string;
  };

  const [networks, setNetworks] = useState<Network[]>([]);

  useEffect(() => {
    const calculateNetworks = async () => {
      const tokenConfig = assetConfig[tokenId];

      if (!tokenConfig) {
        setNetworks([]);
        return;
      }

      const networksWithBalances = await Promise.all(
        tokenConfig.supportedNetworks.map(async networkType => {
          const network = networkConfigs[networkType];

          const balance = balances.list?.find(
            b => networkType === b.networkType && b.denomination === tokenId
          );

          const balanceValue = balance ? parseFloat(balance.value) : 0;

          const balanceUSD = await pricingService.getFiatValue(
            balanceValue,
            tokenId as AssetTicker,
            FiatCurrency.USD
          );

          return {
            ...network,
            balance: formatTokenAmount(balanceValue, tokenId as AssetTicker, false),
            balanceFiat: formatAmount(balanceUSD),
            fiatCurrency: FiatCurrency.USD,
            token: getDisplaySymbol(tokenId),
          };
        })
      );

      setNetworks(networksWithBalances as Network[]);
    };

    calculateNetworks();
  }, [tokenId, balances.list]);

  const handleSelectNetwork = useCallback(
    (network: Network) => {
      router.push({
        pathname: '/send/details',
        params: {
          tokenId,
          tokenSymbol,
          tokenName,
          tokenBalance: network.balance,
          tokenBalanceUSD: network.balanceFiat,
          networkName: network.name,
          networkId: network.id,
          ...(scannedAddress && { scannedAddress }),
        },
      });
    },
    [router, tokenId, tokenSymbol, tokenName, scannedAddress]
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Header title="Select network" style={styles.header} />

      <Text style={styles.description}>
        Select the network you will be using to send {tokenSymbol || tokenName}
      </Text>

      <NetworkSelector networks={networks} onSelectNetwork={handleSelectNetwork} />
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
  description: {
    fontSize: 14,
    color: colors.textSecondary,
    paddingHorizontal: 20,
    marginBottom: 24,
  },
});
