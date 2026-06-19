# Unified Purchase Status Tracking

This document describes the unified status tracking system implemented for subspace purchases that consolidates status information for both purchase variations (subname-only and subname+SPTR) into a single entry in the "My Spaces" table.

## Overview

The unified status tracking system provides a single status display for subspace purchases, regardless of whether the purchase includes SPTR or not. The system tracks the complete workflow from payment confirmation through proof creation, batch commitment, certificate delivery, and SPTR creation/delivery.

## Status Flow

### For Subname-Only Purchase (`sptr=false`)

1. `pending_payment` - Awaiting payment detection
2. `processing` - Payment detected, waiting for confirmations
3. `confirmed` - Payment confirmed (required confirmations met)
4. `proof_created` - Proof created, waiting for batch
5. `proof_batched` - Proof in batch, waiting for commitment
6. `proof_committed` - Batch commitment confirmed on-chain
7. `certificate_pending` - Certificate being prepared
8. `certificate_delivered` - **FINAL STATUS** - Certificate delivered

### For Subname + SPTR Purchase (`sptr=true`)

1. `pending_payment` - Awaiting payment detection (both purchases)
2. `processing` - Payment detected, waiting for confirmations (both purchases)
3. `confirmed` - Payment confirmed (both purchases)
4. `proof_created` - Proof created, waiting for batch
5. `proof_batched` - Proof in batch, waiting for commitment
6. `proof_committed` - Batch commitment confirmed on-chain
7. `certificate_pending` - Certificate being prepared
8. `certificate_delivered` - Certificate delivered
9. `sptr_creating` - SPTR creation in progress
10. `sptr_created` - SPTR created on-chain
11. `sptr_delivered` - **FINAL STATUS** - SPTR delivered

## Status Display Names

| Status Code | Display Name | Description |
|------------|--------------|-------------|
| `pending_payment` | "Awaiting Payment" | Payment not yet detected |
| `processing` | "Confirming Payment" | Payment detected, waiting for confirmations |
| `confirmed` | "Payment Confirmed" | Payment confirmed, starting proof creation |
| `proof_created` | "Proof Created" | Proof created, waiting for batch |
| `proof_batched` | "Waiting for Batch" | Proof in batch, waiting for commitment |
| `proof_committed` | "Proof Committed" | Batch commitment confirmed on-chain |
| `certificate_pending` | "Preparing Certificate" | Certificate being prepared |
| `certificate_delivered` | "Certificate Ready" | Certificate delivered (subname-only final) |
| `sptr_creating` | "Creating SPTR" | SPTR creation in progress |
| `sptr_created` | "SPTR Created" | SPTR created on-chain |
| `sptr_delivered` | "Complete" | SPTR delivered (final status) |
| `expired` | "Expired" | Purchase expired |
| `cancelled` | "Cancelled" | Purchase cancelled |

## Backend Implementation

### Database Schema

The `purchases` table includes the following new columns:

- `unified_status` (TEXT) - The unified status for the purchase
- `parent_purchase_id` (INTEGER) - Links SPTR purchase to subname purchase
- `proof_created_at` (DATETIME) - When proof was created
- `proof_batch_id` (TEXT) - Batch ID the proof is in
- `proof_committed_at` (DATETIME) - When batch was committed on-chain
- `certificate_delivered_at` (DATETIME) - When certificate was delivered
- `sptr_created_at` (DATETIME) - When SPTR was created on-chain
- `sptr_delivered_at` (DATETIME) - When SPTR was delivered

### API Endpoints

#### GET `/api/purchases/:spaceName/:subspace/status`

Returns unified status for a subspace purchase.

**Response:**
```json
{
  "success": true,
  "subspace": "unknown",
  "spaceName": "tabconf",
  "unified_status": "proof_batched",
  "has_sptr": true,
  "subname_status": "proof_batched",
  "sptr_status": "confirmed",
  "subname_job_id": 123,
  "sptr_job_id": 124,
  "subname_purchase_id": 45,
  "sptr_purchase_id": 46,
  "details": {
    "proof_created_at": "2024-01-15T10:30:00Z",
    "proof_batch_id": "batch-abc123",
    "proof_committed_at": null,
    "certificate_delivered_at": null,
    "sptr_created_at": null,
    "sptr_delivered_at": null
  }
}
```

#### PUT `/api/purchases/:purchaseId/status/:statusType`

Updates purchase unified_status and related timestamp fields.

**Status Types:**
- `proof_created`
- `proof_batched` (requires `batch_id` in body)
- `proof_committed`
- `certificate_delivered`
- `sptr_created`
- `sptr_delivered`

