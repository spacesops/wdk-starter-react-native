import { useWalletManager } from '@spacesops/wdk-react-native-core';
import { useAppWallet } from '@/hooks/use-app-wallet';
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { colors } from '@/constants/colors';
export default function Index() {
  const { wallets, refreshWalletList } = useWalletManager();
  const { isInitialized } = useAppWallet();
  const [isListReady, setIsListReady] = useState(false);

  useEffect(() => {
    const loadWallets = async () => {
      try {
        await refreshWalletList();
      } catch (error) {
        console.error('Failed to refresh wallet list:', error);
      } finally {
        setIsListReady(true);
      }
    };
    loadWallets();
  }, [refreshWalletList]);

  if (!isListReady) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const walletExists = wallets.some(w => w.exists);
  if (!walletExists) {
    return <Redirect href="/onboarding" />;
  }

  return <Redirect href={isInitialized ? '/wallet' : '/authorize'} />;
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
});
