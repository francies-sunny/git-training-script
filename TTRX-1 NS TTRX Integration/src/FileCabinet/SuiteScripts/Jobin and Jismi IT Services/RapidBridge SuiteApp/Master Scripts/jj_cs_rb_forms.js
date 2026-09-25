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
 * DEPLOYMENTS (9):
 *   customrecord_jj_rb_config        fieldChanged on Active        — warn on a clash
 *   customrecord_jj_rb_dosage_form   saveRecord                    — warn on a blank code
 *   customrecord_jj_rb_sync_log      pageInit                      — hide main-only groups
 *   customrecord_jj_rb_uom_detail    fieldChanged on Saleable Unit — warn on a duplicate
 *   inventoryitem ×5                 saveRecord                    — warn: no active UOM row
 *
 * §7.10.
 */
define(['N/currentRecord', 'N/search', 'N/ui/dialog', '../Common/jj_rb_core'],
  (currentRecord, search, dialog, core) => {

    const { C, util } = core;

    // Which job belongs to which record type.
    const JOBS = {
      customrecord_jj_rb_config: {
        fieldChanged: (ctx) => {
          log.debug("In customrecord_jj_rb_config");
          console.log("In customrecord_jj_rb_config");
          log.debug('Master CS - fieldChanged', { recordType: ctx.currentRecord.type, recordId: ctx.currentRecord.id || null, fieldId: ctx.fieldId });
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

      // Dosage Form validation is not required because Name is mandatory.
      // Code can be made mandatory at the field level in the future if required.
      // customrecord_jj_rb_dosage_form: {
      //   saveRecord: (ctx) => {
      //     log.debug('Master CS - saveRecord', { recordType: ctx.currentRecord.type, recordId: ctx.currentRecord.id || null });
      //     const rec = ctx.currentRecord;
      //     const code = rec.getValue({ fieldId: C.MASTER.customrecord_jj_rb_dosage_form.fields.code });
      //     const name = rec.getValue({ fieldId: 'name' });
      //     log.debug("Master CS - saveRecord", { code: code, name: name });
      //     log.debug("Result of blank check", { codeBlank: util.blank(code), nameBlank: util.blank(name) });
      //     if (util.blank(code) && util.blank(name)) {
      //       dialog.alert({
      //         title: 'Dosage code required',
      //         message: 'The dosage code is the identity the Middleware keys on, and ' +
      //           'it cannot be changed after the first sync. Enter a code, or ' +
      //           'a name for it to be defaulted from.'
      //       });
      //       return false;
      //     }
      //     return true;
      //   }
      // },

      customrecord_jj_rb_uom_detail: {
        fieldChanged: (ctx) => {
          log.debug('Master CS - fieldChanged', { recordType: ctx.currentRecord.type, recordId: ctx.currentRecord.id || null, fieldId: ctx.fieldId });
          const U = C.MASTER.customrecord_jj_rb_uom_detail.fields;
          if (ctx.fieldId !== U.unit) return;
          const rec = ctx.currentRecord;

          const itemId = rec.getValue({ fieldId: U.item });
          const unitId = rec.getValue({ fieldId: U.unit });
          if (util.blank(itemId) || util.blank(unitId)) return;
          if (util.truthy(rec.getValue({ fieldId: 'isinactive' }))) return;

          let clash = null;
          try {
            search.create({
              type: C.REC.UOM,
              filters: [[U.item, 'anyof', itemId], 'AND',
              [U.unit, 'anyof', unitId], 'AND',
              ['isinactive', 'is', 'F']],
              columns: ['internalid']
            }).run().each((r) => {
              if (String(r.getValue('internalid')) !== String(rec.id)) { clash = true; return false; }
              return true;
            });
          } catch (e) { return; }

          if (clash)
            dialog.alert({
              title: 'Duplicate saleable unit',
              message: 'This item already has an ACTIVE UOM Detail row for that unit. ' +
                'One saleable unit per item — the save will be refused. ' +
                'Inactivate the other row first.'
            });
        }
      },

      customrecord_jj_rb_sync_log: {
        pageInit: (ctx) => {
          log.debug('Master CS - pageInit', { recordType: ctx.currentRecord.type, recordId: ctx.currentRecord.id || null });
          // A child record's main-only fields are meaningless and misleading.
          const rec = ctx.currentRecord;
          let isChild = false;
          try { isChild = !util.blank(rec.getValue({ fieldId: C.LOG.parent })); }
          catch (e) { return; }
          if (!isChild) return;

          // C.LOG.success is NOT hidden any more: a child record now carries its
          // own Success flag, set from its own Call Outcome, and that is exactly
          // what someone reading a retry chain wants to see.
          [C.LOG.status, C.LOG.open, C.LOG.payload, C.LOG.attempts,
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

    /**
     * Item ×5 — warn, do not block, when an ELIGIBLE item has no active UOM
     * Detail row. It cannot sync without one (§9.2), but the item is legitimate
     * NetSuite data and refusing the save would make the integration an obstacle
     * to trading.
     */
    const ITEM_JOB = {
      saveRecord: (ctx) => {
        const rec = ctx.currentRecord;
        const entry = C.MASTER[String(rec.type).toLowerCase()];
        if (!entry || !entry.fields.eligible) return true;

        let eligible = '';
        try {
          eligible = rec.getText({ fieldId: entry.fields.eligible }) ||
            rec.getValue({ fieldId: entry.fields.eligible }) || '';
        }
        catch (e) { return true; }
        const s = String(eligible).toUpperCase();
        if (s !== 'TRUE' && s !== 'T' && s !== 'YES') return true;   // not eligible: no warning

        const U = C.MASTER.customrecord_jj_rb_uom_detail.fields;
        let rows = 0;
        try {
          search.create({
            type: C.REC.UOM,
            filters: [[U.item, 'anyof', rec.id], 'AND', ['isinactive', 'is', 'F']],
            columns: ['internalid']
          }).run().each(() => { rows++; return false; });
        } catch (e) { return true; }

        if (rows === 0)
          dialog.alert({
            title: 'No active UOM Detail',
            message: 'This item is marked eligible for TrackTrace but has no active ' +
              'UOM Detail row, so it cannot sync — each row is one Middleware ' +
              'product. It will save, and appear on the reconciliation page ' +
              'as "Item has no UOM Detail".'
          });
        return true;                                   // warn, never block
      }
    };

    ['inventoryitem', 'lotnumberedinventoryitem', 'serializedinventoryitem',
      'assemblyitem', 'kititem'].forEach((t) => { JOBS[t] = ITEM_JOB; });

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