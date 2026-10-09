import { useWallet, useWdkApp, useWalletManager } from '@spacesops/wdk-react-native-core';

/**
 * useWallet wrapper for this app. Avoids WalletSwitchingService before the Bare
 * worklet has started (autoStartWorklet is false in core) and skips redundant
 * switches when activeWalletId already matches.
 */
export function useAppWallet(resolvedWalletId?: string) {
  const { activeWalletId } = useWalletManager();
  const { workletState } = useWdkApp();

  const shouldSwitch =
    Boolean(resolvedWalletId) &&
    workletState.isReady &&
    resolvedWalletId !== activeWalletId;

  return useWallet(shouldSwitch ? { walletId: resolvedWalletId } : undefined);
}
