/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * jj_rb_sync — the engine and the payload builders.
 *
 * Every master record follows the same eight steps. Only step 2 differs
 * between record types, and step 2 is the builder — which is why the builders
 * live here rather than in files of their own.
 *
 *   1. resolve sync units    (1 for most records, N for an item's UOM rows)
 *   2. build the payload     (the ONLY record-specific step)
 *   3. stringify it canonically
 *   4. compare with the stored payload string → identical AND synced AND uuid ⇒ skip
 *   5. resolve the logIo target: MAIN record, or CHILD of an open one (§12.5)
 *   6. call — creating exactly ONE logIo record
 *   7. on success: write uuid + payload + synced=true + CLEAR the error
 *      on failure: leave synced=false, set the error, schedule a retry
 *      ALWAYS: stamp last_try + try_result (§11.5)
 *   8. roll up (items only)
 *
 * IMPLEMENTED: Dosage Form · Location · Customer · Vendor · Item + UOM Detail.
 * NOT YET: Bin (declared in C.MASTER with implemented:false — fails loudly).
 *
 * Master Data Developer Guide v3.4 §7.7, §8, §9, §10.1–§10.6.
 */
define(['N/record', 'N/search', 'N/runtime', './jj_rb_core', './jj_rb_io'],
  (record, search, runtime, core, io) => {

    const { C, util, lists, config } = core;
    const { logIo, client } = io;

    // Cached across one execution only.
    const DELETE_CACHE = {};   // recordType|id -> { uuid, name, uomUuids:[] }
    const STATE_CACHE = {};   // countryCode   -> { stateName: id }
    const PRESYNCED = {};   // recordType|id -> true, cycle guard for the cascade

    // ═══════════════════════════════════════════════════════════════════════════
    // Small readers
    // ═══════════════════════════════════════════════════════════════════════════

    const dedupe = (a) => a.filter((v, i) => a.indexOf(v) === i);

    /** lookupFields gives scalars for text fields and [{value,text}] for selects. */
    const textOf = (v) => {
      if (Array.isArray(v)) return v.length ? (v[0].value || v[0].text || '') : '';
      return (v === undefined || v === null) ? '' : String(v);
    };
    const labelOf = (v) => {
      if (Array.isArray(v)) return v.length ? (v[0].text || '') : '';
      return (v === undefined || v === null) ? '' : String(v);
    };
    /** '' collapses to undefined so canonical() drops it — a blank is not a value. */
    const orNothing = (v) => (util.blank(v) ? undefined : v);

    // ═══════════════════════════════════════════════════════════════════════════
    // Sync units
    // ═══════════════════════════════════════════════════════════════════════════

    /** The field-id block every unit carries, taken from the dispatch entry. */
    const unitFields = (f) => ({
      uuidField: f.uuid || null,
      payloadField: f.payload || null,
      syncedField: f.synced || null,
      lastSyncField: f.lastSync || null,
      lastTryField: f.lastTry || null,
      tryResultField: f.tryResult || null,
      errorField: f.error || null
    });

    /**
     * A unit is "one thing that gets one API call".
     *
     * For everything except Item it is the record itself. For an Item it is ONE
     * PER ACTIVE UOM DETAIL ROW — an item with three active rows is three
     * products in the Middleware, three UUIDs and three calls (§8.2).
     *
     * @returns {{list:Array<Object>, blocked?:string, blockedTry?:string}}
     */
    const resolveUnits = (entry, recordId, recordType, cfg, o) => {
      if (entry.key === 'ITEM') return resolveItemUnits(entry, recordId, recordType, cfg, o);

      const f = entry.fields || {};
      const unit = Object.assign({
        recordType: recordType,
        recordId: recordId,
        uomId: null,
        storedUuid: null,
        storedPayload: null,
        storedSynced: false,
        data: {}
      }, unitFields(f));

      const cols = [];
      Object.keys(f).forEach((k) => { if (f[k]) cols.push(f[k]); });
      if (entry.key === 'DOSAGE') cols.push('name', 'isinactive');
      if (entry.key === 'LOCATION') cols.push('name', 'isinactive', 'parent', 'subsidiary');
      if (entry.key === 'CUSTOMER' || entry.key === 'VENDOR')
        cols.push('entityid', 'companyname', 'isinactive', 'phone', 'email', 'isperson', 'altname');

      let vals = {};
      try {
        vals = search.lookupFields({ type: recordType, id: recordId, columns: dedupe(cols) });
      } catch (e) {
        return {
          list: [], blocked: 'Record ' + recordType + '/' + recordId +
            ' could not be read: ' + e.message
        };
      }

      unit.storedUuid = f.uuid ? textOf(vals[f.uuid]) : null;
      unit.storedPayload = f.payload ? textOf(vals[f.payload]) : null;
      unit.storedSynced = f.synced ? util.truthy(vals[f.synced]) : false;
      unit.data = vals;

      return { list: [unit] };
    };

    /**
     * §8.2 — one unit per ACTIVE UOM Detail row.
     *
     * An eligible item with no active row cannot sync. That is not an error to
     * retry; it is a data gap only a person can close, so it goes to the
     * reconciliation page with reason `Item has no UOM Detail`.
     */
    const resolveItemUnits = (entry, itemId, itemType, cfg, o) => {
      const U = C.MASTER.customrecord_jj_rb_uom_detail.fields;
      const f = entry.fields;

      // The shared half of the payload: read from the item, once.
      const itemCols = ['itemid', 'displayname', 'salesdescription', 'purchasedescription',
        'isinactive', 'upccode', 'usebins',
        f.eligible, f.dosage, f.strength, f.generic,
        f.synced, f.lastSync, f.lastTry, f.tryResult, f.error, f.attention];
      let item = {};
      try {
        item = search.lookupFields({
          type: itemType, id: itemId,
          columns: dedupe(itemCols.filter(Boolean))
        });
      } catch (e) {
        return {
          list: [], blocked: 'Item ' + itemType + '/' + itemId +
            ' could not be read: ' + e.message
        };
      }

      // The dosage CODE is what the Middleware keys on, not the NetSuite id.
      const dosageId = textOf(item[f.dosage]);
      let dosageCode = '';
      if (dosageId) {
        try {
          const d = search.lookupFields({
            type: C.REC.DOSAGE, id: dosageId,
            columns: [C.MASTER.customrecord_jj_rb_dosage_form.fields.code]
          });
          dosageCode = textOf(d[C.MASTER.customrecord_jj_rb_dosage_form.fields.code]);
        } catch (e) { /* left blank — the payload comparison will show it */ }
      }

      const rows = [];
      try {
        const cols = [U.unit, U.qty, U.upc, U.gtin, U.ndc, U.packSize, U.gs1Prefix,
        U.gs1Id, U.uuid, U.payload, U.synced]
          .map((c) => search.createColumn({ name: c }));
        cols.push(search.createColumn({ name: 'internalid', sort: search.Sort.ASC }));
        search.create({
          type: C.REC.UOM,
          filters: [[U.item, 'anyof', itemId], 'AND', ['isinactive', 'is', 'F']],
          columns: cols
        }).run().each((r) => {
          rows.push({
            id: r.getValue('internalid'),
            unit: r.getText(U.unit) || r.getValue(U.unit),
            qty: r.getValue(U.qty),
            upc: r.getValue(U.upc),
            gtin: r.getValue(U.gtin),
            ndc: r.getValue(U.ndc),
            packSize: r.getValue(U.packSize),
            gs1Prefix: r.getValue(U.gs1Prefix),
            gs1Id: r.getValue(U.gs1Id),
            uuid: r.getValue(U.uuid),
            payload: r.getValue(U.payload),
            synced: util.truthy(r.getValue(U.synced))
          });
          return true;
        });
      } catch (e) {
        return { list: [], blocked: 'UOM Detail rows unreadable: ' + e.message };
      }

      if (!rows.length)
        return {
          list: [], blocked: 'Item has no active UOM Detail row',
          blockedTry: C.TRY.BLOCK_NO_UOM, reason: C.REASON.NO_UOM
        };

      // A UOM row saved directly syncs THAT row only — never its siblings (§10.3).
      const wanted = o && o.onlyUomRowId
        ? rows.filter((r) => String(r.id) === String(o.onlyUomRowId))
        : rows;

      const list = wanted.map((r) => Object.assign({
        recordType: C.REC.UOM,          // the unit IS the UOM row
        recordId: r.id,
        uomId: r.id,
        itemId: itemId,
        itemType: itemType,
        storedUuid: r.uuid || null,
        storedPayload: r.payload || null,
        storedSynced: r.synced,
        data: item,                     // the shared half
        uom: r,                        // the identity half
        dosageCode: dosageCode
      }, unitFields(U)));

      return { list: list };
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Builders — one function per entry.builder value
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * §10.1 — Dosage Form. The simplest complete path: one unit, no children,
     * no parent, no eligibility test.
     */
    const buildDosageForm = (unit, cfg, entry) => {
      const f = entry.fields;
      return {
        code: textOf(unit.data[f.code]),         // the identity. Immutable.
        name: textOf(unit.data.name),
        is_active: !util.truthy(unit.data.isinactive)
      };
    };

    /**
     * §10.6 — Location. One unit, an optional parent that must be synced first.
     * The address rides the comparison only; it is pushed as its own call.
     */
    const buildLocation = (unit, cfg, entry) => {
      const f = entry.fields;
      const payload = {
        name: textOf(unit.data.name),
        is_active: !util.truthy(unit.data.isinactive),
        is_unselectable_location: false,
        gs1_sgln: orNothing(textOf(unit.data[f.sgln])),
        parent_location_uuid: orNothing(unit.parentUuid)
      };

      // On create only, and only where the account has no bins. An account on
      // Bin Management gets its storage areas from real bins, so asking for a
      // default one would create a second, unmanaged storage area.
      if (!unit.storedUuid && !cfg.useBins) payload.create_default_storage_area = true;

      const addr = locationAddresses(unit);
      if (addr.length) payload[util.COMPARE_KEY] = { addresses: addr.map(compareAddr) };

      return payload;
    };

    /**
     * §10.4 — Customer and Vendor. One builder, one dispatch entry each; the
     * only difference is `type`.
     */
    const buildPartner = (unit, cfg, entry) => {
      const f = entry.fields;
      const d = unit.data;
      const isPerson = util.truthy(d.isperson);
      const name = (isPerson ? textOf(d.altname) : textOf(d.companyname)) || textOf(d.entityid);

      const payload = {
        type: entry.partnerType,                    // CUSTOMER | VENDOR
        name: name,
        is_active: !util.truthy(d.isinactive),
        // The existing client code hardcodes ALL, subscribing every partner to
        // every notification. Default NONE; it is a configuration value, not a
        // property of the partner.
        new_trx_notification_type: 'NONE',
        external_reference: String(unit.recordId),
        phone: orNothing(textOf(d.phone)),
        notification_email: orNothing(textOf(d.email)),
        gs1_id: orNothing(textOf(d[f.gln]))
      };

      // The idempotency key. Create only — it lets the Middleware upsert if our
      // response is lost, and re-sending it on an update means nothing.
      if (!unit.storedUuid) payload.custom_uuid = util.uuid();

      const addrs = entityAddresses(unit);
      if (addrs.length) payload[util.COMPARE_KEY] = { addresses: addrs.map(compareAddr) };

      return payload;
    };

    /**
     * §8.3 — Item / Product. Shared fields come from the ITEM; identity fields
     * come from the UOM ROW. That split is what makes N products from one item.
     */
    const buildProduct = (unit, cfg, entry) => {
      const f = entry.fields;
      const d = unit.data;
      const u = unit.uom;
      const inactive = util.truthy(d.isinactive);

      const payload = {
        status: inactive ? 'RETIRED' : 'AVAILABLE',
        is_active: !inactive,
        sku: orNothing(textOf(d.itemid)),

        product_descriptions: [{
          language_code: cfg.language || 'en',
          name: textOf(d.displayname) || textOf(d.itemid),
          description: textOf(d.salesdescription) || textOf(d.displayname) ||
            textOf(d.itemid)
        }],

        // identity — from the UOM row
        upc: orNothing(u.upc || textOf(d.upccode)),
        gtin14: orNothing(u.gtin),
        gs1_company_prefix: orNothing(u.gs1Prefix),
        gs1_id: orNothing(u.gs1Id),
        pack_size: orNothing(u.packSize),
        is_leaf_product: Number(u.qty) === 1,

        // pharma
        class_pharmaceutical__dosage_form: orNothing(unit.dosageCode),
        class_pharmaceutical__strength: orNothing(textOf(d[f.strength])),
        class_pharmaceutical__generic_name: orNothing(textOf(d[f.generic]))
      };

      if (!util.blank(u.ndc))
        payload.product_identifiers = [{ identifier_code: 'US_NDC', value: u.ndc }];

      Object.assign(payload, binState(d, cfg));

      if (!unit.storedUuid) {
        // Create only. `type` is immutable after create — a change to the
        // product class is a business decision, not a PUT.
        payload.type = cfg.productClassText || cfg.productClass || 'Pharmaceutical';
        payload.custom_uuid = util.uuid();
      } else {
        // §8.5 — PUT is a FULL REPLACEMENT and needs explicit gate booleans.
        // Forget them and the call returns 200 and changes nothing: a silent
        // data-loss bug.
        payload.update_product_descriptions = !!payload.product_descriptions;
        payload.update_product_identifiers = !!payload.product_identifiers;
        payload.update_requirements = false;
        payload.update_packaging = false;
      }

      return payload;
    };

    /**
     * §8.4 — a product is bin-managed only when the account feature, the
     * RapidBridge switch and the item's own `usebins` all agree.
     *
     * This is part of the payload, so ticking Use Bins on an item moves the
     * comparison and re-syncs by itself. No special handling needed.
     */
    const binState = (item, cfg) => {
      let accountUsesBins = false;
      try { accountUsesBins = runtime.isFeatureInEffect({ feature: 'BINMANAGEMENT' }); }
      catch (e) { accountUsesBins = false; }
      const itemUsesBins = util.truthy(item.usebins);
      return {
        is_bin_managed: !!(accountUsesBins && itemUsesBins && cfg.useBins === true),
        bin_feature_enabled: !!accountUsesBins
      };
    };

    /**
     * §10.5 — an address payload. Child of an entity or a location.
     * `state_id` must be an id: free text where an id is expected fails silently.
     */
    const buildAddress = (addr, cfg, parentName) => {
      const body = {
        address_nickname: addr.nickname || 'Main Address',
        recipient_name: addr.addressee || parentName || '',
        line1: addr.addr1 || '',
        line2: orNothing(addr.addr2),
        city: addr.city || '',
        zip: addr.zip || '',
        country_code: addr.country || '',
        phone: orNothing(addr.phone),
        gs1_sgln: orNothing(addr.sgln),
        is_licence_required: false
      };
      const stateId = resolveStateId(addr.country, addr.state, cfg);
      if (stateId) body.state_id = stateId;     // omitted, never free text
      return body;
    };

    /** The address fields that belong in the parent's comparison. */
    const compareAddr = (a) => ({
      nickname: a.nickname, addressee: a.addressee, line1: a.addr1, line2: a.addr2,
      city: a.city, state: a.state, zip: a.zip, country: a.country, sgln: a.sgln
    });

    const builders = {
      dosage: buildDosageForm,
      location: buildLocation,
      entity: buildPartner,
      item: buildProduct,
      address: buildAddress
      // bin: declared in C.MASTER, not yet built. See run().
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // The engine
    // ═══════════════════════════════════════════════════════════════════════════

    const run = (o) => {
      const { entry, recordId, recordType, cfg } = o;
      const trigger = o.trigger || C.TRIGGER.INITIAL;
      const correlation = o.correlation || util.uuid();

      log.debug({
        title: 'RB sync.run ' + recordType + '/' + recordId,
        details: {
          key: entry && entry.key, syncType: entry && entry.syncType,
          trigger: trigger, correlation: correlation,
          isCreate: !!o.isCreate, onlyUomRowId: o.onlyUomRowId || null
        }
      });

      // A UOM row is not its own object — it is one unit of its parent item.
      if (entry.key === 'UOM') return runUomRow(recordId, cfg, trigger, correlation);

      if (entry.implemented === false || !builders[entry.builder]) {
        const u = resolveUnits(entry, recordId, recordType, cfg, o);
        if (u.list.length) logIo.stampTry(u.list[0], C.TRY.FAIL_PRE_API);
        logIo.exception(entry, { type: recordType, id: recordId },
          new Error('No builder for "' + entry.builder + '". ' + entry.key +
            ' is declared in the dispatch table but not implemented in ' +
            'this phase. Remove the deployment or add the builder.'));
        return [{ ok: false, notImplemented: true }];
      }

      // §8.1 — eligibility, the first gate. An ineligible item is not an error.
      if (entry.requiresEligibility && !isEligible(entry, recordId, recordType, cfg)) {
        logIo.stampTry(itemStampUnit(entry, recordId, recordType), C.TRY.SKIP_INELIGIBLE);
        return [{ skipped: true, reason: 'not eligible' }];
      }

      const units = resolveUnits(entry, recordId, recordType, cfg, o);

      if (units.blocked) {
        // A blocked item still gets a work item, so it lands on the
        // reconciliation page instead of vanishing.
        const stampUnit = entry.key === 'ITEM'
          ? itemStampUnit(entry, recordId, recordType) : null;
        if (units.blockedTry && stampUnit) {
          logIo.openDeferred({
            entry: entry, unit: stampUnit, cfg: cfg,
            reason: units.reason || C.REASON.NO_UOM,
            status: C.STATUS.OPEN_REVIEW,          // a person must fix this
            outcome: C.OUTCOME.SKIPPED,            // no call was made
            trigger: trigger, note: units.blocked,
            correlation: correlation
          });
          logIo.stampTry(stampUnit, units.blockedTry);
        } else {
          logIo.exception(entry, { type: recordType, id: recordId }, new Error(units.blocked));
        }
        return [{ ok: false, blocked: units.blocked }];
      }

      const inlineCap = Number(cfg.maxInline) || 5;
      const results = [];

      log.debug({
        title: 'RB units resolved ' + recordType + '/' + recordId,
        details: {
          units: units.list.length, inlineCap: inlineCap,
          uomRows: units.list.map((u) => u.uomId || null)
        }
      });

      units.list.forEach((unit, i) => {

        if (i >= inlineCap) {
          logIo.openDeferred({
            entry: entry, unit: unit, cfg: cfg,
            reason: C.REASON.PAYLOAD_CHANGED,
            status: C.STATUS.OPEN_PENDING,         // the sweep will call
            outcome: C.OUTCOME.SKIPPED,
            trigger: trigger,
            note: 'Beyond the inline cap of ' + inlineCap +
              ' units for this save; queued for the reconciliation sweep.',
            correlation: correlation
          });
          logIo.stampTry(unit, C.TRY.DEFERRED);
          results.push({ deferred: true });
          return;
        }

        const gate = preflight(entry, unit, cfg);
        if (gate) {
          if (gate.needsHuman) {
            logIo.openDeferred({
              entry: entry, unit: unit, cfg: cfg,
              reason: C.REASON.AWAITING_DECISION,
              status: C.STATUS.OPEN_REVIEW, outcome: C.OUTCOME.SKIPPED,
              trigger: trigger, note: gate.note || gate.reason,
              correlation: correlation
            });
          } else {
            // A routine skip. No row: §12.9 keeps the log small, and the
            // record's own Last Sync Try fields carry the audit trail.
            logIo.closeStaleWorkItem(unit,
              'Closed without a call: this record is no longer eligible to ' +
              'sync (' + gate.reason + ').');
          }
          logIo.stampTry(unit, gate.tryResult);
          results.push({ skipped: true, reason: gate.reason });
          return;
        }

        // Location: the parent must exist remotely before the child can name it.
        if (entry.key === 'LOCATION') {
          const parentId = textOf(unit.data.parent);
          if (parentId) {
            const pu = ensureParentLocation(parentId, cfg, correlation);
            if (!pu) {
              logIo.openDeferred({
                entry: entry, unit: unit, cfg: cfg,
                reason: C.REASON.MISSING_PARENT,
                status: C.STATUS.OPEN_PENDING,     // resolves once the parent syncs
                outcome: C.OUTCOME.SKIPPED,
                trigger: trigger,
                note: 'Parent location ' + textOf(unit.data.parent) +
                  ' has no Middleware UUID yet.',
                correlation: correlation
              });
              logIo.stampTry(unit, C.TRY.BLOCK_NO_PARENT);
              results.push({ ok: false, blocked: 'parent location not synced' });
              return;
            }
            unit.parentUuid = pu;
          }
        }

        const payload = builders[entry.builder](unit, cfg, entry);    // step 2
        const payloadStr = util.canonical(payload);                      // step 3
        const sendBody = util.stripCompare(payload);

        // ── step 4: THE TRIGGER TEST — a direct string comparison against the
        //    payload the Middleware last accepted, as the RECORD remembers it.
        if (util.samePayload(payloadStr, unit.storedPayload)
          && unit.storedSynced === true && unit.storedUuid) {
          log.debug({
            title: 'RB no change (record) ' + unit.recordType + '/' + unit.recordId,
            details: {
              uomId: unit.uomId || null, uuid: unit.storedUuid,
              payloadLength: payloadStr.length
            }
          });
          // An earlier attempt may have failed and left a work item open. No
          // call is coming this time, so close it here or it never closes.
          logIo.closeStaleWorkItem(unit,
            'Closed without a call: the record now matches the payload the ' +
            'Middleware last accepted, so the change this work item was ' +
            'opened for no longer exists.');
          logIo.stampTry(unit, C.TRY.NO_CHANGE);
          results.push({ skipped: true, noChange: true });
          return;
        }

        // ── step 4b: the record says something changed. Before spending a call
        //    on it, ask the SYNC LOG what the Middleware last accepted. The
        //    record's memory can be missing while the Middleware's is not.
        //
        //    Two separate jobs, and the first matters far more than the second:
        //
        //      1. ADOPT a UUID the record has lost. Without it the next line
        //         resolves to CREATE and the Middleware gets a duplicate.
        //      2. SKIP a send that would change nothing remotely.
        //
        //    A forced re-sync (Mass Update, reconciliation sweep) skips job 2
        //    on purpose: re-sending is the entire point of forcing, and the
        //    Mass Update works by clearing the stored payload — if the log
        //    could veto that, the force button would do nothing.
        const prior = logIo.lastSuccess(unit, entry);

        if (prior && prior.uuid && !unit.storedUuid) {
          log.audit({
            title: 'RB adopted UUID from Sync Log',
            details: {
              recordType: unit.recordType, recordId: unit.recordId,
              uomId: unit.uomId || null, uuid: prior.uuid, logId: prior.logId,
              note: 'record had no UUID; a CREATE here would have duplicated it'
            }
          });
          unit.storedUuid = prior.uuid;
          if (unit.uuidField) {
            try {
              record.submitFields({
                type: unit.recordType, id: unit.recordId,
                values: { [unit.uuidField]: prior.uuid },
                options: { ignoreMandatoryFields: true }
              });
            } catch (e) {
              // Not fatal: the call below already uses the adopted value.
              log.error({ title: 'RB could not write adopted UUID', details: e });
            }
          }
        }

        const forced = trigger === C.TRIGGER.MASS_UPDATE
          || trigger === C.TRIGGER.RECON;

        if (!forced && prior && unit.storedUuid
          && util.samePayload(payloadStr, prior.payload)) {
          log.debug({
            title: 'RB no change (log) ' + unit.recordType + '/' + unit.recordId,
            details: {
              uomId: unit.uomId || null, uuid: unit.storedUuid,
              matchedLogId: prior.logId, matchedAt: prior.at,
              payloadLength: payloadStr.length,
              note: 'record had forgotten; healing it instead of calling out'
            }
          });
          logIo.closeStaleWorkItem(unit,
            'Closed without a call: the record was reverted to the payload ' +
            'accepted by Sync Log ' + prior.logId + ', so the change this work ' +
            'item was opened for no longer exists.');
          healFromLog(entry, unit, payloadStr);
          results.push({ skipped: true, noChange: true, fromLog: true });
          return;
        }

        const operation = operationFor(unit, payload);

        log.debug({
          title: 'RB calling ' + operation + ' ' + unit.recordType + '/' + unit.recordId,
          details: {
            uomId: unit.uomId || null, uuid: unit.storedUuid || null,
            trigger: trigger, forced: forced, payloadLength: payloadStr.length,
            priorSuccessLogId: prior ? prior.logId : null
          }
        });

        const target = logIo.resolveLogTarget({                            // step 5
          entry: entry, unit: unit, operation: operation, payload: payloadStr,
          cfg: cfg, reason: reasonFor(unit), triggeringParentId: o.parentId
        });

        const res = client.call({                                        // step 6
          entry: entry, unit: unit, cfg: cfg, target: target,
          endpoint: unit.storedUuid ? entry.endpoints.update : entry.endpoints.create,
          pathParams: { uuid: unit.storedUuid },
          body: sendBody, operation: operation, payload: payloadStr,
          trigger: trigger, correlation: correlation, requestUuid: correlation
        });

        if (res.ok) {                                                    // step 7
          writeBackSuccess(entry, unit, res.uuid || unit.storedUuid, payloadStr);
          logIo.closeSuccess(target, res);
          results.push({ ok: true, uuid: res.uuid || unit.storedUuid });

          if (entry.hasChildren && cfg.useAddress)
            syncChildAddresses(entry, unit, res.uuid || unit.storedUuid, cfg,
              correlation, trigger);

        } else if (res.suppressed || res.dryRun) {
          // Built, stringified, logged, not sent. Nothing is coming back for
          // it, so the work item closes rather than sitting open for ever.
          logIo.closeNoAction(target, res,
            res.suppressed
              ? 'Environment gate: ' + (res.errorMessage || 'call suppressed') +
              '. The payload is stored; nothing was sent.'
              : 'Dry-run mode is on. The payload is stored; nothing was sent.');
          logIo.stampTry(unit, res.suppressed ? C.TRY.SUPPRESSED_ENV : C.TRY.DRY_RUN);
          results.push({ ok: false, suppressed: true });

        } else if (res.skipped) {
          // Kill switch. The change is real and STILL UNSENT, so the work item
          // stays open on purpose — but parked, not "retrying".
          logIo.parkUnsent(target, res, cfg, C.REASON.AWAITING_DECISION,
            res.errorMessage || 'Kill switch is on; no call was made.');
          logIo.stampTry(unit, C.TRY.FAIL_PRE_API);
          results.push({ ok: false, skipped: true });

        } else {
          writeBackFailure(entry, unit, res.errorMessage);
          logIo.closeFailure(target, res, cfg);
          results.push({ ok: false, error: res.errorMessage });
        }
      });

      if (entry.key === 'ITEM') rollUpItem(entry, recordId, recordType, results);  // step 8

      log.debug({
        title: 'RB sync.run done ' + recordType + '/' + recordId,
        details: {
          correlation: correlation,
          ok: results.filter((r) => r.ok).length,
          noChange: results.filter((r) => r.noChange).length,
          skipped: results.filter((r) => r.skipped && !r.noChange).length,
          deferred: results.filter((r) => r.deferred).length,
          failed: results.filter((r) => r.error).length
        }
      });

      return results;
    };

    /**
     * §10.3 — a UOM Detail row saved on its own. It is never its own object: it
     * delegates to its parent item, and syncs THAT ROW ONLY. Touching siblings
     * would turn one edit into N calls.
     */
    const runUomRow = (uomRowId, cfg, trigger, correlation) => {
      const U = C.MASTER.customrecord_jj_rb_uom_detail.fields;
      let itemId = null;
      try {
        const v = search.lookupFields({ type: C.REC.UOM, id: uomRowId, columns: [U.item] });
        itemId = textOf(v[U.item]);
      } catch (e) { /* fall through */ }

      if (!itemId) {
        logIo.exception(C.MASTER.customrecord_jj_rb_uom_detail,
          { type: C.REC.UOM, id: uomRowId },
          new Error('UOM Detail row has no parent item — nothing to sync.'));
        return [{ ok: false, blocked: 'no parent item' }];
      }

      const itemType = itemTypeOf(itemId);
      if (!itemType) return [{ ok: false, blocked: 'parent item type unresolved' }];

      return run({
        entry: C.MASTER[itemType], recordId: itemId, recordType: itemType,
        cfg: cfg, trigger: trigger, correlation: correlation,
        onlyUomRowId: uomRowId
      });
    };

    /**
     * Which of the five item record types is this? The dispatch entry needs it.
     * One search on the generic `item` type, reading `recordtype` — not five
     * speculative lookupFields calls against types it probably is not.
     */
    const itemTypeOf = (itemId) => {
      let t = null;
      try {
        search.create({
          type: 'item',
          filters: [['internalid', 'anyof', itemId]],
          columns: ['recordtype']
        }).run().each((r) => {
          t = String(r.getValue('recordtype') || '').toLowerCase();
          return false;
        });
      } catch (e) { return null; }
      return (t && C.MASTER[t]) ? t : null;
    };

    /** §8.1 — only regulated items sync. Read from the CONFIGURED field id. */
    const isEligible = (entry, recordId, recordType, cfg) => {
      const fieldId = cfg.eligField || entry.fields.eligible;
      if (!fieldId) return true;
      let raw;
      try {
        const v = search.lookupFields({ type: recordType, id: recordId, columns: [fieldId] });
        raw = labelOf(v[fieldId]) || textOf(v[fieldId]);
      } catch (e) { return false; }

      const s = String(raw).toUpperCase();
      if (s === 'TRUE' || s === 'T' || s === 'YES') return true;
      if (s === 'FALSE' || s === 'F' || s === 'NO') return false;
      // AUTO has no agreed rule yet — §18 question 3. Refuse rather than guess.
      return false;
    };

    /** A stamp-only unit for the ITEM record itself (it has no uuid of its own). */
    const itemStampUnit = (entry, itemId, itemType) => Object.assign({
      recordType: itemType, recordId: itemId, uomId: null,
      storedUuid: null, storedPayload: null, storedSynced: false, data: {}
    }, unitFields(entry.fields));

    /** Gates that belong to one record type and stop the call before it is built. */
    const preflight = (entry, unit, cfg) => {
      if (entry.key === 'DOSAGE') {
        // System rows exist for NetSuite users; the Middleware owns its defaults.
        if (util.truthy(unit.data[entry.fields.isDefault]))
          return { tryResult: C.TRY.SKIP_INELIGIBLE, reason: 'is_default row' };
        if (util.blank(textOf(unit.data[entry.fields.code])))
          // Not a routine skip: this record can NEVER sync until someone types a
          // code. §12.9 gives a row to anything a human has to act on, or the
          // record fails silently for ever.
          return {
            tryResult: C.TRY.FAIL_PRE_API, reason: 'dosage code is blank',
            needsHuman: true,
            note: 'The dosage code is the identity the Middleware keys on and it ' +
              'is blank. Nothing can be sent until it is filled in.'
          };
      }
      if (util.truthy(unit.data.isinactive) && cfg.syncInactive === false && !unit.storedUuid)
        return { tryResult: C.TRY.SKIP_INELIGIBLE, reason: 'inactive, never synced' };
      return null;
    };

    /**
     * §3 list 3 — Sync Operation. 'Update' is true but uninformative when the
     * update IS the activation change. Inactivate / Reactivate were declared
     * and never used; this is what they are for, and it lets a reader see from
     * the log list alone why a record was pushed.
     *
     * Derived by comparing is_active in the payload about to be sent against
     * is_active in the payload the Middleware last accepted. No extra reads.
     */
    const operationFor = (unit, payload) => {
      if (!unit.storedUuid) return C.OPERATION.CREATE;
      if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'is_active'))
        return C.OPERATION.UPDATE;

      const prev = util.safeJson(unit.storedPayload || '');
      if (!prev || !Object.prototype.hasOwnProperty.call(prev, 'is_active'))
        return C.OPERATION.UPDATE;

      const was = prev.is_active === true || String(prev.is_active) === 'true';
      const now = payload.is_active === true || String(payload.is_active) === 'true';
      if (was && !now) return C.OPERATION.INACTIVATE;
      if (!was && now) return C.OPERATION.REACTIVATE;
      return C.OPERATION.UPDATE;
    };

    const reasonFor = (unit) => {
      if (!unit.storedUuid) return C.REASON.NEVER_SYNCED;
      if (!unit.storedSynced) return C.REASON.LAST_FAILED;
      return C.REASON.PAYLOAD_CHANGED;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Write-back
    // ═══════════════════════════════════════════════════════════════════════════

    /** E1 — one submitFields, and it CLEARS the error. §11.8. */
    /**
     * The Middleware already holds this exact payload; the RECORD is what had
     * forgotten. Restore its memory without pretending a call was made:
     * last_sync is left alone — nothing synced just now — and the try result
     * says No change, not Synced.
     */
    const healFromLog = (entry, unit, payloadStr) => {
      const values = {};
      if (unit.uuidField && unit.storedUuid) values[unit.uuidField] = unit.storedUuid;
      if (unit.payloadField) values[unit.payloadField] = payloadStr;
      if (unit.syncedField) values[unit.syncedField] = true;
      if (unit.errorField) values[unit.errorField] = '';
      if (unit.lastTryField) values[unit.lastTryField] = new Date();
      if (unit.tryResultField)
        values[unit.tryResultField] = lists.id(C.LIST.tryResult, C.TRY.NO_CHANGE);

      try {
        record.submitFields({
          type: unit.recordType, id: unit.recordId, values: values,
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) {
        logIo.exception(entry, { type: unit.recordType, id: unit.recordId }, e);
      }
    };

    const writeBackSuccess = (entry, unit, uuid, payloadStr) => {
      const values = {};
      if (unit.uuidField && uuid) values[unit.uuidField] = uuid;
      if (unit.payloadField) values[unit.payloadField] = payloadStr;
      if (unit.syncedField) values[unit.syncedField] = true;   // ONLY here.
      if (unit.lastSyncField) values[unit.lastSyncField] = new Date();
      if (unit.errorField) values[unit.errorField] = '';
      if (unit.lastTryField) values[unit.lastTryField] = new Date();
      if (unit.tryResultField)
        values[unit.tryResultField] = lists.id(C.LIST.tryResult, C.TRY.SYNCED);

      try {
        record.submitFields({
          type: unit.recordType, id: unit.recordId, values: values,
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) {
        logIo.exception(entry, { type: unit.recordType, id: unit.recordId }, e);
      }
    };

    /**
     * E2 — the flag is never set true, and THE STORED PAYLOAD IS NEVER WRITTEN.
     *
     * The stored payload means "the payload that last SUCCEEDED". Overwrite it
     * with a payload that failed and the record compares equal on the next save
     * and never syncs again — silently, with a synced=false nobody notices.
     */
    const writeBackFailure = (entry, unit, message) => {
      const values = {};
      if (unit.syncedField) values[unit.syncedField] = false;
      if (unit.errorField) values[unit.errorField] = util.clip(message, 3900);
      if (unit.lastTryField) values[unit.lastTryField] = new Date();
      if (unit.tryResultField)
        values[unit.tryResultField] = lists.id(C.LIST.tryResult, C.TRY.FAIL_API);
      // the stored payload and the uuid are deliberately NOT written.

      try {
        record.submitFields({
          type: unit.recordType, id: unit.recordId, values: values,
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) {
        logIo.exception(entry, { type: unit.recordType, id: unit.recordId }, e);
      }
    };

    /**
     * §8.6 — the item summarises its UOM rows. It has no stored payload of its
     * own: the payloads live on the rows, because each row is a distinct object.
     */
    const rollUpItem = (entry, itemId, itemType, results) => {
      const f = entry.fields;
      const failed = results.filter((r) => r.ok === false).length;
      const deferred = results.filter((r) => r.deferred).length;
      const allOk = failed === 0 && deferred === 0 && results.length > 0;

      const values = {};
      if (f.synced) values[f.synced] = allOk;
      if (f.attention) values[f.attention] = !allOk;
      if (f.error) values[f.error] = allOk ? '' : summarise(results);
      if (allOk && f.lastSync) values[f.lastSync] = new Date();
      if (f.lastTry) values[f.lastTry] = new Date();
      if (f.tryResult) values[f.tryResult] = lists.id(C.LIST.tryResult,
        allOk ? C.TRY.SYNCED
          : (deferred ? C.TRY.DEFERRED : C.TRY.FAIL_API));

      try {
        record.submitFields({
          type: itemType, id: itemId, values: values,
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) {
        logIo.exception(entry, { type: itemType, id: itemId }, e);
      }
    };

    const summarise = (results) => {
      const bad = results.filter((r) => r.ok === false);
      const def = results.filter((r) => r.deferred).length;
      const parts = [];
      if (bad.length) parts.push(bad.length + ' of ' + results.length +
        ' UOM row(s) failed: ' + dedupe(bad.map((r) => r.error || r.blocked || 'error'))
          .join(' | '));
      if (def) parts.push(def + ' deferred past the inline cap.');
      return util.clip(parts.join(' '), 3900);
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Location parent cascade — §10.9
    // ═══════════════════════════════════════════════════════════════════════════

    const ensureParentLocation = (parentId, cfg, correlation) => {
      const entry = C.MASTER.location;
      const key = 'location|' + parentId;
      try {
        const v = search.lookupFields({
          type: 'location', id: parentId,
          columns: [entry.fields.uuid]
        });
        const uuid = textOf(v[entry.fields.uuid]);
        if (uuid) return uuid;
      } catch (e) { return null; }

      if (PRESYNCED[key]) return null;      // already tried in this execution
      PRESYNCED[key] = true;

      run({
        entry: entry, recordId: parentId, recordType: 'location', cfg: cfg,
        trigger: C.TRIGGER.PRESYNC, correlation: correlation
      });

      try {
        const v2 = search.lookupFields({
          type: 'location', id: parentId,
          columns: [entry.fields.uuid]
        });
        return textOf(v2[entry.fields.uuid]) || null;
      } catch (e) { return null; }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Addresses — §10.5
    // ═══════════════════════════════════════════════════════════════════════════

    const readSub = (sub, f) => {
      try { return sub.getValue({ fieldId: f }) || ''; } catch (e) { return ''; }
    };

    const addrFromSub = (sub, nickname, line) => {
      const a = {
        nickname: nickname || 'Main Address',
        addressee: readSub(sub, 'addressee'),
        addr1: readSub(sub, 'addr1'), addr2: readSub(sub, 'addr2'),
        city: readSub(sub, 'city'), state: readSub(sub, 'state'),
        zip: readSub(sub, 'zip'), country: readSub(sub, 'country'),
        phone: readSub(sub, 'addrphone'),
        sgln: readSub(sub, C.ADDR.sgln),
        uuid: readSub(sub, C.ADDR.uuid),
        line: (line === undefined ? null : line)
      };
      return (!a.addr1 && !a.city && !a.zip) ? null : a;
    };

    /** A Location carries ONE `mainaddress` subrecord, not a sublist. */
    const locationAddresses = (unit) => {
      if (unit.addresses !== undefined) return unit.addresses;
      unit.addresses = [];
      try {
        const rec = record.load({ type: 'location', id: unit.recordId, isDynamic: false });
        const sub = rec.getSubrecord({ fieldId: 'mainaddress' });
        const a = sub ? addrFromSub(sub, 'Main Address', null) : null;
        if (a) unit.addresses = [a];
      } catch (e) {
        logIo.exception(C.MASTER.location, { type: 'location', id: unit.recordId }, e);
      }
      return unit.addresses;
    };

    /** Customer and Vendor carry an `addressbook` sublist — every line is a child. */
    const entityAddresses = (unit) => {
      if (unit.addresses !== undefined) return unit.addresses;
      unit.addresses = [];
      try {
        const rec = record.load({
          type: unit.recordType, id: unit.recordId,
          isDynamic: false
        });
        const n = rec.getLineCount({ sublistId: 'addressbook' });
        for (let i = 0; i < n; i++) {
          const sub = rec.getSublistSubrecord({
            sublistId: 'addressbook',
            fieldId: 'addressbookaddress', line: i
          });
          // A nickname per line: N identically-named addresses is what the
          // existing build produces, and it makes them impossible to tell apart.
          let label = '';
          try {
            label = rec.getSublistValue({
              sublistId: 'addressbook',
              fieldId: 'label', line: i
            }) || '';
          }
          catch (e) { /* no label field on this form */ }
          const a = addrFromSub(sub, label || ('Address ' + (i + 1)), i);
          if (a) unit.addresses.push(a);
        }
      } catch (e) {
        logIo.exception(null, { type: unit.recordType, id: unit.recordId }, e);
      }
      return unit.addresses;
    };

    const readAddresses = (entry, unit) =>
      entry.key === 'LOCATION' ? locationAddresses(unit) : entityAddresses(unit);

    /**
     * After the parent has an identifier, push its addresses — each its own call
     * and its own work item, capped at max_inline.
     */
    const syncChildAddresses = (entry, unit, parentUuid, cfg, correlation, trigger) => {
      const addrs = readAddresses(entry, unit);
      if (!addrs.length) return;

      const cap = Number(cfg.maxInline) || 5;
      const parentName = textOf(unit.data.companyname) || textOf(unit.data.name) ||
        textOf(unit.data.entityid);

      const addrEntry = {
        key: 'ADDRESS', syncType: C.SYNCTYPE.ADDRESS, builder: 'address',
        implemented: true, logSubjectField: entry.logSubjectField,
        fields: {}, endpoints: { create: entry.endpoints.child }
      };

      addrs.forEach((addr, i) => {
        const addrUnit = Object.assign({
          recordType: unit.recordType, recordId: unit.recordId, uomId: null,
          storedUuid: addr.uuid || null, storedPayload: null, storedSynced: false, data: {}
        }, unitFields({}));

        if (i >= cap) {
          logIo.openDeferred({
            entry: addrEntry, unit: addrUnit, cfg: cfg,
            reason: C.REASON.PAYLOAD_CHANGED,
            status: C.STATUS.OPEN_PENDING, outcome: C.OUTCOME.SKIPPED,
            trigger: trigger,
            note: 'Beyond the inline cap of ' + cap + ' addresses for this save.',
            correlation: correlation
          });
          return;
        }

        const body = buildAddress(addr, cfg, parentName);
        const addrPayload = util.canonical(body);

        const target = logIo.resolveLogTarget({
          entry: addrEntry, unit: addrUnit, operation: C.OPERATION.CREATE,
          payload: addrPayload, cfg: cfg
        });

        const res = client.call({
          entry: addrEntry, unit: addrUnit, cfg: cfg, target: target,
          endpoint: entry.endpoints.child, pathParams: { uuid: parentUuid },
          body: body, operation: C.OPERATION.CREATE, payload: addrPayload,
          trigger: trigger, correlation: correlation, requestUuid: correlation
        });

        if (res.ok) {
          logIo.closeSuccess(target, res);
          writeAddressField(entry, unit.recordType, unit.recordId, addr.line,
            C.ADDR.uuid, res.uuid || '');
        } else if (res.suppressed || res.dryRun) {
          logIo.closeNoAction(target, res,
            res.suppressed
              ? 'Environment gate: ' + (res.errorMessage || 'call suppressed') + '.'
              : 'Dry-run mode is on; nothing was sent.');
        } else if (res.skipped) {
          logIo.parkUnsent(target, res, cfg, C.REASON.AWAITING_DECISION,
            res.errorMessage || 'Kill switch is on; no call was made.');
        } else {
          logIo.closeFailure(target, res, cfg);
          writeAddressField(entry, unit.recordType, unit.recordId, addr.line,
            C.ADDR.error, util.clip(res.errorMessage, 900));
        }
      });
    };

    /**
     * Write one field on an address subrecord.
     *
     * This re-fires the User Event. That is safe and self-limiting: the second
     * pass rebuilds the same payload, the stored string matches, and it stamps
     * `No change` without calling out. The payload comparison IS the loop
     * breaker (§2.2).
     */
    const writeAddressField = (entry, recordType, recordId, line, fieldId, value) => {
      try {
        const rec = record.load({ type: recordType, id: recordId, isDynamic: false });
        const sub = (line === null || line === undefined)
          ? rec.getSubrecord({ fieldId: 'mainaddress' })
          : rec.getSublistSubrecord({
            sublistId: 'addressbook',
            fieldId: 'addressbookaddress', line: line
          });
        if (!sub) return;
        sub.setValue({ fieldId: fieldId, value: value });
        rec.save({ ignoreMandatoryFields: true, enableSourcing: false });
      } catch (e) {
        logIo.exception(entry, { type: recordType, id: recordId }, e);
      }
    };

    /**
     * Country → state id. Free text where an id is expected fails silently, so
     * an unresolvable state is OMITTED rather than guessed.
     */
    const resolveStateId = (countryCode, stateValue, cfg) => {
      if (util.blank(countryCode) || util.blank(stateValue)) return null;
      const key = String(countryCode).toUpperCase();

      if (!STATE_CACHE[key]) {
        const map = {};
        const res = client.call({
          entry: {
            key: 'STATES', syncType: C.SYNCTYPE.ADDRESS, implemented: true,
            fields: {}, endpoints: {}
          },
          unit: {
            recordType: 'location', recordId: 0, uomId: null, storedUuid: null,
            payloadField: null, tryResultField: null, lastTryField: null, data: {}
          },
          cfg: cfg, target: { mode: 'MAIN' },
          endpoint: C.EP.STATES, pathParams: { countryId: key },
          body: null, operation: C.OPERATION.QUERY, trigger: C.TRIGGER.INITIAL
        });
        if (res.ok && res.body) {
          const rows = res.body.data || res.body.states || res.body;
          if (Array.isArray(rows)) rows.forEach((s) => {
            if (s && s.name) map[String(s.name).toLowerCase()] = s.id || s.uuid;
            if (s && s.code) map[String(s.code).toLowerCase()] = s.id || s.uuid;
          });
        }
        STATE_CACHE[key] = map;
      }
      const id = STATE_CACHE[key][String(stateValue).toLowerCase()];
      return id === undefined ? null : id;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // User Event helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /** Fields a user legitimately edits. Everything else of ours is locked. */
    const USER_OWNED = {
      code: 1, isDefault: 1, sgln: 1, holdBin: 1, goodBin: 1, props: 1,
      eligible: 1, dosage: 1, strength: 1, generic: 1, gln: 1,
      item: 1, unit: 1, qty: 1, upc: 1, gtin: 1, ndc: 1,
      gs1Prefix: 1, gs1Id: 1, packSize: 1
    };

    const lockSyncFields = (form, entry) => {
      if (!form || !entry || !entry.fields) return;
      Object.keys(entry.fields).forEach((k) => {
        if (USER_OWNED[k]) return;
        try {
          const fld = form.getField({ id: entry.fields[k] });
          if (fld) fld.updateDisplayType({ displayType: 'inline' });
        } catch (e) { /* field not on this form */ }
      });
    };

    /** COPY — a copy has synced nothing. §11.9. */
    const clearAllSyncFields = (newRecord, entry) => {
      if (!newRecord || !entry || !entry.fields) return;
      ['uuid', 'payload', 'synced', 'lastSync', 'lastTry', 'tryResult', 'error', 'attention']
        .forEach((k) => {
          const fid = entry.fields[k];
          if (!fid) return;
          try {
            newRecord.setValue({
              fieldId: fid,
              value: (k === 'synced' || k === 'attention') ? false : ''
            });
          } catch (e) { /* not on the form */ }
        });
    };

    /**
     * beforeSubmit on DELETE — the UUID is unreadable once the record is gone.
     * An item caches every UOM row's UUID, because each row is its own product.
     */
    const cacheForDelete = (oldRecord, entry) => {
      if (!oldRecord || !entry) return;
      const key = oldRecord.type + '|' + oldRecord.id;
      const cached = { uuid: '', name: '', uomUuids: [] };

      if (entry.fields && entry.fields.uuid) {
        try { cached.uuid = oldRecord.getValue({ fieldId: entry.fields.uuid }) || ''; }
        catch (e) { /* non-fatal */ }
      }
      try {
        cached.name = oldRecord.getValue({ fieldId: 'name' }) ||
          oldRecord.getValue({ fieldId: 'itemid' }) || '';
      }
      catch (e) { /* non-fatal */ }

      if (entry.key === 'ITEM') {
        const U = C.MASTER.customrecord_jj_rb_uom_detail.fields;
        try {
          search.create({
            type: C.REC.UOM,
            filters: [[U.item, 'anyof', oldRecord.id]],
            columns: [U.uuid]
          }).run().each((r) => {
            const u = r.getValue(U.uuid);
            if (u) cached.uomUuids.push(u);
            return true;
          });
        } catch (e) { /* non-fatal */ }
      }

      DELETE_CACHE[key] = cached;
    };

    /** afterSubmit on DELETE — only when configured to, and only with a UUID. */
    const handleDelete = (entry, oldRecord, cfg) => {
      if (!entry.endpoints || !entry.endpoints.remove) return [];
      if (String(cfg.inactiveMethod).toUpperCase().indexOf('DELETE') === -1) return [];

      const cached = DELETE_CACHE[oldRecord.type + '|' + oldRecord.id] || {};
      const uuids = entry.key === 'ITEM'
        ? (cached.uomUuids || [])            // one product per UOM row
        : (cached.uuid ? [cached.uuid] : []);
      if (!uuids.length) return [];

      const correlation = util.uuid();
      return uuids.map((uuid) => {
        const unit = Object.assign({
          recordType: oldRecord.type, recordId: oldRecord.id, uomId: null,
          storedUuid: uuid, storedPayload: null, storedSynced: true, data: {}
        }, unitFields({}));

        const target = logIo.resolveLogTarget({
          entry: entry, unit: unit,
          operation: C.OPERATION.DELETE, payload: '', cfg: cfg
        });

        const res = client.call({
          entry: entry, unit: unit, cfg: cfg, target: target,
          endpoint: entry.endpoints.remove, pathParams: { uuid: uuid },
          body: null, operation: C.OPERATION.DELETE, payload: '',
          trigger: C.TRIGGER.INITIAL, correlation: correlation
        });

        // A 404 on a delete means it is already gone, which is the outcome asked
        // for. Treat it as success rather than opening a work item nobody can close.
        if (res.ok || res.httpStatus === 404) logIo.closeSuccess(target, res);
        else if (res.suppressed || res.dryRun)
          logIo.closeNoAction(target, res,
            res.suppressed
              ? 'Environment gate: ' + (res.errorMessage || 'call suppressed') + '.'
              : 'Dry-run mode is on; the delete was not sent.');
        else if (res.skipped)
          logIo.parkUnsent(target, res, cfg, C.REASON.AWAITING_DECISION,
            res.errorMessage || 'Kill switch is on; the delete was not sent.');
        else logIo.closeFailure(target, res, cfg);
        return res;
      });
    };

    /**
     * §14.4 — exactly one Active configuration row. This is the ONE save the
     * SuiteApp refuses.
     */
    const validateConfig = (ctx) => {
      const rec = ctx.newRecord;
      if (!util.truthy(rec.getValue({ fieldId: C.CFG.active }))) return;

      let clash = 0;
      try {
        search.create({
          type: C.REC.CONFIG,
          filters: [[C.CFG.active, 'is', 'T'], 'AND', ['isinactive', 'is', 'F']],
          columns: ['internalid']
        }).run().each((r) => {
          if (String(r.getValue('internalid')) !== String(rec.id)) clash++;
          return true;
        });
      } catch (e) { return; }

      if (clash)
        throw new Error('Another RapidBridge Configuration row is already Active. ' +
          'Exactly one row may be Active — deactivate the other first.');
    };

    /**
     * §9.4 — one saleable unit per item, among ACTIVE rows only.
     *
     * Two active rows claiming the same unit means two Middleware products
     * competing for one identity, and there is no way to tell afterwards which
     * one the destination kept.
     */
    const validateUomRow = (ctx, entry) => {
      const U = entry.fields;
      const rec = ctx.newRecord;

      if (util.truthy(rec.getValue({ fieldId: 'isinactive' }))) return;   // inactive: no claim

      const itemId = rec.getValue({ fieldId: U.item });
      const unitId = rec.getValue({ fieldId: U.unit });
      if (util.blank(itemId) || util.blank(unitId)) return;

      let clash = null;
      try {
        search.create({
          type: C.REC.UOM,
          filters: [[U.item, 'anyof', itemId], 'AND',
          [U.unit, 'anyof', unitId], 'AND',
          ['isinactive', 'is', 'F']],
          columns: ['internalid', U.unit]
        }).run().each((r) => {
          if (String(r.getValue('internalid')) !== String(rec.id)) {
            clash = r.getText(U.unit) || r.getValue(U.unit);
            return false;
          }
          return true;
        });
      } catch (e) { return; }

      if (clash)
        throw new Error('This item already has an active UOM Detail row for "' + clash +
          '". One saleable unit per item — inactivate the other row first.');
    };

    /**
     * §14.1 — an eligible item must carry what the product payload needs. This
     * warns rather than blocks: the item is legitimate NetSuite data, and making
     * the integration an obstacle to trading is the wrong trade.
     */
    const validateItem = (ctx, entry) => {
      // Deliberately empty of throws. The reconciliation page carries
      // `Item has no UOM Detail`, which is where a data gap belongs.
      return;
    };

    return {
      run, builders, resolveUnits, rollUpItem,
      writeBackSuccess, writeBackFailure,
      lockSyncFields, clearAllSyncFields, cacheForDelete, handleDelete,
      validateConfig, validateUomRow, validateItem,
      ensureParentLocation, resolveStateId, isEligible,
      locationAddresses, entityAddresses
    };
  });