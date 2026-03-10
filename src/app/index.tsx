import { useWallet } from '@tetherto/wdk-react-native-provider';
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

export default function Index() {
  const { wallet, isInitialized, isUnlocked } = useWallet();
  const [isPricingReady, setIsPricingReady] = useState(false);
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

  let content: JSX.Element;

  // Show loading indicator while WDK and pricing service are being initialized
  if (!isInitialized || !isPricingReady) {
    content = (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  } else if (!wallet) {
    // Redirect based on wallet existence and unlock status
    content = <Redirect href="/onboarding" />;
  } else {
    // If wallet exists but is not unlocked, go to authorization
    // If wallet is already unlocked (e.g., just created/imported), go directly to wallet
    content = <Redirect href={isUnlocked ? '/wallet' : '/authorize'} />;
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
