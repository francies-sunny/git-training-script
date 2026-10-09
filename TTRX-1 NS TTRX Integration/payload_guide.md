# RapidBridge — Payload Guide

Every endpoint, its method, the body it takes and the answer it gives.
Code state: **Pass 35**. For the reasoning behind any of it, see `expected_payload.md`.

Replace `https://api.tracktraceweb.com/2.0` and `https://td3113894.restlets.api.netsuite.com` with
the account's own domains before use.

---

# Authentication

- **NetSuite → Middleware:** API Key.
- **Middleware → NetSuite:** OAuth 2.0 — JWT Bearer Grant (machine-to-machine; no client secret).
  ECDSA signatures must be **RAW `r‖s`**, not DER.

---

# Conventions

- **No key is ever omitted** on an outbound body. A value with nothing behind it is `""`.
- Default encoding is `application/x-www-form-urlencoded`; objects and arrays are JSON-stringified,
  booleans become `"true"` / `"false"`. JSON is used only when the Configuration's Content Type says
  so.
- Every inbound call answers **HTTP 200**. Branch on `success`, never on the status code.
- Inbound operation names are **exact and case-sensitive**. Note `item_fulfillment` (two `l`s) but
  `fulfilment_exceptions` (one).

---

# Master Data Sync  (NetSuite → Middleware)

## Dosage Form

- Create: `POST https://api.tracktraceweb.com/2.0/products/pharmaceutical/dosage_forms`
- Update: `PUT  https://api.tracktraceweb.com/2.0/products/pharmaceutical/dosage_forms/{{uuid}}`
- Delete: `DELETE .../dosage_forms/{{uuid}}`
- Payload:

```
{
  "code": "TAB",                                                      // custrecord_jj_rb_df_code
  "name": "Tablet",
  "is_active": true
}
```

> No `custom_uuid` on this body — the only master record without one. The UUID travels in the URL.
> Gated by **Use Dosage Form** on the Configuration.

## Location

- Create: `POST https://api.tracktraceweb.com/2.0/locations`
- Update: `PUT  https://api.tracktraceweb.com/2.0/locations/{{uuid}}`
- Delete: `DELETE https://api.tracktraceweb.com/2.0/locations/{{uuid}}`
- Payload:

```
{
  "custom_uuid": "",                                                  // Empty on create; the TrackTrace UUID on every later call
  "name": "Main Warehouse",
  "gs1_id": "abc123",
  "gs1_sgln": "test123",
  "parent_location_uuid": "",                                         // Parent Location's UUID; parent is pre-synced first
  "location_detail": "2",                                             // NetSuite locationtype INTERNAL ID, not the label
  "is_unselectable_location": false,                                  // Always false
  "manufacturing_location_prefix_or_suffix_id_value": "",             // Always empty
  "location_lat": "56.998855",
  "location_long": "-101.027169",
  "is_active": true,
  "create_default_storage_area": true                                 // Currently always true - see note
}
```

> The address is **not** in this body; it is its own call. `create_default_storage_area` was meant
> to be conditional on a first send in a non-bin-managed account; that condition is commented out.
> **Confirm before go-live** whether a bin-managed account should still send `true`.

## Address  (Customer, Vendor and Location all use this body)

- Partner create: `POST https://api.tracktraceweb.com/2.0/trading_partners/{{uuid}}/addresses`
- Partner update: `PUT  .../trading_partners/{{uuid}}/addresses/{{address_uuid}}`
- Location create: `POST https://api.tracktraceweb.com/2.0/locations/{{uuid}}/addresses`
- Location update: `PUT  .../locations/{{uuid}}/addresses/{{address_uuid}}`
- Payload:

```
{
  "address_nickname": "Test A BCD Label",                             // Address Label; 'Address N' by line when unlabelled; 'Main Address' for a location
  "address_gs1_id": "",                                               // Always empty - no NetSuite field exists
  "gs1_sgln": "1234123412341234",                                     // custrecord_jj_rb_addr_sgln on the address subrecord
  "recipient_name": "Test A BCD Addressee",                           // Addressee, falling back to the parent record name
  "line1": "Address 1",
  "line2": "Address 2",
  "country_code": "US",
  "state": "NJ",                                                      // FREE TEXT as the record spells it - there is no state_id
  "city": "City",
  "zip": "08901",
  "phone": "1231231231",                                              // The address subrecord's phone, NOT the entity's
  "is_licence_required": false                                        // Always false (British spelling)
}
```

> An address line with no line1, no city **and** no zip is skipped entirely. Gated by **Use
> Address**, capped at **Max Inline Calls** (default 5) per save.
> The two address DELETE paths are **inferred**, not observed — confirm with TrackTraceRX.

## Customer

- Create: `POST https://api.tracktraceweb.com/2.0/trading_partners`
- Update: `PUT  https://api.tracktraceweb.com/2.0/trading_partners/{{uuid}}`
- Payload:

