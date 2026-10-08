# `inventory_release` — POST payload

```
POST https://td3113894.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=<WRITE_SCRIPT_ID>&deploy=1
Content-Type: application/json
```

Same script and deployment as `item_receipt` — `jj_rl_rb_write.js`. The operation is a body key,
not a path.

> **The Item Receipt reference is MANDATORY.** Send `item_receipt_internal_id`, or a
> `shipment_uuid` that resolves to one. The receipt carries the **release ledger**
> (`custbody_jj_rb_release_log`) — received and released per lot — and that ledger is what stops
> a retry moving the same stock twice. Without it the release is refused.

---

## 1. The normal case — full release of one lot

```json
{
  "operation": "inventory_release",
  "request_uuid": "f7c1a2b3-4d5e-4f60-8a1b-2c3d4e5f6071",
  "order_id": "16050",
  "item_receipt_internal_id": "2481003",
  "shipment_uuid": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "location_id": "13",
  "from_bin": "77",
  "to_bin": "88",
  "transaction_date": "2026-10-05",
  "memo": "EPCIS verification passed - PO447",
  "lines": [
    {
      "line_unique_key": "1",
      "item_id": "718",
      "lot": "LOT-2026-0815",
      "quantity": 24
    }
  ]
}
```

## 2. The smallest thing that works

Bins and location come from the Location record (`custrecord_jj_rb_loc_onhold_bin`,
`custrecord_jj_rb_loc_good_bin`), falling back to the configuration's default bin.

```json
{
  "operation": "inventory_release",
  "request_uuid": "6b0e4f42-9d31-4a0c-8f57-2a1d6c9e3b80",
  "order_id": "16050",
  "item_receipt_internal_id": "2481003",
  "lines": [
    { "line_unique_key": "1", "item_id": "718", "lot": "LOT-2026-0815", "quantity": 24 }
  ]
}
```

## 3. Partial release — 20 passed, 4 damaged

```json
{
  "operation": "inventory_release",
  "request_uuid": "2c7f9a10-33b8-4f9e-9a52-0d4e8b1c7f33",
  "order_id": "16050",
  "item_receipt_internal_id": "2481003",
  "lines": [
    { "line_unique_key": "1", "item_id": "718", "lot": "LOT-2026-0815", "quantity": 20 }
  ]
}
```

The other 4 stay in the on-hold bin. The Sync Log row for this call is left **open**.

## 4. Several lots, several items, per-line bins

```json
{
  "operation": "inventory_release",
  "request_uuid": "8a41dd0e-7c52-4b19-a6f0-5e3b2c81d947",
  "order_id": "16050",
  "item_receipt_internal_id": "2481003",
  "location_id": "13",
  "from_bin": "77",
  "to_bin": "88",
  "transaction_date": "2026-10-05",
  "memo": "Verification batch 2026-10-05-A",
  "lines": [
    { "line_unique_key": "1", "item_id": "718", "lot": "LOT-2026-0815", "quantity": 24 },
    { "line_unique_key": "2", "item_id": "718", "lot": "LOT-2026-0901", "quantity": 10 },
    { "line_unique_key": "3", "item_id": "719", "lot": "LOT-2026-0912", "quantity": 6,
      "to_bin": "89" }
  ]
}
```

Two lots of item 718 become **one** `inventory` sublist line with **two** inventory assignments.

---

## Fields

| Field | Required | |
|---|---|---|
| `operation` | **yes** | `inventory_release` |
| `request_uuid` | **yes** | The duplicate guard. Becomes the Bin Transfer's native `externalid`. A repeat is answered with the transfer that already exists, as a **success**, and nothing moves twice |
| `order_id` | no | The purchase order. Validated if sent; supplies the location |
| `item_receipt_internal_id` | **yes*** | Carries the release ledger. **The release is refused without a receipt** |
| `shipment_uuid` | **yes*** | Used to find the receipt when its internal id is not sent |
| `location_id` | no | A Bin Transfer **cannot cross locations**. Taken from the order or the receipt when absent |
| `from_bin` · `hold_bin` | no | The on-hold bin, by **internal id**. Payload → the **Location's On-Hold Bin** → the config Default Bin. Usually left out: the receipt already put the stock there and the location knows where |
| **`good_bin`** | no | **The destination, and the decision this call exists to carry.** Payload → the **Location's Good Bin**. `to_bin` is accepted as the older spelling. **No fallback to the config Default Bin** — that is the RECEIVING default, and releasing into it would put verified stock back where it came from |
| `transaction_date` | no | `YYYY-MM-DD` or `DD/MM/YYYY`. Today otherwise |
| `memo` | no | Defaults to `RapidBridge inventory release <request_uuid>` |
| `lines[].line_unique_key` | no | Echoed back on success and on failure, so the Middleware can point at the right line |
| `lines[].item_id` | **yes** | Internal id |
| `lines[].lot` | **yes** for a lot/serial item | **The NAME**, as TrackTrace prints it. Also accepted as `lot_number` or `lot_name`. Matched case-insensitively and trimmed, against that item's **on-hand** inventory numbers only |
| `lines[].quantity` | **yes** | Must be > 0 and must not exceed what the from-bin actually holds |
| `lines[].good_bin` · `from_bin` | no | Per-line override of the header bins. `to_bin` / `hold_bin` accepted as the older spellings |

\* **one of the two is required.** The ledger lives on the receipt, and without it there is no
guard against a second call moving stock the first already moved.

---

## Success

