import { BalanceLoader } from '@/components/BalanceLoader';
import { AssetTicker, useWallet } from '@tetherto/wdk-react-native-provider';
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
import { AssetConfig, assetConfig } from '../config/assets';
import { FiatCurrency, pricingService } from '../services/pricing-service';
import {
  buildBtcDailyBalanceTable,
  buildSaveAndReturnBtcDailyBalanceTable,
  saveBtcDailyBalanceTable,
} from '@/services/btc-daily-balance-storage';
import {
  buildPriceChartData,
  isSentByWalletUI,
  loadHistoricalPrices,
  onHistoricalPricesUpdated,
  type PriceChartData,
} from '@/services/historical-price-storage';
import formatAmount from '@/utils/format-amount';
import formatTokenAmount from '@/utils/format-token-amount';
import formatUSDValue from '@/utils/format-usd-value';
import useWalletAvatar from '@/hooks/use-wallet-avatar';
import { colors } from '@/constants/colors';

const chartWidth = Dimensions.get('window').width - 40;
const chartHeight = 220;

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
  const {
    wallet,
    isLoading,
    isUnlocked,
    refreshWalletBalance,
    balances,
    addresses,
    transactions: walletTransactions,
  } = useWallet();
  const [refreshing, setRefreshing] = useState(false);
  const [aggregatedBalances, setAggregatedBalances] = useState<AggregatedBalance>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [chartData, setChartData] = useState<PriceChartData | null>(null);
  const [mounted, setMounted] = useState(false);
  const avatar = useWalletAvatar();
  const scrollY = useRef(new Animated.Value(0)).current;

  const hasWallet = !!wallet;

  // Redirect to authorization if wallet is not unlocked
  useEffect(() => {
    if (hasWallet && !isUnlocked) {
      router.replace('/authorize');
    }
  }, [hasWallet, isUnlocked, router]);

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

  /** Normalize provider token to config key (e.g. "XAU₮", "XAU" -> "xaut") so we match XAU₮ transactions. */
  const tokenToConfigKey = useCallback((token: string | undefined): string => {
    const t = (token ?? '').toString().toLowerCase();
    if (t === 'xaut' || t === 'xau' || t.startsWith('xau')) return 'xaut';
    if (t === 'usat' || t === 'usa' || t.startsWith('usa')) return 'usat';
    return t || '';
  }, []);

  const handleXautChartButtonPress = useCallback(() => {
    const rawList = walletTransactions?.list ?? [];
    // Diagnostic: balance comes from indexer token-balances; transactions from token-transfers.
    // If the indexer does not return XAUT transfers, you get balance but no XAUT transactions.
    const byToken = rawList.reduce<Record<string, number>>((acc, tx) => {
      const key = tokenToConfigKey(tx.token) || (tx.token ?? '?');
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    console.log('[XAU₮] Transaction list total:', rawList.length, 'by token:', byToken);

    const isXautTx = (tx: { token?: string }) => tokenToConfigKey(tx.token) === 'xaut';
    const xautTxs = rawList.filter(isXautTx);
    console.log('[XAU₮] transactions count:', xautTxs.length);
    xautTxs.forEach((tx, i) => {
      console.log('[XAU₮]', i + 1, tx);
    });

    // Log first (earliest) XAUT transaction with date in YYYY-MM-DD HH:mm:ss
    if (xautTxs.length > 0) {
      const earliestXaut = xautTxs.reduce((a, b) =>
        ((a.timestamp ?? 0) <= (b.timestamp ?? 0) ? a : b)
      );
      const tsXaut = earliestXaut.timestamp;
      const msXaut = typeof tsXaut === 'number' && tsXaut < 1e12 ? tsXaut * 1000 : tsXaut;
      const dXaut = new Date(msXaut);
      const dateStrXaut =
        `${dXaut.getFullYear()}-${String(dXaut.getMonth() + 1).padStart(2, '0')}-${String(dXaut.getDate()).padStart(2, '0')} ` +
        `${String(dXaut.getHours()).padStart(2, '0')}:${String(dXaut.getMinutes()).padStart(2, '0')}:${String(dXaut.getSeconds()).padStart(2, '0')}`;
      console.log('[XAU₮] First XAU₮ transaction:', dateStrXaut, earliestXaut);
    } else {
      console.log('[XAU₮] First XAU₮ transaction: none');
    }

    // Log earliest Bitcoin transaction with date in YYYY-MM-DD HH:mm:ss
    const isBtcTx = (tx: { token?: string }) => (tx.token ?? '').toString().toLowerCase() === 'btc';
    const btcTxs = rawList.filter(isBtcTx);
    if (btcTxs.length === 0) {
      console.log('[XAUT] Earliest Bitcoin transaction: none');
      return;
    }
    const earliest = btcTxs.reduce((a, b) =>
      ((a.timestamp ?? 0) <= (b.timestamp ?? 0) ? a : b)
    );
    const ts = earliest.timestamp;
    const ms = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    const dateStr =
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    console.log('[XAUT] Earliest Bitcoin transaction:', dateStr, earliest);
  }, [walletTransactions?.list, tokenToConfigKey]);

  const handleBtcChartButtonPress = useCallback(async () => {
    const rawList = walletTransactions?.list ?? [];
    const txList = rawList.map((tx) => ({
      timestamp: tx.timestamp,
      token: tx.token,
      amount: parseFloat(tx.amount) || 0,
      from: tx.from ?? '',
      to: (tx as { to?: string }).to ?? '',
    }));
    const walletAddresses = addresses ? Object.values(addresses).map((a) => a?.toLowerCase()) : [];
    const table = await buildSaveAndReturnBtcDailyBalanceTable(txList, walletAddresses);
    const sortedDates = Object.keys(table).sort();
    for (const date of sortedDates) {
      console.log(`${date} ${table[date]}`);
    }
  }, [walletTransactions?.list, addresses]);

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
    if (!wallet) return;

    setRefreshing(true);
    try {
      await refreshWalletBalance();
      await loadChartData();
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

  const loadChartData = useCallback(async () => {
    try {
      const stored = await loadHistoricalPrices();
      setChartData(buildPriceChartData(stored, 80, ['btc']) ?? null);
    } catch {
      setChartData(null);
    }
  }, []);

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

  const chartXAxisConfig = useMemo(() => {
    const n = chartData?.labels?.length ?? 0;
    const step = Math.max(1, Math.floor(n / 8));
    const show = new Set<number>();
    for (let i = 0; i < n; i += step) show.add(i);
    if (n > 0) show.add(n - 1);
    const hidePointsAtIndex = Array.from({ length: n }, (_, i) => i).filter((i) => !show.has(i));
    return {
      yAxisInterval: Math.max(1, step),
      hidePointsAtIndex,
    };
  }, [chartData?.labels?.length]);

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
          <Text style={styles.walletName}>{wallet?.name || 'No Wallet'}</Text>
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
                    if (wallet) {
                      router.push({
                        pathname: '/token-details',
                        params: {
                          walletId: wallet.id,
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

        {/* Last 100 days price chart */}
        <View style={styles.chartSection}>
          {chartData && chartData.datasets.length > 0 ? (
            <>
              <View style={[styles.chartWrapper, { width: chartWidth }]}>
                <LineChart
                data={chartData}
                width={chartWidth - 24}
                height={chartHeight}
                yAxisLabel="$"
                yAxisSuffix=""
                segments={3}
                yLabelsOffset={12}
                yAxisInterval={chartXAxisConfig.yAxisInterval}
                hidePointsAtIndex={chartXAxisConfig.hidePointsAtIndex}
                xLabelsOffset={8}
                fromZero={false}
                withDots={false}
                withInnerLines={true}
                withOuterLines={true}
                withVerticalLabels={true}
                withHorizontalLabels={true}
                chartConfig={{
                  backgroundColor: colors.card,
                  backgroundGradientFrom: colors.card,
                  backgroundGradientTo: colors.cardDark,
                  decimalPlaces: 0,
                  formatYLabel: (value: string) =>
                    `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
                  color: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
                  labelColor: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
                  useShadowColorFromDataset: true,
                  fillShadowGradientFromOpacity: 0.25,
                  fillShadowGradientToOpacity: 0.25,
                  propsForBackgroundLines: { stroke: colors.border, strokeWidth: 0.5 },
                  style: { borderRadius: 12 },
                }}
                bezier
                style={styles.chart}
              />
              </View>
            </>
          ) : (
            <View style={styles.chartPlaceholder}>
              <Text style={styles.chartPlaceholderText}>
                No price history yet. Use the wallet to build activity.
              </Text>
            </View>
          )}
          <View style={styles.chartSymbolButtons}>
            <TouchableOpacity
              style={styles.chartSymbolButton}
              onPress={handleXautChartButtonPress}
              activeOpacity={0.7}
            >
              <Text style={styles.chartSymbolButtonText}>{assetConfig.xaut?.symbol ?? 'XAU₮'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.chartSymbolButton}
              onPress={handleBtcChartButtonPress}
              activeOpacity={0.7}
            >
              <Text style={styles.chartSymbolButtonText}>{assetConfig.btc?.symbol ?? 'BTC'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.chartSymbolButton}
              onPress={() => {}}
              activeOpacity={0.7}
            >
              <Text style={styles.chartSymbolButtonText}>{assetConfig.usat?.symbol ?? 'USA₮'}</Text>
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
    paddingVertical: 40,
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
    paddingHorizontal: 20,
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
  },
  chart: {
    marginVertical: 0,
    borderRadius: 12,
    paddingRight: 52,
  },
  chartLegend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    marginTop: 12,
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
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: colors.border,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
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
