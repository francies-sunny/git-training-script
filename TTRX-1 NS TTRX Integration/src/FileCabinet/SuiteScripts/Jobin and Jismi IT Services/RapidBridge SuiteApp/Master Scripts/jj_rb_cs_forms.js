/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 *
 * jj_rb_cs_forms — one Client Script, one job per deployed record type.
 *
 * Client-side rules are ADVISORY. Every one of them is also enforced in
 * beforeSubmit, because a Client Script does not run on CSV import, Mass
 * Update, SuiteTalk or Map/Reduce. This exists to tell the user now rather
 * than after the save.
 *
 * PHASE 1 DEPLOYMENTS (3):
 *   customrecord_jj_rb_config        fieldChanged on Active  — warn on a clash
 *   customrecord_jj_rb_dosage_form   saveRecord              — warn on a blank code
 *   customrecord_jj_rb_sync_log      pageInit                — hide main-only groups
 *
 * LATER: Item ×5 (saveRecord, no active UOM row), UOM Detail (fieldChanged on
 * Saleable Unit).  §7.10.
 */
define(['N/currentRecord', 'N/search', 'N/ui/dialog', '../Common/jj_rb_core'],
  (currentRecord, search, dialog, core) => {

    const { C, util } = core;

    // Which job belongs to which record type.
    const JOBS = {
      customrecord_jj_rb_config: {
        fieldChanged: (ctx) => {
          if (ctx.fieldId !== C.CFG.active) return;
          const rec = ctx.currentRecord;
          if (!util.truthy(rec.getValue({ fieldId: C.CFG.active }))) return;

          let other = null;
          try {
            search.create({
              type: C.REC.CONFIG,
              filters: [[C.CFG.active, 'is', 'T'], 'AND', ['isinactive', 'is', 'F']],
              columns: ['internalid', 'name']
            }).run().each((r) => {
              if (String(r.getValue('internalid')) !== String(rec.id)) {
                other = r.getValue('name') || r.getValue('internalid');
                return false;
              }
              return true;
            });
          } catch (e) { return; }

          if (other)
            dialog.alert({
              title: 'Another configuration is already Active',
              message: '"' + other + '" is Active. Exactly one row may be Active, ' +
                'and the save will be refused until the other is deactivated.'
            });
        }
      },

      customrecord_jj_rb_dosage_form: {
        saveRecord: (ctx) => {
          const rec = ctx.currentRecord;
          const code = rec.getValue({ fieldId: C.MASTER.customrecord_jj_rb_dosage_form.fields.code });
          const name = rec.getValue({ fieldId: 'name' });
          if (util.blank(code) && util.blank(name)) {
            dialog.alert({
              title: 'Dosage code required',
              message: 'The dosage code is the identity the Middleware keys on, and ' +
                'it cannot be changed after the first sync. Enter a code, or ' +
                'a name for it to be defaulted from.'
            });
            return false;
          }
          return true;
        }
      },

      customrecord_jj_rb_sync_log: {
        pageInit: (ctx) => {
          // A child record's main-only fields are meaningless and misleading.
          const rec = ctx.currentRecord;
          let isChild = false;
          try { isChild = !util.blank(rec.getValue({ fieldId: C.LOG.parent })); }
          catch (e) { return; }
          if (!isChild) return;

          [C.LOG.status, C.LOG.open, C.LOG.success, C.LOG.payload, C.LOG.attempts,
          C.LOG.firstAt, C.LOG.notBefore, C.LOG.exhausted, C.LOG.suggested,
          C.LOG.reason, C.LOG.reconStatus, C.LOG.reconMethod, C.LOG.resolvedBy,
          C.LOG.resolvedOn, C.LOG.resolution, C.LOG.mergedInto, C.LOG.mergedCount
          ].forEach((f) => {
            try {
              const fld = rec.getField({ fieldId: f });
              if (fld) fld.isDisplay = false;
            } catch (e) { /* not on this form */ }
          });
        }
      }
    };

    const jobFor = (rec) => {
      try { return JOBS[String(rec.type).toLowerCase()] || null; }
      catch (e) { return null; }
    };

    const run = (entryPoint, ctx) => {
      try {
        const job = jobFor(ctx.currentRecord);
        if (!job || !job[entryPoint]) return undefined;
        return job[entryPoint](ctx);
      } catch (e) {
        console.log('RB client script error in ' + entryPoint, e);
        return undefined;                    // advisory only: never block on a bug
      }
    };

    const pageInit = (ctx) => { run('pageInit', ctx); };
    const fieldChanged = (ctx) => { run('fieldChanged', ctx); };
    const saveRecord = (ctx) => run('saveRecord', ctx) !== false;

    return { pageInit, fieldChanged, saveRecord };
  });
