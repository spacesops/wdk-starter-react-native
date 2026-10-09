# Job Status Polling API

## Overview

The Job Status Polling API provides an anonymous endpoint for clients to check the status of payment jobs. This enables clients to monitor purchase progress, track confirmation status, and handle expiration without requiring authentication.

## Endpoint

```
GET /api/jobs/:jobId
```

**Authentication:** None required (anonymous route)

## Request Parameters

### Path Parameters

- `jobId` (required): The job ID returned from the purchase initiation endpoint (integer)

### Query Parameters

- `space` (optional): Space name to optimize database lookup. If provided, the system will directly query the tenant database. If omitted, the system will search across all tenant databases (less efficient).

## Request Examples

### With Space Name (Recommended)

```bash
curl "http://localhost:3000/api/jobs/123?space=tabconf"
```

### Without Space Name

```bash
curl "http://localhost:3000/api/jobs/123"
```

## Response Format

### Success Response

```json
{
  "success": true,
  "job": {
    "id": 123,
    "status": "processing",
    "expiring_blockheight": 850000,
    "created_at": "2024-01-15T10:30:00Z",
    "current_blockheight": 849998,
    "blocks_until_expiration": 2,
    "is_expired": false
  },
  "purchase": {
    "id": 45,
    "handle": "unknown@tabconf",
    "status": "processing",
    "conf_target": 6,
    "block_fee": 10000,
    "price": 600000,
    "quote_id": 2,
    "created_at": "2024-01-15T10:30:00Z"
  }
}
```

### Error Responses

#### Invalid Job ID

```json
{
  "success": false,
  "message": "Invalid job_id. Must be a positive integer."
}
```
**Status Code:** 400 Bad Request

#### Job Not Found

```json
{
  "success": false,
  "message": "Job 123 not found"
}
```
**Status Code:** 404 Not Found

#### Space Not Found (when space parameter provided)

```json
{
  "success": false,
  "message": "Space not found"
}
```
**Status Code:** 404 Not Found

#### Server Error

```json
{
  "success": false,
  "message": "Internal server error: [error details]"
}
```
**Status Code:** 500 Internal Server Error

## Response Fields

### Job Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Job ID |
| `status` | string | Current job status (see Status Values below) |
| `expiring_blockheight` | integer | Block height when the job expires |
| `created_at` | string | ISO 8601 timestamp when job was created |
| `current_blockheight` | integer\|null | Current blockchain height (null if RPC unavailable) |
| `blocks_until_expiration` | integer\|null | Number of blocks until expiration (null if block height unavailable) |
| `is_expired` | boolean | Whether the job has expired |

### Purchase Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Purchase ID |
| `handle` | string | Subspace handle being purchased |
| `status` | string | Current purchase status |
| `conf_target` | integer | Required confirmation target (1, 6, or 48 blocks) |
| `block_fee` | integer | Fee amount in satoshis |
| `price` | integer | Base price in satoshis |
| `quote_id` | integer | Associated quote ID |
| `created_at` | string | ISO 8601 timestamp when purchase was created |

**Note:** `purchase` may be `null` if no purchase is associated with the job.

## Status Values

### Job Status

- `pending_payment` - Job created, awaiting payment detection
- `processing` - Payment detected, waiting for confirmations
- `confirmed` - Required confirmations met, purchase complete
- `expired` - Job expired (current block height > expiring_blockheight)
- `cancelled` - Job was cancelled

### Purchase Status

- `pending` - Purchase initiated, awaiting payment
- `processing` - Payment detected, waiting for confirmations
- `confirmed` - Required confirmations met
- `expired` - Purchase expired

## HTTP Headers

### Rate Limiting Headers (Future Implementation)

The endpoint includes rate limiting headers for future implementation:

- `X-RateLimit-Limit`: Maximum requests per time window (currently placeholder: 60)
- `X-RateLimit-Remaining`: Remaining requests in current window (currently placeholder)
- `X-RateLimit-Reset`: Unix timestamp when rate limit resets (currently placeholder)

### Cache Headers

- `Cache-Control: no-cache, no-store, must-revalidate`
- `Pragma: no-cache`
- `Expires: 0`

