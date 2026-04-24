# Purchase status update API

Internal/operator endpoint to advance **`unified_status`** and timestamp fields on a **`purchases`** row. Works for both **`purchase_type: "subname"`** and **`"pointer"`** rows; use the **database `purchase_id`** for the row you are updating.

For **bundled** subname + pointer purchases, pointer lifecycle steps (`sptr_created`, `sptr_delivered`) target the **pointer** row’s `id`. When that row has **`parent_purchase_id`** set, the server **recalculates and updates** the parent subname row’s **`unified_status`** to keep bundle state consistent. **Standalone** pointer purchases (`parent_purchase_id` NULL) do not update a parent.

## Endpoint

**`PUT /api/purchases/:purchaseId/status/:statusType`**

### Path parameters

- **`purchaseId`** — integer primary key of the `purchases` row
- **`statusType`** — one of the valid status types below

### Body (optional)

- **`spaceName`** — recommended for faster lookup (tenant resolution)
- **`batch_id`** — required when `statusType` is `proof_batched`

### Valid status types

- `proof_created`
- `proof_batched`
- `proof_committed`
- `certificate_delivered`
- `sptr_created` — space-pointer step (naming reflects historical `sptr_*` columns)
- `sptr_delivered`

## Example calls

Examples use `http://127.0.0.1:3000` (override with `PLATFORM_PORT` if set).

### 1. Mark proof as created

```bash
curl -X PUT "http://127.0.0.1:3000/api/purchases/123/status/proof_created" \
  -H "Content-Type: application/json" \
  -d '{"spaceName": "tabconf"}'
```

**Response:**

```json
{
  "success": true,
  "message": "Purchase 123 status updated to proof_created",
  "purchase_id": 123,
  "unified_status": "proof_created"
}
```

### 2. Mark proof as batched (`batch_id` required)

```bash
curl -X PUT "http://127.0.0.1:3000/api/purchases/123/status/proof_batched" \
  -H "Content-Type: application/json" \
  -d '{
    "spaceName": "tabconf",
    "batch_id": "batch-2024-01-15-abc123"
  }'
```

### 3. Mark proof as committed

```bash
curl -X PUT "http://127.0.0.1:3000/api/purchases/123/status/proof_committed" \
  -H "Content-Type: application/json" \
  -d '{"spaceName": "tabconf"}'
```

### 4. Mark certificate as delivered

```bash
curl -X PUT "http://127.0.0.1:3000/api/purchases/123/status/certificate_delivered" \
  -H "Content-Type: application/json" \
  -d '{"spaceName": "tabconf"}'
```

### 5. Space-pointer: mark created

Use the **`purchase_id` of the pointer row** (standalone pointer, or bundled pointer child).

```bash
curl -X PUT "http://127.0.0.1:3000/api/purchases/456/status/sptr_created" \
  -H "Content-Type: application/json" \
  -d '{"spaceName": "tabconf"}'
```

### 6. Space-pointer: mark delivered

```bash
curl -X PUT "http://127.0.0.1:3000/api/purchases/456/status/sptr_delivered" \
  -H "Content-Type: application/json" \
  -d '{"spaceName": "tabconf"}'
```

### 7. Without `spaceName` (searches all tenant DBs)

```bash
curl -X PUT "http://127.0.0.1:3000/api/purchases/123/status/proof_created" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## JavaScript example

```javascript
async function updatePurchaseStatus(purchaseId, statusType, options = {}) {
  const { spaceName, batchId } = options;
  const baseUrl = 'http://127.0.0.1:3000';

  const body = {};
  if (spaceName) body.spaceName = spaceName;
  if (batchId) body.batch_id = batchId;

  const response = await fetch(
    `${baseUrl}/api/purchases/${purchaseId}/status/${statusType}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();
  if (!data.success) throw new Error(data.message);
  return data;
}

await updatePurchaseStatus(123, 'proof_created', { spaceName: 'tabconf' });
await updatePurchaseStatus(123, 'proof_batched', {
  spaceName: 'tabconf',
  batchId: 'batch-2024-01-15-abc123',
});
await updatePurchaseStatus(456, 'sptr_delivered', { spaceName: 'tabconf' });
```

## Python example

```python
import requests

def update_purchase_status(purchase_id, status_type, space_name=None, batch_id=None):
    url = f"http://127.0.0.1:3000/api/purchases/{purchase_id}/status/{status_type}"
    body = {}
    if space_name:
        body["spaceName"] = space_name
    if batch_id:
        body["batch_id"] = batch_id
    response = requests.put(url, json=body)
    response.raise_for_status()
    return response.json()

update_purchase_status(123, "proof_created", space_name="tabconf")
update_purchase_status(123, "proof_batched", space_name="tabconf", batch_id="batch-2024-01-15-abc123")
update_purchase_status(456, "certificate_delivered", space_name="tabconf")
```

## Notes

1. **Timestamps** — The handler sets the matching `*_at` column (or `proof_batch_id`) when applying a status.
2. **Parent cascade** — If the updated row has **`parent_purchase_id`**, the **parent** subname row’s **`unified_status`** is recomputed from subname + pointer and updated. This applies to **bundled** pointer children, not standalone pointers.
3. **`batch_id`** — Required for `proof_batched`.
4. **`spaceName`** — Optional; omitting it searches every tenant database (slower).
5. **Errors** — `400` invalid status type, `404` purchase not found, `500` server error.

## Workflow example (subname)

```bash
curl -X PUT "http://127.0.0.1:3000/api/purchases/123/status/proof_created" \
  -H "Content-Type: application/json" \
  -d '{"spaceName": "tabconf"}'

curl -X PUT "http://127.0.0.1:3000/api/purchases/123/status/proof_batched" \
  -H "Content-Type: application/json" \
  -d '{"spaceName": "tabconf", "batch_id": "batch-2024-01-15-abc123"}'

curl -X PUT "http://127.0.0.1:3000/api/purchases/123/status/proof_committed" \
  -H "Content-Type: application/json" \
  -d '{"spaceName": "tabconf"}'

curl -X PUT "http://127.0.0.1:3000/api/purchases/123/status/certificate_delivered" \
  -H "Content-Type: application/json" \
  -d '{"spaceName": "tabconf"}'
```

If this subname has a **bundled** pointer row `456`, pointer steps use purchase **456**; the parent **123** `unified_status` updates when **456** is advanced.

## Response format

### Success

```json
{
  "success": true,
  "message": "Purchase 123 status updated to proof_created",
  "purchase_id": 123,
  "unified_status": "proof_created"
}
```

### Invalid status type (400)

```json
{
  "success": false,
  "message": "Invalid status type. Must be one of: proof_created, proof_batched, proof_committed, certificate_delivered, sptr_created, sptr_delivered"
}
```

### Purchase not found (404)

```json
{
  "success": false,
  "message": "Purchase 123 not found"
}
```

## See also

- **`PURCHASE.md`** — `purchase_type`, POST/DELETE/PUT on `/spaces/...`, and **`GET /api/purchases/:spaceName/:subspace/status`**