```
{
  "custom_uuid": "",                                                  // Empty on create
  "name": "Acme Pharma Inc",                                          // Person: altname then companyname. Company: companyname then altname. Then entityid
  "gs1_id": "0312345",                                                // custentity_jj_rb_gln
  "gs1_company_id": "",                                               // Always empty
  "gs1_sgln": "",                                                     // Always empty
  "type": "CUSTOMER",
  "parent_tp_uuid": "",                                               // Parent customer's UUID; customers only
  "customer_id": "CUST-1001",                                         // NetSuite entityid
  "friendly_name": "",                                                // Always empty
  "default_billing_address_uuid": "24530340-c9c8-4ade-a08d-921df2f8c903",
  "default_shipping_address_uuid": "24530340-c9c8-4ade-a08d-921df2f8c903",
  "phone": "212-555-0100",
  "phone_ext": "",                                                    // Always empty
  "notification_email": "ap@acme.example",
  "new_trx_notification_type": "ALL",                                 // Always 'ALL'
  "flag_notification_name": "",                                       // Always empty
  "flag_notification_email": "",                                      // Always empty
  "flag_notification_phone": "",                                      // Always empty
  "flag_notification_phone_ext": "",                                  // Always empty
  "external_reference": "4721",                                       // NetSuite internal id
  "is_active": true,
  "inbound_shipping_check_percentage": "",                            // Always empty
  "outbound_shipping_check_percentage": "",                           // Always empty
  "sender_id": "",                                                    // Always empty
  "receiver_id": "",                                                  // Always empty
  "as2_id": "",                                                       // Always empty
  "is_a_3pl_client": false,                                           // Always false
  "3pl_is_our_company_is_internal_entity_of_tp": false,               // Always false
  "is_send_outbond_epcis": false,                                     // Always false - note spelling 'outbond'
  "is_send_outbond_x12": false,                                       // Always false - note spelling 'outbond'
  "default_outbound_transaction_type": "SALES",                       // Always 'SALES'
  "send_copy_outbound_shipment_external_trading_entity_id": "",       // Always empty
  "outbound_epcis_generator_type": "",                                // Always empty
  "is_enable_transmit_outbound_850": "",                              // Always an EMPTY STRING, not false
  "omit_comm_aggr_in_epcis": false                                    // Always false
}
```

## Vendor

Same endpoint and the same 35 keys as Customer. Two differences:

```
{
  "type": "VENDOR",
  "parent_tp_uuid": "",                                               // ALWAYS empty - a vendor has no parent field in NetSuite
  "customer_id": "VEND-2002"                                          // The key is still 'customer_id' on a vendor
}
```

## Item / UOM Detail

**One call per active UOM Detail row.** An item with Each, Bottle and Case is three products, each
with its own `custom_uuid`.

- Create: `POST https://api.tracktraceweb.com/2.0/products`
- Update: `PUT  https://api.tracktraceweb.com/2.0/products/{{uuid}}`
- Payload:

```
{
  "custom_uuid": "",                                                  // The UOM ROW's UUID, not the item's. Empty on create
  "type": "Pharmaceutical",                                           // From config, default 'Pharmaceutical'
  "gs1_company_prefix": "0300026",
  "gs1_id": "014511",
  "upc": "00300026145113",                                            // UOM Detail UPC, falling back to the item UPC
  "sku": "Test Lot Inventory Item 3",                                 // NetSuite Item ID (NOT the NDC)
  "type_class": "",                                                   // Always empty
  "category_id": "",                                                  // Always empty
  "status": "AVAILABLE",                                              // 'RETIRED' when the item is inactive
  "manufacturer_id": "",                                              // Always empty
  "manufacturer_default_address_uuid": "",                            // Always empty
  "is_active": true,
  "update_product_descriptions": true,                                // Always true
  "product_descriptions": [
    {
      "language_code": "en",                                          // From config, default 'en'
      "name": "Baqsimi 3 mg Powder",                                  // Display Name, falling back to Item ID
      "description": "Baqsimi 3 mg Powder",                           // Purchase Description, then Display Name, then Item ID
      "composition": "",                                              // Always empty - NOT the top-level composition
      "product_long_name": "Baqsimi 3 mg Powder"                      // Purchase Description
    }
  ],
  "update_product_identifiers": true,                                 // True only when the UOM row has an NDC
  "product_identifiers": [
    {
      "identifier_code": "US_NDC",                                    // Always 'US_NDC'
      "value": "00002614511"                                          // UOM Detail NDC
    }
  ],
  "pack_size": "100",                                                 // UOM Detail Pack Size
  "pack_size_type_id": "5",                                           // Pack Size Map on config, keyed on Saleable Unit. Unmapped falls back to '1'
  "update_requirements": false,                                       // Always false
  "update_packaging": false,                                          // Always false
  "class_pharmaceutical__strength": "3MG",                            // Double underscore
  "class_pharmaceutical__dosage_form": "POWDER",                      // Dosage Form CODE, not its name or internal id
  "class_pharmaceutical__generic_name": "BAQSIMI 3MG PWD",
  "is_leaf_product": false,                                           // True only when pack_size_type_id is '1'
  "is_override_products_packaging_type_validation": false,            // Always false
  "gtin14": "00300026145113",
  "update_composition": true,                                         // True only when composition is not empty - true with an empty composition REMOVES it
  "composition": "[{\"238133c2-6039-4a0c-9a57-dd94e227e1cc\":\"20\"}]", // A JSON-ENCODED STRING: [{ base unit product UUID: qty in lowest unit }]. Empty on a base row
  "is_bin_managed": false,                                            // NetSuite Bin feature AND config Use Bins AND item Use Bins
  "bin_feature_enabled": true                                         // NetSuite Bin Management feature in effect
}
```

## Bin → Storage Area

- Create: `POST https://api.tracktraceweb.com/2.0/locations/{{locationUuid}}/storage_areas`
- Update: `PUT  .../locations/{{locationUuid}}/storage_areas/{{uuid}}`
- Delete: `DELETE .../locations/{{locationUuid}}/storage_areas/{{uuid}}`
- Payload:

