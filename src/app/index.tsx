import { useWallet, useWalletManager } from '@spacesops/wdk-react-native-core';
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { getPricingServiceHostname, pricingService } from '../services/pricing-service';
import { colors } from '@/constants/colors';
import { resolveCurrentWalletId } from '@/utils/resolve-current-wallet-id';

export default function Index() {
  const { wallets, activeWalletId, refreshWalletList } = useWalletManager();
  const currentWalletId = resolveCurrentWalletId(activeWalletId, wallets);
  const { isInitialized } = useWallet(
    currentWalletId ? { walletId: currentWalletId } : undefined
  );
  const [isPricingReady, setIsPricingReady] = useState(false);
  const [isListReady, setIsListReady] = useState(false);
  const [isPricingErrorVisible, setIsPricingErrorVisible] = useState(false);
  const pricingHostname = getPricingServiceHostname();

  const initializePricing = async () => {
    try {
      await pricingService.initialize();
      setIsPricingReady(true);
    } catch (error) {
      console.error('Failed to initialize pricing service:', error);
      setIsPricingReady(true);
      setIsPricingErrorVisible(true);
    }
  };

  useEffect(() => {
    initializePricing();
  }, []);

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

  let content: React.ReactElement;

  if (!isListReady || !isPricingReady) {
    content = (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  } else {
    const walletExists = wallets.some(w => w.exists);
    if (!walletExists) {
      content = <Redirect href="/onboarding" />;
    } else {
      content = <Redirect href={isInitialized ? '/wallet' : '/authorize'} />;
    }
  }

  return (
    <>
      {content}
      <Modal
        transparent
        visible={isPricingErrorVisible}
        animationType="fade"
        onRequestClose={() => setIsPricingErrorVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Pricing Service Unavailable</Text>
            <Text style={styles.modalMessage}>
              {`The pricing service ${pricingHostname} is not availabe.  Check your network connection or try again later.`}
            </Text>
            <TouchableOpacity
              style={styles.modalButton}
              onPress={() => setIsPricingErrorVisible(false)}
            >
              <Text style={styles.modalButtonText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '80%',
    borderRadius: 12,
    padding: 20,
    backgroundColor: colors.background,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    color: colors.text,
  },
  modalMessage: {
    fontSize: 14,
    marginBottom: 20,
    color: colors.textSecondary ?? colors.text,
  },
  modalButton: {
    alignSelf: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.primary,
  },
  modalButtonText: {
    color: colors.background,
    fontWeight: '600',
  },
});
