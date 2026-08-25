import { BalanceLoader } from '@/components/BalanceLoader';
import {
  useBalancesForWallet,
  useRefreshBalance,
  useWallet,
  useWalletManager,
  useWalletTransactions,
} from '@spacesops/wdk-react-native-core';
import { Balance } from '@tetherto/wdk-uikit-react-native';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import { ArrowDownLeft, ArrowUpRight, AtSign, QrCode, Settings } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LineChart } from 'react-native-chart-kit';
import { AssetConfig, assetConfig, AssetTicker } from '../config/assets';
import getTokenConfigs, { INDEXER_WALLET_NETWORKS } from '../config/get-token-configs';
import { useEnsureWalletAddresses } from '@/hooks/use-ensure-wallet-addresses';
import { FiatCurrency, pricingService } from '../services/pricing-service';
import {
  buildBtcDailyBalanceTable,
  saveBtcDailyBalanceTable,
} from '@/services/btc-daily-balance-storage';
import {
  buildIndexedPerformanceChartData,
  buildPortfolioValueChartData,
  DEFAULT_CHART_QUOTE_UNIT,
  DEFAULT_CHART_STACK_ORDER,
  ensureChartUsdPrices,
  isSentByWalletUI,
  loadHistoricalPrices,
  moveTokenToChartStackBottom,
  onHistoricalPricesUpdated,
  TOKEN_CHART_COLORS,
  tokenToChartKey,
  type ChartQuoteUnit,
  type ChartStackToken,
  type CurrentHoldings,
  type HistoricalPricesMap,
  type PriceChartData,
  type TransactionForBalance,
} from '@/services/historical-price-storage';
import formatAmount from '@/utils/format-amount';
import formatTokenAmount from '@/utils/format-token-amount';
import formatUSDValue from '@/utils/format-usd-value';
import useWalletAvatar from '@/hooks/use-wallet-avatar';
import { colors } from '@/constants/colors';
import { createLegacyBalances } from '@/utils/legacy-balances';
import { resolveCurrentWalletId } from '@/utils/resolve-current-wallet-id';
import { flattenWalletAddresses } from '@/utils/wallet-addresses';
import { getWalletName } from '@/config/avatar-options';

const chartSectionHorizontalPadding = 12;
const chartHeight = 220;
const performanceChartHeight = 190;
const chartInnerPadding = 6;
const chartLineWidth =
  Dimensions.get('window').width - chartSectionHorizontalPadding * 2 - chartInnerPadding * 2;
/** Left inset inside the SVG for y-axis labels (chart-kit's paddingRight). */
const chartYAxisPadding =24;
/** Space below the plot area inside react-native-chart-kit's SVG for x-axis date labels. */
const chartLabelPaddingBottom = 2;

const chartLabelChartConfig = {
  verticalLabelsHeightPercentage: 0.7,
  propsForLabels: { fontSize: 11 },
};

/** Skip first/last data indices so middle-anchored x labels stay inside the SVG width. */
function buildChartXAxisConfig(labelCount: number) {
  if (labelCount <= 1) {
    return { yAxisInterval: 1, hidePointsAtIndex: [] as number[] };
  }
  const step = Math.max(1, Math.floor(labelCount / 7));
  const edgeInset = Math.max(1, Math.ceil(step / 3));
  const start = Math.min(edgeInset, labelCount - 2);
  const end = Math.max(labelCount - 1 - edgeInset, start);
  const show = new Set<number>();
  for (let i = start; i <= end; i += step) {
    show.add(i);
  }
  show.add(start);
  show.add(end);
  const hidePointsAtIndex = Array.from({ length: labelCount }, (_, i) => i).filter(
    (i) => !show.has(i)
  );
  return {
    yAxisInterval: Math.max(1, step),
    hidePointsAtIndex,
  };
}

type PortfolioChartInputs = {
  stored: HistoricalPricesMap;
  txList: TransactionForBalance[];
  walletAddresses: string[];
  currentHoldings: CurrentHoldings;
};

type AggregatedBalance = ({
  denomination: string;
  balance: number;
  usdValue: number;
  config: AssetConfig;
} | null)[];

type Transaction = {
  id: number;
  type: string;
  asset: string;
  token: string;
  amount: string;
  icon: any;
  iconColor: string;
  blockchain: string;
  hash: string;
  fiatAmount: number;
  currency: FiatCurrency;
};

