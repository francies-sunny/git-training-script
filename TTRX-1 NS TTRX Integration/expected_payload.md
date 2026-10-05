# RapidBridge SuiteApp — Expected Payloads

Every payload the integration sends or receives, in both directions, as the code builds them today.
Supersedes `payload_guide.md`, which covered the outbound master-data bodies and one Item Receipt
sample.

Generated 30 September 2026 against `jj_rb_core.js`, `jj_rb_sync.js`, `jj_rb_txn.js`,
`jj_rl_rb_write.js`, `jj_rl_rb_read.js`.

---

## 0. How to read this document

**Two directions, and they do not resemble each other.**

| | OUTBOUND (NS → MW) | INBOUND (MW → NS) |
|---|---|---|
| Who calls | NetSuite, from a User Event | The Middleware, calling a RESTlet |
| Bodies below | §2 master data · §3 transactions | §4 writes · §5 reads |
| Encoding | `application/x-www-form-urlencoded` by default (config `Content Type`); JSON when that setting contains `json` | Always JSON |
| Operation named by | The HTTP method and path | A key **in the body**: a RESTlet is one script and one URL |

**Conventions in every table below.**

- *Always X* — a fixed value the code writes; not configurable, not read from NetSuite.
- *Empty* — the key **is sent**, with an empty value. Outbound bodies use a **full fixed key set**:
  a key is never omitted, because an omitted key and an emptied key mean different things to the
  destination and only one of them is a clearing instruction.
- A UUID field left empty means the parent has not been accepted by the Middleware yet. The engine
  pre-syncs the parent first and blocks the child if that fails (`Blocked — missing parent UUID`).

---

# PART 1 — OUTBOUND

## 1. Endpoints

| Object | Create | Update | Delete |
|---|---|---|---|
| Dosage Form | `POST /products/pharmaceutical/dosage_forms` | `PUT …/{uuid}` | `DELETE …/{uuid}` |
| Product (per UOM row) | `POST /products` | `PUT /products/{uuid}` | `DELETE /products/{uuid}` |
| Trading Partner | `POST /trading_partners` | `PUT /trading_partners/{uuid}` | `DELETE /trading_partners/{uuid}` |
| Partner Address | `POST /trading_partners/{uuid}/addresses` | `PUT …/addresses/{address_uuid}` | `DELETE …/addresses/{address_uuid}` |
| Location | `POST /locations` | `PUT /locations/{uuid}` | `DELETE /locations/{uuid}` |
| Location Address | `POST /locations/{uuid}/addresses` | `PUT …/addresses/{address_uuid}` | `DELETE …/addresses/{address_uuid}` |
| Storage Area (bin) | `POST /locations/{locationUuid}/storage_areas` | `PUT …/storage_areas/{uuid}` | — |
| Transaction | `POST /transactions/{txnType}` | `PUT /transactions/{txnType}/{uuid}` | `DELETE /transactions/{txnType}/{uuid}` |
| Transaction read | `GET /transactions/{txnType}/{uuid}` | | |
| Storage areas read | `GET /locations/{uuid}/storage_areas` | | |
| Health | `GET /health` | | |

### `{txnType}` is not one constant

The destination spells the same concept differently per operation. Substituted from `C.TOKENS`:

| Operation | Sales Order | Purchase Order |
|---|---|---|
| create · update · void · read | `sales` | `purchase` |
| **list** | **`sale`** — singular | `purchase` |

A single "transaction type" constant will not work across all four. `PARTNER_ADDRESS_DELETE` is
**inferred** from the convention every other object follows — the reference build never deleted an
address. Confirm before relying on it.

---

## 2. Master data bodies

### 2.1 Dosage Form

`POST /products/pharmaceutical/dosage_forms`

```json
{
  "code": "Test2",
  "is_active": true,
  "name": "Test2"
}
```

`code` is the value products reference in `class_pharmaceutical__dosage_form` — **the code, never
the NetSuite internal id**.

