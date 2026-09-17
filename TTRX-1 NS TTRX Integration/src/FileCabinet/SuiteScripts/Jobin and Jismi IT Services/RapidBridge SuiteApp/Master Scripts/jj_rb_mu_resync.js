/**
 * @NApiVersion 2.1
 * @NScriptType MassUpdateScript
 * @NModuleScope SameAccount
 *
 * jj_rb_mu_resync — force a re-sync of selected master records.
 *
 * DEPLOYED TO MASTER DATA RECORD TYPES ONLY. There is no bulk transaction
 * re-sync, and a Mass Update offered on a Sales Order list is an invitation to
 * do the thing the scope says is not built — Transaction Guide §1.5.4.
 *
 * PHASE 1: customrecord_jj_rb_dosage_form, location.
 *
 * What "force" means: CLEAR THE STORED PAYLOAD, then run the engine. The
 * stored payload is the trigger (§2.2), so clearing it is the whole mechanism
 * — the engine then compares against nothing and calls out.
 *
 * The UUID is deliberately NOT cleared. Clearing it would turn every update
 * into a create and produce a duplicate in the Middleware.
 *
 * §7.12.
 */
define(['N/record', '../Common/jj_rb_core', '../Common/jj_rb_io', '../Common/jj_rb_sync'],
  (record, core, io, sync) => {

    const { C, util, config } = core;
    const { log } = io;

    const each = (params) => {
      const recordType = params.type;
      const recordId = params.id;

      const entry = C.MASTER[String(recordType).toLowerCase()];
      if (!entry || entry.key === 'CONFIG') return;

      try {
        const cfg = config.get();
        if (!cfg) {
          log.exception(entry, { type: recordType, id: recordId },
            new Error('No active RapidBridge configuration — nothing was re-synced.'));
          return;
        }

        if (entry.featureFlag && cfg[flagKey(entry.featureFlag)] !== true) {
          const f = entry.fields || {};
          if (f.lastTry && f.tryResult)
            log.stampTry({
              recordType: recordType, recordId: recordId,
              lastTryField: f.lastTry, tryResultField: f.tryResult
            },
              C.TRY.SKIP_FEATURE);
          return;
        }

        // Clear the stored payload — and ONLY that. This is the force.
        if (entry.fields && entry.fields.payload) {
          record.submitFields({
            type: recordType, id: recordId,
            values: { [entry.fields.payload]: '' },
            options: { ignoreMandatoryFields: true }
          });
        }

        sync.run({
          entry: entry, recordId: recordId, recordType: recordType, cfg: cfg,
          trigger: C.TRIGGER.MASS_UPDATE
        });

      } catch (e) {
        // A Mass Update must not abandon the remaining rows because one failed.
        log.exception(entry, { type: recordType, id: recordId }, e);
      }
    };

    const flagKey = (fieldId) => {
      const keys = Object.keys(C.CFG);
      for (let i = 0; i < keys.length; i++)
        if (C.CFG[keys[i]] === fieldId) return keys[i];
      return fieldId;
    };

    return { each };
  });