```
{
  "custom_uuid": "",                                                  // Empty on create
  "name": "Test Hold Bin 1",                                          // binnumber
  "properties": "COLD;FROZEN",                                        // SEMICOLON-SEPARATED STRING. '' when none. Never an array
  "is_active": true,
  "code": "Quarantine hold, dock 3"                                   // The bin's memo - NetSuite has no code field on a Bin
}
```

> **`is_storage_conditions_verification_disabled` is deliberately NOT sent** — pending
> TrackTraceRX confirming their default for a bin that omits it.
>
> **The location is not in the body** — it is a path segment, and the Location is pre-synced first.
> `properties` values are upper-cased with spaces/hyphens turned into underscores, forced into the
> order `COLD;FROZEN;RESTRICTED_ACCESS`. An unrecognised value **refuses the sync** and spends no
> API call.

## Inactivation and deletion

| Configuration **Inactive Method** | What is sent                                  |
| --------------------------------- | --------------------------------------------- |
| `PUT_IS_ACTIVE_FALSE` *(default)* | the full body again with `"is_active": false` |
| `DELETE`                          | `DELETE {endpoint}/{{uuid}}`, **no body**     |

A real NetSuite record delete always uses the DELETE endpoint whatever the setting says.

---

# Transaction Sync  (NetSuite → Middleware)

## Purchase Order Create / Update

- Create: `POST https://api.tracktraceweb.com/2.0/transactions/purchase`
- Update: `PUT  https://api.tracktraceweb.com/2.0/transactions/purchase/{{uuid}}`
- Payload — **16 keys**:

```
{
  "transaction_uuid": "f4efb87c-e483-4f31-b91c-dcfe21382bb6",         // Empty on create
  "custom_id": "PO446",                                               // tranid
  "location_uuid": "800930e8-1609-4b50-a8ef-929088f89a11",            // Blank BLOCKS the send
  "trading_partner_uuid": "358a9c44-48c1-47a2-833d-8bf1970ad350",     // The VENDOR. Blank BLOCKS the send
  "transaction_date": "2026-09-28",                                   // YYYY-MM-DD
  "billing_address_uuid": "ac519f3d-0f02-46db-9b1f-5a410104f56f",     // PO: the LOCATION's address
  "ship_from_address_uuid": "7b2c1d9e-4a6f-4c88-9e10-2d3f4a5b6c7d",   // PO: the VENDOR's shipping address
  "ship_to_address_uuid": "ac519f3d-0f02-46db-9b1f-5a410104f56f",     // PO: the LOCATION's address
  "sold_by_address_uuid": "7b2c1d9e-4a6f-4c88-9e10-2d3f4a5b6c7d",     // PO: the VENDOR's billing address
  "line_items": [
    {
      "product_uuid": "c427a199-a6e2-472a-9f3f-36706c00358c",         // The UOM row matching THIS LINE's unit
      "quantity": 1,                                                  // In the line's OWN unit, not base units
      "sort_order": "1"                                               // A STRING - the NetSuite line number
    }
  ],
  "is_approved": true,                                                // Always true
  "is_approved_is_ship_transaction": false,                           // ALWAYS false - a partial fulfilment would leave a phantom shipment
  "is_manually_close_transaction": false,                             // True only on a close call
  "enforce_oci": false,                                               // Always false
  "order_nbr": "PO446",                                               // tranid
  "po_nbr": "PO446"                                                   // tranid - same value as custom_id and order_nbr
}
```

> `line_items` is **JSON-stringified** on the wire under the default form encoding.
> A line travels only when it is eligible, not closed, and quantity > 0.

## Sales Order Create / Update

- Create: `POST https://api.tracktraceweb.com/2.0/transactions/sales`
- Update: `PUT  https://api.tracktraceweb.com/2.0/transactions/sales/{{uuid}}`
- Payload — the same 16 keys **plus one, last**, and the four address roles are **reversed**:

```
{
  "transaction_uuid": "",
  "custom_id": "SO609",
  "location_uuid": "57841bd1-5bd4-43cc-b5f6-17f85717a712",
  "trading_partner_uuid": "b4720a62-dd54-481a-83e2-d4f6ebaf9c66",     // The CUSTOMER
  "transaction_date": "2026-09-30",
  "billing_address_uuid": "24530340-c9c8-4ade-a08d-921df2f8c903",     // SO: the CUSTOMER's billing address
  "ship_from_address_uuid": "9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f",   // SO: the LOCATION's address
  "ship_to_address_uuid": "24530340-c9c8-4ade-a08d-921df2f8c903",     // SO: the CUSTOMER's shipping address
  "sold_by_address_uuid": "9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f",     // SO: the LOCATION's address
  "line_items": [
    { "product_uuid": "431aac76-0506-4e3c-a5b1-5c16a2822f30", "quantity": 1, "sort_order": "1" }
  ],
  "is_approved": true,
  "is_approved_is_ship_transaction": false,
  "is_manually_close_transaction": false,
  "enforce_oci": false,
  "order_nbr": "SO609",
  "po_nbr": "SO609",
  "outbound_transaction_sub_type": "SALES"                            // SALES ORDERS ONLY - the key is absent on a PO
}
```

**The address roles, side by side:**