### 2.2 Location

`POST /locations`

```json
{
  "create_default_storage_area": true,
  "custom_uuid": "TEST-UUID-00000001",
  "gs1_id": "abc123",
  "gs1_sgln": "test123",
  "is_active": true,
  "is_unselectable_location": false,
  "location_detail": "2",
  "location_lat": "56.998855",
  "location_long": "-101.027169",
  "manufacturing_location_prefix_or_suffix_id_value": "",
  "name": "Test1",
  "parent_location_uuid": ""
}
```

| Field | |
|---|---|
| `create_default_storage_area` | **Always true.** An account with no bins still needs somewhere for stock to land |
| `is_unselectable_location` | Always false |
| `manufacturing_location_prefix_or_suffix_id_value` | Always empty |
| `parent_location_uuid` | The parent location's UUID; empty when top-level. Cascade is capped at five levels |

### 2.3 Address

`POST /trading_partners/{uuid}/addresses` · `POST /locations/{uuid}/addresses`

```json
{
  "address_gs1_id": "",
  "address_nickname": "Test A BCD Label",
  "city": "City",
  "country_code": "US",
  "gs1_sgln": "1234123412341234",
  "is_licence_required": false,
  "line1": "Address 1",
  "line2": "Address 2",
  "phone": "1231231231",
  "recipient_name": "Test A BCD Addressee",
  "state": "NJ",
  "zip": "08901"
}
```

| Field | |
|---|---|
| `address_gs1_id` | Always empty |
| `address_nickname` | The Address Label; `Address N` by line number when unlabelled |
| `recipient_name` | The Addressee, falling back to the parent record's name |
| `is_licence_required` | Always false |
| `state` | Sent **as NetSuite spells it**. Nothing is resolved against `GET /utility/country_list/{countryId}/states` |

Location address sync is currently **off** (`location.hasChildren`); the endpoints are declared so
switching it on needs no code change.

### 2.4 Trading Partner — Customer

`POST /trading_partners`

```json
{
  "custom_uuid": "b5969a19-eacc-4b4b-a12a-9c2fde24722d",
  "name": "Test1",
  "gs1_id": "1234",
  "gs1_company_id": "",
  "gs1_sgln": "",
  "type": "CUSTOMER",
  "parent_tp_uuid": "TEST-UUID-00000001",
  "customer_id": "392",
  "friendly_name": "",
  "default_billing_address_uuid": "TEST-UUID-00000001",
  "default_shipping_address_uuid": "TEST-UUID-00000001",
  "phone": "(123) 456-7890",
  "phone_ext": "",
  "notification_email": "test@gmail.com",
  "new_trx_notification_type": "ALL",
  "flag_notification_name": "",
  "flag_notification_email": "",
  "flag_notification_phone": "",
  "flag_notification_phone_ext": "",
  "external_reference": "1841",
  "is_active": true,
  "inbound_shipping_check_percentage": "",
  "outbound_shipping_check_percentage": "",
  "sender_id": "",
  "receiver_id": "",
  "as2_id": "",
  "is_a_3pl_client": false,
  "3pl_is_our_company_is_internal_entity_of_tp": false,
  "is_send_outbond_epcis": false,
  "is_send_outbond_x12": false,
  "default_outbound_transaction_type": "SALES",
  "send_copy_outbound_shipment_external_trading_entity_id": "",
  "outbound_epcis_generator_type": "",
  "is_enable_transmit_outbound_850": "",
  "omit_comm_aggr_in_epcis": false
}
```

| Field | |
|---|---|
| `name` | Company Name; the Alternate Name when the customer is an Individual; otherwise the Entity ID |
| `type` | Always `CUSTOMER` |
| `parent_tp_uuid` | The parent customer's UUID; empty when there is no parent |
| `customer_id` | The NetSuite **Entity ID** (the human one) |
| `external_reference` | The NetSuite **internal id** |
| `default_*_address_uuid` | The UUID of that default address line; empty until the address has been accepted |
| `new_trx_notification_type` · `default_outbound_transaction_type` | Always `ALL` / `SALES` |
| Everything else marked empty or false above | Fixed. Sent anyway — the full fixed key set |

