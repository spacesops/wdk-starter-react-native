# Android closed beta — detailed setup guide

Ship **Spaces Wallet** to 10–100+ testers via Google Play **Closed testing**. Testers install from the Play Store (no sideloading).

## Your app identifiers (must match exactly)

| Field | Value |
|-------|-------|
| Play / package name | `com.lcfx.spaceswallet` |
| App name (store) | **Spaces** |
| EAS owner / slug | `koine` / `spaces-wallet` |
| EAS project ID | `5df02f86-b279-4bbd-a63c-d5b2bd79d853` |
| Min Android version | API 29 (Android 10+) |
| Beta build profile | `beta` in `eas.json` |
| Beta EAS environment | `preview` (staging API URLs) |
| Submit track | `internal` → Play Console **Internal testing** (change to `alpha` for Closed testing) |

**Internal testing guide:** [`docs/PLAY_INTERNAL_TESTING.md`](docs/PLAY_INTERNAL_TESTING.md) · verify: `npm run android:beta:verify`

**Bookmark these:**

- [Google Play Console](https://play.google.com/console)
- [Expo project — spaces-wallet](https://expo.dev/accounts/koine/projects/spaces-wallet)
- [EAS builds](https://expo.dev/accounts/koine/projects/spaces-wallet/builds)
- [EAS environment variables](https://expo.dev/accounts/koine/projects/spaces-wallet/environment-variables)
- [Expo: Submit to Google Play](https://docs.expo.dev/submit/android/)
- [Play: Closed testing help](https://support.google.com/googleplay/android-developer/answer/9845337)
- [Play: Service account API access](https://support.google.com/googleplay/android-developer/answer/9844689)

---

## Phase 0 — Prerequisites

### Accounts & fees

| Requirement | Link / detail |
|-------------|---------------|
| Google Play developer account | [Register](https://play.google.com/console/signup) — **$25 one-time**, organization account recommended for a crypto wallet |
| Expo account in org **koine** | [expo.dev/accounts/koine](https://expo.dev/accounts/koine) — you must have permission to run EAS builds |
| EAS CLI logged in | `npx eas login` then `npx eas whoami` → shows your Expo username |

**Success:** `eas whoami` prints your user; you can open the Expo project URL above without access errors.

### Blocking item: privacy policy URL

Play **requires** a public privacy policy before any test track goes live. Source file: [`docs/privacy-policy.html`](docs/privacy-policy.html). Phase 1 export/policy declarations and Phase 2 App content answers are mapped in [`docs/play-console-declarations.md`](docs/play-console-declarations.md).

- Host a page at a stable HTTPS URL (e.g. `https://yourcompany.com/spaces-wallet/privacy`)
- You will paste this URL in **App content → Privacy policy** in Play Console
- For a non-custodial wallet, the policy should cover: keys stored on-device, biometric unlock, third-party APIs (indexer, Spaces backend, Bitfinex pricing), camera use (QR scan)

**Success:** URL loads in an incognito browser; no login required.

---

## Phase 1 — Create the app in Play Console

1. Open [Play Console](https://play.google.com/console) → **All apps** → **Create app**.
2. Fill in:
   - **App name:** `Spaces`
   - **Default language:** English (United States) — or your primary market
   - **App or game:** App
   - **Free or paid:** Free
   - Declarations: accept Play policies (including **Financial products** / crypto if prompted)
3. On the new app dashboard, note the **package name** field when prompted later — it **must** be:

   ```
   com.lcfx.spaceswallet
   ```

   This must match `app.json` → `expo.android.package`. Do **not** create the app with a different package and try to change it later.

**Success:** App appears in Play Console with package `com.lcfx.spaceswallet`. Dashboard shows a setup checklist (often ~12–15 tasks).

---

## Phase 2 — Complete Play Console setup (required before first release)

Work through the left sidebar until the dashboard checklist has no blocking errors for **Closed testing**. **Answer key:** [`docs/play-console-declarations.md`](docs/play-console-declarations.md).

Typical navigation paths:

### 2a. Store listing

**Path:** Grow → Store presence → Main store listing  
**Doc:** [Store listing requirements](https://support.google.com/googleplay/android-developer/answer/9866151)

| Asset | Requirement | Your source |
|-------|-------------|-------------|
| App name | `Spaces` | — |
| Short description | ≤ 80 characters | e.g. “Non-custodial multi-chain wallet with Bitcoin Spaces identities.” |
| Full description | ≤ 4000 characters | Features: BTC/ETH/Polygon/Arbitrum/TON, Spaces namespaces, send/receive |
| App icon | **512 × 512** PNG, 32-bit | `./assets/images/icon.png` (resize if needed) |
| Feature graphic | **1024 × 500** JPG or PNG | Create from brand assets |
| Phone screenshots | **≥ 2**, JPEG/PNG, 16:9 or 9:16 | Capture from Android emulator or device (wallet, Spaces, send flow) |
| App category | **Finance** (typical for wallets) | — |
| Contact email | Support address shown on store | Required |
| External marketing | Optional | — |

**Success:** Main store listing shows green checkmarks; no “Missing…” warnings for required fields.

### 2b. App content (policy declarations)

**Path:** Policy → App content

Complete each subsection (exact names vary slightly in Console):

| Section | What to declare | Spaces Wallet notes |
|---------|-----------------|---------------------|
| **Privacy policy** | Paste your HTTPS URL | Blocking until done |
| **Ads** | “No, my app does not contain ads” | Unless you add ads later |
| **App access** | All functionality available without special login, **or** provide test credentials | Wallet: usually “all functionality available” after user creates/imported wallet |
| **Content ratings** | Start questionnaire → [IARC](https://www.globalratings.com/) | Answer honestly; finance/crypto questions apply |
| **Target audience** | Age groups | Likely 18+ / not designed for children |
| **News app** | No | — |
| **COVID-19 apps** | No | — |
| **Data safety** | Declare collected/shared data | See **2c** below |
| **Financial features** | Declare crypto/wallet if asked | Non-custodial wallet — follow Google's [blockchain/crypto policy](https://support.google.com/googleplay/android-developer/answer/12206384) |
| **Government apps** | No | — |
| **Health** | No | — |

**Success:** Every **App content** row shows **Completed** (not “Start” or “Action required”).

### 2c. Data safety form (wallet-specific guidance)

**Path:** Policy → App content → Data safety

Typical declarations for a non-custodial wallet like Spaces (verify against your actual telemetry):

| Data type | Likely answer | Notes |
|-----------|---------------|-------|
| Location | Not collected | Unless you add it |
| Personal info (email, name) | Not collected by app | Unless you add accounts |
| Financial info | **Collected** — crypto wallet addresses, transaction history | Stored on device; synced via your backends as applicable |
| Photos/videos | Optional — **Camera** for QR | `expo-camera` — declare if images processed on device only |
| App activity | Depends on analytics | If none, say not collected |
| Device IDs | Depends | Declare if any SDK sends them |
| Encryption in transit | Yes | HTTPS to APIs |
| Users can request deletion | Depends on backend | On-device wallet delete in settings |

**Success:** Data safety form submitted; status **Completed**.

### 2d. Pricing & distribution

**Path:** Grow → Store presence → Pricing and availability (or **Monetize** section)

- **Free**
- Select **countries/regions** where testers live
- **Content guidelines / US export laws** — accept declarations

**Success:** App marked as free; at least one country selected.

---

## Phase 3 — Google Cloud service account (for `eas submit`)

EAS uploads AABs to Play using a JSON key. Follow [Expo’s guide](https://docs.expo.dev/submit/android/#creating-a-google-service-account) and Play’s [API access doc](https://support.google.com/googleplay/android-developer/answer/9844689).

### Step-by-step

1. **Enable the API**  
   [Google Cloud Console](https://console.cloud.google.com/) → pick or create a project → **APIs & Services → Library** → search **Google Play Android Developer API** → **Enable**.

2. **Create service account**  
   [IAM → Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts) → **Create service account**  
   - Name: `eas-play-submit` (example)  
   - Skip optional role grants on creation  

3. **Create JSON key**  
   Service account → **Keys** → **Add key** → **JSON** → download.  
   Save as **`google-service-account.json`** in the repo root:

   ```bash
   mv ~/Downloads/your-project-*.json ./google-service-account.json
   test -f google-service-account.json && echo "OK"
   ```

   File is gitignored — never commit it.

4. **Link Cloud project to Play Console**  
   Play Console → **Setup → API access**  
   ([direct pattern](https://play.google.com/console/developers/api-access))  
   - Link the same Google Cloud project if not already linked  
   - Under **Service accounts**, find `eas-play-submit@….iam.gserviceaccount.com`

5. **Grant Play permissions**  
   Click **Manage Play Console permissions** (or **Invite user** for service accounts)  
   - **App permissions:** select **Spaces** / `com.lcfx.spaceswallet`  
   - Enable at minimum:
     - **View app information and download bulk reports (read-only)** — often included
     - **Release apps to testing tracks** — required for closed beta
     - **Release to production, exclude devices, and use Play App Signing** — recommended; required for production later  

   Expo docs recommend **Release to production, exclude devices, and use Play App Signing** for submit to work reliably.

6. **Apply / Save** and wait **~5–30 minutes** for permissions to propagate.

**Success checklist:**

- [ ] `google-service-account.json` exists at project root  
- [ ] Play Console → API access shows the service account with **Active** access  
- [ ] Service account has app-level permission on `com.lcfx.spaceswallet`  
- [ ] Google Play Android Developer API is **Enabled** in Cloud Console  

**Verify submit config matches** `eas.json`:

```json
"serviceAccountKeyPath": "./google-service-account.json",
"track": "alpha",
"releaseStatus": "completed"
```

---

## Phase 4 — EAS signing & environment

### 4a. Android upload keystore (first store build)

```bash
nvm use v22.21.1
npx eas credentials -p android
```

- Choose profile **`beta`** when prompted  
- Let EAS **generate a new keystore** (default)  
- Opt into **Google Play App Signing** when Play asks on first upload  

**Success:** `eas credentials -p android` shows a keystore for `com.lcfx.spaceswallet`; first Play upload completes App Signing enrollment.

### 4b. Preview environment variables (staging backend)

Beta builds use EAS environment **`preview`**, not your laptop’s `.env` file.

1. Edit local `.env` with **staging** values (not production secrets, not `192.168.x.x` LAN URLs unless testers are on VPN):

   | Variable | Beta expectation |
   |----------|------------------|
   | `EXPO_PUBLIC_SPACES_API_BASE_URL` | HTTPS staging Spaces API |
   | `EXPO_PUBLIC_WDK_INDEXER_BASE_URL` | Staging or prod indexer (your choice) |
   | `EXPO_PUBLIC_WDK_INDEXER_API_KEY` | Key valid for beta builds |

2. Push to EAS:

   ```bash
   npm run env:push:eas
   ```

3. Confirm at [Environment variables → preview](https://expo.dev/accounts/koine/projects/spaces-wallet/environment-variables) — each `EXPO_PUBLIC_*` used by the app is present.

**Success:** Preview environment shows updated variables; `EXPO_PUBLIC_SPACES_API_BASE_URL` is reachable from the public internet (test with `curl` from your machine).

---

## Phase 5 — Create Closed testing track & tester list

**Path:** Play Console → **Testing → Closed testing**  
**Help:** [Closed testing overview](https://support.google.com/googleplay/android-developer/answer/9845337)

1. Click **Create track** (or use default **Closed testing - Alpha**).
2. Name it e.g. **Beta testers**.
3. Open the track → **Testers** tab:
   - **Create email list** → name e.g. `spaces-beta-v1`
   - Add Gmail addresses (Google accounts only)
   - **Save**
4. Copy the **Opt-in URL** (looks like `https://play.google.com/apps/testing/com.lcfx.spaceswallet` or similar).

**Optional — Google Group:** Create a [Google Group](https://groups.google.com/), add members, attach the group on the Testers tab instead of individual emails.

**Success:** Opt-in URL opens in browser and shows “Become a tester” (may say “app not available” until Phase 6 completes — that’s OK before first release).

---

## Phase 6 — Build and submit

From project root:

```bash
nvm use v22.21.1
npm run android:beta
```

Equivalent to:

```bash
eas build --platform android --profile beta --auto-submit
```

What happens:

1. EAS builds an **AAB** (`buildType: app-bundle`)  
2. `versionCode` auto-increments (`appVersionSource: remote`)  
3. Build uses **preview** environment variables  
4. On success, submits to Play track **`alpha`** (Closed testing) with **`completed`** status  

### Monitor progress

| Where | URL / command |
|-------|----------------|
| EAS build log | [Builds list](https://expo.dev/accounts/koine/projects/spaces-wallet/builds) |
| Submit status | `npx eas submit:list --platform android --limit 5` |
| Play release | Play Console → Testing → Closed testing → your track → **Releases** |

**Build success:** EAS dashboard shows **Finished**; artifact type **AAB**; profile **beta**.

**Submit success:** CLI prints submission ID; `eas submit:list` shows **Status: finished**; Play Console → Closed testing → new release with version code (e.g. `1`, `2`, …) and status **Available to testers** (not Draft).

**Timing:** First closed-test release often takes **15 minutes to a few hours** for Play processing. Pre-launch report may run automatically.

### If build succeeds but submit fails

Submit separately:

```bash
npm run android:beta:submit
# or
npx eas submit --platform android --profile beta --latest
```

Common fixes: service account permissions (Phase 3), app not created in Console, package name mismatch.

---

## Phase 7 — Invite testers & confirm install

### Tester instructions (send this)

1. Open the **opt-in URL** you copied in Phase 5 (while signed into the **same Google account** as on the phone).  
2. Tap **Become a tester** → **Download it on Google Play**.  
3. Install **Spaces** from Play Store. The listing may show **“Internal test”** or **“Early access”** badge.  
4. Open the app → create or import wallet → verify Spaces/staging API works.

### Success criteria (end-to-end)

| Check | Pass condition |
|-------|----------------|
| Opt-in | Tester sees “You’re a tester” |
| Play Store | **Spaces** installs without sideload / unknown sources |
| Version | Settings or About shows `1.0.0` (or current `app.json` version) |
| App runs | Biometric unlock, balances load, Spaces screen reaches staging API |
| Updates | Next `npm run android:beta` → testers get Play Store update prompt |

---

## Phase 8 — Subsequent beta releases

```bash
npm run android:beta
```

- **versionCode:** auto-incremented by EAS  
- **version name:** bump `expo.version` in `app.json` when you want a visible semver change (e.g. `1.0.0` → `1.0.1`)  

Release notes: Play Console → Closed testing release → add **Release notes** (what testers should test).

---

## Profile reference

| npm script | Command |
|------------|---------|
| `npm run android:beta` | Build + submit to closed testing |
| `npm run android:beta:build` | Build only |
| `npm run android:beta:submit` | Submit latest build |

| Profile | Distribution | Use |
|---------|--------------|-----|
| `preview` | EAS internal APK link | Quick sideload for devs |
| `beta` | Play Store closed testing | **This guide** |
| `production` | Play Store production | Public launch |

Change submit track in `eas.json` → `submit.beta.android.track`:

| Value | Play UI | Max testers |
|-------|---------|-------------|
| `internal` | Internal testing | 100 |
| `alpha` | Closed testing | Unlimited (invited) |
| `beta` | Open testing | Unlimited (link) |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| “App not found” on submit | App not created in Play Console | Phase 1; package must be `com.lcfx.spaceswallet` |
| “The caller does not have permission” | Service account | Phase 3; wait 30 min after granting access |
| “You need to upload an APK or Android App Bundle” | No successful submit yet | Re-run submit; check `eas submit:list` |
| Dashboard blocks release | Incomplete store / policy forms | Phase 2 checklist |
| Testers can’t install | Wrong Google account | Same account on opt-in and device |
| “Not compatible with your device” | `minSdkVersion` 29 | Device must be Android 10+ |
| Spaces API fails in beta | Staging URL not public | Phase 4b — no LAN IPs in preview env |
| Version code conflict | Remote version out of sync | `npx eas build:version:set -p android` |

**Useful commands:**

```bash
npx eas build:list --platform android --limit 5
npx eas submit:list --platform android --limit 5
npx eas credentials -p android
npx eas build:version:get -p android
```

---

## Quick APK (not Play Store)

For 2–3 developers before Play setup is done:

```bash
npx eas build --platform android --profile preview
```

Share the install URL from the build page (requires allowing unknown sources).
