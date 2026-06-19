# Google Play Console — declarations reference

Internal record of **Phase 1** declarations accepted when creating **Spaces** on Google Play, plus **Phase 2** answer keys for App content, Data safety, and related forms.

Use this document when completing Play Console setup for closed beta ([`ANDROID_BETA.md`](../ANDROID_BETA.md) Phase 2).

---

## App record

| Field | Value |
|-------|-------|
| Play listing name | **Spaces** |
| Package name | `com.lcfx.spaceswallet` |
| Publisher | **Lunde Cognitive Effects, Inc. (LCFX)** — Atlanta, Georgia, USA |
| App type | App · Free |
| Category (store listing) | **Finance** (recommended) |
| Privacy policy (source) | [`docs/privacy-policy.html`](./privacy-policy.html) |
| Privacy policy (Play URL) | _Host `privacy-policy.html` at a public HTTPS URL and paste here once live_ |
| Support / privacy contact | `privacy@lcfx.com` |
| Effective policy date | June 17, 2026 |
| iOS export flag (aligned) | `ITSAppUsesNonExemptEncryption: false` in `app.json` |
| Phase 1 declarations accepted | See below — recorded at app creation |

---

## Phase 1 — Create app declarations

These three checkboxes appear on **Play Console → Create app → Declarations**. They are **legal attestations** by LCFX, not technical validations by Google.

### 1. Developer Program Policies

**Console text:** “Confirm app meets the Developer Program Policies”

