# Release Hardening (npm Mode)

This runbook validates production readiness when internal packages are consumed from npm (no `file:` dependencies).

## 0) Preconditions

- Node versions:
  - `wdk-starter-react-native-spaces-wallet`: `22.21.1`
  - `wdk-react-native-provider`: `v24.11.0`
- Clean git state or intentional local changes tracked.
- All package versions to be released are already published (or will be published in this sequence):
  1. `@spacesops/pear-wrk-wdk`
  2. `@spacesops/wdk-react-native-provider`
  3. `@tetherto/wdk-starter-react-native` app dependencies updated to those versions

## 1) Package Tarball Gates (producer repos)

Run in `wdk-react-native-provider`:

```bash
npm pack --dry-run --json
```

Pass criteria:
- Tarball includes:
  - `scripts/fix-pear-wrk-wdk.js`
  - `scripts/fix-pack-imports.js`
  - `lib/module/services/wdk-service/wdk-worklet.mobile.bundle.js`
  - `lib/module/services/wdk-service/wdk-secret-manager-worklet.bundle.js`
  - `pack.imports.json`

Run in `pear-wrk-wdk`:

```bash
npm pack --dry-run --json
```

Pass criteria:
- Tarball includes:
  - `scripts/create-ws-stubs.js`
  - `pack.imports.json`
  - `bundle/wdk-worklet.mobile.bundle.js` (or CI explicitly regenerates postinstall)

## 2) Starter npm-mode Install Gate

Run in `wdk-starter-react-native-spaces-wallet`:

```bash
rm -rf node_modules package-lock.json
npm install
```

Pass criteria:
- No `MODULE_NOT_FOUND` from provider postinstall scripts.
- No `ENOENT` for `@tetherto/pear-wrk-wdk/package.json`.

## 3) Bundle & Import-Map Consistency Gate

Run in starter:

```bash
npm run rebuild-wdk-bundle
```

Pass criteria:
- `node_modules/@tetherto/pear-wrk-wdk/pack.imports.json` contains:
  - `"bare-crypto": "bare-crypto"`
  - `"bare-tcp": "bare-tcp"`
  - `"bare-performance": "bare-performance"`
- Provider bundle exists:
  - `node_modules/@tetherto/wdk-react-native-provider/lib/module/services/wdk-service/wdk-worklet.mobile.bundle.js`

## 4) Native Rebuild Gate (required after dependency/link changes)

Android:

```bash
npm run android:prod
```

iOS:

```bash
npm run ios:prod
```

Pass criteria:
- Fresh native binaries built and installed.
- No runtime `ADDON_NOT_FOUND` for `bare-performance`, `bare-crypto`, or related bare addons.

## 5) Runtime Smoke Tests (device)

Minimum checks:
- App launch and wallet unlock.
- Wallet address resolution for BTC and EVM chains.
- Quote/send flow opens without worklet crash.
- Secret manager operations succeed.

Fail indicators:
- `ADDON_NOT_FOUND`
- `Cannot find module .../scripts/fix-pear-wrk-wdk.js`
- `TypeError: bu.unmask is not a function` (empty `bufferutil` stub next to `@react-native/dev-middleware` `ws` — run `npm install` so starter `postinstall` removes pear stubs, or upgrade `@spacesops/pear-wrk-wdk` once stub logic is fixed)
- address resolution returning null with worklet load errors

## 6) CI Recommendations (enforce before tag)

- Producer repos:
  - `npm ci`
  - `npm run prepare` (provider) / bundle generation (pear)
  - `npm pack --dry-run --json` and assert required paths exist
- Starter repo:
  - `npm ci`
  - `npm run rebuild-wdk-bundle`
  - release build job (Android and iOS)
- Block release on any missing tarball artifact or native addon load failure.
