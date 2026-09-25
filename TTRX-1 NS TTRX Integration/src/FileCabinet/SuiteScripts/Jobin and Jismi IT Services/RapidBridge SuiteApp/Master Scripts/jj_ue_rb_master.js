/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * jj_rb_ue_master — the ONE master-data User Event.
 *
 * DEPLOYMENTS (12):
 *   customrecord_jj_rb_dosage_form
 *   location
 *   customer · vendor
 *   inventoryitem · lotnumberedinventoryitem · serializedinventoryitem ·
 *   assemblyitem · kititem
 *   customrecord_jj_rb_uom_detail    ← delegates to its parent item, that row only
 *   customrecord_jj_rb_config        ← validator only, never syncs
 *
 * NOT DEPLOYED YET: bin. It is declared in C.MASTER with implemented:false and
 * fails loudly if deployed, rather than quietly doing nothing.
 *
 * It knows nothing about any of them. Everything comes from C.MASTER[type].
 *
 * Master Data Developer Guide v3.4 §7.9, §10.0.1.
 */
define(['N/runtime', '../Common/jj_rb_core', '../Common/jj_rb_io', '../Common/jj_rb_sync'],
  (runtime, core, io, sync) => {

    const { C, util, config } = core;
    const { logIo } = io;

    const entryFor = (t) => C.MASTER[String(t).toLowerCase()] || null;

    // ── beforeLoad ─────────────────────────────────────────────────────────────
    // Two jobs only: lock our fields, and clear everything on COPY.
    // It is NOT part of the trigger — the stored payload is (§2.2).
    const beforeLoad = (ctx) => {
      try {
        const entry = entryFor(ctx.newRecord.type);

        log.debug('Master UE - beforeLoad', { recordType: ctx.newRecord.type, recordId: ctx.newRecord.id || null, eventType: ctx.type, entry: entry ? entry.key : null });

        if (!entry || entry.key === 'CONFIG') return;

        sync.lockSyncFields(ctx.form, entry);

        if (ctx.type === ctx.UserEventType.COPY)
          sync.clearAllSyncFields(ctx.newRecord, entry);
      } catch (e) {
        logIo.exception(null, ctx && ctx.newRecord, e);
      }
    };

    // ── beforeSubmit ───────────────────────────────────────────────────────────
    // Validation that must be able to BLOCK a save, plus delete bookkeeping.
    // This is the ONLY place a save can be stopped (P2).
    const beforeSubmit = (ctx) => {
      const entry = entryFor(ctx.newRecord.type);
      if (!entry) return;

      log.debug('Master UE - beforeSubmit', { recordType: ctx.newRecord.type, recordId: ctx.newRecord.id || null, eventType: ctx.type, entry: entry.key });

      // The one save the SuiteApp refuses — a second Active configuration row.
      // Deliberately outside the try/catch: it MUST be able to throw.
      //
      // Called, NOT returned. A User Event entry point must resolve to
      // undefined; NetSuite serialises whatever comes back and a non-trivial
      // value surfaces to the user as "An unexpected error has occurred".
      if (entry.key === 'CONFIG') { sync.validateConfig(ctx); return; }

      try {
        if (ctx.type === ctx.UserEventType.DELETE) {
          sync.cacheForDelete(ctx.oldRecord, entry);   // UUID unreadable later
          return;
        }

        // Dosage Form: the code is the identity and is immutable after create.
        // Default it from the name rather than refusing the save.
        if (entry.key === 'DOSAGE' && ctx.type === ctx.UserEventType.CREATE) {
          const codeField = entry.fields.code;
          if (util.blank(ctx.newRecord.getValue({ fieldId: codeField }))) {
            const nm = ctx.newRecord.getValue({ fieldId: 'name' });
            if (!util.blank(nm))
              ctx.newRecord.setValue({ fieldId: codeField, value: nm });
          }
        }

        if (entry.key === 'UOM') sync.validateUomRow(ctx, entry);
        if (entry.key === 'ITEM') sync.validateItem(ctx, entry);

      } catch (e) {
        logIo.exception(entry, ctx.newRecord, e);
      }
    };

    // ── afterSubmit ────────────────────────────────────────────────────────────
    const afterSubmit = (ctx) => {
      const entry = entryFor(ctx.newRecord.type);
      if (!entry) {
        // Deployed to a record type the dispatch table does not know. Silence
        // here looks exactly like a script that did not run at all.
        log.audit({
          title: 'RB no dispatch entry for ' + ctx.newRecord.type,
          details: 'The User Event is deployed to this record type but the ' +
            'dispatch table has no entry for it, so nothing can be synced.'
        });
        return;
      }
      if (entry.key === 'CONFIG') return;             // Config never syncs

      try {
        log.debug('Master UE - afterSubmit', { recordType: ctx.newRecord.type, recordId: ctx.newRecord.id, eventType: ctx.type, entry: entry.key });

        const cfg = config.get();
        log.debug("Master UE - afterSubmit config", cfg);

        if (ctx.type === ctx.UserEventType.DELETE) {
          if (!cfg) return;
          log.debug('Master UE - processing delete', { recordType: ctx.oldRecord.type, recordId: ctx.oldRecord.id, entry: entry.key });

          // Call it, do not return it. handleDelete returns one call-result
          // object per unit; returning that array out of afterSubmit is what
          // produced "An unexpected error has occurred" — NetSuite serialises
          // an entry point's return value, and these objects are not meant to
          // leave the script. Every entry point here resolves to undefined.
          const result = sync.handleDelete(entry, ctx.oldRecord, cfg);
          log.debug('Master UE - delete handled', {
            units: (result && result.length) || 0,
            ok: (result || []).filter(function (r) { return r && r.ok; }).length
          });
          return;
        }

        // ── P4. GUARD 1 — free. Our own write-back changes only sync-control
        //    fields, and this is what stops it re-triggering the sync.
        if (util.onlySyncFieldsChanged(ctx.oldRecord, ctx.newRecord, C.SYNC_CONTROL_FIELDS)) {
          log.debug({
            title: 'RB skipped: only sync-control fields changed',
            details: { recordType: ctx.newRecord.type, recordId: ctx.newRecord.id }
          });
          return;
        }

        log.debug("After onlySyncFieldsChanged");

        // ── P5. No configuration ⇒ do not guess a host. Say so: without this
        //    line, every record type on the account goes quiet with nothing in
        //    the log to explain it.
        if (!cfg) {
          log.audit({
            title: 'RB no active configuration row',
            details: 'Exactly one RapidBridge Configuration row must have ' +
              'Active ticked and not be inactive. Nothing is synced until it does.'
          });
          return;
        }

        // ── P6. Feature gate. Dosage Form needs use_dosage; Bin needs use_bins.
        if (entry.featureFlag && cfg[flagKey(entry.featureFlag)] !== true) {
          log.debug('Master UE - feature disabled', { recordType: ctx.newRecord.type, recordId: ctx.newRecord.id, entry: entry.key, featureFlag: entry.featureFlag, configKey: flagKey(entry.featureFlag) });
          stampFeatureSkip(entry, ctx.newRecord);
          return;
        }

        // ── GUARD 2 — the payload comparison, inside sync.run().
        log.debug('Master UE - starting sync', { recordType: ctx.newRecord.type, recordId: ctx.newRecord.id, entry: entry.key, isCreate: ctx.type === ctx.UserEventType.CREATE });
        sync.run({
          entry: entry,
          recordId: ctx.newRecord.id,
          recordType: ctx.newRecord.type,
          newRecord: ctx.newRecord,
          cfg: cfg,
          trigger: triggerFor(runtime.executionContext),
          isCreate: ctx.type === ctx.UserEventType.CREATE
        });

        log.debug('Master UE - sync completed', { recordType: ctx.newRecord.type, recordId: ctx.newRecord.id, entry: entry.key });
        log.debug('Governance remaining after sync', { governance: runtime.getCurrentScript().getRemainingUsage() });
      } catch (e) {
        // NEVER re-throw in afterSubmit: the record is already committed.
        logIo.exception(entry, ctx.newRecord, e);
      }
    };

    /** C.MASTER stores the field id; config.get() keys the row by short name. */
    const flagKey = (fieldId) => {
      const keys = Object.keys(C.CFG);
      for (let i = 0; i < keys.length; i++)
        if (C.CFG[keys[i]] === fieldId) return keys[i];
      return fieldId;
    };

    /** A closed gate is still an evaluation, and it must be visible. §11.5. */
    const stampFeatureSkip = (entry, rec) => {
      const f = entry.fields || {};

      // Turning a feature off while a work item is open would leave that work
      // item retrying for ever against a sync nobody wants any more. Cancel it.
      logIo.closeStaleWorkItem(
        { recordType: rec.type, recordId: rec.id, uomId: null },
        'Cancelled: the ' + entry.key + ' feature was switched off in the ' +
        'RapidBridge configuration, so this sync is no longer wanted.',
        C.STATUS.CLOSED_CANCELLED);

      if (!f.lastTry || !f.tryResult) return;
      // errorField is passed so the stamp can CLEAR any error left by an
      // earlier evaluation: the feature being off is not a fault of the record.
      logIo.stampTry({
        recordType: rec.type, recordId: rec.id,
        lastTryField: f.lastTry, tryResultField: f.tryResult,
        errorField: f.error || null
      }, C.TRY.SKIP_FEATURE, null, '');

      log.debug('Master UE - feature skip stamped', { recordType: rec.type, recordId: rec.id, entry: entry.key, result: C.TRY.SKIP_FEATURE });
    };

    const triggerFor = (x) => {
      if (x === runtime.ContextType.CSV_IMPORT) return C.TRIGGER.CSV;
      if (x === runtime.ContextType.MASS_UPDATE) return C.TRIGGER.MASS_UPDATE;
      if (x === runtime.ContextType.MAP_REDUCE) return C.TRIGGER.RECON;
      if (x === runtime.ContextType.SCHEDULED) return C.TRIGGER.RECON;
      return C.TRIGGER.INITIAL;
    };

    return { beforeLoad, beforeSubmit, afterSubmit };
  });