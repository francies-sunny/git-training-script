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
 * - Rejects the WHOLE submission when any line fails validation, so nothing is
 *   created and a retry can always repair it.
 * - Guards duplicates on the record's native externalId, which the platform
 *   enforces per record type. A repeat submission answers with the record that
 *   already exists, as a SUCCESS.
 * - Lands receipt stock in the location's on-hold bin, falling back to the
 *   configured default bin.
 * - Writes one closed Sync Log row per call, Direction "Inbound (MW - NS)",
 *   Trigger "Inbound Call".
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
 * NOT BUILT ANYWHERE YET, and absent rather than declared-and-dead:
 * `inventory_release` (§11.6). `inventory_adjustment` is OUT OF SCOPE (§1.5.3)
 * and must not be added.
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

        const map = INBOUND_MAP[operation];
        if (!map)
          return failEnvelope(C.DOC_ERR.UNKNOWN_OPERATION,
            'Unknown operation "' + operation + '". This endpoint accepts: ' +
            Object.keys(INBOUND_MAP).concat([C.INBOUND.IDENTIFIER]).join(', ') + '.');

        return createDocument(map, body, cfg, startedAt);

      } catch (e) {
        // A RESTlet that throws answers with a NetSuite error envelope the
        // Middleware cannot branch on. Everything comes back as OUR envelope.
        log.error({ title: 'RB inbound unhandled', details: e });
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
        return refuse(C.DOC_ERR.ORDER_CLOSED,
          'Order ' + txn.named(order.tranid, orderId) + ' cannot be ' +
          'transformed into a ' + map.syncType + ': ' +
          ((e && e.message) || String(e)));
      }

      // §4.1.2 — THE DUPLICATE GUARD. Set before anything else, so that even a
      // save that fails later has claimed the identifier.
      try { rec.setValue({ fieldId: 'externalid', value: requestUuid }); }
      catch (e) { /* not settable on this form; the lookup above still guards */ }

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
        } catch (e) { /* not on this form */ }
      }

      // ── THE PRE-READ. §17.4 rule 3: everything the line loop needs, in
      //    three searches, BEFORE the loop. Twelve lines times four point
      //    lookups is forty-eight reads on the tightest budget in the SuiteApp.
      const ctx = {
        map: map, cfg: cfg, order: order,
        items: readItems(lines),
        onHand: map.usesHoldBin ? readSerialsOnHand(lines) : {},
        holdBin: map.usesHoldBin ? holdBinFor(order, cfg) : ''
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
        // The last document-level gate. Every line validated and the save was
        // still refused — a permission, a plug-in, a locked period.
        const message = (e && e.message) ? e.message : String(e);
        const code = /period/i.test(message)
          ? C.DOC_ERR.PERIOD_LOCKED : C.DOC_ERR.SAVE_REFUSED;
        return refuse(code, 'NetSuite refused the save: ' + message);
      }

      // ── STAMPED ONLY NOW, because only now is there a record.
      stampCreated(map, newId, body, requestUuid);

      const unit = unitFor(map, newId, '');
      logIo.recordInbound({
        entry: entry, unit: unit, cfg: cfg,
        operation: C.OPERATION.CREATE, outcome: C.OUTCOME.SUCCESS,
        status: C.STATUS.CLOSED_SUCCESS,
        endpoint: map.key + ' ' + body.operation, method: 'POST',
        httpStatus: 200, startedAt: startedAt,
        requestUuid: requestUuid, shipmentUuid: body.shipment_uuid,
        request: body, lineTotal: lines.length, lineSent: applied.length
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
        lines_posted: applied.length
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
        catch (e) { /* not on this form */ }
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

      // §11.8 — the Middleware resolved the bin against the allowed-bins
      // service before submitting, so by the time this runs a named bin is a
      // value to validate, not a decision to make.
      const bin = binFor(ln, ctx);
      if (bin && ctx.cfg.useBins === true) {
        const b = binInfo(bin, ctx);
        if (!b.exists)
          throw err(C.LINE_ERR.BIN_NOT_ALLOWED,
            'Bin ' + bin + ' named on line ' + ln.line_unique_key +
            ' does not exist.');
        if (b.location && ctx.order.locationId
          && String(b.location) !== String(ctx.order.locationId))
          throw err(C.LINE_ERR.BIN_INVALID_LOCATION,
            'Bin ' + txn.named(b.name, bin) + ' is not at the order\'s location.');
      }
      if (!bin && ctx.map.usesHoldBin && ctx.cfg.useBins === true && info.useBins)
        throw err(C.LINE_ERR.BIN_NOT_ALLOWED,
          'No bin was named for line ' + ln.line_unique_key + ' (' +
          txn.named(info.name, itemId) + '), and no on-hold bin is configured ' +
          'on the location or the RapidBridge Configuration.');
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

      const bin = binFor(ln, ctx);
      if (bin) setCur(rec, C.LINE.holdBin, bin);

      const detail = Array.isArray(ln.inventory) ? ln.inventory : [];
      if (!detail.length) return;

      let sub = null;
      try {
        sub = rec.getCurrentSublistSubrecord({
          sublistId: 'item', fieldId: 'inventorydetail'
        });
      } catch (e) { sub = null; }
      if (!sub) return;                 // the item is not tracked

      for (let i = 0; i < detail.length; i++) {
        const d = detail[i];
        sub.selectNewLine({ sublistId: 'inventoryassignment' });
        // TEXT, not value: the lot or serial may not exist yet, and setting it
        // by text is what makes NetSuite create it.
        subSetText(sub, map.inventoryField, String(d.serial || d.lot || ''));
        if (bin) subSet(sub, 'binnumber', bin);
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
        details: { recordType: recordType, internalId: internalId,
          shipmentUuid: ttUuid }
      });
      return okEnvelope({
        internal_id: internalId, external_id: requestUuid,
        shipment_uuid: ttUuid
      });
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
        log.error('Error @ inbound findByExternalId', e);
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
        } catch (e) { /* the field is not deployed; the default bin answers */ }
      }
      return out;
    };

    /** Lot, serial, bin and active for every item on the submission. ONE search. */
    const readItems = (lines) => {
      const out = {};
      const ids = [];
      const seen = {};
      lines.forEach((l) => {
        const id = String(l.item_id || '');
        if (!id || seen[id]) return;
        seen[id] = true;
        ids.push(id);
      });
      if (!ids.length) return out;
      try {
        search.create({
          type: 'item',
          filters: [['internalid', 'anyof', ids]],
          columns: ['itemid', 'isinactive', 'islotitem', 'isserialitem', 'usebins']
        }).run().each((r) => {
          out[String(r.id)] = {
            name: r.getValue('itemid'),
            inactive: util.truthy(r.getValue('isinactive')),
            isLot: util.truthy(r.getValue('islotitem')),
            isSerial: util.truthy(r.getValue('isserialitem')),
            useBins: util.truthy(r.getValue('usebins'))
          };
          return true;
        });
      } catch (e) {
        log.error('Error @ inbound readItems', e);
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
      } catch (e) { info.exists = false; }
      BIN_CACHE[key] = info;
      return info;
    };

    /**
     * §11.8 — the bin this line lands in.
     *
     * The payload wins; otherwise a RECEIPT uses the location's on-hold bin,
     * falling back to the configured default. A fulfilment takes only what the
     * payload names: the stock is being ISSUED, so there is nothing to default.
     */
    const binFor = (ln, ctx) => {
      const named = String(ln.bin || ln.bin_id || '').trim();
      if (named) return named;
      return ctx.map.usesHoldBin ? String(ctx.holdBin || '') : '';
    };

    /**
     * The on-hold bin: the LOCATION's first, the configuration's default
     * second. Per location, because a client with three warehouses has three
     * receiving bins — which is why this reads the Location record rather than
     * a single account-wide setting.
     */
    const holdBinFor = (order, cfg) =>
      String(order.holdBin || cfg.defaultBin || '');

    // ═══════════════════════════════════════════════════════════════════════════
    // Small writers
    // ═══════════════════════════════════════════════════════════════════════════

    const setCur = (rec, fieldId, value) => {
      if (!fieldId) return;
      try {
        rec.setCurrentSublistValue({
          sublistId: 'item', fieldId: fieldId, value: value
        });
      } catch (e) { /* not on this form */ }
    };
    const setCurText = (rec, fieldId, text) => {
      if (!fieldId) return;
      try {
        rec.setCurrentSublistText({
          sublistId: 'item', fieldId: fieldId, text: String(text)
        });
      } catch (e) { /* not on this form, or not a list value */ }
    };
    const subSet = (sub, fieldId, value) => {
      try {
        sub.setCurrentSublistValue({
          sublistId: 'inventoryassignment', fieldId: fieldId, value: value
        });
      } catch (e) { /* not on this form */ }
    };
    const subSetText = (sub, fieldId, text) => {
      try {
        sub.setCurrentSublistText({
          sublistId: 'inventoryassignment', fieldId: fieldId, text: text
        });
      } catch (e) { /* not on this form */ }
    };

    /** The body fields, written once, after the record exists. */
    const stampCreated = (map, id, body, requestUuid) => {
      const values = {};
      values[TXN.origin] = C.ORIGIN_MW;
      values[TXN.synced] = false;          // until call 2 — §11.4
      values[TXN.lastTry] = new Date();
      if (body.shipment_uuid) values[TXN.shipmentUuid] = body.shipment_uuid;
      if (requestUuid) values[TXN.requestUuid] = requestUuid;
      try {
        record.submitFields({
          type: map.recordType, id: id, values: values,
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) {
        log.error('Error @ inbound stampCreated ' + id, e);
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
      } catch (e) { /* fall through */ }
      const d2 = new Date(v);
      return isNaN(d2.getTime()) ? null : d2;
    };

    return { post, put };
  });
