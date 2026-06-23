import { SeedPhrase } from '@/components/SeedPhrase';
import * as Clipboard from 'expo-clipboard';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import {
  consumeScannedImportWords,
  setPendingImportMnemonic,
} from '@/utils/import-mnemonic-session';
import { TWELVE_WORD_COUNT } from '@/utils/parse-twelve-word-mnemonic';
import { logImportStep } from '@/utils/import-wallet-logger';
import * as bip39 from 'bip39';
import { useFocusEffect } from '@react-navigation/native';
import { ChevronLeft, Download, FileText, ScanText } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import { colors } from '@/constants/colors';
import {
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

export default function ImportWalletScreen() {
  const router = useDebouncedNavigation();
  const insets = useSafeAreaInsets();
  const [secretWords, setSecretWords] = useState<string[]>(Array(TWELVE_WORD_COUNT).fill(''));

  useFocusEffect(
    useCallback(() => {
      const scannedWords = consumeScannedImportWords();
      if (!scannedWords) {
        return;
      }

      setSecretWords(scannedWords);
      toast.success('12 words loaded from QR code');
      logImportStep('seed loaded from QR scan');
    }, [])
  );

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
          `Invalid Phrase! Found only ${words.length} words in clipboard. Please ensure you have exactly ${TWELVE_WORD_COUNT} words.`
        );
        return;
      }

      const newWords = [...secretWords];
      words.forEach((word, index) => {
        if (index < TWELVE_WORD_COUNT) {
          newWords[index] = word.toLowerCase().trim();
        }
      });
      setSecretWords(newWords);

      toast.success('12 words have been pasted from clipboard');
    } catch (error) {
      console.error('Paste error:', error);
      toast.error('Could not paste from clipboard');
    }
  };

  const handleScanText = () => {
    router.push({
      pathname: '/scan-qr',
      params: {
        returnRoute: '/wallet-setup/import-wallet',
        scanMode: 'mnemonic',
      },
    });
  };

  const isFormValid = () => {
    return secretWords.every(word => word.trim().length > 0);
  };

  const validateSeedPhrase = (phrase: string): boolean => {
    const words = phrase
      .trim()
      .split(' ')
      .filter(word => word.length > 0);

    // Check if we have exactly 12 words
    if (words.length !== TWELVE_WORD_COUNT) {
      return false;
    }

    // Basic word validation - each word should be at least 3 characters
    const validWords = words.every(
      word => word.length >= 3 && /^[a-z]+$/.test(word) // only lowercase letters
    );

    return validWords;
  };

  const handleImportWallet = () => {
    if (!isFormValid()) {
      Alert.alert('Incomplete', 'Please fill in all 12 words of your secret phrase', [
        { text: 'OK' },
      ]);
      return;
    }

    // Join the words into a seed phrase
    const seedPhrase = secretWords.join(' ');

    // Validate the seed phrase
    if (!validateSeedPhrase(seedPhrase)) {
      Alert.alert(
        'Invalid Seed Phrase',
        'Please check your seed phrase. Make sure all words are spelled correctly and contain only lowercase letters.',
        [{ text: 'OK' }]
      );
      return;
    }

    // Validate BIP39 checksum (basic format check alone is not enough)
    if (!bip39.validateMnemonic(seedPhrase)) {
      Alert.alert(
        'Invalid Seed Phrase',
        'This does not look like a valid recovery phrase. Check spelling, word order, and word count (12 words).',
        [{ text: 'OK' }]
      );
      return;
    }

    logImportStep('seed validated, navigating to name screen', { wordCount: secretWords.length });

    setPendingImportMnemonic(seedPhrase);
    router.push({ pathname: './import-name-wallet' });
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.primary} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={styles.content}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text style={styles.title}>Import via Secret Phrase</Text>

          <SeedPhrase words={secretWords} editable={true} onWordChange={handleWordChange} />

          <View style={styles.actionButtons}>
            <TouchableOpacity style={styles.actionButton} onPress={handlePaste}>
              <FileText size={20} color={colors.primary} />
              <Text style={styles.actionButtonText}>Paste</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionButton} onPress={handleScanText}>
              <ScanText size={20} color={colors.primary} />
              <Text style={styles.actionButtonText}>Scan Text</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 20 }]}>
        <TouchableOpacity
          style={[styles.importButton, !isFormValid() && styles.importButtonDisabled]}
          onPress={handleImportWallet}
        >
          <Download size={20} color={isFormValid() ? colors.black : colors.textTertiary} />
          <Text
            style={[styles.importButtonText, !isFormValid() && styles.importButtonTextDisabled]}
          >
            Import Wallet
          </Text>
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
    paddingHorizontal: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: colors.text,
    marginBottom: 32,
  },
  actionButtons: {
    flexDirection: 'row',
    marginHorizontal: -8,
    marginBottom: 24,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.tintedBackground,
    borderRadius: 12,
    paddingVertical: 14,
    marginHorizontal: 8,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  actionButtonText: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: '500',
    marginLeft: 8,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  importButton: {
    backgroundColor: colors.primary,
    height: 56,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  importButtonDisabled: {
    backgroundColor: colors.card,
  },
  importButtonText: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.black,
  },
  importButtonTextDisabled: {
    color: colors.textTertiary,
  },
});