These headers indicate that responses should not be cached and clients should always fetch fresh data.

## Polling Strategy

### Phase-based intervals (Spaces Wallet)

Purchase status changes on much longer timelines than early clients assumed. **Spaces Wallet** (`src/utils/purchase-status-polling.ts`, `pollJobStatus` in `src/app/spaces.tsx`) uses **fixed phase-based intervals** instead of exponential backoff:

| Phase | When | Interval | Rationale |
|-------|------|----------|-----------|
| `free_coupon_early` | Completely-free coupon (`isFreeCouponPurchase` or `requesting`) before SUBS `staged` | **3 min** | Simulated transaction; server updates after several minutes |
| `pre_staged` | Paid purchase before SUBS `staged` | **30 min** | Real tx confirmation + staging typically takes ≥30 minutes |
| `staged_plus` | SUBS `staged`/`committed`, or unified `proof_created`+ | **60 min** | Batch commitments are ~150 blocks (>1 day); hourly checks suffice |

**Other rules:**

1. **One immediate poll** on start (catch already-complete purchases), then wait the phase interval.
2. **Error retries:** `min(phaseInterval, 5 min)` — no exponential doubling.
3. **maxAttempts:** 168 (~7 days at 1 hr for long commitment pipelines).
4. **Manual refresh:** My Spaces Status header triggers an immediate full refresh (`handleRefreshAllMySpacesStatuses`).
5. **Stop conditions:** Terminal unified states (`certificate_delivered`, `sptr_delivered`, `expired`, `cancelled`) or on-chain via listnums.

### Example Client Implementation

#### JavaScript/TypeScript

```javascript
const FREE_COUPON_POLL_MS = 3 * 60 * 1000;
const PRE_STAGED_POLL_MS = 30 * 60 * 1000;
const STAGED_PLUS_POLL_MS = 60 * 60 * 1000;
const ERROR_RETRY_CAP_MS = 5 * 60 * 1000;
const MAX_POLL_ATTEMPTS = 168;

function resolvePollingPhase({ unifiedStatus, subsHandleStatus, isFreeCouponPurchase }) {
  const subs = subsHandleStatus?.toLowerCase();
  if (subs === 'staged' || subs === 'committed') return 'staged_plus';
  const proofOrLater = ['proof_created', 'proof_batched', 'proof_committed',
    'certificate_pending', 'certificate_delivered', 'sptr_creating', 'sptr_created', 'sptr_delivered'];
  if (proofOrLater.includes(unifiedStatus)) return 'staged_plus';
  if (isFreeCouponPurchase || unifiedStatus === 'requesting') return 'free_coupon_early';
  return 'pre_staged';
}

function intervalForPhase(phase) {
  if (phase === 'free_coupon_early') return FREE_COUPON_POLL_MS;
  if (phase === 'staged_plus') return STAGED_PLUS_POLL_MS;
  return PRE_STAGED_POLL_MS;
}

/**
 * Poll unified purchase status with phase-based fixed intervals.
 */
async function pollPurchaseStatus(spaceName, subspace, options = {}) {
  const { maxAttempts = MAX_POLL_ATTEMPTS, baseUrl = 'http://localhost:3000' } = options;
  let attempt = 0;
  let delay = PRE_STAGED_POLL_MS;

  const statusUrl = `${baseUrl}/api/purchases/${encodeURIComponent(spaceName)}/${encodeURIComponent(subspace)}/status`;

  while (attempt < maxAttempts) {
    try {
      const response = await fetch(statusUrl);
      const data = await response.json();
      if (!data.success) throw new Error(data.message || 'Failed to fetch status');

      const unifiedStatus = data.unified_status;
      const subsHandleStatus = data.subs_handle_status ?? null; // fetch SUBS separately in production

      const terminal = ['certificate_delivered', 'sptr_delivered', 'expired', 'cancelled'];
      if (terminal.includes(unifiedStatus)) return data;

      const phase = resolvePollingPhase({
        unifiedStatus,
        subsHandleStatus,
        isFreeCouponPurchase: unifiedStatus === 'requesting',
      });
      delay = intervalForPhase(phase);
      attempt++;

      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      console.error(`Polling error (attempt ${attempt + 1}):`, error.message);
      const retryMs = Math.min(delay, ERROR_RETRY_CAP_MS);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      attempt++;
      if (attempt >= maxAttempts) {
        throw new Error(`Max polling attempts (${maxAttempts}) reached: ${error.message}`);
      }
    }
  }

  throw new Error(`Max polling attempts (${maxAttempts}) reached without completion`);
}

// Usage example
async function monitorPurchase(spaceName, subspace) {
  try {
    const result = await pollPurchaseStatus(spaceName, subspace, { maxAttempts: MAX_POLL_ATTEMPTS });

    if (result.unified_status === 'certificate_delivered' || result.unified_status === 'sptr_delivered') {
      console.log('Purchase complete!', result);
    } else if (result.unified_status === 'expired') {
      console.log('Purchase expired');
    } else if (result.unified_status === 'cancelled') {
      console.log('Purchase cancelled');
    }
    
    return result;
  } catch (error) {
    console.error('Polling failed:', error);
    throw error;
  }
}
```