```json
{
  "success": true,
  "bin_transfer_internal_id": "2492118",
  "external_id": "f7c1a2b3-4d5e-4f60-8a1b-2c3d4e5f6071",
  "item_receipt_internal_id": "2481003",
  "order_id": "16050",
  "location_id": "13",
  "from_bin": "77",
  "to_bin": "88",
  "moved_quantity": 24,
  "released_quantity": 24,
  "received_quantity": 34,
  "held_quantity": 10,
  "fully_released": false,
  "lines_released": [
    {
      "line_unique_key": "1",
      "item_id": "718",
      "lot": "LOT-2026-0815",
      "lot_internal_id": "901",
      "quantity": 24,
      "released_to_date": 24,
      "received": 24,
      "from_bin": "77",
      "to_bin": "88"
    }
  ]
}
```

| | |
|---|---|
| `moved_quantity` | **This call** |
| `released_quantity` · `received_quantity` · `held_quantity` | **The receipt**, cumulatively, from the ledger |
| `fully_released` | `held_quantity === 0`. Only then does the Sync Log row close |

A retry of the same `request_uuid` — caught by the external id **or** by the ledger:

```json
{ "success": true, "bin_transfer_internal_id": "2492118",
  "external_id": "f7c1a2b3-4d5e-4f60-8a1b-2c3d4e5f6071", "duplicate": true,
  "released_quantity": 24, "held_quantity": 10 }
```

A retry carrying a **new** `request_uuid` for stock already released — the case the external id
cannot see:

```json
{
  "success": false,
  "error_code": "LINE_VALIDATION_FAILED",
  "failed_lines": [
    { "line_unique_key": "1", "error_code": "ALREADY_RELEASED",
      "error_message": "All 24 of lot \"LOT-2026-0815\" of Amoxicillin 500mg Tablet (718) received on Item Receipt 2481003 has already been released. This call would move it a second time. If stock genuinely needs moving again, it is a bin transfer somebody makes in NetSuite, not a release." }
  ]
}
```

## Refusals

**All or nothing.** One bad line rejects the whole release and nothing moves — the stock stays in
the on-hold bin, which is the safe place for it.

```json
{
  "success": false,
  "error_code": "LINE_VALIDATION_FAILED",
  "error_message": "1 of 2 release line(s) failed validation, so NOTHING was moved. The stock is still in the on-hold bin. Correct the cause and resubmit with a new request_uuid.",
  "failed_lines": [
    {
      "line_unique_key": "2",
      "error_code": "LOT_NOT_IN_BIN",
      "error_message": "Lot \"LOT-2026-0901\" of Amoxicillin 500mg Tablet (718) has nothing on hand in bin 77. Either it was already released, or somebody moved it by hand. The release will not guess where it went - find it first."
    }
  ]
}
```

| Line code | |
|---|---|
| `LOT_NOT_FOUND` | The name is not an on-hand lot of that item. **The release never creates a lot** |
| `LOT_NOT_ON_RECEIPT` | The lot may be real and sitting in that very bin — **put there by a different receipt**. Several receipts share one on-hold bin |
| `ALREADY_RELEASED` | Everything this receipt received of that lot has gone. The commonest shape of a duplicate call |
| `QTY_EXCEEDS_RECEIVED` | Names received, already released, and what is still releasable |
| `LOT_NOT_IN_BIN` | The ledger says it is unreleased but the bin does not hold it. Somebody moved it by hand. Refused, never redirected |
| `QTY_EXCEEDS_IN_BIN` | Some is physically there, not all |
| `BIN_NOT_CONFIGURED` | No source bin, or no `good_bin` in the payload **and** no Good Bin on the location; or both bins the same |
| `BAD_QUANTITY` · `ITEM_NOT_FOUND` · `ITEM_INACTIVE` · `LOT_INVALID` | As on a receipt |

The first four come from the **ledger** and the next two from `inventorybalance`. When the balance
search returns **no rows at all** it is treated as a stale index rather than missing stock, and
the release proceeds with an audit line — `inventorybalance` is an index, and a release called
seconds after its receipt can legitimately read nothing.

| Document code | |
|---|---|
| `MISSING_REQUEST_UUID` · `MALFORMED_PAYLOAD` · `FLOW_DISABLED` | |
| `ORDER_NOT_FOUND` | `order_id` was sent and no such purchase order exists |
| `RECEIPT_NOT_IDENTIFIED` | No `item_receipt_internal_id`, and no `shipment_uuid` that matches one. The receipt carries the ledger |
| `RECEIPT_NOT_READABLE` | The receipt was found and its lot detail could not be read, or its ledger is not valid JSON. **A corrupt ledger refuses the release** rather than resetting — a clean slate is what a duplicate call wants |
| `LINE_VALIDATION_FAILED` · `NOTHING_TO_RELEASE` | |
| `PERIOD_LOCKED` · `SAVE_REFUSED` | NetSuite refused the Bin Transfer itself |

---

## Before the first call

1. Deploy the five new body fields — `custbody_jj_rb_released_qty`,
   `custbody_jj_rb_held_qty`, `custbody_jj_rb_released_at`, `custbody_jj_rb_bin_transfer` and
   **`custbody_jj_rb_release_log`** (Long Text — the ledger; nothing works without it).
2. Set **On-Hold Bin** and **Good Bin** on the Location record, or send `from_bin` / `to_bin`.
3. Have a receipt whose stock is in the on-hold bin, and the exact lot name NetSuite holds —
   `fetch_transaction` does not return it, so read it off the receipt's inventory detail or an
   Inventory Balance saved search for the hold bin.
