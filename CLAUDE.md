# CLAUDE.md — Spaces Wallet

## Project Overview

**Spaces Wallet** is a non-custodial multi-chain crypto wallet built with Expo/React Native and Tether's Wallet Development Kit (WDK). The `spaces-wallet` branch adds Bitcoin Spaces protocol integration for namespace/identity management.

- **Bundle ID**: `com.gammastream.spaceswallet`
- **Current version**: 1.0.0-alpha.1
- **Status**: Alpha — active development

## Tech Stack

- **Framework**: Expo SDK (React Native, new architecture enabled)
- **Routing**: Expo Router (file-based, typed routes)
- **State**: Redux Toolkit + WDK React Native Provider
- **Crypto**: BareKit worklets via `@tetherto/pear-wrk-wdk`
- **UI**: Custom components + `@tetherto/wdk-uikit-react-native`, Lucide icons, React Native Reanimated
- **Styling**: StyleSheet (dark theme, color constants in `src/constants/colors.ts`)

## Architecture

```
src/
├── app/                    # Expo Router screens (file-based routing)
│   ├── _layout.tsx         # Root layout: WDK + theme providers
│   ├── index.tsx           # Entry: routes to onboarding, auth, or wallet
│   ├── authorize.tsx       # Biometric unlock
│   ├── wallet.tsx          # Main wallet screen (balances, chart, activity)
│   ├── spaces.tsx          # Bitcoin Spaces protocol integration
│   ├── subspace.tsx        # Subspace management
│   ├── settings.tsx        # Wallet info, addresses, delete wallet
│   ├── scan-qr.tsx         # QR code scanner
│   ├── hex-tool.tsx        # Hex transaction tool
│   ├── assets.tsx          # Full asset list
│   ├── activity.tsx        # Transaction history
│   ├── token-details.tsx   # Individual token view
│   ├── onboarding/         # Welcome + wallet creation/import
│   ├── wallet-setup/       # Seed phrase, naming, security
│   ├── send/               # Send flow (select token → network → details)
│   └── receive/            # Receive flow (select token → network → details)
├── components/             # Shared UI components
├── config/                 # Chain configs, asset configs, networks
├── constants/              # Colors, theme values
├── hooks/                  # Custom hooks (keyboard, navigation, avatar)
├── services/               # Pricing, balance tracking, price history
├── utils/                  # Formatters, gas calculator, error handling
└── types/                  # TypeScript declarations
```

## Supported Chains & Tokens

**Chains**: Bitcoin (SegWit), Ethereum, Polygon, Arbitrum, TON, Tron, Solana, Lightning

**Tokens**: BTC, USD₮ (multi-chain), XAU₮, USA₮

## Key Patterns

- **WDK Provider**: Wraps entire app in `<WalletProvider>` with chain config proxy for safe defaults
- **Biometric auth**: Face ID/Touch ID for wallet unlock (iOS Keychain, Android KeyStore)
- **Seed phrases**: BIP39-compatible 12-word mnemonics, secure generation and import
- **Pricing**: Bitfinex HTTP integration via `@tetherto/wdk-pricing-bitfinex-http`
- **Navigation**: Debounced navigation hook prevents double-taps
- **Spaces API**: Connects to a Spaces protocol backend for namespace operations (configurable URL)
- **Subname purchase flow** (`src/app/spaces.tsx`): GET quote → POST purchase → compose tx → PUT confirm → reserve Taproot path (first-time) → broadcast/simulate with watch-payment + payment callback → poll unified status. See `PURCHASE.md` and `JOB_STATUS_POLLING.md`.
- **Purchase utilities**: `src/utils/resolve-next-spaces-path.ts` (next off-chain BIP-86 path), `src/utils/build-payment-watch-body.ts` (watch-payment JSON body), `src/utils/spaces-scan-paths.ts` (derivation path config)

## Environment Variables

See `.env.example`:
- `EXPO_PUBLIC_WDK_INDEXER_BASE_URL` — WDK indexer API endpoint
- `EXPO_PUBLIC_WDK_INDEXER_API_KEY` — WDK API key
- `EXPO_PUBLIC_TRON_API_KEY` / `EXPO_PUBLIC_TRON_API_SECRET` — Tron network credentials
- `EXPO_PUBLIC_SPACES_API_BASE_URL` — Spaces protocol API (defaults to local dev)
- `EXPO_PUBLIC_SPACES_ACCOUNT_NUMBER` / `EXPO_PUBLIC_SPACES_ACCOUNT_GAP` — BIP-86 Taproot receive paths scanned for Find Spaces and first-time purchase path reservation

## Build & Dev

```bash
nvm use v22.21.1
npm install --ignore-scripts
npm run postinstall
npm run gen:bundle          # Generate WDK worklet bundle
npm run prebuild:clean      # Generate native projects (iOS/Android)
npm run ios                 # Run on iOS
npm run android             # Run on Android
```

## App Store Readiness

### Required before submission:
- [ ] Privacy policy (link in app + App Store listing)
- [ ] Terms of service
- [ ] Support/contact information in-app
- [ ] Apple Developer enrolled as organization (not individual)
- [ ] App Privacy nutrition labels (data collection disclosure)
- [ ] Remove alpha warnings and placeholder content
- [ ] Production Spaces API URL (not local IP)
- [ ] Test all flows end-to-end on physical device

### Key review guidelines:
- **3.1.5(b)**: Crypto wallets must come from registered businesses
- **5.1.1**: Privacy policy required, data collection must be transparent
- **2.1**: Must not crash; all features must work as advertised
