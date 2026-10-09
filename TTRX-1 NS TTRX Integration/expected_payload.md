# RapidBridge SuiteApp — Expected Payloads

**Every body on the wire, in both directions, exactly as the code sends and accepts it.**

| | |
|---|---|
| Generated from | `jj_rb_sync.js`, `jj_rb_txn.js`, `jj_rl_rb_read.js`, `jj_rl_rb_write.js`, `jj_rb_core.js` |
| Code state | Pass 35 |
| Supersedes | every earlier copy of this file |

---

## 0. How to read this document

**The key set is fixed.** Outbound bodies never omit a key. A value with nothing behind it is sent
as an **empty string**, never `null` and never left out — `txt()` in `jj_rb_sync.js` collapses
`null`, `undefined` and blank to `''`. A key that is missing from a body below is missing from the
wire; a key shown as `""` is always present.

**Encoding.** The default is `application/x-www-form-urlencoded`; JSON is used only when the
RapidBridge Configuration's Content Type contains `json`. Under form encoding an object or array
value is `JSON.stringify`-ed, and a boolean becomes the string `"true"` / `"false"`. The JSON shown
here is the logical body.

**Key order** is the order the code builds them in, which is the order they go on the wire. It is
not significant to the destination, but it is what you will see in the Sync Log's stored payload.

**Two keys are on the wire but excluded from change detection** — `custom_uuid` and
`transaction_uuid` (`COMPARE_IGNORE`). A change in either does not, on its own, cause a re-send.

**Inbound calls always answer HTTP 200**, success or refusal. Branch on `success`, never on the
status code.

---

# PART 1 — OUTBOUND  (NetSuite → RapidBridge Middleware)

## 1. Endpoints

`{base}` = Configuration **Domain** + `/` + **Version** when a version is set.

| Record | Create | Update | Delete |
|---|---|---|---|
| Dosage Form | `POST /products/pharmaceutical/dosage_forms` | `PUT …/dosage_forms/{uuid}` | `DELETE …/dosage_forms/{uuid}` |
| Location | `POST /locations` | `PUT /locations/{uuid}` | `DELETE /locations/{uuid}` |
| Customer / Vendor | `POST /trading_partners` | `PUT /trading_partners/{uuid}` | `DELETE /trading_partners/{uuid}` |
| Item (per UOM row) | `POST /products` | `PUT /products/{uuid}` | `DELETE /products/{uuid}` |
| Bin | `POST /locations/{locationUuid}/storage_areas` | `PUT …/storage_areas/{uuid}` | `DELETE …/storage_areas/{uuid}` |
| Partner address | `POST /trading_partners/{uuid}/addresses` | `PUT …/addresses/{address_uuid}` | `DELETE …/addresses/{address_uuid}` |
| Location address | `POST /locations/{uuid}/addresses` | `PUT …/addresses/{address_uuid}` | `DELETE …/addresses/{address_uuid}` |
| Transaction | `POST /transactions/{txnType}` | `PUT /transactions/{txnType}/{uuid}` | `DELETE /transactions/{txnType}/{uuid}` |
| Transaction read | `GET /transactions/{txnType}/{uuid}` | — | — |

**A blank path segment throws** rather than producing `//`. A bin whose location has no UUID is
never sent.

### `{txnType}` is not one constant

| Call | Sales Order | Purchase Order |
|---|---|---|
| create / update / void / read | `sales` | `purchase` |
| list | **`sale`** | `purchase` |

The list token is singular on the sales side. It has no endpoint of its own in this SuiteApp; it
exists because the destination spells that path differently.

### Confirm before go-live

- The two **address delete** paths are *inferred*. The reference build never deleted an address.
- `sku` carries the NetSuite **item id**, not the NDC. Confirm if TrackTraceRX keys on `sku`.

---

## 2. Master-data bodies

### 2.1 Dosage Form — 3 keys

```json
{
  "code": "TAB",
  "name": "Tablet",
  "is_active": true
}
```

**No `custom_uuid`.** It is the only master-data body without one; the UUID travels in the URL on
an update.

| Key | Source |
|---|---|
| `code` | `custrecord_jj_rb_df_code` |
| `name` | native `name` |
| `is_active` | `NOT isinactive` |

Gated by **Use Dosage Form** on the Configuration. Off ⇒ no Dosage Form ever syncs.

### 2.2 Location — 12 keys

```json
{
  "custom_uuid": "",
  "name": "Main Warehouse",
  "gs1_id": "0312345",
  "gs1_sgln": "0312345.001.0",
  "parent_location_uuid": "",
  "location_detail": "2",
  "is_unselectable_location": false,
  "manufacturing_location_prefix_or_suffix_id_value": "",
  "location_lat": "40.7128",
  "location_long": "-74.0060",
  "is_active": true,
  "create_default_storage_area": true
}
```

| Key | Source | Note |
|---|---|---|
| `custom_uuid` | `custrecord_jj_rb_location_uuid` | `""` on create |
| `gs1_id` | `custrecord_jj_rb_loc_gs1_id` | |
| `gs1_sgln` | `custrecord_jj_rb_loc_sgln` | |
| `parent_location_uuid` | parent Location's stored UUID | the parent is pre-synced first |
| `location_detail` | native `locationtype` | the **internal id**, not the label |
| `is_unselectable_location` | literal `false` | |
| `manufacturing_location_prefix_or_suffix_id_value` | literal `""` | never sourced |
| `location_lat` / `location_long` | native `latitude` / `longitude` | |
| `create_default_storage_area` | literal `true` | **currently unconditional** |

**The address is not in this body.** It is its own call — see §2.5.

> `create_default_storage_area` was meant to be `(!custom_uuid && useBins !== true)` — create the
> default storage area only on a first send and only where the account does not manage its own
> bins. That condition is commented out and the literal `true` is live. In a bin-managed account
> this asks the Middleware to create a storage area that NetSuite will then also sync as a Bin.
> **Decide this before go-live.**

### 2.3 Trading Partner — Customer and Vendor, 35 keys

One builder serves both. The only differences are `type` and whether `parent_tp_uuid` can be
non-empty.

