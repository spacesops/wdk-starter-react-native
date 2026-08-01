# App Store Review Response — Submission 727f37df-3db4-47e1-8c6b-974ebfe96eba

Rejection received July 30, 2026 for version 1.0.1 (11), reviewed on iPhone 17 Pro Max.
Three items were raised: 5.1.1(iv), 5.1.1(ii), and 2.1(a). All three are addressed in
build **1.0.1 (13)**.

---

## Reply to paste into App Store Connect → Resolution Center

Hello, and thank you for the detailed review notes. We have addressed all three items in build 1.0.1 (13).

**Guideline 5.1.1(iv) — Camera permission request**

We have removed the custom screen that appeared before the system camera permission dialog. The iOS permission request is now presented directly when the user opens the QR scanner, with no intermediary screen and no "Enable Camera" button influencing the user's decision.

If the user declines, we do not ask again. We show a neutral message explaining that QR scanning requires the camera, together with a link to the Settings app so the user can change their mind at their own initiative.

Camera access is entirely optional in SpacesWallet. Every screen that offers QR scanning also allows the recipient address to be pasted or typed manually, and the recovery phrase to be typed word by word, so declining the camera permission does not block any feature of the app.

**Guideline 5.1.1(ii) — Camera purpose string**

The camera purpose string has been rewritten to describe the specific use of the camera and to give concrete examples. It now reads:

"SpacesWallet uses the camera only to scan QR codes. For example, scan a recipient's Bitcoin or USD₮ address QR code to fill in the send form automatically, or scan a QR code of your 12-word recovery phrase to restore an existing wallet. No photos or video are ever recorded, stored, or shared."

We have also removed the microphone usage description and the Android RECORD_AUDIO permission. Both were added automatically by our camera library and the app does not record audio.

**Guideline 2.1(a) — Demo QR codes**

We have attached two demo QR codes and added the same details to the App Review Information notes. Both can be displayed on a second screen or printed.

1. **`demo-address-qr.png` — recipient address.** Encodes the Bitcoin address `bc1qug6gv7w0q9fhffutnj7c8kdx8pl83s87t0hrlz`.
   To test: open the app, tap the scan icon on the main wallet screen (or go to Send → choose a token → choose a network → tap the QR icon beside the address field), then point the camera at this code. The address is filled into the recipient field automatically. No funds are needed to verify that scanning works.

2. **`demo-recovery-phrase-qr.png` — 12-word recovery phrase.** Encodes the phrase `shrug define animal basic idle harvest carbon rival wasp share profit soon`, which belongs to a newly generated, empty wallet created solely for this review. It holds no funds and is not used for anything else.
   To test: on the welcome screen choose "I already have a wallet", tap the QR icon on the import screen, then point the camera at this code. The 12 words are filled in and the wallet can be restored.

Please let us know if you would like any additional demo material or a video walkthrough of either flow.

Thank you again for your time.

---

## App Review Information → Notes (App Store Connect field)

> SpacesWallet is a non-custodial crypto wallet. Two demo QR codes are attached for
> guideline 2.1(a).
>
> 1. demo-address-qr.png — Bitcoin address bc1qug6gv7w0q9fhffutnj7c8kdx8pl83s87t0hrlz.
>    Tap the scan icon on the wallet screen, or Send → token → network → QR icon beside
>    the address field, and scan this code. The address fills the recipient field. No
>    funds are required.
>
> 2. demo-recovery-phrase-qr.png — 12-word recovery phrase:
>    shrug define animal basic idle harvest carbon rival wasp share profit soon
>    On the welcome screen choose "I already have a wallet", tap the QR icon, and scan
>    this code to restore the wallet. This is an empty wallet generated for review only.
>
> Camera access is optional: addresses can be pasted or typed and the recovery phrase can
> be entered by hand, so no feature is blocked if the camera permission is declined.

---

## Attachments

Both files live in `docs/app-review-assets/` and are 800×800 PNGs, verified to decode to
the exact strings above:

- `docs/app-review-assets/demo-address-qr.png`
- `docs/app-review-assets/demo-recovery-phrase-qr.png`

---

## Changes made in the codebase

**`app.json`**

- `expo-camera` plugin: replaced the default `cameraPermission` string with the specific
  purpose string quoted above.
- `expo-camera` plugin: added `"microphonePermission": false` so the config plugin deletes
  `NSMicrophoneUsageDescription` from `Info.plist` instead of falling back to its generic
  default, and `"recordAudioAndroid": false` so the plugin no longer adds
  `android.permission.RECORD_AUDIO`.
- `android.permissions`: removed the explicit `android.permission.RECORD_AUDIO` entry,
  which would otherwise be merged back in.
- Bumped `ios.buildNumber` to `13` and `android.versionCode` to `13`.

**`src/app/scan-qr.tsx`**

- The pre-permission screen is gone. A `useEffect` calls `requestPermission()` once as
  soon as the scanner mounts, while `permission.canAskAgain` is true, so the system dialog
  is the first thing the user sees.
- The post-denial state no longer re-asks. It shows "Camera is off", an explanation that
  names the manual alternative (paste the address / type the 12 words), and an
  **Open Settings** button backed by `Linking.openSettings()`.
- Removed the "Please allow camera access…" alert that previously fired after a denial.

## Before resubmitting

- [ ] `npm run prebuild:clean`
- [ ] Confirm `ios/SpacesWallet/Info.plist` contains the new `NSCameraUsageDescription`
      and **no** `NSMicrophoneUsageDescription`
      (`rg -n "UsageDescription" -A1 ios/SpacesWallet/Info.plist`)
- [ ] Confirm `android/app/src/main/AndroidManifest.xml` has no `RECORD_AUDIO` entry
- [ ] On a device with the app freshly installed, open the scanner and verify the system
      dialog appears immediately with the new wording
- [ ] Decline the permission and verify the "Camera is off" screen with Open Settings, and
      that reopening the scanner does not re-prompt
- [ ] Scan both demo QR codes end to end
- [ ] Upload build 1.0.1 (13), attach both PNGs and the notes above, then reply in
      Resolution Center
