/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * jj_ue_rb_txn — the ONE transaction User Event.
 *
 * DEPLOYMENTS (2, this phase):
 *   salesorder      ← gate `Pending Fulfillment`
 *   purchaseorder   ← gate `Pending Receipt`
 *
 * NOT DEPLOYED, and each for its own reason:
 *   itemfulfillment · itemreceipt   created INBOUND by the Middleware calling
 *                                   the RESTlet. There is no push path for
 *                                   them — §2.2, §10.2, §11.1
 *   transferorder · returnauthorization · vendorreturnauthorization
 *                                   Phase 2. Declared in C.TXNMAP with
 *                                   implemented:false so deploying to one
 *                                   fails loudly instead of doing nothing
 *   inventoryadjustment             OUT OF SCOPE — §1.5.3. Never deploy it
 *
 * It knows nothing about any of them. Everything comes from C.TXNMAP[type].
 *
 * THE ONE THING TO UNDERSTAND BEFORE READING FURTHER (§7.3.1):
 *   an order below its status gate produces NO call and NO Sync Log record.
 *   On a busy day that is the most common outcome in the account, and it is
 *   not an error. A developer testing against draft orders sees nothing happen
 *   and concludes the script is broken. It is not. Approve the order.
 *
 * Transaction Developer Guide v3.1 §7.3, §7.9.
 */