```json
{
  "custom_uuid": "",
  "name": "Acme Pharma Inc",
  "gs1_id": "0312345",
  "gs1_company_id": "",
  "gs1_sgln": "",
  "type": "CUSTOMER",
  "parent_tp_uuid": "",
  "customer_id": "CUST-1001",
  "friendly_name": "",
  "default_billing_address_uuid": "a1b2…",
  "default_shipping_address_uuid": "c3d4…",
  "phone": "212-555-0100",
  "phone_ext": "",
  "notification_email": "ap@acme.example",
  "new_trx_notification_type": "ALL",
  "flag_notification_name": "",
  "flag_notification_email": "",
  "flag_notification_phone": "",
  "flag_notification_phone_ext": "",
  "external_reference": "4721",
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

| Key | Source |
|---|---|
| `custom_uuid` | `custentity_jj_rb_uuid` |
| `name` | a person ⇒ `altname` ‖ `companyname`; a company ⇒ `companyname` ‖ `altname`; then ‖ `entityid` |
| `gs1_id` | `custentity_jj_rb_gln` |
| `type` | `CUSTOMER` or `VENDOR` |
| `parent_tp_uuid` | the parent Customer's UUID. **Customer only** — a vendor has no parent field, so it is always `""` |
| `customer_id` | `entityid`. **The key is `customer_id` on a vendor too** |
| `default_billing_address_uuid` | the address-book line flagged `defaultbilling`, its `custrecord_jj_rb_addr_uuid`. `""` unless Use Address is on |
| `default_shipping_address_uuid` | same, `defaultshipping` |
| `phone` / `notification_email` | native `phone` / `email` |
| `external_reference` | the NetSuite internal id |
| `is_active` | `NOT isinactive` |

Everything not in that table is a literal and never sourced.

**Spellings that look like typos and are not:** `is_send_outbond_epcis` and `is_send_outbond_x12`
(not *outbound*); `3pl_is_our_company_is_internal_entity_of_tp` begins with a digit;
`is_enable_transmit_outbound_850` is an **empty string** while every neighbouring flag is a boolean
`false`.

### 2.4 Product — one call per UOM Detail row, 30 keys

**One item does not produce one product.** Each active row of the item's UOM Detail child record is
its own product at the destination, with its own `custom_uuid`. An item with Each, Bottle and Case
is three `POST /products` calls.

```json
{
  "custom_uuid": "",
  "type": "Pharmaceutical",
  "gs1_company_prefix": "0312345",
  "gs1_id": "00312345678906",
  "upc": "312345678906",
  "sku": "AMOX-500",
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
      "name": "Amoxicillin 500mg Tablet",
      "description": "Amoxicillin 500mg Tablet, 100 count bottle",
      "composition": "",
      "product_long_name": "Amoxicillin 500mg Tablet, 100 count bottle"
    }
  ],
  "update_product_identifiers": true,
  "product_identifiers": [
    { "identifier_code": "US_NDC", "value": "1234-5678-90" }
  ],
  "pack_size": "100",
  "pack_size_type_id": "1",
  "update_requirements": false,
  "update_packaging": false,
  "class_pharmaceutical__strength": "500mg",
  "class_pharmaceutical__dosage_form": "TAB",
  "class_pharmaceutical__generic_name": "Amoxicillin",
  "is_leaf_product": true,
  "is_override_products_packaging_type_validation": false,
  "gtin14": "00312345678906",
  "update_composition": false,
  "composition": "",
  "is_bin_managed": true,
  "bin_feature_enabled": true
}
```

| Key | Source |
|---|---|
| `custom_uuid` | the UOM row's `custrecord_jj_rb_uom_uuid` |
| `type` | Configuration **Product Class**, default `Pharmaceutical` |
| `gs1_company_prefix` | `custrecord_jj_rb_uom_gs1_prefix` |
| `gs1_id` | `custrecord_jj_rb_uom_gs1_id` |
| `upc` | the UOM row's UPC, else the item's `upccode` |
| `sku` | the item's `itemid` |
| `status` | `AVAILABLE`, or `RETIRED` when the item is inactive |
| `product_descriptions[0].name` | `displayname` ‖ `itemid` |
| `product_descriptions[0].description` | `purchasedescription` ‖ `displayname` ‖ `itemid` |
| `product_descriptions[0].product_long_name` | `purchasedescription` |
| `update_product_identifiers` | `true` only when the UOM row has an NDC |
| `product_identifiers[0].value` | `custrecord_jj_rb_uom_ndc` |
| `pack_size` | `custrecord_jj_rb_uom_pack_size` |
| `pack_size_type_id` | the Configuration's Pack Size Map, keyed on the unit name upper-cased. **Unmapped ⇒ `"1"`**, with an audit line |
| `class_pharmaceutical__strength` | `custitem_jj_rb_strength` — **double underscore** |
| `class_pharmaceutical__dosage_form` | the dosage form's **code**, not its name or id |
| `class_pharmaceutical__generic_name` | `custitem_jj_rb_generic_name` |
| `is_leaf_product` | `pack_size_type_id === "1"` |
| `gtin14` | `custrecord_jj_rb_uom_gtin` |
| `update_composition` | `true` only when there is a composition. **`true` with an empty `composition` removes it at the destination** |
| `composition` | a **JSON-encoded string**, e.g. `"[{\"<baseUuid>\":\"12\"}]"`. Never an array |
| `is_bin_managed` | account has BINMANAGEMENT **and** Use Bins is on **and** the item's `usebins` |
| `bin_feature_enabled` | the account has BINMANAGEMENT |

`product_descriptions[0].composition` is a separate, always-empty key. Do not confuse it with the
top-level one.

### 2.5 Address — 12 keys

The same body serves a Customer's address book, a Vendor's, and the Location's main address. The
parent decides the URL.

```json
{
  "address_nickname": "Main Address",
  "address_gs1_id": "",
  "gs1_sgln": "0312345.001.0",
  "recipient_name": "Acme Pharma Inc",
  "line1": "100 Industrial Way",
  "line2": "Suite 400",
  "country_code": "US",
  "state": "NJ",
  "city": "Newark",
  "zip": "07102",
  "phone": "212-555-0100",
  "is_licence_required": false
}
```

| Key | Source |
|---|---|
| `address_nickname` | the address-book `label`, else `Address 2`, `Address 3`…; a Location's is always `Main Address` |
| `address_gs1_id` | literal `""` — no NetSuite field exists for it |
| `gs1_sgln` | `custrecord_jj_rb_addr_sgln` on the address subrecord |
| `recipient_name` | the subrecord's `addressee`, else the parent's name |
| `line1` / `line2` | `addr1` / `addr2` |
| `state` | **free text, as the record spells it.** There is no `state_id` |
| `phone` | `addrphone` on the subrecord, **not** the entity's `phone` |
| `is_licence_required` | literal `false` — British spelling |

An address line with no `addr1`, no `city` **and** no `zip` is skipped entirely — it never reaches
the wire.

Gated by **Use Address** on the Configuration, and capped at **Max Inline Calls** (default 5)
address calls per save; the rest are deferred.

### 2.6 Bin → Storage Area — 6 keys

```json
{
  "custom_uuid": "",
  "name": "HOLD-01",
  "properties": "COLD;FROZEN",
  "is_storage_conditions_verification_disabled": false,
  "is_active": true,
  "code": "Quarantine hold, dock 3"
}
```

**The location is not in the body.** It is a path segment: `/locations/{locationUuid}/storage_areas`.
The Location is pre-synced first, and a bin whose location has no UUID is never sent.

| Key | Source |
|---|---|
| `custom_uuid` | `custrecord_jj_rb_bin_uuid` |
| `name` | `binnumber` |
| `properties` | see below |
| `is_storage_conditions_verification_disabled` | `Use Dosage Form` is **off** |
| `is_active` | `NOT inactive` |
| `code` | the bin's `memo`. NetSuite's Bin has no code field; the memo stands in |

**`properties` is a semicolon-separated STRING**, never an array and never null. A bin with no
special conditions sends `""`.

```
""   "COLD"   "COLD;FROZEN"   "COLD;FROZEN;RESTRICTED_ACCESS"
```

Order is forced to `COLD`, `FROZEN`, `RESTRICTED_ACCESS` whatever order the multi-select holds, so
re-ordering the selection cannot look like an edit and fire a pointless update. Values are
upper-cased with spaces and hyphens turned into underscores, so *Restricted Access* and
*restricted-access* both become `RESTRICTED_ACCESS`.

**An unrecognised property is a refusal, not a silent drop.** The preflight gate fails the sync
with `needsHuman`, names the offending value and the three legal ones, and **spends no API call**.

Two platform facts this record forced, both undocumented by NetSuite:

- `record.submitFields` **fails on a Bin** when setting custom fields — "Unexpected Error". The
  SuiteApp loads and saves instead (`util.writeFields`).
- The Bin's active flag is spelled **`inactive`**, not `isinactive`, in search and lookup. The
  wrong spelling returns `undefined`, which is a silent wrong answer, not an error.

### 2.7 Inactivation and deletion

Two shapes, chosen by the Configuration's **Inactive Method**:

| Method | What is sent |
|---|---|
| `PUT_IS_ACTIVE_FALSE` *(default)* | the full body again with `is_active: false` |
| `DELETE` | `DELETE {endpoint}/{uuid}`, **no body** |

A real NetSuite record delete always uses the DELETE endpoint regardless of the setting, because
there is no record left to build a body from.

---

## 3. Transaction bodies

One builder serves both orders. A **sales order sends 17 keys**, a **purchase order 16** — the PO
omits `outbound_transaction_sub_type` entirely rather than sending it blank.

### 3.1 Purchase Order

```json
{
  "transaction_uuid": "",
  "custom_id": "PO447",
  "location_uuid": "f1e2d3c4-…",
  "trading_partner_uuid": "a9b8c7d6-…",
  "transaction_date": "2026-09-30",
  "billing_address_uuid": "11111111-…",
  "ship_from_address_uuid": "22222222-…",
  "ship_to_address_uuid": "11111111-…",
  "sold_by_address_uuid": "33333333-…",
  "line_items": "[{\"product_uuid\":\"p1\",\"quantity\":2,\"sort_order\":\"1\"}]",
  "is_approved": true,
  "is_approved_is_ship_transaction": false,
  "is_manually_close_transaction": false,
  "enforce_oci": false,
  "order_nbr": "PO447",
  "po_nbr": "PO447"
}
```

### 3.2 Sales Order

Identical, plus one key, last:

```json
{
  "…": "…",
  "po_nbr": "SO610",
  "outbound_transaction_sub_type": "SALES"
}
```

### 3.3 The keys

| Key | Source |
|---|---|
| `transaction_uuid` | `custbody_jj_rb_uuid`. `""` on create. On the wire, but excluded from change detection |
| `custom_id`, `order_nbr`, `po_nbr` | **all three carry `tranid`.** Same value, three times |
| `location_uuid` | the header location's stored UUID, falling back to line 1's location. **Blank blocks the send** |
| `trading_partner_uuid` | the customer's or vendor's stored UUID. **Blank blocks the send** |
| `transaction_date` | `trandate` as `YYYY-MM-DD` |
| `line_items` | **a JSON-encoded string**, always. `"[]"` is possible in principle, but an order with no eligible line never reaches here |

### 3.4 `line_items` — 3 keys per element

```json
[
  { "product_uuid": "d4c3b2a1-…", "quantity": 2, "sort_order": "1" }
]
```

| Key | Type | Source |
|---|---|---|
| `product_uuid` | string | the UOM Detail row whose Saleable Unit matches **this line's unit**. A line with no UUID **blocks the whole order** |
| `quantity` | number | the quantity **in the line's own unit**, against the product resolved for that unit. Not converted to base units |
| `sort_order` | **string** | the NetSuite line number |

A line travels only when it is **eligible** (`custcol_jj_rb_serialized`), **not closed**, and
**quantity > 0**. Tax, COGS and shipping rows never travel.

> **Open with TrackTraceRX.** `quantity` is in the line's unit, not base units. The product
> identified by `product_uuid` is the one for that unit, so the pair is self-consistent — but
> confirm the destination reads it that way.

### 3.5 Address roles are reversed between the two

| Body key | Sales Order | Purchase Order |
|---|---|---|
| `billing_address_uuid` | the **partner's** billing address | the **location's** address |
| `ship_to_address_uuid` | the **partner's** shipping address | the **location's** address |
| `ship_from_address_uuid` | the **location's** address | the **partner's** shipping address |
| `sold_by_address_uuid` | the **location's** address | the **partner's** billing address |

Read it as: *we* are the location, *they* are the partner. Goods leave us on a sales order and
arrive at us on a purchase order, and the four roles follow.

All four keys are always present. They are `""` unless **Use Address** is on; the location side
additionally needs location address sync to be on.

The partner's address is taken from the **order's own** Billing and Shipping address subrecords
first, falling back to the entity's address book defaults.

### 3.6 The four fixed flags

| Key | Value | Why |
|---|---|---|
| `is_approved` | `true` | the order only syncs from a status the integration recognises |
| `is_approved_is_ship_transaction` | **always `false`** | marking it a ship transaction creates a shipment at the destination. A partial fulfilment would then leave a phantom shipment against a quantity that never moved |
| `is_manually_close_transaction` | `false` on a create or update | set `true` only by the close call |
| `enforce_oci` | `false` | |

### 3.7 Close, cancel and void

The crossing test decides *whether* to call; the Configuration's **Close Action** decides *what*.

| Close Action | Call |
|---|---|
| `MARK_CLOSED` *(default, and blank means this)* | `PUT /transactions/{txnType}/{uuid}` |
| `DELETE` | `DELETE /transactions/{txnType}/{uuid}`, no body |
| `NONE` | no call at all |

**A `MARK_CLOSED` body is the last payload the Middleware accepted, replayed**, with exactly two
keys overwritten:

```json
{
  "…every key of the last accepted body…": "…",
  "is_manually_close_transaction": true,
  "transaction_uuid": "f1e2d3c4-…"
}
```

It is **not rebuilt from the order.** A closed order has all its lines closed, so a fresh build
would carry an empty `line_items` and the update is a full replace — the close would also empty the
order at the destination. If the stored payload is missing or unparseable, **no call is made** and
a review work item is opened.

**A void is guarded.** Before any `DELETE`, the SuiteApp calls
`GET /transactions/{txnType}/{uuid}` and refuses the void if the response reports any shipment. If
the read fails, is suppressed, dry-run or kill-switched, **the void is refused** — never assumed
safe. If the response names no shipment field at all, that is read as "no shipments" and the void
proceeds, with an audit line saying so.

On a successful void the UUID is **kept**; only `custbody_jj_rb_synced` → false and
`custbody_jj_rb_payload` → `""` are cleared.

A genuine NetSuite record delete is always a void, whatever Close Action says.

> **Confirm with TrackTraceRX** which field of the transaction read reports shipments. The guard
> probes `shipments[]`, `shipment_uuids[]`, `nb_shipments`, `shipment_count` and `shipment_uuid`,
> and treats "none of these present" as zero.

---

# PART 2 — INBOUND  (Middleware → NetSuite)

Two RESTlets. Both answer **HTTP 200** whatever happens; branch on `success`.

| | Script | Operations |
|---|---|---|
| **Writes** | `jj_rl_rb_write.js` | `item_receipt`, `item_fulfillment`, `identifier`, `inventory_release` |
| **Reads** | `jj_rl_rb_read.js` | `list_transactions`, `fetch_transaction`, `fulfilment_exceptions`, `allowed_bins_for_item`, `bins_for_location`, `bin_contents`, `item_availability` |

**Operation names are exact and case-sensitive.** Note `fulfilment_exceptions` has one `l` and
`item_fulfillment` has two. An operation sent to the wrong RESTlet comes back
`UNKNOWN_OPERATION`.

**The envelope.**

```json
{ "success": true,  "…operation keys…": "…" }
{ "success": false, "error_code": "CODE", "error_message": "A sentence." }
```

A failure that is about lines adds `failed_lines`. A read that has something to say adds `notes`.

---

## 4. `item_receipt` and `item_fulfillment`

`POST {base}?script={writeScript}&deploy=1`

### 4.1 Request

```json
{
  "operation": "item_receipt",
  "request_uuid": "8f14e45f-ceea-467a-9f12-3c1a2b3c4d5e",
  "order_id": "16050",
  "shipment_uuid": "8dacc081-40be-4c7c-9f3a-ca21ab6366ce",
  "transaction_date": "30/09/2026",
  "memo": "Verified against TrackTraceRX shipment",
  "hold_bin": "936",
  "good_bin": "940",
  "lines": [
    {
      "line_unique_key": "1",
      "item_id": "718",
      "quantity": 24,
      "bin": "936",
      "good_bin": "940",
      "exception_reason": "Damaged in transit",
      "exception_note": "Two cases crushed, photographed on the dock",
      "exception_quantity": 2,
      "inventory": [
        { "lot": "LOT-2026-0815", "quantity": 14, "expiry": "2027-05-31",
          "bin": "936", "good_bin": "940" },
        { "lot": "LOT-2026-0901", "quantity": 10, "expiry": "2028-06-30",
          "bin": "937", "good_bin": "941" }
      ]
    }
  ]
}
```

#### Body

| Field | | |
|---|---|---|
| `operation` | **yes** | `item_receipt` or `item_fulfillment` |
| `request_uuid` | **yes** | goes into the record's native `externalId`. The duplicate guard |
| `order_id` | **yes** | the Purchase Order or Sales Order internal id |
| `shipment_uuid` | no | stored on the record. The `identifier` call can supply it later instead |
| `transaction_date` | no | `DD/MM/YYYY`, `YYYY-MM-DD` or a NetSuite-parseable date |
| `memo` | no | |
| `bin` / `hold_bin` | no | the whole submission's bin. `bin_id` / `hold_bin_id` accepted |
| `good_bin` / `to_bin` | no | **receipt only.** Recorded for the release, never used now. `good_bin_id` / `to_bin_id` accepted |

#### Line

| Field | | |
|---|---|---|
| `line_unique_key` | **yes** | the order's `orderline`. Echoed back verbatim on failure |
| `item_id` | no | validated against the order line if sent |
| `quantity` | **yes** | may not exceed what the order line has outstanding |
| `bin` / `hold_bin` | no | this line's bin |
| `good_bin` / `to_bin` | no | receipt only |
| `exception_reason` | see §4.3 | a **name** from the Fulfilment Exception list |
| `exception_note` | no | prose |
| `exception_quantity` | no | defaults to the full shortfall when a reason is given |
| `inventory[]` | required for a tracked item | one row per lot or serial |

#### `inventory[]` row

| Field | | |
|---|---|---|
| `lot` | for a lot-tracked item | the lot NAME. Created if it does not exist |
| `serial` | for a serial-tracked item | one row per serial |
| `quantity` | lot rows | a serial row defaults to 1 |
| `expiry` / `expiration_date` | no | |
| `bin` / `hold_bin` | no | **this lot's** bin. Two lots on one line may go to two bins |
| `good_bin` / `to_bin` | no | **this lot's** release destination |

### 4.2 The bin ladder

It forks on **eligibility** — whether the item is one TrackTraceRX tracks, read through the
Configuration's Eligibility Field.

**An ELIGIBLE item goes on hold:**

```
inventory row `bin` → line `bin` → body `bin` → LOCATION On-Hold Bin → CONFIG Default Bin
```

**A NON-ELIGIBLE item must land where it can be picked:**

```
inventory row `bin` → line `bin` → body `bin`
  → inventory row `good_bin` → line `good_bin` → body `good_bin`
  → LOCATION Good Bin
