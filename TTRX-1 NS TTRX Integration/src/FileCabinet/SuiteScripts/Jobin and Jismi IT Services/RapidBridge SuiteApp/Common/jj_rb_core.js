/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * jj_rb_core — ids + pure functions + configuration + list resolution.
 *
 * RULE: no record id, field id, list value or endpoint path appears anywhere
 * else in the codebase. If you are about to type a string that starts with
 * 'custrecord', 'custitem', 'custentity' or 'customrecord', it belongs here.
 *
 * Four namespaces, one file, ZERO dependencies on any other RapidBridge file.
 * Nothing here writes a record or makes an HTTP call, which is what makes this
 * file safe to load from the User Event, the Client Script, the Mass Update and
 * the RESTlet alike.
 *
 * Master Data Developer Guide v3.4 §6, §7.5.
 */
define(['N/search'],
  (search) => {

    // ═══════════════════════════════════════════════════════════════════════════
    // namespace 1: C — every id in the SuiteApp
    // ═══════════════════════════════════════════════════════════════════════════

    const REC = Object.freeze({
      CONFIG: 'customrecord_jj_rb_config',
      LOG: 'customrecord_jj_rb_sync_log',   // main AND child — one record type
      UOM: 'customrecord_jj_rb_uom_detail',
      DOSAGE: 'customrecord_jj_rb_dosage_form'
    });

    const CFG = Object.freeze({
      active: 'custrecord_jj_rb_cf_active', subsidiary: 'custrecord_jj_rb_cf_subsidiary',
      clientCode: 'custrecord_jj_rb_cf_client_code', domain: 'custrecord_jj_rb_cf_domain',
      version: 'custrecord_jj_rb_cf_version', secret: 'custrecord_jj_rb_cf_secret',
      authHeader: 'custrecord_jj_rb_cf_auth_header',
      contentType: 'custrecord_jj_rb_cf_content_type',
      timeout: 'custrecord_jj_rb_cf_timeout', language: 'custrecord_jj_rb_cf_language',
      productClass: 'custrecord_jj_rb_cf_product_class',
      eligField: 'custrecord_jj_rb_cf_elig_field',
      maxInline: 'custrecord_jj_rb_cf_max_inline',
      useDosage: 'custrecord_jj_rb_cf_use_dosage',
      useBins: 'custrecord_jj_rb_cf_use_bins',
      useAddress: 'custrecord_jj_rb_cf_use_address',
      syncInactive: 'custrecord_jj_rb_cf_sync_inactive',
      inactiveMethod: 'custrecord_jj_rb_cf_inactive_method',
      staleMinutes: 'custrecord_jj_rb_cf_stale_minutes',
      maxRetries: 'custrecord_jj_rb_cf_max_retries',
      retryBase: 'custrecord_jj_rb_cf_retry_base',
      retryCeiling: 'custrecord_jj_rb_cf_retry_ceiling',
      retryMaxAge: 'custrecord_jj_rb_cf_retry_max_age',
      capture: 'custrecord_jj_rb_cf_capture',
      payloadCap: 'custrecord_jj_rb_cf_payload_cap',
      redactPii: 'custrecord_jj_rb_cf_redact_pii',
      killswitch: 'custrecord_jj_rb_cf_killswitch',
      dryRun: 'custrecord_jj_rb_cf_dryrun',
      // the environment gate — §20.2
      envLabel: 'custrecord_jj_rb_cf_env_label',
      allowNonprod: 'custrecord_jj_rb_cf_allow_nonprod'
    });

    /**
     * Sync Log — ONE record type. Role is decided by whether `parent` is blank.
     * §12.2.
     */
    const LOG = Object.freeze({
      // identification — both roles
      ref: 'custrecord_jj_rb_sl_ref', parent: 'custrecord_jj_rb_sl_parent',
      role: 'custrecord_jj_rb_sl_role', attemptNo: 'custrecord_jj_rb_sl_attempt_no',
      correlation: 'custrecord_jj_rb_sl_correlation',
      requestUuid: 'custrecord_jj_rb_sl_request_uuid',
      // subject
      direction: 'custrecord_jj_rb_sl_direction', type: 'custrecord_jj_rb_sl_type',
      operation: 'custrecord_jj_rb_sl_operation', recType: 'custrecord_jj_rb_sl_rectype',
      nsId: 'custrecord_jj_rb_sl_nsid', item: 'custrecord_jj_rb_sl_item',
      uom: 'custrecord_jj_rb_sl_uom', entity: 'custrecord_jj_rb_sl_entity',
      location: 'custrecord_jj_rb_sl_location', bin: 'custrecord_jj_rb_sl_bin',
      dosage: 'custrecord_jj_rb_sl_dosage', uuid: 'custrecord_jj_rb_sl_uuid',
      config: 'custrecord_jj_rb_sl_config', subsidiary: 'custrecord_jj_rb_sl_subsidiary',
      // work item roll-up — main record only
      status: 'custrecord_jj_rb_sl_status', open: 'custrecord_jj_rb_sl_open',
      success: 'custrecord_jj_rb_sl_success', payload: 'custrecord_jj_rb_sl_payload',
      attempts: 'custrecord_jj_rb_sl_attempts', firstAt: 'custrecord_jj_rb_sl_first_at',
      lastAt: 'custrecord_jj_rb_sl_last_at', notBefore: 'custrecord_jj_rb_sl_not_before',
      exhausted: 'custrecord_jj_rb_sl_exhausted',
      errorClass: 'custrecord_jj_rb_sl_error_class',
      errorCode: 'custrecord_jj_rb_sl_error_code', error: 'custrecord_jj_rb_sl_error',
      suggested: 'custrecord_jj_rb_sl_suggested',
      // call detail — every record
      trigger: 'custrecord_jj_rb_sl_trigger', started: 'custrecord_jj_rb_sl_started',
      completed: 'custrecord_jj_rb_sl_completed', duration: 'custrecord_jj_rb_sl_duration',
      endpoint: 'custrecord_jj_rb_sl_endpoint', method: 'custrecord_jj_rb_sl_method',
      httpStatus: 'custrecord_jj_rb_sl_http_status',
      request: 'custrecord_jj_rb_sl_request', response: 'custrecord_jj_rb_sl_response',
      headers: 'custrecord_jj_rb_sl_headers', outcome: 'custrecord_jj_rb_sl_outcome',
      attemptPayload: 'custrecord_jj_rb_sl_attempt_payload',
      units: 'custrecord_jj_rb_sl_units', context: 'custrecord_jj_rb_sl_context',
      user: 'custrecord_jj_rb_sl_user',
      // reconciliation — main record only
      reason: 'custrecord_jj_rb_sl_reason',
      reconStatus: 'custrecord_jj_rb_sl_recon_status',
      reconMethod: 'custrecord_jj_rb_sl_recon_method',
      resolvedBy: 'custrecord_jj_rb_sl_resolved_by',
      resolvedOn: 'custrecord_jj_rb_sl_resolved_on',
      resolution: 'custrecord_jj_rb_sl_resolution',
      mergedInto: 'custrecord_jj_rb_sl_merged_into',
      mergedCount: 'custrecord_jj_rb_sl_merged_count'
    });

    /**
     * The custom lists behind every SELECT field the scripts write.
     * Code never writes display text directly — it writes an internal id looked
     * up through `lists.id()`, which is what keeps a renamed list value from
     * breaking the code.
     */
    const LIST = Object.freeze({
      tryResult: 'customlist_jj_rb_try_result', syncStatus: 'customlist_jj_rb_sync_status',
      direction: 'customlist_jj_rb_direction', syncType: 'customlist_jj_rb_sync_type',
      operation: 'customlist_jj_rb_operation', outcome: 'customlist_jj_rb_attempt_outcome',
      errorClass: 'customlist_jj_rb_error_class', logRole: 'customlist_jj_rb_log_role',
      trigger: 'customlist_jj_rb_attempt_trigger', httpMethod: 'customlist_jj_rb_http_method',
      reconReason: 'customlist_jj_rb_recon_reason',
      reconStatus: 'customlist_jj_rb_recon_status',
      reconMethod: 'customlist_jj_rb_recon_method',
      envLabel: 'customlist_jj_rb_env_label'
    });

    // ── List values. These are the DISPLAY values as seeded in the SDF objects.
    //    `lists.id()` turns each into the internal id at runtime.
    const STATUS = Object.freeze({
      OPEN_PENDING: 'Open - Pending Retry', OPEN_RETRYING: 'Open - Retrying',
      OPEN_FAILED: 'Open - Failed', OPEN_REVIEW: 'Open - Needs Review',
      CLOSED_SUCCESS: 'Closed - Success', CLOSED_RESOLVED: 'Closed - Resolved',
      CLOSED_MERGED: 'Closed - Merged', CLOSED_CANCELLED: 'Closed - Cancelled',
      CLOSED_NO_ACTION: 'Closed - No Action Needed'
    });
    /** Statuses whose `open` checkbox is TRUE. The find-open-main query, §12.5. */
    const OPEN_STATUSES = Object.freeze([STATUS.OPEN_PENDING, STATUS.OPEN_RETRYING,
    STATUS.OPEN_FAILED, STATUS.OPEN_REVIEW]);

    const ROLE = Object.freeze({ PARENT: 'Parent (main sync)', CHILD: 'Child (retry / new sync)' });

    /** The outcome of an EVALUATION of a master record. §11.5. */
    const TRY = Object.freeze({
      SYNCED: 'Synced - API succeeded', NO_CHANGE: 'No change - payload identical',
      SKIP_INELIGIBLE: 'Skipped - not eligible',
      SKIP_FEATURE: 'Skipped - feature disabled',
      BLOCK_NO_UOM: 'Blocked - no UOM Detail',
      BLOCK_NO_PARENT: 'Blocked - missing parent UUID',
      FAIL_API: 'Failed - API error', FAIL_PRE_API: 'Failed - before API call',
      DEFERRED: 'Deferred - inline cap', DRY_RUN: 'Dry run',
      SUPPRESSED_ENV: 'Suppressed - environment gate'
    });

    const OUTCOME = Object.freeze({
      SUCCESS: 'Success', FAILURE: 'Failure', SKIPPED: 'Skipped', DRY_RUN: 'Dry Run'
    });
    const ERRCLASS = Object.freeze({
      RETRYABLE: 'Retryable', AUTH: 'Auth', POISON: 'Poison', BUSINESS: 'Business'
    });
    const TRIGGER = Object.freeze({
      INITIAL: 'Initial', AUTO_RETRY: 'Auto Retry', MANUAL_RETRY: 'Manual Retry',
      NEW_SYNC: 'New Sync', MASS_UPDATE: 'Mass Update', CSV: 'CSV Import',
      RECON: 'Reconciliation Sweep', PRESYNC: 'Dependency Pre-sync'
    });
    const DIRECTION = Object.freeze({
      OUTBOUND: 'Outbound (NS - MW)', INBOUND: 'Inbound (MW - NS)', INTERNAL: 'Internal'
    });
    const SYNCTYPE = Object.freeze({
      ITEM: 'Item', DOSAGE_FORM: 'Dosage Form', CUSTOMER: 'Customer', VENDOR: 'Vendor',
      ADDRESS: 'Address', LOCATION: 'Location', BIN: 'Bin', RECONCILIATION: 'Reconciliation'
    });
    const OPERATION = Object.freeze({
      CREATE: 'Create', UPDATE: 'Update', DELETE: 'Delete',
      INACTIVATE: 'Inactivate', REACTIVATE: 'Reactivate', QUERY: 'Query'
    });
    const REASON = Object.freeze({
      NEVER_SYNCED: 'Never synced', PAYLOAD_CHANGED: 'Payload changed since last sync',
      LAST_FAILED: 'Last sync failed', NO_UOM: 'Item has no UOM Detail',
      MISSING_PARENT: 'Missing parent UUID', INACTIVE_NOT_SYNCED: 'Inactive but not synced',
      NOT_ELIGIBLE: 'Not eligible - check classification',
      AWAITING_DECISION: 'Awaiting manual decision',
      DUPLICATE_OPEN: 'Duplicate open work items',
      RETRY_EXHAUSTED: 'Retry exhausted'
    });

    // ── Endpoints ──────────────────────────────────────────────────────────────
    const EP = Object.freeze({
      PRODUCT_CREATE: { method: 'POST', path: '/products' },
      PRODUCT_UPDATE: { method: 'PUT', path: '/products/{uuid}' },
      PRODUCT_DELETE: { method: 'DELETE', path: '/products/{uuid}' },
      DOSAGE_CREATE: { method: 'POST', path: '/products/pharmaceutical/dosage_forms' },
      DOSAGE_UPDATE: { method: 'PUT', path: '/products/pharmaceutical/dosage_forms/{uuid}' },
      DOSAGE_DELETE: { method: 'DELETE', path: '/products/pharmaceutical/dosage_forms/{uuid}' },
      PARTNER_CREATE: { method: 'POST', path: '/trading_partners' },
      PARTNER_UPDATE: { method: 'PUT', path: '/trading_partners/{uuid}' },
      PARTNER_DELETE: { method: 'DELETE', path: '/trading_partners/{uuid}' },
      PARTNER_ADDRESS: { method: 'POST', path: '/trading_partners/{uuid}/addresses' },
      LOCATION_CREATE: { method: 'POST', path: '/locations' },
      LOCATION_UPDATE: { method: 'PUT', path: '/locations/{uuid}' },
      LOCATION_DELETE: { method: 'DELETE', path: '/locations/{uuid}' },
      LOCATION_ADDRESS: { method: 'POST', path: '/locations/{uuid}/addresses' },
      STORAGE_AREAS: { method: 'GET', path: '/locations/{uuid}/storage_areas' },
      BIN_CREATE: { method: 'POST', path: '/locations/{locationUuid}/storage_areas' },
      BIN_UPDATE: { method: 'PUT', path: '/locations/{locationUuid}/storage_areas/{uuid}' },
      STATES: { method: 'GET', path: '/utility/country_list/{countryId}/states' },
      HEALTH: { method: 'GET', path: '/health' }
    });

    /**
     * THE DISPATCH TABLE.
     * One entry per NetSuite record type the master User Event is deployed to.
     * Adding a master record = one entry here + one function in `builders`
     * (jj_rb_sync.js) + one deployment. Nothing else.
     *
     * `implemented:false` entries are declared so the shape is fixed and the
     * extension point is obvious, but they have no builder yet. Deploying the
     * User Event to one of them stamps `Failed - before API call` LOUDLY rather
     * than silently doing nothing — see sync.run().
     */
    const MASTER = Object.freeze({

      // ── Phase 1, implemented ────────────────────────────────────────────────
      customrecord_jj_rb_dosage_form: {
        key: 'DOSAGE', syncType: SYNCTYPE.DOSAGE_FORM, builder: 'dosage', implemented: true,
        featureFlag: CFG.useDosage, hasChildren: null, logSubjectField: LOG.dosage,
        fields: {
          uuid: 'custrecord_jj_rb_df_uuid', payload: 'custrecord_jj_rb_df_payload',
          synced: 'custrecord_jj_rb_df_synced', lastSync: 'custrecord_jj_rb_df_last_sync',
          lastTry: 'custrecord_jj_rb_df_last_try',
          tryResult: 'custrecord_jj_rb_df_try_result',
          error: 'custrecord_jj_rb_df_error', code: 'custrecord_jj_rb_df_code',
          isDefault: 'custrecord_jj_rb_df_is_default'
        },
        endpoints: { create: EP.DOSAGE_CREATE, update: EP.DOSAGE_UPDATE, remove: EP.DOSAGE_DELETE }
      },

      location: {
        key: 'LOCATION', syncType: SYNCTYPE.LOCATION, builder: 'location', implemented: true,
        featureFlag: null, hasChildren: 'addressbook', logSubjectField: LOG.location,
        parentField: 'parent',                     // NetSuite's own location hierarchy
        fields: {
          uuid: 'custrecord_jj_rb_location_uuid',
          payload: 'custrecord_jj_rb_loc_payload', synced: 'custrecord_jj_rb_loc_synced',
          lastSync: 'custrecord_jj_rb_loc_last_sync',
          lastTry: 'custrecord_jj_rb_loc_last_try',
          tryResult: 'custrecord_jj_rb_loc_try_result',
          error: 'custrecord_jj_rb_loc_error', sgln: 'custrecord_jj_rb_loc_sgln',
          // Restored. buildLocation reads all four; while they were commented
          // out every one of them resolved to undefined and the keys vanished
          // from the payload.
          gs1Id: 'custrecord_jj_rb_loc_gs1_id',
          locationType: 'locationtype',
          latitude: 'latitude',
          longitude: 'longitude',
          storageAreaUuid: 'custrecord_jj_rb_storage_area_uuid',
          holdBin: 'custrecord_jj_rb_loc_onhold_bin',
          goodBin: 'custrecord_jj_rb_loc_good_bin'
        },
        endpoints: {
          create: EP.LOCATION_CREATE, update: EP.LOCATION_UPDATE,
          remove: EP.LOCATION_DELETE, child: EP.LOCATION_ADDRESS
        }
      },

      // ── Validator only. Never reaches the sync engine. ──────────────────────
      customrecord_jj_rb_config: { key: 'CONFIG', implemented: true, builder: null },

      // ── Declared, not yet built. One builder each and they light up. ────────
      inventoryitem: itemEntry(),
      lotnumberedinventoryitem: itemEntry(),
      serializedinventoryitem: itemEntry(),
      assemblyitem: itemEntry(),
      kititem: itemEntry(),

      customer: entityEntry('CUSTOMER'),
      vendor: entityEntry('VENDOR'),

      bin: {
        key: 'BIN', syncType: SYNCTYPE.BIN, builder: 'bin', implemented: false,
        featureFlag: CFG.useBins, logSubjectField: LOG.bin,
        fields: {
          uuid: 'custrecord_jj_rb_bin_uuid', payload: 'custrecord_jj_rb_bin_payload',
          synced: 'custrecord_jj_rb_bin_synced',
          lastSync: 'custrecord_jj_rb_bin_last_sync',
          lastTry: 'custrecord_jj_rb_bin_last_try',
          tryResult: 'custrecord_jj_rb_bin_try_result',
          error: 'custrecord_jj_rb_bin_error', props: 'custrecord_jj_rb_bin_props'
        },
        endpoints: { create: EP.BIN_CREATE, update: EP.BIN_UPDATE }
      },

      customrecord_jj_rb_uom_detail: {
        key: 'UOM', syncType: SYNCTYPE.ITEM, builder: null, implemented: true,
        delegatesToParent: 'custrecord_jj_rb_uom_item', featureFlag: null,
        logSubjectField: LOG.uom,
        fields: {
          item: 'custrecord_jj_rb_uom_item', unit: 'custrecord_jj_rb_uom_unit',
          qty: 'custrecord_jj_rb_uom_qty', upc: 'custrecord_jj_rb_uom_upc',
          gtin: 'custrecord_jj_rb_uom_gtin',
          gs1Prefix: 'custrecord_jj_rb_uom_gs1_prefix',
          gs1Id: 'custrecord_jj_rb_uom_gs1_id', ndc: 'custrecord_jj_rb_uom_ndc',
          packSize: 'custrecord_jj_rb_uom_pack_size',
          uuid: 'custrecord_jj_rb_uom_uuid', payload: 'custrecord_jj_rb_uom_payload',
          synced: 'custrecord_jj_rb_uom_synced',
          lastSync: 'custrecord_jj_rb_uom_last_sync',
          lastTry: 'custrecord_jj_rb_uom_last_try',
          tryResult: 'custrecord_jj_rb_uom_try_result',
          error: 'custrecord_jj_rb_uom_error'
        },
        endpoints: { create: EP.PRODUCT_CREATE, update: EP.PRODUCT_UPDATE, remove: EP.PRODUCT_DELETE }
      }
    });

    /** Every item type shares one entry shape. Declared once, reused five times. */
    function itemEntry() {
      return {
        key: 'ITEM', syncType: SYNCTYPE.ITEM, builder: 'item', implemented: true,
        featureFlag: null, requiresEligibility: true, requiresUom: true,
        logSubjectField: LOG.item,
        fields: {
          synced: 'custitem_jj_rb_synced', lastSync: 'custitem_jj_rb_last_sync',
          lastTry: 'custitem_jj_rb_last_try', tryResult: 'custitem_jj_rb_try_result',
          error: 'custitem_jj_rb_error', attention: 'custitem_jj_rb_attention',
          eligible: 'custitem_jj_rb_eligible', dosage: 'custitem_jj_rb_dosage_form',
          strength: 'custitem_jj_rb_strength', generic: 'custitem_jj_rb_generic_name'
        },
        // NOTE: no uuid, no payload. Those live on each UOM Detail row.
        endpoints: { create: EP.PRODUCT_CREATE, update: EP.PRODUCT_UPDATE, remove: EP.PRODUCT_DELETE }
      };
    }

    /** Customer and Vendor differ by one payload value. */
    function entityEntry(partnerType) {
      return {
        key: partnerType, syncType: SYNCTYPE[partnerType], builder: 'entity', implemented: true,
        partnerType: partnerType, featureFlag: null, hasChildren: 'addressbook',
        logSubjectField: LOG.entity,
        fields: {
          uuid: 'custentity_jj_rb_uuid', payload: 'custentity_jj_rb_payload',
          synced: 'custentity_jj_rb_synced', lastSync: 'custentity_jj_rb_last_sync',
          lastTry: 'custentity_jj_rb_last_try', tryResult: 'custentity_jj_rb_try_result',
          error: 'custentity_jj_rb_error', gln: 'custentity_jj_rb_gln'
        },
        endpoints: {
          create: EP.PARTNER_CREATE, update: EP.PARTNER_UPDATE,
          remove: EP.PARTNER_DELETE, child: EP.PARTNER_ADDRESS
        }
      };
    }

    /** Address subrecord fields — children of an entity or a location. §10.5. */
    const ADDR = Object.freeze({
      uuid: 'custrecord_jj_rb_addr_uuid', sgln: 'custrecord_jj_rb_addr_sgln',
      error: 'custrecord_jj_rb_addr_error'
    });

    /**
     * Fields that are OURS. A change confined to these is our own write-back,
     * and the recursion guard returns on it. §2.2 guard 1.
     */
    const SYNC_CONTROL_FIELDS = Object.freeze([
      'custitem_jj_rb_synced', 'custitem_jj_rb_last_sync', 'custitem_jj_rb_error',
      'custitem_jj_rb_attention', 'custitem_jj_rb_last_try', 'custitem_jj_rb_try_result',
      'custentity_jj_rb_uuid', 'custentity_jj_rb_payload', 'custentity_jj_rb_synced',
      'custentity_jj_rb_last_sync', 'custentity_jj_rb_error',
      'custentity_jj_rb_last_try', 'custentity_jj_rb_try_result',
      'custrecord_jj_rb_location_uuid', 'custrecord_jj_rb_storage_area_uuid',
      'custrecord_jj_rb_loc_payload', 'custrecord_jj_rb_loc_synced',
      'custrecord_jj_rb_loc_last_sync', 'custrecord_jj_rb_loc_error',
      'custrecord_jj_rb_loc_last_try', 'custrecord_jj_rb_loc_try_result',
      'custrecord_jj_rb_bin_uuid', 'custrecord_jj_rb_bin_payload',
      'custrecord_jj_rb_bin_synced', 'custrecord_jj_rb_bin_last_sync',
      'custrecord_jj_rb_bin_error',
      'custrecord_jj_rb_bin_last_try', 'custrecord_jj_rb_bin_try_result',
      'custrecord_jj_rb_df_uuid', 'custrecord_jj_rb_df_payload', 'custrecord_jj_rb_df_synced',
      'custrecord_jj_rb_df_last_sync', 'custrecord_jj_rb_df_error',
      'custrecord_jj_rb_df_last_try', 'custrecord_jj_rb_df_try_result',
      'custrecord_jj_rb_uom_uuid', 'custrecord_jj_rb_uom_payload',
      'custrecord_jj_rb_uom_synced', 'custrecord_jj_rb_uom_last_sync',
      'custrecord_jj_rb_uom_error',
      'custrecord_jj_rb_uom_last_try', 'custrecord_jj_rb_uom_try_result',
      'custrecord_jj_rb_addr_uuid', 'custrecord_jj_rb_addr_error'
    ]);

    const C = Object.freeze({
      REC, CFG, LOG, LIST, EP, MASTER, ADDR, SYNC_CONTROL_FIELDS,
      STATUS, OPEN_STATUSES, ROLE, TRY, OUTCOME, ERRCLASS, TRIGGER,
      DIRECTION, SYNCTYPE, OPERATION, REASON
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // namespace 2: util — pure. No record access, no HTTP.
    // ═══════════════════════════════════════════════════════════════════════════

    /** RFC-4122 v4, from Math.random. Correlation ids only, never a security token. */
    const uuid = () =>
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
      });

    /**
     * Canonical JSON - and THE change-detection value itself. The string this
     * returns is what gets stored on the record and compared on the next save;
     * there is no hash in between.
     *
     * Keys sorted at every depth, undefined and null dropped. Two payloads that
     * mean the same thing MUST produce the same string, or the comparison fires
     * on key order and every save becomes an API call.
     */
    const canonical = (v) => {
      if (v === null || v === undefined) return '""';
      if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
      if (typeof v === 'object') {
        // EVERY key is kept, including the empty ones. The Middleware contract
        // is a fixed key set: a payload that silently loses its blank keys is
        // not the same payload, and the stored comparison has to be a
        // comparison of what was actually sent. Filtering them out here is what
        // made the stored payload disagree with the wire.
        return '{' + Object.keys(v).sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
      }
      if (typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v);
      return JSON.stringify(String(v));
    };

    /**
     * Are these two payloads the same? A direct string comparison of the
     * canonical forms - no hashing, nothing to collide, and the stored value
     * stays readable in the UI, which is what makes "why did this re-sync?"
     * answerable by looking at the record instead of guessing.
     *
     * A blank on either side is NOT a match: a record that has never synced,
     * and a record whose last call failed, must both still go out.
     */
    const samePayload = (a, b) => {
      if (a === undefined || a === null || a === '') return false;
      if (b === undefined || b === null || b === '') return false;
      return String(a) === String(b);
    };

    /**
     * Form-urlencode, matching the Middleware's declared content type.
     *
     * Nested values are JSON-stringified first. Without that step an array or an
     * object encodes as the literal "[object Object]" — which the Middleware
     * accepts with a 200 and stores as garbage.
     */
    const formEncode = (obj) => Object.keys(obj)
      .map((k) => {
        const v = obj[k];
        // No filtering. The reference client encodes every key of the body and
        // the Middleware expects the full, fixed key set — an omitted key is
        // not the same as an empty one. undefined and null go on the wire as an
        // empty value, exactly as the reference build does.
        const scalar = (v === undefined || v === null) ? ''
          : (typeof v === 'object') ? JSON.stringify(v)
            : (typeof v === 'boolean') ? String(v) : v;
        return encodeURIComponent(k) + '=' + encodeURIComponent(scalar);
      })
      .join('&');

    /**
     * Values a builder wants INSIDE the comparison but NOT on the wire go under
     * `__compare`. An entity's address set is the case this exists for: an
     * address edit must move the parent's comparison, but the addresses are
     * pushed as their own calls and must not ride the parent body.
     */
    const COMPARE_KEY = '__compare';
    const stripCompare = (payload) => {
      if (!payload || typeof payload !== 'object') return payload;
      const out = {};
      Object.keys(payload).forEach((k) => { if (k !== COMPARE_KEY) out[k] = payload[k]; });
      return out;
    };

    const encodeBody = (body, cfg) => {
      if (body === undefined || body === null) return undefined;
      if (typeof body === 'string') return body;
      return String(cfg && cfg.contentType).indexOf('json') !== -1
        ? JSON.stringify(body)
        : formEncode(body);
    };

    const clip = (s, n) => {
      const str = (s === undefined || s === null) ? '' : String(s);
      return str.length <= n ? str : str.substring(0, n - 3) + '...';
    };

    const safeJson = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

    const isoUtc = (d) => {
      try { return (d instanceof Date ? d : new Date(d)).toISOString(); }
      catch (e) { return ''; }
    };

    /** NetSuite hands checkbox values back as boolean, 'T'/'F' or 'true'/'false'. */
    const truthy = (v) =>
      v === true || v === 'T' || v === 'true' || v === 1 || v === '1';

    const blank = (v) =>
      v === undefined || v === null || v === '' || v === 'null' || v === 'undefined';

    /**
     * Did this save change nothing but our own fields?
     * A CREATE has no oldRecord, so it is never our write-back.
     */
    const onlySyncFieldsChanged = (oldRec, newRec, controlled) => {
      if (!oldRec || !newRec) return false;
      const seen = {};
      let changed = 0;
      controlled.forEach((f) => { seen[f] = true; });

      const fields = newRec.getFields();
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        let a, b;
        try { a = oldRec.getValue({ fieldId: f }); b = newRec.getValue({ fieldId: f }); }
        catch (e) { continue; }
        if (String(a) === String(b)) continue;
        if (!seen[f]) return false;        // something of THEIRS changed
        changed++;
      }
      return changed > 0;                  // only ours changed, and something did
    };

    const util = {
      uuid, canonical, samePayload, formEncode, encodeBody, stripCompare, COMPARE_KEY,
      clip, safeJson, isoUtc, truthy, blank, onlySyncFieldsChanged
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // namespace 3: lists — display value → internal id, cached per execution
    // ═══════════════════════════════════════════════════════════════════════════

    const LIST_CACHE = {};

    /**
     * Resolve a custom list value's internal id from its display value.
     * A SELECT field cannot be written with display text through submitFields,
     * and hardcoding internal ids makes the SuiteApp account-specific — which is
     * the whole thing this build exists to stop.
     *
     * @returns {string|null} internal id, or null when the value is not in the list
     */
    const listId = (listScriptId, value) => {
      if (util.blank(value)) return null;
      if (!LIST_CACHE[listScriptId]) {
        const map = {};
        try {
          search.create({
            type: listScriptId,
            filters: [],
            columns: ['internalid', 'name']
          }).run().each((r) => {
            map[String(r.getValue('name')).toLowerCase()] = r.getValue('internalid');
            return true;
          });
        } catch (e) {
          log.error({ title: 'RB listId — list unreadable: ' + listScriptId, details: e });
        }
        LIST_CACHE[listScriptId] = map;
      }
      const id = LIST_CACHE[listScriptId][String(value).toLowerCase()];
      if (id === undefined) {
        log.error({
          title: 'RB listId — value not found',
          details: listScriptId + ' has no value "' + value + '"'
        });
        return null;
      }
      return id;
    };

    const lists = {
      id: listId, invalidate: () => {
        Object.keys(LIST_CACHE)
          .forEach((k) => delete LIST_CACHE[k]);
      }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // namespace 4: config — the one active row, cached for the execution
    // ═══════════════════════════════════════════════════════════════════════════

    let CFG_CACHE = null;
    let CFG_READ = false;

    /**
     * The single active configuration row.
     * @returns {Object|null} null when nothing is configured — the caller returns
     *                        silently rather than guessing at a host.
     */
    const get = () => {
      if (CFG_READ) return CFG_CACHE;
      CFG_READ = true;
      CFG_CACHE = null;

      const cols = Object.keys(CFG).map((k) => CFG[k]);
      try {
        search.create({
          type: REC.CONFIG,
          filters: [[CFG.active, 'is', 'T'], 'AND', ['isinactive', 'is', 'F']],
          columns: cols.concat(['internalid'])
        }).run().getRange({ start: 0, end: 1 }).forEach((r) => {
          const row = { id: r.getValue('internalid') };
          Object.keys(CFG).forEach((k) => {
            const fid = CFG[k];
            const raw = r.getValue(fid);
            row[k] = raw;
            row[k + 'Text'] = r.getText(fid) || null;
          });
          // Normalise the handful the engine branches on.
          row.killswitch = util.truthy(row.killswitch);
          row.dryRun = util.truthy(row.dryRun);
          row.useDosage = util.truthy(row.useDosage);
          row.useBins = util.truthy(row.useBins);
          row.useAddress = util.truthy(row.useAddress);
          row.syncInactive = util.truthy(row.syncInactive);
          row.redactPii = util.truthy(row.redactPii);
          row.allowNonprod = util.truthy(row.allowNonprod);
          row.envLabel = row.envLabelText || 'PRODUCTION';
          row.contentType = row.contentTypeText || 'application/x-www-form-urlencoded';
          // TEXT field, not a list: getText() returns null for a free-form
          // column, so reading the *Text alias meant the configured value
          // (PUT_IS_ACTIVE_FALSE / DELETE) was never seen and every account
          // silently behaved as the default.
          row.inactiveMethod = String(row.inactiveMethod || row.inactiveMethodText || 'PUT_IS_ACTIVE_FALSE').toUpperCase();
          CFG_CACHE = row;
        });
      } catch (e) {
        log.error({ title: 'RB config.get', details: e });
        CFG_CACHE = null;
      }
      return CFG_CACHE;
    };

    const invalidate = () => { CFG_CACHE = null; CFG_READ = false; lists.invalidate(); };

    const config = { get, invalidate };

    return { C, util, lists, config };
  });