| Key                      | Sales Order             | Purchase Order        |
| ------------------------ | ----------------------- | --------------------- |
| `billing_address_uuid`   | the customer's billing  | the location's        |
| `ship_to_address_uuid`   | the customer's shipping | the location's        |
| `ship_from_address_uuid` | the location's          | the vendor's shipping |
| `sold_by_address_uuid`   | the location's          | the vendor's billing  |

## Close / Cancel / Void

Configuration **Close Action** decides which:

| Close Action              | Call                                              | Body                                                                                                             |
| ------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `MARK_CLOSED` *(default)* | `PUT /transactions/{sales\|purchase}/{{uuid}}`    | the **last accepted payload replayed**, with `is_manually_close_transaction: true` and `transaction_uuid` re-set |
| `DELETE`                  | `DELETE /transactions/{sales\|purchase}/{{uuid}}` | none                                                                                                             |
| `NONE`                    | no call                                           | —                                                                                                                |

> A `MARK_CLOSED` body is **not rebuilt** from the order — a closed order's lines are all closed, so
> a fresh build would send an empty `line_items` and the update is a full replace. If the stored
> payload is missing, **no call is made** and a review item is opened.
>
> Before any DELETE the SuiteApp calls `GET /transactions/{type}/{{uuid}}` and **refuses the void if
> any shipment exists**. If that read fails for any reason, the void is refused rather than assumed
> safe.

---

# Write APIs  (Middleware → NetSuite)

All four use the same RESTlet:

```
https://td3113894.restlets.api.netsuite.com/app/site/hosting/restlet.nl
  ?script=customscript_jj_rl_rb_write&deploy=customdeploy_jj_rl_rb_write
```

## Item Receipt

- Method: **POST**
- Payload:

```
{
  "operation": "item_receipt",
  "request_uuid": "11111111-2222-3333-4444-555555555564",             // REQUIRED. Becomes the record's externalId - the duplicate guard
  "order_id": "17054",                                                // REQUIRED. The Purchase Order internal id
  "shipment_uuid": "bed3beeb-d64e-43eb-aeaa-fdf1802ccfa2",            // Optional here; the identifier call can supply it later
  "transaction_date": "2026-10-07",
  "memo": "Postman test receipt for PO449",
  "hold_bin": "49",                                                   // Optional. The whole submission's hold bin
  "good_bin": "50",                                                   // Optional. RECORDED for the release, never used now
  "lines": [
    {
      "line_unique_key": "2",                                         // REQUIRED. The order's orderline value
      "item_id": "719",
      "quantity": 4,                                                  // REQUIRED. May not exceed what the order line has outstanding
      "bin": "49",                                                    // Optional line-level hold bin
      "good_bin": "50",                                               // Optional line-level good bin
      "inventory": [
        {
          "lot": "LOT-719-A",
          "expiry": "2027-06-30",
          "quantity": 3,
          "bin": "49",                                                // THIS LOT's hold bin - two lots on one line may go to two bins
          "good_bin": "50"                                            // THIS LOT's release destination
        },
        {
          "lot": "LOT-719-B",
          "expiry": "2028-01-31",
          "quantity": 1,
          "bin": "48",
          "good_bin": "51"
        }
      ]
    }
  ]
}
```

- Response:

```
{
  "success": true,
  "internal_id": "16453",
  "external_id": "11111111-2222-3333-4444-555555555564",
  "lines_posted": 1,
  "exception_quantity": 0,
  "exception_lines": []
}
```

**The hold bin ladder**, for a receipt:

| Item                                  | Ladder                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Eligible** (TrackTraceRX tracks it) | row `bin` → line `bin` → body `bin` → Location **On-Hold Bin** → config **Default Bin**    |
| **Non-eligible**                      | row `bin` → line `bin` → body `bin` → row/line/body **`good_bin`** → Location **Good Bin** |

A non-tracked item is never released, so it must not sit in the on-hold bin. The config Default Bin
is not on that path — it is the receiving default. Running out, on an item that uses bins, is
`BIN_REQUIRED`.

**A short line is not an exception.** Send `exception_reason` (a **name** from
`fulfilment_exceptions`) only when there is a real discrepancy; `exception_quantity` then defaults
to the full shortfall.

## Item Fulfillment

- Method: **POST**
- Payload — same shape; **no `good_bin` anywhere**, and `bin` has no default at all:

```
{
  "operation": "item_fulfillment",
  "request_uuid": "3f8c21b6-7d94-4e52-9a10-5b6c7d8e9f01",
  "order_id": "16853",
  "shipment_uuid": "b41e9c77-2a65-4f38-85d0-9c1e2f3a4b5c",
  "transaction_date": "2026-10-05",
  "memo": "SO610 full fulfilment",
  "lines": [
    {
      "line_unique_key": "1",
      "item_id": "718",
      "quantity": 1,
      "bin": "50",                                                    // The bin the stock was PICKED FROM. No default - only the device knows
      "inventory": [ { "lot": "LOT-718-A", "quantity": 1 } ]
    },
    {
      "line_unique_key": "3",
      "item_id": "719",
      "quantity": 2,
      "inventory": [
        { "lot": "LOT-719-A", "quantity": 1, "bin": "50" },
        { "lot": "LOT-719-B", "quantity": 1, "bin": "51" }
      ]
    }
  ]
}
```

- Response — one extra key:

