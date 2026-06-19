# Play Internal testing + EAS integration

Confirm and ship **Spaces** (`com.lcfx.spaceswallet`) to Google Play **Internal testing** via EAS.

## Integration map

| Layer | Setting | Value |
|-------|---------|-------|
| Play track | Internal testing | Up to 100 testers, fastest path |
| EAS build profile | `beta` | Store AAB, `preview` env, autoIncrement |
| EAS submit profile | `submit.beta` | Same name as build profile for `--auto-submit` |
| Submit track | `internal` | Maps to Play Internal testing |
| Release status | `completed` | Release live on track after upload (not draft) |
| Service account | `./google-service-account.json` | `eas-play-submit@spaceswallet.iam.gserviceaccount.com` |
| Package | `com.lcfx.spaceswallet` | Must match Play app |

**EAS track → Play Console UI**

| `eas.json` `track` | Play Console |
|--------------------|--------------|
| `internal` | **Testing → Internal testing** |
| `alpha` | Testing → Closed testing |
| `beta` | Testing → Open testing |
| `production` | Production |

To switch to Closed testing later, change `submit.beta.android.track` to `"alpha"` in `eas.json`.

**Open testing** uses a separate submit profile (`submit.open`, track `beta`) so Internal stays on `submit.beta`. See [Open testing](#open-testing) below.

---

## Verify locally

```bash
nvm use v22.21.1
npm run android:beta:verify
```

Checks: service account JSON, `eas.json` alignment, package name, EAS login, recent builds.

---

## Play Console checklist (browser)

1. [Play Console](https://play.google.com/console) → **Spaces**
2. **Setup → [API access](https://play.google.com/console/developers/api-access)**
   - Google Cloud project **spaceswallet** linked
   - Service account **Active**
3. **Users and permissions** → `eas-play-submit@spaceswallet.iam.gserviceaccount.com`
   - **App permissions** → **Spaces** (`com.lcfx.spaceswallet`)
   - **View app information and download bulk reports (read-only)**
   - **Release apps to testing tracks**
4. **Testing → Internal testing**
   - Testers list with Gmail addresses
   - Copy **opt-in URL**

Docs: [Play API access](https://support.google.com/googleplay/android-developer/answer/9844689) · [Expo submit Android](https://docs.expo.dev/submit/android/)

---

## Ship commands

```bash
nvm use v22.21.1

# Build only
npm run android:beta:build

# Submit latest finished build to Internal testing
npm run android:beta:submit

# Build + submit
npm run android:beta
```

Monitor:

- [EAS builds](https://expo.dev/accounts/koine/projects/spaces-wallet/builds)
- Play Console → **Internal testing → Releases**

**Submit success:** Release shows on Internal testing with version code (e.g. 3, 4) and is **Available to testers**.

**First-time note:** Google sometimes requires **one manual AAB upload** before the API works. If submit fails with app/API errors, upload an AAB once via Play Console → Internal testing → Create release, then retry EAS submit.

---

## Open testing

Same **build** profile (`beta` → store AAB). Different **submit** profile targets Play **Open testing** (public opt-in link).

```bash
# Build only (same AAB as Internal)
npm run android:open:build

# Submit latest finished build to Open testing
npm run android:open:submit

# Build + submit to Open testing
npm run android:open
```

Play Console: **Testing → Open testing** → Releases + opt-in URL. Store listing and policy sections must be complete before Open testing goes live.

| Submit profile | `track` | Play Console |
|----------------|---------|--------------|
| `submit.beta` | `internal` | Internal testing |
| `submit.open` | `beta` | Open testing |

---

## Draft vs completed

| `releaseStatus` | Behavior |
|-----------------|----------|
| `completed` | EAS publish makes build available to testers (current config) |
| `draft` | EAS uploads; you **Promote** manually in Play Console |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| The caller does not have permission | Play app permissions on service account; wait 30 min |
| App not found | Create app with package `com.lcfx.spaceswallet` |
| Version code already used | `autoIncrement: true` on `beta` — rebuild |
| Submit went to wrong track | Confirm `track: internal` in `eas.json` |
| Testers can't install | Opt-in URL + same Google account on device |

---

## Related

- [`ANDROID_BETA.md`](../ANDROID_BETA.md) — full beta runbook (includes Closed testing)
- [`play-console-declarations.md`](./play-console-declarations.md) — Data safety / policy answers
- [`../eas.json`](../eas.json) — build + submit profiles
