import SendSpaceRecipientModal from '@/components/send-space-recipient-modal';
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';
import { isValidSpaceAddress } from '@/utils/taproot-address-to-spk';
import { Text, TouchableOpacity } from 'react-native';

type SendSpaceModalContextValue = {
  openSendSpaceModal: () => void;
  closeSendSpaceModal: () => void;
};

const SendSpaceModalContext = createContext<SendSpaceModalContextValue | null>(null);

export function useSendSpaceModal(): SendSpaceModalContextValue {
  const ctx = useContext(SendSpaceModalContext);
  if (!ctx) {
    throw new Error('useSendSpaceModal must be used within SendSpaceModalProvider');
  }
  return ctx;
}

type SendSpaceOpenButtonProps = {
  visible: boolean;
  style: object;
  textStyle: object;
};

/** Opens the recipient modal without re-rendering the parent screen (modal state lives in the provider). */
export function SendSpaceOpenButton({ visible, style, textStyle }: SendSpaceOpenButtonProps) {
  const { openSendSpaceModal } = useSendSpaceModal();
  if (!visible) {
    return null;
  }
  return (
    <TouchableOpacity
      style={style}
      onPress={openSendSpaceModal}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="Send space to another space address"
    >
      <Text style={textStyle}>Send Space</Text>
    </TouchableOpacity>
  );
}

type SendSpaceModalProviderProps = {
  children: ReactNode;
  onScan: () => void;
  onRecipient: (spaceAddress: string) => void;
  scannedSpaceAddress?: string | string[];
  onScannedSpaceAddressConsumed?: () => void;
};

export function SendSpaceModalProvider({
  children,
  onScan,
  onRecipient,
  scannedSpaceAddress,
  onScannedSpaceAddressConsumed,
}: SendSpaceModalProviderProps) {
  const [visible, setVisible] = React.useState(false);
  const consumedScannedRef = useRef<string | null>(null);

  const openSendSpaceModal = useCallback(() => {
    console.log('[Subspace] Send Space — opening recipient dialog');
    setVisible(true);
  }, []);

  const closeSendSpaceModal = useCallback(() => {
    setVisible(false);
  }, []);

  const contextValue = useMemo(
    () => ({ openSendSpaceModal, closeSendSpaceModal }),
    [openSendSpaceModal, closeSendSpaceModal]
  );

  const handleRecipient = useCallback(
    (addr: string) => {
      closeSendSpaceModal();
      onRecipient(addr);
    },
    [closeSendSpaceModal, onRecipient]
  );

  const handleScan = useCallback(() => {
    closeSendSpaceModal();
    onScan();
  }, [closeSendSpaceModal, onScan]);

  useEffect(() => {
    const raw =
      typeof scannedSpaceAddress === 'string'
        ? scannedSpaceAddress
        : Array.isArray(scannedSpaceAddress)
          ? scannedSpaceAddress[0]
          : undefined;
    const trimmed = raw?.trim() ?? '';
    if (!trimmed || !isValidSpaceAddress(trimmed)) {
      return;
    }
    if (consumedScannedRef.current === trimmed) {
      return;
    }
    consumedScannedRef.current = trimmed;
    closeSendSpaceModal();
    onRecipient(trimmed);
    onScannedSpaceAddressConsumed?.();
  }, [
    scannedSpaceAddress,
    closeSendSpaceModal,
    onRecipient,
    onScannedSpaceAddressConsumed,
  ]);

  return (
    <SendSpaceModalContext.Provider value={contextValue}>
      {children}
      <SendSpaceRecipientModal
        visible={visible}
        onRequestClose={closeSendSpaceModal}
        onScan={handleScan}
        onRecipient={handleRecipient}
      />
    </SendSpaceModalContext.Provider>
  );
}