```
{
  "success": true,
  "internal_id": "16954",
  "external_id": "3f8c21b6-7d94-4e52-9a10-5b6c7d8e9f01",
  "lines_posted": 2,
  "exception_quantity": 0,
  "exception_lines": [],
  "shipping_status": "Shipped"                                        // From the Configuration: Picked, Packed or Shipped
}
```

## Identifier  (call 2 of the two-call protocol)

- Method: **PUT**
- Payload:

```
{
  "operation": "identifier",
  "request_uuid": "11111111-2222-3333-4444-555555555564",             // Finds the record by its externalId
  "shipment_uuid": "bed3beeb-d64e-43eb-aeaa-fdf1802ccfa2",            // REQUIRED. 'tracktrace_uuid' and 'uuid' also accepted
  "record_type": "itemreceipt",                                       // Optional. 'itemreceipt' or 'itemfulfillment'; defaults to the receipt
  "internal_id": "16453"                                              // Optional alternative to request_uuid
}
```

- Response:

```
{
  "success": true,
  "internal_id": "16453",
  "external_id": "11111111-2222-3333-4444-555555555564",
  "shipment_uuid": "bed3beeb-d64e-43eb-aeaa-fdf1802ccfa2"
}
```

> **No uniqueness check on `shipment_uuid`, deliberately.** One shipment covering three purchase
> orders produces three receipts that all carry its UUID, and every one is correct.

## Inventory Release  (the Bin Transfer)

- Method: **POST**
- Payload — **the ordinary case carries no bins at all**; the receipt already knows them:

```
{
  "operation": "inventory_release",
  "request_uuid": "f7c1a2b3-4d5e-4f60-8a1b-2c3d4e5f6071",             // REQUIRED. Becomes the Bin Transfer's externalId
  "order_id": "16050",                                                // Optional. Supplies the location
  "item_receipt_internal_id": "2481003",                              // REQUIRED in effect - the receipt carries the release ledger
  "transaction_date": "2026-10-08",
  "memo": "TrackTraceRX verification passed",
  "lines": [
    {
      "line_unique_key": "1",
      "item_id": "718",                                               // Must be ELIGIBLE - a non-tracked item was never held
      "lot": "LOT-2026-0815",                                         // The lot NAME; trimmed, matched case-insensitively
      "quantity": 24                                                  // May not exceed what this receipt has left to release
    },
    { "line_unique_key": "2", "item_id": "718", "lot": "LOT-2026-0901", "quantity": 10 }
  ]
}
```

- Overriding the bins:

```
{
  "operation": "inventory_release",
  "request_uuid": "a1b2c3d4-0000-4000-8000-000000000002",
  "item_receipt_internal_id": "2481003",
  "from_bin": "77",                                                   // Optional. 'hold_bin' also accepted
  "good_bin": "95",                                                   // Optional. 'to_bin' also accepted
  "lines": [
    { "line_unique_key": "1", "item_id": "718", "lot": "LOT-A", "quantity": 24 },
    { "line_unique_key": "2", "item_id": "718", "lot": "LOT-B", "quantity": 10,
      "good_bin": "96" }                                              // Line override beats the body
  ]
}
```

- A lot the receipt **split** across two good bins — release each part with the quantity the receipt
  recorded, and the bins resolve themselves:

```
{
  "operation": "inventory_release",
  "request_uuid": "a1b2c3d4-0000-4000-8000-000000000003",
  "item_receipt_internal_id": "2481003",
  "lines": [
    { "line_unique_key": "1", "item_id": "718", "lot": "LOT-A", "quantity": 10 },
    { "line_unique_key": "2", "item_id": "718", "lot": "LOT-A", "quantity": 14 }
  ]
}
```

- Response:

```
{
  "success": true,
  "bin_transfer_internal_id": "2492118",
  "external_id": "f7c1a2b3-4d5e-4f60-8a1b-2c3d4e5f6071",
  "item_receipt_internal_id": "2481003",
  "order_id": "16050",
  "location_id": "13",
  "from_bin": "77",                                                   // The RESOLVED pair, and only when every line agreed. '' otherwise
  "to_bin": "95",
  "moved_quantity": 34,                                               // What THIS call moved
  "released_quantity": 34,                                            // Where the RECEIPT stands, cumulatively
  "held_quantity": 0,
  "received_quantity": 34,
  "fully_released": true,
  "bin_transfers": ["2492118"],                                       // Every transfer that has released against this receipt
  "lines_released": [
    {
      "line_unique_key": "1",
      "item_id": "718",
      "lot": "LOT-2026-0815",
      "lot_internal_id": "901",
      "quantity": 24,
      "released_to_date": 24,
      "received": 24,
      "from_bin": "77",                                               // Always the per-line truth
      "to_bin": "95"
    }
  ]
}
```

**The release's good-bin ladder:**

```
1. the release LINE's good_bin
2. the release BODY's good_bin
3. the good bin THE RECEIPT RECORDED for that lot
4. the LOCATION's Good Bin
```

Rung 3 is the only one that can differ between two lots of one item at one site. A quantity that
matches no recorded part of a split lot is **refused**, not guessed — name `good_bin` on that line,
or release each part with the quantity the receipt recorded.

## A resend of any write

```
{
  "success": true,
  "internal_id": "16453",
  "external_id": "11111111-2222-3333-4444-555555555564",
  "duplicate": true,
  "lines_posted": 1
}
```

A **success**, not a refusal. Nothing was created or moved twice.

## A failure

**Nothing is saved unless every line passes.** There is no partial save.

