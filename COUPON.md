# Coupon Code System

Per-tenant discount coupon codes for subspace name purchases. Each tenant manages its own coupons independently.

## Overview

| Feature | Details |
|---|---|
| Storage | `coupons` table in each tenant SQLite DB (`data/spaces/<tenant>.db`) |
| Discount target | Applied to the subspace `price` only — `block_fee` (Bitcoin network fee) is never discounted |
| Code format | Stored and matched uppercase (input is normalized automatically) |
| Usage tracking | `current_uses` incremented atomically on each purchase |
| Date range | ISO 8601 strings compared server-side |
| Management UI | `/tenant-coupons?space=<spaceName>` (requires admin or tenant auth) |

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  discount_percent INTEGER NOT NULL DEFAULT 0
    CHECK(discount_percent >= 0 AND discount_percent <= 100),
  max_uses INTEGER,            -- NULL = unlimited
  current_uses INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,    -- ISO 8601
  end_date TEXT NOT NULL,      -- ISO 8601
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

The `purchases` table also gains two columns:

- `coupon_id INTEGER` — references the coupon used (NULL if none)
- `discount_percent INTEGER DEFAULT 0` — snapshot of the discount at time of purchase

## API Endpoints

All CRUD endpoints require admin (Basic Auth) or tenant session auth. The validation endpoint is anonymous.

### List Coupons

```
GET /api/tenant/coupons
```

```bash
curl -u admin:Whatever! \
  "http://localhost:3000/api/tenant/coupons?space=myspace"
```

Response:

```json
{
  "success": true,
  "coupons": [
    {
      "id": 1,
      "code": "SUMMER2026",
      "discount_percent": 25,
      "max_uses": 100,
      "current_uses": 3,
      "start_date": "2026-06-01T00:00:00.000Z",
      "end_date": "2026-08-31T23:59:59.000Z",
      "enabled": 1,
      "created_at": "2026-04-14T12:00:00",
      "updated_at": "2026-04-14T12:00:00"
    }
  ]
}
```

### Create Coupon

```
POST /api/tenant/coupons
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | Normalized to uppercase |
| `discount_percent` | integer | yes | 0–100 |
| `start_date` | string | yes | ISO 8601 datetime |
| `end_date` | string | yes | ISO 8601 datetime |
| `max_uses` | integer \| null | no | Omit or `null` for unlimited |
| `enabled` | boolean | no | Defaults to `true` |

```bash
curl -u admin:Whatever! \
  -X POST "http://localhost:3000/api/tenant/coupons?space=myspace" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "LAUNCH50",
    "discount_percent": 50,
    "max_uses": 200,
    "start_date": "2026-04-15T00:00:00.000Z",
    "end_date": "2026-12-31T23:59:59.000Z",
    "enabled": true
  }'
```

Response:

```json
{
  "success": true,
  "coupon": {
    "id": 2,
    "code": "LAUNCH50",
    "discount_percent": 50,
    "max_uses": 200,
    "current_uses": 0,
    "start_date": "2026-04-15T00:00:00.000Z",
    "end_date": "2026-12-31T23:59:59.000Z",
    "enabled": 1
  }
}
```

Create an unlimited coupon (no usage cap):

```bash
curl -u admin:Whatever! \
  -X POST "http://localhost:3000/api/tenant/coupons?space=myspace" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "FREEBIE",
    "discount_percent": 100,
    "start_date": "2026-01-01T00:00:00.000Z",
    "end_date": "2027-01-01T00:00:00.000Z"
  }'
```

### Update Coupon

```
PUT /api/tenant/coupons/:couponId
```

Only the fields you include in the body are updated; omitted fields keep their current value.

```bash
# Disable coupon 2
curl -u admin:Whatever! \
  -X PUT "http://localhost:3000/api/tenant/coupons/2?space=myspace" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": false }'
```

```bash
# Change discount to 30% and extend end date
curl -u admin:Whatever! \
  -X PUT "http://localhost:3000/api/tenant/coupons/2?space=myspace" \
  -H "Content-Type: application/json" \
  -d '{
    "discount_percent": 30,
    "end_date": "2027-06-30T23:59:59.000Z"
  }'
