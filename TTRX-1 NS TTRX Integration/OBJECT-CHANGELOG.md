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
