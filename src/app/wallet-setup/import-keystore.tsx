import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import { isSpacesKeystoreBackup, type SpacesKeystoreBackup } from '@/services/keystore-backup';
import { openKeystoreJson } from '@/services/keystore-file';
import { setPendingKeystoreBackup } from '@/utils/keystore-backup-session';
import { colors } from '@/constants/colors';
import { ChevronLeft, FileJson } from 'lucide-react-native';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

export default function ImportKeystoreScreen() {
  const router = useDebouncedNavigation();
  const insets = useSafeAreaInsets();
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [backup, setBackup] = useState<SpacesKeystoreBackup | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isPicking, setIsPicking] = useState(false);

  const handleSelectFile = async () => {
    setValidationError(null);
    setBackup(null);
    setSelectedFileName(null);
    setIsPicking(true);

    try {
      const { data, filename } = await openKeystoreJson();
      if (!isSpacesKeystoreBackup(data)) {
        setValidationError('Invalid Spaces keystore format in file');
        return;
      }
      setBackup(data);
      setSelectedFileName(filename);
    } catch (error) {
      if (error instanceof Error && error.name === 'UserCancel') {
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Failed to read keystore file';
      setValidationError(message);
    } finally {
      setIsPicking(false);
    }
  };

  const handleContinue = () => {
    if (!backup) {
      toast.error('Select a keystore file first');
      return;
    }
    setPendingKeystoreBackup(backup);
    router.push('/wallet-setup/import-keystore-confirm');
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Restore Keystore</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.content}>
        <Text style={styles.title}>Import keystore backup</Text>
        <Text style={styles.subtitle}>
          Choose a Spaces keystore JSON file. The file is unencrypted and includes your recovery
          phrase — only use a backup you created yourself.
        </Text>

        <TouchableOpacity
          style={styles.selectButton}
          onPress={handleSelectFile}
          disabled={isPicking}
          activeOpacity={0.7}
        >
          {isPicking ? (
            <ActivityIndicator size="small" color={colors.black} />
          ) : (
            <FileJson size={20} color={colors.black} />
          )}
          <Text style={styles.selectButtonText}>
            {isPicking ? 'Opening…' : 'Select JSON file'}
          </Text>
        </TouchableOpacity>

        {selectedFileName ? (
          <View style={styles.fileInfo}>
            <Text style={styles.fileInfoLabel}>Selected file</Text>
            <Text style={styles.fileName}>{selectedFileName}</Text>
            {backup ? (
              <>
                <Text style={styles.fileMeta}>Wallet: {backup.walletName || 'My Wallet'}</Text>
                <Text style={styles.fileMeta}>
                  Created: {new Date(backup.createdAt).toLocaleString()}
                </Text>
              </>
            ) : null}
          </View>
        ) : null}

        {validationError ? <Text style={styles.errorText}>{validationError}</Text> : null}

        <TouchableOpacity
          style={[styles.continueButton, !backup && styles.continueButtonDisabled]}
          onPress={handleContinue}
          disabled={!backup}
          activeOpacity={0.7}
        >
          <Text style={styles.continueButtonText}>Continue</Text>
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
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 16,
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
    marginBottom: 28,
  },
  selectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    gap: 8,
  },
  selectButtonText: {
    color: colors.black,
    fontSize: 16,
    fontWeight: '600',
  },
  fileInfo: {
    marginTop: 20,
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
  },
  fileInfoLabel: {
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: 6,
  },
  fileName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 8,
  },
  fileMeta: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  errorText: {
    marginTop: 16,
    fontSize: 14,
    color: colors.danger,
  },
  continueButton: {
    marginTop: 'auto',
    marginBottom: 32,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.primary,
    paddingVertical: 16,
    alignItems: 'center',
  },
  continueButtonDisabled: {
    opacity: 0.4,
  },
  continueButtonText: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: '600',
  },
});
