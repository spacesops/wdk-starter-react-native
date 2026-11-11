import { colors } from '@/constants/colors';
import { isValidSpaceAddress } from '@/utils/taproot-address-to-spk';
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { toast } from 'sonner-native';

type SendSpaceRecipientModalProps = {
  visible: boolean;
  onRequestClose: () => void;
  onScan: () => void;
  onRecipient: (spaceAddress: string) => void;
};

export default function SendSpaceRecipientModal({
  visible,
  onRequestClose,
  onScan,
  onRecipient,
}: SendSpaceRecipientModalProps) {
  const [manualEntry, setManualEntry] = useState(false);
  const [manualAddress, setManualAddress] = useState('');

  useEffect(() => {
    if (!visible) {
      setManualEntry(false);
      setManualAddress('');
    }
  }, [visible]);

  const confirmRecipient = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!isValidSpaceAddress(trimmed)) {
        toast.error('Enter a valid space address (bcs1…, tbs1…, or bcrts1…)');
        return;
      }
      onRecipient(trimmed);
    },
    [onRecipient]
  );

  const handlePaste = useCallback(async () => {
    try {
      const text = (await Clipboard.getStringAsync()).trim();
      if (!text) {
        toast.error('Clipboard is empty');
        return;
      }
      confirmRecipient(text);
    } catch (e) {
      console.error('[Subspace] Send Space paste failed:', e);
      toast.error('Could not read clipboard');
    }
  }, [confirmRecipient]);

  const handleManualConfirm = useCallback(() => {
    confirmRecipient(manualAddress);
  }, [confirmRecipient, manualAddress]);

  if (!visible) {
    return null;
  }

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      onRequestClose={onRequestClose}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>Send Space</Text>
          <Text style={styles.hint}>
            Scan, paste, or type the recipient&apos;s space address (bcs1… / tbs1…).
          </Text>
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonPrimary]}
            onPress={onScan}
            activeOpacity={0.7}
            accessibilityLabel="Scan space address QR code"
          >
            <Text style={styles.actionButtonTextPrimary}>Scan QR Code</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonPrimary]}
            onPress={() => void handlePaste()}
            activeOpacity={0.7}
            accessibilityLabel="Paste space address from clipboard"
          >
            <Text style={styles.actionButtonTextPrimary}>Paste from Clipboard</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonPrimary]}
            onPress={() => setManualEntry((v) => !v)}
            activeOpacity={0.7}
            accessibilityLabel="Enter space address manually"
            accessibilityState={{ expanded: manualEntry }}
          >
            <Text style={styles.actionButtonTextPrimary}>Enter Manually</Text>
          </TouchableOpacity>
          {manualEntry ? (
            <View style={styles.manualSection}>
              <TextInput
                style={styles.manualInput}
                placeholder="bcs1…"
                placeholderTextColor={colors.textSecondary}
                value={manualAddress}
                onChangeText={setManualAddress}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                textContentType="none"
                keyboardType="default"
                returnKeyType="done"
                onSubmitEditing={handleManualConfirm}
                accessibilityLabel="Recipient space address"
              />
              <TouchableOpacity
                style={[
                  styles.useButton,
                  !manualAddress.trim() && styles.useButtonDisabled,
                ]}
                onPress={handleManualConfirm}
                activeOpacity={0.7}
                disabled={!manualAddress.trim()}
                accessibilityLabel="Use entered space address"
              >
                <Text style={styles.useButtonText}>Use address</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          <View style={styles.cancelRow}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={onRequestClose}
              activeOpacity={0.7}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 12,
    textAlign: 'center',
  },
  hint: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 20,
  },
  actionButton: {
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    marginTop: 12,
  },
  actionButtonPrimary: {
    borderWidth: 1,
    borderColor: colors.primary,
  },
  actionButtonTextPrimary: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.primary,
  },
  manualSection: {
    marginTop: 12,
    width: '100%',
    gap: 12,
  },
  manualInput: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.borderDark,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 14 : 10,
    fontSize: 14,
    color: colors.text,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  useButton: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    width: '100%',
  },
  useButtonDisabled: {
    opacity: 0.45,
  },
  useButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.black,
  },
  cancelRow: {
    flexDirection: 'row',
    marginTop: 20,
    width: '100%',
  },
  cancelButton: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.borderDark,
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textSecondary,
  },
});