#### Python

```python
import time
import requests
from typing import Optional, Dict, Any

def poll_job_status(
    job_id: int,
    space_name: Optional[str] = None,
    base_url: str = "http://localhost:3000",
    initial_delay: float = 2.0,
    max_delay: float = 300.0,
    max_attempts: int = 100
) -> Dict[str, Any]:
    """
    Poll job status with exponential backoff.
    
    Args:
        job_id: Job ID to poll
        space_name: Space name (optional but recommended)
        base_url: Base URL of the API
        initial_delay: Initial delay in seconds
        max_delay: Maximum delay in seconds
        max_attempts: Maximum number of polling attempts
    
    Returns:
        Final job status data
    
    Raises:
        Exception: If max attempts reached or job fails
    """
    delay = initial_delay
    attempt = 0
    
    url = f"{base_url}/api/jobs/{job_id}"
    if space_name:
        url += f"?space={space_name}"
    
    terminal_states = ['confirmed', 'expired', 'cancelled']
    
    while attempt < max_attempts:
        try:
            response = requests.get(url)
            response.raise_for_status()
            data = response.json()
            
            if not data.get('success'):
                raise Exception(data.get('message', 'Failed to fetch job status'))
            
            job = data['job']
            purchase = data.get('purchase')
            
            # Check for terminal states
            if job['status'] in terminal_states:
                return data
            
            # Check expiration
            if job.get('is_expired'):
                return {**data, 'expired': True}
            
            # Log progress
            print(f"Job {job_id}: {job['status']} (attempt {attempt + 1})")
            if job.get('blocks_until_expiration') is not None:
                print(f"  Blocks until expiration: {job['blocks_until_expiration']}")
            
            # Wait before next poll
            time.sleep(delay)
            
            # Exponential backoff
            delay = min(delay * 2, max_delay)
            attempt += 1
            
        except requests.RequestException as e:
            print(f"Polling error (attempt {attempt + 1}): {e}")
            time.sleep(delay)
            delay = min(delay * 2, max_delay)
            attempt += 1
            
            if attempt >= max_attempts:
                raise Exception(f"Max polling attempts ({max_attempts}) reached: {e}")
    
    raise Exception(f"Max polling attempts ({max_attempts}) reached without completion")

# Usage example
def monitor_purchase(job_id: int, space_name: str):
    try:
        result = poll_job_status(
            job_id,
            space_name,
            initial_delay=2.0,
            max_delay=300.0,
            max_attempts=100
        )
        
        if result['job']['status'] == 'confirmed':
            print('Purchase confirmed!', result.get('purchase'))
        elif result['job']['status'] == 'expired' or result.get('expired'):
            print('Purchase expired')
        elif result['job']['status'] == 'cancelled':
            print('Purchase cancelled')
        
        return result
    except Exception as e:
        print(f'Polling failed: {e}')
        raise
```

#### Bash/curl

