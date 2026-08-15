import getChainsConfig from '@/config/get-chains-config';
import { useWalletManager } from '@spacesops/wdk-react-native-core';
import { useMemo } from 'react';

/**
 * App-scoped wallet manager with chain configs attached.
 * Required for unlock/create/import before WdkAppProvider finishes starting the worklet.
 */
export function useAppWalletManager(walletId?: string) {
  const networkConfigs = useMemo(() => getChainsConfig(), []);
  return useWalletManager(walletId, networkConfigs);
}
