# Mobile platform notes — Spaces Wallet

Practical issues observed on **iOS** and **Android** while building Spaces purchase and list flows. Use this doc when debugging “stuck loading”, silent network hangs, checkout freezes, or confirmation UI disappearing.

---

## Android: purchase summary dismisses when focusing coupon field

### Symptom

After **POST purchase**, the order summary is visible. Tapping the **coupon** `TextInput` hides the summary and returns to the pre-purchase button state.

### Cause

On Android, focusing a nested field often **blurs** the subspace / space_name inputs. Those inputs call `runCheckAvailabilityNow()` on blur. A successful quote GET runs `checkAvailability`, which on `state === 'available'` called `setIsConfirmationMode(false)` and `setPurchaseData(null)`.

### Fix

While `isConfirmationMode` is true:

- Skip availability checks (`checkAvailability`, debounced wake, `runCheckAvailabilityNow`, subspace/space_name blur handlers).
- Ignore in-flight availability responses if confirmation opened before they complete.
- Clear pending availability debounce when entering confirmation mode.

---

## 1. `fetch` can hang after the server responds

### Symptom

- UI stays on **Processing…**, **Requesting…**, **Checking…**, or a spinner forever.
- Metro may show the server returned **200**, but `await response.json()` / `response.text()` never resolves.
- Often worse when **`AbortSignal`** or a timeout `AbortController` is attached.

### Cause (working theory)

React Native on iOS routes `fetch` through **RCTNetworking**. In some cases the HTTP status arrives but the **response body never completes** on the JS side—especially with abort/timeouts—so the promise never settles.

### Fix

Use **`XMLHttpRequest`** for Spaces API traffic on iOS. Implementation lives in `src/utils/load-spaces-list.ts`:

| Export | Use for |
|--------|---------|
| `readSpacesApiGet(url, timeoutMs?, signal?)` | GET JSON endpoints (quotes, availability, job/unified status polls) |
| `readSpacesApiRequest(url, { method, headers, body, timeoutMs, signal })` | POST, PUT, DELETE to Spaces API |

On `Platform.OS === 'ios'`, these call `readSpacesViaXhr`; other platforms use `readSpacesViaFetch`. Always parse the returned **`text`** with `JSON.parse` yourself—do not use `response.json()`.

`GET /getspaces` uses the same XHR path via `readGetSpaces` inside `fetchGetSpacesOnce`.

### Typical timeouts

Defined in `src/app/spaces.tsx` (and reused for Spaces calls):

- `AVAILABILITY_GET_TIMEOUT_MS` — 15s (quote/availability/poll GETs)
- `PURCHASE_API_TIMEOUT_MS` — 60s (POST purchase, PUT confirm, watch-payment, payment callback)

### Still on raw `fetch` (audit if hangs appear)

Not every Spaces-related call has been migrated. Examples as of this doc:

- `src/app/spaces.tsx` — `fetchUnifiedHandleStatus`, `fetchListnumsChainSnapshot`, other helpers; **DELETE** cancel purchase; **Find Spaces** POST
- `src/app/subspace.tsx` — many routes
- `src/utils/space-pipeline.ts`, pricing, certrelay, etc.

**Rule:** Any user-visible Spaces checkout or polling path on iOS should go through `readSpacesApi*` first when adding or debugging hangs.

---

## 2. `setTimeout` debounce while `TextInput` is focused

### Symptom

- Logs show **“debounce scheduled”** but never **“debounce fired”** for subname availability or coupon validation.
- Field looks idle; quote/coupon state never updates until blur or leaving the screen.

### Cause

On iOS, **`setTimeout` / `setInterval` are unreliable** (or heavily delayed) while a **`TextInput` has focus**. A `useEffect` that only schedules `setTimeout(2000)` on dependency changes is not enough.

### Fix (pattern in `src/app/spaces.tsx`)

1. On **`onChangeText`**, record `{ subspace, spaceName, editedAt }` in a ref (`markAvailabilityTyping` / coupon equivalent).
2. **`tryRunDebounced*`** — if `Date.now() - editedAt >= DEBOUNCE_MS`, run the check immediately.
3. **`requestAnimationFrame` wake loop** — each frame, try the debounced runner until idle or unmounted (`startAvailabilityWakeLoop`, coupon wake loop).
4. **Extra wake points** — after render, when job polling ticks (`poll-iteration`), so timers are not the only driver.
5. **Flush on blur / Done / space name select** — `runCheckAvailabilityNow` / force coupon validate via backdated `editedAt` on `onEndEditing`.

