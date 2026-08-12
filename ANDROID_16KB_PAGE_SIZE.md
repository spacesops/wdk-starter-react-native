# Android 16 KB Page Size — Play Store Compliance

Reference for resolving Google Play’s **“Your app does not support 16 KB memory page sizes”** error when submitting Spaces Wallet.

**Official docs:**

- [Android page sizes guide](https://developer.android.com/guide/practices/page-sizes)
- [Expo FYI: 16 KB page sizes](https://github.com/expo/fyi/blob/main/android-16kb-page-sizes.md)
- [Google Play target API policy](https://support.google.com/googleplay/android-developer/answer/11926878)

---

## What Google is checking

Google Play scans your **AAB** and requires all **64-bit** native libraries (`arm64-v8a`, `x86_64`) to be **16 KB ELF-aligned**. This applies to apps targeting **Android 15+ (API level 35+)**.

This is **not** a runtime failure on a specific phone model. It is a **binary compatibility** check on the uploaded bundle.

**Key deadlines (Google Play):**

| Date | Requirement |
|------|-------------|
| Aug 31, 2025 | New apps/updates must target API 35+ |
| Nov 1, 2025 | Must support 16 KB page sizes |
| May 31, 2026 | Extended deadline (if requested in Play Console) |

---

## Pixel 3 + Android 14 (test device context)

| Topic | Reality |
|--------|---------|
| Pixel 3 official OS | Android 12 max (no official Android 14 from Google) |
| Page size on Pixel 3 | **4 KB** (classic) |
| Play 16 KB error | Static AAB check — applies regardless of tester device |
| Devices that need 16 KB at runtime | **Android 15+** with 16 KB kernel page size |

**Implications:**

- Fixing 16 KB alignment is required for **Play submission**.
- Pixel 3 (or Android 14 on older hardware) is useful for **functional QA** but does **not** validate 16 KB compliance.
- To test **16 KB runtime**, use an **Android 15+ emulator** with a **16 KB page size** system image in Android Studio.

---

## This project’s baseline

Spaces Wallet is on a stack that should cover **Expo/React Native core**:

| Component | Version |
|-----------|---------|
| Expo SDK | ~54.0.8 |
| React Native | 0.81.4 (16 KB support since 0.77) |
| compileSdk | 36 (`app.json` → `expo-build-properties`) |
| EAS beta profile | `app-bundle` AAB, `autoIncrement` versionCode |

Expo/RN/Hermes are typically fine on SDK 54. The likely failure source is **third-party prebuilt `.so` files**, especially:

- `react-native-bare-kit` + **pear-wrk / WDK** worklet bundle (`libbare-*.so`, etc.)
- `@spacesprotocol/react-native-libveritas` (Rust / uniffi native)
- Other crypto natives (`react-native-fast-pbkdf2`, `react-native-randombytes`, sodium-related)

`app.json` does not currently set explicit NDK/AGP versions for 16 KB. That helps **source-built** natives during EAS builds but does **not** fix **prebuilt** libs shipped inside npm packages with 4 KB alignment.

---

## Next steps (in order)

### 1. Identify offending libraries (do this first)

**Play Console (recommended):**

1. Play Console → app → **App bundle explorer**
2. Select the latest AAB
3. Open **Memory page size** (or equivalent)
4. Note each **unaligned** `.so` file

**Locally (APK/AAB):**

Use Google’s [`check_elf_alignment.sh`](https://cs.android.com/android/platform/superproject/main/+/main:system/extras/tools/check_elf_alignment.sh) from the Android page sizes doc:

```bash
bash check_elf_alignment.sh /path/to/your-app.apk
```

List only unsupported 64-bit libs:

```bash
bash check_elf_alignment.sh /path/to/your-app.apk | grep -E '(arm64-v8a|x86_64).*UNALIGNED'
```

Map each failing lib to its npm package (bare-kit, libveritas, etc.).

### 2. Confirm Expo patch level

```bash
nvm use v22.21.1
npx expo install --fix
```

Ensures Expo-owned native modules are on current SDK 54 patches. This does not fix Bare/WDK prebuilts.

### 3. Rebuild with modern NDK on EAS (source-built natives only)

Consider adding to `expo-build-properties` in `app.json`:

```json
{
  "android": {
    "ndkVersion": "28.0.13004108",
    "androidGradlePluginVersion": "8.6.0"
  }
}
```

Use versions compatible with your Expo SDK 54 release. After changes:

```bash
npx expo prebuild --clean
npm run android:beta:build
```

This only helps libraries **compiled during the EAS build**, not prebuilt `.so` inside dependencies.

### 4. Fix third-party prebuilts (likely the real work)

For each **UNALIGNED** library:

| Source | Action |
|--------|--------|
| `@spacesprotocol/react-native-libveritas` | Request 16 KB–aligned build from Spaces Protocol, or rebuild with NDK r28+ and `-Wl,-z,max-page-size=16384` |
| `react-native-bare-kit` / `@tetherto/pear-wrk-wdk` | Request updated WDK/BareKit Android binaries with 16 KB alignment |
| Other RN native modules | Upgrade to latest; check CHANGELOG/issues for “16 KB” |

Prebuilt alignment **cannot** be fixed from JS or Gradle packaging alone — the `.so` must be **rebuilt** with 16 KB ELF segment alignment.

### 5. Re-submit and verify

```bash
npm run android:beta:build
# or full build + submit:
npm run android:beta
```

Then in Play Console → bundle explorer → confirm **16 KB compatible** before promoting the release.

### 6. Extension (if needed)

Google allows requesting an extension to **May 31, 2026** in Play Console. This delays the deadline; it does not remove the requirement.

---

## Testing matrix

| Goal | How |
|------|-----|
| Pass Play 16 KB gate | Bundle explorer + `check_elf_alignment.sh` on release AAB |
| Runtime on 16 KB devices | Android **15+** emulator with **16 KB page size** image |
| Pixel 3 / Android 14 QA | Closed testing install; wallet, WDK, libveritas flows — separate from this Play error |

---

## Cannot bypass via targetSdk

Lowering `targetSdkVersion` below 35 does not avoid Play policy: new submissions must target API 35+ **and** satisfy 16 KB alignment for 64-bit native code.

---

## Related project docs

- [ANDROID_BETA.md](./ANDROID_BETA.md) — closed testing build/submit workflow
- [app.json](./app.json) — `expo-build-properties`, `versionCode`, package `com.lcfx.spaceswallet`
- [eas.json](./eas.json) — `beta` profile (`app-bundle`, `autoIncrement`)

---

## Checklist

- [ ] List UNALIGNED `.so` files from Play bundle explorer or `check_elf_alignment.sh`
- [ ] Map each lib to package (bare-kit, libveritas, etc.)
- [ ] Run `npx expo install --fix`
- [ ] Update/rebuild offending native dependencies
- [ ] Fresh EAS AAB build (`npm run android:beta:build`)
- [ ] Play Console shows 16 KB compatible
- [ ] Optional: test on Android 15+ 16 KB emulator
