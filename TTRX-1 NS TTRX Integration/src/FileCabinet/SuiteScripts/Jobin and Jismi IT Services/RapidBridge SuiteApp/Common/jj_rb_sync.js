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
 *   5. resolve the log target: MAIN record, or CHILD of an open one (§12.5)
 *   6. call — creating exactly ONE log record
 *   7. on success: write uuid + payload + synced=true + CLEAR the error
 *      on failure: leave synced=false, set the error, schedule a retry
 *      ALWAYS: stamp last_try + try_result (§11.5)
 *   8. roll up (items only)
 *
 * PHASE 1 SCOPE: Dosage Form and Location. Every other dispatch entry is
 * declared in jj_rb_core.js with `implemented:false` and fails LOUDLY here
 * rather than doing nothing quietly.
 *
 * Master Data Developer Guide v3.4 §7.7, §10.1, §10.5, §10.6.
 */
define(['N/record', 'N/search', 'N/runtime', './jj_rb_core', './jj_rb_io'],
  (record, search, runtime, core, io) => {

    const { C, util, lists, config } = core;
    const { log, client } = io;

    // Cached across one execution only.
    const DELETE_CACHE = {};   // recordType|id -> { uuid, name }
    const STATE_CACHE = {};   // countryCode   -> { stateName: id }
    const PRESYNCED = {};   // recordType|id -> true, cycle guard for the cascade

    // ═══════════════════════════════════════════════════════════════════════════
    // Sync units
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * A unit is "one thing that gets one API call". For everything except Item it
     * is the record itself; for an Item it is one per active UOM Detail row.
     *
     * @returns {{list:Array<Object>, blocked?:string}}
     */
    const resolveUnits = (entry, recordId, recordType, cfg, o) => {
      const f = entry.fields || {};

      const unit = {
        recordType: recordType,
        recordId: recordId,
        uomId: null,
        uuidField: f.uuid || null,
        payloadField: f.payload || null,
        syncedField: f.synced || null,
        lastSyncField: f.lastSync || null,
        lastTryField: f.lastTry || null,
        tryResultField: f.tryResult || null,
        errorField: f.error || null,
        storedUuid: null, storedPayload: null, storedSynced: false,
        data: {}
      };

      const cols = [];
      Object.keys(f).forEach((k) => { if (f[k]) cols.push(f[k]); });

      // The business fields each builder needs, read in ONE lookupFields.
      if (entry.key === 'DOSAGE') cols.push('name', 'isinactive');
      if (entry.key === 'LOCATION')
        cols.push('name', 'isinactive', 'parent', 'subsidiary', 'isinactive');

      let vals = {};
      try {
        vals = search.lookupFields({
          type: recordType, id: recordId,
          columns: dedupe(cols)
        });
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

    // ═══════════════════════════════════════════════════════════════════════════
    // Builders — one function per entry.builder value
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * §10.1 — Dosage Form. The simplest complete path: one unit, no children,
     * no parent, no eligibility test. If this works end to end, the framework
     * works.
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
     * §10.6 — Location. One unit, an optional parent that must be synced first,
     * and the address embedded so an address edit moves the comparison.
     */
    const buildLocation = (unit, cfg, entry) => {
      const f = entry.fields;
      const payload = {
        name: textOf(unit.data.name),
        is_active: !util.truthy(unit.data.isinactive),
        is_unselectable_location: false,
        gs1_sgln: textOf(unit.data[f.sgln]) || undefined,
        parent_location_uuid: unit.parentUuid || undefined
      };

      // On create only. Accounts on Bin Management get their storage areas from
      // real bins, so asking the Middleware for a default one would create a
      // second, unmanaged storage area — §10.6 step 5 read against the v3.1
      // bin decision.
      if (!unit.storedUuid && !cfg.useBins) payload.create_default_storage_area = true;

      // The address set is not its own object, so it rides IN the parent's
      // payload. With a direct string comparison there is nothing to keep short,
      // so the address goes in whole rather than as a digest - which means the
      // stored payload shows exactly what was sent, and an address edit moves
      // the comparison by itself.
      const addr = locationAddress(unit);
      if (addr) payload.address = {
        nickname: addr.nickname, recipient_name: addr.addressee,
        line1: addr.addr1, line2: addr.addr2, city: addr.city,
        state: addr.state, zip: addr.zip, country_code: addr.country,
        gs1_sgln: addr.sgln
      };

      return payload;
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
        line2: addr.addr2 || undefined,
        city: addr.city || '',
        zip: addr.zip || '',
        country_code: addr.country || '',
        gs1_sgln: addr.sgln || undefined
      };
      const stateId = resolveStateId(addr.country, addr.state, cfg);
      if (stateId) body.state_id = stateId;     // omitted, never free text
      return body;
    };

    const builders = {
      dosage: buildDosageForm,
      location: buildLocation,
      address: buildAddress
      // item, entity, bin: declared in C.MASTER, not yet built. See run().
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // The engine
    // ═══════════════════════════════════════════════════════════════════════════

    const run = (o) => {
      const { entry, recordId, recordType, cfg } = o;
      const trigger = o.trigger || C.TRIGGER.INITIAL;
      const correlation = o.correlation || util.uuid();

      // Declared but not built. Fail loudly — a silent no-op here is the kind of
      // thing that is discovered in production.
      if (entry.implemented === false || !builders[entry.builder]) {
        const u = resolveUnits(entry, recordId, recordType, cfg, o);
        if (u.list.length) log.stampTry(u.list[0], C.TRY.FAIL_PRE_API);
        log.exception(entry, { type: recordType, id: recordId },
          new Error('No builder for "' + entry.builder + '". ' + entry.key +
            ' is declared in the dispatch table but not implemented in ' +
            'this phase. Remove the deployment or add the builder.'));
        return [{ ok: false, notImplemented: true }];
      }

      const units = resolveUnits(entry, recordId, recordType, cfg, o);
      if (units.blocked) {
        log.exception(entry, { type: recordType, id: recordId }, new Error(units.blocked));
        return [{ ok: false, blocked: units.blocked }];
      }

      const inlineCap = Number(cfg.maxInline) || 5;
      const results = [];

      units.list.forEach((unit, i) => {

        // ── Beyond the cap: record the work item, let the sweep do the call.
        if (i >= inlineCap) {
          log.openDeferred({
            entry: entry, unit: unit, cfg: cfg,
            reason: C.REASON.PAYLOAD_CHANGED, correlation: correlation
          });
          log.stampTry(unit, C.TRY.DEFERRED);
          results.push({ deferred: true });
          return;
        }

        // ── Record-specific gates that stop a call before it is built.
        const gate = preflight(entry, unit, cfg);
        if (gate) {
          log.stampTry(unit, gate.tryResult);
          results.push({ skipped: true, reason: gate.reason });
          return;
        }

        // ── Location: the parent must exist remotely before the child can name it.
        if (entry.key === 'LOCATION') {
          const parentId = textOf(unit.data.parent);
          if (parentId) {
            const pu = ensureParentLocation(parentId, cfg, correlation);
            if (!pu) {
              log.openDeferred({
                entry: entry, unit: unit, cfg: cfg,
                reason: C.REASON.MISSING_PARENT, correlation: correlation
              });
              log.stampTry(unit, C.TRY.BLOCK_NO_PARENT);
              results.push({ ok: false, blocked: 'parent location not synced' });
              return;
            }
            unit.parentUuid = pu;
          }
        }

        const payload = builders[entry.builder](unit, cfg, entry);       // step 2
        const payloadStr = util.canonical(payload);                      // step 3

        // ── step 4: THE TRIGGER TEST. A direct string comparison against the
        //    payload the Middleware last accepted. Identical, already synced,
        //    and a stored identifier ⇒ nothing to do and NO log record.
        if (util.samePayload(payloadStr, unit.storedPayload)
          && unit.storedSynced === true && unit.storedUuid) {
          log.stampTry(unit, C.TRY.NO_CHANGE);
          results.push({ skipped: true, noChange: true });
          return;
        }

        const operation = unit.storedUuid ? C.OPERATION.UPDATE : C.OPERATION.CREATE;

        const target = log.resolveLogTarget({                            // step 5
          entry: entry, unit: unit, operation: operation, payload: payloadStr,
          cfg: cfg, reason: reasonFor(unit), triggeringParentId: o.parentId
        });

        const res = client.call({                                        // step 6
          entry: entry, unit: unit, cfg: cfg, target: target,
          endpoint: unit.storedUuid ? entry.endpoints.update : entry.endpoints.create,
          pathParams: { uuid: unit.storedUuid },
          body: payload, operation: operation, payload: payloadStr,
          trigger: trigger, correlation: correlation,
          requestUuid: correlation
        });

        if (res.ok) {                                                    // step 7
          writeBackSuccess(entry, unit, res.uuid || unit.storedUuid, payloadStr);
          log.closeSuccess(target, res);
          results.push({ ok: true, uuid: res.uuid || unit.storedUuid });

          // Children, after the parent has an identifier. §10.5.
          if (entry.hasChildren && cfg.useAddress)
            syncChildAddresses(entry, unit, res.uuid || unit.storedUuid, cfg,
              correlation, trigger);

        } else if (res.suppressed || res.dryRun) {
          // Built, stringified, validated, logged — nothing sent. Not a failure:
          // it does not increment retries and does not enter the worklist.
          log.stampTry(unit, res.suppressed ? C.TRY.SUPPRESSED_ENV : C.TRY.DRY_RUN);
          results.push({ ok: false, suppressed: true });

        } else if (res.skipped) {
          log.stampTry(unit, C.TRY.FAIL_PRE_API);
          results.push({ ok: false, skipped: true });

        } else {
          writeBackFailure(entry, unit, res.errorMessage);
          log.closeFailure(target, res, cfg);
          results.push({ ok: false });
        }
      });

      return results;
    };

    /** Gates that belong to one record type and stop the call before it is built. */
    const preflight = (entry, unit, cfg) => {
      if (entry.key === 'DOSAGE') {
        // System rows exist for NetSuite users; the Middleware owns its defaults.
        if (util.truthy(unit.data[entry.fields.isDefault]))
          return { tryResult: C.TRY.SKIP_INELIGIBLE, reason: 'is_default row' };
        if (util.blank(textOf(unit.data[entry.fields.code])))
          return { tryResult: C.TRY.FAIL_PRE_API, reason: 'dosage code is blank' };
      }
      // An inactive record is still synced — is_active:false is the payload that
      // tells the Middleware — unless the account has opted out.
      if (util.truthy(unit.data.isinactive) && cfg.syncInactive === false
        && !unit.storedUuid)
        return { tryResult: C.TRY.SKIP_INELIGIBLE, reason: 'inactive, never synced' };
      return null;
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
        log.exception(entry, { type: unit.recordType, id: unit.recordId }, e);
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
        log.exception(entry, { type: unit.recordType, id: unit.recordId }, e);
      }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Location parent cascade — §10.9
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Make sure the parent location carries a UUID, syncing it first if not.
     * One level of recursion per call, guarded against a cycle.
     *
     * @returns {string|null} the parent's UUID, or null when it could not be got
     */
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

    /**
     * Read the location's main address subrecord.
     * NetSuite gives a Location one `mainaddress` subrecord, not a sublist.
     */
    const readLocationAddress = (locationId) => {
      try {
        const rec = record.load({ type: 'location', id: locationId, isDynamic: false });
        const sub = rec.getSubrecord({ fieldId: 'mainaddress' });
        if (!sub) return null;
        const get = (f) => {
          try { return sub.getValue({ fieldId: f }) || ''; }
          catch (e) { return ''; }
        };
        const addr = {
          nickname: get('addrphone') ? '' : '',      // NetSuite has no nickname here
          addressee: get('addressee'),
          addr1: get('addr1'), addr2: get('addr2'),
          city: get('city'), state: get('state'),
          zip: get('zip'), country: get('country'),
          sgln: get(C.ADDR.sgln),
          uuid: get(C.ADDR.uuid)
        };
        addr.nickname = 'Main Address';
        const empty = !addr.addr1 && !addr.city && !addr.zip;
        return empty ? null : addr;
      } catch (e) {
        log.exception(C.MASTER.location, { type: 'location', id: locationId }, e);
        return null;
      }
    };

    /** Read once per unit — the builder and the child call both use it. */
    const locationAddress = (unit) => {
      if (unit.address === undefined) unit.address = readLocationAddress(unit.recordId);
      return unit.address;
    };

    /** After the parent has an identifier, POST its address. */
    const syncChildAddresses = (entry, unit, parentUuid, cfg, correlation, trigger) => {
      const addr = locationAddress(unit);
      if (!addr) return;

      const body = buildAddress(addr, cfg, textOf(unit.data.name));

      const addrUnit = {
        recordType: unit.recordType, recordId: unit.recordId, uomId: null,
        uuidField: null, payloadField: null, syncedField: null, lastSyncField: null,
        lastTryField: null, tryResultField: null, errorField: null,
        storedUuid: addr.uuid || null, storedPayload: null, storedSynced: false, data: {}
      };
      const addrEntry = {
        key: 'ADDRESS', syncType: C.SYNCTYPE.ADDRESS, builder: 'address',
        implemented: true, logSubjectField: entry.logSubjectField,
        fields: {}, endpoints: { create: entry.endpoints.child }
      };

      const addrPayload = util.canonical(body);
      const target = log.resolveLogTarget({
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
        log.closeSuccess(target, res);
        writeAddressField(unit.recordId, C.ADDR.uuid, res.uuid || '');
      } else if (!res.suppressed && !res.dryRun) {
        log.closeFailure(target, res, cfg);
        writeAddressField(unit.recordId, C.ADDR.error,
          util.clip(res.errorMessage, 900));
      }
    };

    /**
     * Write one field on the location's main address subrecord.
     *
     * This re-fires the User Event. That is safe and self-limiting: the second
     * pass rebuilds the same payload, the stored string matches, and it stamps
     * `No change` without calling out. The payload comparison IS the loop
     * breaker (§2.2).
     */
    const writeAddressField = (locationId, fieldId, value) => {
      try {
        const rec = record.load({ type: 'location', id: locationId, isDynamic: false });
        const sub = rec.getSubrecord({ fieldId: 'mainaddress' });
        if (!sub) return;
        sub.setValue({ fieldId: fieldId, value: value });
        rec.save({ ignoreMandatoryFields: true, enableSourcing: false });
      } catch (e) {
        log.exception(C.MASTER.location, { type: 'location', id: locationId }, e);
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
            key: 'STATES', syncType: C.SYNCTYPE.LOCATION, implemented: true,
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

    /** beforeLoad — our fields are ours. Disabled for every role. */
    const lockSyncFields = (form, entry) => {
      if (!form || !entry || !entry.fields) return;
      Object.keys(entry.fields).forEach((k) => {
        // The business fields a user legitimately edits stay editable.
        if (k === 'code' || k === 'isDefault' || k === 'sgln' ||
          k === 'holdBin' || k === 'goodBin' || k === 'props' ||
          k === 'eligible' || k === 'dosage' || k === 'strength' ||
          k === 'generic' || k === 'gln') return;
        try {
          const fld = form.getField({ id: entry.fields[k] });
          if (fld) fld.updateDisplayType({ displayType: 'inline' });
        } catch (e) { /* field not on this form */ }
      });
    };

    /** COPY — a copy has synced nothing. §11.9. */
    const clearAllSyncFields = (newRecord, entry) => {
      if (!newRecord || !entry || !entry.fields) return;
      const clear = ['uuid', 'payload', 'synced', 'lastSync', 'lastTry', 'tryResult', 'error'];
      clear.forEach((k) => {
        const fid = entry.fields[k];
        if (!fid) return;
        try {
          newRecord.setValue({ fieldId: fid, value: (k === 'synced') ? false : '' });
        } catch (e) { /* not on the form */ }
      });
    };

    /** beforeSubmit on DELETE — the UUID is unreadable once the record is gone. */
    const cacheForDelete = (oldRecord, entry) => {
      if (!oldRecord || !entry || !entry.fields || !entry.fields.uuid) return;
      try {
        DELETE_CACHE[oldRecord.type + '|' + oldRecord.id] = {
          uuid: oldRecord.getValue({ fieldId: entry.fields.uuid }) || '',
          name: oldRecord.getValue({ fieldId: 'name' }) || ''
        };
      } catch (e) { /* non-fatal */ }
    };

    /** afterSubmit on DELETE — only when configured to, and only with a UUID. */
    const handleDelete = (entry, oldRecord, cfg) => {
      if (!entry.endpoints || !entry.endpoints.remove) return [];
      const cached = DELETE_CACHE[oldRecord.type + '|' + oldRecord.id];
      const uuid = cached && cached.uuid;
      if (!uuid) return [];
      if (String(cfg.inactiveMethod).toUpperCase().indexOf('DELETE') === -1) return [];

      const unit = {
        recordType: oldRecord.type, recordId: oldRecord.id, uomId: null,
        uuidField: null, payloadField: null, syncedField: null, lastSyncField: null,
        lastTryField: null, tryResultField: null, errorField: null,
        storedUuid: uuid, storedPayload: null, storedSynced: true, data: {}
      };
      const target = log.resolveLogTarget({
        entry: entry, unit: unit,
        operation: C.OPERATION.DELETE, payload: '', cfg: cfg
      });

      const res = client.call({
        entry: entry, unit: unit, cfg: cfg, target: target,
        endpoint: entry.endpoints.remove, pathParams: { uuid: uuid },
        body: null, operation: C.OPERATION.DELETE, trigger: C.TRIGGER.INITIAL
      });

      if (res.ok) log.closeSuccess(target, res);
      else if (!res.suppressed && !res.dryRun) log.closeFailure(target, res, cfg);
      return [res];
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

    const validateUomRow = () => { /* §9.4 — UOM phase */ };
    const validateItem = () => { /* §14.1 — Item phase */ };

    return {
      run, builders, resolveUnits, locationAddress,
      writeBackSuccess, writeBackFailure,
      lockSyncFields, clearAllSyncFields, cacheForDelete, handleDelete,
      validateConfig, validateUomRow, validateItem,
      ensureParentLocation, resolveStateId
    };
  });
