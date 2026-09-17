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

      // The one save the SuiteApp refuses — a second Active configuration row.
      // Deliberately outside the try/catch: it MUST be able to throw.
      if (entry.key === 'CONFIG') return sync.validateConfig(ctx);

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
      if (!entry || entry.key === 'CONFIG') return;   // Config never syncs

      try {
        const cfg = config.get();

        if (ctx.type === ctx.UserEventType.DELETE) {
          if (!cfg) return;
          return sync.handleDelete(entry, ctx.oldRecord, cfg);
        }

        // ── P4. GUARD 1 — free. Our own write-back changes only sync-control
        //    fields, and this is what stops it re-triggering the sync.
        if (util.onlySyncFieldsChanged(ctx.oldRecord, ctx.newRecord,
          C.SYNC_CONTROL_FIELDS)) return;

        // ── P5. No configuration ⇒ return silently rather than guess a host.
        if (!cfg) return;

        // ── P6. Feature gate. Dosage Form needs use_dosage; Bin needs use_bins.
        if (entry.featureFlag && cfg[flagKey(entry.featureFlag)] !== true) {
          stampFeatureSkip(entry, ctx.newRecord);
          return;
        }

        // ── GUARD 2 — the payload comparison, inside sync.run().
        sync.run({
          entry: entry,
          recordId: ctx.newRecord.id,
          recordType: ctx.newRecord.type,
          newRecord: ctx.newRecord,
          cfg: cfg,
          trigger: triggerFor(runtime.executionContext),
          isCreate: ctx.type === ctx.UserEventType.CREATE
        });

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
      if (!f.lastTry || !f.tryResult) return;
      logIo.stampTry({
        recordType: rec.type, recordId: rec.id,
        lastTryField: f.lastTry, tryResultField: f.tryResult
      }, C.TRY.SKIP_FEATURE);
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