> `is_send_outbond_epcis` and `is_send_outbond_x12` are spelled **`outbond`**, not `outbound`, on
> the destination API. Not a typo in this document.

### 2.5 Trading Partner — Vendor

Identical shape. Four differences:

| Field | Vendor |
|---|---|
| `type` | `VENDOR` |
| `parent_tp_uuid` | **Always empty** — a vendor has no parent hierarchy |
| `name` | Company Name, falling back to the Entity ID (no Individual case) |
| `customer_id` | The Entity ID, which for a vendor is usually the name |

### 2.6 Product — one per UOM Detail row

`POST /products`

**One NetSuite item produces N products**, one per active UOM Detail row. That is the single most
important shape in the master-data scope: a product is a *packaging level*, not an item.

```json
{
  "custom_uuid": "",
  "type": "Pharmaceutical",
  "gs1_company_prefix": "0300026",
  "gs1_id": "014511",
  "upc": "00300026145113",
  "sku": "Test Lot Inventory Item 3",
  "type_class": "",
  "category_id": "",
  "status": "AVAILABLE",
  "manufacturer_id": "",
  "manufacturer_default_address_uuid": "",
  "is_active": true,
  "update_product_descriptions": true,
  "product_descriptions": [
    {
      "language_code": "en",
      "name": "Baqsimi 3 mg Powder",
      "description": "Baqsimi 3 mg Powder",
      "composition": "",
      "product_long_name": ""
    }
  ],
  "update_product_identifiers": true,
  "product_identifiers": [
    { "identifier_code": "US_NDC", "value": "00002614511" }
  ],
  "pack_size": "",
  "pack_size_type_id": "5",
  "update_requirements": false,
  "update_packaging": false,
  "class_pharmaceutical__strength": "3MG",
  "class_pharmaceutical__dosage_form": "POWDER",
  "class_pharmaceutical__generic_name": "BAQSIMI 3MG PWD",
  "is_leaf_product": false,
  "is_override_products_packaging_type_validation": false,
  "gtin14": "00300026145113",
  "update_composition": true,
  "composition": "[{\"238133c2-6039-4a0c-9a57-dd94e227e1cc\":\"20\"}]",
  "is_bin_managed": false,
  "bin_feature_enabled": true
}
```

| Field | |
|---|---|
| `custom_uuid` | Empty on create; the TrackTrace UUID on every later call |
| `type` | From config `Product Class`, defaulting to `Pharmaceutical` |
| `upc` | The UOM Detail UPC, falling back to the item UPC |
| `sku` | The NetSuite **Item ID** — not the NDC |
| `status` | From the item's inactive flag |
| `language_code` | From config, defaulting to `en` |
| `name` | Display Name, falling back to Item ID |
| `description` | Sales Description → Display Name → Item ID |
| `product_long_name` | Sales Description |
| `update_product_identifiers` | True only when an NDC exists |
| `pack_size_type_id` | From the **Pack Size Type Map** on config, keyed on the row's Saleable Unit |
| `class_pharmaceutical__dosage_form` | The Dosage Form **CODE**, never the internal id |
| `is_leaf_product` | True only when `pack_size_type_id` is `1` — the base unit |
| `composition` | `[{ base-unit product UUID: qty in lowest unit }]`, as a **string**. Empty on a base-unit row |
| `update_composition` | True only when `composition` is non-empty |
| `is_bin_managed` | Bin feature **AND** config Use Bins **AND** the item's own Use Bins |
| `type_class` · `category_id` · `manufacturer_id` · `manufacturer_default_address_uuid` · `update_requirements` · `update_packaging` · `is_override_products_packaging_type_validation` | Fixed empty / false |

### 2.7 Storage Area (bin)

