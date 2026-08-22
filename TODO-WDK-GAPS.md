# WDK core / pear gaps (Spaces Wallet)

Track follow-ups after migrating to `@spacesops/wdk-react-native-core` (currently `1.0.0-beta.65` → pear `1.1.1-beta.51`).

Status key: `open` · `blocked` · `optional` · `done`

---

## Pear / wallet-btc

### [done] TON / Tron / Solana wallet managers (USDT networks)

- **Shipped via pear repack** (`1.1.1-beta.51`): `schema.json` `walletModules` for `@tetherto/wdk-wallet-ton`, `-tron`, `-solana` + `gen:mobile-bundle` — not app postinstall patches.
- **App:** `get-chains-config.ts`, `get-token-configs.ts`, `assets.ts` USDT networks, gas-fee calculator, Settings address preload.
- **Follow-up:** Publish pear → core `beta.65` → remove `file:`/`overrides` when on npm pins. **Native rebuild** required after bundle/addon change.

### [blocked] Path-based on-chain update (`priorAcct` over HRPC)

- **App impact:** Subspace “Update on-chain” (`WDKSpaces.quoteUpdateTransactionWithHexTX` / `updateTransactionWithHex`) throws stubs.
- **Why:** `WalletAccountBtc` methods take a live `priorAcct` object; that cannot cross HRPC as JSON.
- **Fix options:**
  1. Pear worklet helper that resolves `priorAccountRelativePath` via `getAccountByPath` and calls the account methods inside the worklet, or
  2. wallet-btc variants that accept a path string instead of `priorAcct`.
- **Refs:** `UPDATE_TX_HEX.md`, `src/utils/wdk-spaces.ts`, `src/app/subspace.tsx`

### [optional] Batch `deriveTaprootAddressesFromPaths` HRPC

- **App impact:** None blocking — app polyfills via `AccountService.callAccountMethodByPath` (`getAddress` → `getScriptPubKeyHex` → optional `getTaprootKeyMaterialHex`).
- **Why optional:** Fewer round-trips / one atomic RPC for Find Spaces and path reservation.
- **Note:** Postinstall still logs that `deriveTaprootAddressesFromPaths` is absent from the worklet; that is expected until this lands.

### [optional] Confirm memo coinselect fix upstream

- **App impact:** Memo send/quote methods exist in the worklet; Spaces purchase/send-with-memo paths call them.
- **Why:** `scripts/patch-wdk-wallet-btc-memo-coinselect.js` skips on current `@spacesops/wdk-wallet-btc` source (“Unexpected file contents”).
- **Follow-up:** Verify the old coinselect bug is fixed in the published wallet-btc; delete or retarget the patch if obsolete.

---

## Core (`@spacesops/wdk-react-native-core`)

### [done] Transaction history API

- **Shipped in core:** `TransactionService` + `useWalletTransactions` call WDK Indexer `token-transfers` when `indexerConfig` is passed to `WdkAppProvider`.
- **App:** `get-indexer-config.ts` wires `EXPO_PUBLIC_WDK_INDEXER_*`; wallet Activity + `HistoricalPriceSync` consume the hook.

### [optional] Export shared enums

- **App impact:** Low — app keeps local `NetworkType` / `AssetTicker` in `src/config/wdk-enums.ts`.
- **Risk:** Drift across consuming apps if core later exports different names/values.

### [done] `callAccountMethodByPath`

- Landed in core `1.0.0-beta.64` + pear `callMethodByPath` (`1.1.1-beta.50`).
- Powers Spaces Find Spaces / path reservation / taproot key material lookup.

---

## App facade (not pear/core holes)

### [done] Runtime / Metro Node polyfills after core swap

- Restored former provider polyfills in-app (`src/polyfills/index.ts` + `metro.config.js`): Buffer, process, crypto, stream, url, zlib, etc.
- Symptom fixed: `bip39.generateMnemonic()` → `Property 'Buffer' doesn't exist`.

### [done] Do not auto-switch to invented `"default"` wallet id

- Screens used `activeWalletId || wallets[0] || 'default'`, which called `useWallet({ walletId: 'default' })` before any wallet existed → `WalletSwitchingService` error.
- Fixed via `resolveCurrentWalletId` (returns `undefined` when none).

### [open] Pass `confirmationTarget` through `WDKService`

- wallet-btc already accepts `confirmationTarget` on send/quote/memo methods.
- Spaces fee-duration UI does not yet pass it into `WDKService` (see TODO in `src/app/spaces.tsx`).
- **Fix:** Extend `WDKService` quote/send helpers to accept and forward `confirmationTarget`.

### [open] Device smoke after core swap

- Unlock → BTC address resolve → send → Find Spaces → path reservation.
- On-chain update remains expected-fail until path-based update lands.

### [done] `bare-performance` Android prebuilds empty → ADDON_NOT_FOUND

- Symptom: `initializeWDK` / create wallet → `ADDON_NOT_FOUND` for `linked:libbare-performance.2.1.1.so`.
- Cause: `node_modules/bare-performance/prebuilds/` sometimes installs empty; bare-kit link then omits the `.so`. `verify-addons` treated it as “no Android prebuild” and still passed.
- Fix: `scripts/ensure-bare-performance-prebuilds.js` on postinstall + relink; rebuild native app so APK includes the `.so`.

---

## Out of scope (tracked elsewhere)

- Expo SDK 57 upgrade
- App Store readiness checklist (`CLAUDE.md`)
