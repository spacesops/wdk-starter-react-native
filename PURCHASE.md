# Subspace and space-pointer purchase flow

This document describes how clients buy **subnames** and **space pointers** in SpacesOps. Both use the same payment and job machinery; they differ in whether a SUBSD **quote** is required and how cancel / confirm / status queries are keyed.

The server defaults to port **3000** unless `PLATFORM_PORT` is set. Examples below use `http://127.0.0.1:3000`; substitute your base URL.

## Overview

1. **Subname** (`purchase_type: "subname"`): requires a quote from **`GET /spaces/:spaceName/:subspace?format=json`**, then **`POST /spaces/...`** with `quote_id`. Optional **bundled** space-pointer purchase on the same handle via `include_pointer_purchase` (second row + second job + second payment).
2. **Space pointer** (`purchase_type: "pointer"`): **no quote** and **no coupons**. Same `POST` path with pricing fields only; confirm/cancel use **`job_id`**, not `quote_id`.

Legacy tenant databases may have had a boolean `sptr` column on `purchases`; on startup, schema migration maps that to `purchase_type` and drops `sptr`.

## Database tables (per tenant)

### `quotes`

Stores SUBSD quote rows (subname flow only). Schema is unchanged in spirit from earlier docs; see `lib/tenantSchema.js` for the canonical `CREATE TABLE`.

### `purchases`

Canonical shape (see `CREATE_PURCHASES_TABLE` in `lib/tenantSchema.js`):