`POST /locations/{locationUuid}/storage_areas`. Declared in `C.MASTER` with
`implemented: false` — **the builder is not written**. Gated behind config `Use Bins`.

### 2.8 Delete

Every delete is the same shape: **no body**, the UUID in the path.

```
DELETE /products/{uuid}
DELETE /trading_partners/{uuid}
DELETE /locations/{uuid}
DELETE /products/pharmaceutical/dosage_forms/{uuid}
```

Whether a NetSuite inactivation sends a `DELETE` or a `PUT` with `is_active: false` is the config
setting **Inactive Method**. The default is the `PUT`, because a delete cannot be undone from
NetSuite.

---

## 3. Transaction bodies

`POST /transactions/{txnType}` · `PUT /transactions/{txnType}/{uuid}`

### 3.1 Purchase Order

```json
{
  "transaction_uuid": "f4efb87c-e483-4f31-b91c-dcfe21382bb6",
  "custom_id": "PO446",
  "location_uuid": "800930e8-1609-4b50-a8ef-929088f89a11",
  "trading_partner_uuid": "358a9c44-48c1-47a2-833d-8bf1970ad350",
  "transaction_date": "2026-09-28",
  "billing_address_uuid": "",
  "ship_from_address_uuid": "ac519f3d-0f02-46db-9b1f-5a410104f56f",
  "ship_to_address_uuid": "",
  "sold_by_address_uuid": "ac519f3d-0f02-46db-9b1f-5a410104f56f",
  "line_items": "[{\"product_uuid\":\"c427a199-a6e2-472a-9f3f-36706c00358c\",\"quantity\":1,\"sort_order\":\"1\"}]",
  "is_approved": true,
  "is_approved_is_ship_transaction": false,
  "is_manually_close_transaction": false,
  "enforce_oci": false,
  "order_nbr": "PO446",
  "po_nbr": "PO446"
}
```

> **`line_items` is a JSON STRING, not an array.** `JSON.stringify(items)` is applied before the body
> is encoded. The sample in `payload_guide.md` showed it unquoted, which is how it reads after
> decoding — not how it is sent.

### 3.2 Sales Order

The same 17 keys, plus one:

```json
{ "outbound_transaction_sub_type": "SALES" }
```

Sent **explicitly on a sale** so NetSuite knows what it created without a second read (§8.4).
**Ignored on a purchase**, so not sent at all (§9.3).

### 3.3 Address roles differ by direction

| Role | Sales Order | Purchase Order |
|---|---|---|
| `billing_address_uuid` | Partner | Location |
| `ship_to_address_uuid` | Partner | Location |
| `ship_from_address_uuid` | Location | Partner |
| `sold_by_address_uuid` | Location | Partner |

Resolved from the **order's own** billing/shipping address records first, falling back to the
entity's defaults.

### 3.4 The fixed flags, and why

| Flag | Value | |
|---|---|---|
| `is_approved` | **Always true** | Nothing is sent until the order reaches a sync-eligible status, so the remote transaction is created in the state that matches it |
| `is_approved_is_ship_transaction` | **Always false** | Setting it asserts that everything ordered ships, in one event, now. Partial fulfilment is supported (§10.7), so a partial pick against an order whose shipment was already created for the full quantity leaves the destination holding a shipment that did not happen — and there is no parity reconciliation in this phase to find it |
| `is_manually_close_transaction` | false on create/update | Set **true** on the close call, which re-sends the *stored* payload with only this flag changed |
| `enforce_oci` | Always false | |

### 3.5 Line items

```json
{ "product_uuid": "…", "quantity": 1, "sort_order": "1" }
```

Only lines whose item is TrackTrace-eligible appear. `product_uuid` comes from the item's UOM Detail
row **for that line's unit**; `sort_order` is the NetSuite line number. `quantity` is the line's own
quantity in its own unit — the guide's §10.4 reading ("convert to base unit unconditionally")
differs only when an item has both a Case row and an Each row, and is **carried as an open question
to TrackTraceRX**. What was sent is written back to `custcol_jj_rb_qty_synced`.