```

Response:

```json
{ "success": true, "message": "Coupon updated successfully" }
```

### Delete Coupon

```
DELETE /api/tenant/coupons/:couponId
```

```bash
curl -u admin:Whatever! \
  -X DELETE "http://localhost:3000/api/tenant/coupons/2?space=myspace"
```

Response:

```json
{ "success": true, "message": "Coupon deleted successfully" }
```

### Validate Coupon (Anonymous)

No authentication required. Returns whether the code is currently valid for the given space.

```
POST /api/spaces/:spaceName/validate-coupon
```

```bash
curl -X POST "http://localhost:3000/api/spaces/myspace/validate-coupon" \
  -H "Content-Type: application/json" \
  -d '{ "code": "LAUNCH50" }'
```

Valid response:

```json
{
  "success": true,
  "valid": true,
  "discount_percent": 50,
  "message": "Coupon valid: 50% discount"
}
```

Invalid/expired response:

```json
{
  "success": true,
  "valid": false,
  "message": "This coupon has expired"
}
```

## Client Usage: Applying a Coupon

A coupon code can be applied at two points in the purchase flow.

### 1. At Quote Time (optional preview)

Append `?coupon=CODE` to the subspace query to see the discounted price before purchasing:

```bash
curl "http://localhost:3000/spaces/myspace/alice?format=json&coupon=LAUNCH50"
```

The response includes the discounted price along with the original:

```json
{
  "handle": "alice@myspace",
  "price": 500,
  "original_price": 1000,
  "coupon_discount_percent": 50,
  "coupon_code": "LAUNCH50",
  "state": "pending",
  "1_block_fee": 12560,
  "6_block_fee": 2768,
  "48_block_fee": 1256,
  "id": 42
}
```

### 2. At Purchase Time (required for discount)

Include `coupon_code` in the POST body. The server re-validates the coupon, applies the discount to `price`, records the coupon on the purchase, and increments usage.

```bash
curl -X POST "http://localhost:3000/spaces/myspace/alice?format=json" \
  -H "Content-Type: application/json" \
  -d '{
    "block_fee": 2768,
    "handle": "alice@myspace",
    "price": 1000,
    "quote_id": 42,
    "conf_target": 6,
    "coupon_code": "LAUNCH50"
  }'
```

Response:

```json
{
  "success": true,
  "taproot_address": "bc1p...",
  "handle": "alice@myspace",
  "total_price": 3268,
  "expiring_blockheight": 890102,
  "purchase_id": 7,
  "job_id": 7,
  "original_price": 1000,
  "discounted_price": 500,
  "discount_percent": 50,
  "coupon_code": "LAUNCH50"
}
```

Note: `total_price` = `block_fee` (2768) + discounted `price` (500) = 3268. The `block_fee` is never reduced.

Without a coupon the same purchase would have `total_price` = 2768 + 1000 = 3768, and no coupon fields appear in the response.

## Discount Calculation

```
discounted_price = floor(price * (100 - discount_percent) / 100)
total_price      = block_fee + discounted_price
```

Examples:

| price | discount_percent | discounted_price | block_fee | total_price |
|---|---|---|---|---|
| 1000 | 25 | 750 | 2768 | 3518 |
| 1000 | 50 | 500 | 2768 | 3268 |
| 1000 | 100 | 0 | 2768 | 2768 |
| 5000 | 10 | 4500 | 12560 | 17060 |

## Validation Rules

A coupon is rejected (at both validation and purchase time) if any of these conditions are true:

1. Code does not exist
2. `enabled` = 0 (disabled via toggle)
3. Current time is before `start_date`
4. Current time is after `end_date`
5. `max_uses` is not null and `current_uses` >= `max_uses`

## Management UI

Navigate to `/tenant-coupons?space=<spaceName>` (linked from the tenant dashboard and configuration pages). The page provides:

- Table of all coupons with status pills (Active, Disabled, Expired, Upcoming, Exhausted)
- Add/Edit form with code, discount percentage, date pickers, max uses (with unlimited toggle), and enabled checkbox
- One-click enable/disable toggle per coupon
- Delete with confirmation