**What we certified:** Spaces Wallet complies with [Google Play Developer Program Policies](https://play.google.com/about/developer-content-policy/), including policies relevant to a **non-custodial cryptocurrency wallet**.

| Policy area | Spaces Wallet position | Evidence |
|-------------|------------------------|----------|
| **Financial services / crypto** | Non-custodial wallet; user controls keys; no LCFX custodial accounts | Privacy policy §§2–3; [Crypto policy](https://support.google.com/googleplay/android-developer/answer/12206384) |
| **Deceptive behavior** | No misrepresentation of custody, recovery, or guaranteed returns | Store copy must state non-custodial nature; user owns seed backup |
| **User data / privacy** | No LCFX account system; policy published | [`privacy-policy.html`](./privacy-policy.html) |
| **Permissions** | Camera for QR scan; biometrics for local unlock only | Privacy policy §7; `app.json` Android permissions |
| **Restricted content** | Not directed at children; no ads | Privacy policy §§9, 12 |
| **Malware / security** | Keys on-device; HTTPS to APIs | Privacy policy §§4, 11 |

**Phase 2 actions tied to this declaration:**

- Complete every **Policy → App content** item (privacy, ads, ratings, target audience, data safety, financial features if prompted).
- Store listing must not promise features the beta build lacks.
- Remove alpha-only warnings from user-facing copy before production; beta may note “beta” if accurate.

**Useful links:**

- [Developer Program Policies](https://play.google.com/about/developer-content-policy/)
- [Policy-compliant app descriptions](https://support.google.com/googleplay/android-developer/answer/9898844)
- [Blockchain / crypto apps on Google Play](https://support.google.com/googleplay/android-developer/answer/12206384)

---

### 2. Play App Signing

**Console text:** “Accept the Play App Signing Terms of Service”

**What we certified:** LCFX accepts [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756) so **Android App Bundles (AAB)** can be published. Google holds the **app signing key**; we upload with an **upload key** managed by EAS.

| Item | Value |
|------|-------|
| Build artifact for Play | **AAB** (`buildType: app-bundle` in `eas.json` → `beta` / `production`) |
| Upload key | Generated/managed via `eas credentials -p android` (profile `beta`) |
| First upload | Play enrolls app in App Signing on first successful AAB upload |
| EAS submit | `npm run android:beta` → `--auto-submit` to closed testing track |

**Phase 2 / release actions tied to this declaration:**

- Never distribute Play-track builds as sideloaded APKs signed with a different key expecting Play updates to apply.
- If upload key is lost, use Play Console + EAS credential recovery flows; do not create a new package name.

**Useful links:**

- [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)
- [Expo: Android credentials](https://docs.expo.dev/app-signing/app-credentials/)

---

### 3. US export laws

**Console text:** “Accept US export laws” — certify compliance with US export rules, **including encryption**, and that the app is **authorized for export** from the United States.

**What we certified:** LCFX (US company) assessed **Export Administration Regulations (EAR)** for Spaces Wallet and certifies the app uses **standard, mass-market encryption** appropriate for public app-store distribution—not custom/non-standard cryptography requiring separate authorization.

| Encryption use in app | Type | Notes |
|----------------------|------|-------|
| HTTPS / TLS | Standard | WDK Indexer, SpacesOps, Bitfinex pricing, RPC endpoints |
| On-device wallet crypto | Standard libraries | BIP39 seed, key derivation, transaction signing |
| Platform secure storage | OS-provided | Android Keystore / encrypted local storage |
| Biometric unlock | OS-provided | Local auth only; no biometric data sent to LCFX |
| Camera QR processing | On-device | No upload of images to LCFX (privacy policy §7) |

| Compliance element | Position |
|--------------------|----------|
| **Publisher jurisdiction** | US (Georgia) — EAR applies |
| **Classification (typical)** | Mass-market encryption software — **ECCN 5D992.c** (self-assessment; confirm with counsel if unsure) |
| **Non-standard / proprietary crypto** | None intended |
| **Embargoed countries** | Google blocks Play downloads; no separate LCFX distribution to sanctioned destinations |
| **iOS alignment** | `ITSAppUsesNonExemptEncryption: false` — standard/exempt encryption only |

**Internal qualification checklist (before certifying):**

- [x] Encryption inventory documented (table above)
- [x] Mass-market / standard crypto only
- [x] Privacy policy describes on-device encryption (§§4, 11)
- [ ] Optional: export counsel sign-off for formal EAR memo on file

**Phase 2 actions tied to this declaration:**

- **Data safety → Security practices → Encryption in transit:** Yes (HTTPS/TLS for off-device requests).
- Do **not** conflate this with Data safety user disclosures; export law is a separate publisher certification.

**Useful links:**

- [Play: Export compliance](https://support.google.com/googleplay/android-developer/answer/113770)
- [BIS: Encryption guidance](https://www.bis.gov/regulations/encryption-export-controls)
- [BIS policy guidance index](https://www.bis.doc.gov/index.php/policy-guidance/encryption)

---

## Phase 2 — App content answer key

Complete under **Policy → App content**. Status goal: every row **Completed**.

### Privacy policy

| Field | Answer |
|-------|--------|
| URL | Public HTTPS URL hosting [`privacy-policy.html`](./privacy-policy.html) |
| Must cover | Non-custodial wallet, on-device keys, SpacesOps/indexer transmission, camera, biometrics, children, contact |

### Ads

| Question | Answer |
|----------|--------|
| Does your app contain ads? | **No** |

Privacy policy §9: no third-party advertising based on identity.

### App access

| Question | Answer |
|----------|--------|
| Is all functionality available without special access? | **Yes** — no login account required to use the wallet after install |
| Instructions for reviewers | Optional short note: create or import a 12-word test wallet; no server-side LCFX account |

If beta requires staging API, ensure preview EAS env points to a **public** staging backend (not LAN IP).

### Content ratings (IARC)

Complete the questionnaire honestly. Recorded answers for Spaces Wallet (beta):

| IARC question | Answer | Rationale |
|---------------|--------|-----------|
| **Digital purchases** — does the app allow users to purchase digital goods? ([help](https://support.google.com/googleplay/android-developer/answer/543?hl=en)) | **Yes** | Users buy Bitcoin Spaces **subnames** and **space pointers** through in-app purchase flows (quote → pay with BTC → confirm). Paid commerce, not Play Billing. |
| **Cash rewards, gift cards, play-to-earn, convertible crypto rewards, or issuance of transferable digital assets (e.g., NFTs)** | **No** | No reward programs, gift cards, play-to-earn, referral/staking earn, or NFT minting. Spaces certificates/SPTR after purchase are **fulfillment of paid orders**, not rewards or free issuance. Standard wallet send/receive is not included. |
| **Real gambling or cash payouts** (if asked) | **No** | No gambling or prize mechanics. |
| Category | Utility / finance-related | Follow questionnaire flow |
| User-generated content | **No** / minimal | — |
| Violence, gambling, etc. | **No** | — |
| Shares location / personal info | **No** traditional PII collection by LCFX | Privacy policy §5 |

**Digital purchases vs. rewards (do not conflate):**

| Feature | Classification |
|---------|----------------|
| Buy Spaces subname / pointer (pay BTC in-app) | Digital **purchase** → **Yes** |
| Send/receive BTC, USD₮, etc. | Wallet transfer — not a digital-goods purchase question |
| Protocol certificates / SPTR after paid purchase | Order fulfillment — not rewards/NFT **issuance** → **No** on rewards question |

Save the issued rating certificate; renewal may be required after major feature changes (e.g. adding play-to-earn, NFT minting, or reward tokens).

### Target audience

| Field | Answer |
|-------|--------|
| Target age groups | **18+** or exclude children — app is not directed at children |
| Appeal to children | **No** |

Privacy policy §12: not directed to children under 13.

### Data safety

[Form help](https://support.google.com/googleplay/android-developer/answer/10787469) — declare **all** data collected or shared by the app **and embedded SDKs**, for **current and future** users on the track.

#### Summary stance

| Question | Answer |
|----------|--------|
| Does your app collect or share user data? | **Yes** (wallet/blockchain identifiers and technical data sent to connected services) |
| Is all collected data encrypted in transit? | **Yes** (HTTPS/TLS for network requests) |
| Do you provide a way to request data deletion? | **Partial** — on-device: uninstall/clear app data; server logs: per third-party policies (disclose in details) |
| Is data sold? | **No** |
| Is data used for advertising / tracking? | **No** |

#### Data types — suggested mapping

Align declarations with [`privacy-policy.html`](./privacy-policy.html). Adjust if implementation changes.

| Play data type | Collected? | Shared? | Purpose | Notes |
|----------------|------------|---------|---------|-------|
| **Financial info** (crypto wallet addresses, transaction-related metadata) | Yes | Yes | App functionality | Sent to SpacesOps, indexers, Electrs, chain RPCs per user actions — §6 |
| **App activity** (in-app actions tied to requests) | Optional | Optional | Analytics / debugging | No LCFX analytics SDK today; infrastructure logs may exist — §9 |
| **Device or other IDs** | Unlikely from LCFX directly | Unlikely | — | Declare if any SDK adds this in a future build |
| **Photos / videos** | No (not collected) | No | Camera for QR | Processed on-device only — §7 |
| **Personal info** (name, email, phone) | No | No | — | §5 |
| **Location** | No | No | — | — |

#### Third-party services to disclose (data processors / recipients)

| Service | Data involved | Privacy reference |
|---------|---------------|-------------------|
| **SpacesOps** | Addresses, script pubkeys, txids, Spaces purchase metadata | §6.1 |
| **Electrs** | Bitcoin addresses queried | §6.2 |
| **WDK Indexer** | Addresses, tx data for supported chains | §6.3 |
| **Bitfinex pricing** | Price requests (not wallet identity) | §6.3 |
| **Public blockchains / RPC** | Transaction broadcasts, chain reads | §§6.3, 8 |

#### Security practices

| Practice | Declare |
|----------|---------|
| Data encrypted in transit | **Yes** |
| Users can request deletion | Describe on-device deletion; third-party retention limits |
| Independent security review (MASA) | **No** (optional; not required for beta) |

#### Permission note for review

`app.json` declares `RECORD_AUDIO` alongside `CAMERA` (common with `expo-camera` on Android). Privacy policy documents **camera for QR only**. If the beta build does not use the microphone, consider removing unused permission in a future native config; for Data safety, do **not** claim audio collection unless the app records audio.

### Financial features

If Play prompts for **Financial products** declarations ([crypto guidance](https://support.google.com/googleplay/android-developer/answer/12206384)):

| Field | Answer |
|-------|--------|
| App function | **Non-custodial cryptocurrency wallet** |
| Custody | User holds keys; LCFX cannot recover seed |
| Supported assets | BTC, USD₮ (multi-chain), XAU₮, USA₮ — per product config |
| Spaces | Bitcoin Spaces namespace / identity features via SpacesOps |
| Licenses | Provide any required regulatory disclosures if applicable to LCFX’s jurisdiction and user markets |

Consult counsel for market-specific financial licensing copy on the store listing.

### Government apps / Health / News / COVID-19

| Section | Answer |
|---------|--------|
| Government apps | No |
| Health apps | No |
| News apps | No |
| COVID-19 contact/status | No |

---

## Phase 2 — Store listing fields

**Path:** Grow → Store presence → Main store listing

| Field | Guidance |
|-------|----------|
| App name | **Spaces** |
| Short description (≤80) | Example: _Non-custodial multi-chain wallet with Bitcoin Spaces identities._ |
| Full description | Non-custodial, user-controlled keys, supported chains, Spaces features; no guaranteed returns |
| Icon | 512×512 PNG — `./assets/images/icon.png` |
| Feature graphic | 1024×500 |
| Screenshots | ≥2 phone screenshots (wallet, Spaces, send/receive) |
| Contact email | Support address (may match `privacy@lcfx.com` or dedicated support) |
| Privacy policy URL | Same URL as App content |

---

## Cross-platform alignment

| Platform | Declaration | Spaces Wallet setting |
|----------|-------------|------------------------|
| Google Play Phase 1 | US export / encryption | Mass-market standard encryption (this doc §3) |
| Apple App Store | `ITSAppUsesNonExemptEncryption` | `false` in `app.json` |
| Both | Privacy policy | [`privacy-policy.html`](./privacy-policy.html) |
| Both | Non-custodial wallet | Consistent store copy and in-app behavior |

---

## Document maintenance

| When | Action |
|------|--------|
| New SDK with analytics/ads | Update Data safety table and Phase 1 policy review |
| New permissions | Update privacy policy + this doc + Play forms |
| New chains or custodial features | Re-review Financial features and export classification |
| Privacy policy revision | Update Play URL effective date and Data safety |
| Major encryption change | Re-review US export certification before next release |
| New reward / NFT / play-to-earn features | Re-run IARC; update Digital purchases and rewards answers |

**Disclaimer:** This is an internal compliance worksheet for Play Console setup, not legal advice. LCFX should have qualified counsel review export and financial declarations before production scale.

---

## Related docs

- [`ANDROID_BETA.md`](../ANDROID_BETA.md) — closed beta build and submit runbook
- [`privacy-policy.html`](./privacy-policy.html) — public privacy policy source
- [`../app.json`](../app.json) — package name, permissions, iOS encryption flag
- [`../eas.json`](../eas.json) — `beta` profile, AAB, Play submit track
