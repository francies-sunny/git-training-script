/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * jj_rb_io — the log writer and the HTTP client.
 *
 * The two halves live in one file because EVERY HTTP call produces EXACTLY ONE
 * Sync Log record (§12.1). Keeping them together makes that invariant provable
 * by reading a single file instead of trusting two to agree.
 *
 * This is the ONLY file that calls N/https, and the ONLY file that writes
 * customrecord_jj_rb_sync_log.
 *
 * Master Data Developer Guide v3.4 §7.6, §12, §20.2.
 */
define(['N/https', 'N/record', 'N/search', 'N/runtime', './jj_rb_core'],
  (https, record, search, runtime, core) => {

    const { C, util, lists, config } = core;

    const ENV = Object.freeze({
      PRODUCTION: runtime.EnvType.PRODUCTION,
      SANDBOX: runtime.EnvType.SANDBOX,
      BETA: runtime.EnvType.BETA
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // The execution-environment gate — §20.2
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * May this environment call out at all?
     *
     * A sandbox refresh copies the configuration row, host and API Secret GUID
     * included. Without this gate the first item saved in that sandbox reaches
     * the PRODUCTION Middleware and becomes a real product record.
     *
     * SAFE Q1.20. Read `runtime.envType` every execution — a cached value
     * survives a refresh, which is the one thing it must not do.
     *
     * @returns {{allowed:boolean, reason:string, env:string}}
     */
    const envGate = (cfg) => {
      const env = runtime.envType;
      log.debug("Environment gate", { env: env, envLabel: cfg.envLabel, allowNonprod: cfg.allowNonprod });
      if (env === ENV.PRODUCTION) {
        return cfg.envLabel === 'PRODUCTION'
          ? { allowed: true, reason: '', env: env }
          : {
            allowed: false, env: env,
            reason: 'Config is labelled ' + cfg.envLabel +
              ' but this is a PRODUCTION account'
          };
      }
      if (!cfg.allowNonprod) {
        return {
          allowed: false, env: env,
          reason: 'Non-production environment (' + env + ') and allow_nonprod_calls is off'
        };
      }
      if (cfg.envLabel === 'PRODUCTION') {
        // The refresh case. Refuse loudly — nobody has re-pointed it yet.
        return {
          allowed: false, env: env,
          reason: 'Refusing to call a PRODUCTION-labelled host from ' + env +
            '. Re-point the configuration after the refresh.'
        };
      }
      return { allowed: true, reason: '', env: env };
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // log — the ONLY writer of customrecord_jj_rb_sync_log
    // ═══════════════════════════════════════════════════════════════════════════

    const L = C.LOG;
    const lid = (list, v) => lists.id(list, v);

    /** Human-readable, quotable reference: RB-LOCATION-20260916T0921-4A7 */
    const makeRef = (entry, unit) => {
      const now = new Date();
      const stamp = util.isoUtc(now).replace(/[-:]/g, '').replace(/\..*$/, '');
      return 'RB-' + entry.key + '-' + stamp + '-' +
        String(unit.recordId).slice(-4) + '-' + util.uuid().substring(0, 3).toUpperCase();
    };

    /**
     * §12.5 — is this call's record a MAIN record, or a CHILD of an open one?
     *
     * Case A: triggered FROM a main record (a retry) → CHILD of it. No search.
     * Case B: anything else → search for an open main record for this unit.
     *          0 found → MAIN.  1 found → CHILD of it.  >1 → anomaly, see below.
     */
    /**
     * Every OPEN main work item for this subject, newest first.
     *
     * One definition, two callers — resolveLogTarget (to attach a retry to it)
     * and closeStaleWorkItem (to close it when no call is coming). If these two
     * ever disagreed on the key, a work item would be invisible to one of them.
     */
    const findOpenMain = (unit) => {
      const open = [];
      try {
        const filters = [
          [L.parent, 'anyof', '@NONE@'], 'AND',
          [L.open, 'is', 'T'], 'AND',
          [L.recType, 'is', String(unit.recordType)], 'AND',
          [L.nsId, 'is', String(unit.recordId)]
        ];
        if (unit.uomId) filters.push('AND', [L.uom, 'anyof', unit.uomId]);
        else filters.push('AND', [L.uom, 'anyof', '@NONE@']);

        search.create({
          type: C.REC.LOG, filters: filters,
          columns: [search.createColumn({ name: 'internalid', sort: search.Sort.DESC })]
        }).run().each((r) => { open.push(r.getValue('internalid')); return true; });
      } catch (e) {
        log.error({ title: 'RB findOpenMain search', details: e });
      }
      return open;
    };

    const resolveLogTarget = (o) => {
      const { entry, unit, payload } = o;

      if (o.triggeringParentId)
        return {
          mode: 'CHILD', parentId: o.triggeringParentId,
          attemptNo: nextAttemptNo(o.triggeringParentId)
        };

      const open = findOpenMain(unit);

      if (open.length === 0) {
        log.debug({
          title: 'RB resolveLogTarget MAIN',
          details: {
            recordType: unit.recordType, recordId: unit.recordId,
            uomId: unit.uomId || null, reason: 'no open work item'
          }
        });
        return { mode: 'MAIN' };
      }

      log.debug({
        title: 'RB resolveLogTarget CHILD',
        details: {
          recordType: unit.recordType, recordId: unit.recordId,
          uomId: unit.uomId || null, parentId: open[0],
          openFound: open.length
        }
      });

      // The main record's target payload always tracks the LATEST intent.
      try {
        record.submitFields({
          type: C.REC.LOG, id: open[0],
          values: { [L.payload]: util.clip(payload || '', 100000) },
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) { /* non-fatal */ }

      if (open.length > 1) {
        // ANOMALY, not an error. Two executions raced, or an earlier build
        // minted a second parent. §12.6 — keep the NEWEST as the survivor and
        // close the rest as Closed - Merged, pointing at it.
        //
        // Previously this only TAGGED them 'Duplicate open work items' and left
        // them all open, so every extra parent stayed on the reconciliation
        // page for ever and the next save made another one.
        log.audit({
          title: 'RB duplicate open work items',
          details: {
            recordType: unit.recordType, recordId: unit.recordId,
            uomId: unit.uomId || null, survivor: open[0],
            merged: open.slice(1)
          }
        });
        mergeDuplicates(open[0], open);
      }
      return { mode: 'CHILD', parentId: open[0], attemptNo: nextAttemptNo(open[0]) };
    };

    const nextAttemptNo = (parentId) => {
      try {
        const v = search.lookupFields({ type: C.REC.LOG, id: parentId, columns: [L.attempts] });
        return (Number(v[L.attempts]) || 0) + 1;
      } catch (e) { return 1; }
    };

    /** Subject block — written on every record, main and child alike. */
    const subjectValues = (entry, unit, cfg, operation) => {
      const v = {};
      v[L.direction] = lid(C.LIST.direction, C.DIRECTION.OUTBOUND);
      v[L.type] = lid(C.LIST.syncType, entry.syncType);
      v[L.operation] = lid(C.LIST.operation, operation || C.OPERATION.UPDATE);
      v[L.recType] = String(unit.recordType);
      v[L.nsId] = String(unit.recordId);
      if (unit.storedUuid) v[L.uuid] = unit.storedUuid;
      if (cfg && cfg.id) v[L.config] = cfg.id;
      if (cfg && cfg.subsidiary) v[L.subsidiary] = cfg.subsidiary;
      // Point the typed subject field at the record this work item is about.
      if (entry.logSubjectField) v[entry.logSubjectField] = unit.recordId;
      if (unit.uomId) v[L.uom] = unit.uomId;
      return v;
    };

    /**
     * Create the ONE record for this call. Nothing else creates a Sync Log row.
     * @returns {{id:string, target:Object, startedAt:number}}
     */
    const openCall = (target, o) => {
      const { entry, unit, cfg, operation } = o;
      const rec = record.create({ type: C.REC.LOG });
      const v = subjectValues(entry, unit, cfg, operation);

      v[L.ref] = makeRef(entry, unit);
      v[L.correlation] = o.correlation || util.uuid();
      v[L.role] = lid(C.LIST.logRole,
        target.mode === 'MAIN' ? C.ROLE.PARENT : C.ROLE.CHILD);
      // A row for a call that will NOT be made (dry run, environment gate, kill
      // switch) is not an attempt. Attempt 0, and it must not bump the parent's
      // attempt count — otherwise the retry cap is spent on calls that never
      // happened and the work item exhausts itself without ever trying.
      const noCall = !!o.noCall;

      v[L.attemptNo] = noCall ? 0
        : (target.mode === 'MAIN' ? 1 : (target.attemptNo || 1));
      if (target.mode === 'CHILD') v[L.parent] = target.parentId;

      // call detail. §3 list 7: `Initial` appears only on a MAIN record. A save
      // that joins an already-open work item is a New Sync, not an Initial one.
      let trigger = o.trigger || C.TRIGGER.INITIAL;
      if (target.mode === 'CHILD' &&
        (trigger === C.TRIGGER.INITIAL || trigger === C.TRIGGER.CSV))
        trigger = C.TRIGGER.NEW_SYNC;
      v[L.trigger] = lid(C.LIST.trigger, trigger);
      v[L.started] = new Date();
      v[L.endpoint] = util.clip(o.endpoint, 300);
      v[L.method] = lid(C.LIST.httpMethod, o.method);
      v[L.context] = String(runtime.executionContext);
      v[L.user] = runtime.getCurrentUser().id;
      if (o.requestUuid) v[L.requestUuid] = o.requestUuid;
      if (o.payload) v[L.attemptPayload] = util.clip(o.payload, 100000);
      if (capturing(cfg, 'request')) v[L.request] = redact(o.request, cfg);

      // main-record-only roll-up
      if (target.mode === 'MAIN') {
        v[L.status] = lid(C.LIST.syncStatus, C.STATUS.OPEN_RETRYING);
        v[L.open] = true;
        v[L.success] = false;
        v[L.payload] = util.clip(o.payload || '', 100000);
        v[L.attempts] = noCall ? 0 : 1;
        v[L.firstAt] = new Date();
        v[L.lastAt] = new Date();
        if (o.reason) v[L.reason] = lid(C.LIST.reconReason, o.reason);
      } else {
        // §4.2.3 — a CHILD describes one call and nothing else. These fields
        // have RECORD-LEVEL DEFAULTS (status 'Open - Retrying', open T), so
        // leaving them unset does not leave them blank: every child would claim
        // to be an open, retrying work item. They have to be blanked by hand.
        v[L.status] = '';
        v[L.open] = false;
        v[L.success] = false;
        v[L.attempts] = '';
        v[L.firstAt] = '';
        v[L.notBefore] = '';
        v[L.exhausted] = false;
        v[L.reconStatus] = '';
      }

      Object.keys(v).forEach((f) => {
        if (v[f] !== null && v[f] !== undefined) {
          try { rec.setValue({ fieldId: f, value: v[f] }); } catch (e) { /* skip */ }
        }
      });

      const id = rec.save({ ignoreMandatoryFields: true });

      log.debug({
        title: 'RB openCall ' + id,
        details: {
          role: target.mode, parentId: target.parentId || null,
          attemptNo: v[L.attemptNo], operation: operation || C.OPERATION.UPDATE,
          method: o.method, endpoint: o.endpoint,
          recordType: unit.recordType, recordId: unit.recordId,
          uomId: unit.uomId || null, uuid: unit.storedUuid || null,
          correlation: v[L.correlation], requestUuid: o.requestUuid || null
        }
      });

      if (target.mode === 'CHILD') bumpParentAttempt(target.parentId, noCall);
      return {
        id: id, target: target, startedAt: Date.now(),
        correlation: v[L.correlation]
      };
    };

    const bumpParentAttempt = (parentId, noCall) => {
      try {
        if (noCall) {
          // Touch the clock so the work item does not look abandoned, but do
          // NOT spend an attempt and do NOT claim it is retrying.
          record.submitFields({
            type: C.REC.LOG, id: parentId, values: { [L.lastAt]: new Date() },
            options: { ignoreMandatoryFields: true }
          });
          return;
        }
        const cur = search.lookupFields({
          type: C.REC.LOG, id: parentId,
          columns: [L.attempts]
        });
        record.submitFields({
          type: C.REC.LOG, id: parentId, values: {
            [L.attempts]: (Number(cur[L.attempts]) || 0) + 1,
            [L.lastAt]: new Date(),
            [L.status]: lid(C.LIST.syncStatus, C.STATUS.OPEN_RETRYING)
          }, options: { ignoreMandatoryFields: true }
        });
      } catch (e) { /* non-fatal */ }
    };

    /**
     * Close this call's own record. Append-only: call detail is never rewritten.
     * @returns {Object} the call result the engine branches on
     */
    const closeCall = (logRec, o) => {
      const v = {};
      v[L.completed] = new Date();
      v[L.duration] = o.durationMs !== undefined
        ? o.durationMs : (Date.now() - logRec.startedAt);
      v[L.outcome] = lid(C.LIST.outcome, o.outcome);

      // The record's own Success flag follows its own Call Outcome. A CHILD
      // record is a call in its own right: if that call came back 2xx, the
      // record that describes it is a success, whatever the work item ends up
      // as. Previously only the MAIN record was ever flipped, so a retry that
      // finally worked left its own row reading Success = false.
      v[L.success] = (o.outcome === C.OUTCOME.SUCCESS);

      v[L.units] = remainingUnits();
      if (o.httpStatus !== undefined) v[L.httpStatus] = o.httpStatus;
      if (o.errorClass) v[L.errorClass] = lid(C.LIST.errorClass, o.errorClass);
      if (o.errorCode) v[L.errorCode] = util.clip(o.errorCode, 60);
      if (o.errorMessage) v[L.error] = util.clip(o.errorMessage, 3900);
      if (o.uuid) v[L.uuid] = o.uuid;

      log.debug({
        title: 'RB closeCall ' + logRec.id + ' ' + o.outcome,
        details: {
          role: logRec.target && logRec.target.mode, success: v[L.success],
          httpStatus: o.httpStatus, durationMs: v[L.duration],
          errorCode: o.errorCode || null, uuid: o.uuid || null,
          unitsLeft: v[L.units]
        }
      });

      try {
        record.submitFields({
          type: C.REC.LOG, id: logRec.id, values: v,
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) { log.error({ title: 'RB closeCall', details: e }); }

      return {
        ok: o.outcome === C.OUTCOME.SUCCESS,
        suppressed: !!o.suppressed,
        dryRun: o.outcome === C.OUTCOME.DRY_RUN,
        skipped: o.outcome === C.OUTCOME.SKIPPED,
        uuid: o.uuid || null,
        httpStatus: o.httpStatus,
        errorClass: o.errorClass || null,
        errorCode: o.errorCode || null,
        errorMessage: o.errorMessage || null,
        logId: logRec.id,
        target: logRec.target
      };
    };

    /** Roll the WORK ITEM up on the main record. Success closes it. §12.4. */
    const closeSuccess = (target, res) => {
      const mainId = target.mode === 'MAIN' ? res.logId : target.parentId;
      log.debug({
        title: 'RB closeSuccess work item ' + mainId,
        details: {
          closedBy: res.logId, role: target.mode,
          uuid: res.uuid || null, httpStatus: res.httpStatus
        }
      });
      try {
        record.submitFields({
          type: C.REC.LOG, id: mainId, values: {
            [L.status]: lid(C.LIST.syncStatus, C.STATUS.CLOSED_SUCCESS),
            [L.open]: false,
            [L.success]: true,
            [L.lastAt]: new Date(),
            [L.notBefore]: '',
            [L.error]: '',
            [L.errorCode]: '',
            [L.exhausted]: false,
            [L.reconStatus]: lid(C.LIST.reconStatus, 'Resolved'),
            [L.resolvedOn]: new Date()
          }, options: { ignoreMandatoryFields: true }
        });
      } catch (e) { log.error({ title: 'RB closeSuccess', details: e }); }
    };

    /**
     * A child row recorded a call that never went out. openCall already moved
     * the parent to 'Open - Retrying'; that is now false. Move it back to
     * 'Open - Pending Retry' and say why, without touching its attempt count
     * (bumpParentAttempt already skipped that for a no-call row).
     */
    const restoreParent = (parentId, note) => {
      if (!parentId) return;
      try {
        record.submitFields({
          type: C.REC.LOG, id: parentId, values: {
            [L.status]: lid(C.LIST.syncStatus, C.STATUS.OPEN_PENDING),
            [L.open]: true,
            [L.lastAt]: new Date(),
            [L.reason]: lid(C.LIST.reconReason, C.REASON.AWAITING_DECISION),
            [L.reconStatus]: lid(C.LIST.reconStatus, 'Open'),
            [L.error]: util.clip(note || '', 3900)
          }, options: { ignoreMandatoryFields: true }
        });
      } catch (e) { log.error({ title: 'RB restoreParent', details: e }); }
    };

    /**
     * §12.9 — the call was built, stringified and logged, but deliberately NOT
     * sent: dry-run mode, or the environment gate refusing a non-production
     * account. The work item CLOSES as "Closed - No Action Needed"; the record
     * keeps Call Outcome "Dry Run" and the stored payload, so a human can read
     * exactly what would have gone over the wire.
     *
     * MAIN records only. A dry run that landed as a CHILD of an open work item
     * proves nothing about that work item — the real change is still unsent,
     * and closing its parent would hide it.
     */
    const closeNoAction = (target, res, note) => {
      if (target.mode !== 'MAIN') {
        // The parent's real change is still unsent, so it stays OPEN — but
        // openCall flipped it to 'Open - Retrying' and nothing is retrying.
        // Put it back to Pending Retry with the reason on it.
        restoreParent(target.parentId, note);
        log.debug({
          title: 'RB no-action call under an open work item ' + target.parentId,
          details: { child: res.logId, note: note, parentLeftOpen: true }
        });
        return false;
      }
      try {
        record.submitFields({
          type: C.REC.LOG, id: res.logId, values: {
            [L.status]: lid(C.LIST.syncStatus, C.STATUS.CLOSED_NO_ACTION),
            [L.open]: false,
            [L.success]: false,
            [L.lastAt]: new Date(),
            [L.notBefore]: '',
            [L.exhausted]: false,
            [L.reconStatus]: lid(C.LIST.reconStatus, 'Resolved'),
            [L.resolvedOn]: new Date(),
            [L.resolution]: util.clip(note, 3900)
          }, options: { ignoreMandatoryFields: true }
        });
        log.debug({
          title: 'RB closeNoAction work item ' + res.logId,
          details: { outcome: res.dryRun ? 'Dry Run' : 'Skipped', note: note }
        });
        return true;
      } catch (e) {
        log.error({ title: 'RB closeNoAction', details: e });
        return false;
      }
    };

    /**
     * The call was refused locally and the change is STILL UNSENT: the kill
     * switch. The work item must stay open — queuing the work until someone
     * turns the switch back on is the entire point — but not as
     * "Open - Retrying", because nothing is retrying. Park it as
     * "Open - Pending Retry" with a back-off and a reason a human can read.
     *
     * MAIN records only, for the same reason as closeNoAction.
     */
    const parkUnsent = (target, res, cfg, reason, note) => {
      if (target.mode !== 'MAIN') {
        restoreParent(target.parentId, note || res.errorMessage);
        return false;
      }
      try {
        record.submitFields({
          type: C.REC.LOG, id: res.logId, values: {
            [L.status]: lid(C.LIST.syncStatus, C.STATUS.OPEN_PENDING),
            [L.open]: true,
            [L.success]: false,
            [L.lastAt]: new Date(),
            [L.notBefore]: backoff(1, cfg),
            [L.reason]: lid(C.LIST.reconReason, reason || C.REASON.AWAITING_DECISION),
            [L.reconStatus]: lid(C.LIST.reconStatus, 'Open'),
            [L.error]: util.clip(note || res.errorMessage || '', 3900)
          }, options: { ignoreMandatoryFields: true }
        });
        log.debug({
          title: 'RB parkUnsent work item ' + res.logId,
          details: { reason: reason, note: note, errorCode: res.errorCode || null }
        });
        return true;
      } catch (e) {
        log.error({ title: 'RB parkUnsent', details: e });
        return false;
      }
    };

    /**
     * A no-change gate fired while an OPEN work item from an earlier FAILED
     * attempt is still sitting there.
     *
     * The case: record created and synced (payload P1). Someone edits it to P2.
     * That sync fails, so a main work item stays open, retrying. Someone then
     * edits the record back to P1. The engine now correctly decides there is
     * nothing to send — and because it sends nothing, nothing ever reaches
     * closeSuccess, and that open work item describes a problem that no longer
     * exists. It would sit on the reconciliation page for ever.
     *
     * So the no-change gates close it here instead.
     *
     * Closed as "No Action Needed", NOT as Success, and `success` is left
     * FALSE on purpose. Success is the flag lastSuccess() searches on, and this
     * record's attempt payload is the one the Middleware REFUSED. Flipping it
     * would publish a rejected payload as "what the destination currently has",
     * and the next genuine edit back to P2 would be skipped as no-change — a
     * silent, permanent desync. The work item closes; the call stays failed.
     *
     * @param {Object} unit
     * @param {string} note    why it closed, for the human reading the record
     * @param {string} [status] Closed - No Action Needed by default; pass
     *                          Closed - Cancelled when the reason is that the
     *                          subject stopped being in scope at all.
     * @returns {number} how many work items were closed
     */
    const closeStaleWorkItem = (unit, note, status) => {
      const open = findOpenMain(unit);
      if (!open.length) return 0;

      log.audit({
        title: 'RB closing stale work item(s)',
        details: {
          recordType: unit.recordType, recordId: unit.recordId,
          uomId: unit.uomId || null, logIds: open, note: note
        }
      });

      let closed = 0;
      open.forEach((id) => {
        try {
          record.submitFields({
            type: C.REC.LOG, id: id, values: {
              [L.status]: lid(C.LIST.syncStatus, status || C.STATUS.CLOSED_NO_ACTION),
              [L.open]: false,
              [L.lastAt]: new Date(),
              [L.notBefore]: '',
              [L.exhausted]: false,
              [L.reconStatus]: lid(C.LIST.reconStatus, 'Resolved'),
              [L.resolvedOn]: new Date(),
              [L.resolution]: util.clip(note, 3900)
            }, options: { ignoreMandatoryFields: true }
          });
          closed++;
        } catch (e) {
          log.error({ title: 'RB closeStaleWorkItem ' + id, details: e });
        }
      });
      return closed;
    };

    /** Failure leaves the work item OPEN with a back-off. §12.10. */
    const closeFailure = (target, res, cfg) => {
      const mainId = target.mode === 'MAIN' ? res.logId : target.parentId;
      let attempts = 1;
      try {
        const cur = search.lookupFields({ type: C.REC.LOG, id: mainId, columns: [L.attempts] });
        attempts = Number(cur[L.attempts]) || 1;
      } catch (e) { /* default 1 */ }

      const maxRetries = Number(cfg && cfg.maxRetries) || 6;
      const retryable = res.errorClass === C.ERRCLASS.RETRYABLE;
      const exhausted = !retryable || attempts > maxRetries;

      const v = {
        [L.lastAt]: new Date(),
        [L.success]: false,
        [L.errorClass]: lid(C.LIST.errorClass, res.errorClass || C.ERRCLASS.RETRYABLE),
        [L.errorCode]: util.clip(res.errorCode || '', 60),
        [L.error]: util.clip(res.errorMessage || '', 3900)
      };

      if (exhausted) {
        v[L.open] = true;
        v[L.exhausted] = !retryable ? false : true;
        v[L.status] = lid(C.LIST.syncStatus,
          retryable ? C.STATUS.OPEN_FAILED : C.STATUS.OPEN_REVIEW);
        v[L.reason] = lid(C.LIST.reconReason,
          retryable ? C.REASON.RETRY_EXHAUSTED : C.REASON.AWAITING_DECISION);
        v[L.reconStatus] = lid(C.LIST.reconStatus, 'Open');
      } else {
        v[L.open] = true;
        v[L.status] = lid(C.LIST.syncStatus, C.STATUS.OPEN_PENDING);
        v[L.notBefore] = backoff(attempts, cfg);
      }

      log.debug({
        title: 'RB closeFailure work item ' + mainId,
        details: {
          closedBy: res.logId, role: target.mode, attempts: attempts,
          maxRetries: maxRetries, errorClass: res.errorClass || null,
          errorCode: res.errorCode || null, retryable: retryable,
          exhausted: exhausted, notBefore: v[L.notBefore] || null
        }
      });

      try {
        record.submitFields({
          type: C.REC.LOG, id: mainId, values: v,
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) { log.error({ title: 'RB closeFailure', details: e }); }
    };

    /** Exponential back-off with a ceiling. */
    const backoff = (attempts, cfg) => {
      const base = Number(cfg && cfg.retryBase) || 60;
      const ceiling = Number(cfg && cfg.retryCeiling) || 3600;
      const secs = Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), ceiling);
      return new Date(Date.now() + secs * 1000);
    };

    /**
     * Beyond the inline cap: record the work item, make no call, let the sweep
     * pick it up. §7.7.
     */
    const openDeferred = (o) => {
      const { entry, unit, cfg, reason } = o;

      // §12.9. These are the rows that exist WITHOUT an HTTP call, because a
      // human has to see them. Status is not one-size-fits-all:
      //   Blocked - no UOM Detail        → Open - Needs Review  (needs a person)
      //   Blocked - missing parent UUID  → Open - Pending Retry (fixes itself)
      //   Deferred - inline cap          → Open - Pending Retry (the sweep has it)
      // Call Outcome is Skipped on all of them: this record made no call, and a
      // blank Call Outcome reads as "not finished yet", which is a lie.
      const status = o.status || C.STATUS.OPEN_PENDING;
      const outcome = o.outcome || C.OUTCOME.SKIPPED;

      // A work item may ALREADY be open for this subject. Minting a second
      // parent is what produced three open parents for one dosage form: every
      // blocked or deferred evaluation created a brand-new main record and
      // ignored the one already sitting there. Join it instead.
      const already = findOpenMain(unit);
      if (already.length) {
        if (already.length > 1) mergeDuplicates(already[0], already);
        const survivor = already[0];
        try {
          const v2 = {
            [L.status]: lid(C.LIST.syncStatus, status),
            [L.open]: true,
            [L.lastAt]: new Date(),
            [L.reason]: lid(C.LIST.reconReason, reason || C.REASON.PAYLOAD_CHANGED),
            [L.reconStatus]: lid(C.LIST.reconStatus, 'Open')
          };
          // The work item always tracks the LATEST intent (§12.5).
          if (o.payload) v2[L.payload] = util.clip(o.payload, 100000);
          if (o.note) v2[L.error] = util.clip(o.note, 3900);
          record.submitFields({
            type: C.REC.LOG, id: survivor, values: v2,
            options: { ignoreMandatoryFields: true }
          });
        } catch (e) { log.error({ title: 'RB openDeferred join', details: e }); }

        log.debug({
          title: 'RB openDeferred joined open work item ' + survivor,
          details: {
            recordType: unit.recordType, recordId: unit.recordId,
            uomId: unit.uomId || null, status: status,
            reason: reason || C.REASON.PAYLOAD_CHANGED
          }
        });
        return survivor;
      }

      try {
        const rec = record.create({ type: C.REC.LOG });
        const v = subjectValues(entry, unit, cfg, C.OPERATION.UPDATE);
        v[L.ref] = makeRef(entry, unit);
        v[L.correlation] = o.correlation || util.uuid();
        v[L.role] = lid(C.LIST.logRole, C.ROLE.PARENT);
        v[L.attemptNo] = 0;
        v[L.status] = lid(C.LIST.syncStatus, status);
        v[L.outcome] = lid(C.LIST.outcome, outcome);
        v[L.open] = true;
        v[L.success] = false;
        v[L.attempts] = 0;
        v[L.firstAt] = new Date();
        v[L.lastAt] = new Date();
        v[L.started] = new Date();
        v[L.completed] = new Date();
        v[L.duration] = 0;
        v[L.payload] = util.clip(o.payload || '', 100000);
        if (o.payload) v[L.attemptPayload] = util.clip(o.payload, 100000);
        v[L.reason] = lid(C.LIST.reconReason, reason || C.REASON.PAYLOAD_CHANGED);
        v[L.reconStatus] = lid(C.LIST.reconStatus, 'Open');
        if (o.note) v[L.error] = util.clip(o.note, 3900);
        v[L.trigger] = lid(C.LIST.trigger, o.trigger || C.TRIGGER.INITIAL);
        v[L.context] = String(runtime.executionContext);
        Object.keys(v).forEach((f) => {
          if (v[f] !== null && v[f] !== undefined) {
            try { rec.setValue({ fieldId: f, value: v[f] }); } catch (e) { /* skip */ }
          }
        });
        const id = rec.save({ ignoreMandatoryFields: true });
        log.debug({
          title: 'RB openDeferred ' + id,
          details: {
            recordType: unit.recordType, recordId: unit.recordId,
            uomId: unit.uomId || null, status: status, outcome: outcome,
            reason: reason || C.REASON.PAYLOAD_CHANGED
          }
        });
        return id;
      } catch (e) {
        log.error({ title: 'RB openDeferred', details: e });
        return null;
      }
    };

    /**
     * §11.5 — the evaluation stamp. Called on EVERY path out of the engine,
     * including the ones that make no API call. One submitFields, always last.
     *
     * These fields are in SYNC_CONTROL_FIELDS, so stamping never re-triggers.
     */
    const stampTry = (unit, result, extra) => {
      if (!unit || !unit.recordId || !unit.tryResultField) return;
      const values = {};
      values[unit.lastTryField] = new Date();
      values[unit.tryResultField] = lid(C.LIST.tryResult, result);
      if (extra) Object.assign(values, extra);

      log.debug({
        title: 'RB stampTry ' + unit.recordType + '/' + unit.recordId,
        details: { result: result, uomId: unit.uomId || null }
      });

      try {
        record.submitFields({
          type: unit.recordType, id: unit.recordId, values: values,
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) {
        log.error({
          title: 'RB stampTry ' + unit.recordType + '/' + unit.recordId,
          details: e
        });
      }
    };

    /** afterSubmit must never re-throw — the record is already committed. */
    const exception = (entry, rec, e) => {
      log.error({
        title: 'RB exception — ' + (entry && entry.key) + ' ' +
          (rec && rec.type) + '/' + (rec && rec.id),
        details: (e && e.stack) || (e && e.message) || String(e)
      });
    };

    /** §12.6 — keep the latest open main record, close the rest as Merged. */
    const mergeDuplicates = (survivorId, loserIds) => {
      let merged = 0;
      (loserIds || []).forEach((id) => {
        if (String(id) === String(survivorId)) return;
        try {
          record.submitFields({
            type: C.REC.LOG, id: id, values: {
              [L.status]: lid(C.LIST.syncStatus, C.STATUS.CLOSED_MERGED),
              [L.open]: false,
              [L.mergedInto]: survivorId,
              [L.reconStatus]: lid(C.LIST.reconStatus, 'Resolved'),
              [L.reconMethod]: lid(C.LIST.reconMethod, 'Merge duplicate work items'),
              [L.resolution]: 'Merged into ' + survivorId + '; duplicate open work item.'
            }, options: { ignoreMandatoryFields: true }
          });
          merged++;
        } catch (e) { log.error({ title: 'RB mergeDuplicates', details: e }); }
      });
      if (merged) {
        try {
          const cur = search.lookupFields({
            type: C.REC.LOG, id: survivorId,
            columns: [L.mergedCount]
          });
          record.submitFields({
            type: C.REC.LOG, id: survivorId, values: {
              [L.mergedCount]: (Number(cur[L.mergedCount]) || 0) + merged
            }, options: { ignoreMandatoryFields: true }
          });
        } catch (e) { /* non-fatal */ }
      }
      return merged;
    };

    // ── capture / redaction ────────────────────────────────────────────────────

    const capturing = (cfg, which) => {
      const mode = String((cfg && cfg.captureText) || (cfg && cfg.capture) || '').toUpperCase();
      if (mode.indexOf('NONE') !== -1) return false;
      if (mode.indexOf('ERROR') !== -1) return false;   // errors only: captured on close
      if (which === 'request' && mode.indexOf('RESPONSE') !== -1
        && mode.indexOf('REQUEST') === -1) return false;
      return true;
    };

    const PII_KEYS = /(^|_)(recipient_name|addressee|line1|line2|phone|email|zip)($|_)/i;

    const redact = (body, cfg) => {
      if (util.blank(body)) return '';
      const cap = Number(cfg && cfg.payloadCap) || 4000;
      if (!cfg || !cfg.redactPii) return util.clip(
        typeof body === 'string' ? body : util.canonical(body), cap);
      let obj = body;
      if (typeof body === 'string') { obj = util.safeJson(body); if (!obj) return util.clip(body, cap); }
      const out = {};
      Object.keys(obj).forEach((k) => { out[k] = PII_KEYS.test(k) ? '[REDACTED]' : obj[k]; });
      return util.clip(util.canonical(out), cap);
    };

    const remainingUnits = () => {
      try { return runtime.getCurrentScript().getRemainingUsage(); } catch (e) { return null; }
    };

    /**
     * The payload the Middleware last ACCEPTED for this subject, read back from
     * the Sync Log instead of from the record.
     *
     * Why this exists. The stored payload field on the record is the fast path
     * and it is right almost always — but it can be blank while the Middleware
     * already holds the object: a sandbox refresh, a field cleared by hand, a
     * restored backup, a Mass Update that cleared it, a UOM row recreated.
     * Calling again in that state is not merely an extra call. With a blank
     * UUID it is a CREATE, and a CREATE of something that already exists is a
     * DUPLICATE product in the Middleware — the single most expensive mistake
     * this integration can make.
     *
     * So before every call the engine asks the log what it last got away with.
     *
     * Newest successful call wins. The search returns the id only; the payload
     * itself is then read with lookupFields, because a long-text column in a
     * search result can come back truncated and a truncated payload would
     * never compare equal.
     *
     * `attemptPayload` is written on EVERY record, main and child alike, so
     * this works whichever role actually closed the success. `payload` (the
     * work-item target, main-record-only) is the fallback.
     *
     * The Sync Type is part of the key. A customer and its addresses log
     * against the SAME record id, and without this filter an address success
     * would answer a question asked about the customer.
     *
     * @param   {Object} unit   the sync unit about to be sent
     * @param   {Object} entry  its C.MASTER dispatch entry, for the Sync Type
     * @returns {{logId:string, payload:string, uuid:string, at:string}|null}
     */
    const lastSuccess = (unit, entry) => {
      if (!unit || !unit.recordType || !unit.recordId) return null;

      try {
        const filters = [
          [L.recType, 'is', String(unit.recordType)], 'AND',
          [L.nsId, 'is', String(unit.recordId)], 'AND',
          [L.success, 'is', 'T']
        ];
        if (entry && entry.syncType) {
          const typeId = lid(C.LIST.syncType, entry.syncType);
          if (typeId) filters.push('AND', [L.type, 'anyof', typeId]);
        }
        // An item is N products, one per UOM row; the unit IS the row, so
        // recType/nsId already separate them. Kept explicit for the case where
        // a caller passes an item-level unit.
        if (unit.uomId) filters.push('AND', [L.uom, 'anyof', unit.uomId]);

        let logId = null;
        search.create({
          type: C.REC.LOG,
          filters: filters,
          columns: [search.createColumn({ name: 'internalid', sort: search.Sort.DESC })]
        }).run().each((r) => { logId = String(r.getValue('internalid')); return false; });

        if (!logId) {
          log.debug({
            title: 'RB lastSuccess ' + unit.recordType + '/' + unit.recordId,
            details: 'no previous successful call on record'
          });
          return null;
        }

        const v = search.lookupFields({
          type: C.REC.LOG, id: logId,
          columns: [L.attemptPayload, L.payload, L.uuid, L.completed]
        });

        const hit = {
          logId: logId,
          payload: String(v[L.attemptPayload] || v[L.payload] || ''),
          uuid: String(v[L.uuid] || ''),
          at: String(v[L.completed] || '')
        };

        log.debug({
          title: 'RB lastSuccess ' + unit.recordType + '/' + unit.recordId,
          details: {
            logId: hit.logId, uuid: hit.uuid || null, at: hit.at,
            payloadLength: hit.payload.length
          }
        });
        return hit;

      } catch (e) {
        // A broken safety net must never break the call it is protecting.
        log.error({
          title: 'RB lastSuccess search ' + unit.recordType + '/' + unit.recordId,
          details: e
        });
        return null;
      }
    };

    const logApi = {
      resolveLogTarget, openCall, closeCall, closeSuccess, closeFailure,
      openDeferred, stampTry, exception, mergeDuplicates, lastSuccess,
      findOpenMain, closeStaleWorkItem, closeNoAction, parkUnsent
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // client — the ONLY place N/https is called
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Build the URL. Trims slashes and encodes path params, so a blank segment
     * can never produce `…/locations//storage_areas`.
     */
    const buildUrl = (endpoint, pathParams, cfg) => {
      const host = String(cfg.domain || '').replace(/\/+$/, '');
      const ver = String(cfg.version || '').replace(/^\/+|\/+$/g, '');
      let path = String(endpoint.path);

      path = path.replace(/\{(\w+)\}/g, (m, key) => {
        const v = pathParams && pathParams[key];
        if (util.blank(v)) throw new Error('Path parameter "' + key + '" is empty for ' + path);
        return encodeURIComponent(v);
      });

      return host + (ver ? '/' + ver : '') + path;
    };

    /**
     * The API key never appears in source or in a log. It is the script id of an
     * API Secret; SecureString substitutes the value inside the platform.
     */
    const secureValue = (cfg) => {
      const secretId = String(cfg.secret || '');
      if (!secretId) throw new Error('No API Secret configured (custrecord_jj_rb_cf_secret)');
      // return https.createSecureString({ input: '{key}' })
      //   .replaceAll({ input: '{key}', replacement: secretId });
      return https.createSecureString({ input: `{${secretId}}` });
    };

    /** Map an HTTP status onto a retry policy. §17.3. */
    const classify = (status) => {
      if (status === 401 || status === 403) return C.ERRCLASS.AUTH;
      if (status === 408 || status === 429) return C.ERRCLASS.RETRYABLE;
      if (status >= 500) return C.ERRCLASS.RETRYABLE;
      if (status === 422 || status === 409) return C.ERRCLASS.BUSINESS;
      if (status >= 400) return C.ERRCLASS.BUSINESS;
      return C.ERRCLASS.POISON;
    };

    const messageFrom = (parsed, raw) => {
      if (parsed) {
        if (parsed.message) return parsed.message;
        if (parsed.error) return typeof parsed.error === 'string'
          ? parsed.error : util.canonical(parsed.error);
        if (parsed.detail) return parsed.detail;
      }
      return util.clip(raw, 900);
    };

    /**
     * One call. One log record. Always returns a closed call object — never
     * `false`, so no caller can read `.code` off a boolean.
     */
    const call = (o) => {
      const cfg = o.cfg;

      // ── The gate comes first. Before the timeout, before redaction, before
      //    https.request. One gate, inside the client, unbypassable: a new
      //    record type gets it for free and no developer can forget it.
      const gate = envGate(cfg);

      // Decide BEFORE the row is created whether a call will happen at all.
      // A row for a call that never goes out must not spend an attempt, must
      // not read as attempt 1, and must not flip its parent to 'Retrying'.
      const noCall = !gate.allowed || !!cfg.killswitch || !!cfg.dryRun;
      if (noCall) {
        log.audit({
          title: 'RB no call will be made',
          details: {
            envGateAllowed: gate.allowed, gateReason: gate.reason || null,
            killswitch: !!cfg.killswitch, dryRun: !!cfg.dryRun,
            recordType: o.unit && o.unit.recordType,
            recordId: o.unit && o.unit.recordId
          }
        });
      }

      let url;
      try {
        url = buildUrl(o.endpoint, o.pathParams, cfg);
      } catch (e) {
        const bad = openCall(o.target, {
          entry: o.entry, unit: o.unit, cfg: cfg, operation: o.operation,
          trigger: o.trigger, endpoint: String(o.endpoint.path), method: o.endpoint.method,
          payload: o.payload, request: o.body, correlation: o.correlation,
          requestUuid: o.requestUuid, noCall: noCall
        });
        return closeCall(bad, {
          outcome: C.OUTCOME.FAILURE,
          errorClass: C.ERRCLASS.BUSINESS, errorCode: 'BAD_PATH_PARAM',
          errorMessage: e.message
        });
      }

      const logRec = openCall(o.target, {
        entry: o.entry, unit: o.unit, cfg: cfg, operation: o.operation,
        trigger: o.trigger, endpoint: url, method: o.endpoint.method,
        payload: o.payload, request: o.body, correlation: o.correlation,
        requestUuid: o.requestUuid, noCall: noCall
      });

      if (!gate.allowed) {
        // Exactly a dry run: built, stringified, validated, logged — nothing sent.
        // Not an error: it does not increment retries and does not enter the
        // failure worklist.
        log.audit({ title: 'RB ENV GATE — call suppressed', details: gate });
        return closeCall(logRec, {
          outcome: C.OUTCOME.DRY_RUN, suppressed: true,
          errorCode: 'ENV_GATE', errorMessage: gate.reason
        });
      }

      if (cfg.killswitch)
        return closeCall(logRec, {
          outcome: C.OUTCOME.SKIPPED, durationMs: 0,
          errorClass: C.ERRCLASS.RETRYABLE, errorCode: 'KILLSWITCH',
          errorMessage: 'Kill switch is on; no call was made.'
        });

      if (cfg.dryRun)
        return closeCall(logRec, {
          outcome: C.OUTCOME.DRY_RUN, durationMs: 0, errorCode: 'DRY_RUN',
          errorMessage: 'Dry-run mode is on; the payload was built and stored ' +
            'but nothing was sent.'
        });

      const headers = {
        'Content-Type': cfg.contentType || 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      };
      try {
        // headers[cfg.authHeader || 'Authorization'] = secureValue(cfg);
        headers[cfg.authHeader || 'Authorization'] = String(cfg.secret || '');;
      } catch (e) {
        return closeCall(logRec, {
          outcome: C.OUTCOME.FAILURE,
          errorClass: C.ERRCLASS.AUTH, errorCode: 'NO_SECRET', errorMessage: e.message
        });
      }

      const noBody = o.endpoint.method === 'GET' || o.endpoint.method === 'DELETE';
      const started = Date.now();
      let res = null, thrown = null;

      try {
        log.audit("Requesting " + o.endpoint.method + " " + url, {
          headers: headers,
          body: noBody ? undefined : util.encodeBody(o.body, cfg),
          timeout: (Number(cfg.timeout) || 8) * 1000
        });

        // let testApiResponse = 'success';

        // if (testApiResponse === 'success') {
        //   res = { code: 200, body: JSON.stringify({ success: true, uuid: 'TEST-UUID-00000001' }) };
        // } else if (testApiResponse === 'error') {
        //   res = { code: 500, body: JSON.stringify({ success: false }) };
        // }

        res = https.request({
          method: o.endpoint.method,
          url: url,
          headers: headers,
          body: noBody ? undefined : util.encodeBody(o.body, cfg),
          timeout: (Number(cfg.timeout) || 8) * 1000        // ALWAYS set
        });
      } catch (e) { thrown = e; }

      const ms = Date.now() - started;

      if (thrown)
        return closeCall(logRec, {
          outcome: C.OUTCOME.FAILURE, durationMs: ms,
          errorClass: C.ERRCLASS.RETRYABLE, errorCode: 'NO_RESPONSE',
          errorMessage: thrown.message || String(thrown)
        });

      const status = Number(res.code);
      const ok = status >= 200 && status < 300;       // the whole 2xx family
      const parsed = util.safeJson(res.body);

      const closed = {
        outcome: ok ? C.OUTCOME.SUCCESS : C.OUTCOME.FAILURE,
        httpStatus: status, durationMs: ms
      };
      if (capturing(cfg, 'response') || !ok)
        closed.response = util.clip(res.body, Number(cfg.payloadCap) || 4000);
      if (ok) {
        closed.uuid = parsed && (parsed.uuid || (parsed.data && parsed.data.uuid));
      } else {
        closed.errorClass = classify(status);
        closed.errorCode = 'HTTP_' + status;
        closed.errorMessage = messageFrom(parsed, res.body);
      }

      const result = closeCall(logRec, closed);
      result.body = parsed;
      // Store the raw response on the record too, when capture allows it.
      if (closed.response) {
        try {
          record.submitFields({
            type: C.REC.LOG, id: logRec.id,
            values: { [L.response]: closed.response },
            options: { ignoreMandatoryFields: true }
          });
        } catch (e) { /* non-fatal */ }
      }
      return result;
    };

    const client = { call, envGate, buildUrl };

    // Exported as `logIo`, not `log`. A consumer that destructures `log` from
    // this module shadows the SuiteScript global of the same name and loses
    // log.debug / log.audit / log.error. `log` is kept as an alias so nothing
    // that still asks for it breaks.
    return { logIo: logApi, log: logApi, client };
  });