```

Nothing will ever release a non-tracked item, so the on-hold bin is a gate that never opens for it.
The Configuration's Default Bin is **not** on that path — it is the receiving default.

**A FULFILMENT has no rung below the payload** for either kind. Stock is being issued and only the
device knows which bin it came out of. An eligible fulfilment line with no bin is refused; a
non-eligible one is left to NetSuite.

Reaching the bottom of a ladder with nothing, on an item that uses bins, is `BIN_REQUIRED`. The
message names the location and the field to set, and the field differs between the two ladders.

**The good bin at receipt time is recorded, never used.** A receipt never moves stock to a good
bin. It is validated to the same standard as the hold bin — it must exist, be at the order's
location, and not be the hold bin — and then written to the line's Bin / Lot Map for the release
that comes days later.

### 4.3 Exceptions

A partial receipt is **not** an exception. A line that receives less than the order had outstanding
is an ordinary short receipt and needs no reason.

An **eligible** line that is short **and declares a reason** records the shortfall:

- `exception_reason` must be a **name** on the Fulfilment Exception list. Fetch the list with
  `fulfilment_exceptions`.
- `exception_quantity` defaults to the full shortfall. Sending one larger than the shortfall is
  `BAD_QUANTITY`; sending one without a reason is `EXCEPTION_REASON_REQUIRED`.
- The quantity is written to every line as a number, **zero included**, and totalled on the
  document. A blank means the line predates the field, not that nothing was short.

### 4.4 Success

```json
{
  "success": true,
  "internal_id": "2481003",
  "external_id": "8f14e45f-ceea-467a-9f12-3c1a2b3c4d5e",
  "lines_posted": 1,
  "exception_quantity": 2,
  "exception_lines": [
    {
      "line_unique_key": "1",
      "item_id": "718",
      "exception_quantity": 2,
      "exception_reason": "Damaged in transit",
      "exception_note": "Two cases crushed, photographed on the dock"
    }
  ]
}
```

A **fulfilment** adds one key, last:

```json
{ "…": "…", "shipping_status": "Shipped" }
```

`exception_quantity` is `0` and `exception_lines` is `[]` when nothing was short.

### 4.5 A resend of the same `request_uuid`

```json
{
  "success": true,
  "internal_id": "2481003",
  "external_id": "8f14e45f-ceea-467a-9f12-3c1a2b3c4d5e",
  "duplicate": true,
  "lines_posted": 1
}
```

**A success, not a refusal.** The record already exists and nothing was created twice. Note the
absent `exception_quantity` and `exception_lines` — a duplicate answer does not re-derive them.

### 4.6 Failure

**Nothing is created unless every line passes.** There is no partial save.

```json
{
  "success": false,
  "error_code": "LINE_VALIDATION_FAILED",
  "error_message": "2 line(s) failed validation, so nothing was created. Correct them and resubmit with a new request_uuid.",
  "failed_lines": [
    {
      "line_unique_key": "1",
      "error_code": "QTY_EXCEEDS_REMAINING",
      "error_message": "Line 1 submits 30 of Amoxicillin 500mg Tablet (718) but only 24 is left on the order. Over-receipt on a regulated product is a discrepancy to investigate, not a quantity to accept."
    },
    {
      "line_unique_key": "2",
      "error_code": "BIN_REQUIRED",
      "error_message": "No bin for lot \"LOT-2026-0901\" on line 2 (Ibuprofen 200mg (716)). The item is eligible for TrackTraceRX, so its stock goes ON HOLD until a release moves it. Send `bin` on the inventory row — different lots may go to different bins — or on the line, or on the body. Nothing answered below that either: location Main Warehouse (5) has no On-Hold Bin and the RapidBridge Configuration has no Default Bin."
    }
  ]
}
```

A document-level refusal has no `failed_lines`:

```json
{
  "success": false,
  "error_code": "ORDER_NOT_SYNCED",
  "error_message": "Order PO447 (16050) has no TrackTraceRX transaction identifier, so it was never sent and cannot be scanned against."
}
```

**Resubmit with a NEW `request_uuid`.** The old one may already be claimed, and an identical replay
of a rejected payload would meet the same disagreement.

---

## 5. `identifier` — store the shipment UUID

`PUT {base}?script={writeScript}&deploy=1`

The second call of the two-call protocol. The document is created first and told what it is
afterwards, so an offline device that replays a queued submission cannot create a second record.

### Request

```json
{
  "operation": "identifier",
  "request_uuid": "8f14e45f-ceea-467a-9f12-3c1a2b3c4d5e",
  "shipment_uuid": "8dacc081-40be-4c7c-9f3a-ca21ab6366ce",
  "record_type": "itemreceipt",
  "internal_id": "2481003"
}
```

| Field | | |
|---|---|---|
| `operation` | **yes** | `identifier` |
| `shipment_uuid` | **yes** | `tracktrace_uuid` and `uuid` also accepted |
| `internal_id` | one-of | address the record directly |
| `request_uuid` | one-of | find it by the `externalId` the create claimed |
| `record_type` | no | `itemreceipt` or `itemfulfillment`. Defaults to the receipt |

### Response

```json
{
  "success": true,
  "internal_id": "2481003",
  "external_id": "8f14e45f-ceea-467a-9f12-3c1a2b3c4d5e",
  "shipment_uuid": "8dacc081-40be-4c7c-9f3a-ca21ab6366ce"
}
```

**There is no uniqueness check on `shipment_uuid`, deliberately.** One shipment covering three
purchase orders produces three receipts that all carry its UUID, and every one of them is correct.
The duplicate guard is `request_uuid` in the native `externalId`, which the platform enforces.

---

## 6. `inventory_release` — the Bin Transfer

`POST {base}?script={writeScript}&deploy=1`

The last step of a receipt. Received eligible stock sits in the on-hold bin until TrackTraceRX
verifies it; this call moves exactly the lots that passed into a good bin.

### 6.1 The ordinary case — the receipt already knows the bins

```json
{
  "operation": "inventory_release",
  "request_uuid": "f7c1a2b3-4d5e-4f60-8a1b-2c3d4e5f6071",
  "order_id": "16050",
  "item_receipt_internal_id": "2481003",
  "transaction_date": "08/10/2026",
  "memo": "TrackTraceRX verification passed",
  "lines": [
    { "line_unique_key": "1", "item_id": "718", "lot": "LOT-2026-0815", "quantity": 24 },
    { "line_unique_key": "2", "item_id": "718", "lot": "LOT-2026-0901", "quantity": 10 }
  ]
}
```

No bins on the payload. The receipt's Bin / Lot Map answers per lot, and the location answers where
it did not.

### 6.2 Overriding the bins

```json
{
  "operation": "inventory_release",
  "request_uuid": "a1b2c3d4-0000-4000-8000-000000000002",
  "item_receipt_internal_id": "2481003",
  "from_bin": "77",
  "good_bin": "95",
  "lines": [
    { "line_unique_key": "1", "item_id": "718", "lot": "LOT-A", "quantity": 24 },
    { "line_unique_key": "2", "item_id": "718", "lot": "LOT-B", "quantity": 10,
      "good_bin": "96" }
  ]
}
```

### 6.3 A lot the receipt split across two good bins

The receipt recorded 10 → bin 96 and 14 → bin 95. Release each part with the quantity the receipt
recorded and the bins resolve themselves:

```json
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