Constants: `SUBNAME_AVAILABILITY_DEBOUNCE_MS`, `COUPON_DEBOUNCE_MS` (2s each).

Availability and coupon **network** calls use `readSpacesApiGet` / `readSpacesApiRequest`, not raw `fetch`.

---

## 3. Bare worklet hangs during purchase / checkout

### Symptom

- Free coupon or paid confirm stuck after PUT, during **Taproot path reserve**, or while “Requesting…” / **Composing Transaction…**.
- No error; worklet queue appears blocked.

### Cause

The Bare **worklet is single-threaded**. During active checkout, calls such as:

- `getMnemonic()` / worklet entropy → mnemonic
- `WDKSpaces.deriveTaprootAddressesFromPaths` → **`getAccountByPath`** on the worklet

can **hang or never return** while other wallet/network work is in flight (same class of issue as balance RPCs competing for the worklet—see `use-ensure-wallet-addresses.ts`).

### Fix

1. **Mnemonic without worklet** — `getMnemonicWithoutWorklet` in `src/utils/mnemonic-from-secure-storage.ts` decrypts entropy from secure storage and runs `entropyToMnemonic` in JS (`@noble/ciphers`, `bip39`).
2. **Local BIP-86 Taproot derive** — pass `mnemonic` into `resolveNextAvailableTaprootPath` (`src/utils/resolve-next-spaces-path.ts`) so derivation uses `deriveBip86TaprootFromMnemonic` instead of the worklet.

Used on:

- Free-coupon confirm (`handlePurchase` confirmation branch)
- Paid confirm after PUT (`reserveTaprootPathForPurchase` with `mnemonicForReserve`)

**Do not** call worklet `getAccountByPath` on the critical checkout path on iOS without a strong reason.

---

## 4. UI stuck on “Requesting…” (free coupon) even when PUT succeeds

### Symptom

Button label **Requesting…** until something far later (or forever), though PUT already returned `job_id`.

### Cause

The confirm handler **awaited** a long chain after PUT: AsyncStorage, Taproot reserve, multiple watch-payment POSTs, payment callback (each up to `PURCHASE_API_TIMEOUT_MS`), before `finally` reset the button.

### Fix

After a successful PUT and minimal state updates (`jobId`, My Spaces row, refs):

- Run **reserve + simulated payment registration + `pollJobStatus`** in a **fire-and-forget** async IIFE.
- Let **`finally`** exit confirmation mode and reset the button immediately.

Toasts and polling continue in the background.

---

## 5. Debugging checklist

1. **Identify the label** — Processing (POST purchase), Requesting (free PUT), Composing (paid PUT + tx), Checking (coupon/availability).
2. **Metro grep** — `[Spaces API]` lines; note whether **start** vs **Success** appears for the same URL.
3. **If Success logged but UI stuck** — suspect post-response work (worklet, or `await` chain before `finally`), not the HTTP layer.
4. **If no Success** — suspect hung `fetch`; switch call site to `readSpacesApi*` or confirm server reachability (simulator → host IP, ATS, VPN).
5. **TextInput focused** — suspect debounce timer; use rAF wake + blur flush.
6. **Release-only native issues** — Bare addon stripping / linking are separate; see `@spacesops/react-native-bare-kit` `TROUBLESHOOTING.md`.

---

## 6. Related files

| Area | File |
|------|------|
| XHR vs fetch transport | `src/utils/load-spaces-list.ts` |
| Purchase, debounce, polls | `src/app/spaces.tsx` |
| Mnemonic off worklet | `src/utils/mnemonic-from-secure-storage.ts` |
| Taproot path without worklet | `src/utils/resolve-next-spaces-path.ts`, `src/utils/derive-bip86-taproot.ts` |
| Worklet bundle / release order | `CLAUDE.md`, `pear-wrk-repack` rules in repo |

---

## 7. When adding new Spaces API calls

1. On iOS, use **`readSpacesApiRequest`** / **`readSpacesApiGet`** from the start.
2. Avoid **`await fetch(...).json()`** on checkout or polling loops.
3. Avoid **worklet** crypto on the same screen path as purchase confirm; prefer mnemonic + local derive.
4. Do not rely on **`setTimeout` alone** for debounced network work while inputs are focused; use the rAF + ref pattern above.
5. Keep **button / confirmation state** in `finally` or reset immediately after the critical HTTP step; defer heavy follow-up work.
