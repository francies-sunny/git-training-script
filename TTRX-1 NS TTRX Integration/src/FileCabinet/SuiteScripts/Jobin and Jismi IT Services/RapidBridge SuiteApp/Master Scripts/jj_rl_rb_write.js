/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
/*******************************************************************************
 * TTRX-1: RapidBridge Inbound Write API - Item Receipt, Item Fulfilment, Identifier
 * ******************************************************************************
 * Date Created : 29 September 2026
 * Author       : Jobin & Jismi IT Services LLP
 *
 * Script Description:
 * This RESTlet is the WRITE half of NetSuite's Middleware-facing surface in the
 * RapidBridge SuiteApp. A warehouse operator scans goods on a RapidS1 device;
 * the RapidBridge Middleware turns that scan into a NetSuite document by calling
 * this script. Every operation here creates or changes a record. Traffic is
 * one-way, inward - nothing in the SuiteApp ever calls it.
 *
 * A RESTlet is one script and one URL, so the operation is a BODY KEY
 * (body.operation), not a path segment.
 *
 * Functionality:
 * - item_receipt (POST)     - creates an Item Receipt, transformed from the Purchase Order.
 * - item_fulfillment (POST) - creates an Item Fulfilment, transformed from the Sales Order,
 *                             in the configured shipping status.
 * - identifier (PUT)        - call 2 of the two-call protocol: stores the SHIPMENT
 *                             UUID. A receipt has no identifier of its own, and
 *                             one shipment may cover several orders, so several
 *                             documents share it - it is NOT checked for
 *                             uniqueness. request_uuid remains the duplicate guard.
 * - Guards duplicates on the record's native externalId, which the platform
 *   enforces per record type. A repeat submission answers with the record that
 *   already exists, as a SUCCESS.
 * - Lands receipt stock in the location's on-hold bin, falling back to the
 *   configured default bin.
 * - inventory_release (POST) - the last step of a receipt. TrackTrace verifies
 *                             the EPCIS data; the Middleware names the lots that
 *                             passed; this creates a BIN TRANSFER moving exactly
 *                             those out of the on-hold bin into a good bin. The
 *                             lot arrives BY NAME and is resolved against the
 *                             item's own on-hand inventory numbers. Never an
 *                             Inventory Status Change - there is none in this
 *                             SuiteApp.
 *                             Guarded by a RELEASE LEDGER on the receipt
 *                             (custbody_jj_rb_release_log) holding received and
 *                             released per lot, so a retry with a fresh
 *                             request_uuid cannot move the same stock twice.
 * - Rejects the WHOLE submission when any line fails validation, so nothing is
 *   created and a retry can always repair it.
 * - Writes one Sync Log row per call, Direction "Inbound (MW - NS)",
 *   Trigger "Inbound Call". Closed on a clean call; OPEN on a PARTIAL release,
 *   because stock left in the on-hold bin surfaces nowhere else.
 *
 * Trigger Type:
 * - RESTlet. POST and PUT. Invoked by the RapidBridge Middleware only.
 * - Deployment customdeploy_jj_rl_rb_api, audience customrole_jj_rapidbridge_integration,
 *   shipped isdeployed = F / isonline = F.
 *
 * Related Files:
 * - Master Scripts/jj_rl_rb_read.js - the READ half. Supplies the line_unique_key
 *   values this script matches a submitted line on.
 * - Common/jj_rb_core.js, Common/jj_rb_io.js, Common/jj_rb_txn.js
 *
 * Reference:
 * - Transaction Developer Guide v3.1 §7.8.2, §10, §11
 * - RapidBridge Inbound RESTlet Contract v1.0
 *
 * ******************************************************************************
 * REVISION HISTORY
 * @version 1.0  29-Sep-2026  Initial build - inbound write API (item_receipt,
 *                            item_fulfillment, identifier)
 * @version 1.1  05-Oct-2026  inventory_release - the Bin Transfer (§11.6). Lot
 *                            resolved BY NAME against on-hand inventory numbers,
 *                            and the stock must still be in the on-hold bin or
 *                            the release is refused rather than redirected.
 * @version 1.2  05-Oct-2026  THE RELEASE LEDGER. v1.1 could be made to move the
 *                            same lot twice by a retry carrying a fresh
 *                            request_uuid: the externalId guard saw a different
 *                            id, and the on-hold bin's balance is shared between
 *                            receipts and lags behind the index. The receipt now
 *                            carries received-and-released per lot in a Long Text
 *                            JSON field and that is the authority. The Item
 *                            Receipt reference became MANDATORY as a result.
 *
 * COPYRIGHT © 2024 Jobin & Jismi.
 * All rights reserved. This script is a proprietary product of Jobin & Jismi IT Services LLP and is protected by copyright
 * law and international treaties. Unauthorized reproduction or distribution of this script, or any portion of it,
 * may result in severe civil and criminal penalties and will be prosecuted to the maximum extent possible under law.
 * ******************************************************************************
 */

/* ============================================================================
 * DESIGN NOTES - the two rules that govern every line of this file
 * ============================================================================
 *
 * 1. AN INBOUND WRITE IS ALL-OR-NOTHING (§7.8.2). Any line failure rejects the
 *    WHOLE submission and nothing is created. The natural implementation - post
 *    the good lines, report the bad - is the wrong one: it consumes the
 *    request_uuid on a document that is missing a line, so a retry cannot repair
 *    it, and a receipt silently short one line is a discrepancy nothing in this
 *    phase will find. A receipt that does not exist is one nobody can miss.
 *    Design §3.10.4.
 *
 * 2. THE DUPLICATE GUARD IS THE NATIVE externalId (§4.1.2). The Middleware's
 *    request_uuid goes there and NOTHING ELSE tests for a duplicate - the
 *    platform enforces uniqueness per record type, which is atomic and
 *    race-free. A repeat submission is answered with the record that already
 *    exists, and that is a SUCCESS, not an error: it is the expected answer to
 *    a retry.
 *
 * WHERE THE TWO RESTLETS MEET. `line_unique_key` on a submission here is the
 * value `fetch_transaction` returned under that same name - the `orderline`
 * field of the transformed receipt or fulfilment. The read endpoint takes it off
 * a transform for exactly this reason, so the key always round-trips.
 *
 * 3. A RELEASE MOVES STOCK THAT ALREADY EXISTS. `inventory_release` never
 *    creates a lot and never redirects a transfer. A lot name that resolves to
 *    nothing is LOT_NOT_FOUND; stock that is no longer in the on-hold bin is
 *    LOT_NOT_IN_BIN. Both refuse. Guessing where the stock went is how a
 *    regulated product is released from a bin nobody verified - Design §9.4.
 *
 * 4. THE RECEIPT'S LEDGER IS THE AUTHORITY ON WHAT MAY STILL MOVE. Rule 2's
 *    externalId guard answers "is this the SAME call again?". It does not
 *    answer "has this stock already been released?", and those are different
 *    questions the moment a retry carries a fresh request_uuid. The on-hold
 *    bin cannot answer the second one either: several receipts share it, so
 *    its balance is not this receipt's, and it is a search index that lags.
 *    `custbody_jj_rb_release_log` holds received and released PER LOT for the
 *    receipt, it is written in the same breath as the transfer, and every
 *    release is measured against it. Without it the release is refused.
 *
 * `inventory_adjustment` is OUT OF SCOPE (§1.5.3) and must not be added.
 *
 * ON THE NAME. `_api` distinguishes nothing now that there are two RESTlets -
 * both are APIs. Master Data Guide v3.3 §7.14 named it `_api` rather than
 * `_bins` BECAUSE it expected one script to hold the bin reads and the receipt
 * writes together; this build split them, so that reasoning no longer applies
 * and `jj_rl_rb_write.js` would say what the file does. The rename is free
 * while the deployment is isdeployed = F and costs a reissued URL afterwards.
 * ============================================================================
 */