### 6.4 Fields

#### Body

| Field | | |
|---|---|---|
| `operation` | **yes** | `inventory_release` |
| `request_uuid` | **yes** | becomes the Bin Transfer's `externalId`, and the ledger's duplicate guard |
| `item_receipt_internal_id` | **effectively yes** | `receipt_internal_id` accepted. The receipt carries the ledger; without it the release is refused |
| `shipment_uuid` | alternative | finds the receipt when the internal id is not sent |
| `order_id` | no | validated if sent; supplies the location |
| `location_id` | no | a Bin Transfer cannot cross locations. Taken from the order or the receipt otherwise |
| `from_bin` / `hold_bin` | no | the source. `from_bin_id` / `hold_bin_id` accepted |
| `good_bin` / `to_bin` | no | the destination. `good_bin_id` / `to_bin_id` accepted |
| `transaction_date` | no | |
| `memo` | no | defaults to `RapidBridge inventory release {request_uuid}` |

#### Line

| Field | | |
|---|---|---|
| `line_unique_key` | **yes** | echoed back verbatim |
| `item_id` | **yes** | must be **eligible**. A non-tracked item was never held, so there is nothing to release — `NOT_ELIGIBLE` |
| `lot` | yes for a tracked item | the NAME TrackTrace printed. `lot_number` / `lot_name` accepted. Trimmed and matched case-insensitively |
| `quantity` | **yes** | may not exceed what this receipt has left to release |
| `from_bin` / `good_bin` | no | per-line override, beats everything |