### 3.6 Close and void

| Action | Call |
|---|---|
| Close (config `Close Action` = *Mark closed*) | `PUT /transactions/{txnType}/{uuid}` — the **stored** payload, with `is_manually_close_transaction: true` |
| Delete (config `Close Action` = *Delete*) | `DELETE /transactions/{txnType}/{uuid}`, no body |

A void is guarded by `GET /transactions/{txnType}/{uuid}` — an order with shipments against it is
not voided. **Which field on that read reports the shipment count is an open question**; the guard
reads `shipments`, `shipment_uuids`, `nb_shipments`, `shipment_count` and `shipment_uuid`, and
treats "no mention at all" as unknown rather than zero.

---

# PART 2 — INBOUND

The Middleware calls NetSuite. Two RESTlets, split because a read and a write want different
governance, deployment, role audience and logging.

| Script | Script id | Operations |
|---|---|---|
| `jj_rl_rb_write.js` | `customscript_jj_rl_rb_api` | 3 writes |
| `jj_rl_rb_read.js` | `customscript_jj_rl_rb_read` | 7 reads |

---

## 4. Inbound writes — `jj_rl_rb_write.js`

### 4.1 `item_receipt` / `item_fulfillment` — request

`POST`, operation in the body.

```json
{
  "operation": "item_receipt",
  "request_uuid": "11111111-2222-3333-4444-555555555555",
  "order_id": "16050",
  "shipment_uuid": "",
  "scan_session_id": "POSTMAN-TEST-01",
  "transaction_date": "2026-09-30",
  "memo": "Postman test receipt for PO447",
  "lines": [
    {
      "line_unique_key": "1",
      "item_id": "718",
      "quantity": 2,
      "bin": "936",
      "exception_reason": "Short stock at the bin",
      "exception_note": "One case damaged in transit",
      "inventory": [
        { "lot": "LOT-718-A", "expiry": "2027-12-31", "quantity": 2 }
      ]
    },
    {
      "line_unique_key": "2",
      "item_id": "719",
      "quantity": 4,
      "inventory": [
        { "lot": "LOT-719-A", "expiry": "2027-06-30", "quantity": 3 },
        { "lot": "LOT-719-B", "expiry": "2028-01-31", "quantity": 1 }
      ]
    }
  ]
}
```

| Field | |
|---|---|
| `operation` | `item_receipt` (from a PO) or `item_fulfillment` (from an SO) |
| `request_uuid` | **Mandatory.** Becomes the record's native `externalId`, and is the only duplicate guard |
| `order_id` | The NetSuite PO or SO internal id |
| `line_unique_key` | The value `fetch_transaction` returned under that name — the transformed document's `orderline`. Echo it back unchanged |
| `bin` | Optional. A receipt defaults to the location's on-hold bin; a fulfilment defaults none |
| `exception_reason` | Set **by text**, so it must be a name from `fulfilment_exceptions` |
| `inventory` | One row per lot; for a **serialized** item one row per serial, `{ "serial": "SN1" }`, quantity 1 each |

Line rules: `inventory` totals must equal `quantity`; a lot- or serial-tracked item with no
`inventory` is refused; `quantity` may not exceed what is left on the order.

### 4.2 Create — response

```json
{
  "success": true,
  "internal_id": "9001",
  "external_id": "3f9c…",
  "lines_posted": 2,
  "shipping_status": "Shipped"
}
```

`shipping_status` on a fulfilment only. A **repeat submission** returns the record that already
exists with `"duplicate": true` — a success, not an error. That is the expected answer to a retry.

### 4.3 Create — failure

