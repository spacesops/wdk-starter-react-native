import { SeedPhrase } from '@/components/SeedPhrase';
import { useAppWalletManager } from '@/hooks/use-app-wallet-manager';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import {
  applyKeystoreMetadata,
  mnemonicsMatch,
  type SpacesKeystoreBackup,
} from '@/services/keystore-backup';
import {
  clearPendingKeystoreBackup,
  peekPendingKeystoreBackup,
} from '@/utils/keystore-backup-session';
import { TWELVE_WORD_COUNT } from '@/utils/parse-twelve-word-mnemonic';
import getErrorMessage from '@/utils/get-error-message';
import { colors } from '@/constants/colors';
import * as Clipboard from 'expo-clipboard';
import * as bip39 from 'bip39';
import { ChevronLeft } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

export default function ImportKeystoreConfirmScreen() {
  const router = useDebouncedNavigation();
  const insets = useSafeAreaInsets();
  const { initializeFromMnemonic, wallets } = useAppWalletManager();
  const [backup] = useState<SpacesKeystoreBackup | null>(() => peekPendingKeystoreBackup());
  const [secretWords, setSecretWords] = useState<string[]>(Array(TWELVE_WORD_COUNT).fill(''));
  const [isRestoring, setIsRestoring] = useState(false);

  useEffect(() => {
    if (!backup) {
      Alert.alert('Missing backup', 'No keystore backup was selected. Go back and choose a file.', [
        {
          text: 'OK',
          onPress: () => router.replace('/wallet-setup/import-keystore'),
        },
      ]);
    }
  }, [backup, router]);

  const handleWordChange = (index: number, text: string) => {
    const newWords = [...secretWords];
    newWords[index] = text.trim().toLowerCase();
    setSecretWords(newWords);
  };

  const handlePaste = async () => {
    try {
      const clipboardContent = await Clipboard.getStringAsync();
      if (!clipboardContent.trim()) {
        toast.error('Empty Clipboard! No text found in clipboard');
        return;
      }
      const words = clipboardContent.trim().split(/\s+/).slice(0, TWELVE_WORD_COUNT);
      if (words.length < TWELVE_WORD_COUNT) {
        toast.error(
          `Invalid Phrase! Found only ${words.length} words. Please paste exactly ${TWELVE_WORD_COUNT} words.`
        );
        return;
      }
      setSecretWords(words.map(word => word.toLowerCase().trim()));
      toast.success('12 words pasted from clipboard');
    } catch {
      toast.error('Could not paste from clipboard');
    }
  };

  const isFormValid = () => secretWords.every(word => word.trim().length > 0);

  const handleRestore = async () => {
    if (!backup) {
      toast.error('No keystore backup loaded');
      return;
    }
    if (wallets.some(w => w.exists)) {
      Alert.alert(
        'Wallet already exists',
        'Delete the existing wallet from Settings before restoring a keystore backup.'
      );
      return;
    }
    if (!isFormValid()) {
      Alert.alert('Incomplete', `Please fill in all ${TWELVE_WORD_COUNT} words`);
      return;
    }

    const entered = secretWords.join(' ');
    if (!bip39.validateMnemonic(entered)) {
      Alert.alert('Invalid Seed Phrase', 'This recovery phrase is not valid. Check your words.');
      return;
    }
    if (!mnemonicsMatch(entered, backup.mnemonic)) {
      Alert.alert(
        'Phrase does not match',
        'The recovery phrase you entered does not match this keystore backup.'
      );
      return;
    }

    setIsRestoring(true);
    try {
      await initializeFromMnemonic(entered, 'default');
      await applyKeystoreMetadata(backup);
      clearPendingKeystoreBackup();
      toast.success('Keystore restored');
      router.dismissAll('/wallet');
    } catch (error) {
      console.error('Failed to restore keystore:', error);
      Alert.alert('Restore failed', getErrorMessage(error, 'Could not restore keystore'));
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          disabled={isRestoring}
        >
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Confirm Phrase</Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Prove you own this backup</Text>
          <Text style={styles.subtitle}>
            Enter the 12-word recovery phrase from this keystore file to finish restoring
            {backup?.walletName ? ` “${backup.walletName}”` : ''}.
          </Text>

          <TouchableOpacity style={styles.pasteButton} onPress={handlePaste} disabled={isRestoring}>
            <Text style={styles.pasteButtonText}>Paste from clipboard</Text>
          </TouchableOpacity>

          <SeedPhrase words={secretWords} editable={!isRestoring} onWordChange={handleWordChange} />

          <TouchableOpacity
            style={[
              styles.restoreButton,
              (!isFormValid() || isRestoring) && styles.restoreButtonDisabled,
            ]}
            onPress={handleRestore}
            disabled={!isFormValid() || isRestoring}
            activeOpacity={0.7}
          >
            {isRestoring ? (
              <ActivityIndicator size="small" color={colors.black} />
            ) : (
              <Text style={styles.restoreButtonText}>Restore Keystore</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backButton: {
    padding: 4,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
    color: colors.text,
  },
  headerSpacer: {
    width: 32,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 15,
    color: colors.textSecondary,
    lineHeight: 22,
    marginBottom: 20,
  },
  pasteButton: {
    alignSelf: 'flex-start',
    marginBottom: 16,
  },
  pasteButtonText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '600',
  },
  restoreButton: {
    marginTop: 8,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  restoreButtonDisabled: {
    opacity: 0.5,
  },
  restoreButtonText: {
    color: colors.black,
    fontSize: 16,
    fontWeight: '600',
  },
});