```
{
  "success": false,
  "error_code": "LINE_VALIDATION_FAILED",
  "error_message": "1 line(s) failed validation, so nothing was created. Correct them and resubmit with a new request_uuid.",
  "failed_lines": [
    {
      "line_unique_key": "2",
      "error_code": "QTY_EXCEEDS_REMAINING",
      "error_message": "Line 2 submits 30 of Amoxicillin 500mg Tablet (718) but only 24 is left on the order. Over-receipt on a regulated product is a discrepancy to investigate, not a quantity to accept."
    }
  ]
}
```

A document-level refusal has no `failed_lines`:

```
{
  "success": false,
  "error_code": "ORDER_NOT_SYNCED",
  "error_message": "Order PO447 (16050) has no TrackTraceRX transaction identifier, so it was never sent and cannot be scanned against."
}
```

**Resubmit with a NEW `request_uuid`** — the old one may already be claimed.

---

# List and Lookup APIs  (Middleware → NetSuite)

All seven use the same RESTlet. Every one is documented as a **GET**; the identical body is accepted
as a **POST** and nothing about the answer differs.

```
https://td3113894.restlets.api.netsuite.com/app/site/hosting/restlet.nl
  ?script=customscript_jj_rl_rb_read&deploy=customdeploy_jj_rl_rb_read
  &operation=...
```

> A GET delivers every parameter as **text**. Flags are parsed, not tested for truthiness:
> `false|f|0|no` are false, `true|t|1|yes` are true, **anything else falls back to the default**.

## PO / SO List

- `&operation=list_transactions&record_type=purchaseorder&location=13&page_size=50`
- Method: **GET**

| Parameter                  | Required |                                                                                                                                             |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `record_type`              | **yes**  | `purchaseorder` / `salesorder`. `po`, `purchase`, `so`, `sales` etc. accepted. The parameter may also be named `transaction_type` or `type` |
| `status`                   | no       | comma list or JSON array. Empty ⇒ every scannable status                                                                                    |
| `location` / `location_id` | no       | falls back to the user's employee location, then unfiltered                                                                                 |
| `serialized_only`          | no       | default `false`                                                                                                                             |
| `page_size` / `limit`      | no       | default **200**, cap **1000**                                                                                                               |
| `offset`                   | no       | default 0                                                                                                                                   |
| `page`                     | no       | zero-based, used when `offset` is absent                                                                                                    |

- Response:

```
{
  "success": true,
  "record_type": "purchaseorder",
  "type": "Purchase",
  "list_token": "purchase",
  "location_filter": { "id": "13", "source": "parameter" },           // null when unfiltered; source is 'parameter' or 'current_user'
  "page": { "offset": 0, "size": 50, "returned": 1, "capped": false },// 'capped' = page SIZE is at the 1000 ceiling, NOT that results were cut
  "has_more": false,                                                  // The page came back full. There is no total count, by design
  "transactions": [
    {
      "internal_id": "16050",
      "record_type": "purchaseorder",
      "type": "Purchase",
      "document_number": "PO447",
      "transaction_date": "9/30/2026",
      "status": "Pending Receipt",
      "status_ref": "PurchOrd:B",
      "entity_id": "1841",
      "entity_name": "Test Vendor 1",
      "location_id": "13",
      "location_name": "Test Location 1",
      "subsidiary_id": "1",
      "transaction_uuid": "8dacc081-40be-4c7c-9f3a-ca21ab6366ce",
      "shipment_uuid": "",
      "open_lines": 3                                                 // Lines still with something outstanding
    }
  ]
}
```

Excluded from the list: an order at a non-scannable status, an order with no TrackTraceRX
identifier, a line closed by hand, a line with nothing left, anything outside the operator's
location.

## PO / SO Detail

- `&operation=fetch_transaction&record_type=purchaseorder&internal_id=16050`
- Method: **GET**

| Parameter                        | Required     |                  |
| -------------------------------- | ------------ | ---------------- |
| `record_type`                    | **yes**      | as above         |
| `internal_id` / `transaction_id` | one of three |                  |
| `transaction_uuid`               | one of three |                  |
| `document_number` / `tranid`     | one of three | `PO447`, `SO610` |

- Response:

```
{
  "success": true,
  "internal_id": "16050",
  "record_type": "purchaseorder",
  "type": "Purchase",
  "creates": "itemreceipt",                                           // What a scan against this order will produce
  "document_number": "PO447",
  "transaction_date": "9/30/2026",
  "status": "Pending Receipt",
  "status_ref": "PurchOrd:B",
  "entity_id": "1841",
  "entity_name": "Test Vendor 1",
  "location_id": "13",
  "location_name": "Test Location 1",
  "subsidiary_id": "1",
  "memo": "",
  "transaction_uuid": "8dacc081-40be-4c7c-9f3a-ca21ab6366ce",
  "default_hold_bin": "77",                                           // OFFERED, not imposed. null on a sales order
  "default_good_bin": "88",                                           // OFFERED. null unless the LOCATION has a Good Bin set
  "line_count": 1,
  "lines_not_scannable": [],
  "lines": [
    {
      "line_unique_key": "1",                                         // Send this back as the line's key on a write
      "item_id": "718",
      "item_name": "Amoxicillin 500mg Tablet",
      "description": "Test Purchase Description",
      "quantity": 2,
      "quantity_remaining": 2,
      "unit": "Pallet",                                               // The unit's canonical NAME from the Units Type
      "unit_id": "23",                                                // The unit's INTERNAL ID, as the line stores it
      "unit_as_entered": "23",                                        // What the line's unit column reads as
      "unit_abbreviation": "PF",
      "conversion_rate": 16,                                          // 1 when the unit could not be resolved
      "is_base_unit": false,
      "quantity_in_base_units": 32,
      "remaining_in_base_units": 32,
      "requires_serialization": true,                                 // The item's TrackTraceRX eligibility
      "is_serial_tracked": false,                                     // NetSuite's own flag
      "is_lot_tracked": true,                                         // NetSuite's own flag
      "uses_bins": true,
      "product_uuid": "d4c3b2a1-0000-4000-8000-000000000001",
      "product_uuid_missing_reason": "",                              // Populated only for an ELIGIBLE line
      "uom_unit_matched": "PALLET",
      "ndc": "1234-5678-90",
      "gtin": "00312345678906",
      "upc": "312345678906",
      "pack_size": "100",
      "bin_id": "",
      "location_id": "13"
    }
  ]
}
```