### 6.5 The release's bin ladder

```
1. the release LINE's own `good_bin`
2. the release BODY's `good_bin`
3. THE GOOD BIN THE RECEIPT RECORDED FOR THAT LOT
4. the LOCATION's Good Bin
```

`from_bin` reads the same ladder with the receipt's hold bin at rung 3 and
`LOCATION On-Hold Bin → CONFIG Default Bin` at rung 4.

Rung 3 is the only one that can differ between two lots of one item at one site. It sits below the
payload because a release that names a bin is a decision somebody is making now, and above the
location because a site-wide setting cannot know which lot this is.

**Which entry rung 3 uses, when the receipt split a lot:**

| Situation | Answer |
|---|---|
| nothing recorded | fall through to rung 4 |
| one entry | that one, whatever the quantity |
| an exact match on an entry's remaining quantity | that one |
| several entries, all agreeing on one good bin | that bin |
| anything else | **no answer — the line is refused** |

A release of 7 against a 10/4 split is `BIN_NOT_CONFIGURED`, listing both parts. Name `good_bin` on
the line, or release each part with the quantity the receipt recorded. Nothing is guessed: a wrong
bin on a regulated lot is the failure this record exists to prevent.

### 6.6 The release ledger

A Long Text field on the Item Receipt, `custbody_jj_rb_release_log`, is **the authority on what may
still move.**

```json
{
  "receipt": "2481003",
  "seq": 3,
  "updated": "2026-10-08T10:11:12.000Z",
  "lots": {
    "718|901": { "item": "718", "lot": "LOT-2026-0815", "lotId": "901",
                 "received": 24, "released": 20, "h": "77", "g": "95" },
    "718|902": { "item": "718", "lot": "LOT-2026-0901", "lotId": "902",
                 "received": 10, "released": 6,
                 "b": [[6, "", "96", 6], [4, "", "95", 0]] }
  },
  "calls": [
    { "uuid": "f7c1…", "bt": "2492118", "at": "2026-10-08T10:11:12.000Z",
      "moved": [{ "k": "718|901", "q": 20 }] }
  ],
  "bts": ["2492118"],
  "callCount": 3
}
```

| Key | |
|---|---|
| `lots[itemId\|lotId].received` / `.released` | the pair that answers "may this move?" |
| `.h` / `.g` | the hold and good bins the receipt recorded for that lot |
| `.b` | `[quantity, hold, good, releasedSoFar]` per part, for a lot the receipt split |
| `calls` | capped at 50. `lots` and `callCount` are never trimmed — they are the guard |
| `bts` | every Bin Transfer that has released against this receipt |

**Why it exists.** `request_uuid` in the `externalId` catches a resend of the same call, but not a
retry carrying a fresh uuid — which is exactly what a middleware retry after a timeout looks like.
The on-hold bin's balance catches neither: it is **shared** between receipts, so a balance of 24
says nothing about whose 24 it is, and it **lags**, because `inventorybalance` is a search index. The
ledger is per receipt, is a stored field that reads back immediately, and records what was received
per lot alongside what has been released per lot.

**Unparseable JSON is not silently replaced with an empty ledger.** That would hand a duplicate
release a clean slate — the one outcome the field exists to prevent. The release fails loudly.

### 6.7 The Bin Transfer's shape

**One inventory line per item**, carrying the total, with one inventory-assignment row per
movement:

```json
[{ "item": "718", "quantity": 34, "inventory": [
  { "lot": "901", "quantity": 24, "from_bin": "77", "to_bin": "95" },
  { "lot": "902", "quantity": 6,  "from_bin": "79", "to_bin": "96" },
  { "lot": "902", "quantity": 4,  "from_bin": "79", "to_bin": "95" }
]}]
```

The last two rows are the **same lot** out of one hold bin into two different good bins — what a
shared on-hold bin produces, and what no line-level pair of bins can express.

Line-level `binnumber` / `tobinnumber` are set only when the whole line agrees on them.

**One exception:** an item that is neither lot nor serial tracked has no inventory detail at all, so
for it the line **is** the move. Those group by item **and** both bins, one line per distinct
movement. A tracked item whose inventory detail subrecord will not open **throws** rather than
saving everything through the first pair of bins.

### 6.8 The balance on the receipt's own lines

Written on every release, derived from the ledger, rewritten in full:

| Column | |
|---|---|
| `custcol_jj_rb_released_qty` | how much of this line has moved to a good bin |
| `custcol_jj_rb_hold_qty` | what is left — received minus released |
| `custcol_jj_rb_released_on` | when the last release touched this line |
| `custcol_jj_rb_release_bin` | where it went, when the whole line agreed on one |

Both numbers are always written, **zero included**. **Nothing reads them back** — the ledger stays
the authority. A number a human can edit is not a duplicate guard.

Body fields, also rewritten each time: `custbody_jj_rb_released_qty`, `custbody_jj_rb_held_qty`,
`custbody_jj_rb_released_at`, `custbody_jj_rb_bin_transfer` (a multiselect of every transfer) and
`custbody_jj_rb_release_log`.

### 6.9 Success

```json
{
  "success": true,
  "bin_transfer_internal_id": "2492118",
  "external_id": "f7c1a2b3-4d5e-4f60-8a1b-2c3d4e5f6071",
  "item_receipt_internal_id": "2481003",
  "order_id": "16050",
  "location_id": "13",
  "from_bin": "77",
  "to_bin": "95",
  "moved_quantity": 34,
  "released_quantity": 34,
  "held_quantity": 0,
  "received_quantity": 34,
  "fully_released": true,
  "bin_transfers": ["2492118"],
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
      "to_bin": "95"
    }
  ]
}
```

