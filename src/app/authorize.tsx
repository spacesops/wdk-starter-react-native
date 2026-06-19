import { useWallet } from '@tetherto/wdk-react-native-provider';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import { Shield } from 'lucide-react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/constants/colors';
import getErrorMessage from '@/utils/get-error-message';
import {
  findAddressDrift,
  formatAddressDriftMessage,
  loadStoredWalletAddresses,
} from '@/utils/wallet-address-guard';

/** Brief pause after WDK init before keychain biometric prompt (worklet settle). */
const UNLOCK_READY_DELAY_MS = 450;

function isBiometricUserCancel(message: string): boolean {
  return message.includes('code: 10');
}

function isBiometricLockedOut(message: string): boolean {
  return message.includes('code: 13');
}

function isBiometricTooManyAttempts(message: string): boolean {
  return message.includes('code: 7');
}

function isSecureStorageUnlockError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('secure storage') ||
    lower.includes('biometric') ||
    lower.includes('keychain') ||
    lower.includes('could not read wallet') ||
    lower.includes('could not load wallet seed')
  );
}

export default function AuthorizeScreen() {
  const insets = useSafeAreaInsets();
  const router = useDebouncedNavigation();
  const { wallet, unlockWallet, isInitialized, isUnlocked } = useWallet();
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlockInFlightRef = useRef(false);
  const hasAutoTriggeredRef = useRef(false);

  const handleAuthorize = useCallback(async () => {
    if (unlockInFlightRef.current) {
      return;
    }

    if (!isInitialized) {
      return;
    }

    if (!wallet) {
      Alert.alert('Error', 'No wallet found');
      router.replace('/onboarding');
      return;
    }

    unlockInFlightRef.current = true;
    setIsUnlocking(true);
    setError(null);

    const addressesBeforeUnlock = await loadStoredWalletAddresses();

    try {
      const isDone = await unlockWallet();
      if (!isDone) {
        setError('Could not unlock wallet. Tap the screen to try again.');
        return;
      }

      const addressesAfterUnlock = await loadStoredWalletAddresses();
      const drift = findAddressDrift(addressesBeforeUnlock, addressesAfterUnlock);
      if (drift.length > 0) {
        console.warn('[Authorize] Address drift detected after unlock:', drift);
        Alert.alert('Address mismatch', formatAddressDriftMessage(drift));
      }

      router.replace('/wallet');
    } catch (unlockError) {
      const message = getErrorMessage(unlockError, 'Failed to unlock wallet');

      if (isBiometricUserCancel(message)) {
        setError(null);
        return;
      }

      if (isBiometricLockedOut(message)) {
        setError('Biometrics locked. Use your device PIN, then tap the screen to try again.');
        return;
      }

      if (isBiometricTooManyAttempts(message)) {
        setError('Too many attempts. Tap the screen to try again in a moment.');
        return;
      }

      if (isSecureStorageUnlockError(message)) {
        setError('Could not access your wallet keys. Tap the screen to try again.');
        return;
      }

      console.error('Failed to unlock wallet:', unlockError);
      setError('Authentication failed. Tap the screen to try again.');
    } finally {
      unlockInFlightRef.current = false;
      setIsUnlocking(false);
    }
  }, [isInitialized, router, unlockWallet, wallet]);

  useEffect(() => {
    if (isUnlocked) {
      router.replace('/wallet');
      return;
    }

    if (!isInitialized || !wallet || hasAutoTriggeredRef.current) {
      return;
    }

    hasAutoTriggeredRef.current = true;
    const timer = setTimeout(() => {
      handleAuthorize();
    }, UNLOCK_READY_DELAY_MS);

    return () => clearTimeout(timer);
  }, [handleAuthorize, isInitialized, isUnlocked, router, wallet]);

  const isPreparing = !isInitialized || !wallet;
  const showSpinner = isPreparing || isUnlocking;

  return (
    <Pressable
      style={[styles.container, { paddingTop: insets.top }]}
      onPress={() => {
        if (!isUnlocking && !isPreparing) {
          handleAuthorize();
        }
      }}
      disabled={isUnlocking || isPreparing}
    >
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Shield size={80} color={colors.primary} />
        </View>

        <Text style={styles.title}>Authorize Access</Text>
        <Text style={styles.subtitle}>Verify your identity to access your wallet</Text>

        {showSpinner && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.loadingText}>
              {isPreparing ? 'Preparing wallet...' : 'Unlocking wallet...'}
            </Text>
          </View>
        )}

        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </View>

      <View style={[styles.footer, { marginBottom: insets.bottom + 20 }]}>
        <Text style={styles.footerText}>Your wallet is encrypted and secured with your device</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  iconContainer: {
    marginBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: colors.text,
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 50,
  },
  loadingContainer: {
    alignItems: 'center',
    marginTop: 50,
  },
  loadingText: {
    color: colors.textSecondary,
    marginTop: 16,
    fontSize: 14,
  },
  errorContainer: {
    marginTop: 20,
    padding: 12,
    backgroundColor: colors.dangerBackground,
    borderRadius: 8,
    width: '100%',
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
    textAlign: 'center',
  },
  footer: {
    paddingHorizontal: 40,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 12,
    color: colors.textTertiary,
    textAlign: 'center',
  },
});