```json
{
  "success": false,
  "error_code": "LINE_VALIDATION_FAILED",
  "error_message": "2 line(s) failed validation, so nothing was created. Correct them and resubmit with a new request_uuid.",
  "failed_lines": [
    {
      "line_unique_key": "2",
      "error_code": "BIN_INVALID_LOCATION",
      "error_message": "Bin HOLD-01 (936) is not at the order's location."
    }
  ]
}
```

**All-or-nothing.** Any line failure rejects the whole submission and nothing is created.
`failed_lines` carries **every** failing line, never the first — an operator who fixes one bin and is
then told about a second has made two trips to the dock.

### 4.4 `identifier` — request

`PUT`. Call 2 of the two-call protocol.

```json
{
  "operation": "identifier",
  "request_uuid": "3f9c…",
  "record_type": "itemreceipt",
  "shipment_uuid": "9b21…"
}
```

> **An Item Receipt has no identifier of its own.** What this call stores is the **shipment UUID**,
> and one shipment can cover several purchase or sales orders — so several receipts legitimately
> carry the same one. **It is not checked for uniqueness**, and it is written to
> `custbody_jj_rb_shipment_uuid`, not `custbody_jj_rb_uuid`.
>
> Orders are the opposite: a PO or SO gets a transaction UUID that *is* unique per record.
>
> `tracktrace_uuid` and a bare `uuid` are accepted as spellings of the same value.

```json
{ "success": true, "internal_id": "9001", "external_id": "3f9c…", "shipment_uuid": "9b21…" }
```

### 4.5 Write error codes

**Document:** `NO_CONFIGURATION` · `FLOW_DISABLED` · `UNKNOWN_OPERATION` · `MISSING_REQUEST_UUID` ·
`MALFORMED_PAYLOAD` · `ORDER_NOT_FOUND` · `ORDER_NOT_APPROVED` · `ORDER_NOT_SYNCED` ·
`ORDER_CLOSED` · `LOCATION_INACTIVE` · `PERIOD_LOCKED` · `LINE_VALIDATION_FAILED` ·
`RECORD_NOT_FOUND` · `SAVE_REFUSED`

**Line:** `ITEM_NOT_FOUND` · `ITEM_INACTIVE` · `LINE_NOT_ON_ORDER` · `BAD_QUANTITY` ·
`QTY_EXCEEDS_REMAINING` · `LOT_INVALID` · `SERIAL_INVALID` · `SERIAL_ALREADY_ON_HAND` ·
`BIN_NOT_ALLOWED` · `BIN_INVALID_LOCATION` · `UOM_NOT_CONVERTIBLE` · `INVENTORY_DETAIL_MISSING` ·
`INSUFFICIENT_STOCK`

`DUPLICATE_IDENTIFIER` is **no longer raised** — see §4.4.

---

## 5. Inbound reads — `jj_rl_rb_read.js`

`GET` with the parameters in the query string, or `POST` with the identical object as a body. Same
contract either way.

**Every failure is HTTP 200** with `success: false` and an `error_code`. A NetSuite error envelope
instead means the request never reached the script.

### 5.1 `list_transactions`

```
GET ?operation=list_transactions&record_type=purchaseorder&location=13&page_size=50&offset=0
```

Optional: `status`, `serialized_only`, `page` in place of `offset`.

```json
{
  "success": true,
  "record_type": "purchaseorder",
  "type": "Purchase",
  "list_token": "purchase",
  "location_filter": { "id": "13", "source": "parameter" },
  "page": { "offset": 0, "size": 50, "returned": 1, "capped": false },
  "has_more": false,
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
      "open_lines": 2
    }
  ]
}
```

No `statuses` array — it echoed back the caller's own filter, and each transaction already carries
`status` and `status_ref`.

`location_filter: null` means the list is **unfiltered** and a `UNFILTERED_LIST` note is raised.
Excluded from the list: not at its status gate · `custbody_jj_rb_uuid` empty · closed, cancelled or
fully processed · outside the operator's location.

### 5.2 `fetch_transaction`

```
GET ?operation=fetch_transaction&record_type=purchaseorder&internal_id=16050
```

