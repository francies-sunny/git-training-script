# RapidBridge — SDF Object Changelog

> **Development folder, from 11 September 2026:**
> `Documents\Git\Z Test SDF\TTRX\TTRX-1 NS TTRX Integration\src`
>
> **Reference only — do not modify:**
> `Desktop\JandJ\Scripting\Non-Git\TTRX\SUAPP-403 TrackTrace - NetSuite Integration\NATPL-2 NetSuite - TrackTraceRX Integration`
> holds the documentation, references and the old TT-NS implementation, and is kept
> untouched for final verification against the new build.
>
> Passes 1-4 below were carried out in the old folder before the move and are already
> reflected in the objects here.

# RapidBridge SDF object changelog

## 11 September 2026 — alignment with the v3.2 / v1.2 / v3.4 document set

Applied from: Partnership Proposal **v4.2** · MasterData Synchronization Design **v1.2** ·
MasterData Developer Guide **v3.4** · Transaction Synchronization Design **v3.2** ·
Transaction Developer Guide **v3.2** · NetSuite **SAFE Guide 2023.1** ·
SDN "Important Notice Prior to Developing Your SuiteApp".

### Modified — 7 objects

| Object | Change | Why |
|---|---|---|
| `manifest.xml` | `BINMANAGEMENT` moved from `required="false"` to `required="true"`; `TOKENBASEDAUTHENTICATION` and `CUSTOMRECORDRESTRICTIONS` added; project renamed | The 8 Sep 2026 decision holds inventory state in physical bins, so the integration does not run without Bin Management (J-14). TBA is the inbound authentication mechanism (SAFE Q1.15.1 / Q5.25) |
| `customlist_jj_rb_sync_type` | 9 → **17** values: Employee, Purchase Order, Sales Order, Item Receipt, Item Fulfilment, Transaction Fetch, Shipment, Inventory Release | The Sync Log is reused whole for transactions. A parallel transaction list must never be created |
| `customlist_jj_rb_operation` | 6 → **12** values: Void, Approve, Unapprove, Transform, Close, Release | Transaction verbs the master-data scope never needed |
| `customlist_jj_rb_direction` | 3 → **5** values: Inbound Query, Internal Repair | The design calls for five directions; two were missing |
| `customlist_jj_rb_try_result` | 10 → **13** values: *Suppressed — environment gate*, *Deferred — awaiting approval*, *Deferred — upstream maintenance* | The environment gate (SAFE Q1.20), the transaction status gate, and planned Middleware maintenance (T-34) are all outcomes that are **not** failures and must not enter the retry count |
| `customrecord_jj_rb_config` | 28 → **30** fields: `custrecord_jj_rb_cf_env_label`, `custrecord_jj_rb_cf_allow_nonprod` | **SAFE Q1.20.** A sandbox refreshed from production copies this row still labelled `PRODUCTION`; the gate detects exactly that and suppresses the call. The free-text *Name* field is not a substitute — the gate needs a comparable value |
| `custrecord_jj_rb_storage_area_uuid` | **DEPRECATED** — label prefixed `[DEPRECATED]`, `displaytype` → `HIDDEN`, `searchlevel` → 1, description and help rewritten | Its help text read *"the bin substitute when the account has no bins"*. Storage areas left the scope in Proposal v4.2 and Bin Management is now a prerequisite, so no such account exists. Retained inactive for one release so existing values can be reconciled, then removed from the bundle |

### Created — 16 objects

**Lists (6)**

| Object | Values | Purpose |
|---|---|---|
| `customlist_jj_rb_env_label` | 3 | `PRODUCTION` / `SANDBOX` / `DEV` — the value the environment gate compares against `runtime.envType` |
| `customlist_jj_rb_if_create_status` | 3 | Picked / Packed / Shipped → NetSuite `shipstatus` A / B / C. Configured per client; **Shipped** for this client |
| `customlist_jj_rb_txn_type` | 4 | The Phase 1 transaction dimension for the flow config and the dispatch table |
| `customlist_jj_rb_doc_err` | 11 | Document-level inbound rejection codes. Part of the published API contract |
| `customlist_jj_rb_line_err` | 10 | Line-level rejection codes. An inbound write is **all-or-nothing** — a failure names every failing line; a success carries no per-line array |
| `customlist_jj_rb_fulfil_exception` | 7 | The reason a picker declares when a pick falls short (TrackTrace 7 Sep Q1). **Confirm the value set with the client before go-live** |

**Location fields (2)**

| Object | Purpose |
|---|---|
| `custrecord_jj_rb_loc_onhold_bin` | Where received stock lands until digital verification completes. **Known limitation T-32 / R-04: a bin does not remove stock from NetSuite's availability calculation**, so unverified stock here can still be committed to a sales order |
| `custrecord_jj_rb_loc_good_bin` | The destination of the inventory release. The release is a **Bin Transfer**, not an Inventory Status Change |

**Employee fields (7) + subtab (1)**

`custentity_jj_rb_emp_` + `hash` · `synced` · `last_sync` · `last_try` · `try_result` · `error` · `attention`,
all on the new `custtab_jj_rb_employee` subtab.

> **There is deliberately no `custentity_jj_rb_emp_uuid`, and adding one would be a mistake.**
> The employee flow reaches the Middleware and stops there — the Middleware keys its copy on the
> NetSuite internal id and issues no identifier back. An always-empty UUID field is how a later
> developer concludes the sync is broken.

> **All seven sit on a record holding personal data.** The Employee record has the widest audience of
> any record RapidBridge touches — HR, payroll and every line manager. Hide the subtab from roles with
> no business seeing it, rather than merely disabling the fields.

### Verified unchanged — reuse as built

`customrecord_jj_rb_sync_log` (55 fields — matches the design exactly; the 4 transaction fields are a
separate task, and **no line-results field may be added**, v3.1 deleted it) ·
`customrecord_jj_rb_uom_detail` (16) · `customrecord_jj_rb_dosage_form` (9) ·
`customlist_jj_rb_bin_property`, `_sync_status`, `_recon_method`, `_recon_status`, `_recon_reason`,
`_attempt_outcome`, `_attempt_trigger`, `_content_type`, `_eligibility`, `_error_class`, `_http_method`,
`_log_role`, `_saleable_unit` ·
all 38 pre-existing custom fields on Item, Entity, Address, Bin and Location ·
`custtab_jj_rb_entity`, `custtab_jj_rb_item`, `custtab_jj_rb_item_uom`.

`customrecord_jj_rb_config` already has `<enableoptimisticlocking>T</enableoptimisticlocking>`, which is
correct — though note SAFE §4.7.3: optimistic locking is bypassed by `record.submitFields`, which is what
the scripts use. Never add a counter field to the Sync Log that is maintained by read-modify-write.

### NOT changed — needs a decision first

| Item | Why it was left alone |
|---|---|
| `manifest.xml` → `projecttype="SUITEAPP"` | Converting from `ACCOUNTCUSTOMIZATION` requires the **Publisher ID and Application ID issued by Oracle**, and the managed-vs-unmanaged choice (**J-16**) is **irreversible once the SuiteApp Definition is created**. Converting early, or with placeholder ids, is worse than converting late. Task **RB-001** |
| `custrecord_jj_rb_addr_sgln`, `custrecord_jj_rb_loc_sgln` | SGLN survives in the glossary, so these are probably correct — but confirm the Middleware still consumes them now that storage areas are gone. Task **RB-031** |
| The 4 transaction fields on `customrecord_jj_rb_sync_log` | They depend on the transaction field bundle being designed as a whole. Task **RB-022** |

### Still absent — every script

`FileCabinet/SuiteScripts/Jobin and Jismi IT Services/RapidBridge SuiteApp/{Common,Master Data,Configuration}`
are **all empty**. Every one of the eleven script files in the plan is a new file.

---

## Pass 3 — field label uniqueness (duplicate `(2)` / `(3)` suffix fix)

**Symptom.** After deployment NetSuite showed `RapidBridge Sync Error`, `RapidBridge Sync Error (2)`
and `RapidBridge Sync Error (3)` for `custrecord_jj_rb_addr_error`, `custrecord_jj_rb_bin_error` and
`custrecord_jj_rb_loc_error`.

**Cause.** NetSuite appends `(n)` when two custom fields share a **label inside the same field family**.
Address (`-289`), Bin (`-242`) and Location (`-103`) fields are all `othercustomfield`, so they land in
one *Other Custom Fields* list and collide. `entitycustomfield` and `itemcustomfield` are separate
families, which is why those did not show a suffix — but they carried the same duplicate labels and
would have collided as soon as the Employee entity fields were added, since those are `entitycustomfield`
too.

**Audit result.** 17 labels were duplicated across 48 fields, not the 3 that were visible.

**Fix.** Every label is now globally unique. `scriptid` values are unchanged, so scripts, saved searches,
forms and workflows are unaffected — redeploying updates the labels in place and the `(n)` suffixes
disappear.

### Native-record fields — record name inserted

| scriptid | Old label | New label |
|---|---|---|
| `custrecord_jj_rb_addr_error` | RapidBridge Sync Error | RapidBridge Address Sync Error |
| `custrecord_jj_rb_bin_error` | RapidBridge Sync Error | RapidBridge Bin Sync Error |
| `custrecord_jj_rb_loc_error` | RapidBridge Sync Error | RapidBridge Location Sync Error |
| `custentity_jj_rb_error` | RapidBridge Sync Error | RapidBridge Partner Sync Error |
| `custitem_jj_rb_error` | RapidBridge Sync Error | RapidBridge Item Sync Error |
| `custrecord_jj_rb_bin_synced` | RapidBridge Synced | RapidBridge Bin Synced |
| `custrecord_jj_rb_loc_synced` | RapidBridge Synced | RapidBridge Location Synced |
| `custentity_jj_rb_synced` | RapidBridge Synced | RapidBridge Partner Synced |
| `custitem_jj_rb_synced` | RapidBridge Synced | RapidBridge Item Synced |
| `custrecord_jj_rb_bin_last_sync` | RapidBridge Last Sync (Success) | RapidBridge Bin Last Sync (Success) |
| `custrecord_jj_rb_loc_last_sync` | RapidBridge Last Sync (Success) | RapidBridge Location Last Sync (Success) |
| `custentity_jj_rb_last_sync` | RapidBridge Last Sync (Success) | RapidBridge Partner Last Sync (Success) |
| `custitem_jj_rb_last_sync` | RapidBridge Last Sync (Success) | RapidBridge Item Last Sync (Success) |
| `custrecord_jj_rb_bin_last_try` | RapidBridge Last Sync Try | RapidBridge Bin Last Sync Try |
| `custrecord_jj_rb_loc_last_try` | RapidBridge Last Sync Try | RapidBridge Location Last Sync Try |
| `custentity_jj_rb_last_try` | RapidBridge Last Sync Try | RapidBridge Partner Last Sync Try |
| `custitem_jj_rb_last_try` | RapidBridge Last Sync Try | RapidBridge Item Last Sync Try |
| `custrecord_jj_rb_bin_try_result` | RapidBridge Last Sync Try Result | RapidBridge Bin Last Sync Try Result |
| `custrecord_jj_rb_loc_try_result` | RapidBridge Last Sync Try Result | RapidBridge Location Last Sync Try Result |
| `custentity_jj_rb_try_result` | RapidBridge Last Sync Try Result | RapidBridge Partner Last Sync Try Result |
| `custitem_jj_rb_try_result` | RapidBridge Last Sync Try Result | RapidBridge Item Last Sync Try Result |
| `custrecord_jj_rb_bin_hash` | RapidBridge Payload Hash | RapidBridge Bin Payload Hash |
| `custrecord_jj_rb_loc_hash` | RapidBridge Payload Hash | RapidBridge Location Payload Hash |
| `custentity_jj_rb_hash` | RapidBridge Payload Hash | RapidBridge Partner Payload Hash |
| `custrecord_jj_rb_addr_sgln` | SGLN | Address SGLN |
| `custrecord_jj_rb_loc_sgln` | SGLN | Location SGLN |

### Custom-record fields — record short name or role inserted

| scriptid | Old label | New label |
|---|---|---|
| `custrecord_jj_rb_df_uuid` | External UUID | TrackTrace Dosage Form UUID |
| `custrecord_jj_rb_uom_uuid` | External UUID | TrackTrace UOM UUID |
| `custrecord_jj_rb_sl_uuid` | External UUID | Object UUID |
| `custrecord_jj_rb_df_hash` | Payload Hash | Dosage Form Payload Hash |
| `custrecord_jj_rb_uom_hash` | Payload Hash | UOM Payload Hash |
| `custrecord_jj_rb_df_synced` | Synced | Dosage Form Synced |
| `custrecord_jj_rb_uom_synced` | Synced | UOM Synced |
| `custrecord_jj_rb_df_last_sync` | Last Sync (Success) | Dosage Form Last Sync (Success) |
| `custrecord_jj_rb_uom_last_sync` | Last Sync (Success) | UOM Last Sync (Success) |
| `custrecord_jj_rb_df_last_try` | Last Sync Try | Dosage Form Last Sync Try |
| `custrecord_jj_rb_uom_last_try` | Last Sync Try | UOM Last Sync Try |
| `custrecord_jj_rb_df_try_result` | Last Sync Try Result | Dosage Form Last Sync Try Result |
| `custrecord_jj_rb_uom_try_result` | Last Sync Try Result | UOM Last Sync Try Result |
| `custrecord_jj_rb_df_error` | Sync Error | Dosage Form Sync Error |
| `custrecord_jj_rb_uom_error` | Sync Error | UOM Sync Error |
| `custrecord_jj_rb_sl_item` | Item | Related Item |
| `custrecord_jj_rb_uom_item` | Item | Parent Item |
| `custrecord_jj_rb_sl_dosage` | Dosage Form | Related Dosage Form |
| `custrecord_jj_rb_sl_subsidiary` | Subsidiary | Subsidiary Context |
| `custrecord_jj_rb_cf_subsidiary` | Subsidiary | Applies To Subsidiary |
| `custrecord_jj_rb_df_code` | Code | Dosage Form Code |
| `custrecord_jj_rb_df_is_default` | Is Default | Default Dosage Form |

`custitem_jj_rb_dosage_form` keeps the plain label **Dosage Form** — it is the natural business label on
the item, and the Sync Log field that clashed with it was renamed instead.

`custrecord_jj_rb_df_code` and `custrecord_jj_rb_df_is_default` were not yet duplicated; they were
renamed because `Code` and `Is Default` are the labels most likely to be chosen again by a later object.

### Naming rule for every field added from here on

1. A field on a **native record** (Item, Entity, Address, Bin, Location, Employee, transactions) carries
   the record name: `RapidBridge <Record> <Purpose>` — e.g. `RapidBridge Employee Sync Error`.
2. A field on a **RapidBridge custom record** carries the record short name (`Dosage Form`, `UOM`,
   `Sync Log`, or a role word such as `Related` / `Parent` / `Applies To`).
3. A TrackTrace-issued identifier is always `TrackTrace <Object> UUID`.
4. Never ship a single generic word (`Code`, `Item`, `Status`, `Subsidiary`) as a label on a field that
   sits in a shared field family.

### Open item carried forward

The 7 `custentity_jj_rb_emp_*` files and their labels are **not present** in
`src/Objects/Custom Entity Field/` — only the original 8 entity fields are there, although
`custtab_jj_rb_employee` (the subtab they attach to) is present. They appear to have been lost in an
object re-import from the account. When they are re-created they must use the
`RapidBridge Employee <Purpose>` labels, or they will collide with the Partner fields above, because
both are `entitycustomfield`.