| Key | |
|---|---|
| `from_bin` / `to_bin` | the **resolved** pair, and only when every line agreed on one. **`""` otherwise** — a single document-level bin would be a half-truth once the ladder can answer per lot |
| `moved_quantity` | what THIS call moved |
| `released_quantity` / `held_quantity` / `received_quantity` | where the **receipt** stands, cumulatively. They differ from `moved_quantity` on every call after the first |
| `bin_transfers` | every transfer that has released against this receipt, in order |
| `lines_released[].from_bin` / `.to_bin` | always the per-line truth |

### 6.10 A resend

```json
{
  "success": true,
  "bin_transfer_internal_id": "2492118",
  "external_id": "f7c1a2b3-4d5e-4f60-8a1b-2c3d4e5f6071",
  "item_receipt_internal_id": "2481003",
  "duplicate": true,
  "released_quantity": 34,
  "held_quantity": 0
}
```

Two guards produce this. The `externalId` catches an identical resend before anything is read; the
ledger catches a retry whose `request_uuid` is already recorded. Either way nothing moves twice.

### 6.11 Refusals

```json
{
  "success": false,
  "error_code": "LINE_VALIDATION_FAILED",
  "error_message": "1 of 2 release line(s) failed validation, so NOTHING was moved. The stock is still in the on-hold bin. Correct the cause and resubmit with a new request_uuid.",
  "failed_lines": [
    {
      "line_unique_key": "2",
      "error_code": "ALREADY_RELEASED",
      "error_message": "All 10 of lot \"LOT-2026-0901\" of Amoxicillin 500mg Tablet (718) received on Item Receipt 2481003 has already been released. This call would move it a second time. If stock genuinely needs moving again, it is a bin transfer somebody makes in NetSuite, not a release."
    }
  ]
}
```

---

## 7. Write error codes

### Document level

| Code | When |
|---|---|
| `MALFORMED_PAYLOAD` | the body is not JSON, is empty, carries no `lines`, or an `identifier` call sent no `shipment_uuid` |
| `UNKNOWN_OPERATION` | the `operation` is not one this RESTlet serves |
| `NO_CONFIGURATION` | no active RapidBridge Configuration row |
| `FLOW_DISABLED` | Item Receipt or Item Fulfilment is switched off on the Configuration |
| `MISSING_REQUEST_UUID` | no `request_uuid`, and no `internal_id` to find the record by |
| `ORDER_NOT_FOUND` | no `order_id`, or no order of that type with that id |
| `ORDER_CLOSED` | the order is at a terminal status, or the transform refused |
| `ORDER_NOT_APPROVED` | the order's status has nothing left to receive or fulfil. The message lists the statuses that do |
| `ORDER_NOT_SYNCED` | the order has no TrackTraceRX identifier — it was never sent |
| `LOCATION_INACTIVE` | the order's location is inactive |
| `LINE_VALIDATION_FAILED` | one or more lines failed. **Nothing was created.** `failed_lines` names every one |
| `PERIOD_LOCKED` | the save was refused and the message mentions a period |
| `SAVE_REFUSED` | the save was refused for any other reason — a permission, a plug-in, a mandatory field |
| `RECORD_NOT_FOUND` | an `identifier` call found no record carrying that `request_uuid` |
| `NOTHING_TO_RELEASE` | every release line resolved to zero quantity |
| `RECEIPT_NOT_IDENTIFIED` | a release with no Item Receipt behind it. The receipt carries the ledger |
| `RECEIPT_NOT_READABLE` | the receipt carries no lot detail that could be read, so there is nothing to measure against |
| `DUPLICATE_IDENTIFIER` | declared; not raised by the current code — see §5 |
| `UNHANDLED` | a defect. Returned as this envelope rather than a NetSuite error page |

### Line level

| Code | When |
|---|---|
| `ITEM_NOT_FOUND` | the line names no item, or one that does not exist |
| `ITEM_INACTIVE` | the item is inactive |
| `LINE_NOT_ON_ORDER` | the `line_unique_key` is not a line on that order |
| `BAD_QUANTITY` | not a positive number; or an `exception_quantity` larger than the shortfall; or the inventory rows do not add up to the line quantity |
| `QTY_EXCEEDS_REMAINING` | more than the order line has outstanding |
| `LOT_INVALID` | a lot-tracked item with no lot named |
| `SERIAL_INVALID` | a serial-tracked item with a row carrying no serial |
| `SERIAL_ALREADY_ON_HAND` | that serial already exists on hand |
| `INVENTORY_DETAIL_MISSING` | a tracked item with no `inventory` array |
| `INSUFFICIENT_STOCK` | fulfilment only |
| `UOM_NOT_CONVERTIBLE` | the line's unit cannot be resolved against the item's Units Type |
| `BIN_NOT_ALLOWED` | a named bin — hold or good — does not exist |
| `BIN_INVALID_LOCATION` | a named bin is at another location. A Bin Transfer cannot cross locations |
| `BIN_REQUIRED` | the bin ladder ran out, on an item that uses bins |
| `BIN_NOT_CONFIGURED` | no from-bin or no good bin anywhere; the two are the same bin; or a release quantity matching no recorded part of a split lot |
| `BIN_MAP_TOO_LARGE` | the line's per-lot good bins exceed 4000 characters. **Never truncated** |
| `EXCEPTION_REASON_REQUIRED` | an exception quantity with no reason |
| `NOT_ELIGIBLE` | a release line naming an item TrackTraceRX does not track |
| `LOT_NOT_FOUND` | the lot name is not an on-hand lot of that item |
| `LOT_NOT_IN_BIN` | the lot exists but none of it is in the bin the release names. Somebody moved it by hand |
| `QTY_EXCEEDS_IN_BIN` | some of it is there, not all |
| `LOT_NOT_ON_RECEIPT` | the lot is not one THIS receipt received. Several receipts share one on-hold bin |
| `ALREADY_RELEASED` | everything this receipt received of that lot has already moved |
| `QTY_EXCEEDS_RECEIVED` | some is still releasable, but less than was asked for |

---

## 8. `custcol_jj_rb_bin_map` — the Bin / Lot Map

A Text Area, **4000 characters**, on Item Receipt lines only. Written by the write RESTlet, never by
hand. It is the receipt's own record of where each lot went and where the release is to take it.

The hold bin is also on the inventory detail. **The good bin is on no other NetSuite record** — a
receipt does not move stock there, the release does, and that can be days later.

```json
{"h":936,"g":940}
{"h":936,"g":940,"l":{"LOT-B":[[10,0,941],[4,0,942]]}}
```

| Key | |
|---|---|
| `h` | the line's hold bin — the one most of its rows used |
| `g` | the line's good bin |
| `l` | only the lots that **differ**, keyed on the lot or serial NAME in UPPER CASE |
| `l[name]` | a list of `[quantity, holdBin, goodBin]`. **`0` means "same as the line"** |

**17 characters for an ordinary line, whatever its lot count** — 400 lots in one good bin cost the
same as one. Only exceptions are listed.

**The quantity is part of the key.** 10 of LOT-B to the cold good bin and 4 to the ambient one is
the same name twice; nothing else in the record separates them.

**If a lot has one odd row, every row of that lot is listed.** One entry reads as "this is the whole
story", which is how a release ends up putting 4 units in the bin meant for 10.

A triple of `[quantity, 0, 0]` is not pointless: it is a row of a split lot that happens to use the
line's own bins, listed because **one** of that lot's rows differed. Verified against the code, a
lot of 24 split 10 to the line's good bin and 14 to a different one stores:

```
{"h":936,"g":940,"l":{"LOT-A":[[10,0,0],[14,0,941]]}}
```

**No version key.** The old `[hold, good]` pair and the new list of triples are told apart
structurally, which is true of the data rather than of a number somebody could edit. An old pair
parses as one entry of quantity 0, meaning "any quantity".

**Never truncated.** A line whose per-lot good bins will not fit is refused `BIN_MAP_TOO_LARGE`.
Per-lot *hold* overrides are dropped first if that buys the fit — they are recoverable from the
inventory detail — and good bins are never dropped.

**Read back once per receipt**, when the release ledger is seeded on the first release. From then
on the bins live in the ledger.

---

## 9. Inbound reads — `jj_rl_rb_read.js`

