import {
  useWallet,
  useWalletManager,
  useWalletTransactions,
  useBalancesForWallet,
  type WalletTransaction,
} from '@spacesops/wdk-react-native-core';
import { Transaction, TransactionList } from '@tetherto/wdk-uikit-react-native';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Header from '@/components/header';
import { colors } from '@/constants/colors';
import getTokenConfigs from '@/config/get-token-configs';
import {
  DISPLAY_WALLET_NETWORKS,
  useEnsureWalletAddresses,
} from '@/hooks/use-ensure-wallet-addresses';
import { FiatCurrency, pricingService } from '@/services/pricing-service';
import formatTokenAmount from '@/utils/format-token-amount';
import { isSentByWalletUI } from '@/services/historical-price-storage';
import { flattenWalletAddresses } from '@/utils/wallet-addresses';
import { resolveCurrentWalletId } from '@/utils/resolve-current-wallet-id';
import { filterTokenConfigsByNonZeroBalance } from '@/utils/filter-token-configs-by-balance';
import { AssetTicker } from '@/config/assets';

function tokenToConfigKey(token: string | undefined): string {
  const t = (token ?? '').toLowerCase();
  if (t === 'xaut' || t === 'xau' || t.startsWith('xau')) return AssetTicker.XAUT;
  if (t === 'usat' || t === 'usa' || t.startsWith('usa')) return AssetTicker.USAT;
  if (t === 'usdt' || t.startsWith('usd')) return AssetTicker.USDT;
  if (t === 'btc') return AssetTicker.BTC;
  return t;
}

async function mapWalletTransactionToUi(
  tx: WalletTransaction,
  walletAddresses: string[],
  index: number
): Promise<Transaction> {
  const tokenKey = tokenToConfigKey(tx.token);
  const amount = parseFloat(tx.amount);
  const isSent = isSentByWalletUI(tx.from, walletAddresses);

  if (!pricingService.isReady()) {
    await pricingService.initialize().catch(() => {});
  }
  const fiatAmount = await pricingService.getFiatValue(
    amount,
    tokenKey as AssetTicker,
    FiatCurrency.USD
  );

  return {
    id: `${tx.transactionHash}-${tx.transferIndex ?? index}`,
    token: tokenKey.toUpperCase(),
    amount: formatTokenAmount(amount, tokenKey as AssetTicker),
    fiatAmount: fiatAmount.toFixed(2),
    fiatCurrency: FiatCurrency.USD,
    network: tx.blockchain,
    type: isSent ? 'sent' : 'received',
  };
}

export default function ActivityScreen() {
  const insets = useSafeAreaInsets();
  const { wallets, activeWalletId } = useWalletManager();
  const currentWalletId = resolveCurrentWalletId(activeWalletId, wallets);
  const tokenConfigs = useMemo(() => getTokenConfigs(), []);
  const { isInitialized, addresses: nestedAddresses } = useWallet(
    currentWalletId ? { walletId: currentWalletId } : undefined
  );
  const { addressesSettled } = useEnsureWalletAddresses(
    DISPLAY_WALLET_NETWORKS,
    currentWalletId
  );
  const {
    data: balanceResults,
    isLoading: isLoadingBalances,
  } = useBalancesForWallet(0, tokenConfigs, {
    enabled: isInitialized && addressesSettled,
  });
  const activityTokenConfigs = useMemo(
    () => filterTokenConfigsByNonZeroBalance(tokenConfigs, balanceResults),
    [tokenConfigs, balanceResults]
  );
  const balancesReady = !isLoadingBalances && Boolean(balanceResults);
  const {
    data: walletTransactionList = [],
    isLoading,
    isError,
  } = useWalletTransactions(0, activityTokenConfigs, {
    enabled:
      isInitialized &&
      Boolean(currentWalletId) &&
      balancesReady &&
      Object.keys(activityTokenConfigs).length > 0,
    walletId: currentWalletId,
  });

  const walletAddresses = useMemo(
    () =>
      Object.values(flattenWalletAddresses(nestedAddresses)).map((a) =>
        a.toLowerCase()
      ),
    [nestedAddresses]
  );

  const [transactions, setTransactions] = React.useState<Transaction[]>([]);
  const showLoading = isLoadingBalances || isLoading;

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const mapped = await Promise.all(
        walletTransactionList.map((tx, index) =>
          mapWalletTransactionToUi(tx, walletAddresses, index)
        )
      );
      if (!cancelled) {
        setTransactions(mapped);
      }
    };
    load().catch(() => {
      if (!cancelled) setTransactions([]);
    });
    return () => {
      cancelled = true;
    };
  }, [walletTransactionList, walletAddresses]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Header isLoading={showLoading} title="Activity" />
      {transactions.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>
            {showLoading ? 'Loading activity…' : 'No activity yet'}
          </Text>
          <Text style={styles.emptySubtitle}>
            {isError
              ? 'Could not load transaction history from the WDK Indexer.'
              : 'Transfers appear here once indexed for your wallet addresses.'}
          </Text>
        </View>
      ) : (
        <TransactionList transactions={transactions} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: colors.textTertiary,
    textAlign: 'center',
    lineHeight: 20,
  },
});