---

## Pass 4 — custom list name length (SDF validation)

`customlist/<name>` is capped at **30 characters**. Three of the lists added in Pass 2 exceeded it and
failed `suitecloud project:validate`. The `scriptid` of each is unchanged, so nothing that references
them is affected.

| scriptid | Old name (len) | New name (len) |
|---|---|---|
| `customlist_jj_rb_doc_err` | RapidBridge Inbound Document Error (34) | RapidBridge Inbound Doc Error (29) |
| `customlist_jj_rb_fulfil_exception` | RapidBridge Fulfilment Exception Reason (39) | RapidBridge Fulfil Exception (28) |
| `customlist_jj_rb_if_create_status` | RapidBridge Item Fulfilment Create Status (41) | RapidBridge IF Create Status (28) |

`customlist_jj_rb_line_err` is exactly 30 (`RapidBridge Inbound Line Error`) and is valid — the limit is
"more than 30". The other 20 lists, all 4 `customrecordtype` record names and all 4 subtab titles were
re-checked and are within limit, as are every list value (cap 60) and every field label (cap 200,
longest in use is 36).

**Rule for new objects:** `RapidBridge ` eats 12 of the 30 characters, so a list name has **18 left**.
Use the SuiteScript-standard short forms — `Doc`, `IF` (Item Fulfilment), `IR` (Item Receipt), `PO`,
`SO`, `TO`, `Recon`, `Fulfil` — rather than the spelled-out words.

---

## Pass 5 — two planned records dropped; their fields folded into existing records

**Decision (11 September 2026):** `customrecord_jj_rb_flow_config` and
`customrecord_jj_rb_shipment_txn` are **not built**. Neither ever existed as XML, so nothing was
deleted — they are removed from the plan. The record count for the finished SuiteApp drops from
**6 to 4**.

Design references to supersede: Transaction Developer Guide §4.3.1 and §4.3.2, and Transaction
Design §4.3 — both still describe the two records.

### 5.1 Flow configuration → `customrecord_jj_rb_config`, four new subtabs

The eighteen flow-configuration axes of Guide §4.3.1 are now fields on the Configuration record.
Two of the eighteen — the on-hold bin and the good bin — were already moved to the Location
record in Pass 2 (`custrecord_jj_rb_loc_onhold_bin`, `custrecord_jj_rb_loc_good_bin`), because
inventory state is held per location, not per flow. The remaining sixteen become **nineteen**
fields, because the three axes that genuinely differ between flows — enabled, status gate and
approval gate — are spelled out per flow instead of being one row per flow.

**Subtab `tab_rb_cf_flows` — Transaction Flows**

| scriptid | Label | Type | Default |
|---|---|---|---|
| `custrecord_jj_rb_cf_po_enabled` | PO Sync Enabled | Check Box | checked |
| `custrecord_jj_rb_cf_po_gate` | PO Status Gate | Text (60) | blank — mandatory while PO sync is on |
| `custrecord_jj_rb_cf_po_approval` | PO Approval Gate | Text (60) | blank |
| `custrecord_jj_rb_cf_so_enabled` | SO Sync Enabled | Check Box | checked |
| `custrecord_jj_rb_cf_so_gate` | SO Status Gate | Text (60) | blank — mandatory while SO sync is on |
| `custrecord_jj_rb_cf_so_approval` | SO Approval Gate | Text (60) | blank |
| `custrecord_jj_rb_cf_ir_enabled` | Item Receipt Sync Enabled | Check Box | checked |
| `custrecord_jj_rb_cf_if_enabled` | Item Fulfilment Sync Enabled | Check Box | checked |
| `custrecord_jj_rb_cf_to_enabled` | Transfer Order Sync Enabled | Check Box | **unchecked — Phase 2** |

**Subtab `tab_rb_cf_inbound` — Inbound Handling**

| scriptid | Label | Type | Default |
|---|---|---|---|
| `custrecord_jj_rb_cf_if_status` | IF Create Status | List → `customlist_jj_rb_if_create_status` | blank falls back to Shipped, and is flagged |
| `custrecord_jj_rb_cf_default_bin` | Default Inbound Bin | List/Record → Bin | blank |
| `custrecord_jj_rb_cf_storage_area` | Default Storage Area | Text (64) | blank |
| `custrecord_jj_rb_cf_held_hours` | Held-Stock Threshold (h) | Integer | 24 |
| `custrecord_jj_rb_cf_close_action` | Close Action | Text (20) | blank |

**Subtab `tab_rb_cf_poll` — Reconciliation Poll**

| scriptid | Label | Type | Default |
|---|---|---|---|
| `custrecord_jj_rb_cf_poll_enabled` | Fallback Poll Enabled | Check Box | **unchecked** — inbound is a push |
| `custrecord_jj_rb_cf_poll_window` | Poll Window (min) | Integer | 60 |
| `custrecord_jj_rb_cf_watermark` | Poll Watermark | Date/Time | **LOCKED** — maintained by the job |

**Subtab `tab_rb_cf_phase2` — Phase 2**

| scriptid | Label | Type | Default |
|---|---|---|---|
| `custrecord_jj_rb_cf_transfer` | Transfer Handling | Text (30) | blank |
| `custrecord_jj_rb_cf_cross_sub_only` | Cross-Subsidiary Only | Check Box | unchecked |

Both Phase 2 fields are created now and left blank, so Phase 2 adds no fields.