define(['N/record', 'N/search', 'N/format', 'N/runtime',
  '../Common/jj_rb_core', '../Common/jj_rb_io', '../Common/jj_rb_txn'],
  (record, search, format, runtime, core, io, txn) => {

    const { C, util, config } = core;
    const { logIo } = io;

    // ═══════════════════════════════════════════════════════════════════════════
    // The dispatch table
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * One row per inbound write. Everything that differs between an Item
     * Receipt and an Item Fulfilment is here; the handler below reads it and
     * knows nothing about either.
     */
    const INBOUND_MAP = Object.freeze({
      [C.INBOUND.IR_CREATE]: {
        key: 'IR',
        syncType: C.SYNCTYPE.ITEM_RECEIPT,
        recordType: 'itemreceipt',
        fromType: 'purchaseorder',
        flowKey: 'irEnabled',
        // The column that says "this order line is on this document". Both
        // spellings are set: `itemreceive` is the one NetSuite uses on a
        // receipt AND on a fulfilment, but accounts differ, and a setter that
        // finds no such field is a no-op rather than an error.
        applyFields: ['itemreceive'],
        // Inbound inventory detail names the number being RECEIVED.
        inventoryField: 'receiptinventorynumber',
        // §11.8 — every line of a receipt lands in the location's on-hold bin
        // until verification passes. The payload may name one instead.
        usesHoldBin: true,
        needsShipStatus: false
      },
      [C.INBOUND.IF_CREATE]: {
        key: 'IF',
        syncType: C.SYNCTYPE.ITEM_FULFILMENT,
        recordType: 'itemfulfillment',
        fromType: 'salesorder',
        flowKey: 'ifEnabled',
        applyFields: ['itemreceive', 'itemfulfill'],
        // Outbound inventory detail names the number being ISSUED.
        inventoryField: 'issueinventorynumber',
        usesHoldBin: false,
        // §10.6 — Picked, Packed or Shipped, from the configuration, and set
        // BEFORE the lines.
        needsShipStatus: true
      }
    });

    /** The seven-field bundle. The same ids the outbound path writes. */
    const TXN = C.TXN;

    /** A dispatch entry the Sync Log writer understands. */
    const logEntry = (map) => ({
      key: map.key, syncType: map.syncType,
      logSubjectField: C.LOG.transaction, fields: TXN
    });

    /** The stamp/subject target for one inbound document. */
    const unitFor = (map, recordId, uuid) => ({
      recordType: String(map.recordType), recordId: recordId || '',
      uomId: null, storedUuid: uuid || '', storedPayload: '', storedSynced: false,
      data: {},
      // Before the record exists there is nothing to point a typed List/Record
      // field at, and NetSuite rejects the whole log row for one bad value.
      subjectDeleted: !recordId,
      uuidField: TXN.uuid, payloadField: TXN.payload, syncedField: TXN.synced,
      lastSyncField: TXN.lastSync, lastTryField: TXN.lastTry,
      tryResultField: TXN.tryResult, errorField: TXN.error
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // The envelope — proposal v4 §7.4
    // ═══════════════════════════════════════════════════════════════════════════

    const okEnvelope = (o) => Object.assign({ success: true }, o);

    /**
     * A failure envelope. `failed_lines` is present ONLY on a line failure and
     * carries every line that failed, never the first one: an operator who
     * fixes one bin and is then told about a second has made two trips to the
     * dock. §7.8.2 point 1.
     */
    const failEnvelope = (code, message, failedLines) => {
      const out = {
        success: false,
        error_code: code,
        error_message: message || code
      };
      if (failedLines && failedLines.length) out.failed_lines = failedLines;
      return out;
    };

    const textOf = (v) => {
      if (Array.isArray(v)) return v.length ? (v[0].value || '') : '';
      return (v === undefined || v === null) ? '' : String(v);
    };
    const labelOf = (v) => (Array.isArray(v) && v.length ? (v[0].text || '') : '');

    // ═══════════════════════════════════════════════════════════════════════════
    // Entry points
    // ═══════════════════════════════════════════════════════════════════════════

    /** Creates. `operation` names which. */
    const post = (body) => dispatch(body, 'POST');

    /** Call 2 of the two-call protocol — §11.4. */
    const put = (body) => dispatch(body, 'PUT');

    const dispatch = (raw, method) => {
      const startedAt = Date.now();
      let body = raw;
      try {
        if (typeof raw === 'string') body = JSON.parse(raw);
      } catch (e) {
        log.error({ title: 'RB-WRITE-001 dispatch', details: (e && e.message) || String(e) });
        return failEnvelope(C.DOC_ERR.MALFORMED_PAYLOAD,
          'The request body is not valid JSON.');
      }
      if (!body || typeof body !== 'object')
        return failEnvelope(C.DOC_ERR.MALFORMED_PAYLOAD,
          'The request body is empty.');

      const operation = String(body.operation || '').trim();

      log.audit({
        title: 'RB inbound ' + method + ' ' + (operation || '(none)'),
        details: {
          request_uuid: body.request_uuid || null,
          order_id: body.order_id || null,
          lines: Array.isArray(body.lines) ? body.lines.length : null
        }
      });

      try {
        const cfg = config.get();
        if (!cfg) {
          log.audit({
            title: 'RB no active configuration row',
            details: 'Exactly one RapidBridge Configuration row must have ' +
              'Active ticked and not be inactive. Nothing inbound is accepted ' +
              'until it does.'
          });
          return failEnvelope(C.DOC_ERR.NO_CONFIGURATION,
            'No active RapidBridge Configuration row exists in this account.');
        }

        if (operation === C.INBOUND.IDENTIFIER)
          return storeIdentifier(body, cfg, startedAt);

        // §11.6 — the last step of a receipt. It creates a Bin Transfer, not
        // a document transformed from an order, so it is NOT in INBOUND_MAP:
        // nothing in that table describes it.
        if (operation === C.INBOUND.INV_RELEASE)
          return releaseInventory(body, cfg, startedAt);

        const map = INBOUND_MAP[operation];
        if (!map)
          return failEnvelope(C.DOC_ERR.UNKNOWN_OPERATION,
            'Unknown operation "' + operation + '". This endpoint accepts: ' +
            Object.keys(INBOUND_MAP)
              .concat([C.INBOUND.IDENTIFIER, C.INBOUND.INV_RELEASE]).join(', ') + '.');

        return createDocument(map, body, cfg, startedAt);

      } catch (e) {
        // A RESTlet that throws answers with a NetSuite error envelope the
        // Middleware cannot branch on. Everything comes back as OUR envelope.
        log.error({ title: 'RB-WRITE-002 dispatch', details: e });
        return failEnvelope('UNHANDLED',
          (e && e.message) ? e.message : String(e));
      }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Create an Item Receipt or an Item Fulfilment
    // ═══════════════════════════════════════════════════════════════════════════

    const createDocument = (map, body, cfg, startedAt) => {
      const requestUuid = String(body.request_uuid || '').trim();
      const entry = logEntry(map);

      const refuse = (code, message, failedLines, unit) => {
        logIo.recordInbound({
          entry: entry, unit: unit || unitFor(map, '', ''), cfg: cfg,
          operation: C.OPERATION.CREATE, outcome: C.OUTCOME.FAILURE,
          status: C.STATUS.OPEN_REVIEW, reason: C.REASON.AWAITING_DECISION,
          errorClass: C.ERRCLASS.BUSINESS, errorCode: code,
          errorMessage: message,
          endpoint: map.key + ' ' + body.operation, method: 'POST',
          httpStatus: 400, startedAt: startedAt,
          requestUuid: requestUuid, shipmentUuid: body.shipment_uuid,
          request: body,
          response: failEnvelope(code, message, failedLines),
          lineTotal: Array.isArray(body.lines) ? body.lines.length : 0,
          lineSent: 0,
          suggested: 'Nothing was created. The operator corrects the cause, ' +
            'rescans and resubmits with a NEW request_uuid.'
        });
        return failEnvelope(code, message, failedLines);
      };

      // ── THE FLOW SWITCH ────────────────────────────────────────────────
      if (cfg[map.flowKey] !== true)
        return refuse(C.DOC_ERR.FLOW_DISABLED,
          'The ' + map.syncType + ' flow is switched off on the RapidBridge ' +
          'Configuration record.');

      // ── DOCUMENT CHECKS. Every one of these runs BEFORE anything is built,
      //    and a failure touches no record at all. §7.8.2.
      if (!requestUuid)
        return refuse(C.DOC_ERR.MISSING_REQUEST_UUID,
          'No request_uuid was supplied. It is the duplicate guard and it is ' +
          'mandatory: it becomes this record\'s NetSuite external id.');

      // RULE 2 — a repeat submission is answered with what already exists, and
      // it is a SUCCESS. The platform's uniqueness constraint is what makes
      // this safe; this lookup only makes the answer friendly.
      const existing = findByExternalId(map, requestUuid);
      if (existing) {
        log.audit({
          title: 'RB inbound duplicate request_uuid',
          details: {
            requestUuid: requestUuid, existing: existing,
            note: 'Answered with the record that already exists. Not an error.'
          }
        });
        return okEnvelope({
          internal_id: existing, external_id: requestUuid,
          duplicate: true,
          lines_posted: Array.isArray(body.lines) ? body.lines.length : 0
        });
      }

      const lines = Array.isArray(body.lines) ? body.lines : null;
      if (!lines || !lines.length)
        return refuse(C.DOC_ERR.MALFORMED_PAYLOAD,
          'The submission carries no lines.');

      const orderId = String(body.order_id || '').trim();
      if (!orderId)
        return refuse(C.DOC_ERR.ORDER_NOT_FOUND,
          'No order_id was supplied, so there is nothing to create this ' +
          'document from.');

      const order = readOrder(map, orderId);
      if (!order.found)
        return refuse(C.DOC_ERR.ORDER_NOT_FOUND,
          'No ' + map.fromType + ' with internal id ' + orderId + ' exists.');

      // The order must be in a status this integration recognises as live, and
      // it must already exist in TrackTraceRX — otherwise the document being
      // created has nothing to hang off.
      const statusRow = util.statusEntry(map.fromType, order.status);
      if (statusRow && statusRow.terminal)
        return refuse(C.DOC_ERR.ORDER_CLOSED,
          'Order ' + txn.named(order.tranid, orderId) + ' is ' + statusRow.name +
          ', so nothing further can be received or fulfilled against it.');
      // `scannable`, not `sync`. A purchase order at Pending Bill is fully
      // received: its payload may still be SENT (an edit must reach the
      // destination) but there is nothing left to put on a receipt, and the
      // transform below would produce an empty document. Refusing here says so
      // in words instead.
      if (!statusRow || !statusRow.scannable)
        return refuse(C.DOC_ERR.ORDER_NOT_APPROVED,
          'Order ' + txn.named(order.tranid, orderId) + ' is "' +
          (order.status || 'unknown') + '", which has nothing left to receive ' +
          'or fulfil. The statuses that do are: ' +
          util.scannableStatusNames(map.fromType).join(', ') +
          '. It should never have been offered for selection.');
      if (!order.uuid)
        return refuse(C.DOC_ERR.ORDER_NOT_SYNCED,
          'Order ' + txn.named(order.tranid, orderId) + ' has no TrackTraceRX ' +
          'transaction identifier, so it was never sent and cannot be scanned ' +
          'against.');
      if (order.locationInactive)
        return refuse(C.DOC_ERR.LOCATION_INACTIVE,
          'The location on order ' + txn.named(order.tranid, orderId) +
          ' is inactive.');

      // ── BUILD. Nothing below here is saved unless EVERY line passes.
      let rec;
      try {
        rec = record.transform({
          fromType: map.fromType, fromId: orderId,
          toType: map.recordType, isDynamic: true
        });
      } catch (e) {
        log.error({ title: 'RB-WRITE-003 createDocument', details: (e && e.message) || String(e) });
        return refuse(C.DOC_ERR.ORDER_CLOSED,
          'Order ' + txn.named(order.tranid, orderId) + ' cannot be ' +
          'transformed into a ' + map.syncType + ': ' +
          ((e && e.message) || String(e)));
      }

      // §4.1.2 — THE DUPLICATE GUARD. Set before anything else, so that even a
      // save that fails later has claimed the identifier.
      try { rec.setValue({ fieldId: 'externalid', value: requestUuid }); }
      catch (e) {
        log.error({ title: 'RB-WRITE-004 createDocument', details: (e && e.message) || String(e) }); /* not settable on this form; the lookup above still guards */
      }

      applyHeader(rec, map, body, cfg, order);

      // §10.6 — the fulfilment's status is set BEFORE the lines. NetSuite's
      // sublist behaviour and its inventory-detail requirements differ by
      // shipping status, and setting it afterwards can invalidate detail that
      // has already been entered.
      let shipStatusLabel = '';
      if (map.needsShipStatus) {
        shipStatusLabel = String(cfg.ifStatus || 'Shipped');
        const code = C.IF_STATUS[shipStatusLabel];
        if (!code) {
          log.audit({
            title: 'RB inbound fulfilment status not configured',
            details: 'Falling back to Shipped. Set the Fulfilment Create ' +
              'Status on the RapidBridge Configuration record.'
          });
          shipStatusLabel = 'Shipped';
        }
        try {
          rec.setValue({ fieldId: 'shipstatus', value: C.IF_STATUS[shipStatusLabel] });
        } catch (e) {
          log.error({ title: 'RB-WRITE-005 createDocument', details: (e && e.message) || String(e) }); /* not on this form */
        }
      }

      // ── THE PRE-READ. §17.4 rule 3: everything the line loop needs, in
      //    three searches, BEFORE the loop. Twelve lines times four point
      //    lookups is forty-eight reads on the tightest budget in the SuiteApp.
      const ctx = {
        map: map, cfg: cfg, order: order,
        items: readItems(lines, cfg),
        onHand: map.usesHoldBin ? readSerialsOnHand(lines) : {},
        // The body's own bin — payload, and the last payload-level answer
        // before the default.
        bodyBin: payloadBin(body),
        // Recorded, never used by the receipt. The release reads it back.
        bodyGoodBin: map.usesHoldBin ? payloadGoodBin(body) : '',
        holdBin: map.usesHoldBin ? holdBinFor(order, cfg) : '',
        // The LOCATION's Good Bin. Read for the receipt because a
        // NON-eligible line ends its ladder there - it is never released,
        // so it must land somewhere it can be picked from.
        locGoodBin: map.usesHoldBin ? locationGoodBin(order.locationId) : ''
      };

      // ── THE LINE LOOP. Collect, then decide. NEVER return on the first
      //    failure — §7.8.2 point 1.
      const byKey = {};
      lines.forEach((l) => { byKey[String(l.line_unique_key)] = l; });

      const failures = [];
      const applied = [];
      const count = rec.getLineCount({ sublistId: 'item' });

      for (let i = 0; i < count; i++) {
        rec.selectLine({ sublistId: 'item', line: i });
        const orderLine = String(rec.getCurrentSublistValue({
          sublistId: 'item', fieldId: 'orderline'
        }) || '');
        const submitted = byKey[orderLine];

        if (!submitted) {
          // Not on this submission. Take it off the document — a line left
          // ticked would save with the order's own quantity.
          map.applyFields.forEach((f) => setCur(rec, f, false));
          rec.commitLine({ sublistId: 'item' });
          continue;
        }
        delete byKey[orderLine];

        try {
          validateLine(rec, submitted, ctx);
          applyLine(rec, submitted, ctx);
          applied.push(orderLine);
          rec.commitLine({ sublistId: 'item' });
        } catch (e) {
          log.error({ title: 'RB-WRITE-006 createDocument', details: (e && e.message) || String(e) });
          failures.push(lineFailure(submitted, e));
          // The line is abandoned rather than committed. Nothing is saved
          // either way, so this only keeps the in-memory record coherent.
          try { rec.commitLine({ sublistId: 'item' }); } catch (e2) { /* ignore */ }
        }
      }

      // Anything the Middleware sent that is not on the order at all.
      Object.keys(byKey).forEach((k) => {
        failures.push(lineFailure(byKey[k], {
          name: C.LINE_ERR.LINE_NOT_ON_ORDER,
          message: 'Line ' + k + ' is not a line on order ' +
            txn.named(order.tranid, orderId) + '.'
        }));
      });

      // ── THE DECISION. Two lines, and they are the whole of rule 1.
      if (failures.length) {
        const msg = failures.length + ' line(s) failed validation, so nothing ' +
          'was created. Correct them and resubmit with a new request_uuid.';
        return refuse(C.DOC_ERR.LINE_VALIDATION_FAILED, msg, failures);
      }

      let newId;
      try {
        newId = rec.save({ enableSourcing: true, ignoreMandatoryFields: true });
      } catch (e) {
        log.error({ title: 'RB-WRITE-007 createDocument', details: (e && e.message) || String(e) });
        // The last document-level gate. Every line validated and the save was
        // still refused — a permission, a plug-in, a locked period.
        const message = (e && e.message) ? e.message : String(e);
        const code = /period/i.test(message)
          ? C.DOC_ERR.PERIOD_LOCKED : C.DOC_ERR.SAVE_REFUSED;
        return refuse(code, 'NetSuite refused the save: ' + message);
      }

      // ── THE DOCUMENT'S TOTAL SHORTFALL. One number, so a saved search
      //    can find every document that came up short and a reconciliation
      //    can compare it with what TrackTraceRX expected.
      const exceptionQty = round6(lines.reduce(
        (n, l) => n + (Number(l.__exceptionQty) || 0), 0));
      const exceptionLines = lines.filter((l) => (Number(l.__exceptionQty) || 0) > 0);

      // ── STAMPED ONLY NOW, because only now is there a record.
      stampCreated(map, newId, body, requestUuid, exceptionQty);

      const unit = unitFor(map, newId, '');
      logIo.recordInbound({
        entry: entry, unit: unit, cfg: cfg,
        operation: C.OPERATION.CREATE, outcome: C.OUTCOME.SUCCESS,
        status: C.STATUS.CLOSED_SUCCESS,
        endpoint: map.key + ' ' + body.operation, method: 'POST',
        httpStatus: 200, startedAt: startedAt,
        requestUuid: requestUuid, shipmentUuid: body.shipment_uuid,
        request: body, lineTotal: lines.length, lineSent: applied.length,
        // A SHORT document is a success with something to answer for. The
        // row stays closed - nothing failed - but it names the shortfall so
        // the reconciliation page can find it without reopening the record.
        suggested: exceptionQty > 0
          ? 'SHORT BY ' + exceptionQty + ' across ' + exceptionLines.length +
          ' line(s): ' + exceptionLines.map((l) => 'line ' +
            l.line_unique_key + ' short ' + l.__exceptionQty +
            ' (' + (l.exception_reason || 'no reason given') + ')').join('; ') +
          '. The document is correct - this is what did not arrive. The ' +
          'quantity is on each line as Exception Quantity and totalled on ' +
          'the record, so it can be compared with what TrackTraceRX ' +
          'expected without reading this row.'
          : null
      });

      // §11.4 — the record exists and call 2 has not arrived. A legitimate
      // state with a worklist, not a fault.
      logIo.stampTry(unit, C.TRY.CREATED_NO_UUID, null,
        'Created from a Middleware submission. Waiting for the identifier ' +
        'call that stores the shipment UUID.');

      log.audit({
        title: 'RB inbound created ' + map.syncType + ' ' + newId,
        details: {
          orderId: orderId, requestUuid: requestUuid,
          linesPosted: applied.length, of: lines.length,
          shipStatus: shipStatusLabel || null,
          holdBin: ctx.holdBin || null
        }
      });

      const out = okEnvelope({
        internal_id: newId, external_id: requestUuid,
        lines_posted: applied.length,
        exception_quantity: exceptionQty,
        exception_lines: exceptionLines.map((l) => ({
          line_unique_key: l.line_unique_key,
          item_id: l.item_id,
          exception_quantity: l.__exceptionQty,
          exception_reason: l.exception_reason || '',
          exception_note: l.exception_note || ''
        }))
      });
      if (map.needsShipStatus) out.shipping_status = shipStatusLabel;
      return out;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Header, lines, and the checks on them
    // ═══════════════════════════════════════════════════════════════════════════

    const applyHeader = (rec, map, body, cfg, order) => {
      const setIf = (fieldId, value) => {
        if (value === undefined || value === null || value === '') return;
        try { rec.setValue({ fieldId: fieldId, value: value }); }
        catch (e) {
          log.error({ title: 'RB-WRITE-008 applyHeader', details: (e && e.message) || String(e) }); /* not on this form */
        }
      };
      const d = parseDate(body.transaction_date);
      if (d) setIf('trandate', d);
      setIf('memo', body.memo);

      // The audit answer to "where did this come from?". Every record this
      // integration creates carries it — §5.2.
      setIf(TXN.origin, C.ORIGIN_MW);
      setIf(TXN.shipmentUuid, body.shipment_uuid);
      setIf(TXN.requestUuid, body.request_uuid);
    };

    /**
     * Everything that can refuse a line, in one place. THROWS a `{name, message}`
     * carrying a C.LINE_ERR code — never a free-form string, because the codes
     * are an external contract the Middleware branches on.
     */
    const validateLine = (rec, ln, ctx) => {
      const itemId = String(rec.getCurrentSublistValue({
        sublistId: 'item', fieldId: 'item'
      }) || '');
      const info = ctx.items[itemId] || {};

      if (ln.item_id && String(ln.item_id) !== itemId)
        throw err(C.LINE_ERR.LINE_NOT_ON_ORDER,
          'Line ' + ln.line_unique_key + ' names item ' + ln.item_id +
          ' but that order line carries ' + txn.named(info.name, itemId) + '.');
      if (!itemId)
        throw err(C.LINE_ERR.ITEM_NOT_FOUND,
          'Line ' + ln.line_unique_key + ' has no item on the order.');
      if (info.inactive)
        throw err(C.LINE_ERR.ITEM_INACTIVE,
          'Item ' + txn.named(info.name, itemId) + ' is inactive.');

      const qty = Number(ln.quantity);
      if (!(qty > 0))
        throw err(C.LINE_ERR.BAD_QUANTITY,
          'Line ' + ln.line_unique_key + ' has quantity "' + ln.quantity + '".');

      // What is left to receive or fulfil on this order line. The transformed
      // record already carries it, so nothing extra is read.
      const remaining = Number(rec.getCurrentSublistValue({
        sublistId: 'item', fieldId: 'quantityremaining'
      })) || Number(rec.getCurrentSublistValue({
        sublistId: 'item', fieldId: 'quantity'
      })) || 0;
      if (remaining > 0 && qty > remaining)
        throw err(C.LINE_ERR.QTY_EXCEEDS_REMAINING,
          'Line ' + ln.line_unique_key + ' submits ' + qty + ' of ' +
          txn.named(info.name, itemId) + ' but only ' + remaining +
          ' is left on the order. Over-receipt on a regulated product is a ' +
          'discrepancy to investigate, not a quantity to accept.');

      // ══ THE EXCEPTION, AND WHAT IT IS NOT ════════════════════════════
      //
      // ── A PARTIAL RECEIPT IS NOT AN EXCEPTION ──────────────────────────
      //
      // This is the correction. A purchase order for 100 that receives 24
      // today is not short by 76 - it has 76 still on order, arriving next
      // week, and the order line stays open to receive them. Treating every
      // under-receipt as a discrepancy would have refused the most ordinary
      // receipt there is, and put a work item on every one it let through.
      //
      // The same holds on a fulfilment: shipping 1 of 2 now and 1 on Friday
      // is a partial fulfilment, not a pick that failed.
      //
      // ── AN EXCEPTION IS SOMETHING THE DEVICE DECLARES ──────────────────
      //
      // `exception_reason` is the declaration. The operator saw a reason the
      // rest is NOT coming - damaged in transit, short against the ASN,
      // stock missing from the bin - and said so. Only then is there a
      // discrepancy to carry, and only then is there a quantity to carry it
      // with.
      //
      //   reason, no quantity   -> the shortfall is the quantity
      //   reason and quantity   -> the declared quantity, which may be less
      //                            than the shortfall when part of the
      //                            remainder is genuinely still on order
      //   quantity, no reason   -> REFUSED. A number nobody will be able to
      //                            explain is worse than no number
      //   neither               -> no exception. 0 is written, and the
      //                            remainder stays on the order
      const shortBy = (remaining > 0) ? round6(remaining - qty) : 0;
      const hasReason = !!String(ln.exception_reason || '').trim();
      const stated = (ln.exception_quantity === undefined ||
        ln.exception_quantity === null || ln.exception_quantity === '')
        ? null : Number(ln.exception_quantity);

      if (stated !== null && !(stated >= 0))
        throw err(C.LINE_ERR.BAD_QUANTITY,
          'Line ' + ln.line_unique_key + ' has exception_quantity "' +
          ln.exception_quantity + '".');

      if (stated !== null && !hasReason)
        throw err(C.LINE_ERR.EXCEPTION_REASON_REQUIRED,
          'Line ' + ln.line_unique_key + ' declares an exception quantity of ' +
          stated + ' for ' + txn.named(info.name, itemId) + ' and gives no ' +
          'exception_reason. A quantity nobody can explain afterwards is ' +
          'worse than no quantity at all. Send one of the values from ' +
          'fulfilment_exceptions.');

      // An exception cannot exceed what was outstanding. More than that is
      // arithmetic nobody can reconcile, not a bigger problem.
      if (stated !== null && remaining > 0 && stated > shortBy)
        throw err(C.LINE_ERR.BAD_QUANTITY,
          'Line ' + ln.line_unique_key + ' declares an exception of ' + stated +
          ' but only ' + shortBy + ' of ' + txn.named(info.name, itemId) +
          ' went unreceived (' + remaining + ' outstanding, ' + qty +
          ' submitted). An exception cannot be larger than the shortfall.');

      if (hasReason && shortBy === 0 && stated === null)
        log.audit({
          title: 'RB inbound exception_reason on a line that is not short',
          details: {
            line: ln.line_unique_key, remaining: remaining, submitted: qty,
            effect: 'The reason is recorded on the line; the exception ' +
              'quantity is 0, because nothing went unreceived.'
          }
        });

      ln.__exceptionQty = hasReason
        ? (stated === null ? shortBy : stated)
        : 0;

      const detail = Array.isArray(ln.inventory) ? ln.inventory : [];
      const tracked = info.isLot || info.isSerial;
      if (tracked && !detail.length)
        throw err(C.LINE_ERR.INVENTORY_DETAIL_MISSING,
          'Item ' + txn.named(info.name, itemId) + ' is lot or serial tracked, ' +
          'so line ' + ln.line_unique_key + ' must carry its inventory detail.');

      let total = 0;
      for (let i = 0; i < detail.length; i++) {
        const d = detail[i];
        const dq = Number(d.quantity === undefined ? 1 : d.quantity);
        if (!(dq > 0))
          throw err(C.LINE_ERR.BAD_QUANTITY,
            'Line ' + ln.line_unique_key + ' has an inventory row with ' +
            'quantity "' + d.quantity + '".');
        total += dq;

        const number = String(d.serial || d.lot || '').trim();
        if (info.isSerial) {
          if (!d.serial)
            throw err(C.LINE_ERR.SERIAL_INVALID,
              'Item ' + txn.named(info.name, itemId) + ' is serialized and an ' +
              'inventory row on line ' + ln.line_unique_key + ' carries no serial.');
          if (dq !== 1)
            throw err(C.LINE_ERR.SERIAL_INVALID,
              'Serial ' + d.serial + ' on line ' + ln.line_unique_key +
              ' has quantity ' + dq + '. One serial is one unit.');
          if (ctx.map.usesHoldBin && ctx.onHand[number.toUpperCase()])
            throw err(C.LINE_ERR.SERIAL_ALREADY_ON_HAND,
              'Serial ' + d.serial + ' on line ' + ln.line_unique_key +
              ' is already on hand. The same serial arriving twice is a ' +
              'compliance question, so the delivery stops here.');
        } else if (info.isLot && !d.lot) {
          throw err(C.LINE_ERR.LOT_INVALID,
            'Item ' + txn.named(info.name, itemId) + ' is lot tracked and an ' +
            'inventory row on line ' + ln.line_unique_key + ' carries no lot.');
        }
      }

      if (tracked && total !== qty)
        throw err(C.LINE_ERR.BAD_QUANTITY,
          'Line ' + ln.line_unique_key + ' submits quantity ' + qty +
          ' but its inventory detail adds up to ' + total + '.');

      // ══ THE BINS, ONE PER INVENTORY ROW ══════════════════════════════
      //
      // §11.8. The Middleware resolved each bin against the allowed-bins
      // service before submitting, so by the time this runs a named bin is
      // a value to VALIDATE, not a decision to make.
      //
      // One per row, because one line can carry several lots and a
      // warehouse puts them where there is space. The resolved bins are
      // kept on the line for applyLine, which must not re-derive them: a
      // validator and an applier that compute the same thing twice are a
      // validator and an applier that will one day disagree.
      //
      // TWO bins per row now, not one. The HOLD bin is where this receipt
      // is putting the stock; the GOOD bin is where the release is to take
      // it, recorded here because the receipt is the only moment anybody
      // knows it and the release can be days later.
      const rows = detail.length ? detail : [null];
      const bins = rows.map((d) => binForRow(ln, d, ctx, info));
      // A non-eligible line is already SITTING in its good bin: the ladder
      // put it there, because nothing will ever release it. Recording a
      // destination for a move that will never happen would put a bin on
      // the map that the release is forbidden to act on.
      const goods = (ctx.map.usesHoldBin && info.eligible === true)
        ? rows.map((d) => goodBinForRow(ln, d, ctx)) : rows.map(() => '');
      ln.__rowBins = detail.length ? bins : [];

      const rowName = (d) => (d
        ? (d.serial ? 'serial ' + d.serial
          : (d.lot ? 'lot "' + d.lot + '"' : 'the row'))
        : 'the line');

      for (let i = 0; i < rows.length; i++) {
        const bin = bins[i];

        // ══ AN ELIGIBLE ITEM MUST END UP SOMEWHERE NAMED ════════════════
        //
        // The ladder is payload, then the location's On-Hold Bin, then the
        // configured Default Bin. Reaching the bottom of it with nothing
        // means the account has no receiving bin set anywhere, which is a
        // configuration gap and not something to paper over: an eligible
        // item that lands wherever NetSuite defaults breaks the
        // hold-then-release flow before it starts, because the release has
        // no bin to move it out of.
        //
        // A FULFILMENT has no rungs below the payload at all. Only the
        // device knows which bin the stock came out of, and defaulting one
        // would relieve stock from a bin nobody picked.
        // A NON-eligible line is refused only on a RECEIPT. A fulfilment
        // has no ladder below the payload for anyone, and a line this
        // integration will never see again is left to NetSuite's own
        // picking rather than refused over a bin nobody asked for.
        if (!bin && ctx.cfg.useBins === true &&
          (info.eligible === true ||
            (ctx.map.usesHoldBin && info.useBins === true))) {
          const at = txn.named(ctx.order.locationName, ctx.order.locationId);
          throw err(C.LINE_ERR.BIN_REQUIRED,
            'No bin for ' + rowName(rows[i]) + ' on line ' +
            ln.line_unique_key + ' (' + txn.named(info.name, itemId) + '). ' +
            (!ctx.map.usesHoldBin
              ? 'Send `bin` on the inventory row or the line - the bin the ' +
              'stock was picked from. A fulfilment has no default: only ' +
              'the device knows where it came from.'
              : info.eligible === true
                ? 'The item is eligible for TrackTraceRX, so its stock goes ' +
                'ON HOLD until a release moves it. Send `bin` on the ' +
                'inventory row - different lots may go to different bins - ' +
                'or on the line, or on the body. Nothing answered below ' +
                'that either: location ' + at + ' has no On-Hold Bin and ' +
                'the RapidBridge Configuration has no Default Bin. Set one ' +
                'of those and an ordinary receipt needs no bin on the ' +
                'payload at all.'
                // ── THE NON-ELIGIBLE REFUSAL, AND IT POINTS SOMEWHERE
                //    DIFFERENT. Nothing will ever release this line, so it
                //    must not be sent to a hold bin - and the ladder that
                //    would have ended there has been replaced by one that
                //    ends in the GOOD bin. Saying "set the On-Hold Bin"
                //    here would be advice that does not work.
                : 'The item is NOT tracked by TrackTraceRX, so nothing will ' +
                'ever release it and it must not go on hold. It needs a ' +
                'bin it can be PICKED from: send `bin` or `good_bin` on ' +
                'the row, line or body, or set a Good Bin on location ' +
                at + '. The On-Hold Bin and the Default Bin are both ' +
                'receiving defaults and neither is used for this line.'));
        }

        if (bin && ctx.cfg.useBins === true) {
          const b = binInfo(bin, ctx);
          if (!b.exists)
            throw err(C.LINE_ERR.BIN_NOT_ALLOWED,
              'Bin ' + bin + ' named for ' + rowName(rows[i]) + ' on line ' +
              ln.line_unique_key + ' does not exist.');
          if (b.location && ctx.order.locationId
            && String(b.location) !== String(ctx.order.locationId))
            throw err(C.LINE_ERR.BIN_INVALID_LOCATION,
              'Bin ' + txn.named(b.name, bin) + ', named for ' +
              rowName(rows[i]) + ' on line ' + ln.line_unique_key +
              ', is not at the order\'s location.');
        }

        // ══ AND THE GOOD BIN, IF ONE WAS NAMED ══════════════════════════
        //
        // Validated to the same standard as the hold bin even though
        // nothing moves there today. A good bin that does not exist, or
        // belongs to another site, is a release that will fail in a week
        // with the goods already received and the operator long gone. It
        // costs one cached lookup to say so now.
        const good = goods[i];
        if (good && ctx.cfg.useBins === true) {
          const g = binInfo(good, ctx);
          if (!g.exists)
            throw err(C.LINE_ERR.BIN_NOT_ALLOWED,
              'Good bin ' + good + ' named for ' + rowName(rows[i]) +
              ' on line ' + ln.line_unique_key + ' does not exist. It is ' +
              'not used by this receipt - it is recorded for the release - ' +
              'but a bin that does not exist now will not exist then.');
          if (g.location && ctx.order.locationId
            && String(g.location) !== String(ctx.order.locationId))
            throw err(C.LINE_ERR.BIN_INVALID_LOCATION,
              'Good bin ' + txn.named(g.name, good) + ', named for ' +
              rowName(rows[i]) + ' on line ' + ln.line_unique_key +
              ', is not at the order\'s location. A Bin Transfer cannot ' +
              'cross locations, so the release could never make that move.');
          if (good === bins[i])
            throw err(C.LINE_ERR.BIN_NOT_CONFIGURED,
              'The good bin named for ' + rowName(rows[i]) + ' on line ' +
              ln.line_unique_key + ' is the same bin the stock is being ' +
              'received into. The release would move it to where it ' +
              'already is and report the job done, with unverified stock ' +
              'never having left the hold.');
        }
      }

      // The LINE column holds one bin, so it holds one only when the whole
      // line used one. Mixed lots keep their bins where they belong - on
      // the inventory detail - and the column stays blank rather than
      // naming one of them and implying the rest.
      const distinct = bins.filter((b, i) => b && bins.indexOf(b) === i);
      ln.__lineBin = distinct.length === 1 ? distinct[0] : '';
      if (distinct.length > 1)
        log.audit({
          title: 'RB inbound - one line, several bins',
          details: {
            line: ln.line_unique_key, item: itemId, bins: distinct,
            effect: 'Each inventory row carries its own bin. The line\'s ' +
              'Hold Bin column is left blank: naming one of several would ' +
              'imply the rest. The bin/lot map on the line names them all.'
          }
        });

      // ══ THE BIN / LOT MAP ════════════════════════════════════════════
      //
      // Written on a RECEIPT only. A fulfilment issues stock and has no
      // release behind it, so there is nothing for a map to be read back
      // for. THROWS BIN_MAP_TOO_LARGE, which is why it is here in the
      // validator and not in applyLine - applyLine may not throw.
      ln.__binMap = ctx.map.usesHoldBin
        ? binMapJson(rows, bins, goods, ln.line_unique_key) : '';

      // An item whose own record says it does not use bins is left to
      // NetSuite entirely. There is nothing to refuse and nothing to
      // record: the account is not binning that item.
      if (!distinct.length && ctx.map.usesHoldBin && ctx.cfg.useBins === true &&
        info.useBins !== true)
        log.audit({
          title: 'RB inbound - the item does not use bins',
          details: {
            line: ln.line_unique_key, item: itemId,
            effect: 'Left to NetSuite\'s own handling. Use Bins is off on ' +
              'the item record, so there is no bin to name.'
          }
        });
    };

    /** Put the validated line onto the document. Nothing here may throw. */
    const applyLine = (rec, ln, ctx) => {
      const map = ctx.map;
      const qty = Number(ln.quantity);

      map.applyFields.forEach((f) => setCur(rec, f, true));
      setCur(rec, 'quantity', qty);

      // §10.7 / §11.7 — a short line carries the picker's declared reason, and
      // that is what makes a partial a SUCCESS rather than a discrepancy.
      if (ln.exception_reason) setCurText(rec, C.LINE.excReason, ln.exception_reason);
      if (ln.exception_note) setCur(rec, C.LINE.excNote, ln.exception_note);
      // ALWAYS written, zero included. A blank then means the line predates
      // the field, not that nothing was short - which is the difference
      // between a reconciliation that can be trusted and one that cannot.
      setCur(rec, C.LINE.exceptionQty, Number(ln.__exceptionQty) || 0);

      // Resolved in validateLine, not re-derived. One place decides which
      // bin a row goes to, and it is the place that already refused the
      // rows that had none.
      if (ln.__lineBin) setCur(rec, C.LINE.holdBin, ln.__lineBin);
      // WHERE EACH LOT WENT AND WHERE IT IS GOING. Built and size-checked
      // in validateLine; here it is only written.
      if (ln.__binMap) setCur(rec, C.LINE.binMap, ln.__binMap);

      const detail = Array.isArray(ln.inventory) ? ln.inventory : [];
      if (!detail.length) return;
      const rowBins = ln.__rowBins || [];

      let sub = null;
      try {
        sub = rec.getCurrentSublistSubrecord({
          sublistId: 'item', fieldId: 'inventorydetail'
        });
      } catch (e) {
        log.error({ title: 'RB-WRITE-009 applyLine', details: (e && e.message) || String(e) }); sub = null;
      }
      if (!sub) return;                 // the item is not tracked

      for (let i = 0; i < detail.length; i++) {
        const d = detail[i];
        sub.selectNewLine({ sublistId: 'inventoryassignment' });
        // TEXT, not value: the lot or serial may not exist yet, and setting it
        // by text is what makes NetSuite create it.
        subSetText(sub, map.inventoryField, String(d.serial || d.lot || ''));
        // THE ROW'S OWN BIN. Two lots on one line may be in two bins.
        const rowBin = rowBins[i];
        if (rowBin) subSet(sub, 'binnumber', rowBin);
        const exp = parseDate(d.expiry || d.expiration_date);
        if (exp) subSet(sub, 'expirationdate', exp);
        subSet(sub, 'quantity', Number(d.quantity === undefined ? 1 : d.quantity));
        sub.commitLine({ sublistId: 'inventoryassignment' });
      }
    };

    const lineFailure = (ln, e) => ({
      // The key AS IT WAS SENT. Never renumbered, reordered or normalized —
      // the Middleware matches on it to point the operator at the right line.
      line_unique_key: ln ? ln.line_unique_key : null,
      error_code: (e && e.name) || C.LINE_ERR.ITEM_NOT_FOUND,
      error_message: (e && e.message) || String(e)
    });

    const err = (code, message) => {
      const e = new Error(message);
      e.name = code;
      return e;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Call 2 — store the TrackTraceRX identifier. §11.4
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Do not collapse this into the create. Proposal v4 §7.4 requires RapidS1
     * to queue offline and replay on reconnection, which makes duplicate
     * submission MORE likely, not less — and this protocol is what makes that
     * safe.
     *
     * OUR OBLIGATION, explicitly: validate the tracktrace_uuid's uniqueness
     * before storing it. Two records claiming one remote object is a problem
     * nothing downstream can untangle.
     */
    /**
     * Call 2 of the two-call protocol - §11.4.
     *
     * ── WHAT THE IDENTIFIER ACTUALLY IS, AND WHY IT IS NOT UNIQUE ───────────
     *
     * An Item Receipt and an Item Fulfilment have NO identifier of their own.
     * What TrackTraceRX returns is the SHIPMENT UUID, and one shipment can
     * cover several purchase or sales orders - so several receipts, created
     * from several POs, legitimately carry THE SAME shipment UUID.
     *
     * That is the opposite of an order. A Sales Order and a Purchase Order each
     * get a transaction UUID that IS unique per record, and `findByUuid` exists
     * to defend that.
     *
     * So on a receipt or a fulfilment the value lands in `shipmentUuid` and
     * NOTHING checks it for uniqueness. Two records naming one shipment is the
     * normal case, not a duplicate. Refusing it would have made a multi-order
     * delivery impossible to record: the second receipt would come back
     * DUPLICATE_IDENTIFIER with nothing whatever wrong.
     *
     * The duplicate guard has not gone anywhere. It is the Middleware's
     * `request_uuid` in the native externalId, which is unique per submission
     * and enforced by the platform (§4.1.2). Nothing is weaker for this.
     */
    const storeIdentifier = (body, cfg, startedAt) => {
      const requestUuid = String(body.request_uuid || '').trim();
      // `shipment_uuid` is what this value IS. The other two names are accepted
      // because the field is `uuid` on the wire and earlier callers send
      // `tracktrace_uuid`.
      const ttUuid = String(body.shipment_uuid || body.tracktrace_uuid ||
        body.uuid || '').trim();
      // `record_type` arrives as a NetSuite record type ('itemreceipt'), which
      // is not the key this table uses. Match on either, and fall back to the
      // receipt — the identifier write is the same either way, and the only
      // thing the map decides here is which type is searched.
      const map = mapForRecordType(body.record_type)
        || INBOUND_MAP[String(body.record_type || '').trim()]
        || INBOUND_MAP[C.INBOUND.IR_CREATE];
      const entry = logEntry(map);

      const refuse = (code, message, unit) => {
        logIo.recordInbound({
          entry: entry, unit: unit || unitFor(map, '', ''), cfg: cfg,
          operation: C.OPERATION.UPDATE, outcome: C.OUTCOME.FAILURE,
          status: C.STATUS.OPEN_REVIEW, reason: C.REASON.AWAITING_DECISION,
          errorClass: C.ERRCLASS.BUSINESS, errorCode: code, errorMessage: message,
          endpoint: C.INBOUND.IDENTIFIER, method: 'PUT',
          httpStatus: 400, startedAt: startedAt,
          requestUuid: requestUuid, uuid: ttUuid, request: body,
          response: failEnvelope(code, message)
        });
        return failEnvelope(code, message);
      };

      if (!ttUuid)
        return refuse(C.DOC_ERR.MALFORMED_PAYLOAD,
          'No shipment_uuid was supplied. On an Item Receipt or an Item ' +
          'Fulfilment this call stores the SHIPMENT identifier; the document ' +
          'has no identifier of its own.');

      // Address the record by whichever the caller knows. request_uuid is the
      // one the Middleware always has, because it chose it.
      let recordType = String(body.record_type || '').trim();
      let internalId = String(body.internal_id || '').trim();
      if (!internalId) {
        if (!requestUuid)
          return refuse(C.DOC_ERR.MISSING_REQUEST_UUID,
            'Supply either internal_id or request_uuid so the record can be found.');
        internalId = findByExternalId(map, requestUuid) || '';
        recordType = String(map.recordType);
      }
      if (!internalId)
        return refuse(C.DOC_ERR.RECORD_NOT_FOUND,
          'No ' + map.syncType + ' carries external id ' + requestUuid + '.');
      if (!recordType) recordType = String(map.recordType);

      // ── NO UNIQUENESS CHECK. See the note on this function. A shipment
      //    covering three purchase orders produces three receipts that all
      //    carry its UUID, and every one of them is correct.
      //
      //    An ORDER is different: its transaction UUID is unique per record,
      //    and findByUuid still guards that on the outbound path.

      const unit = unitFor(map, internalId, '');
      unit.recordType = recordType;

      try {
        record.submitFields({
          type: recordType, id: internalId,
          values: {
            // The SHIPMENT field, not the transaction-UUID field. A receipt
            // written into custbody_jj_rb_uuid would read as an order with its
            // own TrackTrace object, and the outbound engine would later try to
            // PUT updates to something that was never a transaction.
            [TXN.shipmentUuid]: ttUuid,
            [TXN.synced]: true,
            [TXN.lastSync]: new Date(),
            [TXN.error]: ''
          },
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) {
        log.error({ title: 'RB-WRITE-010 storeIdentifier', details: (e && e.message) || String(e) });
        return refuse(C.DOC_ERR.SAVE_REFUSED,
          'The identifier could not be written: ' +
          ((e && e.message) || String(e)), unit);
      }

      logIo.stampTry(unit, C.TRY.SYNCED, null, '');
      logIo.recordInbound({
        entry: entry, unit: unit, cfg: cfg,
        operation: C.OPERATION.UPDATE, outcome: C.OUTCOME.SUCCESS,
        status: C.STATUS.CLOSED_SUCCESS,
        endpoint: C.INBOUND.IDENTIFIER, method: 'PUT',
        httpStatus: 200, startedAt: startedAt,
        requestUuid: requestUuid, shipmentUuid: ttUuid, request: body
      });

      log.audit({
        title: 'RB inbound shipment identifier stored',
        details: {
          recordType: recordType, internalId: internalId,
          shipmentUuid: ttUuid
        }
      });
      return okEnvelope({
        internal_id: internalId, external_id: requestUuid,
        shipment_uuid: ttUuid
      });
    };


    // ═══════════════════════════════════════════════════════════════════════════
    // inventory_release — the Bin Transfer. §11.6, Design v3.1 §9
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * THE LAST STEP OF EVERY RECEIPT.
     *
     * Received serialized stock has not yet been proved genuine. The receipt
     * put it in the location's ON-HOLD BIN. TrackTrace then verifies the EPCIS
     * data, the Middleware decides which lots passed and have no damage, and
     * it calls this. NetSuite moves exactly those lots to a GOOD BIN.
     *
     * ── WHAT THIS IS NOT ──────────────────────────────────────────────────
     *
     * It is NOT an Inventory Status Change. The meeting of 8 September settled
     * that inventory state is represented by PHYSICAL BINS, because bin
     * management is already a prerequisite of this integration and Inventory
     * Status is a separate feature not every account has - Design v3.1 §9.2.1.
     * There is no InventoryStatusChange anywhere in this SuiteApp.
     *
     * ── THE ONE THING TO TELL THE CLIENT ──────────────────────────────────
     *
     * A BIN DOES NOT MAKE STOCK UNAVAILABLE. NetSuite will commit stock
     * sitting in the on-hold bin: the quantity is on hand at that location, so
     * the availability calculation includes it. The on-hold bin buys PROCESS
     * control - a picker directed to good bins does not take from it - not
     * SYSTEM control. Design §9.4.1, carried as T-32.
     *
     * ── THE LOT ARRIVES BY NAME ───────────────────────────────────────────
     *
     * The Middleware knows lots as TrackTrace spells them - "LOT-2026-0815" -
     * and not as NetSuite internal ids. Every name is resolved against the
     * item's own on-hand inventory numbers. A name that resolves to nothing is
     * LOT_NOT_FOUND and the release refuses; it never creates a lot, because a
     * release moves stock that already exists and a lot invented here would be
     * a zero-quantity record nobody asked for.
     *
     * ── AND IT MUST STILL BE WHERE THE RECEIPT PUT IT ─────────────────────
     *
     * Every line is checked against `inventorybalance` for item + location +
     * from-bin + lot. If somebody moved the stock by hand, the release is
     * REFUSED rather than redirected: guessing where it went is how a
     * regulated product ends up released from a bin nobody verified.
     */
    const releaseInventory = (body, cfg, startedAt) => {
      const requestUuid = String(body.request_uuid || '').trim();
      const entry = {
        key: 'REL', syncType: C.SYNCTYPE.INV_RELEASE,
        logSubjectField: C.LOG.transaction, fields: TXN
      };
      const unitFromReceipt = (id) => ({
        recordType: 'itemreceipt', recordId: String(id || ''),
        uomId: null, storedUuid: '', storedPayload: '', storedSynced: false,
        data: {}, subjectDeleted: !id,
        uuidField: TXN.uuid, payloadField: TXN.payload, syncedField: TXN.synced,
        lastSyncField: TXN.lastSync, lastTryField: TXN.lastTry,
        tryResultField: TXN.tryResult, errorField: TXN.error
      });

      const refuse = (code, message, failedLines, receiptId) => {
        logIo.recordInbound({
          entry: entry, unit: unitFromReceipt(receiptId), cfg: cfg,
          operation: C.OPERATION.RELEASE, outcome: C.OUTCOME.FAILURE,
          status: C.STATUS.OPEN_REVIEW, reason: C.REASON.AWAITING_DECISION,
          errorClass: C.ERRCLASS.BUSINESS, errorCode: code,
          errorMessage: message,
          endpoint: 'REL ' + body.operation, method: 'POST',
          httpStatus: 400, startedAt: startedAt,
          requestUuid: requestUuid, shipmentUuid: body.shipment_uuid,
          request: body,
          response: failEnvelope(code, message, failedLines),
          lineTotal: Array.isArray(body.lines) ? body.lines.length : 0,
          lineSent: 0,
          suggested: 'NOTHING MOVED. The stock is still in the on-hold bin, ' +
            'which is the safe place for it. Correct the cause and resubmit ' +
            'with a NEW request_uuid.'
        });
        return failEnvelope(code, message, failedLines);
      };

      // ── DOCUMENT CHECKS. All of them before anything is built.
      if (cfg.irEnabled !== true)
        return refuse(C.DOC_ERR.FLOW_DISABLED,
          'The Item Receipt flow is switched off on the RapidBridge ' +
          'Configuration record, and the release is its last step.');

      if (!requestUuid)
        return refuse(C.DOC_ERR.MISSING_REQUEST_UUID,
          'No request_uuid was supplied. It is the duplicate guard and it is ' +
          'mandatory: it becomes the Bin Transfer\'s NetSuite external id.');

      // RULE 2, unchanged. A retry is answered with the transfer that already
      // exists, and that is a SUCCESS. NO SECOND BIN TRANSFER - Design §9.8.
      const already = findBinTransfer(requestUuid);
      if (already) {
        log.audit({
          title: 'RB release duplicate request_uuid',
          details: {
            requestUuid: requestUuid, binTransfer: already,
            note: 'Answered with the Bin Transfer that already exists. ' +
              'Not an error, and nothing moved twice.'
          }
        });
        return okEnvelope({
          bin_transfer_internal_id: already, external_id: requestUuid,
          duplicate: true
        });
      }

      const lines = Array.isArray(body.lines) ? body.lines : null;
      if (!lines || !lines.length)
        return refuse(C.DOC_ERR.MALFORMED_PAYLOAD,
          'The release carries no lines. A release that names nothing is not ' +
          'an empty release; it is a caller that lost its payload.');

      // ── THE ORDER. The release is about an order's receipt, and the order
      //    is what the Middleware is holding - Design §9.3 asks for "the item
      //    and line details for the order along with the order details".
      const orderId = String(body.order_id || '').trim();
      const order = orderId ? readOrder(INBOUND_MAP[C.INBOUND.IR_CREATE], orderId)
        : { found: false };
      if (orderId && !order.found)
        return refuse(C.DOC_ERR.ORDER_NOT_FOUND,
          'No purchase order with internal id ' + orderId + ' exists.');

      // ── THE RECEIPT. MANDATORY, and it was not in v1.0.
      //
      //    The receipt carries the LEDGER, and the ledger is the only thing
      //    that knows what this release has already moved. Without it a
      //    second call with a fresh request_uuid moves the same lot again,
      //    and the on-hold bin's balance cannot tell anybody otherwise
      //    because several receipts share that bin. Design §9.3 lists the
      //    receipt reference as mandatory; v1.0 treated it as optional and
      //    that was the hole.
      const receiptId = resolveReceipt(body, orderId);
      if (!receiptId)
        return refuse(C.DOC_ERR.RECEIPT_NOT_IDENTIFIED,
          'No Item Receipt could be identified for this release. Send ' +
          'item_receipt_internal_id, or a shipment_uuid that matches one. ' +
          'The receipt holds the release ledger, and without it there is no ' +
          'way to know what a previous call already moved - so the release ' +
          'is refused rather than risking the same lot being moved twice.');

      // ── THE LOCATION. A Bin Transfer CANNOT CROSS LOCATIONS, so there is
      //    exactly one and everything must agree with it.
      const locationId = String(body.location_id || order.locationId ||
        receiptLocation(receiptId) || '').trim();
      if (!locationId)
        return refuse(C.DOC_ERR.MALFORMED_PAYLOAD,
          'No location could be determined for this release. A Bin Transfer ' +
          'is within one location and cannot be built without it. Send ' +
          'location_id, or an order_id or item_receipt_internal_id that ' +
          'carries one.', null, receiptId);

      // ── THE TWO BINS, in two layers: what the PAYLOAD said and what
      //    CONFIGURATION says. The receipt's own per-lot memory goes
      //    between them, which is why they are not collapsed here.
      //    Blank at the bottom of that ladder is a configuration error.
      const bins = releaseBins(body, order, locationId, cfg);

      // ── THE ITEMS FIRST. Eligibility decides what the ledger is even
      //    allowed to carry, so it has to be known before the seed.
      const items = readItems(lines, cfg);

      // ── THE LEDGER. One lookupFields, and it is the authority.
      let ledger = readLedger(receiptId);
      if (!ledger.lotCount) {
        // First release against this receipt: seed the entitlements from what
        // the receipt actually received. ONE read, ONCE in the receipt's life
        // - every later release reads them back out of the stored JSON.
        ledger = seedLedger(receiptId, ledger, cfg);
        if (!ledger.lotCount)
          return refuse(C.DOC_ERR.RECEIPT_NOT_READABLE,
            'Item Receipt ' + receiptId + ' carries no lot detail that could ' +
            'be read, so there is nothing to measure this release against. ' +
            'A release is refused rather than guessed at.', null, receiptId);
      }

      // THE SECOND DUPLICATE GUARD, and the one that catches what externalId
      // cannot: this exact request_uuid has already been applied to this
      // receipt. Answered as a SUCCESS with what it did.
      const applied = ledger.calls.filter((c) => c.uuid === requestUuid)[0];
      if (applied) {
        log.audit({
          title: 'RB release request_uuid already in the receipt ledger',
          details: {
            receiptId: receiptId, requestUuid: requestUuid,
            binTransfer: applied.bt || null
          }
        });
        return okEnvelope({
          bin_transfer_internal_id: applied.bt || '',
          external_id: requestUuid, item_receipt_internal_id: receiptId,
          duplicate: true,
          released_quantity: ledgerReleased(ledger),
          held_quantity: ledgerHeld(ledger)
        });
      }

      // ── THE REST OF THE PRE-READ. §17.4 rule 3: searches for the whole
      //    submission, not per line. Lots first, because the balance search
      //    needs the ids the names resolve to.
      const lots = readLotsByName(lines, items);
      const balance = readHeldBalance(lines, locationId, bins, ledger);

      // ── THE LINE LOOP. Collect, then decide. Rule 1 is the same here as on
      //    a receipt: ONE Bin Transfer for the whole release or none at all.
      //
      //    `claimed` accumulates within THIS submission, so two lines naming
      //    the same lot cannot each spend the whole remaining entitlement.
      const claimed = {};
      const failures = [];
      const moves = [];
      lines.forEach((ln) => {
        try {
          moves.push(validateRelease(ln, {
            items: items, lots: lots, balance: balance, bins: bins,
            ledger: ledger, claimed: claimed, receiptId: receiptId,
            locationId: locationId
          }));
        } catch (e) {
          log.error({ title: 'RB-WRITE-011 releaseInventory', details: (e && e.message) || String(e) });
          failures.push(lineFailure(ln, e));
        }
      });

      if (failures.length)
        return refuse(C.DOC_ERR.LINE_VALIDATION_FAILED,
          failures.length + ' of ' + lines.length + ' release line(s) failed ' +
          'validation, so NOTHING was moved. The stock is still in the ' +
          'on-hold bin. Correct the cause and resubmit with a new ' +
          'request_uuid.', failures, receiptId);

      if (!moves.length)
        return refuse(C.DOC_ERR.NOTHING_TO_RELEASE,
          'Every line of the release resolved to zero quantity. Nothing to ' +
          'transfer.', null, receiptId);

      // ── BUILD AND SAVE.
      let btId;
      try {
        btId = buildBinTransfer(moves, {
          locationId: locationId, requestUuid: requestUuid,
          date: body.transaction_date, memo: body.memo, items: items
        });
      } catch (e) {
        log.error({ title: 'RB-WRITE-012 releaseInventory', details: (e && e.message) || String(e) });
        const message = (e && e.message) ? e.message : String(e);
        const code = /period/i.test(message)
          ? C.DOC_ERR.PERIOD_LOCKED : C.DOC_ERR.SAVE_REFUSED;
        return refuse(code, 'NetSuite refused the Bin Transfer: ' + message,
          null, receiptId);
      }

      // ── POST THE LEDGER. Re-read, merge, write - never write back the copy
      //    read before the save. See commitLedger.
      const posted = commitLedger(receiptId, requestUuid, btId, moves, ledger);
      const released = posted.released;
      const held = posted.held;

      logIo.recordInbound({
        entry: entry, unit: unitFromReceipt(receiptId), cfg: cfg,
        operation: C.OPERATION.RELEASE,
        outcome: posted.overRelease ? C.OUTCOME.FAILURE : C.OUTCOME.SUCCESS,
        // ── CLOSED ONLY WHEN THE RECEIPT IS FULLY RELEASED ────────────────
        //    A PARTIAL release is normal, not a fault - some serials pass and
        //    some do not. But it is also the state that goes unnoticed: no
        //    call failed, and the remainder sits in the on-hold bin until a
        //    picker finds the good bin short. An open row is the only thing
        //    that surfaces it before the warehouse does. Design §9.12.
        status: (held > 0 || posted.overRelease)
          ? C.STATUS.OPEN_REVIEW : C.STATUS.CLOSED_SUCCESS,
        reason: (held > 0 || posted.overRelease)
          ? C.REASON.AWAITING_DECISION : null,
        errorClass: posted.overRelease ? C.ERRCLASS.BUSINESS : null,
        errorCode: posted.overRelease ? C.LINE_ERR.QTY_EXCEEDS_RECEIVED : null,
        errorMessage: posted.overRelease ? posted.conflictNote : null,
        endpoint: 'REL ' + body.operation, method: 'POST',
        httpStatus: 200, startedAt: startedAt,
        requestUuid: requestUuid, shipmentUuid: body.shipment_uuid,
        request: body, lineTotal: lines.length, lineSent: moves.length,
        suggested: posted.overRelease
          ? posted.conflictNote
          : (held > 0
            ? 'PARTIAL RELEASE. ' + released + ' of ' + posted.received +
            ' received has now been released; ' + held + ' is still in the ' +
            'on-hold bin. That remainder is either awaiting a later ' +
            'verification or it failed one. It will not move on its own - ' +
            'somebody resolves it, and this row is how it is found.'
            : null)
      });

      log.audit({
        title: 'RB release created Bin Transfer ' + btId,
        details: {
          orderId: orderId || null, receiptId: receiptId,
          locationId: locationId,
          // The RESOLVED bins, per line. `bins` holds only what the body
          // said, and after the ladder gained the receipt's own map a blank
          // there no longer means a blank on the transfer.
          bins: moves.map((m) => m.fromBin + '->' + m.toBin).filter(
            (v, i, a) => a.indexOf(v) === i),
          lines: moves.length, movedNow: posted.movedNow,
          releasedTotal: released, held: held,
          ledgerWritten: posted.written, overRelease: posted.overRelease
        }
      });

      return okEnvelope({
        bin_transfer_internal_id: btId,
        external_id: requestUuid,
        item_receipt_internal_id: receiptId,
        order_id: orderId || '',
        location_id: locationId,
        // THE RESOLVED pair, not what the body happened to say. Reported
        // only when the whole release agreed on one: once the bin ladder
        // could answer per lot, a single document-level bin could be a
        // half-truth, and `lines_released[].from_bin` / `.to_bin` always
        // carry the per-line answer anyway.
        from_bin: oneOf(moves, 'fromBin'), to_bin: oneOf(moves, 'toBin'),
        // THIS CALL moved this much.
        moved_quantity: posted.movedNow,
        // THE RECEIPT stands at this, cumulatively. The two differ on every
        // call after the first, and reporting only one of them is what made
        // a second release look reasonable.
        released_quantity: released,
        held_quantity: held,
        received_quantity: posted.received,
        fully_released: held === 0,
        // Every transfer that has released against this receipt, in order.
        // The same list the multiselect on the receipt now carries.
        bin_transfers: posted.bts,
        lines_released: moves.map((m) => ({
          line_unique_key: m.lineKey,
          item_id: m.itemId,
          lot: m.lotName,
          lot_internal_id: m.lotId,
          quantity: m.quantity,
          released_to_date: posted.perLot[m.key] === undefined
            ? m.quantity : posted.perLot[m.key],
          received: m.received,
          from_bin: m.fromBin, to_bin: m.toBin
        }))
      });
    };

    /** The Bin Transfer already carrying this request_uuid, if there is one. */
    const findBinTransfer = (requestUuid) => {
      if (!requestUuid) return '';
      let id = '';
      try {
        search.create({
          type: 'bintransfer',
          filters: [['externalid', 'is', requestUuid]],
          columns: ['internalid']
        }).run().each((r) => { id = String(r.id); return false; });
      } catch (e) {
        log.error({ title: 'RB-WRITE-013 findBinTransfer', details: { error: (e && e.message) || String(e) } });
      }
      return id;
    };

    /**
     * Which receipt this release is about.
     *
     * Named outright, or the receipt created from this order that carries the
     * shipment identifier. NOT guessed from the order alone: one order can be
     * received more than once, and stamping the wrong receipt is worse than
     * stamping none.
     */
    const resolveReceipt = (body, orderId) => {
      const named = String(body.item_receipt_internal_id ||
        body.receipt_internal_id || '').trim();
      if (named) return named;

      const shipment = String(body.shipment_uuid || '').trim();
      if (!shipment) return '';

      let id = '';
      try {
        const filters = [['mainline', 'is', 'T'], 'AND',
        [TXN.shipmentUuid, 'is', shipment]];
        if (orderId) filters.push('AND', ['createdfrom', 'anyof', orderId]);
        search.create({
          type: 'itemreceipt', filters: filters,
          columns: [search.createColumn({ name: 'internalid', sort: search.Sort.DESC })]
        }).run().each((r) => { id = String(r.id); return false; });
      } catch (e) {
        log.error({ title: 'RB-WRITE-014 resolveReceipt', details: (e && e.message) || String(e) });
        log.audit({
          title: 'RB release — receipt could not be found by shipment uuid',
          details: (e && e.message) || String(e)
        });
      }
      return id;
    };

    /** The receipt's own location, when nothing else named one. */
    const receiptLocation = (receiptId) => {
      if (!receiptId) return '';
      try {
        const v = search.lookupFields({
          type: 'itemreceipt', id: receiptId, columns: ['location']
        });
        return textOf(v.location);
      } catch (e) {
        log.error({ title: 'RB-WRITE-015 receiptLocation', details: (e && e.message) || String(e) }); return '';
      }
    };

    /**
     * THE TWO BINS, resolved once for the whole release — but kept in TWO
     * layers, because a middle rung sits between them.
     *
     *   from / to     what the PAYLOAD said. Body level; a line overrides.
     *   fromLoc/toLoc what CONFIGURATION says. The last word, not the first.
     *
     * They are not collapsed here, and that is the point. The full order of
     * preference for one release line is:
     *
     *   1. the line's own `good_bin`
     *   2. the body's `good_bin`                          <- out.to
     *   3. THE GOOD BIN THE RECEIPT RECORDED FOR THAT LOT <- the ledger
     *   4. the LOCATION's Good Bin                        <- out.toLoc
     *
     * Rung 3 is the one this split exists for. It is the receipt's own
     * memory of what the device said when the goods arrived, and it has to
     * beat a location-wide setting: an account that puts cold lots in one
     * good bin and ambient in another has nothing else that can say so.
     * Folding the location in at this point would have made rung 4 win
     * over rung 3 and quietly lose the distinction.
     *
     * Blank at the bottom of the ladder is a configuration error and the
     * line says so - Design §9.4.
     */
    /** The value every move agrees on, or '' when they do not. */
    const oneOf = (moves, field) => {
      const seen = [];
      moves.forEach((m) => {
        const v = String(m[field] || '');
        if (v && seen.indexOf(v) === -1) seen.push(v);
      });
      return seen.length === 1 ? seen[0] : '';
    };

    const releaseBins = (body, order, locationId, cfg) => {
      // ── THE RELEASE IS ABOUT THE GOOD BIN ─────────────────────────────
      //
      //    FROM is where the receipt already put the stock. The Middleware
      //    does not have to tell us; the receipt's map does, then the
      //    location, and the ledger proves the stock is there.
      //
      //    TO is the decision this call exists to carry. `good_bin` is its
      //    name; `to_bin` is accepted as the older spelling.
      const out = {
        from: String(body.from_bin || body.from_bin_id ||
          body.hold_bin || body.hold_bin_id || '').trim(),
        to: String(body.good_bin || body.good_bin_id ||
          body.to_bin || body.to_bin_id || '').trim(),
        fromLoc: '',
        toLoc: ''
      };

      let locHold = String(order.holdBin || '');
      let locGood = '';
      try {
        const L = C.MASTER.location.fields;
        const lv = search.lookupFields({
          type: 'location', id: locationId, columns: [L.holdBin, L.goodBin]
        });
        locHold = locHold || textOf(lv[L.holdBin]);
        locGood = textOf(lv[L.goodBin]);
      } catch (e) {
        log.error({ title: 'RB-WRITE-016 releaseBins', details: (e && e.message) || String(e) }); /* the fields are not deployed; the config default answers */
      }

      // FROM falls back to the configured Default Bin as well, because that
      // is the same ladder the RECEIPT used to choose where to put it - the
      // two must agree or the release looks in a bin the receipt never used.
      out.fromLoc = locHold || String(cfg.defaultBin || '');
      // TO does NOT fall back to the Default Bin. That field is the
      // RECEIVING default; sending verified stock to it would put it back
      // where it came from and call the job done.
      out.toLoc = locGood;
      return out;
    };

    /**
     * EVERY LOT NAME ON THE SUBMISSION, RESOLVED IN ONE SEARCH.
     *
     * A transaction line stores a lot as an internal id; the Middleware knows
     * it as the name TrackTrace printed. The bridge is `inventorynumber`,
     * filtered by the ITEMS on this release and by having stock - a lot with
     * nothing on hand cannot be what is being released, and excluding it keeps
     * the result set to what a warehouse actually holds.
     *
     * Matched case-insensitively and trimmed, because a scanner and a label
     * printer disagree about case more often than they agree.
     *
     * Keyed per ITEM, deliberately. Two items may legitimately use the same
     * lot name, and releasing item A's stock because item B has a lot of that
     * name is exactly the class of mistake this integration exists to prevent.
     */
    const readLotsByName = (lines, items) => {
      const byItem = {};
      const itemIds = [];
      const seen = {};
      lines.forEach((l) => {
        const id = String(l.item_id || '');
        if (!id || seen[id]) return;
        seen[id] = true;
        itemIds.push(id);
      });
      if (!itemIds.length) return byItem;

      try {
        search.create({
          type: 'inventorynumber',
          filters: [['item', 'anyof', itemIds], 'AND',
          ['quantityonhand', 'greaterthan', 0]],
          columns: ['internalid', 'inventorynumber', 'item', 'expirationdate']
        }).run().each((r) => {
          const itemId = String(r.getValue('item') || '');
          const name = String(r.getValue('inventorynumber') || '');
          if (!itemId || !name) return true;
          byItem[itemId] = byItem[itemId] || {};
          byItem[itemId][lotKey(name)] = {
            id: String(r.getValue('internalid') || r.id),
            name: name,
            expiry: textOf(r.getValue('expirationdate'))
          };
          return true;
        });
      } catch (e) {
        log.error({ title: 'RB-WRITE-017 readLotsByName', details: { error: (e && e.message) || String(e) } });
      }
      return byItem;
    };

    /** A lot name reduced to a comparison key. Case and padding fall away. */
    const lotKey = (v) => String(v === null || v === undefined ? '' : v)
      .trim().toUpperCase();

    /**
     * WHAT IS ACTUALLY IN THE ON-HOLD BIN, per item and lot. ONE search.
     *
     * `inventorybalance` is the only search that is bin-aware AND lot-aware at
     * once, which is exactly the question a release asks. Everything else -
     * the item's own quantity fields, the receipt's lines - answers a
     * different question and would let a release move stock that is not there.
     */
    const readHeldBalance = (lines, locationId, bins, ledger) => {
      const out = { rows: {}, indexed: false };
      const itemIds = [];
      const binIds = [];
      const seen = {};
      const addBin = (b) => {
        const k = String(b || '');
        if (k && !seen['b' + k]) { seen['b' + k] = true; binIds.push(k); }
      };
      lines.forEach((l) => {
        const id = String(l.item_id || '');
        if (id && !seen['i' + id]) { seen['i' + id] = true; itemIds.push(id); }
        addBin(l.from_bin || l.from_bin_id || l.hold_bin || l.hold_bin_id);
      });
      // EVERY BIN THE RELEASE COULD POSSIBLY READ FROM, not only the one
      // the body named. A per-lot hold bin recorded on the receipt is a
      // rung of the ladder now, so a balance search that only knew the body
      // bin would come back empty for exactly the lots that moved somewhere
      // else - and an empty result reads as a stale index, which would
      // silently skip the physical check on the rows that most need it.
      addBin(bins.from);
      addBin(bins.fromLoc);
      if (ledger && ledger.lots)
        Object.keys(ledger.lots).forEach((k) => addBin(ledger.lots[k].h));
      if (!itemIds.length || !binIds.length || !locationId) return out;

      const S = search.Summary;
      try {
        search.create({
          type: 'inventorybalance',
          filters: [['location', 'anyof', locationId], 'AND',
          ['item', 'anyof', itemIds], 'AND',
          ['binnumber', 'anyof', binIds]],
          columns: [
            search.createColumn({ name: 'item', summary: S.GROUP }),
            search.createColumn({ name: 'binnumber', summary: S.GROUP }),
            search.createColumn({ name: 'inventorynumber', summary: S.GROUP }),
            search.createColumn({ name: 'onhand', summary: S.SUM })
          ]
        }).run().each((r) => {
          out.indexed = true;
          const key = balanceKey(
            r.getValue({ name: 'item', summary: S.GROUP }),
            r.getValue({ name: 'binnumber', summary: S.GROUP }),
            r.getValue({ name: 'inventorynumber', summary: S.GROUP }));
          out.rows[key] = (out.rows[key] || 0) +
            (Number(r.getValue({ name: 'onhand', summary: S.SUM })) || 0);
          return true;
        });
      } catch (e) {
        log.error({ title: 'RB-WRITE-018 readHeldBalance', details: { error: (e && e.message) || String(e) } });
      }
      if (!out.indexed)
        log.audit({
          title: 'RB release — the on-hold bin reads as EMPTY',
          details: {
            locationId: locationId, bins: binIds, items: itemIds,
            effect: 'Treated as a SEARCH INDEX that has not caught up, not ' +
              'as missing stock. `inventorybalance` is an index and a ' +
              'release called seconds after its receipt can read nothing at ' +
              'all. The ledger is the authority on what may move; the ' +
              'balance only adds "and it is still physically there", which ' +
              'cannot be asserted either way from an empty result.'
          }
        });
      return out;
    };

    const balanceKey = (itemId, binId, lotId) =>
      String(itemId || '') + '|' + String(binId || '') + '|' + String(lotId || '');

    /**
     * One release line, validated into one move. THROWS a C.LINE_ERR.
     *
     * Nothing here is forgiving, and that is deliberate. A release says "this
     * stock passed verification and may be picked". Every shortcut taken at
     * this point is a shortcut taken on a regulated product.
     */
    const validateRelease = (ln, ctx) => {
      const key = ln.line_unique_key === undefined ? '' : String(ln.line_unique_key);
      const itemId = String(ln.item_id || '').trim();
      const info = ctx.items[itemId] || {};

      if (!itemId)
        throw err(C.LINE_ERR.ITEM_NOT_FOUND,
          'Release line ' + key + ' names no item.');
      if (!ctx.items[itemId])
        throw err(C.LINE_ERR.ITEM_NOT_FOUND,
          'Release line ' + key + ' names item ' + itemId +
          ', which does not exist in this account.');
      if (info.inactive)
        throw err(C.LINE_ERR.ITEM_INACTIVE,
          'Item ' + txn.named(info.name, itemId) + ' is inactive.');
      // THERE IS NO RELEASE FOR AN ITEM TRACKTRACERX DOES NOT TRACK. It was
      // never put in a hold bin, nothing is verifying it, and nothing is
      // waiting on it.
      if (info.eligible !== true)
        throw err(C.LINE_ERR.NOT_ELIGIBLE,
          'Item ' + txn.named(info.name, itemId) + ' on release line ' + key +
          ' is not eligible for TrackTraceRX, so it was never held and ' +
          'there is nothing to release. Take the line off the release; the ' +
          'stock is already where the receipt put it.');

      const qty = Number(ln.quantity);
      if (!(qty > 0))
        throw err(C.LINE_ERR.BAD_QUANTITY,
          'Release line ' + key + ' has quantity "' + ln.quantity + '".');

      // ── THE LOT. Resolved BEFORE the bins now, because the receipt's
      //    own memory of this lot's bins is one rung of the bin ladder and
      //    the lot is what addresses it.
      const lotName = String(ln.lot || ln.lot_number || ln.lot_name || '').trim();
      const tracked = info.isLot || info.isSerial;
      let lot = null;

      if (tracked) {
        if (!lotName)
          throw err(C.LINE_ERR.LOT_INVALID,
            'Item ' + txn.named(info.name, itemId) + ' is lot or serial ' +
            'tracked, so release line ' + key + ' must name the lot being ' +
            'released. A release without one would move an arbitrary lot.');
        lot = (ctx.lots[itemId] || {})[lotKey(lotName)] || null;
        if (!lot) {
          const offers = Object.keys(ctx.lots[itemId] || {}).length;
          throw err(C.LINE_ERR.LOT_NOT_FOUND,
            'Lot "' + lotName + '" is not an on-hand lot of ' +
            txn.named(info.name, itemId) + '. ' +
            (offers
              ? 'That item has ' + offers + ' lot(s) with stock; this is not ' +
              'one of them.'
              : 'That item has no stock on hand at all.') +
            ' The release does not create lots: it moves stock that already ' +
            'exists, and a lot created here would be an empty record nobody ' +
            'asked for.');
        }
      }

      // ══ THE BINS, FOUR RUNGS EACH ══════════════════════════════════════
      //
      //   1. the LINE's own bin           - this call, this lot
      //   2. the BODY's bin               - this call, every lot
      //   3. WHAT THE RECEIPT RECORDED    - the bin/lot map, per lot
      //   4. the LOCATION's configured bin
      //
      // Rung 3 is what the Item Receipt's bin/lot map stored at the moment
      // the goods arrived, carried into the ledger when it was seeded. It
      // is the only rung that can be different for two lots of the same
      // item at the same site, which is precisely what a warehouse with a
      // cold good bin and an ambient one needs.
      //
      // It sits BELOW the payload because a release that names a bin is a
      // decision somebody is making now, and above the location because a
      // site-wide setting cannot know which lot this is.
      const stored = ctx.ledger.lots[lotLedgerKey(itemId, lot ? lot.id : '')] || {};
      const pick = entryForRelease(stored, qty) || {};
      const paidFrom = String(ln.from_bin || ln.from_bin_id ||
        ln.hold_bin || ln.hold_bin_id || ctx.bins.from || '').trim();
      const paidTo = String(ln.good_bin || ln.good_bin_id ||
        ln.to_bin || ln.to_bin_id || ctx.bins.to || '').trim();

      // ── THE RECEIPT SPLIT THIS LOT AND THIS QUANTITY FITS NEITHER PART
      //
      //    10 went to the cold bin and 4 to the ambient one; a release of
      //    7 belongs to neither. The payload can still say which - that is
      //    a decision somebody is making now - but nothing here will pick
      //    one, because a guessed bin on a regulated product is the exact
      //    failure the map exists to prevent.
      if (pick.ambiguous && !paidTo)
        throw err(C.LINE_ERR.BIN_NOT_CONFIGURED,
          'Release line ' + key + ' asks to move ' + qty + ' of ' +
          (lot ? 'lot "' + lot.name + '" ' : '') + 'but Item Receipt ' +
          ctx.receiptId + ' split that lot across good bins and ' + qty +
          ' matches none of the parts: ' + pick.ambiguous.join(', ') + '. ' +
          'Send `good_bin` on the release line to say which, or release ' +
          'each part in its own line with the quantity the receipt ' +
          'recorded. Nothing is chosen for you here - a guessed bin on a ' +
          'tracked lot is what this record exists to prevent.');

      const fromBin = String(paidFrom || pick.h || ctx.bins.fromLoc || '').trim();
      const toBin = String(paidTo || pick.g || ctx.bins.toLoc || '').trim();
      if (!fromBin)
        throw err(C.LINE_ERR.BIN_NOT_CONFIGURED,
          'Release line ' + key + ' names no from_bin, Item Receipt ' +
          ctx.receiptId + ' recorded none for this lot, and no on-hold bin ' +
          'is set on the location or the RapidBridge Configuration. There ' +
          'is nothing to move the stock out of.');
      if (!toBin)
        throw err(C.LINE_ERR.BIN_NOT_CONFIGURED,
          'Release line ' + key + ' names no good_bin, Item Receipt ' +
          ctx.receiptId + ' recorded none for this lot, and no Good Bin is ' +
          'set on location ' + ctx.locationId + '. Blank in all three ' +
          'places is a configuration error, not a default: the Default Bin ' +
          'on the RapidBridge Configuration is the RECEIVING default, and ' +
          'releasing into it would put verified stock back where it came ' +
          'from.');
      if (fromBin === toBin)
        throw err(C.LINE_ERR.BIN_NOT_CONFIGURED,
          'Release line ' + key + ' moves stock from bin ' + fromBin +
          ' to the same bin. A transfer that changes nothing is a ' +
          'misconfiguration, not a no-op worth saving.');

      // ══ THE LEDGER. THE AUTHORITY ON WHAT MAY STILL MOVE. ═══════════════
      //
      // Everything above this point says the request is coherent. This says
      // whether it has already been honoured - which is the question a
      // RESEND asks, and the one neither externalId nor the bin's balance
      // can answer.
      const lk = lotLedgerKey(itemId, lot ? lot.id : '');
      const row = ctx.ledger.lots[lk];
      if (!row)
        throw err(C.LINE_ERR.LOT_NOT_ON_RECEIPT,
          (lot ? 'Lot "' + lot.name + '" of ' : '') +
          txn.named(info.name, itemId) + ' is not something Item Receipt ' +
          ctx.receiptId + ' received. It may be perfectly real and sitting in ' +
          'bin ' + fromBin + ' - but it was put there by a DIFFERENT ' +
          'receipt, and releasing it against this one would move somebody ' +
          'else\'s goods. Several receipts share one on-hold bin.');

      const already = Number(row.released) || 0;
      const inThisCall = Number(ctx.claimed[lk]) || 0;
      const received = Number(row.received) || 0;
      const left = received - already - inThisCall;

      if (left <= 0)
        throw err(C.LINE_ERR.ALREADY_RELEASED,
          'All ' + received + ' of ' +
          (lot ? 'lot "' + lot.name + '" of ' : '') +
          txn.named(info.name, itemId) + ' received on Item Receipt ' +
          ctx.receiptId + ' has already been released' +
          (inThisCall ? ' (' + inThisCall + ' of it earlier in THIS ' +
            'submission)' : '') + '. This call would move it a second time. ' +
          'If stock genuinely needs moving again, it is a bin transfer ' +
          'somebody makes in NetSuite, not a release.');

      if (qty > left)
        throw err(C.LINE_ERR.QTY_EXCEEDS_RECEIVED,
          'Release line ' + key + ' asks to move ' + qty + ' of ' +
          (lot ? 'lot "' + lot.name + '", ' : '') +
          txn.named(info.name, itemId) + ' but Item Receipt ' + ctx.receiptId +
          ' received ' + received + ' and ' + (already + inThisCall) +
          ' has already been released. ' + left + ' is still releasable.');

      // ── AND IS IT STILL PHYSICALLY IN THE ON-HOLD BIN?
      //
      //    A SECOND check, not the primary one. The ledger says what MAY
      //    move; this says whether it is still there to move. It is advisory
      //    when the index has not caught up - see readHeldBalance - because
      //    `inventorybalance` returning nothing at all is far more often a
      //    stale index than a vanished pallet, and refusing a legitimate
      //    release seconds after its receipt is the worse failure.
      if (ctx.balance.indexed) {
        const have = Number(
          ctx.balance.rows[balanceKey(itemId, fromBin, lot ? lot.id : '')]) || 0;
        if (!have)
          throw err(C.LINE_ERR.LOT_NOT_IN_BIN,
            (lot ? 'Lot "' + lot.name + '" of ' : '') +
            txn.named(info.name, itemId) + ' has nothing on hand in bin ' +
            fromBin + ', though Item Receipt ' + ctx.receiptId + ' still has ' +
            left + ' of it unreleased. Somebody moved it by hand. The ' +
            'release will not guess where it went - find it first.');
        if (qty > have)
          throw err(C.LINE_ERR.QTY_EXCEEDS_IN_BIN,
            'Release line ' + key + ' asks to move ' + qty + ' of ' +
            (lot ? 'lot "' + lot.name + '", ' : '') +
            txn.named(info.name, itemId) + ' but bin ' + fromBin + ' holds ' +
            have + '. Releasing more than is there is a discrepancy to ' +
            'investigate, not a quantity to accept.');
      }

      ctx.claimed[lk] = inThisCall + qty;

      return {
        lineKey: key, key: lk, itemId: itemId, itemName: info.name || '',
        lotId: lot ? lot.id : '', lotName: lot ? lot.name : (row.lot || ''),
        quantity: qty, received: received, releasedBefore: already,
        fromBin: fromBin, toBin: toBin,
        // WHICH split entry this spent, so commitLedger can mark it. -1 or
        // undefined means the lot was never split and there is nothing to
        // mark.
        entry: pick.i === undefined ? -1 : pick.i
      };
    };

    // heldAfter() AND movedFor() LIVED HERE AND ARE GONE.
    //
    // They measured what stayed behind by subtracting this call's moves from
    // an `inventorybalance` read. Two things were wrong with that. The bin is
    // SHARED, so the balance included other receipts' stock and the held
    // figure was somebody else's. And the balance is a search INDEX, so a
    // release called seconds after its receipt measured against a stale
    // number. `ledgerHeld` answers from the receipt's own entitlements
    // instead - exact, immediate, and about this receipt only.

    /**
     * ONE Bin Transfer for the whole release.
     *
     * Grouped by ITEM, because the `inventory` sublist carries one line per
     * item and the lots hang off that line's inventory detail. Two lots of one
     * item are two inventory ASSIGNMENTS on one sublist line, not two lines.
     *
     * ── THE BIN FIELDS, AND WHY THEY ARE SET TWICE ────────────────────────
     *
     * A Bin Transfer names its source and destination bins on the inventory
     * ASSIGNMENT - `binnumber` and `tobinnumber`. On a non-tracked item with
     * bins the same pair appears on the sublist LINE instead. The setters
     * below are no-ops when a field is not on the form, so both are written
     * and whichever the account's configuration exposes is the one that takes.
     * This is the one thing in this handler that wants confirming on the first
     * live run.
     */
    const buildBinTransfer = (moves, o) => {
      const bt = record.create({ type: 'bintransfer', isDynamic: true });

      // §4.1.2 — the duplicate guard, claimed before anything else.
      try { bt.setValue({ fieldId: 'externalid', value: o.requestUuid }); }
      catch (e) {
        log.error({ title: 'RB-WRITE-019 buildBinTransfer', details: (e && e.message) || String(e) }); /* not settable on this form; findBinTransfer still guards */
      }

      try { bt.setValue({ fieldId: 'location', value: o.locationId }); }
      catch (e) {
        log.error({ title: 'RB-WRITE-020 buildBinTransfer', details: (e && e.message) || String(e) }); /* mandatory - the save will say so */
      }

      const d = parseDate(o.date);
      if (d) {
        try { bt.setValue({ fieldId: 'trandate', value: d }); } catch (e) {
          log.error({ title: 'RB-WRITE-021 buildBinTransfer', details: (e && e.message) || String(e) });
        }
      }
      try {
        bt.setValue({
          fieldId: 'memo',
          value: String(o.memo || 'RapidBridge inventory release ' + o.requestUuid)
            .substring(0, 999)
        });
      } catch (e) {
        log.error({ title: 'RB-WRITE-022 buildBinTransfer', details: (e && e.message) || String(e) });
      }

      // ══ ONE LINE PER ITEM, AND THE BINS GO ON THE DETAIL ══════════════
      //
      // The shape the Middleware sends and the shape NetSuite wants are
      // the same shape:
      //
      //   [{ "item":"A", "quantity":13, "inventory":[
      //       {"lot":1,"quantity":10,"from_bin":49,"to_bin":50},
      //       {"lot":2,"quantity":1, "from_bin":48,"to_bin":50},
      //       {"lot":3,"quantity":1, "from_bin":49,"to_bin":51},
      //       {"lot":3,"quantity":1, "from_bin":48,"to_bin":51}]}]
      //
      // One inventory line carrying the item and the total, and one
      // inventory-assignment row per movement, each with its own pair of
      // bins. Note the last two: the SAME LOT, out of two different hold
      // bins, into two different good bins. That is what a shared on-hold
      // bin produces in practice and no line-level pair of bins can
      // express it.
      //
      // ── EXCEPT WHEN THERE IS NO DETAIL TO PUT THEM ON ─────────────────
      //
      // An item that is neither lot nor serial tracked has no inventory
      // detail subrecord at all, so for it the LINE is the move and the
      // bins have nowhere else to go. Those are grouped by item AND both
      // bins, one line per distinct movement - otherwise the second
      // movement's bins would simply be discarded.
      const order = [];
      const byKey = {};
      moves.forEach((m) => {
        const info = (o.items || {})[m.itemId] || {};
        const tracked = info.isLot === true || info.isSerial === true || !!m.lotId;
        const k = tracked
          ? m.itemId
          : m.itemId + '|' + m.fromBin + '|' + m.toBin;
        if (!byKey[k]) { byKey[k] = { tracked: tracked, moves: [] }; order.push(k); }
        byKey[k].moves.push(m);
      });

      order.forEach((k) => {
        const group = byKey[k].moves;
        const itemId = group[0].itemId;
        const total = round6(group.reduce((n, m) => n + m.quantity, 0));

        bt.selectNewLine({ sublistId: 'inventory' });
        btSet(bt, 'item', itemId);
        btSet(bt, 'quantity', total);

        // The line-level bins are set only when the whole line agrees on
        // them. For a tracked item they are decoration - NetSuite derives
        // the movement from the inventory detail - and naming one of
        // several there would contradict the rows beneath it.
        const from = oneOf(group, 'fromBin');
        const to = oneOf(group, 'toBin');
        if (from) {
          btSet(bt, 'binnumber', from);
          btSet(bt, 'previousbinnumber', from);
        }
        if (to) btSet(bt, 'tobinnumber', to);

        let sub = null;
        try {
          sub = bt.getCurrentSublistSubrecord({
            sublistId: 'inventory', fieldId: 'inventorydetail'
          });
        } catch (e) {
          log.error({ title: 'RB-WRITE-023 buildBinTransfer', details: (e && e.message) || String(e) }); sub = null;
        }

        if (sub) {
          group.forEach((m) => {
            sub.selectNewLine({ sublistId: 'inventoryassignment' });
            // The lot is ISSUED from the on-hold bin. By VALUE, not text: it
            // already exists, and resolving it by name here would re-open the
            // ambiguity readLotsByName just closed.
            if (m.lotId) subSet(sub, 'issueinventorynumber', m.lotId);
            subSet(sub, 'binnumber', m.fromBin);
            subSet(sub, 'tobinnumber', m.toBin);
            subSet(sub, 'quantity', m.quantity);
            sub.commitLine({ sublistId: 'inventoryassignment' });
          });
        } else if (byKey[k].tracked && group.length > 1) {
          // A tracked item whose subrecord would not open. The bins cannot
          // all be expressed on one line, and saving it would move the
          // whole quantity through the first pair.
          throw new Error('Item ' + itemId + ' moves ' + group.length +
            ' lots through different bins, but its inventory detail could ' +
            'not be opened on the Bin Transfer. The bins can only be ' +
            'recorded per lot on that subrecord, so NOTHING was saved ' +
            'rather than moving all ' + total + ' through ' +
            group[0].fromBin + ' -> ' + group[0].toBin + '.');
        }

        bt.commitLine({ sublistId: 'inventory' });
      });

      return bt.save({ enableSourcing: true, ignoreMandatoryFields: true });
    };

    const btSet = (bt, fieldId, value) => {
      try {
        bt.setCurrentSublistValue({
          sublistId: 'inventory', fieldId: fieldId, value: value
        });
      } catch (e) {
        log.error({
          title: 'RB-WRITE-024 btSet', details: {
            field: fieldId, error: (e && e.message) || String(e),
            note: 'Not on the Bin Transfer form.'
          }
        });
      }
    };

    // ═══════════════════════════════════════════════════════════════════════
    // The release ledger — the duplicate guard that externalId cannot be
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * WHY THIS EXISTS.
     *
     * v1.0 leaned on two guards and neither is enough on its own:
     *
     *   request_uuid in the native externalId  catches a RESEND OF THE SAME
     *       CALL. It does not catch a second call carrying a FRESH uuid for
     *       the same lot - which is exactly what a Middleware retry after a
     *       timeout looks like, because a retry that reuses the uuid is only
     *       one of the two things middleware does.
     *
     *   the on-hold bin's balance  is SHARED between receipts and it LAGS.
     *       Shared: several receipts put stock in one hold bin, so a balance
     *       of 24 says nothing about whose 24 it is, and a second release
     *       would cheerfully move another receipt's goods. Lagging:
     *       `inventorybalance` is a search index, so a release called
     *       seconds after its receipt can read a number that is not true
     *       yet - in either direction.
     *
     * THE LEDGER HAS NEITHER PROBLEM. It is a Long Text field on the Item
     * Receipt, so it is per receipt; it is a stored field, so it reads back
     * immediately and exactly; and it records what was RECEIVED per lot
     * alongside what has been RELEASED per lot, which is the only pair of
     * numbers that can answer "may this move?".
     *
     * `custbody_jj_rb_release_log`, shape documented on C.TXN.releaseLog.
     */
    const emptyLedger = (receiptId) => ({
      receipt: String(receiptId || ''),
      seq: 0,
      updated: '',
      lots: {},
      calls: [],
      bts: [],
      callCount: 0,
      lotCount: 0
    });

    /** item + lot, the ledger's key. A non-tracked item keys on the item alone. */
    const lotLedgerKey = (itemId, lotId) =>
      String(itemId || '') + '|' + String(lotId || '');

    /**
     * The ledger as stored. ONE lookupFields.
     *
     * Unparseable JSON is NOT silently replaced with an empty ledger - that
     * would hand a duplicate release a clean slate, which is the one outcome
     * this whole mechanism exists to prevent. It is kept as a raw string on
     * the result, the seed is refused, and the release fails loudly.
     */
    const readLedger = (receiptId) => {
      const out = emptyLedger(receiptId);
      if (!receiptId) return out;
      let raw = '';
      try {
        const v = search.lookupFields({
          type: 'itemreceipt', id: receiptId, columns: [TXN.releaseLog]
        });
        raw = textOf(v[TXN.releaseLog]);
      } catch (e) {
        log.error({ title: 'RB-WRITE-025 readLedger', details: (e && e.message) || String(e) });
        log.audit({
          title: 'RB release ledger could not be read: itemreceipt/' + receiptId,
          details: (e && e.message) || String(e)
        });
        return out;
      }
      if (!raw) return out;

      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) {
        log.error({ title: 'RB-WRITE-026 readLedger', details: (e && e.message) || String(e) }); parsed = null;
      }
      if (!parsed || typeof parsed !== 'object') {
        log.error({
          title: 'RB-WRITE-027 readLedger', details: {
            context: 'RB release ledger is not valid JSON: itemreceipt/' + receiptId, raw: String(raw).substring(0, 500),
            effect: 'The release is refused. Replacing it with an empty ' +
              'ledger would give a duplicate call a clean slate, which is ' +
              'the one thing this field exists to prevent.'
          }
        });
        out.corrupt = true;
        return out;
      }

      out.seq = Number(parsed.seq) || 0;
      out.updated = String(parsed.updated || '');
      out.lots = (parsed.lots && typeof parsed.lots === 'object') ? parsed.lots : {};
      out.calls = Array.isArray(parsed.calls) ? parsed.calls : [];
      // EVERY Bin Transfer that has released against this receipt, kept
      // separately from `calls` because `calls` is capped and this list is
      // what the multiselect on the receipt is built from. Losing an id
      // would unlink a transfer that really happened.
      out.bts = Array.isArray(parsed.bts) ? parsed.bts.map(String) : [];
      if (!out.bts.length)
        out.calls.forEach((c) => {
          const b = String((c && c.bt) || '');
          if (b && out.bts.indexOf(b) === -1) out.bts.push(b);
        });
      out.callCount = Number(parsed.callCount) || out.calls.length;
      out.lotCount = Object.keys(out.lots).length;
      return out;
    };

    /**
     * FIRST RELEASE ONLY. What this receipt actually received, per lot.
     *
     * Read ONCE in a receipt's life and then carried in the stored JSON, so
     * the cost is one read per receipt rather than one per release.
     *
     * Two ways in, because the join is not available in every account:
     *
     *   1. A transaction search with the `inventoryDetail` join - one search,
     *      and the cheap answer.
     *   2. `record.load` of the receipt and its inventory detail subrecords -
     *      10 units plus the sublist reads, and it always works.
     *
     * An item with NO inventory detail (not lot or serial tracked) still gets
     * a row, keyed on the item alone, so a bin-only release has an
     * entitlement to measure against too.
     */
    const seedLedger = (receiptId, ledger, cfg) => {
      if (ledger.corrupt) return ledger;
      const seeded = ledger;
      let got = seedFromSearch(receiptId, seeded);
      if (!got) got = seedFromLoad(receiptId, seeded);

      // ══ NON-ELIGIBLE ITEMS ARE NOT PART OF A RELEASE ══════════════════
      //
      // An item TrackTraceRX does not track never goes to a hold bin, never
      // waits for verification and has nothing to be released. Carrying it
      // in the ledger would be worse than useless: `held_quantity` would
      // count stock nobody is ever going to release, so a receipt would
      // never read fully released and every release on it would sit on the
      // worklist for good.
      //
      // The entitlements are dropped, and the receipt remembers how many
      // were dropped so a reader is not left wondering where the lines
      // went.
      const ids = [];
      Object.keys(seeded.lots).forEach((k) => {
        const i = String(seeded.lots[k].item || '');
        if (i && ids.indexOf(i) === -1) ids.push(i);
      });
      const info = itemInfo(ids, cfg, {});
      let dropped = 0;
      Object.keys(seeded.lots).forEach((k) => {
        const i = String(seeded.lots[k].item || '');
        if ((info[i] || {}).eligible !== true) { delete seeded.lots[k]; dropped++; }
      });
      seeded.skipped = dropped;

      seeded.lotCount = Object.keys(seeded.lots).length;
      log.audit({
        title: 'RB release ledger seeded for itemreceipt/' + receiptId,
        details: {
          via: got || 'nothing', eligibleLots: seeded.lotCount,
          nonEligibleDropped: dropped,
          rule: 'Only items eligible for TrackTraceRX can be released. The ' +
            'rest were never held and have nothing to move.'
        }
      });
      return seeded;
    };

    /**
     * ONE ENTITLEMENT ROW, and the two bins that belong to it.
     *
     * `h` and `g` come from the LINE's bin/lot map - what the device said
     * when the goods arrived. They are carried into the ledger at seed time
     * so that every later release answers from one stored field instead of
     * re-reading the receipt's lines, and so that a release is measuring
     * entitlement and destination against the same record.
     *
     * Only written when there is something to write. A receipt created
     * before the map existed seeds rows with neither, and the release falls
     * through to the location's bins exactly as it did then.
     */
    const addEntitlement = (ledger, itemId, lotId, lotName, qty, entries) => {
      const k = lotLedgerKey(itemId, lotId);
      const row = ledger.lots[k] ||
      {
        item: String(itemId), lotId: String(lotId || ''),
        lot: String(lotName || ''), received: 0, released: 0
      };
      row.received = (Number(row.received) || 0) + (Number(qty) || 0);
      if (!row.lot && lotName) row.lot = String(lotName);
      if (entries && entries.length) {
        // ONE entry of quantity 0 is the line's own pair, not a split, so
        // it is stored flat as h/g and the release reads it as "any
        // quantity". Anything else is the split, and `b` keeps it with a
        // fourth number for how much has gone.
        if (entries.length === 1 && !entries[0].q) {
          if (entries[0].h && !row.h) row.h = String(entries[0].h);
          if (entries[0].g && !row.g) row.g = String(entries[0].g);
        } else if (!row.b) {
          row.b = entries.map((e) => [e.q, e.h || '', e.g || '', 0]);
        }
      }
      ledger.lots[k] = row;
    };

    const seedFromSearch = (receiptId, ledger) => {
      let rows = 0;
      const mapCache = {};
      try {
        search.create({
          type: 'itemreceipt',
          filters: [['internalid', 'anyof', receiptId], 'AND',
          ['mainline', 'is', 'F'], 'AND', ['taxline', 'is', 'F'], 'AND',
          ['shipping', 'is', 'F']],
          columns: [
            'item',
            search.createColumn({ name: 'inventorynumber', join: 'inventoryDetail' }),
            search.createColumn({ name: 'quantity', join: 'inventoryDetail' }),
            'quantity',
            // WHERE THE DEVICE SAID EACH LOT WENT, AND WHERE IT GOES NEXT.
            // One column on a search that was already running; the map is
            // parsed once per distinct line value, not once per row.
            C.LINE.binMap
          ]
        }).run().each((r) => {
          const itemId = String(r.getValue('item') || '');
          if (!itemId) return true;
          const lotId = String(r.getValue({
            name: 'inventorynumber', join: 'inventoryDetail'
          }) || '');
          const lotName = r.getText({
            name: 'inventorynumber', join: 'inventoryDetail'
          }) || '';
          const dq = Number(r.getValue({
            name: 'quantity', join: 'inventoryDetail'
          }));
          const lq = Math.abs(Number(r.getValue('quantity')) || 0);
          let raw = '';
          try { raw = String(r.getValue(C.LINE.binMap) || ''); } catch (e) {
            log.error({ title: 'RB-WRITE-028 seedFromSearch', details: (e && e.message) || String(e) }); raw = '';
          }
          if (raw && !mapCache[raw]) mapCache[raw] = parseBinMap(raw);
          addEntitlement(ledger, itemId, lotId, lotName,
            Math.abs(dq || 0) || (lotId ? 0 : lq),
            raw ? binMapFor(mapCache[raw], lotName) : null);
          rows++;
          return true;
        });
      } catch (e) {
        log.error({ title: 'RB-WRITE-029 seedFromSearch', details: (e && e.message) || String(e) });
        log.audit({
          title: 'RB release ledger — the inventoryDetail join is not available',
          details: (e && e.message) || String(e)
        });
        return '';
      }
      return rows ? 'search' : '';
    };

    const seedFromLoad = (receiptId, ledger) => {
      let rec;
      try { rec = record.load({ type: 'itemreceipt', id: receiptId, isDynamic: false }); }
      catch (e) {
        log.error({ title: 'RB-WRITE-030 seedFromLoad', details: { context: 'RB release ledger — itemreceipt/' + receiptId + ' would not load', error: (e && e.message) || String(e) } });
        return '';
      }
      let n = 0;
      try { n = rec.getLineCount({ sublistId: 'item' }); } catch (e) {
        log.error({ title: 'RB-WRITE-031 seedFromLoad', details: (e && e.message) || String(e) }); n = 0;
      }
      let rows = 0;
      for (let i = 0; i < n; i++) {
        const g = (f) => {
          try { return rec.getSublistValue({ sublistId: 'item', fieldId: f, line: i }); }
          catch (e) {
            log.error({ title: 'RB-WRITE-032 g', details: (e && e.message) || String(e) }); return '';
          }
        };
        const itemId = String(g('item') || '');
        if (!itemId) continue;
        const lineQty = Math.abs(Number(g('quantity')) || 0);
        // The line's bin/lot map, parsed once per line.
        const lineMap = parseBinMap(g(C.LINE.binMap));

        let sub = null;
        try {
          sub = rec.getSublistSubrecord({
            sublistId: 'item', fieldId: 'inventorydetail', line: i
          });
        } catch (e) {
          log.error({ title: 'RB-WRITE-033 seedFromLoad', details: (e && e.message) || String(e) }); sub = null;
        }

        if (!sub) {
          addEntitlement(ledger, itemId, '', '', lineQty, binMapFor(lineMap, ''));
          rows++;
          continue;
        }
        let m = 0;
        try { m = sub.getLineCount({ sublistId: 'inventoryassignment' }); }
        catch (e) {
          log.error({ title: 'RB-WRITE-034 seedFromLoad', details: (e && e.message) || String(e) }); m = 0;
        }
        if (!m) {
          addEntitlement(ledger, itemId, '', '', lineQty, binMapFor(lineMap, ''));
          rows++; continue;
        }
        for (let j = 0; j < m; j++) {
          const sg = (f, text) => {
            try {
              return text
                ? sub.getSublistText({ sublistId: 'inventoryassignment', fieldId: f, line: j })
                : sub.getSublistValue({ sublistId: 'inventoryassignment', fieldId: f, line: j });
            } catch (e) {
              log.error({ title: 'RB-WRITE-035 sg', details: (e && e.message) || String(e) }); return '';
            }
          };
          const nm = String(sg('receiptinventorynumber', true) ||
            sg('issueinventorynumber', true) || '');
          addEntitlement(ledger, itemId,
            String(sg('receiptinventorynumber') || sg('issueinventorynumber') || ''),
            nm, Math.abs(Number(sg('quantity')) || 0), binMapFor(lineMap, nm));
          rows++;
        }
      }
      return rows ? 'load' : '';
    };

    const ledgerReleased = (ledger) => round6(Object.keys(ledger.lots)
      .reduce((n, k) => n + (Number(ledger.lots[k].released) || 0), 0));
    const ledgerReceived = (ledger) => round6(Object.keys(ledger.lots)
      .reduce((n, k) => n + (Number(ledger.lots[k].received) || 0), 0));
    const ledgerHeld = (ledger) => round6(Object.keys(ledger.lots)
      .reduce((n, k) => n + Math.max(0,
        (Number(ledger.lots[k].received) || 0) -
        (Number(ledger.lots[k].released) || 0)), 0));
    const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

    /**
     * POST THE MOVES TO THE LEDGER, AND STAMP THE RECEIPT. One submitFields.
     *
     * ── WHY IT RE-READS ───────────────────────────────────────────────────
     *
     * The copy read before the save is STALE by the time we get here: the
     * transfer took a moment, and another release could have landed in it.
     * Writing that copy back would silently undo the other call's figures -
     * a lost update, and the worst possible one, because the quantity it
     * loses is the one guarding against a double move.
     *
     * So the merge is onto a FRESH read. The remaining window is between
     * that read and the submitFields, which is milliseconds; NetSuite offers
     * no row lock that would close it entirely, and pretending otherwise
     * would be worse than saying so.
     *
     * ── AND IF THE FRESH READ SAYS WE ARE OVER ───────────────────────────
     *
     * The transfer is already saved; it cannot be un-saved by wishing. The
     * ledger is written anyway - it must stay a true record of what moved -
     * and the call returns `overRelease`, which makes the Sync Log row a
     * FAILURE with an open work item naming the lots. Somebody reverses it
     * by hand. Hiding it would leave the ledger right and the stock wrong.
     */
    const commitLedger = (receiptId, requestUuid, btId, moves, seeded) => {
      const movedNow = round6(moves.reduce((n, m) => n + m.quantity, 0));
      const fresh = readLedger(receiptId);
      let ledger;

      if (!fresh.corrupt && fresh.lotCount) {
        // The normal path from the second release onwards: a stored ledger
        // exists and it may have moved on since this call read it.
        ledger = fresh;
      } else {
        // FIRST RELEASE for this receipt - the entitlements were seeded in
        // memory and have never been stored, so a fresh read finds nothing.
        // They are the whole guard, and writing only the lots THIS call
        // touched would quietly forget the rest of the receipt.
        ledger = emptyLedger(receiptId);
        Object.keys((seeded && seeded.lots) || {}).forEach((k) => {
          const r = seeded.lots[k];
          ledger.lots[k] = {
            item: r.item, lotId: r.lotId, lot: r.lot,
            received: Number(r.received) || 0, released: Number(r.released) || 0
          };
          // The bins the receipt recorded. Carried through the FIRST write
          // or they are lost: the seed is in memory only, and the next
          // release reads this field, not the receipt's lines.
          if (r.h) ledger.lots[k].h = String(r.h);
          if (r.g) ledger.lots[k].g = String(r.g);
          if (r.b) ledger.lots[k].b = r.b.map((t) => t.slice());
        });
        // And if even that is empty - a corrupt field cleared by hand - at
        // least record what this call knows, rather than writing nothing.
        moves.forEach((m) => {
          if (ledger.lots[m.key]) return;
          ledger.lots[m.key] = {
            item: m.itemId, lotId: m.lotId, lot: m.lotName,
            received: m.received, released: m.releasedBefore
          };
        });
      }

      // Another worker may already have recorded this very call.
      if (ledger.calls.filter((c) => c.uuid === requestUuid).length) {
        log.audit({
          title: 'RB release ledger already carries ' + requestUuid,
          details: {
            receiptId: receiptId, binTransfer: btId,
            note: 'Another call recorded it first. Not applied twice.'
          }
        });
        return {
          written: false, overRelease: false, movedNow: movedNow,
          released: ledgerReleased(ledger), held: ledgerHeld(ledger),
          received: ledgerReceived(ledger), bts: ledger.bts.slice(),
          perLot: perLotReleased(ledger, moves)
        };
      }

      const over = [];
      moves.forEach((m) => {
        const row = ledger.lots[m.key] ||
        {
          item: m.itemId, lotId: m.lotId, lot: m.lotName,
          received: m.received, released: 0
        };
        row.released = round6((Number(row.released) || 0) + m.quantity);
        // A row invented here (a hand-cleared field) still learns its bins
        // from the move that is being recorded against it.
        if (!row.h && m.fromBin) row.h = String(m.fromBin);
        if (!row.g && m.toBin) row.g = String(m.toBin);
        // AND THE SPLIT ENTRY THIS MOVE SPENT. Without this the lot that
        // was received 10-to-one-bin and 4-to-another would hand the same
        // 10 to a second release, which is the whole reason the entries
        // carry a fourth number.
        if (m.entry >= 0 && Array.isArray(row.b) && row.b[m.entry])
          row.b[m.entry][3] = round6((Number(row.b[m.entry][3]) || 0) + m.quantity);
        if (row.released > (Number(row.received) || 0) + 1e-9)
          over.push((m.lotName || m.itemName || m.itemId) + ': released ' +
            row.released + ' of ' + row.received + ' received');
        ledger.lots[m.key] = row;
      });

      ledger.seq = (Number(ledger.seq) || 0) + 1;
      ledger.updated = new Date().toISOString();
      ledger.callCount = (Number(ledger.callCount) || 0) + 1;
      if (ledger.bts.indexOf(String(btId)) === -1) ledger.bts.push(String(btId));
      ledger.calls.push({
        uuid: requestUuid, bt: String(btId), at: ledger.updated,
        moved: moves.map((m) => ({ k: m.key, q: m.quantity }))
      });
      // Keep the tail. The cumulative figures in `lots` are never trimmed -
      // they are the guard. The full history of every call already lives in
      // the Sync Log, which is where history belongs.
      if (ledger.calls.length > C.RELEASE_LEDGER.MAX_CALLS)
        ledger.calls = ledger.calls.slice(-C.RELEASE_LEDGER.MAX_CALLS);

      const released = ledgerReleased(ledger);
      const received = ledgerReceived(ledger);
      const held = ledgerHeld(ledger);

      const values = {};
      values[TXN.releaseLog] = JSON.stringify({
        receipt: String(receiptId),
        seq: ledger.seq, updated: ledger.updated,
        lots: ledger.lots, calls: ledger.calls, bts: ledger.bts,
        callCount: ledger.callCount
      });
      values[TXN.releasedQty] = released;
      values[TXN.heldQty] = held;
      values[TXN.releasedAt] = new Date();
      // ── EVERY TRANSFER, NOT THE LAST ONE ─────────────────────────────
      //    A MULTISELECT of transactions. A receipt released in three
      //    batches has three Bin Transfers, and a field holding only the
      //    most recent made the other two findable nowhere: the warehouse
      //    question is "show me the transfers that released this receipt",
      //    not "the last one".
      values[TXN.binTransfer] = ledger.bts.slice();
      values[TXN.requestUuid] = requestUuid;

      let written = true;
      try {
        // LOAD AND SAVE, not submitFields. The ledger is a body field and
        // submitFields would do, but the per-line balance columns are
        // sublist values and there is no other way to reach them. One
        // extra load per release buys a receipt a warehouse supervisor can
        // read without parsing JSON.
        writeReceiptAndLines(receiptId, values, ledger, moves);
      } catch (e) {
        // The LINE columns are a convenience; the LEDGER is the guard. If
        // the load-and-save failed for any reason - a locked period, a
        // mandatory field somebody added to the form - try once more for
        // the body alone, because a release that moved stock and did not
        // record it is the one outcome worth a second attempt.
        try {
          record.submitFields({
            type: 'itemreceipt', id: receiptId, values: values,
            options: { ignoreMandatoryFields: true }
          });
          log.audit({
            title: 'RB release - line balances not written, ledger was',
            details: {
              receiptId: receiptId, binTransfer: btId,
              error: (e && e.message) || String(e),
              effect: 'The per-line Quantity Released and Quantity On Hold ' +
                'columns are stale on this receipt. The ledger is correct ' +
                'and it is what every later release measures against.'
            }
          });
        } catch (e2) {
          written = false;
          // THIS IS SERIOUS AND IT IS SAID SO. The stock moved and the ledger
          // does not know. The next release will see the old figures and may
          // move it again.
          log.error({
            title: 'RB-WRITE-036 commitLedger', details: {
              context: 'RB release LEDGER NOT WRITTEN: itemreceipt/' + receiptId, binTransfer: btId, requestUuid: requestUuid,
              error: (e2 && e2.message) || String(e2),
              firstAttempt: (e && e.message) || String(e),
              consequence: 'The transfer SAVED and the receipt does not record ' +
                'it. A later release will measure against stale figures and ' +
                'could move the same lot again. Reconcile by hand.'
            }
          });
        }
      }

      return {
        written: written,
        overRelease: over.length > 0 || !written,
        conflictNote: over.length
          ? 'OVER-RELEASE. The Bin Transfer ' + btId + ' saved, and the ' +
          'receipt\'s ledger now shows more released than was received: ' +
          over.join('; ') + '. Two releases almost certainly overlapped. ' +
          'The stock has moved and cannot be un-moved from here - reverse ' +
          'the excess with a bin transfer in NetSuite and correct the ' +
          'ledger on the receipt.'
          : (written ? null
            : 'The Bin Transfer ' + btId + ' saved but the receipt\'s ' +
            'release ledger could NOT be written. A later release will ' +
            'measure against stale figures and could move the same lot ' +
            'again. Record the move on the receipt by hand before the ' +
            'next release.'),
        movedNow: movedNow, released: released, held: held, received: received,
        bts: ledger.bts.slice(),
        perLot: perLotReleased(ledger, moves)
      };
    };

    /**
     * THE RECEIPT, BODY AND LINES, IN ONE SAVE.
     *
     * ── WHY THE LINES AT ALL ──────────────────────────────────────────────
     *
     * The ledger is the authority and it is JSON on a body field, which is
     * exactly the wrong shape for the question a warehouse supervisor
     * actually asks: "what is still sitting on hold?". A saved search
     * cannot filter inside a Long Text, cannot total it and cannot group
     * by it.
     *
     * So the same facts are written again as NUMBERS on the line:
     *
     *   Quantity Released  how much of this line has moved to a good bin
     *   Quantity On Hold   what is left - received minus released
     *   Released On        when the last release touched this line
     *   Released To Bin    where it went, when the whole line agreed on one
     *
     * NOTHING READS THEM BACK. They are derived on every release and
     * rewritten in full. A number a human can edit is not a duplicate
     * guard, and making one load-bearing is how a hand-corrected figure
     * ends up authorising a second release of the same lot.
     *
     * ── MATCHING A LEDGER ROW TO A LINE ───────────────────────────────────
     *
     * The ledger keys on item and lot; the line knows its item and, through
     * its inventory detail, its lots. A tracked line claims the rows for
     * the lots it actually carries, which is right even when the same item
     * appears on two lines with different lots. A line with no detail
     * claims the item's unkeyed row.
     *
     * Where two lines DO carry the same item and the same lot - legal, and
     * rare - both would claim the row and the pair would double-count. That
     * is said out loud rather than papered over, and the ledger is still
     * correct.
     */
    const writeReceiptAndLines = (receiptId, values, ledger, moves) => {
      const rec = record.load({
        type: 'itemreceipt', id: receiptId, isDynamic: false
      });
      Object.keys(values).forEach((f) => {
        try { rec.setValue({ fieldId: f, value: values[f] }); }
        catch (e) {
          log.error({ title: 'RB-WRITE-037 writeReceiptAndLines', details: (e && e.message) || String(e) });
          log.audit({
            title: 'RB release - itemreceipt.' + f + ' would not set',
            details: (e && e.message) || String(e)
          });
        }
      });

      // What THIS call moved, per item|lot, so only the lines it touched
      // get a new Released On.
      const touched = {};
      (moves || []).forEach((m) => {
        const k = lotLedgerKey(m.itemId, m.lotId);
        if (!touched[k]) touched[k] = [];
        touched[k].push(String(m.toBin || ''));
      });

      let n = 0;
      try { n = rec.getLineCount({ sublistId: 'item' }); } catch (e) {
        log.error({ title: 'RB-WRITE-038 writeReceiptAndLines', details: (e && e.message) || String(e) }); n = 0;
      }
      const claimed = {};
      const now = new Date();

      for (let i = 0; i < n; i++) {
        let itemId = '';
        try {
          itemId = String(rec.getSublistValue({
            sublistId: 'item', fieldId: 'item', line: i
          }) || '');
        } catch (e) {
          log.error({ title: 'RB-WRITE-039 writeReceiptAndLines', details: (e && e.message) || String(e) }); itemId = '';
        }
        if (!itemId) continue;

        // The lots this line carries.
        const keys = [];
        let sub = null;
        try {
          sub = rec.getSublistSubrecord({
            sublistId: 'item', fieldId: 'inventorydetail', line: i
          });
        } catch (e) {
          log.error({ title: 'RB-WRITE-040 writeReceiptAndLines', details: (e && e.message) || String(e) }); sub = null;
        }
        if (sub) {
          let m = 0;
          try { m = sub.getLineCount({ sublistId: 'inventoryassignment' }); }
          catch (e) {
            log.error({ title: 'RB-WRITE-041 writeReceiptAndLines', details: (e && e.message) || String(e) }); m = 0;
          }
          for (let j = 0; j < m; j++) {
            let id = '';
            try {
              id = String(sub.getSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'receiptinventorynumber', line: j
              }) || '');
            } catch (e) {
              log.error({ title: 'RB-WRITE-042 writeReceiptAndLines', details: (e && e.message) || String(e) }); id = '';
            }
            const k = lotLedgerKey(itemId, id);
            if (keys.indexOf(k) === -1) keys.push(k);
          }
        }
        if (!keys.length) keys.push(lotLedgerKey(itemId, ''));

        let received = 0, releasedQ = 0, touchedLine = false;
        const bins = [];
        keys.forEach((k) => {
          const row = ledger.lots[k];
          if (!row) return;
          if (claimed[k])
            log.audit({
              title: 'RB release - one ledger row, two receipt lines',
              details: {
                receiptId: receiptId, key: k, lines: [claimed[k], i],
                effect: 'Both lines report the same released quantity, so ' +
                  'the two columns add up to more than the receipt. The ' +
                  'ledger and the body totals are correct; only the line ' +
                  'columns double-count.'
              }
            });
          claimed[k] = i;
          received += Number(row.received) || 0;
          releasedQ += Number(row.released) || 0;
          if (touched[k]) {
            touchedLine = true;
            touched[k].forEach((b) => {
              if (b && bins.indexOf(b) === -1) bins.push(b);
            });
          }
        });
        if (!keys.filter((k) => ledger.lots[k]).length) continue;

        const set = (f, v) => {
          if (!f) return;
          try {
            rec.setSublistValue({ sublistId: 'item', fieldId: f, line: i, value: v });
          } catch (e) {
            log.error({
              title: 'RB-WRITE-043 set', details: {
                field: f, line: i, error: (e && e.message) || String(e),
                note: 'The balance column is not on this form.'
              }
            });
          }
        };
        // ALWAYS both numbers, zero included. A blank means the line
        // predates the field, not that nothing has been released - which
        // is the difference between a reconciliation that can be trusted
        // and one that cannot.
        set(C.LINE.releasedQty, round6(releasedQ));
        set(C.LINE.holdQty, round6(Math.max(received - releasedQ, 0)));
        if (touchedLine) {
          set(C.LINE.releasedOn, now);
          // One bin only when the line went to one. Naming one of several
          // would imply the rest, and the inventory detail of the Bin
          // Transfer already holds the truth per lot.
          if (bins.length === 1) set(C.LINE.releaseBin, bins[0]);
        }
      }

      return rec.save({ enableSourcing: false, ignoreMandatoryFields: true });
    };

    const perLotReleased = (ledger, moves) => {
      const out = {};
      moves.forEach((m) => {
        out[m.key] = Number((ledger.lots[m.key] || {}).released) || m.quantity;
      });
      return out;
    };

    const mapForRecordType = (t) => {
      const want = String(t || '').trim().toLowerCase();
      if (!want) return null;
      const keys = Object.keys(INBOUND_MAP);
      for (let i = 0; i < keys.length; i++) {
        const m = INBOUND_MAP[keys[i]];
        if (String(m.recordType).toLowerCase() === want) return m;
      }
      return null;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Reads — three searches, all of them before the line loop
    // ═══════════════════════════════════════════════════════════════════════════

    /** The record that already carries this request_uuid, if there is one. */
    const findByExternalId = (map, requestUuid) => {
      if (!requestUuid) return '';
      let id = '';
      try {
        search.create({
          type: map.recordType,
          filters: [['externalid', 'is', requestUuid]],
          columns: ['internalid']
        }).run().each((r) => { id = String(r.id); return false; });
      } catch (e) {
        log.error({ title: 'RB-WRITE-044 findByExternalId', details: { error: (e && e.message) || String(e) } });
      }
      return id;
    };

    // findByUuid() LIVED HERE and is gone. It refused a second record claiming
    // the same identifier - correct for an order, wrong for a receipt, because
    // one shipment covers several orders and therefore several receipts. See
    // the note on storeIdentifier. The outbound engine keeps its own
    // equivalent check for transaction UUIDs, where uniqueness does hold.

    const readOrder = (map, orderId) => {
      const out = { found: false };
      try {
        const v = search.lookupFields({
          type: map.fromType, id: orderId,
          columns: ['tranid', 'status', 'location', TXN.uuid]
        });
        out.found = true;
        out.tranid = textOf(v.tranid);
        out.status = labelOf(v.status) || textOf(v.status);
        out.locationId = textOf(v.location);
        out.locationName = labelOf(v.location);
        out.uuid = textOf(v[TXN.uuid]);
      } catch (e) {
        log.error({ title: 'RB-WRITE-045 readOrder', details: (e && e.message) || String(e) });
        log.audit({
          title: 'RB inbound order could not be read: ' + map.fromType + '/' + orderId,
          details: (e && e.message) || String(e)
        });
        return out;
      }
      if (out.locationId) {
        try {
          const L = C.MASTER.location.fields;
          const lv = search.lookupFields({
            type: 'location', id: out.locationId,
            columns: ['isinactive', L.holdBin]
          });
          out.locationInactive = util.truthy(lv.isinactive);
          out.holdBin = textOf(lv[L.holdBin]);
        } catch (e) {
          log.error({ title: 'RB-WRITE-046 readOrder', details: (e && e.message) || String(e) }); /* the field is not deployed; the default bin answers */
        }
      }
      return out;
    };

    /**
     * Lot, serial, bin, active AND ELIGIBILITY for every item on the
     * submission. ONE search.
     *
     * Eligibility is read through the CONFIGURED field, the same way the
     * outbound classification and the read RESTlet read it, so all three
     * agree in an account that points Eligibility Field ID at its own item
     * field. It is what decides whether a bin is mandatory on the line and
     * whether the line can ever be released.
     */
    const readItems = (lines, cfg) => {
      const out = {};
      const ids = [];
      const seen = {};
      (lines || []).forEach((l) => {
        const id = String(l.item_id || '');
        if (!id || seen[id]) return;
        seen[id] = true;
        ids.push(id);
      });
      return itemInfo(ids, cfg, out);
    };

    const itemInfo = (ids, cfg, out) => {
      out = out || {};
      if (!ids.length) return out;
      const eligField = (cfg && cfg.eligField) || 'custitem_jj_rb_eligible';
      const cols = ['itemid', 'isinactive', 'islotitem', 'isserialitem', 'usebins'];
      const fill = (r, withElig) => {
        out[String(r.id)] = {
          name: r.getValue('itemid'),
          inactive: util.truthy(r.getValue('isinactive')),
          isLot: util.truthy(r.getValue('islotitem')),
          isSerial: util.truthy(r.getValue('isserialitem')),
          useBins: util.truthy(r.getValue('usebins')),
          eligible: withElig
            ? txn.eligibleValue(r.getText(eligField) || r.getValue(eligField))
            : undefined
        };
      };
      try {
        search.create({
          type: 'item', filters: [['internalid', 'anyof', ids]],
          columns: cols.concat([eligField])
        }).run().each((r) => { fill(r, true); return true; });
        return out;
      } catch (e) {
        log.error({ title: 'RB-WRITE-047 itemInfo', details: (e && e.message) || String(e) });
        // The configured field is not deployed on every item type in this
        // account. Fall back WITHOUT it rather than failing the write, and
        // say so: `eligible` is then undefined and the mandatory-bin and
        // release gates treat the line as not eligible.
        log.audit({
          title: 'RB inbound — the Eligibility Field could not be read',
          details: { field: eligField, error: (e && e.message) || String(e) }
        });
      }
      try {
        search.create({
          type: 'item', filters: [['internalid', 'anyof', ids]], columns: cols
        }).run().each((r) => { fill(r, false); return true; });
      } catch (e) {
        log.error({ title: 'RB-WRITE-048 itemInfo', details: { error: (e && e.message) || String(e) } });
      }
      return out;
    };

    /**
     * Which of the submitted serials are already on hand. ONE search for the
     * whole submission — §17.4 rule 3.
     */
    const readSerialsOnHand = (lines) => {
      const out = {};
      const numbers = [];
      lines.forEach((l) => {
        (Array.isArray(l.inventory) ? l.inventory : []).forEach((d) => {
          if (d && d.serial) numbers.push(String(d.serial));
        });
      });
      if (!numbers.length) return out;
      try {
        search.create({
          type: 'inventorynumber',
          filters: [['inventorynumber', 'anyof', numbers], 'AND',
          ['quantityonhand', 'greaterthan', 0]],
          columns: ['inventorynumber']
        }).run().each((r) => {
          out[String(r.getValue('inventorynumber') || '').toUpperCase()] = true;
          return true;
        });
      } catch (e) {
        log.error({ title: 'RB-WRITE-049 readSerialsOnHand', details: (e && e.message) || String(e) });
        // `anyof` on a text column is refused in some accounts. Not fatal: the
        // save itself refuses a duplicate serial, it just does so less kindly.
        log.audit({
          title: 'RB inbound serial-on-hand check could not run',
          details: (e && e.message) || String(e)
        });
      }
      return out;
    };

    const BIN_CACHE = {};
    const binInfo = (binId, ctx) => {
      const key = String(binId);
      if (BIN_CACHE[key]) return BIN_CACHE[key];
      const info = { exists: false, location: '', name: '' };
      try {
        const v = search.lookupFields({
          type: 'bin', id: key, columns: ['binnumber', 'location']
        });
        info.exists = true;
        info.name = textOf(v.binnumber);
        info.location = textOf(v.location);
      } catch (e) {
        log.error({ title: 'RB-WRITE-050 binInfo', details: (e && e.message) || String(e) }); info.exists = false;
      }
      BIN_CACHE[key] = info;
      return info;
    };

    /**
     * §11.8 — THE BINS THIS LINE TOUCHES, and the two documents want two
     * different things from them.
     *
     * ── A RECEIPT WANTS THE HOLD BIN, AND THE LOCATION KNOWS IT ───────────
     *
     * Received stock has not been verified, so it lands in the ON-HOLD bin
     * and stays there until `inventory_release` moves it.
     *
     *   row `bin` -> line `bin` / `hold_bin` -> body `bin` / `hold_bin`
     *     -> the LOCATION's On-Hold Bin -> the configuration's Default Bin
     *
     * PER LOCATION, because a client with three warehouses has three
     * receiving bins - which is why this reads the Location record rather
     * than one account-wide setting. The payload still wins: a device that
     * names a bin observed it, and an observation beats a default.
     *
     * ── PASS 29 MADE THE DEFAULT UNREACHABLE FOR AN ELIGIBLE ITEM. ────────
     *
     * It refused any eligible line that did not name a bin, on the grounds
     * that where tracked stock went is observed rather than inferred. That
     * is true of where it ENDED UP and not true of where it was PUT: a
     * receiving dock with one on-hold bin puts everything in it, and making
     * the device restate that on every line bought nothing and refused the
     * most ordinary receipt in the building. The location's On-Hold Bin is
     * a configured fact about the site, not a guess, and it answers for an
     * eligible item the same as for any other.
     *
     * What survives from Pass 29 is the ORDER: the payload is consulted
     * first, row before line before body, so the one afternoon where LOT-A
     * went to HOLD-01 and LOT-B to HOLD-02 still records both.
     *
     * ── A RECEIPT MAY ALSO BE TOLD THE GOOD BIN ───────────────────────────
     *
     * Not to use - a receipt never moves stock to a good bin - but to
     * REMEMBER, in the line's bin/lot map, for the release that comes
     * later. Same ladder, no default: the location's Good Bin is read at
     * release time, and freezing it into the receipt would mean a
     * configuration change never took effect on stock already received.
     *
     * ── A FULFILMENT WANTS THE PICK BIN, AND HAS NO DEFAULT ───────────────
     *
     * The stock is being ISSUED. Only the device knows which bin it came out
     * of, and defaulting one would relieve stock from a bin nobody picked.
     * Payload or nothing.
     */
    /** A bin named ON THE PAYLOAD - row, line or body. Never a default. */
    const payloadBin = (o) => String((o && (o.bin || o.bin_id ||
      o.hold_bin || o.hold_bin_id)) || '').trim();

    /** The GOOD bin named on the payload. `to_bin` is the older spelling. */
    const payloadGoodBin = (o) => String((o && (o.good_bin || o.good_bin_id ||
      o.to_bin || o.to_bin_id)) || '').trim();

    /**
     * THE HOLD BIN FOR ONE INVENTORY ROW.
     *
     * ── WHY PER ROW AND NOT PER LINE ──────────────────────────────────────
     *
     * One line of a receipt can carry several lots, and a warehouse puts
     * them wherever there is space: LOT-A in HOLD-01 and LOT-B in HOLD-02 is
     * an ordinary afternoon, not an edge case. A single bin per line forced
     * them into one, and the stock then sat somewhere the record did not
     * say - which `inventory_release` would later refuse, correctly, as
     * LOT_NOT_IN_BIN.
     *
     * The bin belongs with the lot. It is read as close to the lot as the
     * payload puts it, and only then does the location answer:
     *
     *   inventory row `bin` -> line `bin` -> body `bin` -> ctx.holdBin
     *
     * `ctx.holdBin` is already the location's On-Hold Bin falling back to
     * the configured Default Bin - see holdBinFor. A FULFILMENT has no such
     * default and gets nothing.
     */
    const binForRow = (ln, d, ctx, info) => {
      const named = payloadBin(d) || payloadBin(ln) || String(ctx.bodyBin || '');
      if (named) return named;
      if (!ctx.map.usesHoldBin) return '';          // a fulfilment, no default
      // ── AN ITEM NOTHING TRACKS DOES NOT GO ON HOLD ──────────────────
      //
      // There is no release for it. It was never going to be verified,
      // nothing is waiting on it, and `inventory_release` refuses it by
      // name. Putting it in the on-hold bin would strand ordinary stock
      // behind a gate that never opens for it.
      //
      // So its ladder ends somewhere it can be PICKED FROM:
      //
      //   payload hold bin -> payload GOOD bin -> the LOCATION's Good Bin
      //
      // The location's On-Hold Bin and the configured Default Bin are
      // both receiving defaults and neither is offered.
      if (info && info.eligible !== true)
        return goodBinForRow(ln, d, ctx) || String(ctx.locGoodBin || '');
      return String(ctx.holdBin || '');
    };

    /**
     * THE GOOD BIN FOR ONE INVENTORY ROW. Payload only, same three rungs.
     *
     * No default, deliberately. A blank here does not fail anything: the
     * release falls through to the location's Good Bin, read at the moment
     * it is needed rather than copied here and left to go stale.
     */
    const goodBinForRow = (ln, d, ctx) =>
      payloadGoodBin(d) || payloadGoodBin(ln) || String(ctx.bodyGoodBin || '');

    /**
     * The receipt's DEFAULT on-hold bin - the LOCATION's, then the
     * configuration's. The body's own `hold_bin` is NOT folded in here: it
     * is payload, and binForRow consults payload first in its own right.
     */
    const holdBinFor = (order, cfg) =>
      String(order.holdBin || cfg.defaultBin || '');

    /**
     * The LOCATION's Good Bin. No fallback to the Configuration's Default
     * Bin, which is the RECEIVING default: a non-eligible line that fell
     * back to it would land on hold after all, which is the one place it
     * must not be.
     */
    const locationGoodBin = (locationId) => {
      if (!locationId) return '';
      try {
        const L = C.MASTER.location.fields;
        const v = search.lookupFields({
          type: 'location', id: locationId, columns: [L.goodBin]
        });
        return textOf(v[L.goodBin]);
      } catch (e) {
        log.error({ title: 'RB-WRITE-051 locationGoodBin', details: (e && e.message) || String(e) }); return '';
      }
    };

    // ═══════════════════════════════════════════════════════════════════════
    // The bin / lot map — C.LINE.binMap
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * BUILD THE LINE'S MAP. Returns a JSON string, or '' when there is
     * nothing worth storing. THROWS BIN_MAP_TOO_LARGE.
     *
     * ── WHY IT IS NOT JUST A LIST ─────────────────────────────────────────
     *
     * The field is declared at 4000 characters and a serialized line can
     * carry hundreds of rows. One entry per row would blow the cap on an
     * ordinary pallet of serials, all of them saying the same two bins.
     *
     * So the line's OWN bins go in once, as `h` and `g`, and only a row
     * that DIFFERS from them earns an entry in `l`. A line with one hold
     * bin and one good bin is twenty-three characters whatever its lot
     * count, and the common case costs nothing:
     *
     *   {"v":1,"h":936,"g":940}
     *
     * ── AND WHEN IT STILL WILL NOT FIT ────────────────────────────────────
     *
     * It is refused, not trimmed. Dropping an override silently is a lot
     * released into a bin nobody chose, discovered weeks later by a
     * reconciliation. A loud refusal names the line and the operator splits
     * it.
     *
     * HOLD overrides are dropped FIRST if dropping buys the fit, because a
     * hold bin is also written to the inventory detail and can be read back
     * from there. A GOOD bin exists nowhere else and is never dropped.
     */
    const binMapJson = (rows, holds, goods, lineKey) => {
      // The modes: the bin the most rows agree on. A line with no rows at
      // all still records the line-level pair, because a non-tracked item
      // has a bin too.
      const mode = (list) => {
        const n = {};
        let best = '', bestN = 0;
        list.forEach((v) => {
          const k = String(v || '');
          if (!k) return;
          n[k] = (n[k] || 0) + 1;
          if (n[k] > bestN) { bestN = n[k]; best = k; }
        });
        return best;
      };
      const h = mode(holds);
      const g = mode(goods);
      if (!h && !g) return '';

      const num = (v) => {
        const s = String(v || '');
        return /^[0-9]+$/.test(s) ? Number(s) : s;
      };
      const base = {};
      if (h) base.h = num(h);
      if (g) base.g = num(g);

      // ══ THE EXCEPTIONS, PER LOT AND PER QUANTITY ══════════════════════
      //
      // v1 kept one pair per lot name. That cannot describe the receipt
      // where 10 of LOT-B went to the cold good bin and 4 to the ambient
      // one: same name, two destinations, and nothing in the key to tell
      // the release which is which. The quantity is what tells them apart,
      // so it goes in the value.
      //
      // AND IF A LOT HAS ONE ODD ROW, EVERY ROW OF THAT LOT IS LISTED.
      // Recording only the row that differs would leave the release
      // holding one entry for a lot that was split, and "one entry" is
      // read as "this is the whole story" - which is how a release ends up
      // confidently putting 4 units in the bin that was meant for 10.
      const byLot = {};
      const lotOrder = [];
      for (let i = 0; i < rows.length; i++) {
        const d = rows[i];
        const name = String((d && (d.serial || d.lot)) || '').trim();
        if (!name) continue;                    // cannot be addressed later
        const k = name.toUpperCase();
        if (!byLot[k]) { byLot[k] = []; lotOrder.push(k); }
        byLot[k].push({
          q: Number(d.quantity === undefined ? 1 : d.quantity) || 0,
          h: String(holds[i] || ''), g: String(goods[i] || '')
        });
      }
      const over = [];
      lotOrder.forEach((k) => {
        const list = byLot[k];
        const odd = list.filter((e) => e.h !== h || e.g !== g).length;
        if (!odd) return;
        over.push({ name: k, rows: list });
      });
      if (!over.length) return JSON.stringify(base);

      // `l` LAST, so the stored value reads v, h, g, then the exceptions -
      // which is the order a person scanning the field on the form wants.
      const build = (list, withHold) => {
        const o = {};
        Object.keys(base).forEach((k) => { o[k] = base[k]; });
        o.l = {};
        list.forEach((e) => {
          o.l[e.name] = e.rows.map((x) => [
            x.q,
            withHold && x.h !== h ? num(x.h) : 0,
            x.g !== g ? num(x.g) : 0
          ]);
        });
        return JSON.stringify(o);
      };

      let out = build(over, true);
      if (out.length <= C.BIN_MAP.MAX) return out;

      // Too long. Drop the hold overrides - recoverable from the inventory
      // detail - and keep every good bin.
      const goodOnly = over.filter(
        (e) => e.rows.filter((x) => x.g !== g).length);
      out = build(goodOnly, false);
      if (out.length <= C.BIN_MAP.MAX) {
        log.audit({
          title: 'RB inbound - bin map trimmed to its good bins',
          details: {
            line: lineKey, lots: over.length, kept: goodOnly.length,
            effect: 'The per-lot HOLD bins did not fit and were dropped. ' +
              'They are on the inventory detail of this line and can be ' +
              'read back from there. No good bin was dropped.'
          }
        });
        return out;
      }

      throw err(C.LINE_ERR.BIN_MAP_TOO_LARGE,
        'Line ' + lineKey + ' splits ' + goodOnly.length + ' lot(s) across ' +
        'good bins, and the bin/lot map that records them is ' + out.length +
        ' characters against a limit of ' + C.BIN_MAP.MAX + '. The map is ' +
        'NOT truncated: a dropped entry is a lot that would later release ' +
        'into a bin nobody chose. Send one good bin for the whole line, or ' +
        'split the line across several so each map fits.');
    };

    /**
     * READ A STORED MAP back. Never throws - a line written before this
     * field existed, or by hand, simply has no map and the release falls
     * through to the location's bins.
     *
     * Returns { h, g, l: { LOTNAME: [{ q, h, g }] } }. BOTH VERSIONS parse:
     * a v1 value is a bare `[hold, good]` pair, read as one entry of
     * quantity 0, which means "any quantity" and is exactly how v1 behaved.
     */
    const parseBinMap = (raw) => {
      const out = { h: '', g: '', l: {} };
      const text = String(raw || '').trim();
      if (!text) return out;
      let p = null;
      try { p = JSON.parse(text); } catch (e) {
        log.error({ title: 'RB-WRITE-052 parseBinMap', details: (e && e.message) || String(e) }); p = null;
      }
      if (!p || typeof p !== 'object') {
        log.audit({
          title: 'RB release - a bin/lot map is not valid JSON',
          details: {
            raw: text.substring(0, 300),
            effect: 'Ignored. The release falls back to the payload and ' +
              'then to the location\'s Good Bin, which is what a receipt ' +
              'written before this field did anyway.'
          }
        });
        return out;
      }
      out.h = p.h === undefined || p.h === null ? '' : String(p.h);
      out.g = p.g === undefined || p.g === null ? '' : String(p.g);
      const l = (p.l && typeof p.l === 'object') ? p.l : {};
      // 0 in any slot is the sentinel for "the line's own", not a bin id
      // and not a real quantity.
      const entry = (t) => ({
        q: Number(t[0]) || 0,
        h: t[1] ? String(t[1]) : out.h,
        g: t[2] ? String(t[2]) : out.g
      });
      Object.keys(l).forEach((k) => {
        const v = l[k];
        if (!Array.isArray(v) || !v.length) return;
        const key = String(k).toUpperCase();
        out.l[key] = Array.isArray(v[0])
          ? v.map(entry)                          // v2: [[q,h,g], ...]
          : [entry([0, v[0], v[1]])];             // v1: [h,g]
      });
      return out;
    };

    /** Every entry for one lot. The line's own, as one entry, when unlisted. */
    const binMapFor = (map, lotName) => {
      if (!map) return [];
      const k = String(lotName || '').trim().toUpperCase();
      if (k && map.l[k]) return map.l[k];
      if (!map.h && !map.g) return [];
      return [{ q: 0, h: map.h, g: map.g }];
    };

    /**
     * WHICH ENTRY A RELEASE OF `qty` IS ALLOWED TO USE.
     *
     * The entries are what the RECEIPT recorded. The fourth number on each
     * is how much of it a previous release already spent, so a lot split
     * 10/4 across two bins cannot have the same 10 released twice.
     *
     * The rules, in order, and they refuse rather than guess:
     *
     *   nothing recorded      -> no answer, the ladder goes on to the
     *                            location
     *   one entry left        -> that one, whatever the quantity. A lot
     *                            that was never split has one destination
     *                            and the quantity adds nothing
     *   an EXACT match on an  -> that one. This is the split case working
     *   entry's own quantity     as intended: ask for 10 and get the bin
     *                            the 10 went to
     *   every remaining entry -> that bin. The lot was split by quantity
     *   agrees on the good bin   but not by destination, so there is
     *                            nothing to be ambiguous about
     *   otherwise             -> NO ANSWER, and the caller refuses. The
     *                            receipt says 10 went one way and 4 the
     *                            other; a release of 7 cannot be
     *                            attributed to either, and putting
     *                            regulated stock in a guessed bin is the
     *                            failure this whole field exists to stop
     */
    const entryForRelease = (row, qty) => {
      const list = (row && Array.isArray(row.b)) ? row.b : null;
      if (!list || !list.length) {
        if (row && (row.h || row.g)) return { i: -1, h: row.h || '', g: row.g || '' };
        return null;
      }
      const left = [];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const q = Number(t[0]) || 0;
        const done = Number(t[3]) || 0;
        if (q && done >= q) continue;                 // spent
        left.push({
          i: i, q: q, h: String(t[1] || ''), g: String(t[2] || ''),
          remaining: q ? q - done : 0
        });
      }
      if (!left.length) return null;
      if (left.length === 1)
        return { i: left[0].i, h: left[0].h, g: left[0].g };
      const exact = left.filter((e) => e.remaining === Number(qty))[0];
      if (exact) return { i: exact.i, h: exact.h, g: exact.g };
      const goods = [];
      left.forEach((e) => { if (goods.indexOf(e.g) === -1) goods.push(e.g); });
      if (goods.length === 1)
        return { i: left[0].i, h: left[0].h, g: goods[0] };
      return { ambiguous: left.map((e) => e.remaining + ' -> ' + e.g) };
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Small writers
    // ═══════════════════════════════════════════════════════════════════════════

    const setCur = (rec, fieldId, value) => {
      if (!fieldId) return;
      try {
        rec.setCurrentSublistValue({
          sublistId: 'item', fieldId: fieldId, value: value
        });
      } catch (e) {
        log.error({
          title: 'RB-WRITE-053 setCur', details: {
            field: fieldId, error: (e && e.message) || String(e),
            note: 'The column is not on this form. Expected on a client ' +
              'whose receipt or fulfilment form omits it.'
          }
        });
      }
    };
    const setCurText = (rec, fieldId, text) => {
      if (!fieldId) return;
      try {
        rec.setCurrentSublistText({
          sublistId: 'item', fieldId: fieldId, text: String(text)
        });
      } catch (e) {
        log.error({
          title: 'RB-WRITE-054 setCurText', details: {
            field: fieldId, text: text,
            error: (e && e.message) || String(e),
            note: 'Not on this form, or not a list value.'
          }
        });
      }
    };
    const subSet = (sub, fieldId, value) => {
      try {
        sub.setCurrentSublistValue({
          sublistId: 'inventoryassignment', fieldId: fieldId, value: value
        });
      } catch (e) {
        log.error({
          title: 'RB-WRITE-055 subSet', details: {
            field: fieldId, error: (e && e.message) || String(e),
            note: 'Not on the inventory detail of this item.'
          }
        }); /* not on this form */
      }
    };
    const subSetText = (sub, fieldId, text) => {
      try {
        sub.setCurrentSublistText({
          sublistId: 'inventoryassignment', fieldId: fieldId, text: text
        });
      } catch (e) {
        log.error({
          title: 'RB-WRITE-056 subSetText', details: {
            field: fieldId, error: (e && e.message) || String(e),
            note: 'Not on the inventory detail of this item.'
          }
        }); /* not on this form */
      }
    };

    /** The body fields, written once, after the record exists. */
    const stampCreated = (map, id, body, requestUuid, exceptionQty) => {
      const values = {};
      values[TXN.origin] = C.ORIGIN_MW;
      values[TXN.synced] = false;          // until call 2 — §11.4
      values[TXN.lastTry] = new Date();
      if (body.shipment_uuid) values[TXN.shipmentUuid] = body.shipment_uuid;
      if (requestUuid) values[TXN.requestUuid] = requestUuid;
      // Always, zero included - a blank means the document predates the
      // field, not that nothing was short.
      values[TXN.exceptionQty] = Number(exceptionQty) || 0;
      try {
        record.submitFields({
          type: map.recordType, id: id, values: values,
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) {
        log.error({ title: 'RB-WRITE-057 stampCreated', details: { context: 'Error @ inbound stampCreated ' + id, error: (e && e.message) || String(e) } });
      }
    };

    /**
     * A date in the account's own format, or an ISO one from the Middleware.
     * `new Date()` on a dd/mm/yyyy account reads September as August.
     */
    const parseDate = (raw) => {
      const v = String(raw === null || raw === undefined ? '' : raw).trim();
      if (!v) return null;
      const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      try {
        const d = format.parse({ value: v, type: format.Type.DATE });
        if (d && !isNaN(d.getTime())) return d;
      } catch (e) {
        log.error({ title: 'RB-WRITE-058 parseDate', details: (e && e.message) || String(e) }); /* fall through */
      }
      const d2 = new Date(v);
      return isNaN(d2.getTime()) ? null : d2;
    };

    return { post, put };
  });
