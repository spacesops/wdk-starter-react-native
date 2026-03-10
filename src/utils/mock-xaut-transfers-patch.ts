/**
 * Temporary patch: when EXPO_PUBLIC_MOCK_XAUT_TRANSFERS is true, merge mock XAUT
 * transfers from mock_xaut_tx.json into the token-transfers response so the app
 * shows XAU₮ transactions until batch/token-transfers is fixed.
 */

import { WDKService } from '@tetherto/wdk-react-native-provider';

const MOCK_ENABLED = process.env.EXPO_PUBLIC_MOCK_XAUT_TRANSFERS === 'true';

if (MOCK_ENABLED) {
  const mockData = require('../../mock_xaut_tx.json') as { transfers?: unknown[] };
  const rawTransfers = mockData?.transfers ?? [];
  const mockTransfers = rawTransfers.map((t: Record<string, unknown>) => {
    const { label: _label, ...tx } = t;
    return tx;
  });

  const original = WDKService.resolveWalletTransactions.bind(WDKService);
  (WDKService as { resolveWalletTransactions: typeof original }).resolveWalletTransactions =
    async function resolveWalletTransactionsWithMock(
      enabledAssets: Parameters<typeof original>[0],
      networkAddresses: Parameters<typeof original>[1]
    ) {
      const map = await original(enabledAssets, networkAddresses);
      const key = 'ethereum_xaut';
      const existing = (map as Record<string, unknown[]>)[key] ?? [];
      (map as Record<string, unknown[]>)[key] = [...existing, ...mockTransfers];
      return map;
    };
}