```bash
#!/bin/bash

# Poll job status with exponential backoff
poll_job_status() {
    local job_id=$1
    local space_name=$2
    local base_url=${3:-"http://localhost:3000"}
    local initial_delay=${4:-2}
    local max_delay=${5:-300}
    local max_attempts=${6:-100}
    
    local delay=$initial_delay
    local attempt=0
    
    local url="${base_url}/api/jobs/${job_id}"
    if [ -n "$space_name" ]; then
        url="${url}?space=${space_name}"
    fi
    
    while [ $attempt -lt $max_attempts ]; do
        response=$(curl -s "$url")
        success=$(echo "$response" | jq -r '.success')
        
        if [ "$success" = "true" ]; then
            status=$(echo "$response" | jq -r '.job.status')
            
            # Check for terminal states
            if [ "$status" = "confirmed" ] || [ "$status" = "expired" ] || [ "$status" = "cancelled" ]; then
                echo "$response" | jq '.'
                return 0
            fi
            
            echo "Job $job_id: $status (attempt $((attempt + 1)))"
            sleep $delay
            
            # Exponential backoff
            delay=$((delay * 2))
            if [ $delay -gt $max_delay ]; then
                delay=$max_delay
            fi
        else
            echo "Error: $(echo "$response" | jq -r '.message')"
            sleep $delay
            delay=$((delay * 2))
            if [ $delay -gt $max_delay ]; then
                delay=$max_delay
            fi
        fi
        
        attempt=$((attempt + 1))
    done
    
    echo "Max attempts reached"
    return 1
}

# Usage
poll_job_status 123 "tabconf"
```

## Best Practices

### 1. Always Provide Space Name

When possible, include the `space` query parameter. This significantly improves performance by avoiding database searches across all tenants.

```bash
# Good - direct lookup
GET /api/jobs/123?space=tabconf

# Less efficient - searches all tenant DBs
GET /api/jobs/123
```

### 2. Match polling frequency to operational timelines

Do not poll every few seconds for purchases that take 30+ minutes to stage or days to commit. Use phase-based fixed intervals (see above) or exponential backoff capped at intervals appropriate to the current lifecycle stage.

### 3. Handle Network Errors

Network errors are common. Your polling implementation should:
- Retry on transient errors
- Use exponential backoff for retries
- Distinguish between retryable and non-retryable errors

### 4. Monitor Expiration

Always check `is_expired` and `blocks_until_expiration`:
- Stop polling if expired
- Adjust polling frequency based on expiration proximity
- Warn users when expiration is approaching

### 5. Respect Rate Limits

When rate limiting is implemented:
- Monitor `X-RateLimit-Remaining` header
- Adjust polling frequency based on rate limit status
- Implement backoff when approaching limits

### 6. Handle Missing Block Height

`current_blockheight` may be `null` if RPC is unavailable:
- Don't rely on expiration calculations when null
- Still poll for status changes
- Log warnings when block height unavailable

## Typical Polling Timeline

### Paid purchase (real transaction)

| Time | Interval | Status | Action |
|------|----------|--------|--------|
| 0s | immediate | `pending_payment` / `processing` | First status check |
| +30 min | 30 min | `processing` / `confirmed` | Poll until SUBS `staged` |
| +30 min | 30 min | SUBS `staged` | Phase switches to `staged_plus` |
| +60 min | 60 min | `proof_*` / commitment pipeline | Hourly checks |
| … | 60 min | `certificate_delivered` | **Done** — stop polling |

Staging after payment typically takes **≥30 minutes**. Batch commitments are **~150 blocks (>1 day)**.

### Completely-free coupon (simulated transaction)

| Time | Interval | Status | Action |
|------|----------|--------|--------|
| 0s | immediate | `requesting` | First status check |
| +3 min | 3 min | `requesting` / `processing` | Poll until SUBS `staged` |
| +3 min | 3 min | SUBS `staged` | Phase switches to hourly |
| … | 60 min | `certificate_delivered` | **Done** |

Simulated payment registration completes on the server after **several minutes**, not seconds.

## Integration with Purchase Flow

### Spaces Wallet client timeline

The app in `src/app/spaces.tsx` follows this sequence (see **`PURCHASE.md` → Spaces Wallet client flow** for API detail):

