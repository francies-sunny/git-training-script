/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
/*******************************************************************************
 * TTRX-1: RapidBridge Read API - Transaction List, Transaction Details, Bins
 * ******************************************************************************
 * Date Created : 29 September 2026
 * Author       : Jobin & Jismi IT Services LLP
 *
 * Script Description:
 * This RESTlet is the READ half of NetSuite's Middleware-facing surface in the
 * RapidBridge SuiteApp. Before a warehouse operator can scan anything, the
 * RapidS1 device has to be told WHICH documents they may work on, WHAT is on the
 * one they pick, WHICH bins an item may be put in, and WHAT is in a bin right
 * now. The RapidBridge Middleware asks this script, on the operator's behalf.
 *
 * It is READ ONLY. Nothing here creates or changes a record, and nothing here
 * opens a work item - the answers are what the operator then scans against.
 *
 * A RESTlet is one script and one URL, so the operation is a PARAMETER. get()
 * takes it in the query string, post() takes the identical object as a body -
 * the same contract and the same answers, because a query string has a length
 * limit and cannot nest an array.
 *
 * Functionality:
 * - list_transactions     - which approved, open, already-synchronized documents
 *                           this operator may choose from, filtered by location.
 * - fetch_transaction     - everything needed to scan one of them: the per-line
 *                           serialization flag, remaining quantity, unit, product
 *                           UUID, NDC / GTIN-14 / UPC, and the line_unique_key the
 *                           write API expects back.
 * - allowed_bins_for_item - the bins attached to the item record AND available;
 *                           an empty attachment returns every available bin at
 *                           the location.
 * - fulfilment_exceptions - the reasons the mobile app renders when a pick falls
 *                           short, served from customlist_jj_rb_fulfil_exception.
 * - bins_for_location     - level 1 of the inventory read service: which bins exist.
 * - bin_contents          - level 2: what is stored in a bin.
 * - item_availability     - level 3: how much of one item is there, by lot or serial.
 * - Writes a Sync Log row ONLY on a failure, or when something unexpected is
 *   detected about an answer that succeeded (C.READ_NOTE). A clean read writes
 *   nothing. Any row it does write is closed, under Direction
 *   "Inbound Query (MW - NS read)" and Sync Type "Transaction Fetch" or
 *   "Bin Query", so a scanning operator never appears in a worklist.
 *
 * Trigger Type:
 * - RESTlet. GET and POST. Invoked by the RapidBridge Middleware only.
 * - Deployment customdeploy_jj_rl_rb_read, audience customrole_jj_rapidbridge_integration,
 *   shipped isdeployed = F / isonline = F.
 *
 * Related Files:
 * - Master Scripts/jj_rl_rb_write.js - the WRITE half, where a finished scan is
 *   submitted. It matches a submitted line on the line_unique_key this script returns.
 * - Common/jj_rb_core.js, Common/jj_rb_io.js
 *
 * Reference:
 * - Transaction Developer Guide v3.1 §7.8.1
 * - Master Data Developer Guide v3.3 §7.14
 * - Master Data Synchronization Design v1.1 §11-§12
 * - RapidBridge Read RESTlet Contract v1.0
 *
 * ******************************************************************************
 * REVISION HISTORY
 * @version 1.0  29-Sep-2026  Initial build - seven read operations for RapidS1
 *                            scanning and bin selection
 *
 * COPYRIGHT © 2024 Jobin & Jismi.
 * All rights reserved. This script is a proprietary product of Jobin & Jismi IT Services LLP and is protected by copyright
 * law and international treaties. Unauthorized reproduction or distribution of this script, or any portion of it,
 * may result in severe civil and criminal penalties and will be prosecuted to the maximum extent possible under law.
 * ******************************************************************************
 */

/* ============================================================================
 * DESIGN NOTES
 * ============================================================================
 *
 * ---- THE THREE RULES ------------------------------------------------------
 *
 * 1. NOTHING HERE WRITES. Not a record, not a field, not a stamp. The only
 *    thing this script creates is its own Sync Log row. A read service that
 *    quietly wrote something would be a serious defect - Design v1.1 §11.9.
 *    The test harness throws on record.create, record.submitFields and save(),
 *    so this is enforced rather than intended.
 *
 * 2. A CLEAN READ WRITES NO LOG ROW AT ALL. A row is created only when the
 *    read FAILED, or when C.READ_NOTE detected something unexpected about an
 *    answer that otherwise succeeded. A warehouse opens hundreds of scan
 *    sessions a day; a row per browse buries the rows that mean something.
 *
 *    When a row IS written it still CLOSES on the spot, under Direction
 *    "Inbound Query (MW - NS read)" and status "Closed - No Action Needed",
 *    so a read never opens a work item - Design v1.1 §11.12.
 *
 * 3. EVERY LIST IS CAPPED at C.READ_PAGE.MAX. A large location must not be able
 *    to return an unbounded list, and a RESTlet that runs out of governance
 *    answers with a NetSuite error envelope the Middleware cannot branch on.
 *
 * ---- WHY THIS IS A SEPARATE SCRIPT FROM jj_rl_rb_write.js -------------------
 *
 * They share a body shape and nothing else.
 *
 *   A write is rare, creates a record, must never be repeated by accident, and
 *   every failure of it is somebody's work item.
 *
 *   A read is constant, creates nothing, is SAFE to repeat, and a failure of it
 *   is a failed lookup the operator retries.
 *
 * One file would have meant one governance budget, one deployment, one role
 * audience and one logging posture for two things that want four different
 * ones. The split is also how the read can be given to a scanning role without
 * giving that role the ability to create an Item Receipt.
 *
 * ---- THE LINE KEY ---------------------------------------------------------
 *
 * `line_unique_key` is the `orderline` field of the receipt or fulfilment the
 * order transforms into - exactly what jj_rl_rb_write.js matches a submitted line
 * on. So fetch_transaction TRANSFORMS the order (read-only, never saved) and
 * reads the keys off the transformed document rather than counting the order's
 * lines. A counted key is right until an order has a closed line, a drop-ship
 * line or a line the receipt does not carry, and then it is wrong in a way that
 * surfaces as LINE_NOT_ON_ORDER after the goods are on the dock.
 * ============================================================================
 */
