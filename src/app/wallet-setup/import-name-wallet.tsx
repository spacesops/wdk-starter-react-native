import avatarOptions, { setAvatar } from '@/config/avatar-options';
import { useWallet } from '@tetherto/wdk-react-native-provider';
import { useLocalSearchParams } from 'expo-router';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import { useKeyboard } from '@/hooks/use-keyboard';
import {
  clearPendingImportMnemonic,
  consumePendingImportMnemonic,
} from '@/utils/import-mnemonic-session';
import { logImportError, logImportStep } from '@/utils/import-wallet-logger';
import getErrorMessage from '@/utils/get-error-message';
import * as bip39 from 'bip39';
import { ChevronLeft } from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';
import { colors } from '@/constants/colors';
import {
  ActivityIndicator,
  Alert,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

function parseMnemonicParam(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return '';
  }
  return value.split(',').join(' ');
}

export default function ImportNameWalletScreen() {
  const router = useDebouncedNavigation();
  const params = useLocalSearchParams<{ mnemonic?: string | string[]; seedPhrase?: string | string[] }>();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboard();
  const { createWallet } = useWallet();
  const [walletName, setWalletName] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState(avatarOptions[0]);
  const [isImporting, setIsImporting] = useState(false);
  const [sessionMnemonic] = useState(() => consumePendingImportMnemonic());

  const seedPhrase = useMemo(() => {
    if (sessionMnemonic) {
      return sessionMnemonic;
    }
    return (
      parseMnemonicParam(params.mnemonic) ||
      parseMnemonicParam(params.seedPhrase)
    );
  }, [params.mnemonic, params.seedPhrase, sessionMnemonic]);

  useEffect(() => {
    logImportStep('name screen mounted', {
      hasSeed: seedPhrase.length > 0,
      wordCount: seedPhrase ? seedPhrase.split(/\s+/).length : 0,
    });
    if (!seedPhrase) {
      logImportError('name screen mount', 'missing mnemonic');
    }
    return () => {
      clearPendingImportMnemonic();
    };
  }, [seedPhrase]);

  const handleNext = async () => {
    Keyboard.dismiss();

    if (!seedPhrase) {
      Alert.alert('Error', 'No seed phrase provided. Please go back and enter your seed phrase.');
      return;
    }

    if (!bip39.validateMnemonic(seedPhrase)) {
      Alert.alert(
        'Invalid Seed Phrase',
        'This recovery phrase is not valid. Go back and check your words.',
        [{ text: 'OK' }]
      );
      return;
    }

    setIsImporting(true);
    logImportStep('createWallet starting', { walletName });

    try {
      await createWallet({ name: walletName, mnemonic: seedPhrase });
      logImportStep('createWallet finished');

      await setAvatar(selectedAvatar.id);
      logImportStep('avatar saved');

      toast.success('Your wallet has been imported successfully.');

      // Let WDK worklet + wallet context effects settle before navigation (matches authorize screen).
      await new Promise<void>(resolve => setTimeout(resolve, 450));

      await new Promise<void>(resolve => {
        InteractionManager.runAfterInteractions(() => resolve());
      });

      logImportStep('navigating to wallet');
      router.dismissTo('/wallet');
      logImportStep('navigation dispatched');
    } catch (error: unknown) {
      logImportError('createWallet', error);
      Alert.alert(
        'Import Failed',
        getErrorMessage(error, 'Failed to import wallet. Please check your seed phrase and try again.'),
        [{ text: 'OK' }]
      );
    } finally {
      setIsImporting(false);
    }
  };

  const isNextDisabled = walletName.length === 0 || isImporting;

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <View style={styles.inner}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
              <ChevronLeft size={24} color={colors.primary} />
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.title}>Name Your Wallet</Text>
            <Text style={styles.subtitle}>This name is just for you and can be changed later.</Text>

            <View style={styles.inputSection}>
              <Text style={styles.label}>Wallet Name*</Text>
              <View style={styles.inputContainer}>
                <Text style={styles.inputIcon}>💼</Text>
                <TextInput
                  style={styles.input}
                  value={walletName}
                  onChangeText={setWalletName}
                  placeholder="e.g., Investment Stash"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="words"
                  returnKeyType="done"
                  blurOnSubmit
                  onSubmitEditing={Keyboard.dismiss}
                />
              </View>
            </View>

            <View style={styles.avatarSection}>
              <Text style={styles.sectionTitle}>Choose an avatar</Text>
              <View style={styles.avatarGrid}>
                {avatarOptions.map(avatar => (
                  <TouchableOpacity
                    key={avatar.id}
                    style={[
                      styles.avatarItem,
                      { backgroundColor: avatar.color },
                      selectedAvatar.id === avatar.id && styles.selectedAvatar,
                    ]}
                    onPress={() => setSelectedAvatar(avatar)}
                  >
                    <Text style={styles.avatarEmoji}>{avatar.emoji}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </ScrollView>

          <View
            style={[
              styles.footer,
              { paddingBottom: (keyboard.isVisible ? 12 : insets.bottom + 20) },
            ]}
          >
            <TouchableOpacity
              style={[styles.nextButton, isNextDisabled && styles.nextButtonDisabled]}
              onPress={handleNext}
              disabled={isNextDisabled}
            >
              {isImporting ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator size="small" color={colors.textTertiary} />
                  <Text
                    style={[
                      styles.nextButtonText,
                      isNextDisabled && styles.nextButtonTextDisabled,
                      { marginLeft: 8 },
                    ]}
                  >
                    Importing...
                  </Text>
                </View>
              ) : (
                <Text style={[styles.nextButtonText, isNextDisabled && styles.nextButtonTextDisabled]}>
                  Import Wallet
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  inner: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backText: {
    color: colors.primary,
    fontSize: 16,
    marginLeft: 4,
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: colors.text,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: colors.textSecondary,
    marginBottom: 32,
  },
  inputSection: {
    marginBottom: 32,
  },
  label: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 8,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  inputError: {
    borderColor: colors.danger,
  },
  inputIcon: {
    fontSize: 20,
    marginRight: 12,
  },
  input: {
    flex: 1,
    height: 50,
    color: colors.text,
    fontSize: 16,
  },
  helperText: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 8,
  },
  errorText: {
    fontSize: 12,
    color: colors.danger,
    marginTop: 8,
  },
  avatarSection: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 20,
  },
  avatarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -6,
    marginBottom: 24,
  },
  avatarItem: {
    width: 56,
    height: 56,
    borderRadius: 28,
    margin: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  selectedAvatar: {
    borderColor: colors.primary,
  },
  avatarEmoji: {
    fontSize: 28,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  nextButton: {
    backgroundColor: colors.primary,
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextButtonDisabled: {
    backgroundColor: colors.card,
  },
  nextButtonText: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.black,
  },
  nextButtonTextDisabled: {
    color: colors.textTertiary,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
