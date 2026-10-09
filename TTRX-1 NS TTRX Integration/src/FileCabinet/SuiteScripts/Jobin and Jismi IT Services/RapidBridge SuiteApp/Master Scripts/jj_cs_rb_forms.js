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
 * ONE RULE FOR EVERY WARNING HERE: if the user has to READ it, the save must
 * not be running while they do. `dialog.alert` fires and forgets - the form
 * submits, the page navigates, and the modal dies half-drawn. Use
 * `dialog.confirm`, return false to refuse THIS save, and save from the
 * promise once they have answered.
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
          } catch (e) {
            log.error({ title: 'RB-FORMS-001 fieldChanged', details: (e && e.message) || String(e) }); return;
          }

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
          } catch (e) {
            log.error({ title: 'RB-FORMS-002 fieldChanged', details: (e && e.message) || String(e) }); return;
          }

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
          catch (e) {
            log.error({ title: 'RB-FORMS-003 pageInit', details: (e && e.message) || String(e) }); return;
          }
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
            } catch (e) {
              log.error({ title: 'RB-FORMS-004 pageInit', details: (e && e.message) || String(e) }); /* not on this form */
            }
          });
        }
      }
    };

    /**
     * Item ×5 — the UOM Detail warning.
     *
     * ── THE THREE DEFECTS THIS REPLACES ────────────────────────────────────
     *
     * 1. THE MESSAGE VANISHED. `dialog.alert()` returns a promise and the old
     *    code ignored it, returning true immediately. NetSuite then submitted
     *    the form and navigated away, destroying the modal mid-render. On a
     *    fast save the user saw a flash and nothing else. A message that has
     *    to be read cannot be shown by something the save does not wait for.
     *
     *    It is now `dialog.confirm`, and the FIRST save is REFUSED. The user
     *    reads the message, chooses, and only then does the record save. The
     *    save now waits because it has not started.
     *
     * 2. NO WARNING AT ALL ON CREATE. The old check searched UOM Detail with
     *    `[U.item, 'anyof', rec.id]`, and on a new record `rec.id` is null.
     *    `anyof` with no value throws, the catch swallowed it, and the function
     *    returned true — silently, on exactly the path where the warning
     *    matters most. A brand-new item CANNOT have UOM rows in the database,
     *    so on create there is nothing to search for: the sublist is the whole
     *    truth.
     *
     * 3. "NO UOM DETAIL" AFTER ADDING THE FIRST ROWS. `custrecord_jj_rb_uom_item`
     *    is marked `isparent = T`, so UOM Detail renders as a SUBLIST on the
     *    item form and its rows are saved WITH the parent. In `saveRecord` those
     *    rows exist only in the form; the database still has none. The search
     *    answered honestly and the answer was useless. The sublist is now read
     *    FIRST, and the search is a fallback for a form that does not show it.
     *
     * Still advisory. The item is legitimate NetSuite data and refusing the save
     * outright would make this integration an obstacle to trading (§9.2).
     */

    /** The child sublist UOM Detail renders in, because the item field is a parent. */
    const UOM_SUBLIST = 'recmachcustrecord_jj_rb_uom_item';

    /**
     * How many ACTIVE UOM Detail rows this item has, and where the number came
     * from. The sublist wins: it is what the user is looking at, and on a save
     * it is ahead of the database by definition.
     *
     * @returns {{count:number, source:'sublist'|'search'|'none'}}
     */
    const activeUomRows = (rec) => {
      // ── the form's own rows, pending save
      try {
        const n = rec.getLineCount({ sublistId: UOM_SUBLIST });
        if (n >= 0) {
          let active = 0;
          for (let i = 0; i < n; i++) {
            let inactive = false;
            try {
              inactive = util.truthy(rec.getSublistValue({
                sublistId: UOM_SUBLIST, fieldId: 'isinactive', line: i
              }));
            } catch (e) {
              log.error({ title: 'RB-FORMS-005 activeUomRows', details: (e && e.message) || String(e) }); inactive = false;
            }   // column not on the sublist
            if (!inactive) active++;
          }
          return { count: active, source: 'sublist' };
        }
      } catch (e) {
        log.error({ title: 'RB-FORMS-006 activeUomRows', details: (e && e.message) || String(e) }); /* the sublist is not on this form */
      }

      // ── no sublist: ask the database, but only when there is an id to ask
      //    about. On create there is none, and that is an ANSWER (zero), not
      //    an error to swallow.
      const id = rec.id;
      if (!id) return { count: 0, source: 'none' };

      const U = C.MASTER.customrecord_jj_rb_uom_detail.fields;
      try {
        let rows = 0;
        search.create({
          type: C.REC.UOM,
          filters: [[U.item, 'anyof', id], 'AND', ['isinactive', 'is', 'F']],
          columns: ['internalid']
        }).run().each(() => { rows++; return false; });
        return { count: rows, source: 'search' };
      } catch (e) {
        log.error({ title: 'RB-FORMS-007 activeUomRows', details: (e && e.message) || String(e) });
        // Cannot tell. Say nothing rather than warn wrongly - beforeSubmit
        // still catches it, and the reconciliation page still lists it.
        console.log('RB client script: UOM Detail count unavailable', e);
        return { count: -1, source: 'none' };
      }
    };

    /** Set while re-saving after the user accepted the warning. */
    let uomWarningAccepted = false;

    const ITEM_JOB = {
      saveRecord: (ctx) => {
        const rec = ctx.currentRecord;

        // Second pass: the user already read the message and said go ahead.
        if (uomWarningAccepted) { uomWarningAccepted = false; return true; }

        const entry = C.MASTER[String(rec.type).toLowerCase()];
        if (!entry || !entry.fields.eligible) return true;

        let eligible = '';
        try {
          eligible = rec.getText({ fieldId: entry.fields.eligible }) ||
            rec.getValue({ fieldId: entry.fields.eligible }) || '';
        } catch (e) {
          log.error({ title: 'RB-FORMS-008 saveRecord', details: (e && e.message) || String(e) }); return true;
        }
        const v = String(eligible).toUpperCase();
        if (v !== 'TRUE' && v !== 'T' && v !== 'YES') return true;   // not eligible

        const found = activeUomRows(rec);
        if (found.count !== 0) return true;         // has rows, or cannot tell

        // ── THE WARNING. The save is refused so the modal cannot be raced.
        const isNew = !rec.id;
        dialog.confirm({
          title: 'No UOM Detail rows',
          message:
            (isNew
              ? 'This new item is marked eligible for TrackTrace and has no UOM ' +
              'Detail rows.'
              : 'This item is marked eligible for TrackTrace and has no active ' +
              'UOM Detail rows.') +
            '\n\nEach UOM Detail row is one product in the Middleware, so with ' +
            'none the item cannot sync. It will save, and appear on the ' +
            'reconciliation page as "Item has no UOM Detail".' +
            '\n\nOK to save it anyway, or Cancel to add the rows first.'
        }).then((proceed) => {
          if (!proceed) return;                     // user went back to add rows
          uomWarningAccepted = true;
          try {
            rec.save({ enableSourcing: true, ignoreMandatoryFields: false });
          } catch (e) {
            log.error({ title: 'RB-FORMS-009 saveRecord', details: (e && e.message) || String(e) });
            // Not every form exposes save() from a client script. Say so
            // plainly rather than leave the user on a form that will not go.
            uomWarningAccepted = true;
            dialog.alert({
              title: 'Press Save again',
              message: 'Press Save once more to save this item. The warning ' +
                'will not appear a second time.'
            });
          }
        }).catch((e) => {
          // The dialog itself failed. Do not strand the record.
          console.log('RB client script: UOM confirm failed', e);
          uomWarningAccepted = true;
        });

        return false;                               // stop THIS save, not the record
      }
    };

    ['inventoryitem', 'lotnumberedinventoryitem', 'serializedinventoryitem',
      'assemblyitem', 'kititem'].forEach((t) => { JOBS[t] = ITEM_JOB; });

    const jobFor = (rec) => {
      try { return JOBS[String(rec.type).toLowerCase()] || null; }
      catch (e) {
        log.error({ title: 'RB-FORMS-010 jobFor', details: (e && e.message) || String(e) }); return null;
      }
    };

    const run = (entryPoint, ctx) => {
      try {
        const job = jobFor(ctx.currentRecord);
        if (!job || !job[entryPoint]) return undefined;
        return job[entryPoint](ctx);
      } catch (e) {
        log.error({ title: 'RB-FORMS-011 run', details: (e && e.message) || String(e) });
        console.log('RB client script error in ' + entryPoint, e);
        return undefined;                    // advisory only: never block on a bug
      }
    };

    const pageInit = (ctx) => { run('pageInit', ctx); };
    const fieldChanged = (ctx) => { run('fieldChanged', ctx); };
    const saveRecord = (ctx) => run('saveRecord', ctx) !== false;

    return { pageInit, fieldChanged, saveRecord };
  });