**Request Body:**
```json
{
  "spaceName": "tabconf",
  "batch_id": "batch-abc123" // Required for proof_batched
}
```

### Unified Status Logic

The `getUnifiedStatus()` function calculates the unified status by:
1. If no SPTR purchase exists, return subname purchase status
2. If SPTR purchase exists, return the "most advanced" status using priority order
3. Priority order: `sptr_delivered` > `sptr_created` > `sptr_creating` > `certificate_delivered` > `proof_committed` > `proof_batched` > `proof_created` > `confirmed` > `processing` > `pending_payment`

## Frontend Implementation

### Type Definitions

```typescript
type UnifiedStatus =
  | 'pending_payment'
  | 'processing'
  | 'confirmed'
  | 'proof_created'
  | 'proof_batched'
  | 'proof_committed'
  | 'certificate_pending'
  | 'certificate_delivered'
  | 'sptr_creating'
  | 'sptr_created'
  | 'sptr_delivered'
  | 'expired'
  | 'cancelled'
  | 'purchasing'; // Legacy status

type SpaceItem = {
  subspace: string;
  spaceName: string;
  handle: string;
  status: UnifiedStatus;
  jobId?: number; // Primary job ID (subname)
  sptrJobId?: number; // SPTR job ID (if applicable)
  purchaseId?: number; // Subname purchase ID
  sptrPurchaseId?: number; // SPTR purchase ID
  hasSptr?: boolean; // Whether this purchase includes SPTR
  scriptPubKeyHex?: string; // Taproot script pubkey (Find Spaces scan or reserved at purchase)
  taprootDerivationPath?: string; // Full BIP-86 path when reserved at first-time purchase
};
```

### Polling Logic

The frontend polling logic:
1. First attempts to use the unified status endpoint: `GET /api/purchases/:spaceName/:subspace/status`
2. Falls back to job status endpoint if unified status endpoint fails
3. Updates space status based on unified status response
4. Stops polling when status reaches terminal states: `certificate_delivered` (subname-only) or `sptr_delivered` (with SPTR)

### Purchase Flow

When a user buys a new subname in **Spaces Wallet** (`src/app/spaces.tsx`):

1. POST purchase returns `job_id` and `payment_watch` spec
2. PUT confirm returns `purchase_id` and moves job to `pending_payment`
3. **First-time purchase:** client reserves the next available off-chain Taproot path and stores `scriptPubKeyHex` on the My Spaces row (between PUT confirm and broadcast)
4. After broadcast (or simulate), client calls watch-payment and `/api/payments/callback?tenant=...` with `transaction_id` and `script_pubkey` (first-time only)
5. Polling begins; unified status progresses from `pending_payment` → `processing` → …

When `sptr=true` (bundled pointer):
- Stores both `jobId` (subname) and `sptrJobId` (SPTR) in space data
- Stores both `purchaseId` and `sptrPurchaseId`
- Sets `hasSptr: true`
- Initializes `unified_status` to `pending_payment`

## Migration

The migration `014_add_unified_status_tracking.js`:
1. Adds new columns to `purchases` table
2. Updates existing purchases to set `unified_status` based on current `status`
3. Links existing SPTR purchases to their parent subname purchases (if applicable)

## Integration Points

When implementing proof/certificate/SPTR workflows, call the status update endpoints:

1. **Proof Creation**: `PUT /api/purchases/:purchaseId/status/proof_created`
2. **Proof Batching**: `PUT /api/purchases/:purchaseId/status/proof_batched` (with `batch_id`)
3. **Batch Commitment**: `PUT /api/purchases/:purchaseId/status/proof_committed`
4. **Certificate Delivery**: `PUT /api/purchases/:purchaseId/status/certificate_delivered`
5. **SPTR Creation**: `PUT /api/purchases/:purchaseId/status/sptr_created`
6. **SPTR Delivery**: `PUT /api/purchases/:purchaseId/status/sptr_delivered`

## Testing

To test the unified status system:

1. Create a subname-only purchase and verify status progression
2. Create a subname+SPTR purchase and verify unified status reflects both purchases
3. Verify that status updates propagate correctly
4. Verify that polling stops at appropriate terminal states
5. Verify that "My Spaces" table displays correct unified status

## Future Enhancements

1. **Webhook Support**: Push status updates to client instead of polling
2. **Status History**: Track status change history for debugging
3. **Estimated Time**: Show estimated time remaining for each status
4. **Error States**: Add error statuses for failed operations
5. **Retry Logic**: Allow retrying failed operations
