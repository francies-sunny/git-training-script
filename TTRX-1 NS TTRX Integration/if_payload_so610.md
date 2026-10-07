# `item_fulfillment` test payload — SO610 (16853)

```
POST https://td3113894.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=<WRITE_SCRIPT_ID>&deploy=1
Content-Type: application/json
```

## What the read told us, and what it means for the payload

| Line | Item | Unit | Qty | Eligible | Lot | Bins | Consequence |
|---|---|---|---|---|---|---|---|
| 1 | 718 | Pallet (rate 16) | 1 | **yes** | yes | yes | `bin` **mandatory**, inventory detail mandatory |
| 2 | 721 | Test (rate 1) | 1 | **no** | yes | yes | `bin` optional — but lot detail still mandatory, NetSuite requires it |
| 3 | 719 | Each(1) | 2 | **yes** | yes | yes | `bin` **mandatory**, inventory detail mandatory |

Three things the read is telling you that the payload has to answer:

1. **`default_hold_bin` is `null`** — correct, it is a fulfilment. Stock is being **issued**, so
   there is no fallback bin: only the device knows which bin it picked from. Lines 1 and 3 are
   eligible, so a missing `bin` is `BIN_REQUIRED` and the whole submission is refused.
2. **Line 2 has no `product_uuid` and an empty `product_uuid_missing_reason`** — that is the
   non-eligible case, and nothing is wrong. It is still a real SO line that has to be fulfilled.
3. **Line 1 is in Pallets at a conversion rate of 16.** `quantity` is in the **line's unit** —
   `1` means one pallet. The inventory-detail quantities must add up to the line quantity in the
   same unit, so `1`, not `16`.

---

## 1. Full fulfilment — all three lines

```json
{
  "operation": "item_fulfillment",
  "request_uuid": "3f8c21b6-7d94-4e52-9a10-5b6c7d8e9f01",
  "order_id": "16853",
  "shipment_uuid": "b41e9c77-2a65-4f38-85d0-9c1e2f3a4b5c",
  "transaction_date": "2026-10-05",
  "memo": "SO610 full fulfilment - Postman test",
  "lines": [
    {
      "line_unique_key": "1",
      "item_id": "718",
      "quantity": 1,
      "bin": "REPLACE_BIN_718",
      "inventory": [
        { "lot": "REPLACE_LOT_718", "quantity": 1 }
      ]
    },
    {
      "line_unique_key": "2",
      "item_id": "721",
      "quantity": 1,
      "bin": "REPLACE_BIN_721",
      "inventory": [
        { "lot": "REPLACE_LOT_721", "quantity": 1 }
      ]
    },
    {
      "line_unique_key": "3",
      "item_id": "719",
      "quantity": 2,
      "bin": "REPLACE_BIN_719",
      "inventory": [
        { "lot": "REPLACE_LOT_719", "quantity": 2 }
      ]
    }
  ]
}
```

**Replace five values before sending.** The bins must be the bins at location 13 that actually
hold the stock, and the lots must be lots of that item with quantity on hand there:

```
?operation=bin_contents&location=13&bin=<binId>
?operation=item_availability&location=13&item=718
```

`item_availability` returns one row per lot with its bin, which is both values at once.

## 2. The eligible lines only — line 2 dropped

A line the submission does not name is taken **off** the document, so this fulfils 1 and 3 and
leaves 721 on the order.

```json
{
  "operation": "item_fulfillment",
  "request_uuid": "9d2a4e18-6b37-4c90-a1f5-7e8d0c3b2a46",
  "order_id": "16853",
  "shipment_uuid": "b41e9c77-2a65-4f38-85d0-9c1e2f3a4b5c",
  "transaction_date": "2026-10-05",
  "memo": "SO610 - tracked lines only",
  "lines": [
    { "line_unique_key": "1", "item_id": "718", "quantity": 1,
      "bin": "REPLACE_BIN_718",
      "inventory": [ { "lot": "REPLACE_LOT_718", "quantity": 1 } ] },
    { "line_unique_key": "3", "item_id": "719", "quantity": 2,
      "bin": "REPLACE_BIN_719",
      "inventory": [ { "lot": "REPLACE_LOT_719", "quantity": 2 } ] }
  ]
}
```

## 3. Short pick — the exception path

Line 3 wants 2 and only 1 is on the shelf. **An eligible line that comes up short must carry
`exception_reason`**, or the submission is refused with `EXCEPTION_REASON_REQUIRED`.

```json
{
  "operation": "item_fulfillment",
  "request_uuid": "c5b8f207-41d6-4a93-b2e7-0f8a6d5c4e31",
  "order_id": "16853",
  "shipment_uuid": "b41e9c77-2a65-4f38-85d0-9c1e2f3a4b5c",
  "transaction_date": "2026-10-05",
  "memo": "SO610 - short on 719",
  "lines": [
    { "line_unique_key": "1", "item_id": "718", "quantity": 1,
      "bin": "REPLACE_BIN_718",
      "inventory": [ { "lot": "REPLACE_LOT_718", "quantity": 1 } ] },
    { "line_unique_key": "3", "item_id": "719", "quantity": 1,
      "bin": "REPLACE_BIN_719",
      "exception_reason": "Short stock at the bin",
      "exception_note": "One unit damaged in the bin, quarantined",
      "inventory": [ { "lot": "REPLACE_LOT_719", "quantity": 1 } ] }
  ]
}
```

Expected answer — a **success** that names what did not go:

```json
{
  "success": true,
  "internal_id": "<new IF>",
  "external_id": "c5b8f207-41d6-4a93-b2e7-0f8a6d5c4e31",
  "lines_posted": 2,
  "shipping_status": "Shipped",
  "exception_quantity": 1,
  "exception_lines": [
    { "line_unique_key": "3", "item_id": "719", "exception_quantity": 1,
      "exception_reason": "Short stock at the bin",
      "exception_note": "One unit damaged in the bin, quarantined" }
  ]
}
```

`exception_quantity` is written to `custcol_jj_rb_exception_qty` on line 3 and totalled into
`custbody_jj_rb_exception_qty` on the fulfilment. Lines that went in full are stamped **0**, not
left blank.

Valid `exception_reason` values come from `?operation=fulfilment_exceptions` — send one of those,
not free text.

---

## Negative tests worth running

| Change | Expected |
|---|---|
| Drop `bin` from line 1 | `BIN_REQUIRED` — "only the device knows where it came from". Whole submission refused |
| Drop `bin` from line 2 only | **Succeeds.** 721 is not eligible, so NetSuite's own default stands |
| Line 3 quantity 1 with no `exception_reason` | `EXCEPTION_REASON_REQUIRED` |
| Drop `inventory` from line 1 | `INVENTORY_DETAIL_MISSING` — the item is lot tracked |
| Line 1 `quantity: 2` | `QTY_EXCEEDS_REMAINING` — only 1 pallet is outstanding |
| Line 1 `quantity: 1`, inventory `quantity: 16` | `BAD_QUANTITY` — the detail must add up to the line, in the line's unit |
| Resend the same `request_uuid` | `success: true`, `duplicate: true`, the same `internal_id`. No second fulfilment |
| `line_unique_key: "4"` | `LINE_NOT_ON_ORDER` |

## No release for a fulfilment

`inventory_release` is the last step of a **receipt** — it moves received stock out of an on-hold
bin once TrackTraceRX verifies it. A fulfilment issues stock out of the account; there is nothing
to hold and nothing to release. Do not send one for SO610.
