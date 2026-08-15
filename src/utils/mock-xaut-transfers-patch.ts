/**
 * Temporary patch: when EXPO_PUBLIC_MOCK_XAUT_TRANSFERS is true, merge mock XAUT
 * transfers from mock_xaut_tx.json into the token-transfers response so the app
 * shows XAU₮ transactions until batch/token-transfers is fixed.
 *
 * Note: @spacesops/wdk-react-native-core no longer exposes resolveWalletTransactions
 * on WDKService. This patch is a no-op until transaction fetching is reintroduced.
 */

const MOCK_ENABLED = process.env.EXPO_PUBLIC_MOCK_XAUT_TRANSFERS === 'true';

if (MOCK_ENABLED) {
  console.warn(
    '[mock-xaut-transfers-patch] EXPO_PUBLIC_MOCK_XAUT_TRANSFERS is set, but resolveWalletTransactions is not available on the new WDK core. Mock XAUT transfers are disabled.'
  );
}
