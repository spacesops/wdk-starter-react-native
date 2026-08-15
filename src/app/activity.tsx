import { useWallet, useWalletManager } from '@spacesops/wdk-react-native-core';
import { Transaction, TransactionList } from '@tetherto/wdk-uikit-react-native';
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Header from '@/components/header';
import { colors } from '@/constants/colors';
import { flattenWalletAddresses } from '@/utils/wallet-addresses';
import { resolveCurrentWalletId } from '@/utils/resolve-current-wallet-id';

/**
 * Activity historically came from useWallet().transactions.
 * @spacesops/wdk-react-native-core does not expose a transaction list yet.
 */
export default function ActivityScreen() {
  const insets = useSafeAreaInsets();
  const { wallets, activeWalletId } = useWalletManager();
  const currentWalletId = resolveCurrentWalletId(activeWalletId, wallets);
  const { addresses } = useWallet(
    currentWalletId ? { walletId: currentWalletId } : undefined
  );
  const [transactions] = useState<Transaction[]>([]);

  // Keep address flattening wired so we can restore sent/received once txs return.
  useMemo(() => flattenWalletAddresses(addresses), [addresses]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Header isLoading={false} title="Activity" />
      {transactions.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No activity yet</Text>
          <Text style={styles.emptySubtitle}>
            Transaction history is not available with the current WDK core. Balances and sends still
            work.
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