define(['N/runtime', '../Common/jj_rb_core', '../Common/jj_rb_io', '../Common/jj_rb_txn'],
  (runtime, core, io, txn) => {

    const { C, util, config } = core;
    const { logIo } = io;

    const entryFor = (t) => C.TXNMAP[String(t || '').toLowerCase()] || null;

    // ── beforeLoad ─────────────────────────────────────────────────────────────
    // Two jobs only: lock our fields, and clear everything on COPY.
    // It is NOT part of the trigger — the stored payload is.
    const beforeLoad = (ctx) => {
      try {
        const entry = entryFor(ctx.newRecord.type);
        if (!entry) return;

        txn.lockSyncFields(ctx.form, entry);

        // §15.6 — a copy has synced nothing. Leaving the transaction UUID on
        // it would make two NetSuite orders claim one remote transaction, and
        // an update sent for either would silently replace the other's lines.
        if (ctx.type === ctx.UserEventType.COPY)
          txn.clearAllSyncFields(ctx.newRecord, entry);
      } catch (e) {
        logIo.exception(null, ctx && ctx.newRecord, e);
      }
    };

    // ── beforeSubmit ───────────────────────────────────────────────────────────
    /**
     * ONE job: Concept 3. Classify every line, resolve its destination product,
     * and roll the answer up to the body.
     *
     * NOTHING HERE BLOCKS A SAVE. This integration never refuses a transaction
     * (§17.1). Version 2.0 kept a mixed-line block here, inherited from a
     * policy that was deleted in v2.0 itself; proposal v4 §8.2 requires a mixed
     * order to be accepted. If you find a `throw` in this function it is a
     * leftover — take it out.
     */
    const beforeSubmit = (ctx) => {
      const entry = entryFor(ctx.newRecord.type);
      if (!entry) return;

      try {
        if (ctx.type === ctx.UserEventType.DELETE) return;

        // Our own write-back is a save too, and it changes nothing a line
        // classification could depend on. Re-running two searches for it on
        // every stamp would double the governance of every sync for nothing.
        if (util.onlySyncFieldsChanged(ctx.oldRecord, ctx.newRecord,
          C.SYNC_CONTROL_FIELDS)) return;

        const cfg = config.get();
        if (!cfg) return;                      // nothing to classify against

        const counts = txn.classifyLines(ctx.newRecord, entry, cfg);
        log.debug({
          title: 'RB txn UE - classified ' + ctx.newRecord.type,
          details: {
            recordId: ctx.newRecord.id || null,
            lines: counts.total, serialized: counts.serialized
          }
        });
      } catch (e) {
        // Deliberately swallowed. A classification failure must not stop a
        // user saving a legitimate order.
        logIo.exception(entry, ctx.newRecord, e);
      }
    };

    // ── afterSubmit ────────────────────────────────────────────────────────────
    const afterSubmit = (ctx) => {
      const entry = entryFor(ctx.newRecord.type);
      if (!entry) {
        // Deployed to a transaction type the dispatch table does not know.
        // Silence here looks exactly like a script that did not run at all.
        log.audit({
          title: 'RB txn no dispatch entry for ' + ctx.newRecord.type,
          details: 'The transaction User Event is deployed to this record type ' +
            'but C.TXNMAP has no entry for it, so nothing can be synced.'
        });
        return;
      }

      try {
        const recordType = ctx.newRecord.type;
        const recordId = ctx.newRecord.id;

        // ── §12.2 — THE ORDER WAS DELETED. The destination transaction is
        //    voided, always, whatever the Close Action says — and the shipment
        //    guard still refuses to void one that has a shipment against it.
        //
        //    Everything comes off oldRecord: there is no record left to read,
        //    and nothing can be written back to it. Nothing is RETURNED out of
        //    the entry point either — NetSuite serialises what an entry point
        //    returns, and the result objects are not meant to leave the script.
        if (ctx.type === ctx.UserEventType.DELETE) {
          const cfgDel = config.get();
          if (!cfgDel) return;
          const flowDel = config.flow(entry);
          if (!flowDel || flowDel.enabled !== true) return;
          txn.runDelete(entry, ctx.oldRecord, cfgDel);
          return;
        }

        // ── GUARD 1 — free. Our own write-back changes only sync-control
        //    fields, and this is what stops it re-triggering the sync.
        if (util.onlySyncFieldsChanged(ctx.oldRecord, ctx.newRecord,
          C.SYNC_CONTROL_FIELDS)) {
          log.debug({
            title: 'RB txn skipped: only sync-control fields changed',
            details: { recordType: recordType, recordId: recordId }
          });
          return;
        }

        // ── No configuration ⇒ do not guess a host. Say so: without this line
        //    every transaction type goes quiet with nothing to explain it.
        const cfg = config.get();
        if (!cfg) {
          log.audit({
            title: 'RB no active configuration row',
            details: 'Exactly one RapidBridge Configuration row must have ' +
              'Active ticked and not be inactive. Nothing is synced until it does.'
          });
          return;
        }

        // ── The flow gate. One row per flow on the configuration record.
        const flow = config.flow(entry);
        if (!flow || flow.enabled !== true) {
          log.debug({
            title: 'RB txn flow disabled',
            details: {
              recordType: recordType, recordId: recordId,
              syncType: entry.syncType
            }
          });
          txn.stampFlowDisabled(entry, recordType, recordId);
          return;
        }

        // ── A row with no builder fails LOUDLY, and before the status test,
        //    which would otherwise defer it forever for the wrong reason.
        if (entry.implemented === false) {
          txn.stampNotImplemented(entry, recordType, recordId);
          return;
        }

        // ── §7.3.1 — HAS THE ORDER REACHED A STATUS IT CAN BE SENT IN?
        //    Evaluated BEFORE the payload comparison inside txn.run(), because
        //    an order reaching that status changes no field that is IN the
        //    payload: the payload is identical, and a comparison-first engine
        //    would skip the one save that matters.
        //
        //    One test, both kinds of account. With approval routing the order
        //    waits in Pending Approval and the approval is the transition;
        //    with no approval workflow NetSuite creates it already in Pending
        //    Fulfillment and the CREATE is the transition. Nothing here asks
        //    which kind of account this is, and nothing should.
        const crossed = txn.atSyncStatus(entry, ctx);

        if (crossed === false) {
          // ── §12 — NOT eligible can mean two different things. An order that
          //    has just been CLOSED or CANCELLED is not waiting for anything;
          //    it is finished, and the destination has to be told. Everything
          //    else is an order that has not been released yet.
          if (txn.needsClose(entry, ctx)) {
            txn.runClose({
              entry: entry, cfg: cfg,
              recordType: recordType, recordId: recordId,
              trigger: C.TRIGGER.STATUS
            });
            return;
          }
          // Not eligible yet. The common case, and not an error.
          txn.stampDeferred(entry, recordType, recordId);
          return;
        }

        // ── GUARD 2 — the payload comparison, inside txn.run(). `forceSend`
        //    is set only by a TRANSITION (crossed === true); an order that was
        //    already eligible (crossed === null) lets the comparison decide,
        //    which is how a later edit becomes an update instead of a second
        //    create.
        txn.run({
          entry: entry, flow: flow,
          recordId: recordId, recordType: recordType,
          newRecord: ctx.newRecord, cfg: cfg,
          forceSend: crossed === true,
          trigger: crossed === true
            ? C.TRIGGER.STATUS
            : triggerFor(runtime.executionContext),
          isCreate: ctx.type === ctx.UserEventType.CREATE
        });

        log.debug({
          title: 'RB txn UE - sync completed',
          details: {
            recordType: recordType, recordId: recordId, entry: entry.key,
            governance: runtime.getCurrentScript().getRemainingUsage()
          }
        });
      } catch (e) {
        // NEVER re-throw in afterSubmit: the record is already committed.
        logIo.exception(entry, ctx.newRecord, e);
      }
    };

    /**
     * Where the work came from. A CROSSING is always `Status Change`, whatever
     * moved the status — a person, an approval routing workflow or a CSV
     * import are indistinguishable to this code, and that is the point
     * (§15.5).
     *
     * `Mass Update` and `Reconciliation Sweep` are deliberately not produced
     * here: there is no transaction sweep and no transaction mass resync
     * (§1.5.4), and a transaction work item carrying either value is a defect.
     */
    const triggerFor = (x) => {
      if (x === runtime.ContextType.CSV_IMPORT) return C.TRIGGER.CSV;
      return C.TRIGGER.INITIAL;
    };

    return { beforeLoad, beforeSubmit, afterSubmit };
  });