**What this costs.** The child record allowed one row per flow *per subsidiary*. Flat fields on
the Configuration record do not — the flow settings now vary per configuration row, which is
per subsidiary, not per flow within a subsidiary. That is the correct granularity given
proposal v4 §4.3 ("one standardized integration flow per transaction type, without
client-specific process variations") and it is what makes the flattening safe. **If a client
ever needs two different status gates for the same transaction type inside one subsidiary, the
child record has to come back.**

`jj_rb_cs_forms.js` still validates on save of the Configuration record: a blank status gate on
an enabled outbound flow is refused, and a blank IF create status on an enabled Item Fulfilment
flow is flagged.

### 5.2 Shipment-to-transaction link → `customrecord_jj_rb_sync_log`, one new subtab

The link record held per-shipment rows, which is transactional data and cannot live on a
single-row configuration record. It goes on the Sync Log instead, which already carries exactly
one row per work item — a shipment covering two purchase orders simply produces two Sync Log
rows sharing one shipment uuid, and that *is* the many-to-many link.

**Subtab `tab_rb_sl_txn` — Transaction** (all six LOCKED — written by the scripts, never by a user)

| scriptid | Label | Type | Replaces |
|---|---|---|---|
| `custrecord_jj_rb_sl_shipment_uuid` | Shipment UUID | Text (64) | `custrecord_jj_rb_st_shipment` |
| `custrecord_jj_rb_sl_transaction` | Related Transaction | List/Record → Transaction | `custrecord_jj_rb_st_ns_txn` |
| `custrecord_jj_rb_sl_txn_result` | Resulting Transaction | List/Record → Transaction | `custrecord_jj_rb_st_ns_result` |
| `custrecord_jj_rb_sl_qty_covered` | Quantity Covered | Integer | `custrecord_jj_rb_st_qty` |
| `custrecord_jj_rb_sl_line_total` | Lines In Payload | Integer | Guide §6.1 `LOG.lineTotal` |
| `custrecord_jj_rb_sl_line_sent` | Lines Written | Integer | Guide §6.1 `LOG.lineSent` |

`custrecord_jj_rb_st_txn` (the remote transaction uuid) needs no new field — the existing
`custrecord_jj_rb_sl_uuid` **Object UUID** already holds it. `custrecord_jj_rb_st_log` is gone
by construction: the row *is* the log row.

`jj_rb_core.js` namespace `C`: drop `REC.FLOW` and `REC.SHIP_TXN`; the flow axes read from
`REC.CONFIG`, and `LOG` gains the six ids above.

### 5.3 Display type — LOCKED, not DISABLED

Verified across all 47 object files in the development folder: **50 LOCKED, 124 NORMAL, zero
DISABLED**. Every field the scripts write and a user must not is LOCKED, including the three new
ones that needed it. `DISABLED` greys a field but still renders it as an input; `LOCKED` renders
it as inline text, which is what a script-maintained field should be.

### 5.4 State after this pass

47 object files · 4 custom records · 20 custom lists · 38 native-record custom fields ·
136 custom-record fields · 174 fields in total, **every label unique** · 17 record subtabs ·
no name over the 30-character cap · all XML well-formed.

---

## Pass 6 — transaction fields created; eleven of the specified fields dropped

**Decision (11 September 2026).** Eleven fields named in Transaction Developer Guide §5.2 and §5.3
are **not built**. The transaction field set is created against what remains, plus a new line-level
verification set that the guide did not have.

### 6.1 Not built — eleven

| Dropped | Guide | Why it has no writer |
|---|---|---|
| `custcol_jj_rb_product_uuid` | §5.3 | The destination product identifier is resolved at payload-build time from the item's UOM Detail row; storing a copy on the line adds a second place for it to be wrong |
| `custcol_jj_rb_serialized` | §5.3 | The per-line classification is read from the item's Eligibility on every evaluation; the body roll-ups are what scripts branch on |
| `custcol_jj_rb_line_uuid` | §5.3 | Line matching is not on the primary path — the operator selects the transaction, so its internal id travels with the submission |
| `custcol_jj_rb_ship_status` | §5.3 | Line-level shipped status belonged to the *serialized only* mixed-line policy, deleted in v2.0 |
| `custcol_jj_rb_qty_synced` | §5.3 | The base unit is always Each and conversion is unconditional, so the sent quantity is derivable |
| `custbody_jj_rb_delivery_status` | §5.2 | The remote lifecycle state is read when needed; nothing in Phase 1 branches on a stored copy. **`customlist_jj_rb_delivery_status` is therefore not created either** |
| `custbody_jj_rb_subtype` | §5.2 | Only `SALES` is used in Phase 1 and it is a constant on the payload builder. **`customlist_jj_rb_txn_subtype` is not created** |
| `custbody_jj_rb_container_uuid` | §5.2 | Container synchronization left the scope in proposal v4, and T-21 never established where the value comes from |
| `custbody_jj_rb_held_qty` | §5.2 | **Moved to the line** — `custcol_jj_rb_hold_qty` |
| `custbody_jj_rb_released_on` | §5.2 | **Moved to the line** — `custcol_jj_rb_released_on` |
| `custbody_jj_rb_attention` | §5.2 | The reconciliation page selects on the Sync Log's own open/status fields; a duplicate flag on the transaction is a second thing to keep in step |

**Three lists fall away with them** — delivery status, transaction sub-type and transfer handling
(the last because `custrecord_jj_rb_cf_transfer` is free-form text). The new-list count in Guide §3.3
drops from five to **two**: `customlist_jj_rb_if_create_status`, which already exists, and
`customlist_jj_rb_verify_status`, added below.

### 6.2 Transaction body fields — twelve

`Objects/Custom Transaction Body Field/`. All **LOCKED**. Applied to **sale, purchase, item
fulfilment, item receipt and transfer order** — which covers all seven in-scope types, because a
Return Authorisation is a sale and a Vendor Return a purchase. **Not on inventory adjustment.**

| scriptid | Label | Type |
|---|---|---|
| `custbody_jj_rb_uuid` | TrackTrace Transaction UUID | Text (64) |
| `custbody_jj_rb_hash` | RapidBridge Transaction Payload Hash | Text (64) |
| `custbody_jj_rb_synced` | RapidBridge Transaction Synced | Check Box |
| `custbody_jj_rb_last_sync` | RapidBridge Transaction Last Sync (Success) | Date/Time |
| `custbody_jj_rb_last_try` | RapidBridge Transaction Last Sync Try | Date/Time |
| `custbody_jj_rb_try_result` | RapidBridge Transaction Last Sync Try Result | List → `customlist_jj_rb_try_result` |
| `custbody_jj_rb_error` | RapidBridge Transaction Sync Error | Long Text |
| `custbody_jj_rb_shipment_uuid` | TrackTrace Shipment UUID | Text (64) |
| `custbody_jj_rb_all_serial` | All Lines Serialized | Check Box |
| `custbody_jj_rb_contains_nonserial` | Contains Non-Serialized Lines | Check Box |
| `custbody_jj_rb_origin` | RapidBridge Record Origin | Text (20) |
| `custbody_jj_rb_scan_session` | RapidS1 Scan Session ID | Text (60) |

The seven-field bundle keeps the master-data ids and the master-data list, so one saved search on
*Failed — API error* returns items and sales orders together.

### 6.3 Error detail on the transaction — no new field needed

`custbody_jj_rb_error` (the full message, cleared on a later success) and
`custbody_jj_rb_try_result` (the classified outcome) put the error on the transaction itself. The
**class, the code, the request and the response** stay on the Sync Log, which is now reachable
directly from the record — §6.5. A second copy of the class and code on the body would be two
places to keep in step for no new information.

**No line-level error field exists, deliberately.** An inbound write is all-or-nothing: a line that
fails validation is never saved, so a column field holding its error code would have no writer.

### 6.4 Transaction line fields — eight, and six of them are new work

`Objects/Custom Transaction Line Field/`. All **LOCKED**.

**The verification set — Item Receipt only.** A received line lands in the on-hold bin; digital
verification runs; the release bin-transfers the passed quantity to the good bin. The guide held
that state at body level in two fields. It belongs per line, because verification is per serial and
a partial release is normal.

| scriptid | Label | Type | Applies to |
|---|---|---|---|
| `custcol_jj_rb_verify_status` | Verification Status | List → `customlist_jj_rb_verify_status` | Item Receipt |
| `custcol_jj_rb_hold_bin` | On-Hold Bin | List/Record → Bin | Item Receipt |
| `custcol_jj_rb_hold_qty` | Quantity On Hold | Decimal | Item Receipt |
| `custcol_jj_rb_released_qty` | Quantity Released | Decimal | Item Receipt |
| `custcol_jj_rb_release_bin` | Released To Bin | List/Record → Bin | Item Receipt |
| `custcol_jj_rb_released_on` | Released On | Date/Time | Item Receipt |
| `custcol_jj_rb_exception_reason` | Fulfilment Exception Reason | List → `customlist_jj_rb_fulfil_exception` | Item Receipt · Item Fulfilment |
| `custcol_jj_rb_exception_note` | Exception Comment | Text (300) | Item Receipt · Item Fulfilment |

**How the line reads across the flow:**

| Stage | Verification Status | Qty On Hold | Qty Released | Released On |
|---|---|---|---|---|
| Receipt created, non-trackable line | Not Required | 0 | qty | (receipt date) |
| Receipt created, serial-tracked line | Awaiting Verification | qty | 0 | blank |
| Release arrives, all serials pass | Verified | 0 | qty | timestamp |
| Release arrives, some damaged | Partially Verified | remainder | passed | timestamp |
| Verification fails | Verification Failed | qty | 0 | blank |

**Blank `Released On` past the held-stock threshold is what the *received but not released*
worklist selects on** — the one inbound failure that reports no error at all. It now selects per
line rather than per receipt, so a partially released receipt is visible instead of looking
finished.

**New list `customlist_jj_rb_verify_status`** — *RapidBridge Verify Status* (25 chars): Not Required
· Awaiting Verification · Partially Verified · Verified · Verification Failed.

> **Say this to the client with the line, not after it.** A bin does not remove stock from NetSuite
> availability. A line showing *Awaiting Verification* with a quantity on hold **can still be
> committed to a sales order** — open point **T-32**, to be answered before Phase 1 go-live.

### 6.5 The Sync Log links to its transaction, as a parent

`custrecord_jj_rb_sl_transaction` is now **`isparent = T`**. Every Sync Log row for a transaction
renders as a **RapidBridge Sync Log sublist on the transaction itself**, so a user standing on a
purchase order sees every call made about it — the create, its retries, the receipt, the identifier
update and the release — without a saved search.

This is the route from `custbody_jj_rb_error` to the full detail: the message is on the record, and
one click away are the class, the code, the endpoint, the HTTP status, the request and the response.

The record now has three parent fields, which NetSuite permits: `custrecord_jj_rb_sl_parent`
(self-parent, the retry chain), `custrecord_jj_rb_sl_transaction` (new), and
`custrecord_jj_rb_uom_item` on the UOM Detail record.

### 6.6 Employee fields — six, the bundle minus the UUID

`Objects/Custom Entity Field/`, on `custtab_jj_rb_employee`, **LOCKED**, `accesslevel` 1 and
`searchlevel` 1 — the Employee record has an audience of HR, payroll and every line manager.

`custentity_jj_rb_emp_synced` · `_hash` · `_last_sync` · `_last_try` · `_try_result` · `_error`

**No UUID field.** TrackTrace never sees an employee and issues no identifier; the flow ends at the
Middleware, keyed on the NetSuite internal id. Six fields, not seven.

> **This flow has no issued contract — open point E-04.** The Middleware has published no employee
> endpoint. The fields are safe to create; the flow cannot be built until the contract exists.

### 6.7 State after this pass

74 object files · 4 custom records · 21 custom lists · 200 fields, **every label unique** ·
12 transaction body fields · 8 transaction line fields · 44 native-record custom fields ·
136 custom-record fields · 18 record subtabs · 76 LOCKED / 124 NORMAL, **zero DISABLED** ·
no name over the 30-character cap · all XML well-formed · no duplicate scriptid.

---

## Pass 7 — employee fields withdrawn; scan session replaced by request UUID

**Decision (11 September 2026).**

### 7.1 The employee flow is a read, not a synchronization

**There is no employee synchronization.** The Middleware fetches employee details from NetSuite with
a **GET**; NetSuite stores nothing back and holds no per-employee sync state.

**Deleted — seven objects created in Pass 6:**

`custentity_jj_rb_emp_synced` · `_hash` · `_last_sync` · `_last_try` · `_try_result` · `_error` ·
and the subtab `custtab_jj_rb_employee`, which existed only to hold them.

**What this changes elsewhere.** Master Data Synchronization Design §11 describes employee as a
synchronized master data type with the seven-field bundle, a hash comparison, an inactivation push
and a Sync Log work item. **All of that is superseded.** What survives of §11 is the *requirement* —
an operator sees only their own location's transactions — and it is met by a read operation in
`jj_rb_rl_api.js`, alongside the other reads of Transaction Guide §7.8.1.

| Was (Design §11) | **Is** |
|---|---|
| NetSuite → Middleware push on save, when location or role changed | **Middleware GET, on demand** |
| Seven-field bundle on the Employee record | **No fields** |
| A Sync Log work item per employee | **Logged as a read**, under its own Sync Type, like every other read |
| Blocked when the employee has no location, or no email | **The read returns what NetSuite holds**; the Middleware decides what to do with a blank location |
| Open point **E-04** — no employee endpoint contract | **Dissolved.** NetSuite exposes the read; there is no Middleware endpoint to agree |

Open points **E-01**, **E-02** and **E-03** survive unchanged — they are about how the Middleware
matches and filters, and a read does not settle them.

> This also removes the only place the SuiteApp wrote custom fields to a record with an HR and
> payroll audience. The caution in Design §11.9 no longer applies because there is nothing to hide.

### 7.2 `custbody_jj_rb_scan_session` → `custbody_jj_rb_request_uuid`

**Deleted:** `custbody_jj_rb_scan_session` — *RapidS1 Scan Session ID*. The scan session is the
Middleware's and NetSuite never observes it; what NetSuite does see is the call.

**Created:** `custbody_jj_rb_request_uuid` — **Latest Request UUID**, Free-Form Text (64), LOCKED,
on the same five transaction families.

Holds the `request_uuid` of the **most recent** Middleware call about this record, so the record
points at the Sync Log row for the call that last touched it — the create, the identifier PATCH, or
a later inventory release, each of which carries its own.

> **This does not replace the native external id, and must never be read as if it did.**
> Transaction Guide §5.2.1 says no custom field carries the `request_uuid`, on the grounds that two
> copies invite disagreement. That reasoning holds for the **duplicate guard** and this field does
> not touch it:
>
> | | Native `externalId` | `custbody_jj_rb_request_uuid` |
> |---|---|---|
> | Holds | The **first** call's `request_uuid` — the one that created the record | The **latest** call's |
> | Written | Once, by the create | On every call |
> | Enforced | **By the platform**, unique per record type | Not at all |
> | Purpose | **The duplicate guard.** A replayed submission is refused here | Navigation and support |
>
> **Never test for a duplicate against this field.** The guard is the external id, and it is the
> only thing that is race-free.

### 7.3 `custrecord_jj_rb_sl_request_uuid` — Request UUID on the Sync Log

Added to `customrecord_jj_rb_sync_log`, on the **API Call** subtab beside Correlation ID. Free-Form
Text (64), LOCKED. Blank on an outbound call, which NetSuite originates.

**It is not the Correlation ID.** The correlation id ties the several calls of one work item
together; the request_uuid identifies one inbound call from the Middleware. A two-call inbound
protocol has one correlation id and two request uuids.

The Sync Log now holds **62 fields**.

### 7.4 State after this pass

67 object files · 4 custom records · 21 custom lists · 195 fields, **every label unique** ·
12 transaction body fields · 8 transaction line fields · 38 native-record custom fields ·
137 custom-record fields · 18 record subtabs · 70 LOCKED / 125 NORMAL, **zero DISABLED** ·
no name over the 30-character cap · all XML well-formed · no duplicate scriptid.

---

## Pass 8 — SO / PO outbound transaction sync built

Applied from: Transaction Synchronization Design **v3.1** · Transaction Developer Guide **v3.1**,
against the reference build's `jj_ue_tracktracerx_transaction_sync_natpl_2.js`.

**Scope of this pass: NetSuite → Middleware, Sales Order and Purchase Order only.** Item
Fulfilment and Item Receipt are created inbound by the Middleware calling the RESTlet (guide
§2.2, §10.2, §11.1), so they get no User Event deployment and no dispatch row. Order close,
cancel and delete (§12) are not part of the approved transitions and are not built.

### Added — 4 objects

| Object | Type | Why |
|---|---|---|
| `custcol_jj_rb_serialized` | Check Box, LOCKED, on sale / purchase / transfer / IF / IR | Guide §5.3. The Scenario 1 classification, per line. The two body roll-ups are computed from it. **Deliberately NOT a sync-control field** — a change to it is a change to the order's classification and must re-trigger the sync |
| `custcol_jj_rb_product_uuid` | Free-Form Text (64), LOCKED | §5.3. The destination product identifier used for this line, resolved from the UOM Detail row whose Saleable Unit matches the line's unit. **The join that makes line matching work** |
| `custcol_jj_rb_qty_synced` | Decimal, LOCKED | §5.3. What was actually sent for this line. On a mixed order the destination's totals will not match NetSuite's, and this is where a support person sees why |
| `customscript_jj_ue_rb_txn` | User Event + 2 deployments | `SALESORDER` and `PURCHASEORDER`, both **`isdeployed F`** — deployed by hand from the NetSuite UI when wanted |

**Nothing else was added.** Every other object the flow needs already existed from passes 5 to 7:
the twelve transaction body fields, the four Sync Log transaction fields
(`_sl_transaction`, `_sl_shipment_uuid`, `_sl_line_total`, `_sl_line_sent`) and the six SO/PO
gate fields on `customrecord_jj_rb_config`.

### Modified — 2 objects

| Object | Change | Why |
|---|---|---|
| `customlist_jj_rb_try_result` | **`Skipped - feature LOCKED` corrected to `Skipped - feature disabled`**; `Skipped - no serialized lines` added | The first is a defect, not a new value: `C.TRY.SKIP_FEATURE` is `'Skipped - feature disabled'`, so the list lookup returned null and **every feature-disabled stamp has been silently dropped since the value was introduced** — a find-and-replace on the word "disabled" had reached inside the list. The second is guide §3.2, and it is the most common non-error outcome on a transaction |
| `customlist_jj_rb_attempt_trigger` | `Status Change` added | §3.2. The work item exists because a STATUS moved, not because field data changed. In Phase 1 that is every outbound create |

### The two fields that were specified and NOT created

| Not created | Why |
|---|---|
| `custbody_jj_rb_subtype` | The sub-type is `SALES` on every Sales Order in Phase 1 and is **not sent at all** on a Purchase Order (§9.3). It is a constant on the dispatch row (`entry.subType`), which is where a value with one possible setting belongs |
| `custrecord_jj_rb_flow_config` (18 fields) | The guide's per-flow child record. The two Phase 1 flows need three values each, **those six fields already exist on `customrecord_jj_rb_config`**, and a child record with two rows in it would be a join on every transaction save for nothing. `config.flow(entry)` in `jj_rb_core.js` hides the difference, so moving to the child record later is one function rather than a rewrite |

### State after this pass

71 object files · 4 custom records · 21 custom lists · 198 fields · 12 transaction body fields ·
**11 transaction line fields** · all XML well-formed · no duplicate scriptid.

---

## Pass 9 — status gates become lists; approval-flow and non-approval-flow accounts; the sourced eligibility column

### Added — 4 objects

| Object | Type | Why |
|---|---|---|
| `customlist_jj_rb_so_status` | Custom list, 8 values | The standard NetSuite Sales Order statuses, so the SO Status Gate is chosen rather than typed |
| `customlist_jj_rb_po_status` | Custom list, 8 values | The same for Purchase Order. Two lists, not one: a PO status must not be selectable on the SO gate |
| `customlist_jj_rb_approval_mode` | Custom list, 3 values | `Native approval routing` · `No approval workflow` · `Custom approval field` |
| `custcol_jj_rb_item_eligible` | SELECT → `customlist_jj_rb_eligibility`, **SOURCED** | Source List = Item, Source From = TrackTrace Eligibility. Puts the item's eligibility on the line with **no script at all**, so a user, a saved search and the reconciliation page can tell a sync-required line from a non-sync-required one directly — and the classification saves one search per save |

### Modified — 6 fields on `customrecord_jj_rb_config`

| Field | Was | Is |
|---|---|---|
| `custrecord_jj_rb_cf_so_gate` | Free-Form Text, no default | **SELECT → SO status list, default `Pending Fulfillment`** |
| `custrecord_jj_rb_cf_po_gate` | Free-Form Text, no default | **SELECT → PO status list, default `Pending Receipt`** |
| `custrecord_jj_rb_cf_so_approval` | Free-Form Text "Native, or a field id" | **SELECT → approval mode, default `Native approval routing`.** Relabelled *SO Approval Mode* |
| `custrecord_jj_rb_cf_po_approval` | as above | **SELECT → approval mode.** Relabelled *PO Approval Mode* |
| `custrecord_jj_rb_cf_so_approval_fld` | — | **NEW** Free-Form Text (60). The custom approval checkbox id. Read only under `Custom approval field`, and mandatory there |
| `custrecord_jj_rb_cf_po_approval_fld` | — | **NEW** as above |

**The defaults are right for both kinds of account, and that is the point.** NetSuite puts an
approved sales order in `Pending Fulfillment` and an approved purchase order in `Pending Receipt`
— and it puts a **new** one there too when the account has no approval workflow. One default,
both cases.

> **If these four fields are already deployed**, NetSuite will not change a field's type in place.
> Delete them in the account and redeploy, or recreate them by hand. In an account where they have
> never been deployed — which is the current state — nothing special is needed.

### Behaviour

| Account | What happens |
|---|---|
| **Native approval routing** | The order is created in `Pending Approval`; the approval moves it to the gate; that movement is the crossing. One call, on the save that approved it |
| **No approval workflow** | NetSuite creates the order **already in the gate status**. `oldRecord` is null on a create, so nothing satisfied the gate before, and the create is itself the crossing. One call, on the save that created it. **No branch was added for this** — these accounts work because the gate is a crossing test rather than a state test, and a branch would have been the bug |
| **Custom approval field** | The order sits at the gate from creation and a field carries the approval. Both must hold, and **the field turning true is a crossing in its own right**, so an order approved with no status movement is still sent |

**Statuses past the gate now count as above it.** `alsoSatisfies` was one value per type and is now
four: Partially Fulfilled · Pending Billing/Partially Fulfilled · Pending Billing · Billed, and the
purchase equivalents. Without them a fully fulfilled order moves to `Pending Billing`, falls below
the gate, and **every later edit is silently deferred as "awaiting approval"** — a defect that
affected both kinds of account. `Closed` and `Cancelled` are deliberately absent: those belong to
order close, which is not built.

**Configuration is refused at save** (guide §4.3.1.1) when an enabled flow has no status gate, when
`Custom approval field` names no field, or when `No approval workflow` gates on the status only an
approval workflow produces — the last one would look exactly like a script that does not run.

### State after this pass

75 object files · 4 custom records · **24 custom lists** · 200 fields ·
**12 transaction line fields** · all XML well-formed · no duplicate scriptid.

---

## Pass 10 — Pass 9 reversed: NetSuite's own statuses, no custom list, no approval detection

Pass 9 built a custom status list per transaction type and an approval-mode field. **That was the
wrong shape.** Which statuses make an order sendable is a fact about **NetSuite**, not about the
client, and the question the engine has to answer is *"has this order reached a status in which it
is eligible to sync?"* — never *"does this account use approval routing?"*

### Removed — 3 lists and 6 configuration fields

| Removed | Why |
|---|---|
| `customlist_jj_rb_so_status` · `customlist_jj_rb_po_status` | A custom copy of a standard NetSuite list. Moved to `_to_delete/` |
| `customlist_jj_rb_approval_mode` | Approval-flow detection, which is exactly what must not be depended on. Moved to `_to_delete/` |
| `custrecord_jj_rb_cf_so_gate` · `_po_gate` | Nothing left to configure: the eligible statuses are the platform's |
| `custrecord_jj_rb_cf_so_approval` · `_po_approval` | Approval-mode detection |
| `custrecord_jj_rb_cf_so_approval_fld` · `_po_approval_fld` | The custom approval flag id, added in Pass 9 and never needed |

**`custrecord_jj_rb_cf_so_enabled` and `_po_enabled` are the only per-flow settings left.**
Nothing to type, nothing to leave blank, no configuration error to report — `flowConfigError` and
`stampNoGate` are gone with the fields, and `validateConfig` returns to the single-active-row check
it had before Pass 9.

### Added — `C.TXN_STATUS` in `jj_rb_core.js`

NetSuite's own transaction statuses, per record type, each row carrying **four spellings** and a
`sync` flag.

| Type | Eligible to sync | Never eligible |
|---|---|---|
| **Sales Order** | `12` Pending Fulfillment · `14` Partially Fulfilled · `15` Pending Billing/Partially Fulfilled · `16` Pending Billing · `17` Billed | `11` Pending Approval · `13` Cancelled · `18` Closed · `19` Undefined |
| **Purchase Order** | `54` Pending Receipt · `56` Partially Received · `57` Pending Billing/Partially Received · `58` Pending Bill · `59` Fully Billed | `53` Pending Supervisor Approval · `55` Rejected by Supervisor · `60` Closed · `61` Undefined · `326` Planned |

**Four spellings per row, because NetSuite hands the same status back in four shapes** depending on
how it is read — the numeric id, the `SalesOrd:B` form from a search's `statusref`, the camelCase
form from `lookupFields`, and the display text. `util.statusEntry(recordType, value)` matches any
of them, plus a Transaction Status record's prefixed name (`Sales Order : Pending Fulfillment`).
The display text alone would not do: it is translated and the codes are not.

> **The prefix is stripped only against the NAME, never against the ref.** Strip it generally and
> `SalesOrd:B` and `PurchOrd:B` both collapse to `b`, so a purchase status matches a sales row.
> A test caught exactly that.

### The one test, and both kinds of account

`atSyncStatus(entry, ctx)` — `false` not eligible · `true` just became eligible · `null` already
eligible, so the payload decides.

| Account | What happens |
|---|---|
| **With approval routing** | The order waits in `Pending Approval`, which is not eligible, so it defers. The approval moves it to `Pending Fulfillment`: `was` was not eligible, `now` is, so **that save sends** |
| **With no approval workflow** | NetSuite creates the order directly in `Pending Fulfillment`. `oldRecord` is null, so `was` is false and **the create is itself the transition** |

**Nothing asks which kind of account it is, and nothing should.** An eligible *range* rather than
one status is what keeps a partly fulfilled or fully billed order syncing edits as updates.

An unrecognised status is treated as not eligible **and written to the audit log** naming the value
and the statuses that are known — otherwise a new or custom status would present as an order that
silently never syncs.

### State after this pass

72 object files · 4 custom records · **21 custom lists** · **194 fields** ·
12 transaction line fields · all XML well-formed · no duplicate scriptid.

---

## Pass 11 — two live defects from the first PO test

No object changed. `jj_rb_txn.js` only.

### 1. `SSS_INVALID_SRCH_COL ... billaddresslist`

`readHeader` asked `search.lookupFields` for `billaddresslist` and `shipaddresslist`. Those are
**fields on the record but not search columns**, and one invalid column fails the whole read — so
every Purchase Order died before a payload was built.

**`billaddress` / `shipaddress` are valid and are the wrong fix.** They return the address as
FORMATTED TEXT — name, street, city over several lines — not an identifier, so the code that
matched them against the entity address book's internal ids could never match. It fell through to
the entity's default billing and shipping addresses on every order and looked like it worked.

**What it does now:** the identifiers are read off **the order's own address records**, through the
`billingAddress` / `shippingAddress` search joins — the same route the reference build shipped. A
transaction carries copies of the addresses it used, and the address custom fields ride along with
them, so this is the only source that knows *which* of the entity's addresses this order chose. If
the copy predates the identifier — the address was synchronized after the order was raised — the
entity's default addresses answer instead, and only then is the record load paid for.

### 2. `Blocked - missing parent UUID` on an item that was perfectly fine

> `These lines have no UOM Detail row ... item 715 (Each(1))`

**A transaction line's unit carries its conversion rate.** The line says `Each(1)`; the UOM Detail
row's Saleable Unit says `Each`. A literal comparison finds nothing, and every order blocks with a
message that reads as "the item has not synced" when the item is fine.

Both sides now go through `unitKey()`: the parenthesised part is dropped and the rest reduced to
letters and digits, so `Each(1)` ≡ `Each` ≡ ` each ` and `Fl. Oz` ≡ `FL OZ`.

**And the two causes are now told apart**, because they need different actions:

| Reason | What it means | What the message says |
|---|---|---|
| `NO_ROW` | The item has no UOM Detail row for that unit | Names the units the item **does** have rows for, so the gap is obvious |
| `NO_UUID` | The row exists; the item has not been published yet | **The item is published from here and the lines are resolved again, once** — §8.3 step 6. Only if it still has no identifier does the order block, pointing at the item's own Last Sync Try Result |

The pre-sync is once per item per execution, so one order's save cannot cascade.

### 3. The transaction date was parsed in the wrong calendar

`new Date('08/09/2026')` reads September as August on a dd/mm/yyyy account, and every
`transaction_date` sent would have been months out. It is parsed with `N/format` in the account's
own format now, and falls back to `new Date()` only when that cannot.

### What `custcol_jj_rb_product_uuid` is, and is not

It is **written in `beforeSubmit` and never read by the payload**. The builder resolves products
from the UOM Detail rows at send time, because a row can gain its identifier between the save that
stamped the line and the save that sends. The column is there for a person, a saved search and the
reconciliation page — an empty one is a symptom, never the cause.

---

## Pass 12 — names in messages · one line field, not two · order close

### 1. Every message names the record, not just its id

`named(name, id)` → `Amoxicillin 500mg Tablet (715)`. An internal id on its own sends a warehouse
manager to a saved search before they can tell which record the message is even about.

| Message | Before | Now |
|---|---|---|
| No UOM Detail row | `item 715` | `item Amoxicillin 500mg Tablet (715)` |
| Item not published | `item 715` | `item Amoxicillin 500mg Tablet (715)` |
| Dependency not synced | `the location (5)`, `the customer (77)` | `the location Main Warehouse (5)`, `the customer Acme Pharma Ltd (77)` |
| Pre-sync audit log | `item inventoryitem/715` | `item Amoxicillin 500mg Tablet (715) [inventoryitem]` |

The name comes free: the line search already reads `item`, so `getText` costs nothing, and the
header lookup already returns location and entity as `[{value,text}]`.

### 2. `custcol_jj_rb_item_eligible` removed — it duplicated `custcol_jj_rb_serialized`

**They answered the same question, and the sourced one was the weaker.**

| | `custcol_jj_rb_serialized` | `custcol_jj_rb_item_eligible` *(removed)* |
|---|---|---|
| What it holds | What THIS INTEGRATION decided for the line | What the shipped item field says |
| Under a client-configured `Eligibility Field ID` | **Correct** | **Wrong** — sourcing is wired to `custitem_jj_rb_eligible` in the object and cannot follow that setting |
| Written by | `beforeSubmit`, every save including CSV import | NetSuite sourcing |

A column that is right in some accounts and misleading in others, on the same form, is worse than
not having it. `serialized` stays; the sourced mirror moved to `_to_delete/`, and with it
`C.SOURCED_ELIG_FIELD` and the trust-the-sourced-value branch in the classifier and the line read.

### 3. Order close, cancel and delete — guide §12

| Object | Change |
|---|---|
| `custrecord_jj_rb_cf_close_action` | Default **`Mark closed`**, help rewritten, moved to the Transaction Flows subtab. No new field — it already existed |
| `customlist_jj_rb_recon_reason` | **+2**: `Order closed but still open remotely`, `Recover lost UUID` |
| `C.OPERATION` | **+2**: `Close`, `Void` (both already in `customlist_jj_rb_operation`) |
| `C.EP.TXN_READ` | `GET /transactions/{txnType}/{uuid}` — used by ONE thing: the shipment guard |
| `C.TXN_STATUS` | `terminal: true` on Closed, Cancelled and Rejected by Supervisor |

**What happens**

| Event | Behaviour |
|---|---|
| Order **closed or cancelled** | Per Close Action. `Mark closed` (default) PUTs the **last accepted payload** with `is_manually_close_transaction: true`. `Delete` voids, behind the guard. `None` sends nothing |
| Order **deleted in NetSuite** | **Always a void**, whatever Close Action says — the record it described is gone. Guard still applies. Everything read from `oldRecord`; nothing written back to a record that no longer exists |
| **Last trackable line closed** on an order that has a transaction | §12.4 — the Close Action is applied. It is not "nothing to send": the destination still holds the lines it was given, and an update would replace them with an empty set |
| Order **re-opened** after its transaction was voided | §12.5 — a 404 on the update clears the identifier and payload, opens a work item with reason `Recover lost UUID`, and creates it afresh. **Once**; a second failure must not loop |
| **Location or trading partner changed** after the create | §8.8 — the update silently DROPS both, so a work item is opened naming the new values. The update still goes; the rest of the change is legitimate |

**The shipment guard is the part that matters.** Before any void the transaction is read back. Any
shipment ⇒ refused, `Open - Needs Review`, reason `Order closed but still open remotely`. **A read
that fails also refuses** — not being able to prove it is safe is not the same as it being safe.
A read that succeeds but names no shipment field at all is taken as "none" **and audit-logged**,
because that is an assumption about TrackTraceRX's contract rather than a fact.

**Mark closed re-sends the stored payload, not a rebuilt one.** By the time an order is closed its
lines usually are too, so a fresh build carries an empty line set — and the update is a full
replace, so it would wipe the destination's lines on the way to closing them.

### State after this pass

71 object files · 4 custom records · 21 custom lists · 194 fields ·
**11 transaction line fields** · all XML well-formed · no duplicate scriptid.

---

## Pass 13 — a voided transaction could not be re-created

Found by walking one scenario: Close Action = `Delete` voids the transaction; later a
non-serialized line becomes eligible; the order is re-opened and saved.

### The defect

`stampVoided` KEEPS `custbody_jj_rb_uuid` on purpose, so the audit trail shows what was removed.
On the next eligible save the engine therefore resolves to UPDATE, gets a 404, and §12.5 recovery
clears the identity and re-runs as a CREATE. That part worked.

**But the re-run went through step 5b, which adopts an identifier from the Sync Log when the record
has none — and the Sync Log's memory was the VOID call's own row, carrying the dead identifier.**
It was written straight back onto the order, a second PUT went to the object that no longer exists,
and the once-only guard refused a second recovery. The order sat failed, pointing at nothing.

```
   PUT /transactions/purchase/TT-DEAD   404
   → clear identity, open work item "Recover lost UUID"
   → re-run … and adopt TT-DEAD back from the Sync Log
   PUT /transactions/purchase/TT-DEAD   404   ← and no recovery left
```

**Fix:** a recovery pass does not consult the Sync Log. When §12.5 clears an identity it is because
the destination object is gone, and the log's memory of it is the memory of that same dead object —
usually written by the very void that removed it.

### Two more, found alongside

| | |
|---|---|
| **410 Gone** | Treated like 404. Both mean "that object is not there". A 500 still does not recover — re-creating on a transient fault would duplicate |
| **A closed order that is edited** | Said *"not yet in a status from which it can be synchronized. It will be sent as soon as it reaches Pending Receipt…"* — sending somebody to wait for a release that is never coming. It now says the order is Closed or Cancelled and that re-opening is what changes that |

166 assertions across 7 suites.

---

## Pass 14 — the inbound write RESTlet (Item Receipt · Item Fulfilment · identifier)

`Master Scripts/jj_rl_rb_write.js` — new, the Middleware's write surface. Guide v3.1 §7.8.2, §10, §11.

| Operation | Method | Creates |
|---|---|---|
| `item_receipt` | POST | an Item Receipt from a purchase order |
| `item_fulfillment` | POST | an Item Fulfilment from a sales order |
| `identifier` | PUT | call 2 of the two-call protocol — stores the TrackTraceRX identifier |

**The two rules the whole file is built around.**

1. **An inbound write is all-or-nothing.** Any line failure rejects the *whole* submission and
   nothing is created. Posting the good lines and reporting the bad is the natural implementation
   and it is the wrong one: it consumes the `request_uuid` on a document that is missing a line, so
   a retry cannot repair it, and a receipt silently short one line is a discrepancy nothing in this
   phase will find. A receipt that does not exist is one nobody can miss.
2. **The duplicate guard is the native `externalId`.** The Middleware's `request_uuid` goes there
   and nothing else tests for a duplicate — the platform enforces uniqueness per record type, which
   is atomic and race-free. A repeat submission is answered with the record that already exists, and
   that is a **success**, not an error: it is the expected answer to a retry.

### Objects

| Object | Change |
|---|---|
| `customscript_jj_rl_rb_api.xml` | **New.** One deployment, `isdeployed F`, `isonline F`, audience `customrole_jj_rapidbridge_integration` |
| `customlist_jj_rb_try_result` | Added `Created - awaiting TrackTrace identifier` — §11.4, a legitimate state with a worklist, not a fault |
| `customlist_jj_rb_attempt_trigger` | Added `Inbound Call` |

### `jj_rb_io.js` could not stay unchanged

The guide describes the inbound RESTlet as needing no change to the IO module. It does.
`subjectValues()` hard-coded Direction = `Outbound (NS - MW)`, so an inbound call had nowhere to be
logged. It now takes the direction from its caller, and a new `recordInbound()` writes the one
closed Sync Log row an inbound call produces.

---

## Pass 15 — the read RESTlet

`Master Scripts/jj_rl_rb_read.js` — new. Guide v3.1 §7.8.1 · Master Data Guide v3.3 §7.14 ·
Master Data Design v1.1 §11–§12.

| Operation | Answers | Sync Type |
|---|---|---|
| `list_transactions` | which documents may this operator scan | `Transaction Fetch` |
| `fetch_transaction` | everything needed to scan one of them | `Transaction Fetch` |
| `allowed_bins_for_item` | 26 Aug Q4 — bins attached to the item **and available** | `Bin Query` |
| `fulfilment_exceptions` | 7 Sep Q1 — the reasons the app offers on a short pick | `Transaction Fetch` |
| `bins_for_location` | Design §12.5 level 1 | `Bin Query` |
| `bin_contents` | level 2 | `Bin Query` |
| `item_availability` | level 3 | `Bin Query` |

### Why a second RESTlet and not seven more operations on the first

A read and a write share a body shape and nothing else. A write is rare, creates a record, must
never be repeated by accident, and every failure of it is somebody's work item. A read is constant,
creates nothing, is **safe** to repeat, and a failure of it is a failed lookup the operator repeats
— Design v1.1 §11.12 says in so many words that a failed bin query must not appear on a
reconciliation page. One file would have meant one governance budget, one deployment, one role
audience and one logging posture for two things that want four different ones. The split is also
what lets a scanning role be given the reads without being given the ability to create an Item
Receipt.

### The three rules

1. **Nothing here writes.** Not a record, not a field, not a stamp. The only thing the script
   creates is its own Sync Log row. The test harness throws on `record.create`, `record.submitFields`
   and `save()`, so this is enforced rather than intended.
2. **Nothing here opens a work item.** Every log row closes on the spot under Direction
   `Inbound Query (MW - NS read)` and status `Closed - No Action Needed`, **on the failure path as
   well as the success path**. That one filter is what keeps a device polling every few seconds out
   of every worklist in the SuiteApp.
3. **Every list is capped** at `C.READ_PAGE.MAX` = 1,000, default 200.

### Two decisions worth recording

**`fetch_transaction` transforms the order to read its line keys.** `line_unique_key` in the
response is the value the *write* RESTlet matches a submitted line on: the `orderline` field of the
receipt or fulfilment the order transforms into. So the read transforms the order — read-only,
never saved — and takes the keys off the transformed document rather than deriving them by counting
the order's lines. That costs one transform and buys the property that makes the whole scan work:
the key the device sends back is, by construction, a key the write side will find. A counted key is
right until an order has a closed line, a drop-ship line or a line the receipt does not carry, and
then it is wrong in a way that surfaces as `LINE_NOT_ON_ORDER` *after* the goods are on the dock.
The transform also supplies `quantity_remaining` and decides which lines appear at all — NetSuite
omits the ones there is nothing left to receive on, so nothing here has to filter.

**`list_transactions` searches lines and groups, rather than `mainline is T`.** Two reasons, both
correctness:

- **Location.** On a sales order the location can live on the line. On a mainline-only search a
  line-level-location account has a blank body location, so a body-level location filter drops every
  order it should have returned. NetSuite copies a body location down to the lines, so filtering the
  line catches both arrangements and misses neither.
- **Remaining quantity.** "Fully processed" is a line fact, not a header one. A purchase order every
  line of which has been received sits at `Pending Bill` — which is `sync: true`, because an edit to
  it must still reach TrackTrace — and has nothing left to receive. Only the lines know that.

**And the filter §7.8.1 calls out as the easy one to forget:** `custbody_jj_rb_uuid isnotempty`. An
order approved before the integration was switched on was never sent, so TrackTrace has nothing to
scan against. Leave it in the list and the operator picks it, scans a full pallet, and the
submission fails at the record level with everything already counted.

### Objects

| Object | Change |
|---|---|
| `customscript_jj_rl_rb_read.xml` | **New.** One deployment, `isdeployed F`, `isonline F`, audience `customrole_jj_rapidbridge_integration` |
| `manifest.xml` | Removed a stray `1` after `</feature>` on the `SERVERSIDESCRIPTING` line, which fails `project:validate` |

**No new fields and no new lists.** Every value the read surface needs was already seeded and had no
code behind it: `Bin Query` and `Transaction Fetch` on `customlist_jj_rb_sync_type`,
`Inbound Query (MW - NS read)` on `customlist_jj_rb_direction`, and the seven values of
`customlist_jj_rb_fulfil_exception` — which is now *served* to the mobile app rather than duplicated
inside it, so a client adding a reason sees it offered.

### Core and IO

| File | Change |
|---|---|
| `jj_rb_core.js` | `DIRECTION.INBOUND_QUERY` · `SYNCTYPE.BIN_QUERY` + `TXN_FETCH` · seven read operations on `INBOUND` · `REC.FULFIL_EXCEPTION` · new `READ_ERR` code set · `READ_PAGE` |
| `jj_rb_io.js` | `recordInbound` takes `o.direction` instead of hard-coding `Inbound (MW - NS)` |

`READ_ERR` is its own set rather than a reuse of `DOC_ERR` because a read failure means something
different to the caller: nothing was attempted, nothing is half-done, and the answer to every one of
them is "ask again with better parameters", never "correct the data and resubmit".

### Open points this pass touched

| | |
|---|---|
| **T-22 — availability with no bins** | Answered provisionally: an account with `Use Bins` off gets an **empty list and a `use_bins: false` flag**, never an error. The operator can still scan; they just make no bin selection. Confirm with TrackTrace |
| **T-21 — name or internal id** | This build takes **internal ids** on every read and returns both the id and the name. The agreed example used names, which are neither unique nor stable. Confirm |
| **Operator location** | The **Middleware is the authority**, not NetSuite: the RESTlet runs under the integration's credentials, so `getCurrentUser()` is a service account whose location says nothing about who is scanning. The `location` parameter wins; the current user's location is a fallback for a token-per-operator account; neither ⇒ **no filter, and the response says so** in `location_filter`. Silently returning every warehouse's work while the caller believes it is filtered is the failure mode worth spending a response field on |

354 assertions across 9 suites.

---

## Pass 16 — a clean read stops writing a Sync Log row

`jj_rl_rb_read.js`, `jj_rb_core.js`.

### The change

Pass 15 wrote one closed Sync Log row per read, success or failure. That followed the design
documents, which ask for reads to be logged under their own Sync Type so a polling scanner can be
**excluded** from the worklists (Design v1.1 §11.12).

Not writing the row at all reaches the same end more directly, and it fixes the thing that made the
original rule uncomfortable: a warehouse opens hundreds of scan sessions a day, each one several
reads, and a row per browse buries the rows that mean something under the rows that do not.

**A read now writes a row only when:**

1. **It failed.** No exceptions — every `C.READ_ERR` refusal writes one.
2. **Something unexpected was detected about an answer that succeeded.** New code set
   `C.READ_NOTE`.

### `C.READ_NOTE` — the success path needed a rule more than the failure path did

A failed read gets retried and complained about within minutes. An answer that is silently short a
line, silently unfiltered, or silently truncated is **acted on**. Those are the cases nobody reports
and nobody finds, so those are the ones worth a row.

| Code | Raised when | Why it matters |
|---|---|---|
| `UNFILTERED_LIST` | `list_transactions` returned rows with no location filter | The operator is being offered every warehouse's work, and the list looks perfectly normal doing it |
| `LINES_NOT_SCANNABLE` | `fetch_transaction` returned a line that requires serialization and has no `product_uuid` | Scanning it would be refused at submit, after the goods are on the dock |
| `NO_SCANNABLE_LINES` | `fetch_transaction` transformed the order and found no item line | The order was offered for selection and there is nothing on it |
| `RESULT_TRUNCATED` | An unpaged list filled to `READ_PAGE.MAX` and was cut off | The caller cannot tell truncation from "that is all there is". On `item_availability` the returned total is then a **floor**, not the true quantity |
| `DEGRADED_READ` | A sub-search failed and the read carried on with less than it should have | The answer is thinner than it looks. A broken Eligibility Field ID makes **every** line read `requires_serialization: false` |

**Three of these were previously swallowed into `log.error` and nothing else** — the eligibility
field that will not read, the item-to-bin join the account's features do not support, and the UOM
read that fails. They degraded the answer silently and left no trace anybody would find.

### The row a note produces

`outcome = Success`, status `Closed - No Action Needed`, no error class, the note code in the error
fields. That is the honest reading: the call worked, and something about the answer wants a human.
Rule 2's other half is unchanged — **a read still never opens a work item**, so a warehouse's every
mistyped bin code stays off the reconciliation page.

### The caller is told as well

The notes are returned on the envelope, so the Middleware can act without waiting for somebody to
read a Sync Log:

```json
{ "success": true, "…": "…",
  "notes": [ { "code": "LINES_NOT_SCANNABLE", "message": "1 of 2 line(s) on order PO-1001 (55) …" } ] }
```

Additive and present only when something is off. **Whether the Middleware surfaces a note to the
operator, raises it to a supervisor, or only records it is not agreed** — added to the open points.

### Objects

**None.** No new field, no new list, no new list value. `C.READ_NOTE` is a code set in the module,
and the row it writes uses the same Direction, Sync Type and status values Pass 15 already used.

378 assertions across 9 suites, of which 161 cover the read RESTlet.

---

## Pass 17 — five corrections from the first live Postman run

`jj_rb_core.js` · `jj_rl_rb_read.js` · `jj_rl_rb_write.js` · `jj_cs_rb_forms.js`.
Also: `jj_rl_rb_api.js` was renamed to **`jj_rl_rb_write.js`** and the script object repointed at it.
The script id stays `customscript_jj_rl_rb_api`.

### 1. The item form's UOM warning was wrong on all three counts

Three separate defects in one twelve-line function, and each hid the next.

| | What happened | Why |
|---|---|---|
| **The message vanished** | On a fast save the user saw a flash and nothing else | `dialog.alert()` returns a promise and the code ignored it, returning `true` at once. NetSuite submitted the form, navigated away, and destroyed the modal mid-render. **A message that must be read cannot be shown by something the save does not wait for** |
| **No warning at all on create** | The path where it matters most was silent | The check searched UOM Detail with `[U.item, 'anyof', rec.id]`, and on a new record `rec.id` is null. `anyof` with no value throws, the `catch` swallowed it, and the function returned `true` |
| **"No UOM Detail" right after adding the first rows** | The user added rows, saved, and was told there were none | `custrecord_jj_rb_uom_item` is `isparent = T`, so UOM Detail renders as a **sublist on the item form** and its rows are saved *with* the parent. In `saveRecord` those rows exist only in the form; the database still has none. The search answered honestly and the answer was useless |

**Fixes.** The save is now **refused on the first pass** — `dialog.confirm`, `return false` — and the
record is saved from the promise once the user has answered. The save waits because it has not
started. Row counting reads the **sublist first** (`recmachcustrecord_jj_rb_uom_item`, skipping
inactive rows) and falls back to a search only for a form that does not show it; on create there is
nothing to search for, so zero is an *answer*, not an error to swallow. A search that genuinely
fails now says **nothing** rather than warning wrongly.

Still advisory — it never blocks. A form that cannot self-save tells the user to press Save again
rather than stranding them.

### 2. `list_transactions` no longer echoes a `statuses` array

It handed back the filter the caller had just chosen. Every transaction already carries its own
`status` and `status_ref`, and the scannable set is a NetSuite fact rather than per-call state. A
**refusal** still lists the scannable names in its message, which is where that information is
actually wanted. Both PO and SO.

### 3. `product_uuid` never resolved — the unit was an internal id

**The reported symptom:** every line came back `NO_ROW: the item has no UOM Detail row for unit
"23". It has: EACH, PALLET`, with UOM Detail rows that were perfectly correct.

**The cause.** A transaction line stores its unit as an **internal id**. `getSublistText` on a
transformed record does not reliably resolve it, v1.0 fell back to the raw value, and every line
reported `unit: "23"`. `unitKey("23")` can never match `EACH`, so the lookup compared an id against
a name and failed forever.

**The reference build hit this and gave up.** `jj_ue_tracktracerx_transaction_sync_natpl_2.js`
reads `unitsdisplay`, then hardcodes the answer, with the real attempt left commented above it:

```javascript
// itemUnit = (itemUnit == 'EA') ? 'Each' : itemUnit;
   itemUnit='Each'
```

Its UOM lookup reads the row's unit with `getText()` — a **custom list display name** — while the
line offers an abbreviation. That mismatch is the whole problem, and hardcoding `'Each'` is what
made a single-unit account work and a multi-unit one silently wrong.

**Fix — a candidate ladder, not a guess.** One `unitstype` search resolves the line's unit ids to
name, abbreviation, plural forms, conversion rate and base-unit flag. `uomRowFor` then tries, in
order: **unit name → abbreviation → the line's own `unitsdisplay` → plural name → plural
abbreviation**, and only when all of those miss does it try `C.UNIT_ALIAS` — the standard
abbreviation of each of the seven values in `customlist_jj_rb_saleable_unit`. That table is bounded
by a list this SuiteApp owns; it is not a guess at arbitrary text, and a client who spells their
units out in full never reaches it.

New on every line: `unit` is now the **name**, with `unit_id` beside it, plus `unit_abbreviation`,
`conversion_rate`, `is_base_unit`, `quantity_in_base_units`, `remaining_in_base_units` and
`uom_unit_matched` — which spelling actually found the row. The base unit is always Each (proposal
v4 §5.2), so the converted quantity is what TrackTrace counts in.

A failed `unitstype` search is a `DEGRADED_READ` note, not a crash: an account without Multiple
Units of Measure has no such records, and the line's own display is still a candidate.

### 4. An Item Receipt has no identifier of its own

**Corrected from TrackTraceRX.** What call 2 returns for an IR or IF is the **shipment UUID**, and
one shipment can cover several purchase or sales orders — so several receipts legitimately carry
the same one. Orders are the opposite: a PO or SO gets a transaction UUID that *is* unique per
record.

| | Before | Now |
|---|---|---|
| Stored in | `custbody_jj_rb_uuid` | **`custbody_jj_rb_shipment_uuid`** |
| Uniqueness | `findByUuid` refused a second claimant | **No check.** Sharing is the normal case |
| Body key | `tracktrace_uuid` | `shipment_uuid` (the older two spellings still accepted) |

`findByUuid` is **deleted** from the write RESTlet. It was correct for an order and wrong for a
receipt, and leaving it would have made a multi-order delivery impossible to record — the second
receipt coming back `DUPLICATE_IDENTIFIER` with nothing whatever wrong.

**Nothing is weaker for this.** The duplicate guard was never that check: it is the Middleware's
`request_uuid` in the native `externalId`, unique per submission and enforced by the platform
(§4.1.2).

Writing a shipment UUID into `custbody_jj_rb_uuid` would also have been actively harmful — the
receipt would read as an order with its own TrackTrace object, and the outbound engine would later
try to PUT updates to something that was never a transaction.

### Objects

**None.** No new field, no new list, no new list value. `C.UNIT_ALIAS` is a constant in the module.

464 assertions across 11 suites — `t10` covers the unit ladder, `t11` the client script.

---

## Pass 18 — when a Sync Log row may be created

`jj_rb_core.js` · `jj_rb_io.js` · `jj_rb_sync.js`.

### The rule

**Four admissible reasons — `C.LOG_REASON`:**

| | |
|---|---|
| `CALL` | An API call was made, or was about to be and was suppressed (kill switch, dry run, environment gate) |
| `ERROR` | Something failed, expected or not |
| `ACTION` | A person must do something before this can proceed |
| `NOTICE` | Something must be said that the NetSuite record cannot carry — in practice, the record is gone and there is nothing left to stamp |

**Routine processing writes nothing.** No change, feature disabled, not eligible, nothing to do:
those are stamped on the record's own Last Sync Try fields by `stampTry`, which creates no row at
all. An account saving two thousand items a day must not produce two thousand rows saying nothing
happened — the rows that matter drown in them.

### What the audit found

The architecture already mostly obeyed this. Every "nothing happened" path in the engine already
went to `stampTry`, and §12.9 had already excluded one routine skip by hand. **Four functions, and
only four, create a Sync Log row:**

| | Reason | |
|---|---|---|
| `openCall` | CALL | One row per HTTP call, opened before it goes out |
| `openDeferred` | ACTION | Real work, unsent, still owed. Always OPEN, and it joins an existing work item rather than minting a second for one subject |
| `recordInbound` | CALL / ERROR | The Middleware called us. A clean READ writes nothing — Pass 16 |
| `recordNoCall` | NOTICE | No call, no record left to stamp |

All fourteen `openDeferred` sites were checked against the rule and all fourteen are admissible —
each is either a blocked state needing a person (`Open - Needs Review`) or real work queued for the
sweep (`Open - Pending Retry`). The `closeNoAction` and `parkUnsent` sites all follow an *attempted*
call that was suppressed, so a row already exists and must be closed rather than left open for ever.

**One violation, in the delete path.** A record deleted in NetSuite that had never been accepted
remotely wrote a closed row saying so. No call, no error, nothing anybody must act on — and on a
go-live that imports and then tidies up, or on any account that deletes drafts, that is one row per
deletion recording that the integration had no opinion. It now goes to the execution log and
nowhere else.

### The rule is enforced, not merely documented

`recordNoCall` is the one writer with no call behind it and no obligation to stay open, so it is the
one place a caller can ask for a row that should not exist. It now refuses:

```javascript
if (!isOpen && !o.errorCode && !o.errorClass && !o.suggested) { … return null; }
```

An OPEN row is always admissible — open means somebody still owes the work, which is `ACTION` by
definition. A CLOSED row must carry an error, or **say what the reader should do about it**. That
last clause is the useful one: the difference between a notice and noise is whether anything can be
suggested, and if nothing can be, there was nothing to say.

Callers already treated the row as advisory on every path that reaches here, so returning null is
safe. The refusal is written to the execution log with the rule that refused it, so a developer who
expected a row finds out why there is none.

### One site gained a suggestion rather than losing its row

The other delete-path notice — a record deleted in NetSuite whose type has **no delete endpoint**,
leaving a remote orphan — would have been dropped by the same guard. It should not be: a human has
to go and remove that object. It now says so, which is what it was missing all along:

> Find the object in TrackTraceRX and remove it by hand. Nothing in NetSuite points at it any more.

### Objects

**None.**

486 assertions across 12 suites. `t12` tests the rule itself: routine refused, error written, open
always written, a closed notice written only with a suggestion, `stampTry` creating no row, and a
source-level assertion that exactly four functions can create one.

---

## Pass 19 — scan session dropped · scannable ≠ syncable · expected refusals stop logging

`jj_rb_core.js` · `jj_rl_rb_read.js` · `jj_rl_rb_write.js`.

### 1. `scan_session_id` removed

Not required at this time. The payload key, the stamp, the `C.TXN.scanSession` entry and the field
object all went together — a half-removal that leaves an unwritten field on the form is worse than
either state.

`custbody_jj_rb_scan_session.xml` moved to `_to_delete/`. The field is **not** referenced by any
subtab or form object, so nothing else moves with it.

A body that still sends `scan_session_id` is simply ignored. `t8` keeps sending it on purpose, to
prove that an unknown key is harmless rather than fatal.

### 2. `scannable` is a narrower set than `sync`

**Two different questions, and the gap between them is the point.**

| | |
|---|---|
| `sync` | May this order's payload be **sent** to TrackTraceRX? |
| `scannable` | Has this order anything **left to receive or fulfil**? |

A purchase order at **Pending Bill** has been fully received — every unit is in. It stays
`sync: true`, because an edit to it (a corrected address, a changed quantity) must still reach the
destination, and closing that door would leave the two systems disagreeing. But offering it to an
operator wastes a trip to the dock: there is nothing to put on a receipt, and the transform would
produce an empty document.

**Fully Billed**, **Pending Billing** and **Billed** are the same case, further along.

| Type | Scannable |
|---|---|
| Purchase Order | Pending Receipt · Partially Received · Pending Billing/Partially Received |
| Sales Order | Pending Fulfillment · Partially Fulfilled · Pending Billing/Partially Fulfilled |

**The partial statuses stay in.** `Pending Billing/Partially Received` means *some* of it is billed
and *some* is still outstanding; the billing half is noise to a warehouse, and dropping them would
hide genuinely open work.

Applied in three places: `list_transactions` filters on it, `fetch_transaction` refuses on it, and
the **write** RESTlet refuses `item_receipt` / `item_fulfillment` on it — so the refusal says in
words what the transform would otherwise have failed at obscurely.

The refusal message distinguishes the two cases, because they need different responses from a
reader:

> Order PO447 (16050) is "Pending Bill", which has nothing left to receive or fulfil. The statuses
> that do are: Pending Receipt, Partially Received, Pending Billing/Partially Received. It should
> never have been offered for selection.

and on a fetch, when the order is still synchronized:

> …It is still synchronized with TrackTraceRX; it simply has nothing left to receive or fulfil.

**The outbound gate is untouched.** `atSyncStatus` still reads `sync`, so an edit to a billed order
still reaches the destination. Narrowing that would have been a silent data-divergence bug, not a
tidy-up.

### 3. An expected refusal writes no Sync Log row

Pass 16 stopped logging clean reads. This stops logging the refusals that are **answers rather than
faults**.

A caller asking for a purchase order that does not exist, or one that was never sent to
TrackTraceRX, has not found a defect — it has found something out, which is what a read is for. The
envelope *is* the answer, and the next call carries better parameters. Logging those puts every
mistyped id and every stale cache entry on the reconciliation page, which is the opposite of what
that page is for.

**`C.READ_EXPECTED` — twelve codes, no row:**

`UNKNOWN_OPERATION` · `MALFORMED_PAYLOAD` · `MISSING_PARAMETER` · `UNKNOWN_RECORD_TYPE` ·
`NOT_IMPLEMENTED` · `TRANSACTION_NOT_FOUND` · `TRANSACTION_NOT_SYNCED` ·
`TRANSACTION_NOT_SCANNABLE` · `LOCATION_NOT_FOUND` · `BIN_NOT_FOUND` · `ITEM_NOT_FOUND` ·
`BINS_NOT_ENABLED`

**What still writes:**

| | |
|---|---|
| `NO_CONFIGURATION` | The account is misconfigured. Nothing inbound works until a person fixes it — `C.LOG_REASON` ACTION |
| `SEARCH_FAILED` | NetSuite refused a search this script asked for. A defect in the SuiteApp or the account's field setup — ERROR |
| Anything unhandled | A bug, by definition |
| `C.READ_NOTE` | Unexpected behaviour on an answer that **succeeded** — the whole reason that set exists |

Every refusal still goes to the NetSuite execution log with the rule that filtered it, so a
developer who expected a row finds out why there is none.

The dispatch order changed as a consequence: the **unknown-operation check now runs before the
configuration check**, because an unknown operation is the caller's problem and reporting a missing
configuration row first would blame the account for a typo.

### Objects

| Object | Change |
|---|---|
| `custbody_jj_rb_scan_session.xml` | **Moved to `_to_delete/`** |

No other object touched. `scannable` and `READ_EXPECTED` are constants in the module.

511 assertions across 12 suites.

---

## Pass 20 — the account supplies its own unit vocabulary

`jj_rb_core.js` · `jj_rb_txn.js` · `jj_rl_rb_read.js` · 12 transaction body field objects.

### Adopted from the development folder, unchanged

| | |
|---|---|
| `jj_rl_rb_api.js` → **`jj_rl_rb_write.js`** | The rename and every reference to it |
| `recordType: 'itemreceipt'` | String literals in `INBOUND_MAP` and `SCAN` instead of `record.Type.*`. **The `record` module is not loaded when those constants are evaluated**, so the enum reads `undefined` and the map keys silently become the string `"undefined"` — two rows collapsing into one. The literal is correct and it is what is kept |

Device debug statements were stripped. One of them had **replaced** the line that populates `unitIds`, so unit resolution was dead on that copy — rewritten here regardless.

### `UNIT_ALIAS` deleted. The item knows.

Pass 17 fixed the symptom with a hardcoded abbreviation table — `EA` → `EACH`, and six more. That was
wrong in principle for a SuiteApp whose whole purpose is to stop per-client hardcoding, and wrong in
practice the moment an account used a unit called `Vial` or `Blister`.

**It also solved the wrong problem.** The earlier `readUnits` searched `unitstype` filtered by the
**line's** unit value. That cannot work: a `unitstype` record's internal id is the **TYPE's**, not
the individual unit's. The search matched nothing on every call, and the alias table was quietly
carrying the entire feature.

**NetSuite already holds the translation.** Every item names a Units Type; every Units Type lists its
units with a name, an abbreviation, both plurals and a conversion rate. `core.units` reads that:

```
item → unitstype id → that type's units → { EA, EACH, PALLET, PLT, PLTS … } → canonical NAME
```

The canonical name is then matched against UOM Detail. **One candidate, no ladder.** By the time
`uomRowFor` runs there is nothing left to guess at — a name that does not match is a real mismatch
between the Units Type and the UOM Detail table, and saying so is more useful than trying six more
spellings.

### Governance

**Two searches per document, not two per line.**

| | |
|---|---|
| items → their Units Type | **Zero extra searches** on both paths. `readItems` and `classifyLines` already search `item`; `unitstype` rides along as one more column |
| the units themselves | **ONE** `unitstype` search over the **distinct** type ids |

A twelve-line order with three items on one Units Type costs one search here. `t10` asserts exactly
that: twelve lines, one `unitstype` search, at most one `item` search.

`resolveProducts` loads the book **once** and reuses it across the pre-sync retry rather than
reloading after re-reading the product map.

### Two failures, and they were one before

Telling them apart is the point, because the fix differs:

| | Meaning | Fix |
|---|---|---|
| `UNIT_UNKNOWN` | The unit is not in the item's Units Type at all. **No UOM Detail row could ever match it** | Correct the Units Type |
| `NO_ROW` | The unit resolved to a name, and UOM Detail has no row for that name | Add a UOM Detail row |

The read returns both on the line; the outbound block message names the unit **as the line spells it
and as it resolved**, because "EA did not resolve" and "Each has no UOM row" are different clues.

A unit that cannot be resolved is **not** guessed around. The outbound path blocks the order
(`Blocked — missing parent UUID`, work item open) rather than sending a product it inferred.

### The same bug was in the outbound path

`jj_rb_txn.js`'s `lineUnit` reads `getSublistText('units')`, which returns the abbreviation on a
loaded record exactly as it does on a transformed one. `classifyLines` and `applyProducts` now go
through the same resolver, so the stamped `custcol_jj_rb_product_uuid` and the payload's
`product_uuid` agree with what `fetch_transaction` reports. They could not before.

### Objects

| Object | Change |
|---|---|
| `custtab_jj_rb_transaction` | Already present. **All 12 `custbody_jj_rb_*` fields now carry `<subtab>[scriptid=custtab_jj_rb_transaction]</subtab>`** — every one was empty, so the fields were scattered across the main form instead of grouped |

No new object. `custtab_jj_rb_transaction` matches the four that already exist for entity, item,
UOM and employee, so a transaction now reads the same way as every other record this SuiteApp
touches.

531 assertions across 12 suites. `t10` covers the resolver end to end, including an account-specific
unit that appears in no table anywhere, and the governance assertion.

---

## Pass 21 — the unit is an id, and `record.load` is the only thing that knows it

`jj_rb_core.js` · `jj_rb_txn.js` · `jj_rl_rb_read.js`.

Pass 20 removed the hardcoded alias table and replaced it with a `unitstype` **search**. The live run
proved the search cannot work, and the account's own console output is the proof:

```
units            Value: 23        Text: PF
unitslist        Value: 1222324   Text: 1222324
unitconversionrate Value: 16      Text: 16
origunits        Value: 23        Text: 23
```

```json
{ "line_unique_key": "1", "item": "718 (718)",
  "reason": "UNIT_UNKNOWN: \"23\" is not a unit of this item's Units Type. It offers: Each(1), Case, Pallet, Package." }
```

The line carries **23**. The index was keyed on `EACH`, `PF`, `PALLETS` and the like. `23` was never
going to be in it.

### A `unitstype` search cannot return a unit's id

| | |
|---|---|
| `search.create({ type: 'unitstype' })` | One result row per **unit**, but `internalid` is the **TYPE's**, repeated on every row. No column carries the unit's own id |
| `record.load({ type: 'unitstype' })` | The `uom` **sublist**, one line per unit, and `getSublistValue('internalid')` on it **is the unit's id** |

So the resolver loads the type instead of searching it. `['N/search']` became `['N/search', 'N/record']`
in `jj_rb_core.js` for exactly this.

```
item → unitstype id → record.load → uom sublist → { id, name, abbreviation, rate, isBase }
```

Resolution is now **by id**, which is an exact match against what the line actually holds. Name and
abbreviation remain as a fallback for a form that exposes no id — they are no longer the mechanism.

### One object per unit

The Pass 20 index built **eleven keys for four units** — name, abbreviation, plural name, plural
abbreviation, each with its own copy of the unit:

```
1: { EACH:{…}, EA:{…}, CASE:{…}, CA:{…}, CASES:{…}, PALLET:{…}, PF:{…},
     PALLETS:{…}, PACKAGE:{…}, PK:{…}, PACKAGES:{…} }
```

Now **one object per unit**, with the id key and the two spelling keys pointing at the same object:

```
1: { '23':pallet, 'PALLET':pallet, 'PF':pallet, '1':each, 'EACH':each, 'EA':each, … }
```

Plurals are gone. Nothing produces a plural anywhere an id is unavailable, and an index nothing reads
is one more thing to keep correct. Ids are numeric and spellings are alphabetic, so the two key spaces
cannot collide.

### Scoped per type, not global

A unit id is unique across the account, so a single flat id index would resolve a unit belonging to a
Units Type the item does not use. That is a **data error worth reporting**, not something to paper
over — the line and the item disagree about which type applies. The index is therefore one map per
type, and `nameFor(itemId, raw)` looks only inside the type the item names. A test asserts that
resolving unit `23` for an item whose type does not contain it returns **nothing**.

### Value first, not text first

```js
const unitId  = String(sv('units') || '');
const unitRaw = unitId || st('units') || st('unitsdisplay') || String(sv('unitsdisplay') || '');
```

Asking for the text first is what produced `"23"` in the failure message: on a **transformed** record
`getSublistText` frequently returns nothing and the ladder fell through to the raw value by accident.
The id is now what is asked for on purpose, and `unit_id` is carried on the line beside the resolved
`unit` name.

### Governance

| | |
|---|---|
| items → their Units Type | **Zero extra searches.** `readItems` / `classifyLines` already search `item`; `unitstype` is one more column |
| the units themselves | **One `record.load` per DISTINCT Units Type.** Zero searches |

`t10` asserts it: twelve lines across three items on one Units Type cost **one `record.load` and no
`unitstype` search**. A failed load (Multiple Units of Measure off, or a deleted type) is an audit
line and an unresolved unit, never a thrown read.

### The note said nothing a reader could act on

Before:

```
2 of 3 line(s) on order PO448 (16352) require serialization and have no product UUID:
718 (718) [UNIT_UNKNOWN], 719 (719) [UNIT_UNKNOWN]. Scanning them would be refused at submit, on the dock.
```

No line number, no unit, a bare code, and no fix. After:

```
Order PO448 (16352): 2 of 3 line(s) cannot be scanned.
line 1 — Widget A (718) in Pallet — UNIT_UNKNOWN;
line 2 — Widget B (719) in Each — NO_ROW.
UNIT_UNKNOWN means the line's unit is not in the item's Units Type, so no UOM Detail row could ever
match it — fix the item's Units Type first. NO_ROW means the unit resolved but the item has no UOM
Detail row for it — add one whose Saleable Unit is that unit.
Until then the device must not offer these lines: a scan against them is refused at submit, with the
goods already on the dock.
```

Line, item, unit, cause, and the fix for each distinct cause — `unresolvedAdvice()` groups by code so
one order with two problems reads as two problems. The `lines_not_scannable` entries gained `unit`,
`unit_id` and `code` alongside the prose `reason`.

The per-line reason distinguishes the two shapes of `UNIT_UNKNOWN`:

| | |
|---|---|
| item has a Units Type | `the line is in unit id 23, which is not in this item's Units Type. That type offers: Each(1), Case, Pallet, Package.` |
| item has none | `this item has no Units Type … Set a Units Type on the item.` |

### Still open

An account with **Multiple Units of Measure switched off** has no Units Type on any item, so every
line reports `UNIT_UNKNOWN`. A fallback straight to the single UOM Detail row would serve that account,
and has not been built — it needs a decision on whether a one-row UOM Detail table may be assumed to
describe the line's unit.

544 assertions across 12 suites. `t10` grew to 72: id resolution, scoped-not-global lookup, same-object
identity across every lookup path, an account-specific unit (`Vial`) present in no table anywhere, the
two distinct failures, the message content, and the governance count.

---

## Pass 22 — a Sync Log row means somebody has to do something

`jj_rb_core.js` · `jj_rl_rb_read.js` · `expected_payload.md` · the Postman collection.

Three corrections from the second live run, all of them about **what is worth saying**.

### 1. A non-eligible item is not missing a UUID

```json
"product_uuid_missing_reason": "NO_ROW: the item has no UOM Detail row for unit \"Test\". It has: EACH. Add a UOM Detail row for that unit, or correct the Saleable Unit on an existing one."
```

That line's item **is not eligible**. It is never sent to TrackTraceRX, so it has no product
UUID **by design** — the UOM Detail table has no row for it because it should not have one. The
message was telling a reader to go and fix something that is already right.

`fetch_transaction` now reports the reason **only on an eligible line**:

```js
product_uuid_missing_reason: info.eligible === true ? row.reason : '',
```

The real cost of the old behaviour was not the noise. It was that a reader who sees the field
filled on lines where nothing is wrong learns to skip it, and then skips it on the line where it
matters. `lines_not_scannable` already counted only eligible lines; the per-line field now agrees
with it.

The outbound path needed no change — `filterLines` drops non-serialized lines before
`applyProducts` ever sees them.

### 2. Two classes of note, and only one of them is a work item

Every note used to write a Sync Log row, all of them `Closed - No Action Needed` with a
`suggested` that said, in so many words, that no action was needed. A row that says nothing is
wanted is a row nobody should have written.

`C.READ_NOTE_REVIEW` splits them:

| Note | Row? | Why |
|---|---|---|
| `LINES_NOT_SCANNABLE` | **OPEN - Needs Review** | An **eligible** item on a live order has no product UUID for the unit the line is in. The device is refused at submit with the goods on the dock. Only a person inside NetSuite can fix it |
| `DEGRADED_READ` | **OPEN - Needs Review** | A configured field is not deployed, or a join the account's features do not support. An administrator has to make the answer whole |
| `RESULT_TRUNCATED` | audit only | The caller asked for more than a page. It pages |
| `NO_SCANNABLE_LINES` | audit only | The order has no item line. That is the order, not a fault |
| `UNFILTERED_LIST` | audit only | The caller omitted the location filter. The caller is who can add it |

A clean read still writes nothing at all. That has not changed since Pass 16 and is the point of
the whole sequence.

**The row is OPEN now, and that is the change.** Pass 15 closed every read row on the reasoning
that a failed lookup is a lookup the operator repeats. True — but `LINES_NOT_SCANNABLE` is not a
failed lookup. The read **succeeded**, the device got the order, and two of its lines will be
refused at submit. Nobody discovers that by reading a closed row, which is exactly how this
reached a live run.

`suggested` now names the fix rather than disclaiming one.

### 3. One open row per order per code

A device polling the same order every thirty seconds would open a work item every thirty seconds,
all of them saying the same thing.

```js
if (review && alreadyOpen(recType, txnId, code)) return;
```

One search, four filters — open, record type, internal id, error code — and **it runs only when a
review note fired**, so the path that runs all day costs nothing. The code is part of the key on
purpose: an order whose UOM Detail is missing *and* whose read came back degraded has two
problems and two people to fix them. A search that throws returns `false`; writing a duplicate row
is a much smaller failure than silently writing none.

The dedupe key is the **resolved** NetSuite type, not the caller's spelling. `PO`, `po` and
`purchaseorder` are one subject, and a key that disagreed with itself across spellings would open
one work item per spelling the device happens to send.

### Postman

| | |
|---|---|
| `scan_session_id` | Removed from all three write bodies. Dropped from the scripts in Pass 19; the collection still sent it |
| **4.5 — a status that syncs but cannot be scanned** | New. `status=Pending Bill` is refused. It proves the two sets are different questions: `sync` asks *may the payload be sent* (yes — an edit to a billed order must still reach TrackTrace), `scannable` asks *is anything left to receive* (no). Narrowing `sync` to match `scannable` is a silent data-divergence bug, and this is the request that would catch it. 4.5–4.12 renumbered to 4.6–4.13 |
| 1.4 | Two assertions added: a non-eligible line carries no missing-UUID reason, and every entry in `lines_not_scannable` belongs to a line that is eligible |

`expected_payload.md` updated to match — the `fetch_transaction` example now shows the live
account's Pallet line (`unit_id: "23"`, rate 16), a populated `lines_not_scannable` block, the
three codes with their fixes, and the Sync Log rule for reads.

564 assertions across 12 suites. `t9` covers the five notes and their two classes, the OPEN
status, the dedupe, and that a different code on the same order is a different finding. `t10`
covers the non-eligible line: no reason, not counted, no note, no row — and a mixed order where
the note counts one of two lines.

---

## Pass 23 — inventory_release: the Bin Transfer, and the lot arrives by name

`jj_rb_core.js` · `jj_rl_rb_write.js` · 4 new transaction body fields · `t13.js`.

The last unbuilt Phase 1 flow. §11.6 / Design v3.1 §9.

### What it is

An Item Receipt puts received stock in the location's **on-hold bin** because it has not yet been
proved genuine. TrackTrace runs EPCIS verification; the Middleware decides which lots passed and
have no damage; it calls this, and NetSuite moves exactly those lots to a **good bin**.

**A Bin Transfer, not an Inventory Status Change.** The 8 September meeting settled that inventory
state is represented by physical bins — bin management is already a prerequisite of this
integration and Inventory Status is a separate feature not every account has (Design §9.2.1).
There is no `InventoryStatusChange` anywhere in this SuiteApp and there is not going to be one.

### The lot arrives by NAME

The Middleware knows lots as TrackTrace prints them — `LOT-2026-0815`. NetSuite stores them as
internal ids. One `inventorynumber` search per submission bridges the two:

```
filters: item anyof <the items on this release>  AND  quantityonhand greaterthan 0
```

Filtering on **on-hand** is not an optimisation. A lot with no stock cannot be what is being
released, and leaving it out keeps the result to what the warehouse actually holds.

The index is keyed **per item**, deliberately. Two items may legitimately carry the same lot name,
and releasing item A's stock because item B has a lot of that name is precisely the class of
mistake this integration exists to prevent. Names are matched trimmed and uppercased, because a
scanner and a label printer disagree about case more often than they agree.

**A name that resolves to nothing is `LOT_NOT_FOUND` and the release refuses.** It never creates
the lot. A release moves stock that already exists; a lot invented here would be an empty record
nobody asked for, sitting in a regulated account's inventory forever.

### And it must still be in the on-hold bin

One `inventorybalance` search — item, location, from-bin, lot — answers both of the rules Design
§9.4 asks for:

| | |
|---|---|
| nothing there | `LOT_NOT_IN_BIN`. Either it was already released or somebody moved it by hand |
| not enough there | `QTY_EXCEEDS_IN_BIN`, naming both numbers |

**Refused, never redirected.** Guessing where the stock went is how a regulated product gets
released from a bin nobody verified.

`inventorybalance` is the only search that is bin-aware AND lot-aware at once, which is exactly
the question a release asks. The item's own quantity fields answer a different one.

### One transfer, grouped by item

The `inventory` sublist carries one line per item; the lots hang off that line's inventory detail.
Two lots of one item are **two inventory assignments on one sublist line**, not two lines. `t13`
asserts it.

The bins are written in both places — on the assignment (`binnumber` / `tobinnumber`, the
lot-tracked shape) and on the sublist line (the bin-only shape). The setters are no-ops when a
field is not on the form, so whichever the account exposes is the one that takes. **This is the one
thing in the handler that wants confirming on the first live run**, and it is called out in the
code rather than left to be discovered.

### A partial release leaves the row OPEN

| | |
|---|---|
| everything moved | `Closed - Success` |
| some stayed behind | **`Open - Needs Review`**, with the quantities in `suggested` |

A partial release is **normal** — some serials pass and some do not. It is also the state that
goes unnoticed: no call failed, nothing errored, and the remainder sits in the on-hold bin until a
picker finds the good bin short. An open row is the only thing that surfaces it before the
warehouse does (Design §9.12).

`held_quantity` is measured, not guessed: the balance read above, minus what has now moved.

### Rules 1 and 2 hold unchanged

**All or nothing.** One bad line rejects the whole release and nothing moves. The stock staying in
the on-hold bin is the safe outcome, and the refusal says so.

**A retry is a SUCCESS.** `request_uuid` becomes the Bin Transfer's native `externalid`; a repeat
is answered with the transfer that already exists and **no second transfer is created**
(Design §9.8).

### Objects

Four new transaction body fields, Item Receipt only, under `custtab_jj_rb_transaction`:

| Field | Type | |
|---|---|---|
| `custbody_jj_rb_released_qty` | Decimal | What moved to a good bin |
| `custbody_jj_rb_held_qty` | Decimal | What is still held. > 0 means a partial release |
| `custbody_jj_rb_released_at` | Date/Time | Blank means no release ever arrived — what the held-stock threshold measures against |
| `custbody_jj_rb_bin_transfer` | Text | The transfer's internal id. TEXT, not a List/Record link: a transaction link has to name a record type, and the useful answer is one id a user can paste |

These three are what the *received but not released* worklist is built on. A receipt whose stock is
never released fails **silently** — no call errored; the stock simply sits there.

`Inventory Release` was already a value in `customlist_jj_rb_sync_type` and `Release` in
`customlist_jj_rb_operation`, seeded in the first build. This pass is the code behind them.

New constants: `C.INBOUND.INV_RELEASE`, `C.SYNCTYPE.INV_RELEASE`, `C.OPERATION.RELEASE`, four
`C.LINE_ERR` codes, `C.DOC_ERR.NOTHING_TO_RELEASE`, four `C.TXN` field ids.

### Governance

Two searches for the whole submission — the lots, then the balance — plus the item read the
receipt path already had. Not two per line.

### Still to tell the client

> **A bin does not make stock unavailable.** NetSuite will commit stock sitting in the on-hold
> bin: the quantity is on hand at that location, so the availability calculation includes it. The
> on-hold bin buys **process** control — a picker directed to good bins does not take from it —
> not **system** control. Design §9.4.1, carried as **T-32**, and it should be answered before
> Phase 1 go-live rather than after.

651 assertions across 13 suites. `t13` (87) covers the happy path, the receipt stamp, the Sync Log
row and its open/closed split, two lots on one line, name matching with case and padding, every
refusal, both bin fallbacks, all-or-nothing, the duplicate retry, a release with no receipt named,
and a save NetSuite refuses.

---

## Pass 24 — the release ledger: externalId answers the wrong question

`jj_rb_core.js` · `jj_rl_rb_write.js` · `custbody_jj_rb_release_log` · `t13.js`.

Pass 23 shipped `inventory_release` with two guards, and **neither of them guards what matters**.

### The defect

```
call 1 : request_uuid = A, lot LOT-2026-0815, 24     → moved
call 2 : request_uuid = B, lot LOT-2026-0815, 24     → moved AGAIN
```

| Guard | What it answers | Why it misses this |
|---|---|---|
| `request_uuid` in the native `externalId` | "is this the **same call** again?" | A Middleware retry after a timeout often carries a **fresh** uuid. Different uuid, different external id, no collision |
| the on-hold bin's `inventorybalance` | "is the stock still there?" | **Shared** — several receipts put stock in one hold bin, so a balance of 24 says nothing about *whose* 24 it is, and the second call happily moves another receipt's goods. **Lagging** — it is a search index, so a release called seconds after its receipt reads a number that is not true yet |

Those are two different questions, and neither is *"has this stock already been released?"*

### The ledger

`custbody_jj_rb_release_log` — Long Text on the Item Receipt, locked, under
`custtab_jj_rb_transaction`.

```json
{ "v": 1, "receipt": "2481003", "seq": 3, "updated": "2026-10-05T10:11:12.000Z",
  "lots": { "718|901": { "item":"718", "lot":"LOT-2026-0815", "lotId":"901",
                         "received":24, "released":20 } },
  "calls": [ { "uuid":"A", "bt":"2492118", "at":"...", "moved":[{"k":"718|901","q":20}] } ],
  "callCount": 3 }
```

It has neither problem. **Per receipt**, so another receipt's stock in the same bin is invisible
to it. **A stored field**, so it reads back immediately and exactly — no index between the write
and the next read. And it holds `received` beside `released`, which is the only pair of numbers
that can answer the question.

Every line is now measured as `received − released − claimed-earlier-in-this-submission`.

### Entitlement is read once per receipt, not once per call

On the **first** release, `seedLedger` reads what the receipt actually received per lot and stores
it. Every later release reads it back out of the JSON.

| | |
|---|---|
| 1 | A transaction search with the `inventoryDetail` join — one search, the cheap answer |
| 2 | `record.load` of the receipt and its inventory-detail subrecords — always works, used when the join is not available in that account |

An item with no inventory detail still gets a row keyed on the item alone, so a bin-only release
has an entitlement too.

### Four new refusals

| | |
|---|---|
| `LOT_NOT_ON_RECEIPT` | The lot may be perfectly real and sitting in that very bin — **put there by a different receipt**. Releasing it against this one would move somebody else's goods |
| `ALREADY_RELEASED` | Everything this receipt received of that lot has gone. *"If stock genuinely needs moving again, it is a bin transfer somebody makes in NetSuite, not a release"* |
| `QTY_EXCEEDS_RECEIVED` | Names received, already-released and what is left |
| `RECEIPT_NOT_IDENTIFIED` · `RECEIPT_NOT_READABLE` | Document level — see below |

### The Item Receipt reference is now MANDATORY

v1.1 let a release through without one and created the transfer anyway. The receipt **carries the
ledger**, so without it there is no duplicate guard worth the name — and Design §9.3 listed the
receipt reference as mandatory all along. v1.1 was the deviation, not this.

### The balance check is demoted, and made lag-aware

It stays as a **second** question — the ledger says what *may* move, the balance says whether it
is *still there*. But:

| the balance returns | meaning | effect |
|---|---|---|
| rows, lot missing or short | somebody moved it by hand | **refuse** — `LOT_NOT_IN_BIN` / `QTY_EXCEEDS_IN_BIN` |
| **no rows at all** | the index has not caught up | **proceed**, with an audit line |

An empty `inventorybalance` is far more often a stale index than a vanished pallet, and refusing
a legitimate release seconds after its receipt is the worse failure. `heldAfter()` and
`movedFor()` are gone with it.

### Writing it back: re-read, merge, write

The copy read before the save is **stale** by the time the transfer is saved. Writing it back
would silently undo a concurrent call's figures — a lost update, and the worst possible one,
because the number it loses is the guard.

So `commitLedger` merges onto a **fresh** read. The remaining window is between that read and the
`submitFields` — milliseconds. NetSuite offers no row lock that would close it entirely, and
pretending otherwise would be worse than saying so, so the code says so.

Two honest failure paths, both of which could previously have been silent:

| | |
|---|---|
| the fresh read shows we are now **over** | The transfer is saved and cannot be un-saved by wishing. The ledger is written anyway — it must stay a true record of what moved — and the Sync Log row becomes a **FAILURE** with an open work item naming the lots. Somebody reverses it by hand |
| the ledger **will not write** | The stock moved and the receipt does not know. `log.error` plus a FAILURE row saying a later release could move the same lot again |

A corrupt or unparseable ledger **refuses the release**. Replacing it with an empty one would hand
a duplicate call a clean slate, which is the one outcome the field exists to prevent.

### The response says both numbers

`released_quantity` used to mean "what this call moved", which is exactly what made a second
release look reasonable. Now:

| | |
|---|---|
| `moved_quantity` | this call |
| `released_quantity` · `received_quantity` · `held_quantity` | the receipt, cumulatively |
| `fully_released` | `held_quantity === 0` |
| `lines_released[].released_to_date` · `.received` | per lot |

`held_quantity` is the whole receipt's unreleased balance, not "what is left of the lots this call
happened to name" — the earlier reading hid a receipt with a second lot nobody had released. The
Sync Log row closes only when the **receipt** is done.

### Trade-off, stated

A Long Text field is not a child record table. It cannot be searched or reported on, and it is one
field two concurrent calls contend for. What it buys is one read and one write per release instead
of a search plus N record creates, and a guard that is correct the instant it is written. `calls`
keeps the most recent 50 — the per-lot totals are never trimmed, because they are the guard, and
the full history already lives in the Sync Log.

712 assertions across 13 suites. `t13` grew from 87 to 148: the retry-with-a-fresh-uuid that
started this, partial-then-the-rest, over-asking capped at what is left, two lines of one
submission racing each other, a lot from another receipt in the same bin, the same uuid answered
from the ledger, a corrupt ledger, an unreadable receipt, the `record.load` fallback, a
non-tracked item, and the ledger write failing out loud.

---

## Pass 25 — eligibility decides, bins are mandatory, and a shortfall is a number

`jj_rb_core.js` · `jj_rb_txn.js` · `jj_rl_rb_write.js` · 3 objects · `t8.js` · `t13.js`.

Four corrections, and three of them are the same correction: **the integration has to know which
lines it is responsible for.**

### `readItems` learns eligibility

The inbound write path never read the eligibility field. It knew lot, serial, bins and active, and
nothing about whether TrackTraceRX tracks the item — so every rule below was impossible to state.

It is read through the **configured** field, the same way `jj_rb_txn.classifyLines` and the read
RESTlet read it; `eligibleValue` is now exported from `jj_rb_txn.js` so there is **one** reading of
that field, not three. A field that is not deployed on every item type falls back to a search
without it and says so — `eligible` is then `undefined`, which the gates treat as not eligible.

### 1. No release for a non-eligible item

A non-eligible item never goes to a hold bin, never waits for verification and has nothing to
release. Two consequences, and the second is the one that mattered:

| | |
|---|---|
| A release line naming one | `NOT_ELIGIBLE`. *"it was never held … the stock is already where the receipt put it"* |
| The **ledger** | Non-eligible entitlements are **dropped at seed time** |

Keeping them would have been worse than useless: `held_quantity` counts `received − released`
across the whole receipt, so untrackable stock nobody is ever going to release would have kept
every receipt permanently part-released, and every release on it permanently on the worklist. The
seed records how many it dropped, so a reader is not left wondering where the lines went.

### 2. A bin is mandatory on an eligible line

Not a preference. The hold-then-release flow is built on knowing which bin the stock is in: a
receipt that lands it wherever NetSuite defaults leaves `inventory_release` with no bin to move it
out of, and the goods sit unreleasable with nothing saying why.

| | |
|---|---|
| **Receipt** | Payload `bin` → the location's On-Hold Bin → the config Default Bin. None of the three ⇒ `BIN_REQUIRED` |
| **Fulfilment** | Payload `bin` only. There is no default — stock is being **issued**, and only the device knows which bin it was picked from |
| **Non-eligible line** | Left to NetSuite, with an audit line. Not tracked, never held, never released |

It refuses the submission, which under rule 1 means nothing is created — and the refusal already
writes an `Open - Needs Review` row. That is the "exception and review sync section": the work item
exists, the document does not, and the retry is clean.

The old gate was `usesHoldBin && useBins && info.useBins` — receipt-only, and keyed on the item's
bin flag rather than on whether this integration cares about the line.

### 3. The bin transfers are a LIST

`custbody_jj_rb_bin_transfer` was TEXT holding the last transfer's id. A receipt verified in
batches has several, and the earlier ones were findable nowhere.

Now **MULTISELECT** of transactions, carrying every transfer that has released against the
receipt. The list is kept in the ledger as `bts` — separate from `calls`, because `calls` is
capped at 50 and losing an id would unlink a transfer that really happened. `bin_transfers` is on
the release response too.

The warehouse question is *"show me the transfers that released this receipt"*, not *"the last
one"*.

### 4. The shortfall is a number

`exception_reason` says why a line came up short and `exception_note` says it in prose. Neither
can be totalled, filtered, or compared against what TrackTraceRX expected — and comparison is the
whole point of recording an exception.

| | |
|---|---|
| `custcol_jj_rb_exception_qty` | Per line: outstanding − submitted |
| `custbody_jj_rb_exception_qty` | The document's total |

**Written on every line, zero included.** A blank then means the line predates the field, not that
nothing was short — which is the difference between a reconciliation that can be trusted and one
that cannot.

The payload may state `exception_quantity`; the **derived** figure wins, because the order is the
authority on what was outstanding, and a disagreement is audited rather than silently accepted.

**A short ELIGIBLE line must carry a reason** — `EXCEPTION_REASON_REQUIRED`, naming
`fulfilment_exceptions` as the source of valid values. A shortfall on a regulated product is a
discrepancy somebody has to account for, and an unexplained one cannot be reconciled afterwards.
On a non-eligible line the number alone is enough.

The response gained `exception_quantity` and `exception_lines[]`; the Sync Log row stays **closed**
— nothing failed — but its `suggested` names the shortfall line by line, so the reconciliation page
finds it without reopening the record.

### Objects

| | |
|---|---|
| `custcol_jj_rb_exception_qty` | **New.** Decimal, Item Receipt + Item Fulfilment, locked |
| `custbody_jj_rb_exception_qty` | **New.** Decimal, both documents, locked |
| `custbody_jj_rb_bin_transfer` | **Changed.** TEXT → MULTISELECT of transactions, relabelled *Release Bin Transfers* |

New codes: `C.LINE_ERR.BIN_REQUIRED`, `NOT_ELIGIBLE`, `EXCEPTION_REASON_REQUIRED`;
`C.LINE.exceptionQty`; `C.TXN.exceptionQty`.

### Noted, not touched

`custcol_jj_rb_hold_qty`, `custcol_jj_rb_release_bin`, `custcol_jj_rb_released_on` and
`custcol_jj_rb_released_qty` are still in the SDF from the v3.0 inventory-status design. **No code
reads or writes any of them** — the release is tracked on the body, per lot, in the ledger. They
should be deleted or wired up; leaving four line columns that are always blank on a form teaches a
user to distrust the ones that are not.

742 assertions across 13 suites. `t8` grew to 81 with the mandatory-bin gate on both directions and
the exception quantity end to end; `t13` to 157 with the non-eligible release refusal, the
non-eligible stock that must NOT count as held, and two releases linking two transfers.

### Also delivered

`if_payload_so610.md` — the Item Fulfilment test payloads for SO610 (16853): full, tracked-lines-
only and short-pick, with the eight negative tests and the five values to substitute. Line 2
(item 721) is the non-eligible case and line 1 is in Pallets at a rate of 16, so `quantity: 1`
means one pallet and the inventory detail must add up to **1**, not 16.

---

## Pass 26 — Bin → storage_area: the master record whose parent is in the URL

`jj_rb_core.js` · `jj_rb_sync.js` · `customscript_jj_ue_rb_master.xml` · `t14.js` · `syharness.js`.

The last unbuilt **master data** type. Design v1.1 §10, Guide v3.3 §10.7. It was declared in
`C.MASTER` from the first build with `implemented: false`, and `run()` refused it by name.

### What makes a bin different from every other master record

```
POST /locations/{locationUuid}/storage_areas
PUT  /locations/{locationUuid}/storage_areas/{uuid}
```

**The location is not a parent to name — it is the ADDRESS of the call.** Every other
hierarchical type (`location.parent`, a sub-customer) writes its parent into the *body* through
`entry.parentField`, and a parent that has not synced yet produces a weaker payload. Here a
missing location produces `/locations//storage_areas`, which fails in a way nobody can diagnose
from a log.

So the bin gets its own pre-sync, before the payload is built:

| | |
|---|---|
| Location has a UUID | Proceed |
| Location has none | `ensureParentLocation` syncs it first |
| Still none | **No call.** `Blocked - missing parent UUID`, work item `Open - Pending Retry`, which resolves when the location syncs |
| Bin names no location at all | Same, and the message says so |

The extra segment travels on `unit.pathParams` and is merged into the call — create, update **and**
delete — rather than being special-cased at each of the three call sites. `buildUrl` already throws
on a blank segment; this check is what stops it ever getting that far.

### `properties` — the field the design says is most often got wrong

**A semicolon-separated STRING.** Not an array, not a list, and an **empty string** — never null —
when the bin has no special conditions.

`custrecord_jj_rb_bin_props` is a multi-select over `customlist_jj_rb_bin_property`, which an
administrator can add values to. TrackTraceRX accepts exactly three, so `C.BIN_PROPS` holds them
and the gate runs **before** the call:

```
Storage Properties on this bin carries CHILLED, which TrackTraceRX does not accept.
The only values it knows are COLD, FROZEN, RESTRICTED_ACCESS. Correct the value on
the bin, or remove it from the Bin Property list.
```

Otherwise it comes back as `STORAGE_AREA_INVALID_PROPERTY` — a business error on a work item,
after the call has been spent, naming nothing a user can act on.

The check lives in **`preflight`, not the builder**. A builder that throws escapes `run()` into the
User Event, and a save that errors out is a far worse answer than a work item.

Values are emitted in `C.BIN_PROPS` order, not the order the multi-select happens to hold them in —
otherwise re-ordering a selection looks like an edit and fires a pointless update.

### The feature gate, which did not exist

`C.MASTER.bin` carried `featureFlag: CFG.useBins` from the first build and **nothing read it**.
`preflight` now gates on `entry.featureFlagKey`:

> Design §10.4 — *"Nothing runs. No call, no work item, no backlog."*

Stamped `Skipped - feature disabled`. An account that does not use bins must not accumulate a
silent pile of failed bin work items, and turning the switch on later produces a backlog of
*Never synced* that the sweep picks up — which is the wanted behaviour, not a bug to design around.

### `is_storage_conditions_verification_disabled`

`true` unless the account handles pharmaceutical storage conditions. There is **no dedicated
setting**, so it reads **Use Dosage Forms** — the one pharma switch this SuiteApp has. Inventing a
second pharma flag a client could set inconsistently with the first would be worse.

Get it backwards and it is quiet either way: `false` on a client who never asked for cold-chain
checks has TrackTrace refusing their receipts; `true` on a pharmaceutical client silently removes
the check they are relying on. Worth a dedicated config field eventually — noted below.

### Delete

A deleted bin is still addressed through its location, and the location field goes with the record.
`runDelete` reads it off `oldRecord` while it is still there and resolves the UUID with
**`storedLocationUuid` — a read, with no cascade.** Syncing a location because a bin under it was
removed would create a remote object as a side effect of a deletion. No location UUID ⇒ no call and
a NOTICE row saying the storage area, if any, is now an orphan.

### Objects

`customdeploy_jj_ue_rb_bin` added to `customscript_jj_ue_rb_master` — `recordtype BIN`, same
execution contexts as the location deployment. The UE itself needed no change: it resolves
`C.MASTER[recordType]` and knows nothing about any particular type.

All eight `custrecord_jj_rb_bin_*` fields and `customlist_jj_rb_bin_property` were already in the
SDF from the first build.

### A new harness

`syharness.js` — the first one that loads **`jj_rb_sync.js` itself**. Every other harness stubs the
sync engine out, which is why a whole master-data type could sit unbuilt with a green suite.

795 assertions across 14 suites. `t14` (52) covers the dispatch entry, a create with the location in
the path and **not** in the body, the semicolon string in all four shapes, the unknown-property
gate, both sides of the pharma flag, Use Bins off, the location cascade and its blocked case, update
versus no-change, inactivation, and that `custom_uuid` travels in the body but stays out of the
comparison string.

---

## Pass 27 — two platform facts about the Bin record

`jj_rb_core.js` · `jj_rb_sync.js` · `jj_rb_io.js` · `jj_rb_txn.js` · `jj_rl_rb_read.js` ·
`jj_mu_rb_resync.js` · `t9.js` · `t14.js` · `syharness.js`.

Pass 26 shipped the bin sync against the design documents. The first live run found two things no
document says.

### 1. `record.submitFields` does not work on a bin

It fails with an unexpected error when it carries custom fields. Not a permission problem, not a
field-id typo — the record type does not support the partial-submit path for them. **A bin has to
be loaded and saved.**

There are **nineteen** `submitFields` calls across the engine, the log writer, the transaction
module and the Mass Update, and every one of them can be handed a bin. Nineteen places to remember
a platform quirk is nineteen places to forget it, so there is now one:

```js
util.writeFields(type, id, values)   // submitFields, except for C.LOAD_AND_SAVE
```

All nineteen call sites moved to it. `LOAD_AND_SAVE` holds `bin` and nothing else; a type is added
to that list when the platform proves it needs to be, not when somebody guesses.

| | |
|---|---|
| Cost | 10 units instead of 2 |
| Tolerance | A field that is not on the record is skipped and audited, the same way `submitFields` skips it. One undeployed field must not lose the write of the six beside it |
| Throws | Exactly as `submitFields` does, so every existing `try/catch` around a write still catches the same thing |

**The re-entry it buys.** A load-and-save fires the bin's own User Event, which is this SuiteApp's,
and which calls straight back in. `SYNC_CONTROL_FIELDS` already carries all seven
`custrecord_jj_rb_bin_*` fields, so `onlySyncFieldsChanged` sees a save that touched nothing but
sync control and the User Event returns before doing anything. **Remove a bin field from that list
and this recurses** — said so in the code, where somebody editing the list will read it.

### 2. A bin spells it `inactive`, not `isinactive`

In a search and in a lookup. Every other master type uses `isinactive`.

**And the wrong spelling does not error.** It returns `undefined`, which reads as *active* — so an
inactivated bin would have gone on being reported as live, and `is_active` would never have flipped
in the payload. The quiet kind of wrong.

| Fixed | |
|---|---|
| `C.MASTER.bin.extraColumns` | `isinactive` → `inactive` |
| `C.MASTER.bin.inactiveField` | New. `resolveUnits` copies the value onto `data.isinactive`, so `preflight`, `operationFor` and the builders go on reading **one** field name for every type |
| `bins_for_location` | Filter and column both. `available` is read off `inactive` |
| `allowed_bins_for_item` | `binNumber.isinactive` → `binNumber.inactive`. Same failure mode: it matched nothing, so an item with perfectly good allowed bins came back with none and the device was told it could not scan |

`customlist_jj_rb_fulfil_exception` and the UOM Detail searches keep `isinactive` — they are custom
records, and they spell it the normal way.

### The harness refuses it too

`syharness.js`'s `record.submitFields` stub throws `Unexpected Error` for a bin, exactly as the
platform does. A regression now fails the suite instead of the account.

813 assertions across 14 suites. `t14` (68) gained the load-and-save path, that a location still
goes through `submitFields`, that an undeployed field does not lose its neighbours, and both sides
of the `inactive` reading. `t9` (203) asserts the bin spelling on both read searches and that
`available` is actually read, not defaulted.