- When a line cannot be scanned:

```
{
  "lines_not_scannable": [
    {
      "line_unique_key": "2",
      "item": "Gauze Pad (716)",
      "unit": "Each",
      "unit_id": "1",
      "code": "NO_UUID",                                              // UNIT_UNKNOWN | NO_ROW | NO_UUID
      "reason": "NO_UUID: the UOM Detail row for \"Each\" exists but has not been accepted by the Middleware yet."
    }
  ],
  "notes": [
    { "code": "LINES_NOT_SCANNABLE", "message": "1 line cannot be scanned: ..." }
  ]
}
```

**Do not offer an unscannable line to the operator.** A scan against it is refused at submit, with
the goods already on the dock.

## Item Fulfillment Exception

- `&operation=fulfilment_exceptions`  *(one `l` — note the spelling)*
- Method: **GET**. **No parameters.**
- Response:

```
{
  "success": true,
  "list_id": "customlist_jj_rb_fulfil_exception",
  "submit_as": "name",                                                // Send the NAME on exception_reason, not the id
  "count": 7,
  "exception_reasons": [
    { "id": "2", "name": "Damaged on inspection" },
    { "id": "3", "name": "Expired or short-dated" },
    { "id": "4", "name": "Not found at the location" },
    { "id": "7", "name": "Other - raise an investigation" },
    { "id": "6", "name": "Quantity mismatch on count" },
    { "id": "5", "name": "Serial mismatch" },
    { "id": "1", "name": "Short stock at the bin" }
  ]
}
```

The ids are not stable across sandbox and production. Always submit the name.

## Allowed Bins For Item

- `&operation=allowed_bins_for_item&item=718&location=13`
- Method: **GET**

| Parameter                  | Required    |                                                 |
| -------------------------- | ----------- | ----------------------------------------------- |
| `item`                     | **yes**     | `item_id` is **not** accepted                   |
| `location` / `location_id` | conditional | **required** when the item has no bins attached |

**Three answers. Read `source` before reading `bins` — the element shape differs.**

```
// source 'item' - the item has bins attached. 5 keys, including 'preferred'
{
  "success": true, "item_id": "718", "location_id": "13",
  "use_bins": true, "source": "item",
  "bins": [
    { "bin_id": "77", "bin_number": "HOLD-01", "location_id": "13",
      "location_name": "Test Location 1", "preferred": true }
  ]
}

// source 'location' - fallback. 7 keys, NO 'preferred'
{
  "success": true, "item_id": "718", "location_id": "13",
  "use_bins": true, "source": "location",
  "bins": [
    { "bin_id": "77", "bin_number": "HOLD-01", "location_id": "13",
      "location_name": "Test Location 1", "description": "Quarantine hold",
      "available": true, "bin_uuid": "aa11bb22-..." }
  ],
  "note": "This item has no bins attached to it, so every available bin at the location is offered."
}

// source 'none' - bins switched off on the Configuration
{
  "success": true, "item_id": "718", "location_id": "13",
  "use_bins": false, "source": "none", "bins": [],
  "note": "Bins are switched off on the RapidBridge Configuration record, so no bin is required or accepted on a line."
}
```

## Bins For Location

- `&operation=bins_for_location&location=13&include_inactive=false`
- Method: **GET**

| Parameter          | Required |                                        |
| ------------------ | -------- | -------------------------------------- |
| `location`         | **yes**  | `location_id` is **not** accepted here |
| `include_inactive` | no       | default `false`                        |

```
{
  "success": true,
  "location_id": "13",
  "use_bins": true,
  "count": 2,
  "capped": false,                                                    // true means the 1000-row cap was reached
  "bins": [
    { "bin_id": "77", "bin_number": "HOLD-01", "location_id": "13",
      "location_name": "Test Location 1", "description": "Quarantine hold",
      "available": true, "bin_uuid": "aa11bb22-..." }
  ]
}
```

## Bin Contents

- `&operation=bin_contents&location=13&bin=77`
- Method: **GET**

| Parameter        | Required    |                                              |
| ---------------- | ----------- | -------------------------------------------- |
| `location`       | **yes**     |                                              |
| `bin` / `bin_id` | conditional | required **only when the account uses bins** |

```
{
  "success": true,
  "location_id": "13",
  "bin_id": "77",
  "use_bins": true,
  "count": 2,
  "capped": false,
  "items": [
    { "bin_id": "77", "bin_number": "HOLD-01",
      "available_quantity": 24, "on_hand_quantity": 24,
      "item_id": "718", "item_name": "AMOX-500" }
  ]
}
```