`GET {base}?script={readScript}&deploy=1&operation=…` or the same body as a `POST`.

**Both are the same contract.** Every read is documented as a GET; the identical body is accepted
as a POST, and nothing about the answer differs. A GET exists because a query string has a length
limit and no nesting; `list_transactions` takes a status list and benefits from the POST.

**A GET delivers every parameter as TEXT.** Numbers and booleans are coerced. `"false"` is not false
in JavaScript, so flags are **parsed**, not tested for truthiness: `false`, `f`, `0`, `no` are false;
`true`, `t`, `1`, `yes` are true; **anything else falls back to the default**, not to false.

### 9.1 Paging

Only `list_transactions` pages.

| Parameter | | Default |
|---|---|---|
| `page_size` or `limit` | rows per page | 200, capped at 1000 |
| `offset` | rows to skip | 0 |
| `page` | zero-based page number, used when `offset` is absent | 0 |

The cap is not negotiable per call. A large location must not be able to return an unbounded list,
and a RESTlet that runs out of governance answers with a platform error the Middleware cannot branch
on.

The other six operations expose `count` and `capped` instead, cap at 1000 rows, and have no way to
request a second page. **A list that fills the cap raises a `RESULT_TRUNCATED` note**, so the caller
can tell truncation from "that is all there is".

### 9.2 When an inbound read writes a Sync Log row

A clean read writes **nothing**. A warehouse browsing orders all day must not fill the
reconciliation page.

| Situation | Row? | Status |
|---|---|---|
| a clean read | No | — |
| an expected refusal — order not found, not synced, not scannable, a bad parameter | No | audited only |
| `NO_CONFIGURATION` | **Yes** | the account is broken until somebody fixes it |
| `SEARCH_FAILED` | **Yes** | a search threw; not an expected outcome |
| a success carrying a **review** note | **Yes** | `Open - Needs Review` |

Review rows are **deduped** one per subject per code — an open row for the same record and the same
code is not written twice. The dedupe needs a record id, so a review note on a bin query (which has
no transaction) opens a row each time.

### 9.3 Notes

```json
{ "notes": [ { "code": "LINES_NOT_SCANNABLE", "message": "…" } ] }
```

Two keys, and `notes` is only present when there is something to say.

| Code | Opens a work item? | Meaning |
|---|---|---|
| `LINES_NOT_SCANNABLE` | **Yes** | at least one eligible line has no `product_uuid`. Naming them is the point: submitting one is refused at the write, with the goods already on the dock |
| `DEGRADED_READ` | **Yes** | a supporting search threw and the answer is thinner than it should be. The lines come back, but with fields missing |
| `RESULT_TRUNCATED` | No | the list filled the 1000-row cap |
| `NO_SCANNABLE_LINES` | No | the document transformed to zero lines |
| `UNFILTERED_LIST` | No | no location filter and the calling user has no employee location, so the list spans every site |

**Notes are lost on a refusal.** They are attached on the success path only.

---

## 10. The seven read operations

### 10.1 `list_transactions` — what can be scanned

```
GET {base}?script=766&deploy=1
    &operation=list_transactions
    &record_type=purchaseorder
    &location=13
    &page_size=50
```

| Parameter | | |
|---|---|---|
| `record_type` | **yes** | `purchaseorder` or `salesorder`. `po`, `purchase`, `purchase_order`, `so`, `sales`, `sales_order` accepted. `transaction_type` and `type` are accepted as the parameter name |
| `status` | no | a comma list or a JSON array. Empty ⇒ every scannable status. **A value that resolves to nothing is `MISSING_PARAMETER`**, not a silent empty list |
| `location` or `location_id` | no | falls back to the calling user's employee location, then to unfiltered |
| `serialized_only` | no | `true` returns only orders with at least one eligible line |
| `page_size` / `limit`, `offset`, `page` | no | §9.1 |

```json
{
  "success": true,
  "record_type": "purchaseorder",
  "type": "Purchase",
  "list_token": "purchase",
  "location_filter": { "id": "13", "source": "parameter" },
  "page": { "offset": 0, "size": 50, "returned": 2, "capped": false },
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
      "open_lines": 3
    }
  ]
}
```

| Key | |
|---|---|
| `location_filter` | `null` when nothing filtered. `source` is `parameter` or `current_user` |
| `page.capped` | the page **size** is at the 1000 ceiling. It does **not** mean the results were truncated |
| `has_more` | the page came back full. **There is no total count** — counting every matching order on every page of a warehouse's browsing is a cost nobody asked for |
| `open_lines` | how many lines still have something outstanding |

Excluded from the list: an order not at a scannable status, an order with no TrackTraceRX
identifier, a line the buyer closed by hand, a line with nothing left on it. Anything outside the
operator's location. **There is no `statuses` array in the response** — it echoed back the caller's
own filter, and every transaction already carries its `status` and `status_ref`.

### 10.2 `fetch_transaction` — the scan detail for one order

```
GET {base}?script=766&deploy=1
    &operation=fetch_transaction
    &record_type=purchaseorder
    &internal_id=16050
```

| Parameter | | |
|---|---|---|
| `record_type` | **yes** | as above |
| `internal_id` or `transaction_id` | one of the three | |
| `transaction_uuid` | one of the three | the TrackTraceRX identifier |
| `document_number` or `tranid` | one of the three | `PO447`, `SO610` |

Precedence is `internal_id` → `transaction_uuid` → `document_number`.

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
  "default_hold_bin": "77",
  "default_good_bin": "88",
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
      "unit": "Pallet",
      "unit_id": "23",
      "unit_as_entered": "23",
      "unit_abbreviation": "PF",
      "conversion_rate": 16,
      "is_base_unit": false,
      "quantity_in_base_units": 32,
      "remaining_in_base_units": 32,
      "requires_serialization": true,
      "is_serial_tracked": false,
      "is_lot_tracked": true,
      "uses_bins": true,
      "product_uuid": "d4c3b2a1-…",
      "product_uuid_missing_reason": "",
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

**`creates`** says which document a scan against this order will produce — `itemreceipt` or
`itemfulfillment`.

**`default_hold_bin` and `default_good_bin` are OFFERED, not imposed.** The device shows them so the
operator is not asked for a bin the account has already decided, and sends back whichever it uses.

| | `default_hold_bin` | `default_good_bin` |
|---|---|---|
| a sales order | **`null`** always | **`null`** always |
| a PO, location has the field set | that bin id | that bin id |
| a PO, location field blank | the Configuration's Default Bin, or `null` | **`null`** |

`default_good_bin` has **no fallback to the Default Bin**, by design: that field is the *receiving*
default, and offering it as a release destination would send verified stock back where it came from.

**The three unit fields are three different things**, and conflating them is the mistake this
response exists to prevent:

| Key | What it is | Example |
|---|---|---|
| `unit_id` | the unit's **internal id**, as the line stores it | `"23"` |
| `unit_as_entered` | what the line's unit column reads as — usually the id, sometimes an abbreviation | `"23"` |
| `unit` | the unit's canonical **name** from the item's Units Type | `"Pallet"` |
| `unit_abbreviation` | that unit's abbreviation | `"PF"` |
| `uom_unit_matched` | the normalised key that matched a UOM Detail row | `"PALLET"` |

A UOM Detail row's Saleable Unit holds the **name**. The line holds the **id**. The Units Type is
what translates one into the other, which is why a line can be in Pallet and still find its product.

`conversion_rate` is `1` and `is_base_unit` is `true` when the unit could not be resolved — a
defensive default, not a claim.

`requires_serialization` is the item's **TrackTraceRX eligibility**, read through the configured
Eligibility Field. `is_serial_tracked` and `is_lot_tracked` are NetSuite's own flags. They answer
different questions and a line can be eligible without being serial-tracked.

#### When a line cannot be scanned

```json
{
  "lines_not_scannable": [
    {
      "line_unique_key": "2",
      "item": "Gauze Pad (716)",
      "unit": "Each",
      "unit_id": "1",
      "code": "NO_UUID",
      "reason": "NO_UUID: the UOM Detail row for \"Each\" exists but has not been accepted by the Middleware yet."
    }
  ],
  "notes": [
    { "code": "LINES_NOT_SCANNABLE",
      "message": "1 line cannot be scanned: line 2 — Gauze Pad (716) in Each — NO_UUID. …" }
  ]
}
```