Addressable by `internal_id`, `transaction_uuid` or `document_number`.

```json
{
  "success": true,
  "internal_id": "16050",
  "record_type": "purchaseorder",
  "type": "Purchase",
  "creates": "itemreceipt",
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
  "shipment_uuid": "",
  "default_hold_bin": "2",
  "line_count": 1,
  "lines_not_scannable": [],
  "lines": [
    {
      "line_unique_key": "1",
      "item_id": "718",
      "item_name": "Amoxicillin 500mg Tablet",
      "description": "Test Purchase Description",
      "quantity": 2,
      "quantity_remaining": 2,
      "unit": "Each",
      "unit_id": "23",
      "unit_abbreviation": "EA",
      "conversion_rate": 1,
      "is_base_unit": true,
      "quantity_in_base_units": 2,
      "remaining_in_base_units": 2,
      "requires_serialization": true,
      "is_serial_tracked": false,
      "is_lot_tracked": true,
      "uses_bins": false,
      "product_uuid": "PROD-718-EA",
      "product_uuid_missing_reason": "",
      "uom_unit_matched": "EACH",
      "ndc": "1234-5678-90",
      "gtin": "00312345678906",
      "upc": "312345678906",
      "pack_size": "1",
      "bin_id": "",
      "location_id": "13"
    }
  ]
}
```

| Field | |
|---|---|
| `line_unique_key` | The `orderline` of the document this order **transforms into** — read off the transform so the key the device sends back is one the write side will find |
| `unit` | The unit **name**. `unit_id` is the internal id beside it |
| `conversion_rate` · `quantity_in_base_units` | The base unit is always Each, so a line in Pallets says how many Each that is |
| `uom_unit_matched` | Which spelling of the unit found the UOM Detail row. Empty means none did |
| `requires_serialization` | Read from the **item**, through the configured Eligibility Field — never from the line column |
| `default_hold_bin` | The location's on-hold bin, falling back to the config default. Receipts only |
| `lines_not_scannable` | Lines that require serialization and have no `product_uuid`. Submitting one is the failure the operator cannot undo |

### 5.3 `allowed_bins_for_item`

```
GET ?operation=allowed_bins_for_item&item=718&location=13
```

```json
{
  "item_id": "718",
  "location_id": "13",
  "use_bins": true,
  "source": "item",
  "bins": [
    { "bin_id": "81", "bin_number": "FRIDGE-01", "location_id": "13",
      "location_name": "Test Location 1", "preferred": true }
  ]
}
```

`source` is `"item"` when the item has bins on its Bins sublist, `"location"` when it has none and
every available bin at the location was returned instead. Both are correct. `use_bins: false` with
an empty list is the answer for an account with bins off — never an error.

### 5.4 `fulfilment_exceptions`

```json
{
  "success": true,
  "list_id": "customlist_jj_rb_fulfil_exception",
  "submit_as": "name",
  "count": 7,
  "exception_reasons": [
    { "id": "1", "name": "Short stock at the bin" },
    { "id": "2", "name": "Damaged on inspection" },
    { "id": "3", "name": "Expired or short-dated" },
    { "id": "4", "name": "Not found at the location" },
    { "id": "5", "name": "Serial mismatch" },
    { "id": "6", "name": "Quantity mismatch on count" },
    { "id": "7", "name": "Other - raise an investigation" }
  ]
}
```

The app submits the **name**, because the write RESTlet sets the column by text. An internal id from
one account is meaningless in another.

### 5.5 The three inventory levels

**Level 1 — `bins_for_location`**

```json
{
  "location_id": "13", "use_bins": true, "count": 2, "capped": false,
  "bins": [
    { "bin_id": "90", "bin_number": "TEST-BIN-001", "location_id": "13",
      "location_name": "Test Location 1", "description": "ambient",
      "available": true, "bin_uuid": "BIN-90" }
  ]
}
```

**Level 2 — `bin_contents`** (`location` + `bin`)