## Item Availability

- `&operation=item_availability&location=13&item=718&bin=77`
- Method: **GET**

| Parameter        | Required |                                               |
| ---------------- | -------- | --------------------------------------------- |
| `location`       | **yes**  |                                               |
| `item`           | **yes**  | `item_id` is **not** accepted                 |
| `bin` / `bin_id` | no       | narrows it; blank ⇒ every bin at the location |

```
{
  "success": true,
  "location_id": "13",
  "bin_id": "77",
  "item_id": "718",
  "item_name": "AMOX-500",
  "use_bins": true,
  "tracking": "lot",                                                  // 'serial' | 'lot' | 'none'
  "available_quantity": 24,                                           // The SUM of the rows returned - a floor when capped is true
  "on_hand_quantity": 24,
  "count": 1,
  "capped": false,
  "lots": [                                                           // The array is NAMED FOR THE TRACKING - see below
    { "bin_id": "77", "bin_number": "HOLD-01",
      "available_quantity": 24, "on_hand_quantity": 24,
      "item_id": "718", "item_name": "AMOX-500",
      "number_id": "901", "number": "LOT-2026-0815" }
  ]
}
```

**Read `tracking`, then read the array it names.** Only one of the three is ever present:

| `tracking` | the array is called |
| ---------- | ------------------- |
| `"serial"` | `serials`           |
| `"lot"`    | `lots`              |
| `"none"`   | `balances`          |

A device that looks only for `lots` will find nothing on a serialized item and conclude, wrongly,
that there is no stock.

## Notes on a read

```
{ "notes": [ { "code": "RESULT_TRUNCATED", "message": "..." } ] }
```

Present only when there is something to say. Two keys.

| Code                  | Means                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| `LINES_NOT_SCANNABLE` | at least one eligible line has no `product_uuid`. Do not offer those lines |
| `DEGRADED_READ`       | a supporting search failed; the answer is thinner than it should be        |
| `RESULT_TRUNCATED`    | the list hit the 1000-row cap                                              |
| `NO_SCANNABLE_LINES`  | the document transformed to zero lines                                     |
| `UNFILTERED_LIST`     | no location filter anywhere, so the list spans every site                  |

---

# Error codes

## Write — document level

`MALFORMED_PAYLOAD` · `UNKNOWN_OPERATION` · `NO_CONFIGURATION` · `FLOW_DISABLED` ·
`MISSING_REQUEST_UUID` · `ORDER_NOT_FOUND` · `ORDER_CLOSED` · `ORDER_NOT_APPROVED` ·
`ORDER_NOT_SYNCED` · `LOCATION_INACTIVE` · `LINE_VALIDATION_FAILED` · `PERIOD_LOCKED` ·
`SAVE_REFUSED` · `RECORD_NOT_FOUND` · `NOTHING_TO_RELEASE` · `RECEIPT_NOT_IDENTIFIED` ·
`RECEIPT_NOT_READABLE` · `UNHANDLED`

## Write — line level

`ITEM_NOT_FOUND` · `ITEM_INACTIVE` · `LINE_NOT_ON_ORDER` · `BAD_QUANTITY` ·
`QTY_EXCEEDS_REMAINING` · `LOT_INVALID` · `SERIAL_INVALID` · `SERIAL_ALREADY_ON_HAND` ·
`INVENTORY_DETAIL_MISSING` · `INSUFFICIENT_STOCK` · `UOM_NOT_CONVERTIBLE` · `BIN_NOT_ALLOWED` ·
`BIN_INVALID_LOCATION` · `BIN_REQUIRED` · `BIN_NOT_CONFIGURED` · `BIN_MAP_TOO_LARGE` ·
`EXCEPTION_REASON_REQUIRED` · `NOT_ELIGIBLE` · `LOT_NOT_FOUND` · `LOT_NOT_IN_BIN` ·
`QTY_EXCEEDS_IN_BIN` · `LOT_NOT_ON_RECEIPT` · `ALREADY_RELEASED` · `QTY_EXCEEDS_RECEIVED`

## Read

`MALFORMED_PAYLOAD` · `UNKNOWN_OPERATION` · `NO_CONFIGURATION` · `MISSING_PARAMETER` ·
`UNKNOWN_RECORD_TYPE` · `NOT_IMPLEMENTED` · `TRANSACTION_NOT_FOUND` · `TRANSACTION_NOT_SCANNABLE` ·
`TRANSACTION_NOT_SYNCED` · `SEARCH_FAILED`

Every code and the exact condition that raises it is in `expected_payload.md` §7 and §11.

---

# The device's normal sequence

1. `list_transactions` — show the operator what can be scanned at their location.
2. `fetch_transaction` — the lines, their units, their product UUIDs, and the two default bins.
   **Skip anything in `lines_not_scannable`.**
3. *(optional)* `allowed_bins_for_item` or `bins_for_location` — offer bins.
4. *(optional)* `fulfilment_exceptions` — the reasons a short line may carry.
5. `item_receipt` or `item_fulfillment` — **POST**, one call, all lines, all or nothing.
6. `identifier` — **PUT**, store the shipment UUID against the record just created.
7. *(receipts only, after TrackTraceRX verifies)* `inventory_release` — **POST**, move the lots that
   passed from the on-hold bin to a good bin.