- **`purchase_type`**: `"subname"` or `"pointer"` (required; default `"subname"` for old rows).
- **`quote_id`**: set for subname (and for **bundled** pointer child, so both rows tie to the same quote for cancel-by-quote); **NULL** for standalone pointer purchases.
- **`parent_purchase_id`**: set on a **bundled** pointer row to the subname purchase `id`; **NULL** for standalone pointer or subname rows.
- **`conf_target`**: `1`, `6`, or `48`.
- **`unified_status`**, proof/certificate/**`sptr_*_at`** timestamps: lifecycle fields updated by payment confirmation and **`PUT /api/purchases/:id/status/...`**.
- **`coupon_id`**, **`discount_percent`**: optional columns (subname + coupons only).

Bundled flow creates **two** purchase rows (subname + pointer) and **two** jobs; the POST response includes `pointer_*` fields when a bundled pointer was created.

### `jobs`

Payment windows (`expiring_blockheight`, `status`). Each purchase row references one `job_id`.

## Step 1: Quote retrieval (subname only)

**`GET /spaces/:spaceName/:subspace?format=json`**

Proxied to the tenant SUBSD service; fees may be raised to platform minimums; if a **pending subname** purchase exists for the handle, `state` may be forced to `"pending"`. That pending check considers purchases with **`purchase_type = 'subname'`** (or legacy NULL `purchase_type`), not standalone pointer purchases.

When the response includes quote data, a row is stored and an `id` (quote id) is returned—use this as **`quote_id`** on POST for `purchase_type: "subname"`.

## Step 2: Purchase initiation

**`POST /spaces/:spaceName/:subspace?format=json`**

### Required for all purchase types

| Field | Description |
|--------|-------------|
| `purchase_type` | `"subname"` or `"pointer"` |
| `block_fee` | Fee for the chosen confirmation target |
| `handle` | Full handle, e.g. `unknown@tabconf` |
| `price` | Base price (satoshis); for subname with coupon, server applies discount |
| `conf_target` | `1`, `6`, or `48` |

### Subname only

| Field | Description |
|--------|-------------|
| `quote_id` | From the GET quote response |

Optional:

- `coupon_code` — **not** allowed for `purchase_type: "pointer"`.
- **`include_pointer_purchase`** (truthy) — only with `purchase_type: "subname"`. Also required:
  - `pointer_price`
  - `block_pointer_fee`  
  Creates a second purchase row with `purchase_type: "pointer"`, `parent_purchase_id` set to the subname purchase, and the **same** `quote_id` as the subname row.

### Pointer only

- Do **not** send `quote_id`.
- Do **not** send `coupon_code`.

### Example: subname only

```bash
curl -X POST "http://127.0.0.1:3000/spaces/tabconf/unknown?format=json" \
  -H "Content-Type: application/json" \
  -d '{
    "purchase_type": "subname",
    "block_fee": 10000,
    "handle": "unknown@tabconf",
    "price": 600000,
    "conf_target": 6,
    "quote_id": 2
  }'
```

### Example: subname + bundled pointer

```bash
curl -X POST "http://127.0.0.1:3000/spaces/tabconf/unknown?format=json" \
  -H "Content-Type: application/json" \
  -d '{
    "purchase_type": "subname",
    "include_pointer_purchase": true,
    "block_fee": 10000,
    "handle": "unknown@tabconf",
    "price": 600000,
    "conf_target": 6,
    "quote_id": 2,
    "pointer_price": 50000,
    "block_pointer_fee": 2000
  }'
```

### Example: standalone pointer (no quote)

```bash
curl -X POST "http://127.0.0.1:3000/spaces/tabconf/unknown?format=json" \
  -H "Content-Type: application/json" \
  -d '{
    "purchase_type": "pointer",
    "block_fee": 2000,
    "handle": "unknown@tabconf",
    "price": 50000,
    "conf_target": 6
  }'
```

### Response (shape)

Common fields:

- `success`, `purchase_type`, `taproot_address`, `handle`, `total_price`, `expiring_blockheight`, `purchase_id`, `job_id`
- `payment_watch`: subname — `{ "method": "POST", "path": "/api/jobs/{jobId}/watch-payment?space=...", "body": { "transaction_id": "..." } }`. Standalone **pointer** — same shape but `path` is `/api/purchases/{purchase_id}/watch-pointer-payment?space=...` (no `job_id` in the URL).
- **`pointer_watch_by_handle`** (standalone pointer only): alternate to `payment_watch` — `POST /api/purchases/watch-pointer-payment-by-handle?space=...` with body `{ "handle": "<same as response handle>", "transaction_id": "..." }`. Use when the client knows `subname@space` (e.g. from chain / another app) but not `purchase_id`.

When a bundled pointer is created:

- `pointer_purchase_id`, `pointer_job_id`, `pointer_total_price`, `pointer_payment_watch`
- **`pointer_payment_watch_by_handle`**: same as `pointer_watch_by_handle` but for the bundled pointer row (same `handle` as the subname).

Coupon discounts (subname only) may add `original_price`, `discounted_price`, `discount_percent`, `coupon_code`, `completely_free`.

### Flow (server)

1. Validates `purchase_type` and fields; pointer rejects coupons.
2. Inserts purchase row(s) and job(s); derives payment address from **primary** (subname or standalone pointer) `purchase_id`.
3. Returns payment instructions for the primary job; bundled responses also describe the pointer job.

## Cancel before payment

**`DELETE /spaces/:spaceName/:subspace`**

Pass **`purchase_type`** in query or JSON body.

- **`subname`**: requires **`quote_id`**. Cancels the quote and **all** purchases with that `quote_id`, and their jobs.
- **`pointer`**: requires **`job_id`** only; **do not** pass `quote_id`. Cancels that pointer purchase row and its job (standalone or bundled row, keyed by job).

## Confirm after payment (move to processing)

**`PUT /spaces/:spaceName/:subspace`**

Pass **`purchase_type`** in query or body.

- **`subname`**: requires **`quote_id`**. Marks quote purchased, sets **all** purchases for that quote to `processing`, and **all** related jobs to `processing`.
- **`pointer`**: requires **`job_id`**; **do not** pass `quote_id`. Sets that pointer purchase and its job to `processing`.

### Optional: register Spaced tx watch on confirm

By default, **no** tx watch is registered on purchase or confirm; the client must either register a watch with a 64-hex **`transaction_id`** (subname: **`POST /api/jobs/:jobId/watch-payment`**; pointer: **`POST /api/purchases/:purchaseId/watch-pointer-payment`** or **`POST /api/purchases/watch-pointer-payment-by-handle`** with **`handle`** + **`transaction_id`** when `purchase_id` is not available), or pass the same on confirm:

- **`transaction_id`** (or **`txid`**) — subname payment tx when `purchase_type` is `subname`, or the pointer payment tx when `purchase_type` is `pointer`.
- **`pointer_transaction_id`** — only for **bundled** subname + pointer: second tx paying the pointer job.

On success, the confirm response may include **`payment_watches`** with `watch_id` / `transaction_id` per registered tx. If you omit these fields, the server logs a reminder to call **`watch-payment`** separately.

### `POST /api/jobs/:jobId/watch-payment` body

After the client broadcasts (or simulates) a payment tx, it registers the tx for monitoring:

| Field | Required | Description |
|--------|----------|-------------|
| `transaction_id` | yes | 64-char hex txid |
| `script_pubkey` | first-time purchase only | Taproot script pubkey hex for the **wallet receive path** reserved for this handle (see **Spaces Wallet client flow**). Omit on renewals when the server/job already knows the spk. |

The POST purchase response includes a `payment_watch` template whose `body` may contain placeholder `transaction_id` / `script_pubkey` fields. **Spaces Wallet** strips those placeholders from the template and sets `transaction_id` (and `script_pubkey` when applicable) at registration time via `buildPaymentWatchRequestBody` (`src/utils/build-payment-watch-body.ts`).

### `POST /api/payments/callback`

Query parameter **`tenant`** (space name, lowercased) is **required**.

Example body for a first-time subname purchase:

```json
{
  "transaction_id": "<64-hex txid>",
  "label": "unknown@tabconf",
  "purchase_id": 45,
  "script_pubkey": "<taproot script pubkey hex>"
}
```

For renewals or handles that already have an assigned wallet path, omit `script_pubkey` when the server already has it on the purchase/job row.

## Spaces Wallet client flow

This repo implements the subname purchase UI in `src/app/spaces.tsx`. The end-to-end timeline:

| Step | Action | Notes |
|------|--------|-------|
| 1 | `GET /spaces/:space/:subspace?format=json` | Quote: `handle`, `quote_id`, fees — no wallet `script_pubkey` yet |
| 2 | `POST /spaces/...` | Returns `taproot_address`, `job_id`, `payment_watch` (stored in `postPurchaseWatchRef`) |
| 3 | Compose tx | P2TR + OP_RETURN memo = handle; show confirmation UI |
| 4 | `PUT /spaces/...` | `{ "quote_id", "purchase_type": "subname" }` → `job_id`, `purchase_id` |
| **4.5** | **Reserve wallet path** | **First-time only** (no `scriptPubKeyHex` on the My Spaces row): call `resolveNextAvailableTaprootPath` (`src/utils/resolve-next-spaces-path.ts`) — scans BIP-86 paths from `buildSpacesScanDerivationPaths()`, derives spks via WDK, skips paths on-chain (`GET /api/listnums-by-spk`) or already assigned to other handles. Stores `scriptPubKeyHex` + `taprootDerivationPath` on the row and in AsyncStorage (`spaces_purchase_{job_id}`). |
| 5 | Broadcast or Simulate | Register payment: `POST watch-payment` + `POST /api/payments/callback?tenant=...` with `transaction_id` and `script_pubkey` (first-time). Then poll unified/job status. |

**Environment:** `EXPO_PUBLIC_SPACES_ACCOUNT_NUMBER` and `EXPO_PUBLIC_SPACES_ACCOUNT_GAP` control which BIP-86 receive paths are scanned (see `.env.example`).

**Find Spaces:** Handles discovered via scan already have `scriptPubKeyHex` on the My Spaces row; step 4.5 is skipped and the existing spk is reused at step 5.

**Simulate:** Dev-only path builds a dummy 64-hex txid (`decafcafe…` prefix) and runs the same watch-payment + callback registration as broadcast.

## Unified status (polling)

**`GET /api/purchases/:spaceName/:subspace/status`**

Query parameter **`purchase_type`** (default **`subname`**):

- **`subname`**: latest subname purchase for `subspace@spaceName`, merged unified status with optional **bundled** pointer child (`has_pointer_purchase`, `pointer_*` when present).
- **`pointer`**: latest **standalone** pointer only: `purchase_type = 'pointer'` and **`parent_purchase_id IS NULL`**. Bundled pointer rows are **not** returned on this query; use `purchase_type=subname` to see bundle state.

## Related routes

- **`GET /spaces/:spaceName/:subspace`** — quote (subname)
- **`POST /spaces/:spaceName/:subspace`** — start purchase
- **`DELETE` / `PUT` `/spaces/:spaceName/:subspace`** — cancel / confirm (with `purchase_type`)
- **`GET /api/purchases/:spaceName/:subspace/status`** — unified status
- **`PUT /api/purchases/:purchaseId/status/:statusType`** — operator lifecycle updates (see `PURCHASE_STATUS_UPDATE.md`)
- **`POST /api/jobs/:jobId/watch-payment`** — register payment tx watch (subname / job-keyed)
- **`POST /api/payments/callback?tenant=:spaceName`** — notify server of an on-chain payment (see **Spaces Wallet client flow** above)
- **`GET /api/listnums-by-spk?script_pubkey=:hex`** — check whether a Taproot script pubkey is already on-chain (used when reserving a wallet path)
- **`POST /api/purchases/:purchaseId/watch-pointer-payment`** — same behavior for **pointer** purchases only, keyed by `purchase_id` (standalone: `purchase_id` from the POST response; bundled: `pointer_purchase_id`). Query `space` and JSON body `transaction_id` as on the job route.
- **`POST /api/purchases/watch-pointer-payment-by-handle`** — pointer only; resolves the open pointer purchase for **`handle`** (`subname@space`, must match `?space=`) and registers the same Spaced watch + callback. Body: `handle`, `transaction_id`. For workflows where the subname is discovered on-chain or registered elsewhere, so the client has the handle but not `purchase_id`.

Implementation lives in `server.js` (purchase, cancel, confirm, status) and `lib/tenantSchema.js` (DDL and `sptr` → `purchase_type` migration).

## Fee calculation (GET quote path)

### Platform fee configuration

Platform fees are stored in the `config` table:

- `1_block_fee`, `6_block_fee`, `48_block_fee`

### RPC fee estimation

The system calls the `estimatefee` RPC:

- Parameters: `[blocks, "unset"]` for blocks `1`, `6`, or `48`
- Response includes `feerate_sat_vb` (and related fields)

### Test mode

If `USE_TEST_FEE_RATES=true`, RPC calls are skipped and fixed test feerates are used (see `server.js`).

### Final fee calculation

```
final_fee = platform_fee + (COMMITMENT_VBYTES * feerate_sat_vb)
```

(`COMMITMENT_VBYTES` is defined in `server.js`, typically `256`.)

### Fee replacement logic

In the proxied GET response, a block fee is replaced only when the SUBSD value is **less than** the calculated platform minimum; otherwise the SUBSD value is kept.

## Address derivation (POST payment address)

The **first** purchase row created by a single POST (subname-only, subname in a bundle, or standalone pointer) receives the derived payment address. The path uses that row’s `purchase_id`.

**Space-specific XPUB** (when `xpub` + `derivation` exist on the space): derive from the space XPUB at `{derivation}/0/{purchase_id}`.

**Platform default XPUB**: path shape `m/86/0/{space_id}/0/{purchase_id}` (see `derivePurchasePaymentAddress` in `server.js`).

Network is inferred from the XPUB prefix (`xpub` vs `tpub`). Libraries: `bip32`, `bitcoinjs-lib`, `tiny-secp256k1`.

## Logging

- `[spaces-proxy]` — quote proxy, fee adjustment, pending subname check
- `[purchase]` — POST purchase, jobs, derivation

## Testing

```bash
curl -X POST "http://127.0.0.1:3000/spaces/tabconf/unknown?format=json" \
  -H "Content-Type: application/json" \
  -d '{
    "purchase_type": "subname",
    "block_fee": 10000,
    "handle": "unknown@tabconf",
    "price": 600000,
    "conf_target": 6,
    "quote_id": 2
  }'
```

## Error handling

Typical `400` cases: missing `purchase_type`, wrong combination (`quote_id` with pointer, `include_pointer_purchase` with pointer, coupon on pointer, missing `pointer_price` / `block_pointer_fee` when bundling, invalid `conf_target`).

```json
{
  "success": false,
  "message": "Error description"
}
```
