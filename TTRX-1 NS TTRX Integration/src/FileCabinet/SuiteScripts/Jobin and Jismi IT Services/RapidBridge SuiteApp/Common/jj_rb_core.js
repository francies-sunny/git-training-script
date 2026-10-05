/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * jj_rb_core — ids + pure functions + configuration + list resolution.
 *
 * RULE: no record id, field id, list value or endpoint path appears anywhere
 * else in the codebase. If you are about to type a string that starts with
 * 'custrecord', 'custitem', 'custentity' or 'customrecord', it belongs here.
 *
 * Four namespaces, one file, ZERO dependencies on any other RapidBridge file.
 * Nothing here writes a record or makes an HTTP call, which is what makes this
 * file safe to load from the User Event, the Client Script, the Mass Update and
 * the RESTlet alike.
 *
 * Master Data Developer Guide v3.4 §6, §7.5.
 */
define(['N/search', 'N/record'],
  (search, record) => {

    // ═══════════════════════════════════════════════════════════════════════════
    // namespace 1: C — every id in the SuiteApp
    // ═══════════════════════════════════════════════════════════════════════════

    const REC = Object.freeze({
      CONFIG: 'customrecord_jj_rb_config',
      LOG: 'customrecord_jj_rb_sync_log',   // main AND child — one record type
      UOM: 'customrecord_jj_rb_uom_detail',
      DOSAGE: 'customrecord_jj_rb_dosage_form',
      // Not a record type — a CUSTOM LIST, and it is here because the read
      // RESTlet serves it to the mobile app (§7.8.1, 7 Sep Q1). A custom list
      // is searchable by its script id exactly like a record type, which is
      // what `lists.id()` has always relied on.
      FULFIL_EXCEPTION: 'customlist_jj_rb_fulfil_exception'
    });

    const CFG = Object.freeze({
      active: 'custrecord_jj_rb_cf_active', subsidiary: 'custrecord_jj_rb_cf_subsidiary',
      clientCode: 'custrecord_jj_rb_cf_client_code', domain: 'custrecord_jj_rb_cf_domain',
      version: 'custrecord_jj_rb_cf_version', secret: 'custrecord_jj_rb_cf_secret',
      authHeader: 'custrecord_jj_rb_cf_auth_header',
      contentType: 'custrecord_jj_rb_cf_content_type',
      timeout: 'custrecord_jj_rb_cf_timeout', language: 'custrecord_jj_rb_cf_language',
      productClass: 'custrecord_jj_rb_cf_product_class',
      packSizeMap: 'custrecord_jj_rb_cf_pack_size_map',
      eligField: 'custrecord_jj_rb_cf_elig_field',
      maxInline: 'custrecord_jj_rb_cf_max_inline',
      useDosage: 'custrecord_jj_rb_cf_use_dosage',
      useBins: 'custrecord_jj_rb_cf_use_bins',
      useAddress: 'custrecord_jj_rb_cf_use_address',
      syncInactive: 'custrecord_jj_rb_cf_sync_inactive',
      inactiveMethod: 'custrecord_jj_rb_cf_inactive_method',
      staleMinutes: 'custrecord_jj_rb_cf_stale_minutes',
      maxRetries: 'custrecord_jj_rb_cf_max_retries',
      retryBase: 'custrecord_jj_rb_cf_retry_base',
      retryCeiling: 'custrecord_jj_rb_cf_retry_ceiling',
      retryMaxAge: 'custrecord_jj_rb_cf_retry_max_age',
      capture: 'custrecord_jj_rb_cf_capture',
      payloadCap: 'custrecord_jj_rb_cf_payload_cap',
      killswitch: 'custrecord_jj_rb_cf_killswitch',
      dryRun: 'custrecord_jj_rb_cf_dryrun',
      // the environment gate — §20.2
      envLabel: 'custrecord_jj_rb_cf_env_label',
      allowNonprod: 'custrecord_jj_rb_cf_allow_nonprod',

      // ── TRANSACTIONS. Transaction Developer Guide v3.1 §4.3.1.
      //
      //    The guide puts these on a child record, `customrecord_jj_rb_flow_
      //    config`, one row per flow. They live HERE instead: the two Phase 1
      //    outbound flows need three values each, the fields already exist on
      //    the configuration record, and a child record with two rows in it
      //    would be a join on every transaction save for nothing. `config.flow`
      //    below hides the difference, so a later move to the child record is
      //    one function, not a rewrite.
      //
      //    EVERY key here becomes a search COLUMN in config.get(). A field that
      //    is not deployed to the account fails the whole configuration read,
      //    so deploy the configuration record with the code.
      soEnabled: 'custrecord_jj_rb_cf_so_enabled',
      poEnabled: 'custrecord_jj_rb_cf_po_enabled',
      // ── INBOUND. The Middleware calls NetSuite and NetSuite creates the
      //    record — §2.2, §10.2, §11.1. All four fields already existed.
      irEnabled: 'custrecord_jj_rb_cf_ir_enabled',
      ifEnabled: 'custrecord_jj_rb_cf_if_enabled',
      ifStatus: 'custrecord_jj_rb_cf_if_status',
      defaultBin: 'custrecord_jj_rb_cf_default_bin',
      // What a NetSuite close or cancel does to the destination transaction.
      // MARK_CLOSED · DELETE · NONE — §12.3.
      closeAction: 'custrecord_jj_rb_cf_close_action'
      //
      // NO STATUS GATE FIELD, AND NO APPROVAL FIELD. Which statuses make an
      // order syncable is a fact about NETSUITE, not about the client: an
      // order is sendable once it has reached a status in which it can be
      // fulfilled or received. That set is the platform's own, so it lives in
      // TXN_STATUS below rather than being re-entered per account — and there
      // is nothing to type wrongly, nothing to leave blank, and no approval
      // workflow to detect. See §7.3.1 and the note on TXN_STATUS.
    });

    /**
     * Sync Log — ONE record type. Role is decided by whether `parent` is blank.
     * §12.2.
     */
    const LOG = Object.freeze({
      // identification — both roles
      ref: 'custrecord_jj_rb_sl_ref', parent: 'custrecord_jj_rb_sl_parent',
      role: 'custrecord_jj_rb_sl_role', attemptNo: 'custrecord_jj_rb_sl_attempt_no',
      correlation: 'custrecord_jj_rb_sl_correlation',
      requestUuid: 'custrecord_jj_rb_sl_request_uuid',
      // subject
      direction: 'custrecord_jj_rb_sl_direction', type: 'custrecord_jj_rb_sl_type',
      operation: 'custrecord_jj_rb_sl_operation', recType: 'custrecord_jj_rb_sl_rectype',
      nsId: 'custrecord_jj_rb_sl_nsid', item: 'custrecord_jj_rb_sl_item',
      uom: 'custrecord_jj_rb_sl_uom', entity: 'custrecord_jj_rb_sl_entity',
      location: 'custrecord_jj_rb_sl_location', bin: 'custrecord_jj_rb_sl_bin',
      dosage: 'custrecord_jj_rb_sl_dosage', uuid: 'custrecord_jj_rb_sl_uuid',
      config: 'custrecord_jj_rb_sl_config', subsidiary: 'custrecord_jj_rb_sl_subsidiary',
      // work item roll-up — main record only
      status: 'custrecord_jj_rb_sl_status', open: 'custrecord_jj_rb_sl_open',
      success: 'custrecord_jj_rb_sl_success', payload: 'custrecord_jj_rb_sl_payload',
      attempts: 'custrecord_jj_rb_sl_attempts', firstAt: 'custrecord_jj_rb_sl_first_at',
      lastAt: 'custrecord_jj_rb_sl_last_at', notBefore: 'custrecord_jj_rb_sl_not_before',
      exhausted: 'custrecord_jj_rb_sl_exhausted',
      errorClass: 'custrecord_jj_rb_sl_error_class',
      errorCode: 'custrecord_jj_rb_sl_error_code', error: 'custrecord_jj_rb_sl_error',
      suggested: 'custrecord_jj_rb_sl_suggested',
      // call detail — every record
      trigger: 'custrecord_jj_rb_sl_trigger', started: 'custrecord_jj_rb_sl_started',
      completed: 'custrecord_jj_rb_sl_completed', duration: 'custrecord_jj_rb_sl_duration',
      endpoint: 'custrecord_jj_rb_sl_endpoint', method: 'custrecord_jj_rb_sl_method',
      httpStatus: 'custrecord_jj_rb_sl_http_status',
      request: 'custrecord_jj_rb_sl_request', response: 'custrecord_jj_rb_sl_response',
      headers: 'custrecord_jj_rb_sl_headers', outcome: 'custrecord_jj_rb_sl_outcome',
      attemptPayload: 'custrecord_jj_rb_sl_attempt_payload',
      units: 'custrecord_jj_rb_sl_units', context: 'custrecord_jj_rb_sl_context',
      user: 'custrecord_jj_rb_sl_user',
      // reconciliation — main record only
      reason: 'custrecord_jj_rb_sl_reason',
      reconStatus: 'custrecord_jj_rb_sl_recon_status',
      reconMethod: 'custrecord_jj_rb_sl_recon_method',
      resolvedBy: 'custrecord_jj_rb_sl_resolved_by',
      resolvedOn: 'custrecord_jj_rb_sl_resolved_on',
      resolution: 'custrecord_jj_rb_sl_resolution',
      mergedInto: 'custrecord_jj_rb_sl_merged_into',
      mergedCount: 'custrecord_jj_rb_sl_merged_count',
      // ── transactions. Guide v3.1 §5.4.2. Four fields, and no fifth: there
      //    is no per-line result array, because an inbound write creates the
      //    record or creates nothing.
      transaction: 'custrecord_jj_rb_sl_transaction',
      shipmentUuid: 'custrecord_jj_rb_sl_shipment_uuid',
      lineTotal: 'custrecord_jj_rb_sl_line_total',
      lineSent: 'custrecord_jj_rb_sl_line_sent'
    });

    /**
     * The custom lists behind every SELECT field the scripts write.
     * Code never writes display text directly — it writes an internal id looked
     * up through `lists.id()`, which is what keeps a renamed list value from
     * breaking the code.
     */
    const LIST = Object.freeze({
      tryResult: 'customlist_jj_rb_try_result', syncStatus: 'customlist_jj_rb_sync_status',
      direction: 'customlist_jj_rb_direction', syncType: 'customlist_jj_rb_sync_type',
      operation: 'customlist_jj_rb_operation', outcome: 'customlist_jj_rb_attempt_outcome',
      errorClass: 'customlist_jj_rb_error_class', logRole: 'customlist_jj_rb_log_role',
      trigger: 'customlist_jj_rb_attempt_trigger', httpMethod: 'customlist_jj_rb_http_method',
      reconReason: 'customlist_jj_rb_recon_reason',
      reconStatus: 'customlist_jj_rb_recon_status',
      reconMethod: 'customlist_jj_rb_recon_method',
      envLabel: 'customlist_jj_rb_env_label'
    });

    // ── List values. These are the DISPLAY values as seeded in the SDF objects.
    //    `lists.id()` turns each into the internal id at runtime.
    const STATUS = Object.freeze({
      OPEN_PENDING: 'Open - Pending Retry', OPEN_RETRYING: 'Open - Retrying',
      OPEN_FAILED: 'Open - Failed', OPEN_REVIEW: 'Open - Needs Review',
      CLOSED_SUCCESS: 'Closed - Success', CLOSED_RESOLVED: 'Closed - Resolved',
      CLOSED_MERGED: 'Closed - Merged', CLOSED_CANCELLED: 'Closed - Cancelled',
      CLOSED_NO_ACTION: 'Closed - No Action Needed'
    });
    /** Statuses whose `open` checkbox is TRUE. The find-open-main query, §12.5. */
    const OPEN_STATUSES = Object.freeze([STATUS.OPEN_PENDING, STATUS.OPEN_RETRYING,
    STATUS.OPEN_FAILED, STATUS.OPEN_REVIEW]);

    const ROLE = Object.freeze({ PARENT: 'Parent (main sync)', CHILD: 'Child (retry / new sync)' });

    /** The outcome of an EVALUATION of a master record. §11.5. */
    const TRY = Object.freeze({
      SYNCED: 'Synced - API succeeded', NO_CHANGE: 'No change - payload identical',
      SKIP_INELIGIBLE: 'Skipped - not eligible',
      SKIP_FEATURE: 'Skipped - feature disabled',
      BLOCK_NO_UOM: 'Blocked - no UOM Detail',
      BLOCK_NO_PARENT: 'Blocked - missing parent UUID',
      FAIL_API: 'Failed - API error', FAIL_PRE_API: 'Failed - before API call',
      DEFERRED: 'Deferred - inline cap', DRY_RUN: 'Dry run',
      SUPPRESSED_ENV: 'Suppressed - environment gate',
      // ── transactions. Guide v3.1 §3.2. Neither is an error: on a busy day
      //    they are the two most common stamps in the account.
      DEFER_APPROVAL: 'Deferred - awaiting approval',
      SKIP_NO_SERIAL: 'Skipped - no serialized lines',
      // ── inbound. §11.4 — the record exists and the second call of the
      //    two-call protocol has not arrived. A legitimate state, not a fault.
      CREATED_NO_UUID: 'Created - awaiting TrackTrace identifier'
    });

    const OUTCOME = Object.freeze({
      SUCCESS: 'Success', FAILURE: 'Failure', SKIPPED: 'Skipped', DRY_RUN: 'Dry Run'
    });
    const ERRCLASS = Object.freeze({
      RETRYABLE: 'Retryable', AUTH: 'Auth', POISON: 'Poison', BUSINESS: 'Business'
    });
    const TRIGGER = Object.freeze({
      INITIAL: 'Initial', AUTO_RETRY: 'Auto Retry', MANUAL_RETRY: 'Manual Retry',
      NEW_SYNC: 'New Sync', MASS_UPDATE: 'Mass Update', CSV: 'CSV Import',
      RECON: 'Reconciliation Sweep', PRESYNC: 'Dependency Pre-sync',
      // The work item exists because a STATUS moved, not because field data
      // changed — in Phase 1 that means an order reaching its gate. §7.3.1.
      STATUS: 'Status Change',
      // The work item exists because THE MIDDLEWARE CALLED NETSUITE —
      // directions 2 and 3 of Concept 4. §3.2.
      INBOUND_CALL: 'Inbound Call'
    });
    const DIRECTION = Object.freeze({
      OUTBOUND: 'Outbound (NS - MW)', INBOUND: 'Inbound (MW - NS)', INTERNAL: 'Internal',
      // ── READS. A scanning operator browsing orders and bins calls NetSuite
      //    exactly as often as a synchronization does and means nothing like
      //    the same thing. Under this direction a polling device can be cut
      //    out of every worklist with one filter — Master Data Design v1.1
      //    §11.12, Transaction Guide v3.1 §7.8.1.
      INBOUND_QUERY: 'Inbound Query (MW - NS read)'
    });
    const SYNCTYPE = Object.freeze({
      ITEM: 'Item', DOSAGE_FORM: 'Dosage Form', CUSTOMER: 'Customer', VENDOR: 'Vendor',
      ADDRESS: 'Address', LOCATION: 'Location', BIN: 'Bin', RECONCILIATION: 'Reconciliation',
      SALES_ORDER: 'Sales Order', PURCHASE_ORDER: 'Purchase Order',
      ITEM_RECEIPT: 'Item Receipt', ITEM_FULFILMENT: 'Item Fulfilment',
      // ── READS. Both values were seeded in customlist_jj_rb_sync_type from
      //    the first build and had no code behind them until the read RESTlet.
      //    BIN_QUERY is the Master Data guide's name (§7.14); TXN_FETCH is the
      //    Transaction guide's (§7.8.1). Two names because a warehouse looking
      //    for "why is that bin empty" and one looking for "why can the
      //    operator not see that PO" are two different searches.
      BIN_QUERY: 'Bin Query', TXN_FETCH: 'Transaction Fetch',
      // The release of held stock. Already a value in
      // customlist_jj_rb_sync_type from the first build; this is the code
      // behind it.
      INV_RELEASE: 'Inventory Release'
    });
    const OPERATION = Object.freeze({
      CREATE: 'Create', UPDATE: 'Update', DELETE: 'Delete',
      INACTIVATE: 'Inactivate', REACTIVATE: 'Reactivate', QUERY: 'Query',
      // ── transactions, guide §12. `Close` covers a NetSuite close and a
      //    cancel alike — both mean "this order will not go any further".
      //    `Void` is the destructive one, and only a NetSuite DELETE or the
      //    Delete close action reaches it.
      CLOSE: 'Close', VOID: 'Void',
      // §11.6 — held stock moving to a good bin. Its own operation because a
      // release is neither a create of the subject record nor an update of
      // it: the subject is the Item Receipt and what gets created is a
      // separate Bin Transfer. Already a value in customlist_jj_rb_operation.
      RELEASE: 'Release'
    });
    const REASON = Object.freeze({
      NEVER_SYNCED: 'Never synced', PAYLOAD_CHANGED: 'Payload changed since last sync',
      LAST_FAILED: 'Last sync failed', NO_UOM: 'Item has no UOM Detail',
      MISSING_PARENT: 'Missing parent UUID', INACTIVE_NOT_SYNCED: 'Inactive but not synced',
      NOT_ELIGIBLE: 'Not eligible - check classification',
      AWAITING_DECISION: 'Awaiting manual decision',
      DUPLICATE_OPEN: 'Duplicate open work items',
      RETRY_EXHAUSTED: 'Retry exhausted',
      // ── transactions, guide §12.
      CLOSED_REMOTE: 'Order closed but still open remotely',
      RECOVER_UUID: 'Recover lost UUID'
    });

    /**
     * NETSUITE'S OWN TRANSACTION STATUSES. Not a custom list — these are the
     * platform's, and `sync` says which of them mean "this order has reached a
     * state where it can be sent".
     *
     * ── WHY THIS IS NOT CONFIGURATION ───────────────────────────────────────
     * The question the engine has to answer is "has this order reached a
     * status in which it is eligible to sync?" — nothing more. It is NOT "does
     * this account use approval routing?", and it must not be: an account
     * without an approval workflow never produces `Pending Approval` at all,
     * so anything that keyed off an approval status would sync nothing there.
     *
     * An order becomes eligible the moment it can be fulfilled or received,
     * and stays eligible through billing, so an edit after fulfilment is an
     * update rather than something silently deferred. `Closed`, `Cancelled`,
     * `Rejected by Supervisor`, `Undefined` and `Planned` are NOT eligible:
     * they are ends, not stages, and order close is its own chapter.
     *
     * ── WHY EACH ROW CARRIES FOUR SPELLINGS ─────────────────────────────────
     * NetSuite hands the same status back in different shapes depending on how
     * it is read — the numeric id from a Transaction Status reference, the
     * `SalesOrd:B` form from a search's statusref column, the camelCase form
     * from search.lookupFields, and the display text on the record. Each row
     * carries all four, and `statusEntry()` matches on any of them, so no
     * caller has to know which shape it is holding. The display text alone
     * would not do: it is translated, and the codes are not.
     */
    const TXN_STATUS = Object.freeze({
      salesorder: Object.freeze([
        { id: 11, ref: 'SalesOrd:A', key: 'pendingApproval', name: 'Pending Approval', sync: false },
        { id: 12, ref: 'SalesOrd:B', key: 'pendingFulfillment', name: 'Pending Fulfillment', sync: true, scannable: true },
        { id: 13, ref: 'SalesOrd:C', key: 'cancelled', name: 'Cancelled', sync: false, terminal: true },
        { id: 14, ref: 'SalesOrd:D', key: 'partiallyFulfilled', name: 'Partially Fulfilled', sync: true, scannable: true },
        { id: 15, ref: 'SalesOrd:E', key: 'pendingBillingPartFulfilled', name: 'Pending Billing/Partially Fulfilled', sync: true, scannable: true },
        { id: 16, ref: 'SalesOrd:F', key: 'pendingBilling', name: 'Pending Billing', sync: true },
        { id: 17, ref: 'SalesOrd:G', key: 'billed', name: 'Billed', sync: true },
        { id: 18, ref: 'SalesOrd:H', key: 'closed', name: 'Closed', sync: false, terminal: true },
        { id: 19, ref: null, key: 'undefined', name: 'Undefined', sync: false }
      ]),
      purchaseorder: Object.freeze([
        { id: 53, ref: 'PurchOrd:A', key: 'pendingSupervisorApproval', name: 'Pending Supervisor Approval', sync: false },
        { id: 54, ref: 'PurchOrd:B', key: 'pendingReceipt', name: 'Pending Receipt', sync: true, scannable: true },
        { id: 55, ref: 'PurchOrd:C', key: 'rejectedBySupervisor', name: 'Rejected by Supervisor', sync: false, terminal: true },
        { id: 56, ref: 'PurchOrd:D', key: 'partiallyReceived', name: 'Partially Received', sync: true, scannable: true },
        { id: 57, ref: 'PurchOrd:E', key: 'pendingBillingPartReceived', name: 'Pending Billing/Partially Received', sync: true, scannable: true },
        { id: 58, ref: 'PurchOrd:F', key: 'pendingBill', name: 'Pending Bill', sync: true },
        { id: 59, ref: 'PurchOrd:G', key: 'fullyBilled', name: 'Fully Billed', sync: true },
        { id: 60, ref: 'PurchOrd:H', key: 'closed', name: 'Closed', sync: false, terminal: true },
        { id: 61, ref: null, key: 'undefined', name: 'Undefined', sync: false },
        { id: 326, ref: null, key: 'planned', name: 'Planned', sync: false }
      ])
    });

    /**
     * A status compared as data rather than as prose: case, spacing and
     * punctuation fall away, so "Pending Fulfillment", "pendingFulfillment"
     * and "PENDING_FULFILLMENT" are one value.
     *
     * The record-type prefix is NOT stripped here, and that is deliberate:
     * strip it and `SalesOrd:B` and `PurchOrd:B` both collapse to "b", so a
     * purchase status would match a sales row. statusEntry() handles the one
     * prefixed shape that needs it — the Transaction Status display name — by
     * comparing the part after the colon against the NAME only.
     */
    const normStatus = (v) => String(v === null || v === undefined ? '' : v)
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase();

    /**
     * The status row a value names, whatever shape the value arrived in.
     * null when nothing matches — which is deliberately NOT the same as "not
     * eligible", so the caller can say so out loud instead of going quiet.
     */
    const statusEntry = (recordType, value) => {
      const rows = TXN_STATUS[String(recordType || '').toLowerCase()];
      if (!rows) return null;
      const raw = String(value === null || value === undefined ? '' : value).trim();
      if (!raw) return null;
      const n = normStatus(raw);
      if (!n) return null;
      // "Sales Order : Pending Fulfillment" — the Transaction Status record's
      // own name carries the record type. Compared against the NAME alone,
      // never against the ref, or SalesOrd:B and PurchOrd:B would both be "b".
      const after = raw.indexOf(':') === -1
        ? '' : normStatus(raw.substring(raw.lastIndexOf(':') + 1));
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (String(r.id) === raw) return r;
        if (r.ref && normStatus(r.ref) === n) return r;
        if (normStatus(r.key) === n) return r;
        if (normStatus(r.name) === n) return r;
        if (after && after.length > 1 && normStatus(r.name) === after) return r;
      }
      return null;
    };

    /** The names of the statuses an order of this type may be SENT in. */
    const syncStatusNames = (recordType) => {
      const rows = TXN_STATUS[String(recordType || '').toLowerCase()] || [];
      return rows.filter((r) => r.sync).map((r) => r.name);
    };

    /**
     * The statuses an order may be SCANNED in — a strict subset of `sync`.
     *
     * ── WHY THESE ARE TWO DIFFERENT QUESTIONS ──────────────────────────────
     *
     * `sync`      may this order's payload be SENT to TrackTraceRX?
     * `scannable` has this order got anything left to receive or fulfil?
     *
     * A purchase order at **Pending Bill** has been fully received. Every unit
     * is in. It is still `sync: true`, because an edit to it — a changed
     * address, a corrected quantity — must still reach the destination, and
     * closing that door would leave the two systems disagreeing.
     *
     * But it is NOT scannable. Offering it to an operator wastes a trip to the
     * dock: there is nothing to put in a receipt, and the transform would
     * produce an empty document.
     *
     * The same split on a sale. **Pending Billing** means fully fulfilled and
     * awaiting an invoice; **Billed** means finished. Neither has stock left to
     * pick.
     *
     * THE PARTIAL STATUSES STAY IN. `Pending Billing/Partially Received` and
     * `Pending Billing/Partially Fulfilled` both mean *some* of it has been
     * billed and *some* is still outstanding — the billing half is noise to a
     * warehouse, and dropping them would hide genuinely open work.
     *
     *   PO scannable: Pending Receipt · Partially Received ·
     *                 Pending Billing/Partially Received
     *   SO scannable: Pending Fulfillment · Partially Fulfilled ·
     *                 Pending Billing/Partially Fulfilled
     */
    const scannableStatusNames = (recordType) => {
      const rows = TXN_STATUS[String(recordType || '').toLowerCase()] || [];
      return rows.filter((r) => r.scannable).map((r) => r.name);
    };

    /**
     * NETSUITE'S OWN INBOUND SURFACE. §7.8.
     *
     * These are OURS — the Middleware calls them; we never call them. One
     * value per operation, carried in the request body, because a RESTlet is
     * one script and one URL: the operation cannot be a path segment.
     *
     * NO `inventory_adjustment`. Direct inventory adjustment is out of scope
     * (§1.5.3), and reinstating it is not a small decision.
     */
    const INBOUND = Object.freeze({
      // ── WRITES — jj_rl_rb_write.js, §7.8.2.
      IR_CREATE: 'item_receipt',
      IF_CREATE: 'item_fulfillment',
      IDENTIFIER: 'identifier',

      // ── READS — jj_rl_rb_read.js, §7.8.1. A SEPARATE SCRIPT, on purpose.
      //    A read and a write share a body shape and nothing else: a read
      //    creates nothing, is safe to repeat, never opens a work item and is
      //    called orders of magnitude more often. Putting them in one file
      //    would mean one governance budget, one deployment, one audience and
      //    one log posture for two things that want four different ones.
      TXN_LIST: 'list_transactions',
      TXN_FETCH: 'fetch_transaction',
      ALLOWED_BINS: 'allowed_bins_for_item',
      EXC_REASONS: 'fulfilment_exceptions',
      // The three levels of the Master Data read service, Design v1.1 §12.5.
      // Strictly 1 -> 2 -> 3, each narrowing the last.
      BINS_FOR_LOCATION: 'bins_for_location',
      BIN_CONTENTS: 'bin_contents',
      ITEM_AVAILABILITY: 'item_availability',

      // ── THE LAST STEP OF A RECEIPT — jj_rl_rb_write.js, §11.6 / Design §9.
      //    TrackTrace verifies what was received; the Middleware says which
      //    lots passed; NetSuite moves exactly those out of the on-hold bin.
      //    It is a WRITE, and it creates a Bin Transfer - never an Inventory
      //    Status Change. There is no InventoryStatusChange anywhere in this
      //    SuiteApp (Design v3.1 §9.2.1).
      INV_RELEASE: 'inventory_release'
    });

    /**
     * LINE-LEVEL error codes. A CLOSED SET, and an EXTERNAL CONTRACT: the
     * Middleware branches on these strings to tell an operator what to fix, so
     * a typo here is a silent behaviour change on the other side of the
     * integration. Tell them before you extend it. §6.1.
     */
    const LINE_ERR = Object.freeze({
      ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
      ITEM_INACTIVE: 'ITEM_INACTIVE',
      LINE_NOT_ON_ORDER: 'LINE_NOT_ON_ORDER',
      BAD_QUANTITY: 'BAD_QUANTITY',
      QTY_EXCEEDS_REMAINING: 'QTY_EXCEEDS_REMAINING',
      LOT_INVALID: 'LOT_INVALID',
      SERIAL_INVALID: 'SERIAL_INVALID',
      SERIAL_ALREADY_ON_HAND: 'SERIAL_ALREADY_ON_HAND',
      BIN_NOT_ALLOWED: 'BIN_NOT_ALLOWED',
      BIN_INVALID_LOCATION: 'BIN_INVALID_LOCATION',
      UOM_NOT_CONVERTIBLE: 'UOM_NOT_CONVERTIBLE',
      INVENTORY_DETAIL_MISSING: 'INVENTORY_DETAIL_MISSING',
      INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',         // fulfilment only
      // ── INVENTORY RELEASE — §11.6. Four failures, and they are four
      //    different conversations with the warehouse.
      // The lot name on the payload is not a lot of that item at all.
      LOT_NOT_FOUND: 'LOT_NOT_FOUND',
      // The lot exists, but none of it is in the bin the release names. Most
      // often somebody moved it by hand. The release must NOT guess where it
      // went - Design v3.1 §9.4.
      LOT_NOT_IN_BIN: 'LOT_NOT_IN_BIN',
      // Some of it is there, not all of it.
      QTY_EXCEEDS_IN_BIN: 'QTY_EXCEEDS_IN_BIN',
      // No bin to move from, or none to move to, in the payload OR in
      // configuration. Blank in both places is a configuration error.
      BIN_NOT_CONFIGURED: 'BIN_NOT_CONFIGURED',
      // ── THE LEDGER'S OWN REFUSALS. These are the ones that stop a second
      //    release moving stock a first release already moved.
      // The lot is not one THIS RECEIPT received. It may be perfectly real
      // and sitting in the same hold bin - put there by another receipt.
      LOT_NOT_ON_RECEIPT: 'LOT_NOT_ON_RECEIPT',
      // Everything this receipt received of that lot has already been
      // released. The commonest shape of a duplicate call.
      ALREADY_RELEASED: 'ALREADY_RELEASED',
      // Some of it is still releasable, but not as much as was asked for.
      QTY_EXCEEDS_RECEIVED: 'QTY_EXCEEDS_RECEIVED'
    });

    /** DOCUMENT-level error codes — a failure that is not about one line. */
    const DOC_ERR = Object.freeze({
      MISSING_REQUEST_UUID: 'MISSING_REQUEST_UUID',
      UNKNOWN_OPERATION: 'UNKNOWN_OPERATION',
      FLOW_DISABLED: 'FLOW_DISABLED',
      NO_CONFIGURATION: 'NO_CONFIGURATION',
      ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
      ORDER_NOT_APPROVED: 'ORDER_NOT_APPROVED',
      ORDER_NOT_SYNCED: 'ORDER_NOT_SYNCED',
      ORDER_CLOSED: 'ORDER_CLOSED',
      LOCATION_INACTIVE: 'LOCATION_INACTIVE',
      PERIOD_LOCKED: 'PERIOD_LOCKED',
      MALFORMED_PAYLOAD: 'MALFORMED_PAYLOAD',
      LINE_VALIDATION_FAILED: 'LINE_VALIDATION_FAILED',
      DUPLICATE_IDENTIFIER: 'DUPLICATE_IDENTIFIER',
      RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
      SAVE_REFUSED: 'SAVE_REFUSED',
      // §11.6 — every line of the release was refused, so there is no Bin
      // Transfer to create. Distinct from LINE_VALIDATION_FAILED on a
      // receipt only in what it tells the operator to do next.
      NOTHING_TO_RELEASE: 'NOTHING_TO_RELEASE',
      // §11.6 — a release with no Item Receipt behind it. MANDATORY, because
      // the receipt carries the ledger and without the ledger there is no
      // duplicate guard worth the name. Design v3.1 §9.3 lists the receipt
      // reference as mandatory for exactly this reason.
      RECEIPT_NOT_IDENTIFIED: 'RECEIPT_NOT_IDENTIFIED',
      // The receipt was found and its lines could not be read, so there is
      // no entitlement to check a release against.
      RECEIPT_NOT_READABLE: 'RECEIPT_NOT_READABLE'
    });

    /**
     * READ error codes — jj_rl_rb_read.js. Their own set, not DOC_ERR's,
     * because a read failure means something different to the caller: nothing
     * was attempted, nothing is half-done, and the answer to every one of them
     * is "ask again with better parameters", never "correct the data and
     * resubmit". The Middleware branches on these, so the same rule as LINE_ERR
     * applies — tell them before you extend it.
     */
    /**
     * ══ WHEN A SYNC LOG ROW MAY BE CREATED ═════════════════════════════════
     *
     * FOUR REASONS, AND NOTHING ELSE:
     *
     *   1. CALL        an API call was made, or was about to be and was
     *                  suppressed (kill switch, dry run, environment gate).
     *   2. ERROR       something failed, expected or not.
     *   3. ACTION      a person must do something before this can proceed.
     *   4. NOTICE      something must be said that the NetSuite record itself
     *                  cannot carry - which in practice means the record is
     *                  gone, so there is nothing left to stamp.
     *
     * ROUTINE PROCESSING WRITES NOTHING. No change, feature disabled, not
     * eligible, nothing to do: those are stamped on the RECORD's own Last Sync
     * Try fields by `stampTry`, which creates no row. A warehouse that saves
     * two thousand items a day must not produce two thousand log rows saying
     * nothing happened - the rows that matter drown.
     *
     * This is enforced, not merely documented: `recordNoCall` refuses to write
     * a CLOSED row that carries no error and asks nothing of anyone. See the
     * guard there.
     */
    const LOG_REASON = Object.freeze({
      CALL: 'Call', ERROR: 'Error', ACTION: 'Action', NOTICE: 'Notice'
    });

    const READ_ERR = Object.freeze({
      UNKNOWN_OPERATION: 'UNKNOWN_OPERATION',
      NO_CONFIGURATION: 'NO_CONFIGURATION',
      MALFORMED_PAYLOAD: 'MALFORMED_PAYLOAD',
      MISSING_PARAMETER: 'MISSING_PARAMETER',
      UNKNOWN_RECORD_TYPE: 'UNKNOWN_RECORD_TYPE',
      NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
      TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',
      TRANSACTION_NOT_SYNCED: 'TRANSACTION_NOT_SYNCED',
      TRANSACTION_NOT_SCANNABLE: 'TRANSACTION_NOT_SCANNABLE',
      LOCATION_NOT_FOUND: 'LOCATION_NOT_FOUND',
      BIN_NOT_FOUND: 'BIN_NOT_FOUND',
      ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
      BINS_NOT_ENABLED: 'BINS_NOT_ENABLED',
      SEARCH_FAILED: 'SEARCH_FAILED'
    });

    /**
     * UNEXPECTED BEHAVIOUR ON A READ THAT SUCCEEDED.
     *
     * A clean read writes NO Sync Log row at all — a warehouse opens hundreds
     * of scan sessions a day and a row per browse buries the rows that mean
     * something. A row is written only when the read FAILED, or when one of
     * these was detected: the answer was returned, and something about it
     * needs a human to see it.
     *
     * They are NOT errors. The caller got its answer. They are the cases where
     * the answer is quietly incomplete or quietly wrong, which is exactly the
     * class of thing nobody reports and nobody finds.
     */
    const READ_NOTE = Object.freeze({
      // An uncapped list filled to READ_PAGE.MAX and was cut off. The caller
      // cannot tell truncation from "that is all there is".
      RESULT_TRUNCATED: 'RESULT_TRUNCATED',
      // A line was offered whose item requires serialization and whose product
      // UUID is missing. Scanning it would fail at submit, on the dock.
      LINES_NOT_SCANNABLE: 'LINES_NOT_SCANNABLE',
      // The order transformed but carried no item line at all.
      NO_SCANNABLE_LINES: 'NO_SCANNABLE_LINES',
      // list_transactions ran with no location filter, so the operator was
      // offered every warehouse's work. §7.8.1 requires the filter.
      UNFILTERED_LIST: 'UNFILTERED_LIST',
      // A sub-search failed and the read carried on with less than it should
      // have — a configured field that is not deployed, a join the account's
      // features do not support. The answer is thinner than it looks.
      DEGRADED_READ: 'DEGRADED_READ'
    });

    /**
     * WHICH NOTES ARE WORTH A SYNC LOG ROW, AND WHICH ARE ONLY WORTH SAYING.
     *
     * A note in the envelope always reaches the caller. A Sync Log ROW is a
     * different claim: somebody in this account has to do something. Writing
     * one for every note puts a scanning device's ordinary browsing on the
     * reconciliation page, which is what the last three passes were spent
     * taking off it.
     *
     * -- A ROW, AND AN OPEN ONE ---------------------------------------------
     *
     *   LINES_NOT_SCANNABLE  an ELIGIBLE item on a live order has no product
     *                        UUID for the unit the line is in. The device is
     *                        refused at submit with the goods on the dock.
     *                        Nobody outside NetSuite can fix it: a UOM Detail
     *                        row has to be added, or a Units Type corrected.
     *   DEGRADED_READ        a configured field is not deployed, or a join the
     *                        account's features do not support. The answer is
     *                        thinner than it looks and an administrator has to
     *                        make it whole.
     *
     * -- NO ROW. The envelope's note is the whole answer ---------------------
     *
     *   RESULT_TRUNCATED     the caller asked for more than a page. It pages.
     *   NO_SCANNABLE_LINES   the order has no item line. That is the order,
     *                        not a fault in this account.
     *   UNFILTERED_LIST      the caller omitted the location filter. The
     *                        caller is the one who can add it.
     *
     * NON-ELIGIBLE ITEMS NEVER REACH HERE. An item that is not eligible is
     * never sent to TrackTraceRX, so it has no product UUID BY DESIGN and a
     * missing one is not a finding. `fetch_transaction` counts only eligible
     * lines towards LINES_NOT_SCANNABLE and reports no missing-UUID reason on
     * the others at all.
     */
    const READ_NOTE_REVIEW = Object.freeze([
      'LINES_NOT_SCANNABLE', 'DEGRADED_READ'
    ]);

    /**
     * READ REFUSALS THAT ARE EXPECTED, AND THEREFORE WRITE NO SYNC LOG ROW.
     *
     * A caller asking for a purchase order that does not exist, or one that was
     * never sent to TrackTraceRX, has not found a defect — it has found out
     * something, which is what a read is for. The answer is the product, and
     * the next call will carry better parameters.
     *
     * Logging these would put every mistyped id and every stale cache entry on
     * the reconciliation page, which is the opposite of what that page is for.
     *
     * WHAT IS *NOT* HERE, and therefore still writes a row:
     *
     *   NO_CONFIGURATION   the account is misconfigured. Nothing inbound works
     *                      until somebody fixes it — C.LOG_REASON ACTION
     *   SEARCH_FAILED      NetSuite refused a search this script asked for.
     *                      That is a defect in the SuiteApp or in the account's
     *                      field setup — C.LOG_REASON ERROR
     *   anything unhandled a bug, by definition
     *
     * Plus C.READ_NOTE: unexpected behaviour on an answer that SUCCEEDED, which
     * is the whole reason that set exists.
     */
    const READ_EXPECTED = Object.freeze([
      'UNKNOWN_OPERATION', 'MALFORMED_PAYLOAD', 'MISSING_PARAMETER',
      'UNKNOWN_RECORD_TYPE', 'NOT_IMPLEMENTED',
      'TRANSACTION_NOT_FOUND', 'TRANSACTION_NOT_SYNCED', 'TRANSACTION_NOT_SCANNABLE',
      'LOCATION_NOT_FOUND', 'BIN_NOT_FOUND', 'ITEM_NOT_FOUND', 'BINS_NOT_ENABLED'
    ]);

    /**
     * The page-size ceiling on every read — Master Data Guide v3.3 §7.14.
     * A large location must not be able to return an unbounded list, and a
     * RESTlet that runs out of governance answers with a platform error the
     * Middleware cannot branch on. The cap is not negotiable per call; the
     * caller pages.
     */
    const READ_PAGE = Object.freeze({ MAX: 1000, DEFAULT: 200 });

    /**
     * NetSuite's Item Fulfilment `shipstatus`, from the configured label.
     *
     * A, B and C are not memorable and confusing A with C is the difference
     * between staging goods and relieving inventory. Map from the readable
     * value; never write the letter by hand. §6.1.2, §10.6.
     */
    const IF_STATUS = Object.freeze({ Picked: 'A', Packed: 'B', Shipped: 'C' });

    /** What the inbound path writes into `custbody_jj_rb_origin`. */
    const ORIGIN_MW = 'MIDDLEWARE';

    // ── Endpoints ──────────────────────────────────────────────────────────────
    const EP = Object.freeze({
      PRODUCT_CREATE: { method: 'POST', path: '/products' },
      PRODUCT_UPDATE: { method: 'PUT', path: '/products/{uuid}' },
      PRODUCT_DELETE: { method: 'DELETE', path: '/products/{uuid}' },
      DOSAGE_CREATE: { method: 'POST', path: '/products/pharmaceutical/dosage_forms' },
      DOSAGE_UPDATE: { method: 'PUT', path: '/products/pharmaceutical/dosage_forms/{uuid}' },
      DOSAGE_DELETE: { method: 'DELETE', path: '/products/pharmaceutical/dosage_forms/{uuid}' },
      PARTNER_CREATE: { method: 'POST', path: '/trading_partners' },
      PARTNER_UPDATE: { method: 'PUT', path: '/trading_partners/{uuid}' },
      PARTNER_DELETE: { method: 'DELETE', path: '/trading_partners/{uuid}' },
      PARTNER_ADDRESS: { method: 'POST', path: '/trading_partners/{uuid}/addresses' },
      // An address CAN be updated. Two path parameters: the trading partner and
      // the address within it.
      PARTNER_ADDRESS_UPDATE: { method: 'PUT', path: '/trading_partners/{uuid}/addresses/{address_uuid}' },
      // Same path as the update, DELETE method — the convention every other
      // object in this API follows. CONFIRM with TrackTraceRX: the reference
      // build never deleted an address, so this path is inferred, not observed.
      PARTNER_ADDRESS_DELETE: { method: 'DELETE', path: '/trading_partners/{uuid}/addresses/{address_uuid}' },
      LOCATION_CREATE: { method: 'POST', path: '/locations' },
      LOCATION_UPDATE: { method: 'PUT', path: '/locations/{uuid}' },
      LOCATION_DELETE: { method: 'DELETE', path: '/locations/{uuid}' },
      LOCATION_ADDRESS: { method: 'POST', path: '/locations/{uuid}/addresses' },
      // Location address sync is currently off (location.hasChildren), but the
      // endpoint is declared so switching it back on needs no change here.
      LOCATION_ADDRESS_UPDATE: { method: 'PUT', path: '/locations/{uuid}/addresses/{address_uuid}' },
      LOCATION_ADDRESS_DELETE: { method: 'DELETE', path: '/locations/{uuid}/addresses/{address_uuid}' },
      STORAGE_AREAS: { method: 'GET', path: '/locations/{uuid}/storage_areas' },
      BIN_CREATE: { method: 'POST', path: '/locations/{locationUuid}/storage_areas' },
      BIN_UPDATE: { method: 'PUT', path: '/locations/{locationUuid}/storage_areas/{uuid}' },
      // Not called by anything. The address payload sends the state as the
      // NetSuite record spells it; nothing is resolved to an id. Kept in the
      // catalogue because this file is the one place an endpoint is written.
      STATES: { method: 'GET', path: '/utility/country_list/{countryId}/states' },
      HEALTH: { method: 'GET', path: '/health' },

      // ── transactions. Guide v3.1 §6.2. {txnType} is NOT a constant: the
      //    destination spells the same concept four different ways, so the
      //    token is substituted per operation from TOKENS below.
      TXN_CREATE: { method: 'POST', path: '/transactions/{txnType}' },
      TXN_UPDATE: { method: 'PUT', path: '/transactions/{txnType}/{uuid}' },
      // Declared, not wired. Order close, cancel and delete (§12) are not part
      // of the approved transitions built in this phase; the endpoint is here
      // so that chapter is a builder rather than an edit to this file.
      TXN_VOID: { method: 'DELETE', path: '/transactions/{txnType}/{uuid}' },
      // Read one transaction back. Used by ONE thing: the guard that refuses
      // to void a transaction which already has a shipment against it (§12.3).
      TXN_READ: { method: 'GET', path: '/transactions/{txnType}/{uuid}' }
    });

    /**
     * §6.3 — the path-token table.
     *
     * `POST /transactions/{type}` wants `sales`; `GET /transactions/{type}`
     * wants **`sale`**, singular; the response body says `Sales`, title case.
     * One "transaction type" constant cannot serve all three, so the token is
     * looked up per operation.
     */
    const TOKENS = Object.freeze({
      TXN_CREATE: { salesorder: 'sales', purchaseorder: 'purchase' },
      TXN_UPDATE: { salesorder: 'sales', purchaseorder: 'purchase' },
      TXN_VOID: { salesorder: 'sales', purchaseorder: 'purchase' },
      TXN_READ: { salesorder: 'sales', purchaseorder: 'purchase' },
      TXN_LIST: { salesorder: 'sale', purchaseorder: 'purchase' }   // ← sale
    });

    /**
     * The transaction body fields. The same seven-field bundle every
     * synchronized record carries, plus what Concept 1 forces — a transaction
     * and a shipment are two objects with two identifiers.
     *
     * NOTE: `requestUuid` is a convenience copy of the LATEST inbound call's
     * identifier. The duplicate guard is the NATIVE externalId and is never
     * written from here. §5.2.1.
     */
    const TXN = Object.freeze({
      uuid: 'custbody_jj_rb_uuid', payload: 'custbody_jj_rb_payload',
      synced: 'custbody_jj_rb_synced', lastSync: 'custbody_jj_rb_last_sync',
      lastTry: 'custbody_jj_rb_last_try',
      tryResult: 'custbody_jj_rb_try_result', error: 'custbody_jj_rb_error',
      shipmentUuid: 'custbody_jj_rb_shipment_uuid',
      requestUuid: 'custbody_jj_rb_request_uuid',
      origin: 'custbody_jj_rb_origin',
      allSerial: 'custbody_jj_rb_all_serial',
      containsNonSerial: 'custbody_jj_rb_contains_nonserial',
      // ── THE RELEASE STAMP — Design v3.1 §9.9, on the ITEM RECEIPT only.
      //    A receipt whose stock is never released is invisible unless
      //    somebody looks for it: no call failed and nothing errored, the
      //    stock just sits in the on-hold bin until a picker finds the good
      //    bin empty. These three are what the "received but not released"
      //    worklist is built on (§9.12).
      releasedQty: 'custbody_jj_rb_released_qty',
      heldQty: 'custbody_jj_rb_held_qty',
      releasedAt: 'custbody_jj_rb_released_at',
      // The Bin Transfer that did it. TEXT, holding the internal id, not a
      // List/Record link: a transaction link field would have to name a
      // record type, and the useful answer here is one id a user can paste.
      binTransfer: 'custbody_jj_rb_bin_transfer',
      // ══ THE RELEASE LEDGER ════════════════════════════════════════════
      //
      // Long Text on the ITEM RECEIPT holding a JSON record of what this
      // receipt received per lot and how much of it has been released, call
      // by call. IT IS THE AUTHORITY ON WHAT MAY STILL MOVE.
      //
      // WHY A LEDGER AND NOT THE STOCK ITSELF. Neither of the two obvious
      // guards is sufficient:
      //
      //   request_uuid in externalId  catches a RESEND of the SAME call. It
      //                               does not catch a second call, with a
      //                               fresh uuid, for the same lot - which
      //                               is what a Middleware retry after a
      //                               timeout actually looks like.
      //
      //   the on-hold bin's balance   is SHARED. Several receipts put stock
      //                               in one hold bin, so a balance of 24
      //                               says nothing about WHOSE 24 it is, and
      //                               a second release would happily move
      //                               another receipt's goods. It also lags:
      //                               `inventorybalance` is a search index,
      //                               and a release called seconds after its
      //                               receipt can read a stale number.
      //
      // The ledger has neither problem. It is per receipt, it is written in
      // the same breath as the transfer, and a stored field is read back
      // immediately and exactly.
      //
      // SHAPE - short keys, because this is stored on every receipt:
      //
      //   { "v": 1, "receipt": "2481003", "seq": 3,
      //     "updated": "2026-10-05T10:11:12.000Z",
      //     "lots": {
      //       "718|901": { "item":"718", "lot":"LOT-2026-0815", "lotId":"901",
      //                    "received":24, "released":20 }
      //     },
      //     "calls": [
      //       { "uuid":"f7c1...", "bt":"2492118",
      //         "at":"2026-10-05T10:11:12.000Z",
      //         "moved":[{ "k":"718|901", "q":20 }] }
      //     ],
      //     "callCount": 3 }
      //
      // `calls` is capped - see RELEASE_LEDGER. `lots` and `callCount` are
      // not, because they are the running totals and losing them loses the
      // guard.
      releaseLog: 'custbody_jj_rb_release_log'
    });

    /**
     * Ledger housekeeping. One place, because both the writer and anything
     * that later reads the field has to agree.
     */
    const RELEASE_LEDGER = Object.freeze({
      VERSION: 1,
      // How many individual calls are kept in `calls`. The cumulative figures
      // in `lots` are never trimmed, so trimming history costs traceability
      // in the Sync Log's direction - where the full record already lives -
      // and nothing in the duplicate guard.
      MAX_CALLS: 50
    });

    /** The transaction column fields. The line filter has to be visible on the line. */
    /**
     * The transaction column fields. The line filter has to be visible on the
     * line — §5.3.
     *
     * ── THERE WAS A SOURCED `custcol_jj_rb_item_eligible`, AND IT IS GONE ────
     * It mirrored the item's own TrackTrace Eligibility onto the line through
     * NetSuite's field sourcing, so a line could be read with no script at all.
     * It duplicated `serialized` and it was the weaker of the two:
     *
     *   `serialized` is what THIS INTEGRATION decided, and it stays correct
     *   when a client points the configured Eligibility Field ID at their own
     *   item field.
     *
     *   The sourced column is wired to `custitem_jj_rb_eligible` in the OBJECT
     *   and cannot follow that setting, so in exactly that account it would sit
     *   on the form showing "No" beside a line the integration is syncing. A
     *   column that is right in some accounts and misleading in others, on the
     *   same form, is worse than not having it.
     *
     * One field, one answer. `serialized` is stamped in beforeSubmit on every
     * save, including a CSV import, so nothing is lost.
     */
    const LINE = Object.freeze({
      serialized: 'custcol_jj_rb_serialized',
      productUuid: 'custcol_jj_rb_product_uuid',
      qtySynced: 'custcol_jj_rb_qty_synced',
      // ── INBOUND. Written by the RESTlet onto the receipt or the fulfilment
      //    it creates; never by the outbound path. All three already existed.
      excReason: 'custcol_jj_rb_exception_reason',
      excNote: 'custcol_jj_rb_exception_note',
      holdBin: 'custcol_jj_rb_hold_bin'
    });

    /**
     * UNIT_ALIAS LIVED HERE AND IS GONE.
     *
     * It mapped "EA" to "EACH" and six more like it. Every one of those pairs
     * was a guess about how an account spells its own units, hardcoded into a
     * SuiteApp that exists to stop exactly that. An account with a unit called
     * "Vial" or "Blister" was never in the table and never would be.
     *
     * NetSuite already knows the answer. The item names a Units Type; the Units
     * Type lists its units with BOTH a name and an abbreviation. `units.load`
     * reads that and does the translation from the account's own data — see
     * below.
     */

    /**
     * The base unit is ALWAYS Each - proposal v4 §5.2. A constant, not a
     * switch: v1.0 had a "convert to lowest unit" configuration value and it
     * was deleted when the proposal settled the question.
     */
    const BASE_UNIT = 'EACH';

    /** What NetSuite calls an order that is where the transaction becomes real. */
    const ORIGIN_NS = 'NETSUITE';

    /**
     * THE DISPATCH TABLE.
     * One entry per NetSuite record type the master User Event is deployed to.
     * Adding a master record = one entry here + one function in `builders`
     * (jj_rb_sync.js) + one deployment. Nothing else.
     *
     * `implemented:false` entries are declared so the shape is fixed and the
     * extension point is obvious, but they have no builder yet. Deploying the
     * User Event to one of them stamps `Failed - before API call` LOUDLY rather
     * than silently doing nothing — see sync.run().
     */
    const MASTER = Object.freeze({

      // ── Phase 1, implemented ────────────────────────────────────────────────
      customrecord_jj_rb_dosage_form: {
        key: 'DOSAGE', syncType: SYNCTYPE.DOSAGE_FORM, builder: 'dosage', implemented: true,
        featureFlag: CFG.useDosage, hasChildren: null, logSubjectField: LOG.dosage,
        fields: {
          uuid: 'custrecord_jj_rb_df_uuid', payload: 'custrecord_jj_rb_df_payload',
          synced: 'custrecord_jj_rb_df_synced', lastSync: 'custrecord_jj_rb_df_last_sync',
          lastTry: 'custrecord_jj_rb_df_last_try',
          tryResult: 'custrecord_jj_rb_df_try_result',
          error: 'custrecord_jj_rb_df_error', code: 'custrecord_jj_rb_df_code',
          isDefault: 'custrecord_jj_rb_df_is_default'
        },
        endpoints: { create: EP.DOSAGE_CREATE, update: EP.DOSAGE_UPDATE, remove: EP.DOSAGE_DELETE }
      },

      location: {
        key: 'LOCATION', syncType: SYNCTYPE.LOCATION, builder: 'location', implemented: true,
        featureFlag: null,
        // ── Location ADDRESS sync is OFF. ──────────────────────────────────
        // This one value is the whole switch. While it is null the engine
        // pushes no address child calls for a Location, and buildLocation
        // leaves the address set out of the comparison, so an address-only
        // edit does not re-send the Location either.
        //
        // To switch it back on: set this to 'addressbook'. Nothing else needs
        // to change — the child endpoint below and the address builder, the
        // change detection and the write-back all stay in place and are still
        // used by Customer and Vendor, which are unaffected.
        hasChildren: null,
        logSubjectField: LOG.location,
        parentField: 'parent',                     // NetSuite's own location hierarchy
        fields: {
          uuid: 'custrecord_jj_rb_location_uuid',
          payload: 'custrecord_jj_rb_loc_payload', synced: 'custrecord_jj_rb_loc_synced',
          lastSync: 'custrecord_jj_rb_loc_last_sync',
          lastTry: 'custrecord_jj_rb_loc_last_try',
          tryResult: 'custrecord_jj_rb_loc_try_result',
          error: 'custrecord_jj_rb_loc_error', sgln: 'custrecord_jj_rb_loc_sgln',
          // Restored. buildLocation reads all four; while they were commented
          // out every one of them resolved to undefined and the keys vanished
          // from the payload.
          gs1Id: 'custrecord_jj_rb_loc_gs1_id',
          locationType: 'locationtype',
          latitude: 'latitude',
          longitude: 'longitude',
          storageAreaUuid: 'custrecord_jj_rb_storage_area_uuid',
          holdBin: 'custrecord_jj_rb_loc_onhold_bin',
          goodBin: 'custrecord_jj_rb_loc_good_bin'
        },
        endpoints: {
          create: EP.LOCATION_CREATE, update: EP.LOCATION_UPDATE,
          remove: EP.LOCATION_DELETE,
          child: EP.LOCATION_ADDRESS, childUpdate: EP.LOCATION_ADDRESS_UPDATE,
          childRemove: EP.LOCATION_ADDRESS_DELETE
        }
      },

      // ── Validator only. Never reaches the sync engine. ──────────────────────
      customrecord_jj_rb_config: { key: 'CONFIG', implemented: true, builder: null },

      // ── Declared, not yet built. One builder each and they light up. ────────
      inventoryitem: itemEntry(),
      lotnumberedinventoryitem: itemEntry(),
      serializedinventoryitem: itemEntry(),
      assemblyitem: itemEntry(),
      kititem: itemEntry(),

      customer: entityEntry('CUSTOMER'),
      vendor: entityEntry('VENDOR'),

      bin: {
        key: 'BIN', syncType: SYNCTYPE.BIN, builder: 'bin', implemented: false,
        featureFlag: CFG.useBins, logSubjectField: LOG.bin,
        fields: {
          uuid: 'custrecord_jj_rb_bin_uuid', payload: 'custrecord_jj_rb_bin_payload',
          synced: 'custrecord_jj_rb_bin_synced',
          lastSync: 'custrecord_jj_rb_bin_last_sync',
          lastTry: 'custrecord_jj_rb_bin_last_try',
          tryResult: 'custrecord_jj_rb_bin_try_result',
          error: 'custrecord_jj_rb_bin_error', props: 'custrecord_jj_rb_bin_props'
        },
        endpoints: { create: EP.BIN_CREATE, update: EP.BIN_UPDATE }
      },

      customrecord_jj_rb_uom_detail: {
        key: 'UOM', syncType: SYNCTYPE.ITEM, builder: null, implemented: true,
        delegatesToParent: 'custrecord_jj_rb_uom_item', featureFlag: null,
        logSubjectField: LOG.uom,
        fields: {
          item: 'custrecord_jj_rb_uom_item', unit: 'custrecord_jj_rb_uom_unit',
          qty: 'custrecord_jj_rb_uom_qty', upc: 'custrecord_jj_rb_uom_upc',
          gtin: 'custrecord_jj_rb_uom_gtin',
          gs1Prefix: 'custrecord_jj_rb_uom_gs1_prefix',
          gs1Id: 'custrecord_jj_rb_uom_gs1_id', ndc: 'custrecord_jj_rb_uom_ndc',
          packSize: 'custrecord_jj_rb_uom_pack_size',
          uuid: 'custrecord_jj_rb_uom_uuid', payload: 'custrecord_jj_rb_uom_payload',
          synced: 'custrecord_jj_rb_uom_synced',
          lastSync: 'custrecord_jj_rb_uom_last_sync',
          lastTry: 'custrecord_jj_rb_uom_last_try',
          tryResult: 'custrecord_jj_rb_uom_try_result',
          error: 'custrecord_jj_rb_uom_error'
        },
        endpoints: { create: EP.PRODUCT_CREATE, update: EP.PRODUCT_UPDATE, remove: EP.PRODUCT_DELETE }
      }
    });

    /** Every item type shares one entry shape. Declared once, reused five times. */
    function itemEntry() {
      return {
        key: 'ITEM', syncType: SYNCTYPE.ITEM, builder: 'item', implemented: true,
        featureFlag: null, requiresEligibility: true, requiresUom: true,
        logSubjectField: LOG.item,
        fields: {
          synced: 'custitem_jj_rb_synced', lastSync: 'custitem_jj_rb_last_sync',
          lastTry: 'custitem_jj_rb_last_try', tryResult: 'custitem_jj_rb_try_result',
          error: 'custitem_jj_rb_error', attention: 'custitem_jj_rb_attention',
          eligible: 'custitem_jj_rb_eligible', dosage: 'custitem_jj_rb_dosage_form',
          strength: 'custitem_jj_rb_strength', generic: 'custitem_jj_rb_generic_name'
        },
        // NOTE: no uuid, no payload. Those live on each UOM Detail row.
        endpoints: { create: EP.PRODUCT_CREATE, update: EP.PRODUCT_UPDATE, remove: EP.PRODUCT_DELETE }
      };
    }

    /** Customer and Vendor differ by one payload value. */
    function entityEntry(partnerType) {
      return {
        key: partnerType, syncType: SYNCTYPE[partnerType], builder: 'entity', implemented: true,
        partnerType: partnerType, featureFlag: null, hasChildren: 'addressbook',
        // A sub-customer. The parent must hold a Middleware UUID before the
        // child can name it, exactly as for a Location hierarchy.
        //
        // CUSTOMER only. `parent` is not a valid search column on VENDOR — the
        // record type has no parent-vendor hierarchy — and asking for it fails
        // the whole lookup with "An nlobjSearchColumn contains an invalid
        // column ... parent", which stops the vendor syncing at all.
        parentField: partnerType === 'CUSTOMER' ? 'parent' : null,
        // The native columns this builder reads, beyond the custom fields
        // above. Per record type, because the two do not expose the same set:
        // `altname` and `parent` exist on CUSTOMER and not on VENDOR.
        extraColumns: partnerType === 'CUSTOMER'
          ? ['entityid', 'companyname', 'isinactive', 'phone', 'email',
            'isperson', 'altname', 'parent']
          : ['entityid', 'companyname', 'isinactive', 'phone', 'email',
            'isperson'],
        logSubjectField: LOG.entity,
        fields: {
          uuid: 'custentity_jj_rb_uuid', payload: 'custentity_jj_rb_payload',
          synced: 'custentity_jj_rb_synced', lastSync: 'custentity_jj_rb_last_sync',
          lastTry: 'custentity_jj_rb_last_try', tryResult: 'custentity_jj_rb_try_result',
          error: 'custentity_jj_rb_error', gln: 'custentity_jj_rb_gln'
        },
        endpoints: {
          create: EP.PARTNER_CREATE, update: EP.PARTNER_UPDATE,
          remove: EP.PARTNER_DELETE,
          child: EP.PARTNER_ADDRESS, childUpdate: EP.PARTNER_ADDRESS_UPDATE,
          childRemove: EP.PARTNER_ADDRESS_DELETE
        }
      };
    }

    /**
     * THE TRANSACTION DISPATCH TABLE. §6.4.
     *
     * The same shape as MASTER, and for the same reason: adding a transaction
     * type is one entry here plus one builder in jj_rb_txn.js. Nothing else.
     *
     * `implemented:false` rows are declared so the shape is fixed and the
     * extension point is obvious. Deploying the User Event to one of them
     * stamps `Failed - before API call` LOUDLY rather than doing nothing.
     *
     * PHASE 1, OUTBOUND ONLY. Item Fulfilment and Item Receipt are created
     * INBOUND, by the Middleware calling the RESTlet, so they have no entry
     * here at all — an outbound dispatch row for them would be a push path the
     * standard flow does not have (§10.1, §11.1).
     */
    const TXNMAP = Object.freeze({

      salesorder: txnEntry({
        recordType: 'salesorder', key: 'SO', syncType: SYNCTYPE.SALES_ORDER, builder: 'salesTxn',
        implemented: true, phase: 1,
        // The customer. Its trading-partner UUID is what the payload names.
        partnerType: 'CUSTOMER', entityField: 'entity',
        // §8.4 — always sent explicitly on a SALES transaction, never inferred
        // from the trading partner's default. Ignored on a purchase.
        subType: 'SALES',
        // §8.2 — NetSuite's status for an approved order awaiting picking.
        // The value actually tested comes from the configuration; this is the
        // default that seeds it.
        // WHEN IT MAY BE SENT: any status marked sync:true in TXN_STATUS for
        // this record type — Pending Fulfillment onwards. Nothing is named
        // here, so nothing can drift out of step with that table.
        flow: { enabled: 'soEnabled' },
        // §9.3 — on a SALE the partner supplies billing and ship-to, the
        // location supplies ship-from and sold-by.
        addressRoles: {
          billing: 'PARTNER', shipTo: 'PARTNER',
          shipFrom: 'LOCATION', soldBy: 'LOCATION'
        }
      }),

      purchaseorder: txnEntry({
        recordType: 'purchaseorder', key: 'PO', syncType: SYNCTYPE.PURCHASE_ORDER, builder: 'purchaseTxn',
        implemented: true, phase: 1,
        partnerType: 'VENDOR', entityField: 'entity',
        // §9.3 — the sub-type is IGNORED on a purchase transaction. Not sent.
        subType: null,
        // §9.2 — the most consequential gate in the SuiteApp: below it the
        // order carries no transaction identifier, so the goods against it
        // cannot be scanned at all.
        // Pending Receipt onwards — TXN_STATUS.purchaseorder.
        flow: { enabled: 'poEnabled' },
        // §9.3 — REVERSED against a sale.
        addressRoles: {
          billing: 'LOCATION', shipTo: 'LOCATION',
          shipFrom: 'PARTNER', soldBy: 'PARTNER'
        }
      }),

      // ── Declared, not built in this phase. One builder each and they light
      //    up. Every one of them is Phase 2 in the guide except the two
      //    inbound types, which are not outbound work at all. ──────────────
      transferorder: txnEntry({
        recordType: 'transferorder', key: 'TO', syncType: SYNCTYPE.SALES_ORDER, builder: 'transferTxn',
        implemented: false, phase: 2, partnerType: null, entityField: null,
        subType: 'TRANSFER',
        flow: { enabled: 'toEnabled' },
        addressRoles: null
      }),
      returnauthorization: txnEntry({
        recordType: 'returnauthorization', key: 'RMA', syncType: SYNCTYPE.SALES_ORDER, builder: 'rmaTxn',
        implemented: false, phase: 2, partnerType: 'CUSTOMER', entityField: 'entity',
        subType: 'RETURN',
        flow: { enabled: null },
        addressRoles: null
      }),
      vendorreturnauthorization: txnEntry({
        recordType: 'vendorreturnauthorization', key: 'VRA', syncType: SYNCTYPE.PURCHASE_ORDER, builder: 'vendorReturnTxn',
        implemented: false, phase: 2, partnerType: 'VENDOR', entityField: 'entity',
        subType: 'RETURN',
        flow: { enabled: null },
        addressRoles: null
      })

      // NO inventoryadjustment ENTRY. Direct inventory adjustment is out of
      // scope — §1.5.3. Do not add one.
      //
      // NO itemfulfillment / itemreceipt ENTRY. They are created inbound by
      // the Middleware — §2.2, §10.2, §11.1.
    });

    /**
     * Every transaction entry shares one shape, so the parts that never differ
     * are written once. The caller supplies only what IS different.
     */
    function txnEntry(o) {
      return {
        key: o.key, syncType: o.syncType, builder: o.builder,
        implemented: o.implemented, phase: o.phase,
        partnerType: o.partnerType, entityField: o.entityField,
        subType: o.subType,
        // The platform's status rows for this record type. A Phase 2 row that
        // NetSuite has no table for gets null, and reads as "never eligible"
        // — which never bites, because an unbuilt row fails loudly first.
        statuses: TXN_STATUS[o.recordType] || null,
        flow: o.flow, addressRoles: o.addressRoles,
        // Concept 3 — every outbound order filters its lines.
        filtersLines: true,
        // The Sync Log's link back to the order. The subject block's other
        // links are all master data; without this one a work item cannot be
        // opened from the order it is about (§5.4.2).
        logSubjectField: LOG.transaction,
        // The seven-field bundle, under the ids the engine's write-back and
        // stamping already expect.
        fields: TXN,
        lineFields: LINE,
        // An order is one object, so it is one unit and one call. There is no
        // per-row fan-out as there is for an Item.
        featureFlag: null, hasChildren: null, parentField: null,
        endpoints: {
          create: EP.TXN_CREATE, update: EP.TXN_UPDATE, remove: EP.TXN_VOID
        }
      };
    }

    /** Address subrecord fields — children of an entity or a location. §10.5. */
    const ADDR = Object.freeze({
      uuid: 'custrecord_jj_rb_addr_uuid', sgln: 'custrecord_jj_rb_addr_sgln',
      error: 'custrecord_jj_rb_addr_error',
      // NEW. Without a stored payload every parent update re-POSTed every
      // address, and the address endpoint only creates — so each parent edit
      // added another duplicate address in the Middleware.
      payload: 'custrecord_jj_rb_addr_payload'
      // The NetSuite address internal id is deliberately NOT a field here. It
      // already exists — it is NetSuite's own id for the address — so copying
      // it onto the address would be a third home for the same value. It is
      // carried on the SYNC LOG instead, inside the NetSuite Internal ID of the
      // address's own work item (see nsKey in jj_rb_io.js).
    });

    /**
     * Fields that are OURS. A change confined to these is our own write-back,
     * and the recursion guard returns on it. §2.2 guard 1.
     */
    const SYNC_CONTROL_FIELDS = Object.freeze([
      'custitem_jj_rb_synced', 'custitem_jj_rb_last_sync', 'custitem_jj_rb_error',
      'custitem_jj_rb_attention', 'custitem_jj_rb_last_try', 'custitem_jj_rb_try_result',
      'custentity_jj_rb_uuid', 'custentity_jj_rb_payload', 'custentity_jj_rb_synced',
      'custentity_jj_rb_last_sync', 'custentity_jj_rb_error',
      'custentity_jj_rb_last_try', 'custentity_jj_rb_try_result',
      'custrecord_jj_rb_location_uuid', 'custrecord_jj_rb_storage_area_uuid',
      'custrecord_jj_rb_loc_payload', 'custrecord_jj_rb_loc_synced',
      'custrecord_jj_rb_loc_last_sync', 'custrecord_jj_rb_loc_error',
      'custrecord_jj_rb_loc_last_try', 'custrecord_jj_rb_loc_try_result',
      'custrecord_jj_rb_bin_uuid', 'custrecord_jj_rb_bin_payload',
      'custrecord_jj_rb_bin_synced', 'custrecord_jj_rb_bin_last_sync',
      'custrecord_jj_rb_bin_error',
      'custrecord_jj_rb_bin_last_try', 'custrecord_jj_rb_bin_try_result',
      'custrecord_jj_rb_df_uuid', 'custrecord_jj_rb_df_payload', 'custrecord_jj_rb_df_synced',
      'custrecord_jj_rb_df_last_sync', 'custrecord_jj_rb_df_error',
      'custrecord_jj_rb_df_last_try', 'custrecord_jj_rb_df_try_result',
      'custrecord_jj_rb_uom_uuid', 'custrecord_jj_rb_uom_payload',
      'custrecord_jj_rb_uom_synced', 'custrecord_jj_rb_uom_last_sync',
      'custrecord_jj_rb_uom_error',
      'custrecord_jj_rb_uom_last_try', 'custrecord_jj_rb_uom_try_result',
      'custrecord_jj_rb_addr_uuid', 'custrecord_jj_rb_addr_payload',
      'custrecord_jj_rb_addr_error',
      // ── transactions. §6.5.
      'custbody_jj_rb_uuid', 'custbody_jj_rb_payload', 'custbody_jj_rb_synced',
      'custbody_jj_rb_last_sync', 'custbody_jj_rb_last_try',
      'custbody_jj_rb_try_result', 'custbody_jj_rb_error',
      'custbody_jj_rb_shipment_uuid', 'custbody_jj_rb_request_uuid',
      'custcol_jj_rb_product_uuid', 'custcol_jj_rb_qty_synced'
      //
      // DELIBERATELY ABSENT, and this is not an oversight:
      //   custbody_jj_rb_all_serial
      //   custbody_jj_rb_contains_nonserial
      //   custcol_jj_rb_serialized
      // They are recomputed from the lines in beforeSubmit, so a change to one
      // of them IS a change to the order's classification and must re-trigger
      // the sync. Listing them here would make an item becoming eligible
      // invisible to the engine. §6.5.
    ]);

    const C = Object.freeze({
      REC, CFG, LOG, LIST, EP, MASTER, ADDR, SYNC_CONTROL_FIELDS,
      STATUS, OPEN_STATUSES, ROLE, TRY, OUTCOME, ERRCLASS, TRIGGER,
      DIRECTION, SYNCTYPE, OPERATION, REASON,
      // transactions
      TXN, LINE, TXNMAP, TOKENS, BASE_UNIT, ORIGIN_NS,
      TXN_STATUS, INBOUND, LINE_ERR, DOC_ERR, IF_STATUS, ORIGIN_MW,
      // reads
      READ_ERR, READ_NOTE, READ_NOTE_REVIEW, READ_EXPECTED, READ_PAGE, LOG_REASON,
      RELEASE_LEDGER
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // namespace 2: util — pure. No record access, no HTTP.
    // ═══════════════════════════════════════════════════════════════════════════

    /** RFC-4122 v4, from Math.random. Correlation ids only, never a security token. */
    const uuid = () =>
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
      });

    /**
     * Canonical JSON - and THE change-detection value itself. The string this
     * returns is what gets stored on the record and compared on the next save;
     * there is no hash in between.
     *
     * Keys sorted at every depth, undefined and null dropped. Two payloads that
     * mean the same thing MUST produce the same string, or the comparison fires
     * on key order and every save becomes an API call.
     */
    const canonical = (v) => {
      if (v === null || v === undefined) return '""';
      if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
      if (typeof v === 'object') {
        // EVERY key is kept, including the empty ones. The Middleware contract
        // is a fixed key set: a payload that silently loses its blank keys is
        // not the same payload, and the stored comparison has to be a
        // comparison of what was actually sent. Filtering them out here is what
        // made the stored payload disagree with the wire.
        return '{' + Object.keys(v).sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
      }
      if (typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v);
      return JSON.stringify(String(v));
    };

    /**
     * Are these two payloads the same? A direct string comparison of the
     * canonical forms - no hashing, nothing to collide, and the stored value
     * stays readable in the UI, which is what makes "why did this re-sync?"
     * answerable by looking at the record instead of guessing.
     *
     * A blank on either side is NOT a match: a record that has never synced,
     * and a record whose last call failed, must both still go out.
     */
    const samePayload = (a, b) => {
      if (a === undefined || a === null || a === '') return false;
      if (b === undefined || b === null || b === '') return false;
      return String(a) === String(b);
    };

    /**
     * Form-urlencode, matching the Middleware's declared content type.
     *
     * Nested values are JSON-stringified first. Without that step an array or an
     * object encodes as the literal "[object Object]" — which the Middleware
     * accepts with a 200 and stores as garbage.
     */
    const formEncode = (obj) => Object.keys(obj)
      .map((k) => {
        const v = obj[k];
        // No filtering. The reference client encodes every key of the body and
        // the Middleware expects the full, fixed key set — an omitted key is
        // not the same as an empty one. undefined and null go on the wire as an
        // empty value, exactly as the reference build does.
        const scalar = (v === undefined || v === null) ? ''
          : (typeof v === 'object') ? JSON.stringify(v)
            : (typeof v === 'boolean') ? String(v) : v;
        return encodeURIComponent(k) + '=' + encodeURIComponent(scalar);
      })
      .join('&');

    /**
     * Values a builder wants INSIDE the comparison but NOT on the wire go under
     * `__compare`. An entity's address set is the case this exists for: an
     * address edit must move the parent's comparison, but the addresses are
     * pushed as their own calls and must not ride the parent body.
     */
    const COMPARE_KEY = '__compare';

    /**
     * The mirror image of COMPARE_KEY: values that go ON THE WIRE but must be
     * kept OUT of the comparison.
     *
     * `custom_uuid` is the whole reason this exists. It is empty on the create
     * and holds the TrackTrace UUID afterwards, so the payload legitimately
     * differs before and after the first successful sync — for a record whose
     * data has not changed at all. Comparing it would make the write-back of
     * the UUID look like an edit and fire a pointless update on the next save.
     *
     * The identity is not part of what is being compared. What is compared is
     * the DATA.
     */
    const COMPARE_IGNORE = Object.freeze([
      'custom_uuid',
      // The transaction payload's identity key. Exactly the same argument:
      // empty on the create, the destination's identifier afterwards, and the
      // ORDER has not changed — so comparing it would fire an update on the
      // save that follows every first sync.
      'transaction_uuid'
    ]);

    /**
     * The canonical string used for CHANGE DETECTION. Same renderer as
     * canonical(), minus the identity keys. Everything else, including the
     * empty keys and the __compare block, is kept.
     */
    const canonicalCompare = (payload) => {
      if (!payload || typeof payload !== 'object') return canonical(payload);
      const out = {};
      Object.keys(payload).forEach((k) => {
        if (COMPARE_IGNORE.indexOf(k) !== -1) return;
        out[k] = payload[k];
      });
      return canonical(out);
    };
    const stripCompare = (payload) => {
      if (!payload || typeof payload !== 'object') return payload;
      const out = {};
      Object.keys(payload).forEach((k) => { if (k !== COMPARE_KEY) out[k] = payload[k]; });
      return out;
    };

    const encodeBody = (body, cfg) => {
      if (body === undefined || body === null) return undefined;
      if (typeof body === 'string') return body;
      return String(cfg && cfg.contentType).indexOf('json') !== -1
        ? JSON.stringify(body)
        : formEncode(body);
    };

    const clip = (s, n) => {
      const str = (s === undefined || s === null) ? '' : String(s);
      return str.length <= n ? str : str.substring(0, n - 3) + '...';
    };

    const safeJson = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

    const isoUtc = (d) => {
      try { return (d instanceof Date ? d : new Date(d)).toISOString(); }
      catch (e) { return ''; }
    };

    /** NetSuite hands checkbox values back as boolean, 'T'/'F' or 'true'/'false'. */
    const truthy = (v) =>
      v === true || v === 'T' || v === 'true' || v === 1 || v === '1';

    const blank = (v) =>
      v === undefined || v === null || v === '' || v === 'null' || v === 'undefined';

    /**
     * Did this save change nothing but our own fields?
     * A CREATE has no oldRecord, so it is never our write-back.
     */
    const onlySyncFieldsChanged = (oldRec, newRec, controlled) => {
      if (!oldRec || !newRec) return false;
      const seen = {};
      let changed = 0;
      controlled.forEach((f) => { seen[f] = true; });

      const fields = newRec.getFields();
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        let a, b;
        try { a = oldRec.getValue({ fieldId: f }); b = newRec.getValue({ fieldId: f }); }
        catch (e) { continue; }
        if (String(a) === String(b)) continue;
        if (!seen[f]) return false;        // something of THEIRS changed
        changed++;
      }
      return changed > 0;                  // only ours changed, and something did
    };

    const util = {
      normStatus, statusEntry, syncStatusNames, scannableStatusNames,
      uuid, canonical, canonicalCompare, COMPARE_IGNORE,
      samePayload, formEncode, encodeBody, stripCompare, COMPARE_KEY,
      clip, safeJson, isoUtc, truthy, blank, onlySyncFieldsChanged
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // namespace 3: lists — display value → internal id, cached per execution
    // ═══════════════════════════════════════════════════════════════════════════

    const LIST_CACHE = {};

    /**
     * Resolve a custom list value's internal id from its display value.
     * A SELECT field cannot be written with display text through submitFields,
     * and hardcoding internal ids makes the SuiteApp account-specific — which is
     * the whole thing this build exists to stop.
     *
     * @returns {string|null} internal id, or null when the value is not in the list
     */
    const listId = (listScriptId, value) => {
      if (util.blank(value)) return null;
      if (!LIST_CACHE[listScriptId]) {
        const map = {};
        try {
          search.create({
            type: listScriptId,
            filters: [],
            columns: ['internalid', 'name']
          }).run().each((r) => {
            map[String(r.getValue('name')).toLowerCase()] = r.getValue('internalid');
            return true;
          });
        } catch (e) {
          log.error({ title: 'RB listId — list unreadable: ' + listScriptId, details: e });
        }
        LIST_CACHE[listScriptId] = map;
      }
      const id = LIST_CACHE[listScriptId][String(value).toLowerCase()];
      if (id === undefined) {
        log.error({
          title: 'RB listId — value not found',
          details: listScriptId + ' has no value "' + value + '"'
        });
        return null;
      }
      return id;
    };

    const lists = {
      id: listId, invalidate: () => {
        Object.keys(LIST_CACHE)
          .forEach((k) => delete LIST_CACHE[k]);
      }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // namespace 4: config — the one active row, cached for the execution
    // ═══════════════════════════════════════════════════════════════════════════

    let CFG_CACHE = null;
    let CFG_READ = false;

    /**
     * The single active configuration row.
     * @returns {Object|null} null when nothing is configured — the caller returns
     *                        silently rather than guessing at a host.
     */
    /**
     * Parse the Pack Size Type Map configuration value.
     *
     * Accepts {"Each":"1","Case":"5"}, where the key is the Saleable Unit and
     * the value is the TrackTraceRX pack size type id from
     * GET /products/packaging_types. The inverted form {"1":"Each"} is NOT
     * accepted — the unit has to be the key, because two units can legitimately
     * share a pack size type.
     *
     * A value that will not parse is logged and treated as an empty map rather
     * than throwing: a mistyped configuration must not stop every item syncing.
     *
     * @returns {Object} UPPERCASED unit text -> pack size type id, as a string
     */
    const parsePackSizeMap = (raw) => {
      const out = {};
      if (!raw) return out;
      let src = null;
      try { src = JSON.parse(String(raw)); }
      catch (e) {
        log.error({
          title: 'RB Pack Size Type Map is not valid JSON',
          details: (e && e.message) || String(e)
        });
        return out;
      }
      if (!src || typeof src !== 'object' || Array.isArray(src)) {
        log.error({
          title: 'RB Pack Size Type Map must be a JSON object',
          details: 'Expected {"Each":"1","Case":"5"}; got ' + String(raw).slice(0, 120)
        });
        return out;
      }
      Object.keys(src).forEach((k) => {
        const v = src[k];
        // Scalars only. An object or an array here would stringify to
        // "[object Object]" or "1,2" and travel to the Middleware as the pack
        // size type id, which is worse than having no mapping at all.
        if (v === null || v === undefined || typeof v === 'object') {
          log.error({
            title: 'RB Pack Size Type Map value ignored for "' + k + '"',
            details: 'Expected a number or a string; got ' +
              (v === null ? 'null' : typeof v) + '.'
          });
          return;
        }
        const val = String(v).trim();
        if (val === '') return;                      // trimmed, then checked
        out[String(k).trim().toUpperCase()] = val;
      });
      return out;
    };

    /** The single active configuration row, read once per execution. */
    const get = () => {
      if (CFG_READ) return CFG_CACHE;
      CFG_READ = true;
      CFG_CACHE = null;

      const cols = Object.keys(CFG).map((k) => CFG[k]);
      try {
        search.create({
          type: REC.CONFIG,
          filters: [[CFG.active, 'is', 'T'], 'AND', ['isinactive', 'is', 'F']],
          columns: cols.concat(['internalid'])
        }).run().getRange({ start: 0, end: 1 }).forEach((r) => {
          const row = { id: r.getValue('internalid') };
          Object.keys(CFG).forEach((k) => {
            const fid = CFG[k];
            const raw = r.getValue(fid);
            row[k] = raw;
            row[k + 'Text'] = r.getText(fid) || null;
          });
          // Normalise the handful the engine branches on.
          row.killswitch = util.truthy(row.killswitch);
          row.dryRun = util.truthy(row.dryRun);
          row.useDosage = util.truthy(row.useDosage);
          row.useBins = util.truthy(row.useBins);
          row.useAddress = util.truthy(row.useAddress);
          row.syncInactive = util.truthy(row.syncInactive);
          row.allowNonprod = util.truthy(row.allowNonprod);
          // Transaction flow flags. Checkboxes, so the same normalisation —
          // a raw 'F' is truthy as a string and would enable a disabled flow.
          row.soEnabled = util.truthy(row.soEnabled);
          row.poEnabled = util.truthy(row.poEnabled);
          row.irEnabled = util.truthy(row.irEnabled);
          row.ifEnabled = util.truthy(row.ifEnabled);
          // A LIST field, so the label is what C.IF_STATUS is keyed on.
          row.ifStatus = String(row.ifStatusText || row.ifStatus || '').trim();
          // Free-form text, so the *Text alias is the wrong one to read — the
          // trap inactiveMethod fell into. Blank means MARK_CLOSED: it is the
          // useful answer and the only one of the three that is not
          // destructive, and voiding is irreversible (J-03).
          row.closeAction = String(row.closeAction || '')
            .trim().toUpperCase().replace(/[^A-Z]+/g, '_') || 'MARK_CLOSED';
          row.envLabel = row.envLabelText || 'PRODUCTION';
          row.contentType = row.contentTypeText || 'application/x-www-form-urlencoded';
          // TEXT field, not a list: getText() returns null for a free-form
          // column, so reading the *Text alias meant the configured value
          // (PUT_IS_ACTIVE_FALSE / DELETE) was never seen and every account
          // silently behaved as the default.
          row.inactiveMethod = String(row.inactiveMethod || row.inactiveMethodText || 'PUT_IS_ACTIVE_FALSE').toUpperCase();

          // Saleable Unit -> TrackTraceRX pack size type id, as JSON on the
          // configuration. It cannot be hardcoded: the ids come from
          // GET /products/packaging_types and the Saleable Unit values are the
          // client's own list. Keyed case-insensitively on the DISPLAY TEXT of
          // the Saleable Unit, so the map survives a redeployed list whose
          // internal ids differ.
          row.packSizeTypes = parsePackSizeMap(row.packSizeMap);

          CFG_CACHE = row;
        });
      } catch (e) {
        log.error({ title: 'RB config.get', details: e });
        CFG_CACHE = null;
      }
      return CFG_CACHE;
    };

    const invalidate = () => { CFG_CACHE = null; CFG_READ = false; lists.invalidate(); };

    /**
     * The per-flow settings for one transaction entry. Guide v3.1 §4.3.1.
     *
     * The guide reads these off a child record with one row per flow. This
     * build holds them on the configuration row itself (see CFG above), and
     * this function is the whole difference — every caller asks `config.flow`
     * and none of them knows where the values live.
     *
     * WHAT IS NOT HERE, DELIBERATELY: a status gate and an approval mode.
     * Whether an order may be sent is decided by NetSuite's own status
     * (TXN_STATUS above), which is not something an account configures and not
     * something that can be left blank or typed wrongly. All that remains per
     * flow is whether it runs at all.
     *
     * @returns {{enabled:boolean}|null}
     *          null when the entry declares no flow key at all, which is how
     *          an unbuilt Phase 2 row reads as "not configured" rather than as
     *          "enabled".
     */
    const flow = (entry) => {
      const cfg = get();
      if (!cfg || !entry || !entry.flow) return null;
      const k = entry.flow;
      return { enabled: k.enabled ? cfg[k.enabled] === true : false };
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // namespace 5: units — the account's own unit vocabulary
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * ══ WHY THIS EXISTS ═══════════════════════════════════════════════════
     *
     * A transaction line's `units` field reads back as an ABBREVIATION — "EA",
     * "PLT". A UOM Detail row's Saleable Unit is a NAME — "Each", "Pallet".
     * Comparing them never matches, and every line reports
     * `NO_ROW: the item has no UOM Detail row for unit "EA"` against a UOM
     * table that is perfectly correct.
     *
     * The earlier fix guessed, with a hardcoded abbreviation table. That is
     * wrong in principle for a configurable SuiteApp — an account with a unit
     * called "Vial" was never in the table — and it was wrong in practice the
     * moment a client used their own vocabulary.
     *
     * NETSUITE ALREADY HOLDS THE TRANSLATION. Every item names a **Units
     * Type**; every Units Type lists its units with a name, an abbreviation,
     * plural forms and a conversion rate. Read that and the account tells you
     * its own spelling.
     *
     * ══ GOVERNANCE ════════════════════════════════════════════════════════
     *
     * TWO searches for a whole document, not two per line:
     *
     *   1. the items  → their Units Type ids   (callers that already search
     *                   `item` add one column instead and skip this)
     *   2. ONE `unitstype` search over the DISTINCT type ids → every unit of
     *      every type on the document
     *
     * A twelve-line order with three distinct items on one Units Type costs
     * one search here, not twelve.
     */

    /** The item field naming its Units Type. */
    const UNITS_TYPE_FIELD = 'unitstype';

    /** itemId -> unitstype id. One search. Skip it if you already search items. */
    const unitTypesForItems = (itemIds) => {
      const out = {};
      if (!itemIds || !itemIds.length) return out;
      try {
        search.create({
          type: 'item',
          filters: [['internalid', 'anyof', itemIds]],
          columns: ['internalid', UNITS_TYPE_FIELD]
        }).run().each((r) => {
          out[String(r.id)] = String(r.getValue(UNITS_TYPE_FIELD) || '');
          return true;
        });
      } catch (e) {
        log.error({ title: 'RB unitTypesForItems', details: e });
      }
      return out;
    };

    /**
     * Load every unit of every Units Type these items name, and return a
     * resolver keyed by the UNIT'S OWN INTERNAL ID.
     *
     * ── WHY record.load AND NOT A SEARCH ───────────────────────────────────
     *
     * A transaction line names its unit by an INTERNAL ID — `units` reads back
     * as `23`. That id belongs to a row in the Units Type's UOM sublist, and
     * **a `unitstype` SEARCH cannot return it**: the search's `internalid` is
     * the TYPE's, repeated once per unit, so there is no column that says
     * "this row is unit 23". Searching could only ever give names and
     * abbreviations, which is why the first attempt had to guess at spellings
     * and why an alias table appeared to be needed.
     *
     * `record.load` on the Units Type exposes the sublist, and the sublist has
     * the row id. Resolution becomes a lookup, not a comparison:
     *
     *     line says units = 23  →  byId['23']  →  { name: 'Pallet', rate: 16 }
     *
     * No normalisation, no plurals, no abbreviations, nothing hardcoded, and
     * nothing that can mis-resolve. The spelling index below is a FALLBACK for
     * the one case where no id is available, not the mechanism.
     *
     * ── GOVERNANCE ────────────────────────────────────────────────────────
     *
     * 10 units per DISTINCT Units Type, not per line and not per item. A
     * twelve-line order whose items all share one Units Type costs 10.
     */
    const loadUnits = (itemTypes) => {
      const typeIds = [];
      Object.keys(itemTypes || {}).forEach((k) => {
        const t = String(itemTypes[k] || '');
        if (t && typeIds.indexOf(t) === -1) typeIds.push(t);
      });

      // ONE MAP PER TYPE, ONE OBJECT PER UNIT.
      //
      //   byType['1'] = { '23': pallet, 'PALLET': pallet, 'PF': pallet, … }
      //
      // The id key and the spelling keys point at the SAME object, so four
      // units cost four objects however many ways they can be found. Ids are
      // numeric and spellings are alphabetic, so the two cannot collide.
      //
      // SCOPED BY TYPE, not global. A unit id is unique across NetSuite, so a
      // global index would happily resolve a unit belonging to a type the item
      // does not use — which is a data error worth reporting, not papering
      // over.
      const byType = {};        // typeId -> { key: unit }
      const byTypeList = {};    // typeId -> [unit]   (for messages, in order)
      let loaded = false;

      typeIds.forEach((tid) => {
        let rec;
        try {
          rec = record.load({ type: 'unitstype', id: tid, isDynamic: false });
        } catch (e) {
          // No Multiple Units of Measure feature, or the type was deleted.
          log.audit({
            title: 'RB loadUnits — Units Type ' + tid + ' could not be loaded',
            details: (e && e.message) || String(e)
          });
          return;
        }
        loaded = true;
        byType[tid] = byType[tid] || {};
        byTypeList[tid] = byTypeList[tid] || [];

        let n = 0;
        try { n = rec.getLineCount({ sublistId: 'uom' }); } catch (e) { n = 0; }

        for (let i = 0; i < n; i++) {
          const g = (f) => {
            try { return rec.getSublistValue({ sublistId: 'uom', fieldId: f, line: i }); }
            catch (e) { return ''; }
          };
          const name = String(g('unitname') || '');
          if (!name) continue;

          const unit = {
            id: String(g('internalid') || ''),
            typeId: tid,
            name: name,
            abbreviation: String(g('abbreviation') || ''),
            rate: Number(g('conversionrate')) || 1,
            isBase: truthy(g('baseunit'))
          };

          byTypeList[tid].push(unit);

          // The id — what a transaction line actually carries.
          if (unit.id) byType[tid][unit.id] = unit;

          // NAME and ABBREVIATION, for a form that exposes no id. Two keys,
          // not the five the spelling-guessing version carried. Plurals are
          // dropped: nothing produces a plural where an id is unavailable, and
          // an index nothing reads is one more thing to keep correct.
          [unit.name, unit.abbreviation].forEach((sp) => {
            const k = unitKey(sp);
            if (k && !byType[tid][k]) byType[tid][k] = unit;
          });
        }
      });

      return {
        loaded: loaded,

        /**
         * The unit this line is in.
         *
         * @param itemId  the line's item, used to scope the spelling fallback
         * @param raw     the line's `units` value — an INTERNAL ID normally,
         *                a name or abbreviation when that is all there is
         */
        nameFor: (itemId, raw) => {
          const v = String(raw === null || raw === undefined ? '' : raw).trim();
          if (!v) return null;
          const tid = String((itemTypes || {})[String(itemId)] || '');
          const rows = tid && byType[tid];
          if (!rows) return null;

          // 1. BY ID — what a transaction line carries. An id that is not in
          //    THIS item's type is not a match: the line and the item disagree
          //    about which Units Type applies, and saying so beats resolving a
          //    unit the item does not use.
          if (Object.prototype.hasOwnProperty.call(rows, v)) return rows[v];

          // 2. By spelling, same scope. Reached only when no id was available.
          const k = unitKey(v);
          return (k && rows[k]) || null;
        },

        /** Every unit NAME this item's type offers. For an error message. */
        unitsOf: (itemId) => {
          const tid = String((itemTypes || {})[String(itemId)] || '');
          return ((byTypeList[tid] || []).map((u) => u.name));
        }
      };
    };

    /**
     * A line's unit text reduced to a comparison key.
     *
     * THE CONVERSION RATE IS PART OF THE DISPLAY. A line reads `Each(1)` where
     * the UOM row reads `Each`, and comparing them raw is how every line on an
     * order came back `Blocked - missing parent UUID`.
     */
    function unitKey(v) {
      return String(v === null || v === undefined ? '' : v)
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]/gi, '')
        .toUpperCase();
    }

    const units = {
      TYPE_FIELD: UNITS_TYPE_FIELD,
      typesForItems: unitTypesForItems,
      load: loadUnits,
      key: unitKey
    };

    const config = { get, invalidate, flow };

    return { C, util, lists, config, units };
  });