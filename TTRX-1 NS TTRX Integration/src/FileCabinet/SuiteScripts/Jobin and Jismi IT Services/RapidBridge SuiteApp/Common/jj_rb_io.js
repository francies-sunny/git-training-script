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
    const resolveLogTarget = (o) => {
      const { entry, unit, payload } = o;

      if (o.triggeringParentId)
        return {
          mode: 'CHILD', parentId: o.triggeringParentId,
          attemptNo: nextAttemptNo(o.triggeringParentId)
        };

      let open = [];
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
        log.error({ title: 'RB resolveLogTarget search', details: e });
      }

      if (open.length === 0) return { mode: 'MAIN' };

      // The main record's target payload always tracks the LATEST intent.
      try {
        record.submitFields({
          type: C.REC.LOG, id: open[0],
          values: { [L.payload]: util.clip(payload || '', 100000) },
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) { /* non-fatal */ }

      if (open.length > 1) {
        // ANOMALY, not an error. Two executions raced. Detect, keep working,
        // and put it in front of a human rather than holding a lock that can
        // be orphaned. §12.5.
        open.forEach((id) => {
          try {
            record.submitFields({
              type: C.REC.LOG, id: id, values: {
                [L.reason]: lid(C.LIST.reconReason, C.REASON.DUPLICATE_OPEN),
                [L.reconStatus]: lid(C.LIST.reconStatus, 'Open')
              }, options: { ignoreMandatoryFields: true }
            });
          } catch (e) { /* non-fatal */ }
        });
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
      v[L.attemptNo] = target.mode === 'MAIN' ? 1 : (target.attemptNo || 1);
      if (target.mode === 'CHILD') v[L.parent] = target.parentId;

      // call detail
      v[L.trigger] = lid(C.LIST.trigger, o.trigger || C.TRIGGER.INITIAL);
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
        v[L.attempts] = 1;
        v[L.firstAt] = new Date();
        v[L.lastAt] = new Date();
        if (o.reason) v[L.reason] = lid(C.LIST.reconReason, o.reason);
      }

      Object.keys(v).forEach((f) => {
        if (v[f] !== null && v[f] !== undefined) {
          try { rec.setValue({ fieldId: f, value: v[f] }); } catch (e) { /* skip */ }
        }
      });

      const id = rec.save({ ignoreMandatoryFields: true });

      if (target.mode === 'CHILD') bumpParentAttempt(target.parentId);
      return {
        id: id, target: target, startedAt: Date.now(),
        correlation: v[L.correlation]
      };
    };

    const bumpParentAttempt = (parentId) => {
      try {
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
      v[L.units] = remainingUnits();
      if (o.httpStatus !== undefined) v[L.httpStatus] = o.httpStatus;
      if (o.errorClass) v[L.errorClass] = lid(C.LIST.errorClass, o.errorClass);
      if (o.errorCode) v[L.errorCode] = util.clip(o.errorCode, 60);
      if (o.errorMessage) v[L.error] = util.clip(o.errorMessage, 3900);
      if (o.uuid) v[L.uuid] = o.uuid;

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
      try {
        record.submitFields({
          type: C.REC.LOG, id: mainId, values: {
            [L.status]: lid(C.LIST.syncStatus, C.STATUS.CLOSED_SUCCESS),
            [L.open]: false,
            [L.success]: true,
            [L.lastAt]: new Date(),
            [L.notBefore]: '',
            [L.error]: '',
            [L.errorCode]: ''
          }, options: { ignoreMandatoryFields: true }
        });
      } catch (e) { log.error({ title: 'RB closeSuccess', details: e }); }
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
      try {
        const rec = record.create({ type: C.REC.LOG });
        const v = subjectValues(entry, unit, cfg, C.OPERATION.UPDATE);
        v[L.ref] = makeRef(entry, unit);
        v[L.correlation] = o.correlation || util.uuid();
        v[L.role] = lid(C.LIST.logRole, C.ROLE.PARENT);
        v[L.attemptNo] = 0;
        v[L.status] = lid(C.LIST.syncStatus, C.STATUS.OPEN_PENDING);
        v[L.open] = true;
        v[L.success] = false;
        v[L.attempts] = 0;
        v[L.firstAt] = new Date();
        v[L.payload] = util.clip(o.payload || '', 100000);
        v[L.reason] = lid(C.LIST.reconReason, reason || C.REASON.PAYLOAD_CHANGED);
        v[L.reconStatus] = lid(C.LIST.reconStatus, 'Open');
        v[L.context] = String(runtime.executionContext);
        Object.keys(v).forEach((f) => {
          if (v[f] !== null && v[f] !== undefined) {
            try { rec.setValue({ fieldId: f, value: v[f] }); } catch (e) { /* skip */ }
          }
        });
        return rec.save({ ignoreMandatoryFields: true });
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

    const logApi = {
      resolveLogTarget, openCall, closeCall, closeSuccess, closeFailure,
      openDeferred, stampTry, exception, mergeDuplicates
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

      let url;
      try {
        url = buildUrl(o.endpoint, o.pathParams, cfg);
      } catch (e) {
        const bad = openCall(o.target, {
          entry: o.entry, unit: o.unit, cfg: cfg, operation: o.operation,
          trigger: o.trigger, endpoint: String(o.endpoint.path), method: o.endpoint.method,
          payload: o.payload, request: o.body, correlation: o.correlation,
          requestUuid: o.requestUuid
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
        requestUuid: o.requestUuid
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
          outcome: C.OUTCOME.SKIPPED,
          errorClass: C.ERRCLASS.RETRYABLE, errorCode: 'KILLSWITCH',
          errorMessage: 'Kill switch is on; no call was made.'
        });

      if (cfg.dryRun)
        return closeCall(logRec, { outcome: C.OUTCOME.DRY_RUN, errorCode: 'DRY_RUN' });

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

    return { log: logApi, client };
  });