1. **GET quote** — availability and `quote_id`
2. **POST purchase** — payment address, `job_id`, `payment_watch` spec
3. **Compose tx** — unsigned hex with handle memo
4. **PUT confirm** — `{ quote_id, purchase_type: "subname" }` → `purchase_id`
5. **Reserve Taproot path** (first-time only) — next off-chain BIP-86 path + `script_pubkey` via `resolveNextAvailableTaprootPath`
6. **Broadcast / Simulate** — `POST /api/jobs/:jobId/watch-payment` and `POST /api/payments/callback?tenant=:space` with `transaction_id` (+ `script_pubkey` on first purchase)
7. **Poll** — `GET /api/purchases/:spaceName/:subspace/status` (or job status fallback) until terminal state

Polling should start after step 6. Status moves from `pending_payment` → `processing` once the server accepts the payment registration.

### Complete Purchase Flow Example

```javascript
// 1. Initiate purchase
const purchaseResponse = await fetch('/spaces/tabconf/unknown?format=json', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    block_fee: 10000,
    handle: 'unknown@tabconf',
    price: 600000,
    quote_id: 2,
    conf_target: 6
  })
});

const purchase = await purchaseResponse.json();
const jobId = purchase.job_id; // Extract job_id from response

// 2. Confirm purchase (PUT) — required before payment registration in Spaces Wallet
await fetch('/spaces/tabconf/unknown?format=json', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ quote_id: 2, purchase_type: 'subname' })
});

// 2.5 First-time purchase: reserve wallet Taproot path + script_pubkey
// (see resolveNextAvailableTaprootPath in src/utils/resolve-next-spaces-path.ts)

// 3. User sends payment to purchase.taproot_address (or simulate in dev)

// 4. Register payment watch + callback
await fetch(`/api/jobs/${jobId}/watch-payment?space=tabconf`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    transaction_id: '<64-hex txid>',
    script_pubkey: '<taproot spk hex>' // first-time only
  })
});
await fetch('/api/payments/callback?tenant=tabconf', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    transaction_id: '<64-hex txid>',
    label: 'unknown@tabconf',
    purchase_id: purchase.purchase_id,
    script_pubkey: '<taproot spk hex>' // first-time only
  })
});

// 5. Poll for unified status (phase-based intervals in Spaces Wallet)
const result = await pollPurchaseStatus('tabconf', 'unknown', { maxAttempts: 168 });

// 6. Handle result
if (result.unified_status === 'certificate_delivered') {
  console.log('Purchase complete!', result);
  // Proceed with next steps
} else if (result.job.status === 'expired') {
  console.log('Purchase expired');
  // Handle expiration
}
```

## Troubleshooting

### Job Not Found

- Verify the job ID is correct
- Ensure the job hasn't been deleted
- Check if you're using the correct space name

### Status Not Changing

- Verify payment was sent to the correct address
- Check that the PUT confirmation endpoint was called
- For first-time purchases, confirm `script_pubkey` was sent with watch-payment / callback
- Ensure blockchain monitoring is active

### Block Height Unavailable

- This is non-fatal - polling can continue
- Status updates will still work
- Expiration calculations won't be available

### High Polling Frequency

- Implement exponential backoff
- Use longer initial delays for longer confirmation targets
- Monitor rate limit headers when implemented

## Related Endpoints

- `POST /spaces/:spaceName/:subspace` - Initiate purchase (returns `job_id`)
- `PUT /spaces/:spaceName/:subspace` - Confirm purchase (updates job status to `processing`)
- `DELETE /spaces/:spaceName/:subspace` - Cancel purchase (updates job status to `cancelled`)
- `POST /api/jobs/:jobId/watch-payment` - Register payment tx for monitoring (`transaction_id`, optional `script_pubkey` on first purchase)
- `POST /api/payments/callback?tenant=:spaceName` - Notify server of payment (requires `tenant` query param)
- `GET /api/purchases/:spaceName/:subspace/status` - Unified purchase status (preferred for polling)

## Future Enhancements

- Rate limiting implementation
- Webhook support for push notifications
- WebSocket support for real-time updates
- Batch job status queries