| `code` | Meaning |
|---|---|
| `UNIT_UNKNOWN` | the item has no Units Type, or the line's unit is not in it |
| `NO_ROW` | the item has no UOM Detail row for that unit |
| `NO_UUID` | the row exists but the Middleware has not accepted it yet |

**`product_uuid_missing_reason` is only populated for an eligible line.** A non-eligible item is
never synced to TrackTraceRX and has no UUID by design; reporting a reason there would be noise
describing normality.

### 10.3 `fulfilment_exceptions` — the reasons a short line may carry

```
GET {base}?script=766&deploy=1&operation=fulfilment_exceptions
```

**No parameters.**

```json
{
  "success": true,
  "list_id": "customlist_jj_rb_fulfil_exception",
  "submit_as": "name",
  "count": 4,
  "exception_reasons": [
    { "id": "1", "name": "Damaged in transit" },
    { "id": "2", "name": "Short shipped" },
    { "id": "3", "name": "Failed verification" },
    { "id": "4", "name": "Quarantined" }
  ]
}
```

**`submit_as: "name"`** is the contract: send the **name** on `exception_reason`, not the id. The
list is per account and the ids are not stable across sandbox and production.

### 10.4 `allowed_bins_for_item`

```
GET {base}?script=766&deploy=1&operation=allowed_bins_for_item&item=718&location=13
```

| Parameter | | |
|---|---|---|
| `item` | **yes** | `item_id` is **not** accepted |
| `location` or `location_id` | conditional | **required** when the item has no bins attached to it |

Three different answers, and **the `bins[]` element differs between them**:

**Bins switched off:**

```json
{ "success": true, "item_id": "718", "location_id": "13", "use_bins": false,
  "source": "none", "bins": [],
  "note": "Bins are switched off on the RapidBridge Configuration record, so no bin is required or accepted on a line." }
```

**The item has bins attached** — `source: "item"`, 5 keys per bin, including `preferred`:

```json
{ "success": true, "item_id": "718", "location_id": "13", "use_bins": true,
  "source": "item",
  "bins": [
    { "bin_id": "77", "bin_number": "HOLD-01", "location_id": "13",
      "location_name": "Test Location 1", "preferred": true }
  ] }
```

**Falling back to the location** — `source: "location"`, 7 keys per bin, **no `preferred`**:

```json
{ "success": true, "item_id": "718", "location_id": "13", "use_bins": true,
  "source": "location",
  "bins": [
    { "bin_id": "77", "bin_number": "HOLD-01", "location_id": "13",
      "location_name": "Test Location 1", "description": "Quarantine hold",
      "available": true, "bin_uuid": "aa11…" }
  ],
  "note": "This item has no bins attached to it, so every available bin at the location is offered." }
```

**Read `source` before reading `bins`.** It is the only thing that tells you which element shape you
have.

### 10.5 `bins_for_location`

```
GET {base}?script=766&deploy=1&operation=bins_for_location&location=13&include_inactive=false
```

| Parameter | | |
|---|---|---|
| `location` | **yes** | `location_id` is **not** accepted here |
| `include_inactive` | no | default `false` |

```json
{
  "success": true,
  "location_id": "13",
  "use_bins": true,
  "count": 2,
  "capped": false,
  "bins": [
    { "bin_id": "77", "bin_number": "HOLD-01", "location_id": "13",
      "location_name": "Test Location 1", "description": "Quarantine hold",
      "available": true, "bin_uuid": "aa11…" }
  ]
}
```

Bins off replaces `count`/`capped`/`bins` with `count: 0`, `bins: []` and a `note`, and drops
`capped` entirely.

### 10.6 The three inventory reads

They answer three different questions and the third has three shapes.

| Operation | Question | Grouped by |
|---|---|---|
| `bins_for_location` | what bins exist here? | — |
| `bin_contents` | what is in this bin? | item |
| `item_availability` | where is this item, and in what lots or serials? | lot / serial |

#### `bin_contents`

```
GET {base}?script=766&deploy=1&operation=bin_contents&location=13&bin=77
```

`location` is required. `bin` (or `bin_id`) is required **only when the account uses bins**.

```json
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

#### `item_availability`

```
GET {base}?script=766&deploy=1&operation=item_availability&location=13&item=718&bin=77
```

`location` and `item` are required; `bin` narrows it.

```json
{
  "success": true,
  "location_id": "13",
  "bin_id": "77",
  "item_id": "718",
  "item_name": "AMOX-500",
  "use_bins": true,
  "tracking": "lot",
  "available_quantity": 24,
  "on_hand_quantity": 24,
  "count": 1,
  "capped": false,
  "lots": [
    { "bin_id": "77", "bin_number": "HOLD-01",
      "available_quantity": 24, "on_hand_quantity": 24,
      "item_id": "718", "item_name": "AMOX-500",
      "number_id": "901", "number": "LOT-2026-0815" }
  ]
}
```

**The last key is named for the tracking**, and only one of the three is ever present:

| `tracking` | the array is called |
|---|---|
| `"serial"` | `serials` |
| `"lot"` | `lots` |
| `"none"` | `balances` |

That is the point of `tracking`: read it, then read the array it names. A device that looks only for
`lots` will find nothing on a serialized item and conclude, wrongly, that there is no stock.

**`available_quantity` and `on_hand_quantity` at the top level are the sums of the rows returned.**
When `capped` is true they are a floor, not the truth, and the `RESULT_TRUNCATED` note says so.

---

## 11. Read error codes

| Code | When |
|---|---|
| `MALFORMED_PAYLOAD` | a POST body that is not JSON |
| `UNKNOWN_OPERATION` | not one of the seven. The message lists them |
| `NO_CONFIGURATION` | no active Configuration row |
| `MISSING_PARAMETER` | a required parameter is absent; or every `status` resolved to nothing; or `fetch_transaction` was given no identifier; or `allowed_bins_for_item` has neither attached bins nor a location; or `bin_contents` has no bin in a bin-managed account |
| `UNKNOWN_RECORD_TYPE` | the `record_type` is neither a purchase nor a sales order |
| `NOT_IMPLEMENTED` | a Phase 2 flow — a Transfer Order, a Return Authorisation |
| `TRANSACTION_NOT_FOUND` | no such order, or the uuid / document number matched nothing |
| `TRANSACTION_NOT_SCANNABLE` | terminal, or at a status with nothing left, or the transform produced nothing |
| `TRANSACTION_NOT_SYNCED` | the order has no TrackTraceRX identifier. It should never have been offered |
| `SEARCH_FAILED` | a search threw. **The only read refusal that opens a Sync Log row besides `NO_CONFIGURATION`** |

`LOCATION_NOT_FOUND`, `BIN_NOT_FOUND`, `ITEM_NOT_FOUND` and `BINS_NOT_ENABLED` are declared and
**never raised**. A non-existent location or bin yields an empty list, not a refusal; bins being off
yields `use_bins: false` and a `note`.

---

## 12. Open questions on these payloads

- **Line quantity and unit on the wire.** The outbound line sends the quantity in the line's own
  unit against the product resolved for that unit. Confirm TrackTraceRX reads the pair that way
  rather than expecting base units.
- **`sku`** carries the item id, not the NDC. Confirm if the destination keys on it.
- **The two address DELETE paths** are inferred. The reference build never deleted an address.
- **Which field of a transaction read reports shipments**, for the void guard. Five are probed and
  "none present" is read as zero.
- **`create_default_storage_area`** is unconditionally `true`. In a bin-managed account this asks
  the Middleware to create a storage area that NetSuite will also sync as a Bin.
- **An account with Multiple Units of Measure switched off** has no Units Type on any item, so every
  line reports `UNIT_UNKNOWN`. A fallback straight to a single UOM Detail row would serve those
  accounts and is not built.
- **`order_nbr` and `po_nbr`** both carry `tranid`, on both order types. Confirm the destination
  wants the customer's PO number in `po_nbr` on a sales order rather than our own document number.