export default function WalletScreen() {
  const insets = useSafeAreaInsets();
  const router = useDebouncedNavigation();
  const { wallets, activeWalletId } = useWalletManager();
  const currentWalletId = resolveCurrentWalletId(activeWalletId, wallets);
  const { isInitialized, addresses: nestedAddresses } = useWallet(
    currentWalletId ? { walletId: currentWalletId } : undefined
  );
  useEnsureWalletAddresses(INDEXER_WALLET_NETWORKS, currentWalletId);
  const { mutate: refreshBalance } = useRefreshBalance();
  const tokenConfigs = useMemo(() => getTokenConfigs(), []);
  const {
    data: balanceResults,
    isLoading: isLoadingBalances,
    refetch,
  } = useBalancesForWallet(0, tokenConfigs, { enabled: isInitialized });
  const balances = useMemo(
    () => createLegacyBalances(balanceResults, tokenConfigs, isLoadingBalances),
    [balanceResults, tokenConfigs, isLoadingBalances]
  );
  const addresses = useMemo(() => flattenWalletAddresses(nestedAddresses), [nestedAddresses]);
  const {
    data: walletTransactionList = [],
    isLoading: isLoadingTransactions,
    refetch: refetchTransactions,
  } = useWalletTransactions(0, tokenConfigs, {
    enabled: isInitialized && Boolean(currentWalletId),
    walletId: currentWalletId,
  });
  const walletTransactions = useMemo(
    () => ({ list: walletTransactionList, isLoading: isLoadingTransactions }),
    [walletTransactionList, isLoadingTransactions]
  );
  const isLoading = isLoadingBalances;
  const [refreshing, setRefreshing] = useState(false);
  const [aggregatedBalances, setAggregatedBalances] = useState<AggregatedBalance>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [portfolioChartInputs, setPortfolioChartInputs] = useState<PortfolioChartInputs | null>(
    null
  );
  const [chartStackOrder, setChartStackOrder] = useState<ChartStackToken[]>(
    DEFAULT_CHART_STACK_ORDER
  );
  const [chartQuoteUnit, setChartQuoteUnit] = useState<ChartQuoteUnit>(DEFAULT_CHART_QUOTE_UNIT);
  const [mounted, setMounted] = useState(false);
  const [walletDisplayName, setWalletDisplayName] = useState('My Wallet');
  const avatar = useWalletAvatar();
  const scrollY = useRef(new Animated.Value(0)).current;

  const hasWallet = isInitialized || Object.keys(addresses).length > 0;

  useEffect(() => {
    getWalletName().then(setWalletDisplayName);
  }, []);

  // Redirect to authorization if wallet is not initialized
  useEffect(() => {
    if (wallets.some(w => w.exists) && !isInitialized) {
      router.replace('/authorize');
    }
  }, [wallets, isInitialized, router]);

  // Calculate aggregated balances by denomination
  const getAggregatedBalances = async () => {
    if (!balances) return [];

    const map = new Map<string, { totalBalance: number }>();

    // Sum up balances by denomination across all networks
    balances.list.forEach(balance => {
      const current = map.get(balance.denomination) || { totalBalance: 0 };
      map.set(balance.denomination, {
        totalBalance: current.totalBalance + parseFloat(balance.value),
      });
    });

    const promises = Array.from(map.entries()).map(async ([denomination, { totalBalance }]) => {
      const config = assetConfig[denomination];
      if (!config) return null;

      if (!pricingService.isReady()) {
        await pricingService.initialize().catch(() => {});
      }
      const fiatValue = await pricingService.getFiatValue(
        totalBalance,
        denomination as AssetTicker,
        FiatCurrency.USD
      );

      return {
        denomination,
        balance: totalBalance,
        usdValue: fiatValue,
        config,
      };
    });

    return (await Promise.all(promises))
      .filter(Boolean)
      .filter(asset => asset && asset.balance > 0) // Only show tokens with positive balance
      .sort((a, b) => (b?.usdValue || 0) - (a?.usdValue || 0)); // Sort by USD value descending
  };

  // Calculate total portfolio value
  const totalPortfolioValue = useMemo(() => {
    return aggregatedBalances.reduce((sum, asset) => sum + (asset?.usdValue || 0), 0);
  }, [aggregatedBalances]);

  // Animated border opacity based on scroll position
  const borderOpacity = scrollY.interpolate({
    inputRange: [0, 50],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  // Get real transactions from wallet data
  const getTransactions = async () => {
    if (!walletTransactions) return [];

    // Same address list as balance replay (Object.values(addresses).map(addr => addr?.toLowerCase()))
    const walletAddresses = addresses
      ? Object.values(addresses).map(addr => addr?.toLowerCase())
      : [];

    if (!pricingService.isReady()) {
      await pricingService.initialize().catch(() => {});
    }
    const result = await Promise.all(
      walletTransactions.list
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 3)
        .map(async (tx, index) => {
          const isSent = isSentByWalletUI(tx.from, walletAddresses);
          const amount = parseFloat(tx.amount);
          const config = assetConfig[tx.token];

          const fiatAmount = await pricingService.getFiatValue(
            amount,
            tx.token as AssetTicker,
            FiatCurrency.USD
          );

          return {
            id: index + 1,
            type: isSent ? 'sent' : 'received',
            asset: config?.name || tx.token.toUpperCase(),
            token: tx.token,
            amount: `${formatTokenAmount(amount, tx.token as AssetTicker)}`,
            icon: isSent ? ArrowUpRight : ArrowDownLeft,
            iconColor: isSent ? colors.danger : colors.success,
            blockchain: tx.blockchain,
            hash: tx.transactionHash,
            fiatAmount: fiatAmount,
            currency: FiatCurrency.USD,
          };
        })
    );

    return result;
  };

  const handleSendPress = () => {
    router.push('/send/select-token');
  };

  const handleReceivePress = () => {
    router.push('/receive/select-token');
  };

  const handleChartTokenPress = useCallback((token: ChartStackToken) => {
    setChartQuoteUnit(token);
  }, []);

  const handleChartTokenLongPress = useCallback((token: ChartStackToken) => {
    setChartStackOrder((prev) => moveTokenToChartStackBottom(prev, token));
  }, []);

  const indexedChartData = useMemo(
    () =>
      portfolioChartInputs
        ? buildIndexedPerformanceChartData(portfolioChartInputs.stored, 80, chartQuoteUnit)
        : null,
    [portfolioChartInputs, chartQuoteUnit]
  );

  const chartData = useMemo(
    () =>
      portfolioChartInputs
        ? buildPortfolioValueChartData(
            portfolioChartInputs.stored,
            portfolioChartInputs.txList,
            portfolioChartInputs.walletAddresses,
            80,
            portfolioChartInputs.currentHoldings,
            chartStackOrder,
            chartQuoteUnit
          )
        : null,
    [portfolioChartInputs, chartStackOrder, chartQuoteUnit]
  );

  const holdingsChartAxis = useMemo(() => {
    switch (chartQuoteUnit) {
      case 'btc':
        return {
          yAxisLabel: '',
          yAxisSuffix: '',
          decimalPlaces: 4,
          formatYLabel: (value: string) => Number(value).toFixed(4),
        };
      case 'xaut':
        return {
          yAxisLabel: '',
          yAxisSuffix: '',
          decimalPlaces: 2,
          formatYLabel: (value: string) => Number(value).toFixed(2),
        };
      default:
        return {
          yAxisLabel: '$',
          yAxisSuffix: '',
          decimalPlaces: 0,
          formatYLabel: (value: string) =>
            `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        };
    }
  }, [chartQuoteUnit]);

  const handleQRPress = () => {
    router.push('/scan-qr');
  };

  const handleSeeAllTokens = () => {
    router.push('/assets');
  };

  const handleSeeAllActivity = () => {
    router.push('/activity');
  };

  const handleCreateWallet = () => {
    router.push('/wallet-setup/name-wallet');
  };

  const handleSpacesPress = () => {
    router.push('/spaces');
  };

  const handleSettingsPress = () => {
    router.push('/settings');
  };

  const handleRefresh = async () => {
    if (!hasWallet) return;

    setRefreshing(true);
    try {
      refreshBalance({ accountIndex: 0, type: 'wallet' });
      await Promise.all([refetch(), refetchTransactions(), loadChartData()]);
    } catch (error) {
      console.error('Failed to refresh wallet data:', error);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    getAggregatedBalances().then(setAggregatedBalances);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balances]);

  useEffect(() => {
    getTransactions().then(setTransactions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletTransactions?.list, addresses]);

  // Persist BTC daily balance table when transactions or addresses change (same address list as UI)
  useEffect(() => {
    const rawList = walletTransactions?.list ?? [];
    const walletAddresses = addresses ? Object.values(addresses).map((a) => a?.toLowerCase()) : [];
    if (rawList.length === 0 && walletAddresses.length === 0) return;
    const txList = rawList.map((tx) => ({
      timestamp: tx.timestamp,
      token: tx.token,
      amount: parseFloat(tx.amount) || 0,
      from: tx.from ?? '',
      to: (tx as { to?: string }).to ?? '',
    }));
    const table = buildBtcDailyBalanceTable(txList, walletAddresses);
    saveBtcDailyBalanceTable(table).catch(() => {});
  }, [walletTransactions?.list, addresses]);

  const currentHoldings = useMemo((): CurrentHoldings => {
    const holdings: CurrentHoldings = {};
    balances?.list.forEach((balance) => {
      const key = tokenToChartKey(balance.denomination);
      if (key !== 'btc' && key !== 'xaut' && key !== 'usdt' && key !== 'usat') return;
      holdings[key] = (holdings[key] ?? 0) + (parseFloat(balance.value) || 0);
    });
    return holdings;
  }, [balances?.list]);

  const loadChartData = useCallback(async () => {
    try {
      if (!pricingService.isReady()) {
        await pricingService.initialize().catch(() => {});
      }
      let stored = await loadHistoricalPrices();
      if (pricingService.isReady()) {
        stored = await ensureChartUsdPrices(stored, pricingService);
      }
      const rawList = walletTransactions?.list ?? [];
      const txList = rawList.map((tx) => ({
        timestamp: tx.timestamp,
        token: tx.token,
        amount: parseFloat(tx.amount) || 0,
        from: tx.from ?? '',
        to: (tx as { to?: string }).to ?? '',
      }));
      const walletAddresses = addresses
        ? Object.values(addresses).map((a) => a?.toLowerCase())
        : [];
      setPortfolioChartInputs({
        stored,
        txList,
        walletAddresses,
        currentHoldings,
      });
    } catch {
      setPortfolioChartInputs(null);
    }
  }, [walletTransactions?.list, addresses, currentHoldings]);

  useEffect(() => {
    loadChartData();
  }, [loadChartData]);

  // Reload chart when historical price sync completes (so we don't stay on "No price history yet")
  useEffect(() => {
    const unsubscribe = onHistoricalPricesUpdated(loadChartData);
    return unsubscribe;
  }, [loadChartData]);

  // Delayed reload so we pick up chart data if sync completes shortly after mount
  useEffect(() => {
    const t = setTimeout(loadChartData, 1500);
    return () => clearTimeout(t);
  }, [loadChartData]);

  useFocusEffect(
    useCallback(() => {
      loadChartData();
    }, [loadChartData])
  );

  // Force component to fully mount before enabling RefreshControl on iOS
  useEffect(() => {
    requestAnimationFrame(() => {
      setMounted(true);
    });
  }, []);

  const chartXAxisConfig = useMemo(
    () => buildChartXAxisConfig(chartData?.labels?.length ?? 0),
    [chartData?.labels?.length]
  );

  const indexedChartXAxisConfig = useMemo(
    () => buildChartXAxisConfig(indexedChartData?.labels?.length ?? 0),
    [indexedChartData?.labels?.length]
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <Animated.View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 16,
            borderBottomColor: borderOpacity.interpolate({
              inputRange: [0, 1],
              outputRange: ['rgba(30, 30, 30, 0)', 'rgba(30, 30, 30, 1)'],
            }),
          },
        ]}
      >
        <View style={styles.walletInfo}>
          <View style={styles.walletIcon}>
            <Text style={styles.walletIconText}>{avatar}</Text>
          </View>
          <Text style={styles.walletName}>{walletDisplayName}</Text>
        </View>

        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.headerButtonFirst} onPress={handleSpacesPress}>
            <AtSign size={24} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerButton} onPress={handleSettingsPress}>
            <Settings size={24} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        bounces={true}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: false,
        })}
        refreshControl={
          mounted ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
              title="Pull to refresh"
              titleColor={colors.textSecondary}
              progressViewOffset={insets.top}
            />
          ) : (
            <RefreshControl
              refreshing={false}
              onRefresh={() => {}}
              tintColor={colors.white}
              colors={[colors.white]}
              progressViewOffset={0}
            />
          )
        }
      >
        {/* Balance */}
        {!hasWallet && !isLoading ? (
          <TouchableOpacity onPress={handleCreateWallet}>
            <Text>Create Your First Wallet</Text>
          </TouchableOpacity>
        ) : (
          <View
            style={{
              margin: 12,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Balance
              value={totalPortfolioValue}
              currency="USD"
              isLoading={isLoading}
              Loader={BalanceLoader}
            />
            {balances.isLoading ? (
              <View style={{ top: 16, marginRight: 8 }}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : null}
          </View>
        )}

        {/* Portfolio */}
        <View style={styles.portfolioSection}>
          {aggregatedBalances.length > 0 ? (
            aggregatedBalances.map(asset => {
              if (!asset) return null;

              return (
                <TouchableOpacity
                  key={asset.denomination}
                  style={styles.assetRow}
                  onPress={() => {
                    if (hasWallet) {
                      router.push({
                        pathname: '/token-details',
                        params: {
                          walletId: currentWalletId,
                          token: asset.denomination.toUpperCase(),
                        },
                      });
                    }
                  }}
                >
                  <View style={styles.assetInfo}>
                    <View style={[styles.assetIcon, { backgroundColor: asset.config.color }]}>
                      <Image source={asset.config.icon} style={styles.assetIconImage} />
                    </View>
                    <View>
                      <Text style={styles.assetName}>{asset.config.name}</Text>
                    </View>
                  </View>
                  <View style={styles.assetBalance}>
                    <Text style={styles.assetAmount}>
                      {formatTokenAmount(asset.balance, asset.denomination as AssetTicker)}
                    </Text>
                    <Text style={styles.assetValue}>{formatAmount(asset.usdValue)} USD</Text>
                  </View>
                </TouchableOpacity>
              );
            })
          ) : (
            <View style={styles.noAssetsContainer}>
              <Text style={styles.noAssetsText}>No assets found</Text>
            </View>
          )}

          <TouchableOpacity onPress={handleSeeAllTokens}>
            <Text style={styles.seeAllText}>See All</Text>
          </TouchableOpacity>
        </View>

        {/* Last 100 days: indexed performance + stacked USD holdings */}
        <View style={styles.chartSection}>
          {indexedChartData && indexedChartData.datasets.length > 0 ? (
            <View style={[styles.chartWrapper, styles.chartWrapperSpaced]}>
              <LineChart
                key={`perf-${chartQuoteUnit}`}
                data={indexedChartData}
                width={chartLineWidth}
                height={performanceChartHeight}
                yAxisLabel=""
                yAxisSuffix=""
                segments={3}
                yLabelsOffset={12}
                yAxisInterval={indexedChartXAxisConfig.yAxisInterval}
                hidePointsAtIndex={indexedChartXAxisConfig.hidePointsAtIndex}
                xLabelsOffset={0}
                fromZero={false}
                withDots={false}
                withShadow={false}
                withInnerLines={true}
                withOuterLines={true}
                withVerticalLabels={true}
                withHorizontalLabels={true}
                bezier
                chartConfig={{
                  ...chartLabelChartConfig,
                  backgroundColor: colors.card,
                  backgroundGradientFrom: colors.card,
                  backgroundGradientTo: colors.cardDark,
                  decimalPlaces: 0,
                  formatYLabel: (value: string) => {
                    const pct = Number(value) - 100;
                    const rounded = Math.round(pct);
                    return `${rounded >= 0 ? '+' : ''}${rounded}%`;
                  },
                  color: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
                  labelColor: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
                  useShadowColorFromDataset: false,
                  propsForBackgroundLines: { stroke: colors.border, strokeWidth: 0.5 },
                  style: { borderRadius: 12 },
                }}
                style={styles.chart}
              />
            </View>
          ) : null}
          {chartData && chartData.datasets.length > 0 ? (
            <View style={styles.chartWrapper}>
              <LineChart
                key={`${chartStackOrder.join('-')}-${chartQuoteUnit}`}
                data={chartData}
                width={chartLineWidth}
                height={chartHeight}
                yAxisLabel={holdingsChartAxis.yAxisLabel}
                yAxisSuffix={holdingsChartAxis.yAxisSuffix}
                segments={3}
                yLabelsOffset={12}
                yAxisInterval={chartXAxisConfig.yAxisInterval}
                hidePointsAtIndex={chartXAxisConfig.hidePointsAtIndex}
                xLabelsOffset={0}
                fromZero={true}
                withDots={false}
                withInnerLines={true}
                withOuterLines={true}
                withVerticalLabels={true}
                withHorizontalLabels={true}
                chartConfig={{
                  ...chartLabelChartConfig,
                  backgroundColor: colors.card,
                  backgroundGradientFrom: colors.card,
                  backgroundGradientTo: colors.cardDark,
                  decimalPlaces: holdingsChartAxis.decimalPlaces,
                  formatYLabel: holdingsChartAxis.formatYLabel,
                  color: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
                  labelColor: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
                  useShadowColorFromDataset: true,
                  fillShadowGradientFromOpacity: 0.9,
                  fillShadowGradientToOpacity: 0.9,
                  fillShadowGradientOpacity: 0.9,
                  propsForBackgroundLines: { stroke: colors.border, strokeWidth: 0.5 },
                  style: { borderRadius: 12 },
                }}
                style={styles.chart}
              />
            </View>
          ) : !indexedChartData ? (
            <View style={styles.chartPlaceholder}>
              <Text style={styles.chartPlaceholderText}>
                No holdings history yet. Use the wallet to build activity.
              </Text>
            </View>
          ) : null}
          <View style={styles.chartSymbolButtons}>
            <TouchableOpacity
              style={[
                styles.chartSymbolButton,
                chartQuoteUnit === 'usd' && styles.chartSymbolButtonActive,
              ]}
              onPress={() => handleChartTokenPress('usd')}
              onLongPress={() => handleChartTokenLongPress('usd')}
              delayLongPress={400}
              activeOpacity={0.7}
            >
              <View
                style={[styles.chartLegendDot, { backgroundColor: TOKEN_CHART_COLORS.usd }]}
              />
              <Text style={styles.chartSymbolButtonText}>USD</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.chartSymbolButton,
                chartQuoteUnit === 'xaut' && styles.chartSymbolButtonActive,
              ]}
              onPress={() => handleChartTokenPress('xaut')}
              onLongPress={() => handleChartTokenLongPress('xaut')}
              delayLongPress={400}
              activeOpacity={0.7}
            >
              <View
                style={[styles.chartLegendDot, { backgroundColor: TOKEN_CHART_COLORS.xaut }]}
              />
              <Text style={styles.chartSymbolButtonText}>{assetConfig.xaut?.symbol ?? 'XAU₮'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.chartSymbolButton,
                chartQuoteUnit === 'btc' && styles.chartSymbolButtonActive,
              ]}
              onPress={() => handleChartTokenPress('btc')}
              onLongPress={() => handleChartTokenLongPress('btc')}
              delayLongPress={400}
              activeOpacity={0.7}
            >
              <View
                style={[styles.chartLegendDot, { backgroundColor: TOKEN_CHART_COLORS.btc }]}
              />
              <Text style={styles.chartSymbolButtonText}>{assetConfig.btc?.symbol ?? 'BTC'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Activity */}
        <View style={styles.activitySection}>
          <View
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Text style={styles.sectionTitle}>Activity</Text>
            {walletTransactions.isLoading ? (
              <View style={{ marginRight: 8 }}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : null}
          </View>

          {transactions.length > 0 ? (
            transactions.map(tx => (
              <View key={tx.id} style={styles.transactionRow}>
                <View style={styles.transactionIcon}>
                  <tx.icon size={16} color={tx.iconColor} />
                </View>
                <View style={styles.transactionInfo}>
                  <Text style={styles.transactionType}>{tx.asset}</Text>
                  <Text style={styles.transactionSubtitle}>
                    {tx.type === 'sent' ? 'Sent' : 'Received'} • {tx.blockchain}
                  </Text>
                </View>
                <View style={styles.transactionAmount}>
                  <Text style={styles.transactionAssetAmount}>{tx.amount}</Text>
                  <Text style={styles.transactionUsdAmount}>{formatUSDValue(tx.fiatAmount)}</Text>
                </View>
              </View>
            ))
          ) : (
            <View style={styles.noAssetsContainer}>
              <Text style={styles.noAssetsText}>No transactions yet</Text>
            </View>
          )}

          <TouchableOpacity onPress={handleSeeAllActivity}>
            <Text style={styles.seeAllText}>See All</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Bottom Actions */}
      <View style={[styles.bottomActions, { marginBottom: insets.bottom }]}>
        <TouchableOpacity style={styles.actionButton} onPress={handleSendPress}>
          <ArrowUpRight size={20} color={colors.white} />
          <Text style={styles.actionButtonText}>Send</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.qrButton} onPress={handleQRPress}>
          <QrCode size={24} color={colors.black} />
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionButton} onPress={handleReceivePress}>
          <ArrowDownLeft size={20} color={colors.white} />
          <Text style={styles.actionButtonText}>Receive</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 120,
    flexGrow: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
  },
  walletInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 12,
  },
  walletIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  walletIconText: {
    fontSize: 12,
  },
  walletName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerButtonFirst: {
    padding: 8,
  },
  headerButton: {
    padding: 8,
    marginLeft: 8,
  },
  settingsButton: {
    padding: 8,
  },
  portfolioSection: {
    paddingHorizontal: 20,
    marginBottom: 32,
  },
  assetRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    paddingLeft: 16,
    marginBottom: 16,
  },
  assetInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  assetIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  assetIconImage: {
    width: 24,
    height: 24,
  },
  assetName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 2,
  },
  assetBalance: {
    alignItems: 'flex-end',
  },
  noAssetsContainer: {
    alignItems: 'center',
    paddingVertical: 0,
  },
  noAssetsText: {
    fontSize: 16,
    color: colors.textSecondary,
  },
  assetAmount: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 2,
  },
  assetValue: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  seeAllText: {
    fontSize: 16,
    color: colors.primary,
    textAlign: 'center',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  chartSection: {
    paddingHorizontal: chartSectionHorizontalPadding,
    marginBottom: 32,
  },
  chartHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  chartWrapper: {
    width: '100%',
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'visible',
    paddingTop: 4,
    paddingBottom: 4,
    paddingHorizontal: chartInnerPadding,
  },
  chartWrapperSpaced: {
    marginBottom: 2,
  },
  chart: {
    marginVertical: 0,
    borderRadius: 12,
    paddingTop: 4,
    paddingBottom: chartLabelPaddingBottom,
    paddingRight: chartYAxisPadding,
  },
  chartLegend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    marginTop: 2,
  },
  chartLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  chartLegendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 6,
  },
  chartLegendLabel: {
    fontSize: 14,
    color: colors.text,
    fontWeight: '500',
  },
  chartPlaceholder: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 24,
    minHeight: chartHeight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  chartPlaceholderText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  chartSymbolButtons: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    marginTop: 16,
    gap: 12,
  },
  chartSymbolButton: {
    flex: 1,
    flexDirection: 'row',
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: colors.border,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chartSymbolButtonActive: {
    backgroundColor: colors.cardDark,
    borderColor: colors.primary,
  },
  chartSymbolButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  activitySection: {
    paddingHorizontal: 20,
    marginBottom: 32,
  },
  transactionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    marginBottom: 12,
  },
  transactionIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  transactionInfo: {
    flex: 1,
  },
  transactionType: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.text,
    marginBottom: 2,
  },
  transactionSubtitle: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  transactionAmount: {
    alignItems: 'flex-end',
  },
  transactionAssetAmount: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 2,
  },
  transactionUsdAmount: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  bottomActions: {
    position: 'absolute',
    bottom: 20,
    left: 72,
    right: 72,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 48,
    paddingHorizontal: 20,
    paddingVertical: 16,
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    height: 80,
  },
  actionButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
  },
  actionButtonText: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 4,
  },
  qrButton: {
    width: 48,
    height: 48,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 20,
    backgroundColor: colors.primary,
  },
});