```json
{
  "location_id": "13", "bin_id": "90", "use_bins": true,
  "count": 2, "capped": false,
  "items": [
    { "item_id": "718", "item_name": "AMOX-500", "bin_id": "90",
      "bin_number": "TEST-BIN-001",
      "available_quantity": 40, "on_hand_quantity": 40 }
  ]
}
```

**Level 3 — `item_availability`** (`location` + `item`, optional `bin`)

```json
{
  "location_id": "13", "bin_id": "90", "item_id": "718",
  "item_name": "AMOX-500", "use_bins": true,
  "tracking": "lot",
  "available_quantity": 40, "on_hand_quantity": 40,
  "count": 2, "capped": false,
  "lots": [
    { "number_id": "6001", "number": "LOT-001", "item_id": "718",
      "item_name": "AMOX-500", "bin_id": "90", "bin_number": "TEST-BIN-001",
      "available_quantity": 25, "on_hand_quantity": 25 }
  ]
}
```

The array is named after what it holds — **`serials`** for a serial-tracked item, **`lots`** for a
lot item, **`balances`** for neither — so a serial can never be mistaken for a lot on the other side
of the integration. `tracking` carries the same answer as a scalar.

### 5.6 Read error codes

`UNKNOWN_OPERATION` · `NO_CONFIGURATION` · `MALFORMED_PAYLOAD` · `MISSING_PARAMETER` ·
`UNKNOWN_RECORD_TYPE` · `NOT_IMPLEMENTED` · `TRANSACTION_NOT_FOUND` · `TRANSACTION_NOT_SYNCED` ·
`TRANSACTION_NOT_SCANNABLE` · `LOCATION_NOT_FOUND` · `BIN_NOT_FOUND` · `ITEM_NOT_FOUND` ·
`BINS_NOT_ENABLED` · `SEARCH_FAILED`

A separate set from the write codes, because a read failure means something different: nothing was
attempted, nothing is half-done, and the answer is always "ask again with better parameters".

### 5.7 `notes` — unexpected behaviour on a read that succeeded

Present only when something is off. `success` stays `true`; these are not errors.

```json
{
  "success": true,
  "notes": [
    {
      "code": "LINES_NOT_SCANNABLE",
      "message": "1 of 2 line(s) on order PO447 (16050) require serialization and have no product UUID: 718 (718) [NO_ROW]. Scanning them would be refused at submit, on the dock."
    }
  ]
}
```

| Code | Raised when |
|---|---|
| `UNFILTERED_LIST` | `list_transactions` returned rows with no location filter |
| `LINES_NOT_SCANNABLE` | A line requires serialization and has no `product_uuid` |
| `NO_SCANNABLE_LINES` | The order transformed and carried no item line |
| `RESULT_TRUNCATED` | An unpaged list hit the 1,000 cap. On `item_availability` the total is then a **floor** |
| `DEGRADED_READ` | A sub-search failed and the read carried on thinner than it should have |

A note is the **only** reason a successful read writes a Sync Log row. A clean read writes nothing.

---

## 6. Open questions on these payloads

| | |
|---|---|
| **Line quantity and unit** | Send the line's own quantity in its own unit, or convert to base units unconditionally? Only differs when an item has both a Case row and an Each row. The read now returns both, so either can be honoured |
| **`order_nbr` / `po_nbr`** | Both carry `tranid` today. Whether they mean different things on the destination is not documented anywhere |
| **Empty `ship_from_address_uuid` / `sold_by_address_uuid`** | Sent empty when the location has no synced address. Whether the destination accepts that or should be blocked is unconfirmed |
| **Transaction read shipment field** | Which field on `GET /transactions/{txnType}/{uuid}` reports shipments. The void guard needs it |
| **`PARTNER_ADDRESS_DELETE`** | The path is inferred from convention; never observed |
| **Ids or names on the reads** | This build takes internal ids and returns both. The agreed examples used names, which are neither unique nor stable |
