# RapidBridge SuiteApp — what is left

As of 6 October 2026. 795 assertions, 14 suites, green.

---

## 1. Built and working

| | |
|---|---|
| **Master data** | Dosage Form · Location (+ addresses, + default storage area) · Customer · Vendor · Item + UOM Detail → products · **Bin → storage_area (today)** |
| **Transactions out** | Purchase Order · Sales Order · close / cancel / void |
| **Inbound writes** | `item_receipt` · `item_fulfillment` · `identifier` · `inventory_release` |
| **Inbound reads** | `list_transactions` · `fetch_transaction` · `allowed_bins_for_item` · `fulfilment_exceptions` · `bins_for_location` · `bin_contents` · `item_availability` |
| **Infrastructure** | Sync Log + work items · change detection · dependency pre-sync · unit resolution · release ledger · Mass Update resync · client script form validation |

**Every Phase 1 flow in the design documents now has code behind it.** What follows is what makes
it survivable in production, not what makes it work on a good day.

---

## 2. Blocking — nothing is production-ready without these

### 2.1 The HTTP call is still stubbed

`jj_rb_io.js` — `testApiResponse = 'success'`. **Nothing has ever been sent to a real Middleware.**
Every payload shape in this build is derived from the design documents and never from a response.

This is the single biggest item on the list, and everything below it is secondary.

### 2.2 There is no retry, anywhere

`jj_rb_mr_jobs.js` does not exist. That means no:

| Job | What its absence costs |
|---|---|
| **RETRY** | A transient failure — a timeout, a 503 — is permanent. The work item opens `Open - Pending Retry` and nothing ever retries it |
| **SWEEP** | The reconciliation backlog (*Never synced*, *Last sync failed*, the bin backlog after Use Bins is switched on) is only cleared by somebody running a Mass Update by hand |
| **INBOUND POLL** | §11.5's fallback when the Middleware cannot push |

The Retry button on the Sync Log (§7.6) is unbuilt for the same reason.

### 2.3 Deployment gaps

- `jj_mu_rb_resync.js` exists as a file with **no `massupdatescript` SDF object**, so it cannot be
  deployed by SDF.
- `manifest.xml` is missing `TOKENBASEDAUTHENTICATION` and `CUSTOMRECORDRESTRICTIONS`.
- All RESTlet and UE deployments ship `isdeployed = F` / `isonline = F` — correct for a bundle, but
  somebody has to turn them on and the install notes do not say so.

---

## 3. Correctness — known-wrong or unproven

### 3.1 Unconfirmed against a live account

| | |
|---|---|
| **Bin Transfer bin fields** | The handler writes `binnumber`/`tobinnumber` on both the inventory **assignment** and the sublist **line**, because the shape differs between a lot-tracked and a bin-only account. Only one of them takes. **Confirm on the first live release.** |
| **`inventoryDetail` search join** | The release ledger's seed prefers it and falls back to `record.load`. The join is not available in every account; the fallback is untested against a real receipt |
| **`properties` casing** | `COLD;FROZEN;RESTRICTED_ACCESS` is from the design document, not from a Middleware response |

### 3.2 Items with Multiple Units of Measure switched off

No Units Type ⇒ every line reports `UNIT_UNKNOWN`. A fallback straight to a single UOM Detail row
would serve those accounts. **Not built** — it needs a decision on whether a one-row UOM Detail
table may be assumed to describe the line's unit.

### 3.3 Four line columns nothing reads

`custcol_jj_rb_hold_qty` · `custcol_jj_rb_release_bin` · `custcol_jj_rb_released_on` ·
`custcol_jj_rb_released_qty` — left over from the v3.0 inventory-status design. **No code reads or
writes any of them.** Delete them or wire them up; four permanently blank columns on a form teach a
user to distrust the ones that are not.

### 3.4 Smaller

- `custrecord_jj_rb_cf_redact_pii` is inert — declared, never read.
- `custrecord_jj_rb_cf_pack_size_map` is not deployed.
- **Dosage Form carries `featureFlag: CFG.useDosage` and still nothing reads it.** Pass 26 added the
  gate mechanism (`featureFlagKey`) but wired it only to Bin — turning it on for Dosage is a
  behaviour change on a shipped type and wants a decision first.
- **`is_storage_conditions_verification_disabled` is no longer sent on a Bin (Pass 37).** It was
  derived from Use Dosage Forms as a pharma signal — an inference, not a setting, and wrong in
  either direction without saying so. **Ask TrackTraceRX what their default is for a bin that omits
  the key.** If it is "verification on", the key may never need to come back; if it is "off", the
  SuiteApp needs a dedicated checkbox on the Configuration rather than reading Use Dosage Forms.

---

## 4. Unbuilt features

| | |
|---|---|
| **EDI 850 flag** | §9.3 |
| **Phase 2 transaction types** | Transfer Order · RMA · Vendor RMA — declared in `C.TXNMAP`, no builders |
| **Storage shelves** | TrackTrace's second level below a storage area. NetSuite's Bin maps to the first. Whether any client needs it is open (Design §12) |
| **`PUT …/storage_areas/{uuid}/default`** | Nominating a client's own bin as the location's default. Defined in the API, deliberately not called |
| **Bin moved to another location** | The storage area's *address* changes, not its body. Delete-and-recreate, or a relocation operation if TrackTrace has one. **Confirm with TrackTrace before implementing** — today it is sent as an ordinary update, under the new location's path |

---

## 5. Open with TrackTraceRX / the client

| Ref | Question |
|---|---|
| **T-32** | **A bin does not make stock unavailable.** NetSuite will commit stock sitting in the on-hold bin. Process control, not system control. Four options in Design §9.4.1; none selected. **Answer before Phase 1 go-live** |
| **T-21** | Ids versus names on the read endpoints |
| — | Line quantity and unit convention on the wire |
| — | `order_nbr` / `po_nbr` semantics |
| — | Empty `ship_from_address_uuid` / `sold_by_address_uuid` |
| — | Which field on the transaction read reports shipments — the void guard needs it |
| — | `notes` handling |

---

## 6. Suggested order

1. **Un-stub the HTTP client** and run one of each flow against a real Middleware. Everything else
   is guesswork until this happens.
2. **Build `jj_rb_mr_jobs.js`** — RETRY first. A work item that never retries is a work item
   somebody has to clear by hand, for ever.
3. **Answer T-32.** It is a go-live decision, not a development one, and the answer may add scope.
4. Close the deployment gaps — the Mass Update object and the manifest features.
5. Confirm the Bin Transfer field shape and the `inventoryDetail` join on the first live run.
6. Tidy: the four dead line columns, the inert config fields, the Dosage feature gate.