define(['N/record', 'N/search', 'N/runtime',
  '../Common/jj_rb_core', '../Common/jj_rb_io'],
  (record, search, runtime, core, io) => {

    const { C, util, config } = core;
    const { logIo } = io;

    // ═══════════════════════════════════════════════════════════════════════════
    // The dispatch table
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * One row per read. `syncType` is what the Sync Log is filtered by, and
     * the two values are not interchangeable: a warehouse asking "why is that
     * bin empty" and one asking "why can the operator not see that PO" are two
     * different searches, so they are two different types.
     */
    const READS = Object.freeze({
      [C.INBOUND.TXN_LIST]: { key: 'LIST', syncType: C.SYNCTYPE.TXN_FETCH, fn: 'listTransactions' },
      [C.INBOUND.TXN_FETCH]: { key: 'FETCH', syncType: C.SYNCTYPE.TXN_FETCH, fn: 'fetchTransaction' },
      [C.INBOUND.EXC_REASONS]: { key: 'EXC', syncType: C.SYNCTYPE.TXN_FETCH, fn: 'fulfilmentExceptions' },
      [C.INBOUND.ALLOWED_BINS]: { key: 'ABIN', syncType: C.SYNCTYPE.BIN_QUERY, fn: 'allowedBinsForItem' },
      [C.INBOUND.BINS_FOR_LOCATION]: { key: 'BINS', syncType: C.SYNCTYPE.BIN_QUERY, fn: 'binsForLocation' },
      [C.INBOUND.BIN_CONTENTS]: { key: 'BINC', syncType: C.SYNCTYPE.BIN_QUERY, fn: 'binContents' },
      [C.INBOUND.ITEM_AVAILABILITY]: { key: 'AVAIL', syncType: C.SYNCTYPE.BIN_QUERY, fn: 'itemAvailability' }
    });

    /**
     * The transaction types a scan can be run against. The record type, the
     * document it becomes, and the TXNMAP row that owns its statuses.
     *
     * DERIVED FROM C.TXNMAP, not repeated from it. A Phase 2 type appears here
     * the moment its TXNMAP row turns `implemented: true`, and until then it is
     * answered with NOT_IMPLEMENTED rather than an empty list — an empty list
     * reads as "there is no work", which is a different and much worse answer.
     */
    const SCAN = Object.freeze({
      purchaseorder: {
        alias: ['po', 'purchase', 'purchaseorder', 'purchase_order'],
        // What a scan against it produces, and therefore what the write
        // RESTlet will transform it into. `fetch_transaction` transforms into
        // exactly this to read its line keys — see §THE LINE KEY below.
        toType: 'itemreceipt',
        // The token the destination API spells this type with on a LIST —
        // singular `sale`, plural `purchase`. §6.3.
        listToken: 'purchase',
        bodyToken: 'Purchase'
      },
      salesorder: {
        alias: ['so', 'sales', 'salesorder', 'sales_order'],
        toType: 'itemfulfillment',
        listToken: 'sale',
        bodyToken: 'Sales'
      }
    });

    /** The UOM Detail field ids — the product identity a scanner needs. */
    const U = C.MASTER.customrecord_jj_rb_uom_detail.fields;

    // ═══════════════════════════════════════════════════════════════════════════
    // Envelopes
    // ═══════════════════════════════════════════════════════════════════════════

    const okEnvelope = (o) => Object.assign({ success: true }, o);

    const failEnvelope = (code, message) => ({
      success: false,
      error_code: code,
      error_message: message || code
    });

    const textOf = (v) => {
      if (Array.isArray(v)) return v.length ? (v[0].value || '') : '';
      return (v === undefined || v === null) ? '' : String(v);
    };
    const labelOf = (v) => (Array.isArray(v) && v.length ? (v[0].text || '') : '');

    /** `Amoxicillin 500mg Tablet (715)` — a name a human can act on. §6.1. */
    const named = (name, id) => {
      const n = String(name === null || name === undefined ? '' : name).trim();
      const i = String(id === null || id === undefined ? '' : id).trim();
      if (n && i) return n + ' (' + i + ')';
      return n || i;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Anomalies — the only reason a SUCCESSFUL read writes anything down
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Per-execution. A RESTlet execution serves one call, so this is reset at
     * the top of every dispatch rather than carried between them.
     */
    let NOTES = [];

    /**
     * Record something unexpected about an answer that SUCCEEDED.
     *
     * Not an error — the caller got its answer. These are the cases where the
     * answer is quietly incomplete or quietly wrong, which is the class of
     * thing nobody reports and nobody finds. Each one is also returned to the
     * caller on the envelope, so the Middleware can act on it without waiting
     * for somebody to read a Sync Log.
     */
    const flag = (code, message) => {
      NOTES.push({ code: code, message: message });
      log.audit({ title: 'RB read note ' + code, details: message });
    };

    /** Thrown by a handler to refuse the read with a code the caller branches on. */
    const refuseWith = (code, message) => {
      const e = new Error(message || code);
      e.name = code;
      e.rbRefusal = true;
      return e;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Entry points
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * The documented method — §7.8.1 says GET for all seven. NetSuite hands a
     * GET's query string over as a flat object of strings, so every parameter
     * that is a number or a boolean arrives as text and is coerced below.
     */
    const get = (params) => dispatch(params, 'GET');

    /**
     * The same operations over POST. Not a second contract — the SAME one.
     *
     * It exists because a GET query string has a length limit and no nesting,
     * and `list_transactions` takes a status list. A caller that would have to
     * encode an array into a query string may send the identical body instead.
     * Nothing about the answer differs.
     */
    const post = (body) => dispatch(body, 'POST');

    const dispatch = (raw, method) => {
      const startedAt = Date.now();
      NOTES = [];

      let params = raw;
      try {
        if (typeof raw === 'string') params = raw ? JSON.parse(raw) : {};
      } catch (e) {
        return failEnvelope(C.READ_ERR.MALFORMED_PAYLOAD,
          'The request body is not valid JSON.');
      }
      if (!params || typeof params !== 'object') params = {};

      const operation = String(params.operation || '').trim();

      try {
        const cfg = config.get();
        if (!cfg)
          return failEnvelope(C.READ_ERR.NO_CONFIGURATION,
            'No active RapidBridge Configuration row exists in this account. ' +
            'Exactly one row must have Active ticked and not be inactive.');

        const read = READS[operation];
        if (!read)
          return failEnvelope(C.READ_ERR.UNKNOWN_OPERATION,
            'Unknown operation "' + operation + '". This endpoint accepts: ' +
            Object.keys(READS).join(', ') + '.');

        let out;
        try {
          out = okEnvelope(HANDLERS[read.fn](params, cfg));
        } catch (e) {
          if (e && e.rbRefusal) {
            // A FAILURE. Always logged.
            recordRead(read, params, cfg, startedAt, method, false,
              e.name, e.message);
            return failEnvelope(e.name, e.message);
          }
          throw e;
        }

        // ── THE ONLY REASON A SUCCESSFUL READ IS WRITTEN DOWN ──────────────
        //    Nothing unexpected happened ⇒ no Sync Log row. A clean browse
        //    leaves no trace, which is the whole point: the rows that survive
        //    are the ones somebody should look at.
        if (NOTES.length) {
          out.notes = NOTES.slice();
          recordRead(read, params, cfg, startedAt, method, true,
            NOTES[0].code, NOTES.map((n) => n.code + ': ' + n.message).join(' | '));
        }
        return out;

      } catch (e) {
        // A RESTlet that throws answers with a NetSuite error envelope the
        // Middleware cannot branch on. Everything comes back as OUR envelope.
        log.error({ title: 'RB read unhandled ' + operation, details: e });
        return failEnvelope(C.READ_ERR.SEARCH_FAILED,
          (e && e.message) ? e.message : String(e));
      }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Logging — rule 2. Every row closes, none of them opens a work item.
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * ONE Sync Log row, closed on the spot.
     *
     * CALLED ONLY on a failure, or when `NOTES` caught something unexpected
     * about an answer that succeeded. A clean read never reaches here — see
     * dispatch. The design documents ask for reads to be logged under their
     * own Sync Type so a polling scanner can be EXCLUDED from the worklists
     * (Design v1.1 §11.12); not writing the row at all reaches the same end
     * more directly, and keeps a warehouse's daily browsing out of the log
     * table entirely.
     *
     * `Closed - No Action Needed` on BOTH paths, so `open` is false on both.
     * A failed read is a failed lookup the operator repeats, not a record that
     * should have reached TrackTrace and did not. Opening a work item for one
     * would put a warehouse's every mistyped bin code on the reconciliation
     * page.
     *
     * An ANOMALY row carries `outcome = Success` with a `READ_NOTE` code in
     * the error fields, which is the honest reading: the call worked, and
     * something about the answer wants a human.
     */
    const recordRead = (read, params, cfg, startedAt, method, ok, code, message) => {
      try {
        // The transaction reads can point the log row at the order they were
        // about; the bin reads have no transaction, and a typed List/Record
        // field set to nothing is how a whole log row gets rejected on save.
        const txnId = read.syncType === C.SYNCTYPE.TXN_FETCH
          ? String(params.internal_id || params.transaction_id || '') : '';

        logIo.recordInbound({
          entry: {
            key: read.key, syncType: read.syncType,
            logSubjectField: txnId ? C.LOG.transaction : null, fields: C.TXN
          },
          unit: {
            recordType: String(params.record_type || read.key),
            recordId: txnId, uomId: null, storedUuid: '', storedPayload: '',
            storedSynced: false, data: {}, subjectDeleted: !txnId,
            uuidField: C.TXN.uuid, payloadField: C.TXN.payload,
            syncedField: C.TXN.synced, lastSyncField: C.TXN.lastSync,
            lastTryField: C.TXN.lastTry, tryResultField: C.TXN.tryResult,
            errorField: C.TXN.error
          },
          cfg: cfg,
          // ── THE TWO VALUES THAT MATTER ───────────────────────────────────
          direction: C.DIRECTION.INBOUND_QUERY,
          status: C.STATUS.CLOSED_NO_ACTION,
          operation: C.OPERATION.QUERY,
          outcome: ok ? C.OUTCOME.SUCCESS : C.OUTCOME.FAILURE,
          trigger: C.TRIGGER.INBOUND_CALL,
          endpoint: method + ' ' + (params.operation || ''),
          method: method,
          httpStatus: ok ? 200 : 400,
          startedAt: startedAt,
          request: params,
          errorClass: ok ? null : C.ERRCLASS.BUSINESS,
          errorCode: code || null,
          errorMessage: message || null,
          suggested: ok
            ? 'The read returned an answer. Something about that answer is '
            + 'unexpected and is recorded above; no operator action is '
            + 'implied by this row on its own.'
            : null
        });
      } catch (e) {
        // Losing the log row must not lose the answer.
        log.error({ title: 'RB read log', details: e });
      }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Parameters
    // ═══════════════════════════════════════════════════════════════════════════

    /** A GET delivers everything as text. `"false"` is not false in JavaScript. */
    const flagOf = (v, dflt) => {
      if (v === undefined || v === null || v === '') return dflt;
      const s = String(v).trim().toLowerCase();
      if (s === 'false' || s === 'f' || s === '0' || s === 'no') return false;
      if (s === 'true' || s === 't' || s === '1' || s === 'yes') return true;
      return dflt;
    };

    /** A list parameter, however the caller chose to send it. */
    const listOf = (v) => {
      if (v === undefined || v === null || v === '') return [];
      if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x);
      return String(v).split(',').map((x) => x.trim()).filter((x) => x);
    };

    const required = (params, name) => {
      const v = params[name];
      if (v === undefined || v === null || String(v).trim() === '')
        throw refuseWith(C.READ_ERR.MISSING_PARAMETER,
          'The parameter "' + name + '" is required for operation "' +
          params.operation + '".');
      return String(v).trim();
    };

    /** Capped, always. Rule 3. */
    const pageSize = (params) => {
      const n = Number(params.page_size || params.limit || 0);
      if (!(n > 0)) return C.READ_PAGE.DEFAULT;
      return Math.min(Math.floor(n), C.READ_PAGE.MAX);
    };

    const pageStart = (params) => {
      const n = Number(params.offset !== undefined ? params.offset
        : (Number(params.page || 0) * pageSize(params)));
      return (n > 0) ? Math.floor(n) : 0;
    };

    /** The SCAN row a caller's type names, whatever spelling arrived. */
    const scanFor = (raw) => {
      const want = String(raw || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
      if (!want) return null;
      const keys = Object.keys(SCAN);
      for (let i = 0; i < keys.length; i++) {
        if (SCAN[keys[i]].alias.indexOf(want) !== -1)
          return Object.assign({ recordType: keys[i] }, SCAN[keys[i]]);
      }
      return null;
    };

    /**
     * The record type for a read, refusing clearly rather than returning
     * nothing. A Phase 2 type that TXNMAP has not implemented is NOT a
     * scannable type, and saying so is the whole point — an empty list reads
     * as "no work today".
     */
    const scanTypeOrRefuse = (params) => {
      const raw = params.record_type || params.transaction_type || params.type;
      const s = scanFor(raw);
      if (!s) {
        const entry = raw ? C.TXNMAP[String(raw).trim().toLowerCase()] : null;
        if (entry && entry.implemented === false)
          throw refuseWith(C.READ_ERR.NOT_IMPLEMENTED,
            'Transaction type "' + raw + '" is a Phase 2 flow and cannot be ' +
            'scanned yet.');
        throw refuseWith(C.READ_ERR.UNKNOWN_RECORD_TYPE,
          'Unknown transaction type "' + (raw || '') + '". This endpoint ' +
          'scans: ' + Object.keys(SCAN).join(', ') + '.');
      }
      return s;
    };

    /**
     * §7.8.1 — the operator's own location.
     *
     * THE MIDDLEWARE IS THE AUTHORITY, not NetSuite. The employee flow (Master
     * Data Guide v3.3 §10.8) exists precisely so the Middleware knows which
     * warehouse a RapidS1 login belongs to; this RESTlet is called under the
     * INTEGRATION's credentials, not the operator's, so `getCurrentUser()` is
     * a service account whose location means nothing about who is scanning.
     *
     * So: the parameter wins. The current user's location is a fallback for an
     * account that issues a token per operator, and it is a fallback rather
     * than a default because getting it wrong shows an operator another
     * warehouse's orders.
     *
     * NOT SUPPLIED AND NOT DERIVABLE ⇒ no filter, and the response SAYS SO in
     * `location_filter`. Silently returning every warehouse's work while the
     * caller believes it is filtered is the failure mode worth spending a
     * response field on.
     */
    const locationFilter = (params) => {
      const given = String(params.location || params.location_id || '').trim();
      if (given) return { id: given, source: 'parameter' };
      try {
        const u = runtime.getCurrentUser();
        const loc = u && u.location ? String(u.location) : '';
        if (loc && loc !== '0') return { id: loc, source: 'current_user' };
      } catch (e) { /* no user context */ }
      return { id: '', source: 'none' };
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // 1 — list_transactions
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Which documents may this operator choose from.
     *
     * ── THE FOUR EXCLUSIONS, §7.8.1 ────────────────────────────────────────
     *
     * | Excluded | How |
     * |---|---|
     * | Not at its status gate | `status anyof` the sync:true refs of TXN_STATUS |
     * | **`custbody_jj_rb_uuid` is empty** | `isnotempty` — see below |
     * | Closed, cancelled, fully processed | closed lines out, zero-remaining lines out |
     * | Outside the operator's location | the line's location |
     *
     * THE UUID FILTER IS THE ONE THAT MATTERS. An order approved before the
     * integration was switched on was never sent (§1.5.4), so TrackTrace has
     * nothing to scan against. Leave it in the list and the operator picks it,
     * scans a full pallet, and the submission fails at the record level with
     * everything already counted. §7.8.1 calls this out as the filter that is
     * easy to forget and produces the worst symptom, and it is checked again
     * on the write side — but by then the operator has done the work.
     *
     * ── WHY THIS SEARCHES LINES AND GROUPS, RATHER THAN `mainline is T` ────
     *
     * Two reasons, and both are correctness rather than taste:
     *
     *   LOCATION. On a sales order the location can live on the line, and on a
     *   mainline-only search a line-level-location account has a blank body
     *   location — so a body-level location filter drops every order it should
     *   have returned. NetSuite copies a body location down to the lines, so
     *   filtering the LINE catches both arrangements and neither misses.
     *
     *   REMAINING QUANTITY. "Fully processed" is a line fact, not a header
     *   one. A purchase order every line of which has been received sits at
     *   `Pending Bill` — which is sync:true, because an edit to it must still
     *   reach TrackTrace — and has nothing left to receive. Only the lines know
     *   that.
     *
     * The grouped columns collapse it back to one row per order.
     */
    const listTransactions = (params, cfg) => {
      const s = scanTypeOrRefuse(params);
      const size = pageSize(params);
      const start = pageStart(params);
      const loc = locationFilter(params);

      // The statuses this type may be scanned in. Taken from the platform's
      // own table, so nothing here can drift out of step with what the
      // outbound gate allows.
      const rows = (C.TXN_STATUS[s.recordType] || []).filter((r) => r.sync && r.ref);
      const wanted = listOf(params.status);
      const allowed = wanted.length
        ? rows.filter((r) => wanted.some((w) => {
          const hit = util.statusEntry(s.recordType, w);
          return hit && hit.id === r.id;
        }))
        : rows;

      if (!allowed.length)
        throw refuseWith(C.READ_ERR.MISSING_PARAMETER,
          'None of the requested statuses (' + wanted.join(', ') + ') is a ' +
          'status a ' + s.recordType + ' can be scanned in. The scannable ' +
          'ones are: ' + util.syncStatusNames(s.recordType).join(', ') + '.');

      const filters = [
        ['type', 'anyof', s.recordType === 'salesorder' ? 'SalesOrd' : 'PurchOrd'],
        'AND', ['mainline', 'is', 'F'],
        'AND', ['taxline', 'is', 'F'],
        'AND', ['shipping', 'is', 'F'],
        'AND', ['cogs', 'is', 'F'],
        'AND', ['status', 'anyof', allowed.map((r) => r.ref)],
        // THE ONE THAT MATTERS.
        'AND', [C.TXN.uuid, 'isnotempty', ''],
        // A line the buyer closed by hand is not work.
        'AND', ['closed', 'is', 'F'],
        // Nothing left on this line ⇒ nothing to scan against it.
        'AND', ['formulanumeric: CASE WHEN NVL({quantity},0) - ' +
          'NVL({quantityshiprecv},0) > 0 THEN 1 ELSE 0 END', 'equalto', 1]
      ];
      if (loc.id) filters.push('AND', ['location', 'anyof', loc.id]);

      // An order with no serialized line was never sent, so the UUID filter
      // has already removed it. A MIXED order stays, and must: its
      // non-serialized lines are still received in NetSuite on the same
      // document. `fetch_transaction` marks them per line.
      if (flagOf(params.serialized_only, false))
        filters.push('AND', [C.LINE.serialized, 'is', 'T']);

      const G = (name, join) => search.createColumn(
        join ? { name: name, join: join, summary: search.Summary.GROUP }
          : { name: name, summary: search.Summary.GROUP });

      let res;
      try {
        res = search.create({
          type: s.recordType,
          filters: filters,
          columns: [
            search.createColumn({
              name: 'trandate', summary: search.Summary.GROUP,
              sort: search.Sort.ASC
            }),
            G('internalid'), G('tranid'), G('statusref'), G('entity'),
            G('location'), G('subsidiary'), G(C.TXN.uuid), G(C.TXN.shipmentUuid),
            search.createColumn({ name: 'internalid', summary: search.Summary.COUNT })
          ]
        }).run().getRange({ start: start, end: start + size });
      } catch (e) {
        throw refuseWith(C.READ_ERR.SEARCH_FAILED,
          'The transaction list could not be read: ' +
          ((e && e.message) || String(e)));
      }

      const out = [];
      res.forEach((r) => {
        const id = r.getValue({ name: 'internalid', summary: search.Summary.GROUP });
        const statusRef = r.getValue({ name: 'statusref', summary: search.Summary.GROUP });
        const row = util.statusEntry(s.recordType, statusRef);
        out.push({
          internal_id: String(id),
          record_type: s.recordType,
          type: s.bodyToken,
          document_number: r.getValue({ name: 'tranid', summary: search.Summary.GROUP }) || '',
          transaction_date: r.getValue({ name: 'trandate', summary: search.Summary.GROUP }) || '',
          status: row ? row.name : String(statusRef || ''),
          status_ref: String(statusRef || ''),
          entity_id: r.getValue({ name: 'entity', summary: search.Summary.GROUP }) || '',
          entity_name: r.getText({ name: 'entity', summary: search.Summary.GROUP }) || '',
          location_id: r.getValue({ name: 'location', summary: search.Summary.GROUP }) || '',
          location_name: r.getText({ name: 'location', summary: search.Summary.GROUP }) || '',
          subsidiary_id: r.getValue({ name: 'subsidiary', summary: search.Summary.GROUP }) || '',
          transaction_uuid: r.getValue({ name: C.TXN.uuid, summary: search.Summary.GROUP }) || '',
          shipment_uuid: r.getValue({ name: C.TXN.shipmentUuid, summary: search.Summary.GROUP }) || '',
          open_lines: Number(r.getValue({ name: 'internalid', summary: search.Summary.COUNT })) || 0
        });
      });

      // §7.8.1 requires the list to be filtered by the operator's location.
      // Unfiltered, it offers every warehouse's work and looks perfectly
      // normal doing it — the one failure mode nobody reports.
      if (!loc.id && out.length)
        flag(C.READ_NOTE.UNFILTERED_LIST,
          'list_transactions returned ' + out.length + ' ' + s.recordType +
          '(s) with NO location filter: no "location" parameter was supplied ' +
          'and the calling user has no location on their employee record. The ' +
          'operator is being offered every warehouse\'s work.');

      return {
        record_type: s.recordType,
        type: s.bodyToken,
        list_token: s.listToken,
        // Whether the list is filtered, and by what. Never left to be assumed.
        location_filter: loc.id ? { id: loc.id, source: loc.source } : null,
        statuses: allowed.map((r) => ({ id: r.id, ref: r.ref, name: r.name })),
        page: { offset: start, size: size, returned: out.length, capped: size >= C.READ_PAGE.MAX },
        // The caller pages until this is false. A count would cost a second
        // search of the same set for a number that is stale by the time it
        // arrives.
        has_more: out.length === size,
        transactions: out
      };
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // 2 — fetch_transaction
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Everything needed to scan against one document.
     *
     * ── THE LINE KEY ───────────────────────────────────────────────────────
     *
     * `line_unique_key` in the response is the value the WRITE RESTlet matches
     * a submitted line on: the `orderline` field of the receipt or fulfilment
     * this order transforms into. So this function TRANSFORMS the order and
     * reads the keys off the transformed document rather than deriving them
     * from the order's own line numbering.
     *
     * That costs one transform. It buys the one property that makes the whole
     * scan work: the key the operator's device sends back is, by construction,
     * a key the write side will find. A key derived by counting lines is right
     * until an order has a closed line, a drop-ship line or a line the receipt
     * does not carry — and then it is wrong in a way that surfaces as
     * LINE_NOT_ON_ORDER after the goods are on the dock.
     *
     * The transform is also what supplies `quantity_remaining`, and it is what
     * decides which lines appear at all: NetSuite omits from a receipt the
     * lines there is nothing left to receive on. Nothing here has to filter.
     *
     * NOTHING IS SAVED. The transformed record is read and discarded.
     *
     * ── CALLED ONCE PER SESSION, NOT TWICE — §7.8.1 ────────────────────────
     * Version 2.0 called it again immediately before submit to detect a change
     * made during scanning. That call is removed: the WRITE handlers validate
     * the submission against the live record, which closes the gap a separate
     * revalidation left open. Nothing can change between a check and a write
     * that are the same operation.
     */
    const fetchTransaction = (params, cfg) => {
      const s = scanTypeOrRefuse(params);
      const orderId = resolveTransactionId(params, s);

      let head;
      try {
        head = search.lookupFields({
          type: s.recordType, id: orderId,
          columns: ['tranid', 'trandate', 'status', 'entity', 'location',
            'subsidiary', 'memo', C.TXN.uuid, C.TXN.shipmentUuid]
        });
      } catch (e) {
        throw refuseWith(C.READ_ERR.TRANSACTION_NOT_FOUND,
          'No ' + s.recordType + ' with internal id ' + orderId + ' exists.');
      }

      const tranid = textOf(head.tranid);
      const statusRow = util.statusEntry(s.recordType, labelOf(head.status) || textOf(head.status));

      // The same three gates the write side applies, applied HERE so an
      // operator is told before scanning rather than after.
      if (statusRow && statusRow.terminal)
        throw refuseWith(C.READ_ERR.TRANSACTION_NOT_SCANNABLE,
          'Order ' + named(tranid, orderId) + ' is ' + statusRow.name +
          ', so nothing further can be received or fulfilled against it.');
      if (!statusRow || !statusRow.sync)
        throw refuseWith(C.READ_ERR.TRANSACTION_NOT_SCANNABLE,
          'Order ' + named(tranid, orderId) + ' is "' +
          (labelOf(head.status) || textOf(head.status) || 'unknown') + '", which ' +
          'is not a status it can be scanned in. The scannable ones are: ' +
          util.syncStatusNames(s.recordType).join(', ') + '.');

      const txnUuid = textOf(head[C.TXN.uuid]);
      if (!txnUuid)
        throw refuseWith(C.READ_ERR.TRANSACTION_NOT_SYNCED,
          'Order ' + named(tranid, orderId) + ' has no TrackTraceRX ' +
          'transaction identifier, so it was never sent and cannot be scanned ' +
          'against. It should not have been offered for selection.');

      // ── THE TRANSFORM. Read-only; never saved.
      let rec;
      try {
        rec = record.transform({
          fromType: s.recordType, fromId: orderId,
          toType: s.toType, isDynamic: false
        });
      } catch (e) {
        throw refuseWith(C.READ_ERR.TRANSACTION_NOT_SCANNABLE,
          'Order ' + named(tranid, orderId) + ' has nothing left to scan: ' +
          ((e && e.message) || String(e)));
      }

      const count = rec.getLineCount({ sublistId: 'item' }) || 0;
      const raw = [];
      const itemIds = [];
      const seen = {};
      for (let i = 0; i < count; i++) {
        const sv = (f) => {
          try { return rec.getSublistValue({ sublistId: 'item', fieldId: f, line: i }); }
          catch (e) { return ''; }
        };
        const st = (f) => {
          try { return rec.getSublistText({ sublistId: 'item', fieldId: f, line: i }); }
          catch (e) { return ''; }
        };
        const itemId = String(sv('item') || '');
        if (!itemId) continue;                  // description / subtotal line
        if (!seen[itemId]) { seen[itemId] = true; itemIds.push(itemId); }
        const qty = Number(sv('quantity')) || 0;
        const rem = Number(sv('quantityremaining'));
        raw.push({
          line_unique_key: String(sv('orderline') || ''),
          item_id: itemId,
          item_name: st('item') || '',
          description: sv('description') || '',
          // The transform defaults `quantity` to what is left, so these agree
          // on a clean order. They are both reported because they disagree on
          // a partially received one, and the device needs the remaining.
          quantity: qty,
          quantity_remaining: (rem > 0 ? rem : qty),
          unit: st('units') || String(sv('units') || ''),
          bin_id: String(sv('binnumbers') || ''),
          location_id: String(sv('location') || '')
        });
      }

      // ── ONE search for the items, ONE for their UOM rows. §17.4 rule 3.
      const items = readItems(itemIds, cfg);
      const uom = readUom(itemIds);

      const lines = raw.map((l) => {
        const info = items[l.item_id] || {};
        const row = uomRowFor(uom, l.item_id, l.unit);
        return {
          line_unique_key: l.line_unique_key,
          item_id: l.item_id,
          item_name: l.item_name || info.name || '',
          description: l.description,
          quantity: l.quantity,
          quantity_remaining: l.quantity_remaining,
          unit: l.unit,
          // ── WHAT THE DEVICE BRANCHES ON ─────────────────────────────────
          // Read from the ITEM through the CONFIGURED eligibility field, not
          // from the line's stamped column. Same source the outbound
          // classification uses, so the two can never disagree; and it stays
          // right in an account that points Eligibility Field ID at its own
          // item field, which a shipped line column cannot follow.
          requires_serialization: info.eligible === true,
          is_serial_tracked: info.isSerial === true,
          is_lot_tracked: info.isLot === true,
          uses_bins: info.useBins === true,
          // The destination's product identity for THIS unit. Empty means the
          // item's UOM row for this unit has not been accepted by the
          // Middleware yet — the device should not scan against it.
          product_uuid: row.uuid,
          product_uuid_missing_reason: row.reason,
          ndc: row.ndc, gtin: row.gtin, upc: row.upc,
          pack_size: row.packSize,
          bin_id: l.bin_id,
          location_id: l.location_id
        };
      });

      const unresolved = lines.filter((l) => l.requires_serialization && !l.product_uuid);

      if (!lines.length)
        flag(C.READ_NOTE.NO_SCANNABLE_LINES,
          'Order ' + named(tranid, orderId) + ' transformed into a ' +
          String(s.toType) + ' with no item line on it. The order was offered ' +
          'for selection and there is nothing on it to scan.');
      else if (unresolved.length)
        flag(C.READ_NOTE.LINES_NOT_SCANNABLE,
          unresolved.length + ' of ' + lines.length + ' line(s) on order ' +
          named(tranid, orderId) + ' require serialization and have no ' +
          'product UUID: ' + unresolved.map((l) =>
            named(l.item_name, l.item_id) + ' [' +
            l.product_uuid_missing_reason.split(':')[0] + ']').join(', ') +
          '. Scanning them would be refused at submit, on the dock.');

      return {
        internal_id: String(orderId),
        record_type: s.recordType,
        type: s.bodyToken,
        creates: String(s.toType),
        document_number: tranid,
        transaction_date: textOf(head.trandate),
        status: statusRow.name,
        status_ref: statusRow.ref || '',
        entity_id: textOf(head.entity),
        entity_name: labelOf(head.entity),
        location_id: textOf(head.location),
        location_name: labelOf(head.location),
        subsidiary_id: textOf(head.subsidiary),
        memo: textOf(head.memo),
        transaction_uuid: txnUuid,
        shipment_uuid: textOf(head[C.TXN.shipmentUuid]),
        // Where a receipt's stock lands before verification — §11.8. The
        // device shows it so the operator is not asked for a bin the account
        // has already decided.
        default_hold_bin: s.recordType === 'purchaseorder'
          ? holdBinFor(textOf(head.location), cfg) : null,
        line_count: lines.length,
        // Named out loud rather than left for the device to work out, because
        // submitting one of these is the failure the operator cannot undo.
        lines_not_scannable: unresolved.map((l) => ({
          line_unique_key: l.line_unique_key,
          item: named(l.item_name, l.item_id),
          reason: l.product_uuid_missing_reason
        })),
        lines: lines
      };
    };

    /** internal_id, or the TrackTrace UUID, or the document number. */
    const resolveTransactionId = (params, s) => {
      const direct = String(params.internal_id || params.transaction_id || '').trim();
      if (direct) return direct;

      const uuid = String(params.transaction_uuid || '').trim();
      const tranid = String(params.document_number || params.tranid || '').trim();
      if (!uuid && !tranid)
        throw refuseWith(C.READ_ERR.MISSING_PARAMETER,
          'One of internal_id, transaction_uuid or document_number is required.');

      let hit = '';
      try {
        search.create({
          type: s.recordType,
          filters: [['mainline', 'is', 'T'], 'AND',
            (uuid ? [C.TXN.uuid, 'is', uuid] : ['tranid', 'is', tranid])],
          columns: ['internalid']
        }).run().each((r) => { hit = String(r.id); return false; });
      } catch (e) {
        throw refuseWith(C.READ_ERR.SEARCH_FAILED,
          'The transaction could not be looked up: ' + ((e && e.message) || String(e)));
      }
      if (!hit)
        throw refuseWith(C.READ_ERR.TRANSACTION_NOT_FOUND,
          'No ' + s.recordType + ' matches ' +
          (uuid ? 'transaction_uuid ' + uuid : 'document number ' + tranid) + '.');
      return hit;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // 3 — allowed_bins_for_item  (26 August Q4)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * The bins an item may be put in, at one location.
     *
     * The agreed behaviour, verbatim from the 26 August answer: show the bins
     * that are (i) attached to the item record and (ii) available; and **if the
     * company does not use item-to-bin attachment, return the entire available
     * list of bins** so the operator can choose any.
     *
     * NetSuite's own item record carries that attachment, per location, on its
     * Bins sublist — so this reads the native structure rather than a custom
     * item-to-bin record, and the fallback falls out of it naturally: no rows
     * means no attachment means return the location's bins.
     *
     * "Available" is the bin not being inactive. A bin marked unavailable
     * disappears from the answer, which is the example the clarification gave.
     */
    const allowedBinsForItem = (params, cfg) => {
      const itemId = required(params, 'item');
      const loc = String(params.location || params.location_id || '').trim();

      if (cfg.useBins !== true)
        return {
          item_id: itemId, location_id: loc || null,
          use_bins: false, source: 'none', bins: [],
          note: 'Bins are switched off on the RapidBridge Configuration ' +
            'record, so no bin is required or accepted on a line.'
        };

      const bins = [];
      try {
        // The join id is `binNumber` on BOTH the filters and the columns. A
        // filter that spells it differently from its column is accepted by
        // NetSuite and then silently joins nothing.
        const filters = [['internalid', 'anyof', itemId], 'AND',
          ['binNumber.isinactive', 'is', 'F']];
        if (loc) filters.push('AND', ['binNumber.location', 'anyof', loc]);
        search.create({
          type: 'item',
          filters: filters,
          columns: [
            search.createColumn({ name: 'internalid', join: 'binNumber' }),
            search.createColumn({ name: 'binnumber', join: 'binNumber' }),
            search.createColumn({ name: 'location', join: 'binNumber' }),
            search.createColumn({ name: 'preferredbin', join: 'binNumber' })
          ]
        }).run().each((r) => {
          const id = String(r.getValue({ name: 'internalid', join: 'binNumber' }) || '');
          if (!id) return true;
          bins.push({
            bin_id: id,
            bin_number: r.getValue({ name: 'binnumber', join: 'binNumber' }) || '',
            location_id: String(r.getValue({ name: 'location', join: 'binNumber' }) || ''),
            location_name: r.getText({ name: 'location', join: 'binNumber' }) || '',
            preferred: util.truthy(r.getValue({ name: 'preferredbin', join: 'binNumber' }))
          });
          return bins.length < C.READ_PAGE.MAX;
        });
      } catch (e) {
        // The Bins sublist is only present when the Bin feature is on. An
        // account that has it off answers with the location's list, which is
        // the documented fallback rather than an error.
        flag(C.READ_NOTE.DEGRADED_READ,
          'The item-to-bin attachment could not be read for item ' + itemId +
          ' (' + ((e && e.message) || String(e)) + '). Falling back to every ' +
          'available bin at the location, which is wider than the item allows.');
      }

      if (bins.length)
        return {
          item_id: itemId, location_id: loc || null, use_bins: true,
          source: 'item', bins: bins
        };

      // THE FALLBACK. No attachment ⇒ every available bin at the location.
      if (!loc)
        throw refuseWith(C.READ_ERR.MISSING_PARAMETER,
          'Item ' + itemId + ' has no bins attached to it, so the answer is ' +
          'every available bin at the location — and no location was given.');

      const all = binsForLocation({ operation: params.operation, location: loc }, cfg);
      return {
        item_id: itemId, location_id: loc, use_bins: true,
        source: 'location', bins: all.bins,
        note: 'This item has no bins attached to it, so every available bin ' +
          'at the location is offered.'
      };
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // 4 — fulfilment_exceptions  (7 September Q1)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * The reasons the mobile app renders when a pick falls short.
     *
     * Served from `customlist_jj_rb_fulfil_exception` — the SAME list the write
     * RESTlet writes into `custcol_jj_rb_exception_reason`, which is the only
     * reason this endpoint exists at all. Hardcoding the reasons in the app
     * would let a client add a reason on the list and never see it offered,
     * or worse, let the app send one the column will not accept.
     */
    const fulfilmentExceptions = () => {
      const out = [];
      try {
        search.create({
          type: C.REC.FULFIL_EXCEPTION,
          filters: [['isinactive', 'is', 'F']],
          columns: ['internalid', 'name']
        }).run().each((r) => {
          out.push({ id: String(r.getValue('internalid')), name: r.getValue('name') });
          return out.length < C.READ_PAGE.MAX;
        });
      } catch (e) {
        throw refuseWith(C.READ_ERR.SEARCH_FAILED,
          'The fulfilment exception list could not be read: ' +
          ((e && e.message) || String(e)));
      }
      return {
        list_id: C.REC.FULFIL_EXCEPTION,
        // The app sends `name`, not `id`: the write RESTlet sets the column by
        // TEXT (`setCurrentSublistText`), so the name is the contract and an
        // internal id from one account is meaningless in another.
        submit_as: 'name',
        count: out.length,
        exception_reasons: out
      };
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // 5, 6, 7 — the three levels, Design v1.1 §12.5
    // ═══════════════════════════════════════════════════════════════════════════

    /** Level 1 — which bins exist at a location. */
    const binsForLocation = (params, cfg) => {
      const loc = required(params, 'location');
      const includeInactive = flagOf(params.include_inactive, false);

      if (cfg.useBins !== true)
        return {
          location_id: loc, use_bins: false, count: 0, bins: [],
          // T-22 — what the service returns for an account with no bins. An
          // empty list and a flag, never an error: the operator can still
          // scan, they just make no bin selection.
          note: 'This account does not use bins. Quantities are held at the ' +
            'location and no bin selection is required.'
        };

      const B = C.MASTER.bin.fields;
      const filters = [['location', 'anyof', loc]];
      if (!includeInactive) filters.push('AND', ['isinactive', 'is', 'F']);

      const bins = [];
      try {
        search.create({
          type: 'bin', filters: filters,
          columns: ['internalid', 'binnumber', 'location', 'isinactive',
            'memo', B.uuid]
        }).run().each((r) => {
          bins.push({
            bin_id: String(r.id),
            bin_number: r.getValue('binnumber') || '',
            location_id: String(r.getValue('location') || ''),
            location_name: r.getText('location') || '',
            description: r.getValue('memo') || '',
            available: !util.truthy(r.getValue('isinactive')),
            bin_uuid: r.getValue(B.uuid) || ''
          });
          return bins.length < C.READ_PAGE.MAX;
        });
      } catch (e) {
        throw refuseWith(C.READ_ERR.SEARCH_FAILED,
          'The bins at location ' + loc + ' could not be read: ' +
          ((e && e.message) || String(e)));
      }
      if (bins.length >= C.READ_PAGE.MAX)
        flag(C.READ_NOTE.RESULT_TRUNCATED,
          'Location ' + loc + ' has at least ' + C.READ_PAGE.MAX + ' bins and ' +
          'the list was cut off at that cap. The operator is choosing from a ' +
          'truncated list and cannot tell.');
      return {
        location_id: loc, use_bins: true, count: bins.length,
        capped: bins.length >= C.READ_PAGE.MAX, bins: bins
      };
    };

    /** Level 2 — what is stored in a bin. */
    const binContents = (params, cfg) => {
      const loc = required(params, 'location');
      const bin = String(params.bin || params.bin_id || '').trim();
      if (!bin && cfg.useBins === true)
        throw refuseWith(C.READ_ERR.MISSING_PARAMETER,
          'The parameter "bin" is required. This account uses bins, so ' +
          'a location alone does not name a storage place.');

      const rows = inventoryRows(loc, bin, '', 'item');
      if (rows.length >= C.READ_PAGE.MAX)
        flag(C.READ_NOTE.RESULT_TRUNCATED,
          'Bin ' + (bin || loc) + ' holds at least ' + C.READ_PAGE.MAX +
          ' distinct items and the list was cut off at that cap.');
      return {
        location_id: loc, bin_id: bin || null,
        use_bins: cfg.useBins === true,
        count: rows.length, capped: rows.length >= C.READ_PAGE.MAX,
        items: rows
      };
    };

    /** Level 3 — how much of one item is there, by lot or by serial. */
    const itemAvailability = (params, cfg) => {
      const loc = required(params, 'location');
      const itemId = required(params, 'item');
      const bin = String(params.bin || params.bin_id || '').trim();

      const rows = inventoryRows(loc, bin, itemId, 'number');
      if (rows.length >= C.READ_PAGE.MAX)
        flag(C.READ_NOTE.RESULT_TRUNCATED,
          'Item ' + itemId + ' has at least ' + C.READ_PAGE.MAX + ' lot or ' +
          'serial rows at this location and the list was cut off at that cap. ' +
          'THE TOTAL BELOW IS THEREFORE A FLOOR, NOT THE TRUE AVAILABILITY.');

      let total = 0;
      let onHand = 0;
      rows.forEach((r) => { total += r.available_quantity; onHand += r.on_hand_quantity; });

      const items = readItems([itemId], cfg);
      const info = items[itemId] || {};
      // A serial-controlled item returns individual serial numbers where a lot
      // item returns lots — Design v1.1 §12.7. One shape, named honestly.
      const kind = info.isSerial ? 'serial' : (info.isLot ? 'lot' : 'none');

      const out = {
        location_id: loc, bin_id: bin || null, item_id: itemId,
        item_name: info.name || '',
        use_bins: cfg.useBins === true,
        tracking: kind,
        available_quantity: total,
        on_hand_quantity: onHand,
        count: rows.length, capped: rows.length >= C.READ_PAGE.MAX
      };
      // The key the device reads is named after what it holds, so a serial is
      // never mistaken for a lot on the other side of the integration.
      if (kind === 'serial') out.serials = rows;
      else if (kind === 'lot') out.lots = rows;
      else out.balances = rows;
      return out;
    };

    /**
     * The inventory read behind levels 2 and 3.
     *
     * `inventorybalance` is the one search that is bin-aware AND lot/serial
     * aware, which is exactly the shape the three levels need. Reading the item
     * record's own quantity fields would answer level 3 at the location and
     * could not answer level 2 at all.
     *
     * @param groupBy 'item'   one row per item — level 2
     *                'number' one row per lot or serial — level 3
     */
    const inventoryRows = (locationId, binId, itemId, groupBy) => {
      const filters = [['location', 'anyof', locationId]];
      if (binId) filters.push('AND', ['binnumber', 'anyof', binId]);
      if (itemId) filters.push('AND', ['item', 'anyof', itemId]);

      const S = search.Summary;
      const columns = groupBy === 'item'
        ? [
          search.createColumn({ name: 'item', summary: S.GROUP, sort: search.Sort.ASC }),
          search.createColumn({ name: 'binnumber', summary: S.GROUP }),
          search.createColumn({ name: 'available', summary: S.SUM }),
          search.createColumn({ name: 'onhand', summary: S.SUM })
        ]
        : [
          search.createColumn({ name: 'inventorynumber', summary: S.GROUP, sort: search.Sort.ASC }),
          search.createColumn({ name: 'binnumber', summary: S.GROUP }),
          search.createColumn({ name: 'item', summary: S.GROUP }),
          search.createColumn({ name: 'available', summary: S.SUM }),
          search.createColumn({ name: 'onhand', summary: S.SUM })
        ];

      let res;
      try {
        res = search.create({
          type: 'inventorybalance', filters: filters, columns: columns
        }).run().getRange({ start: 0, end: C.READ_PAGE.MAX });
      } catch (e) {
        throw refuseWith(C.READ_ERR.SEARCH_FAILED,
          'Inventory could not be read for location ' + locationId +
          (binId ? ', bin ' + binId : '') + ': ' + ((e && e.message) || String(e)));
      }

      return res.map((r) => {
        const row = {
          bin_id: String(r.getValue({ name: 'binnumber', summary: S.GROUP }) || ''),
          bin_number: r.getText({ name: 'binnumber', summary: S.GROUP }) || '',
          available_quantity: Number(r.getValue({ name: 'available', summary: S.SUM })) || 0,
          on_hand_quantity: Number(r.getValue({ name: 'onhand', summary: S.SUM })) || 0
        };
        row.item_id = String(r.getValue({ name: 'item', summary: S.GROUP }) || '');
        row.item_name = r.getText({ name: 'item', summary: S.GROUP }) || '';
        if (groupBy === 'number') {
          row.number_id = String(r.getValue({ name: 'inventorynumber', summary: S.GROUP }) || '');
          row.number = r.getText({ name: 'inventorynumber', summary: S.GROUP }) || '';
        }
        return row;
      });
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Shared reads
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Tracking, bins, and TRACKTRACE ELIGIBILITY for a set of items — ONE
     * search.
     *
     * Eligibility is read through the CONFIGURED field id, exactly as the
     * outbound classification does, so an account pointing Eligibility Field ID
     * at its own item field gets the same answer from both sides of the
     * integration. A field the account never deployed is not fatal here: it
     * leaves `eligible` undefined, and the line is reported as not requiring
     * serialization rather than the whole read failing.
     */
    const readItems = (ids, cfg) => {
      const out = {};
      if (!ids || !ids.length) return out;
      const eligField = (cfg && cfg.eligField) || 'custitem_jj_rb_eligible';

      const run = (withElig) => {
        const columns = ['itemid', 'displayname', 'isinactive', 'islotitem',
          'isserialitem', 'usebins'];
        if (withElig) columns.push(eligField);
        search.create({
          type: 'item',
          filters: [['internalid', 'anyof', ids]],
          columns: columns
        }).run().each((r) => {
          out[String(r.id)] = {
            name: r.getValue('itemid'),
            display_name: r.getValue('displayname'),
            inactive: util.truthy(r.getValue('isinactive')),
            isLot: util.truthy(r.getValue('islotitem')),
            isSerial: util.truthy(r.getValue('isserialitem')),
            useBins: util.truthy(r.getValue('usebins')),
            eligible: withElig
              ? eligibleValue(r.getText(eligField) || r.getValue(eligField))
              : undefined
          };
          return true;
        });
      };

      try { run(true); }
      catch (e) {
        // The Eligibility Field is configurable free text, so a typo or a
        // field the account never deployed lands here. NOT fatal — but every
        // line then reads requires_serialization: false, which is a silently
        // wrong answer and exactly what a note exists for.
        flag(C.READ_NOTE.DEGRADED_READ,
          'The configured Eligibility Field "' + eligField + '" could not be ' +
          'read (' + ((e && e.message) || String(e)) + '). Every line is ' +
          'reported as NOT requiring serialization. Check the Eligibility ' +
          'Field ID on the RapidBridge Configuration record.');
        try { run(false); } catch (e2) {
          flag(C.READ_NOTE.DEGRADED_READ,
            'The item read failed outright: ' + ((e2 && e2.message) || String(e2)) +
            '. Lines are returned without tracking, bin or serialization detail.');
        }
      }
      return out;
    };

    /**
     * The one true reading of the eligibility field, whatever type it is.
     * A checkbox gives T/F, a list gives its display text. Same rule as the
     * outbound classification — a value it does not recognise is NOT eligible.
     */
    const eligibleValue = (v) => {
      if (v === true) return true;
      const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
      if (!s) return false;
      return s === 't' || s === 'true' || s === 'yes' || s === 'y' || s === '1'
        || s === 'required' || s === 'serialized' || s === 'eligible';
    };

    /** Every UOM Detail row for a set of items — ONE search. */
    const readUom = (ids) => {
      const map = {};
      if (!ids || !ids.length) return map;
      try {
        search.create({
          type: C.REC.UOM,
          filters: [[U.item, 'anyof', ids], 'AND', ['isinactive', 'is', 'F']],
          columns: [U.item, U.unit, U.uuid, U.ndc, U.gtin, U.upc, U.packSize, U.qty]
        }).run().each((r) => {
          const itemId = String(r.getValue(U.item) || '');
          const key = unitKey(r.getText(U.unit) || r.getValue(U.unit));
          if (!itemId || !key) return true;
          if (!map[itemId]) map[itemId] = {};
          map[itemId][key] = {
            uuid: String(r.getValue(U.uuid) || ''),
            ndc: String(r.getValue(U.ndc) || ''),
            gtin: String(r.getValue(U.gtin) || ''),
            upc: String(r.getValue(U.upc) || ''),
            packSize: String(r.getValue(U.packSize) || ''),
            conversion: Number(r.getValue(U.qty)) || null
          };
          return true;
        });
      } catch (e) {
        flag(C.READ_NOTE.DEGRADED_READ,
          'The UOM Detail rows could not be read (' +
          ((e && e.message) || String(e)) + '). Every line is reported with ' +
          'no product UUID, NDC, GTIN or UPC.');
      }
      return map;
    };

    /**
     * A line's unit, reduced to something that matches a UOM Detail row.
     *
     * THE CONVERSION RATE IS PART OF THE LINE'S UNIT TEXT. A line reads
     * `Each(1)` where the UOM row reads `Each`, and comparing them raw is how
     * every line on an order came back `Blocked - missing parent UUID`.
     * Strip the parenthesis, then everything that is not a letter or a digit.
     */
    const unitKey = (v) => String(v === null || v === undefined ? '' : v)
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^a-z0-9]/gi, '')
      .toUpperCase();

    /**
     * The UOM row for one line, and WHY when there is none.
     *
     * A line with no unit at all falls back to the base unit, which proposal
     * v4 §5.2 fixes at Each.
     */
    const uomRowFor = (map, itemId, unitText) => {
      const rows = map[itemId] || {};
      const key = unitKey(unitText) || C.BASE_UNIT;
      const row = rows[key];
      if (!row)
        return {
          uuid: '', ndc: '', gtin: '', upc: '', packSize: '', conversion: null,
          reason: Object.keys(rows).length
            ? 'NO_ROW: the item has no UOM Detail row for unit "' +
            (unitText || C.BASE_UNIT) + '". It has: ' + Object.keys(rows).join(', ')
            : 'NO_ROW: the item has no UOM Detail rows at all.'
        };
      return Object.assign({}, row, {
        reason: row.uuid ? '' :
          'NO_UUID: the UOM Detail row for "' + (unitText || C.BASE_UNIT) +
          '" exists but has not been accepted by the Middleware yet.'
      });
    };

    /**
     * §11.8 — the bin a receipt's stock lands in before verification. The
     * LOCATION's first, the configuration's default second. Read here so the
     * device can show it rather than ask for it.
     */
    const holdBinFor = (locationId, cfg) => {
      if (!locationId) return String((cfg && cfg.defaultBin) || '') || null;
      try {
        const L = C.MASTER.location.fields;
        const v = search.lookupFields({
          type: 'location', id: locationId, columns: [L.holdBin]
        });
        const bin = textOf(v[L.holdBin]);
        if (bin) return bin;
      } catch (e) { /* field not deployed; the default answers */ }
      return String((cfg && cfg.defaultBin) || '') || null;
    };

    // ═══════════════════════════════════════════════════════════════════════════

    const HANDLERS = {
      listTransactions: listTransactions,
      fetchTransaction: fetchTransaction,
      allowedBinsForItem: allowedBinsForItem,
      fulfilmentExceptions: fulfilmentExceptions,
      binsForLocation: binsForLocation,
      binContents: binContents,
      itemAvailability: itemAvailability
    };

    return {
      get: get,
      post: post,
      // Exported for the test harness. Nothing in the SuiteApp calls these.
      // _internals: {
      //   READS, SCAN, scanFor, flagOf, listOf, pageSize, pageStart,
      //   unitKey, uomRowFor, eligibleValue, named, locationFilter,
      //   failEnvelope, okEnvelope, notes: () => NOTES.slice()
      // }
    };
  });
