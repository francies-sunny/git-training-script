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
    const PRESYNCED = {};   // recordType|id -> true, cycle guard for the cascade

    // ═══════════════════════════════════════════════════════════════════════════
    // Small readers
    // ═══════════════════════════════════════════════════════════════════════════

    const dedupe = (a) => a.filter((v, i) => a.indexOf(v) === i);

    /**
     * search.lookupFields, but a column this account does not expose costs that
     * one column instead of the whole record.
     *
     * NetSuite rejects the ENTIRE lookup when one column is not valid for the
     * record type — "An nlobjSearchColumn contains an invalid column, or is not
     * in proper syntax: altname" — and the record then fails to sync for a
     * reason that has nothing to do with it. Field availability varies by
     * record type, by account and by enabled features, so a SuiteApp that must
     * run in accounts it has never seen cannot assume a fixed column list.
     *
     * The offending column is named in the message. Drop it, try again, and
     * report which columns were dropped so the gap is visible in the log rather
     * than silently changing the payload.
     */
    const lookupSafe = (type, id, columns) => {
      let cols = dedupe((columns || []).filter(Boolean));
      const dropped = [];

      for (let attempt = 0; attempt < 6; attempt++) {
        if (!cols.length) break;
        try {
          const vals = search.lookupFields({ type: type, id: id, columns: cols });
          if (dropped.length) {
            log.audit({
              title: 'RB columns not available on ' + type,
              details: {
                recordId: id, dropped: dropped,
                note: 'These fields are not exposed on this record type in this ' +
                  'account. They were read as empty.'
              }
            });
          }
          return { values: vals, dropped: dropped };
        } catch (e) {
          const msg = String((e && e.message) || e);
          // "... is not in proper syntax: altname"  →  altname
          const m = /invalid column[^:]*:\s*([A-Za-z0-9_.]+)/i.exec(msg);
          const bad = m && m[1];
          if (!bad) throw e;                       // a different failure
          const before = cols.length;
          cols = cols.filter((c) => c !== bad);
          if (cols.length === before) throw e;     // named a column we did not ask for
          dropped.push(bad);
        }
      }

      throw new Error('No usable columns remained for ' + type + '/' + id +
        ' after dropping: ' + dropped.join(', '));
    };

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
    /**
     * RETIRED. It collapsed a blank to undefined, and undefined was then dropped
     * by both the canonical renderer and the form encoder, so the key vanished
     * from the payload entirely. The Middleware contract is a FIXED KEY SET: an
     * absent key is not the same as an empty one.
     *
     * Kept only so nothing outside the builders breaks; no builder uses it.
     */
    // const orNothing = (v) => (util.blank(v) ? undefined : v);

    /**
     * The replacement. Every payload value goes through this: a blank becomes an
     * empty string and the key stays in the payload, exactly as the reference
     * client sends it.
     */
    const txt = (v) => {
      const t = textOf(v);
      return (t === undefined || t === null) ? '' : String(t);
    };

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

      log.debug("Resolving unit for " + entry.key + "/" + recordType + "/" + recordId);

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

      if (entry.key === 'LOCATION') {
        const locationFields = dedupe(
          Object.keys(f)
            .filter((key) => f[key])
            .map((key) => f[key])
            .concat(['name', 'isinactive', 'parent', 'subsidiary'])
        );

        try {
          const locationRecord = record.load({
            type: recordType,
            id: recordId,
            isDynamic: false
          });
          const vals = {};

          locationFields.forEach((fieldId) => {
            vals[fieldId] = locationRecord.getValue({ fieldId: fieldId });
          });

          unit.storedUuid = f.uuid ? textOf(vals[f.uuid]) : null;
          unit.storedPayload = f.payload ? textOf(vals[f.payload]) : null;
          unit.storedSynced = f.synced ? util.truthy(vals[f.synced]) : false;
          unit.data = vals;
          unit.sourceRecord = locationRecord;
          return { list: [unit] };
        } catch (e) {
          log.error('Error @ resolveUnits location load: ' + recordType + '/' + recordId, e);
          return {
            list: [],
            blocked: 'Location ' + recordId +
              ' could not be read: ' + e.message
          };
        }
      }

      const cols = [];
      Object.keys(f).forEach((k) => { if (f[k]) cols.push(f[k]); });
      if (entry.key === 'DOSAGE') cols.push('name', 'isinactive');
      // The native columns are declared on the entry, because Customer and
      // Vendor do not expose the same ones.
      (entry.extraColumns || []).forEach((c) => cols.push(c));

      let vals = {};
      try {
        vals = lookupSafe(recordType, recordId, cols).values;
      } catch (e) {
        log.error("Error @ resolveUnits: ", e);
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
        log.error("Error @ resolveUnits: ", e);
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

      // BASE UNIT FIRST. A pack names its child product by UUID, so the row
      // that IS that child has to be accepted before the pack can be sent. The
      // rows keep their internal-id order within each group, so the sequence
      // is still stable from one save to the next.
      rows.sort((a, b) => {
        const la = isLeafRow(a, cfg) ? 0 : 1;
        const lb = isLeafRow(b, cfg) ? 0 : 1;
        if (la !== lb) return la - lb;
        return Number(a.id) - Number(b.id);
      });

      // A UOM row saved directly syncs THAT row only — never its siblings (§10.3).
      const wanted = o && o.onlyUomRowId
        ? rows.filter((r) => String(r.id) === String(o.onlyUomRowId))
        : rows;

      // The row the save came from is not among its item's ACTIVE rows. An
      // inactive row is not a product and is not published, which is correct —
      // but returning an empty list here left the row untouched and the item
      // stamped as failed with no message, so it is reported as a block.
      if (o && o.onlyUomRowId && !wanted.length) {
        log.audit({
          title: 'RB UOM Detail row not published',
          details: {
            uomRowId: o.onlyUomRowId, itemId: itemId,
            activeRows: rows.map((r) => r.id)
          }
        });
        return {
          list: [],
          blocked: 'This UOM Detail row is not an active row of item ' + itemId +
            ', so it is not one of its products and nothing is published for it.',
          blockedTry: C.TRY.SKIP_INELIGIBLE,
          reason: C.REASON.NOT_ELIGIBLE,
          stampUomRowId: o.onlyUomRowId
        };
      }

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
        // Every active row of the same item. A pack row needs its base-unit
        // sibling's UUID to state its composition, and a row saved on its own
        // still has to be able to find it.
        uomRows: rows,
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
      // Reference payload: code, name. is_active is NEW — required so an
      // inactivated dosage form can be expressed without deleting it.
      return {
        code: txt(unit.data[f.code]),            // the identity. Immutable.
        name: txt(unit.data.name),
        is_active: !util.truthy(unit.data.isinactive)      // NEW
      };
    };

    /**
     * §10.6 — Location. One unit, an optional parent that must be synced first.
     * The address rides the comparison only; it is pushed as its own call.
     */
    const buildLocation = (unit, cfg, entry) => {
      const f = entry.fields;
      const d = unit.data;

      // The FULL reference key set, in the reference order. Every key is always
      // present; a value the account does not hold goes out empty, never absent.
      const payload = {
        custom_uuid: txt(unit.storedUuid),
        name: txt(d.name),
        gs1_id: txt(d[f.gs1Id]),
        gs1_sgln: txt(d[f.sgln]),
        parent_location_uuid: txt(unit.parentUuid),
        location_detail: txt(d[f.locationType]),
        is_unselectable_location: false,
        manufacturing_location_prefix_or_suffix_id_value: '',
        location_lat: txt(d[f.latitude]),
        location_long: txt(d[f.longitude]),
        is_active: !util.truthy(d.isinactive),

        // The reference build sends this as true unconditionally. Here the KEY
        // is always sent and only the VALUE is conditional: a default storage
        // area is wanted on create, and only when the account is not on Bin
        // Management — with real bins it would create a second, unmanaged
        // storage area alongside them.
        // create_default_storage_area: (!unit.storedUuid && cfg.useBins !== true)
        create_default_storage_area: true // always true for now
      };

      // No address set in this comparison. An address is its own object in the
      // Middleware with its own identifier, payload and work item, so an
      // address edit is an address change, not a Location change. Addresses are
      // evaluated separately on every save — see maybeSyncAddresses — and that
      // holds whether Location address sync is on or off.

      return payload;
    };

    /**
     * §10.4 — Customer and Vendor. One builder, one dispatch entry each; the
     * only difference is `type`.
     */
    const buildPartner = (unit, cfg, entry) => {
      log.debug("buildPartner", unit, cfg, entry);
      const f = entry.fields;
      const d = unit.data;
      const isPerson = util.truthy(d.isperson);
      // `altname` is the person's name on a Customer. A Vendor does not expose
      // it, so fall through rather than sending an empty name.
      const name = (isPerson
        ? (txt(d.altname) || txt(d.companyname))
        : (txt(d.companyname) || txt(d.altname))) || txt(d.entityid);

      // The FULL reference trading-partner key set. Customer and Vendor differ
      // by the `type` value alone. Everything the account does not supply is
      // sent empty; nothing is omitted.
      const payload = {
        custom_uuid: txt(unit.storedUuid),
        name: name,
        gs1_id: txt(d[f.gln]),
        gs1_company_id: '',
        gs1_sgln: '',
        type: entry.partnerType,                    // CUSTOMER | VENDOR
        // The parent trading partner, for a sub-customer or sub-vendor. Empty
        // when the NetSuite record has no parent.
        parent_tp_uuid: txt(unit.parentUuid),
        customer_id: txt(d.entityid),
        friendly_name: '',
        // Named by ADDRESS UUID, so they can only be filled once the address
        // itself has been accepted. On an UPDATE the address pass has already
        // run by the time this payload is built, so the identifiers are here.
        // On a CREATE they cannot be: the addresses do not exist remotely yet.
        // Those go out empty and refreshPartnerDefaults fills them in.
        default_billing_address_uuid: defaultAddressUuid(unit, cfg, entry, 'defaultBilling'),
        default_shipping_address_uuid: defaultAddressUuid(unit, cfg, entry, 'defaultShipping'),
        phone: txt(d.phone),
        phone_ext: '',
        notification_email: txt(d.email),
        // As in the reference build: every partner is subscribed to every
        // notification.
        new_trx_notification_type: 'ALL',
        flag_notification_name: '',
        flag_notification_email: '',
        flag_notification_phone: '',
        flag_notification_phone_ext: '',
        // NEW value for an existing key: the reference sends this empty. The
        // NetSuite internal id makes the remote object traceable back.
        external_reference: String(unit.recordId),
        is_active: !util.truthy(d.isinactive),
        inbound_shipping_check_percentage: '',
        outbound_shipping_check_percentage: '',
        sender_id: '',
        receiver_id: '',
        as2_id: '',
        is_a_3pl_client: false,
        '3pl_is_our_company_is_internal_entity_of_tp': false,
        is_send_outbond_epcis: false,
        is_send_outbond_x12: false,
        default_outbound_transaction_type: 'SALES',
        send_copy_outbound_shipment_external_trading_entity_id: '',
        outbound_epcis_generator_type: '',
        is_enable_transmit_outbound_850: '',
        omit_comm_aggr_in_epcis: false
      };

      // The address set is deliberately NOT folded into this comparison.
      // An address is its own object in the Middleware with its own identifier,
      // its own payload and its own work item, so an address edit is an address
      // change — not a change to the customer or vendor. Including it here made
      // every address edit re-send the parent for data that had not moved.
      //
      // Addresses are evaluated separately, on every save, in
      // syncChildAddresses. They no longer depend on the parent calling out.
      return payload;
    };

    /**
     * §8.3 — Item / Product. Shared fields come from the ITEM; identity fields
     * come from the UOM ROW. That split is what makes N products from one item.
     */
    /**
     * The TrackTraceRX pack size type id for one UOM Detail row.
     *
     * The mapping lives on the configuration as JSON, keyed on the Saleable
     * Unit display text, because neither half can be hardcoded: the ids come
     * from GET /products/packaging_types and the units are the client's own
     * custom list.
     *
     * An unmapped unit falls back to "1", as the reference build does. That is
     * the leaf value, so the fallback is written to the execution log: a Case
     * that quietly became a leaf product is a data error worth seeing.
     */
    const packSizeTypeOf = (u, cfg) => {
      if (!u) return '1';
      // Resolved once per row. The rows are sorted by this value and the
      // builder reads it again, so without the cache one unmapped unit would
      // write the audit entry below a dozen times for one save.
      if (u.packSizeType !== undefined) return u.packSizeType;

      const map = (cfg && cfg.packSizeTypes) || {};
      const key = String(u.unit || '').trim().toUpperCase();
      if (key && Object.prototype.hasOwnProperty.call(map, key)) {
        u.packSizeType = map[key];
        return u.packSizeType;
      }

      log.audit({
        title: 'RB no pack size type mapped for unit "' + (u.unit || '') + '"',
        details: 'Falling back to 1, which marks the product as a leaf. Add the ' +
          'unit to the Pack Size Type Map on the RapidBridge Configuration.'
      });
      u.packSizeType = '1';
      return u.packSizeType;
    };

    /**
     * Pack size type 1 is the base unit, and only the base unit is a leaf.
     *
     * TrackTraceRX: a leaf product is one that inventory is handled in. A pack
     * made up of a child product must be false, so that a pick can be taken
     * against the child for the pack's quantity.
     */
    const isLeafRow = (u, cfg) => String(packSizeTypeOf(u, cfg)) === '1';

    /**
     * The composition of a pack: which child product it is made of, and how
     * many of them.
     *
     * The child is the item's base-unit row — the one whose pack size type is
     * 1 — and the quantity is this row's Quantity in Lowest Unit. A leaf row
     * composes nothing.
     *
     * @returns {{json:string, waitingFor:Object|null}} `json` is the encoded
     *   composition, empty when there is none to send. `waitingFor` names the
     *   base row when one exists but has not been accepted by the Middleware
     *   yet, which is the signal to hold this row back rather than publish a
     *   pack with no contents.
     */
    const compositionOf = (unit, cfg) => {
      const u = unit.uom || {};
      if (isLeafRow(u, cfg)) return { json: '', waitingFor: null };

      const siblings = unit.uomRows || [];
      const bases = [];
      for (let i = 0; i < siblings.length; i++) {
        if (String(siblings[i].id) === String(u.id)) continue;
        if (isLeafRow(siblings[i], cfg)) bases.push(siblings[i]);
      }
      const base = bases.length ? bases[0] : null;

      if (bases.length > 1) {
        // Two units mapped to pack size type 1 on the same item. The rows are
        // in internal-id order, so the choice is stable, but it is a guess and
        // only one of them can be the product this pack is composed of.
        log.audit({
          title: 'RB more than one base unit row on item ' + unit.itemId,
          details: {
            chose: base.id, units: bases.map((r) => r.unit),
            note: 'Map exactly one Saleable Unit to pack size type 1.'
          }
        });
      }

      if (!base) {
        // Nothing to compose from. Not an error: an item may legitimately be
        // sold only by the case, and the pack still has to reach TrackTrace.
        log.audit({
          title: 'RB no base unit row for pack ' + unit.recordId,
          details: 'No active UOM Detail row maps to pack size type 1, so the ' +
            'composition is sent empty.'
        });
        return { json: '', waitingFor: null };
      }

      if (util.blank(base.uuid)) return { json: '', waitingFor: base };

      // The reference encoding: an array holding one object whose key is the
      // child product UUID and whose value is the quantity.
      const entry = {};
      entry[String(base.uuid)] = util.blank(u.qty) ? '' : String(u.qty);
      return { json: JSON.stringify([entry]), waitingFor: null };
    };

    const buildProduct = (unit, cfg, entry) => {
      const f = entry.fields;
      const d = unit.data;
      const u = unit.uom;
      const inactive = util.truthy(d.isinactive);
      // Leaf-ness follows the PACK SIZE TYPE, not the quantity. TrackTraceRX
      // defines a leaf product as one inventory is handled in; a pack made of a
      // child product must be false so a pick can be taken against the child.
      const packSizeType = packSizeTypeOf(u, cfg);
      const isLeaf = isLeafRow(u, cfg);
      const composition = compositionOf(unit, cfg);

      // The FULL reference product key set. One product per active UOM Detail
      // row; the identity half comes from the row, the shared half from the item.
      const payload = {
        custom_uuid: txt(unit.storedUuid),
        // `type` is immutable after create, but the key is still sent on every
        // call so the body keeps its shape.
        type: txt(cfg.productClassText || cfg.productClass) || 'Pharmaceutical',

        gs1_company_prefix: txt(u.gs1Prefix),
        gs1_id: txt(u.gs1Id),
        upc: txt(u.upc) || txt(d.upccode),
        // The reference build puts the NDC in `sku`. The item id is the SKU a
        // NetSuite user recognises, so it is sent here instead; the NDC travels
        // in product_identifiers where it belongs. CONFIRM with TrackTraceRX
        // before go-live if they key on sku.
        sku: txt(d.itemid),
        type_class: '',
        category_id: '',
        status: inactive ? 'RETIRED' : 'AVAILABLE',
        manufacturer_id: '',
        manufacturer_default_address_uuid: '',
        is_active: !inactive,

        update_product_descriptions: true,
        product_descriptions: [{
          language_code: txt(cfg.language) || 'en',
          name: txt(d.displayname) || txt(d.itemid),
          description: txt(d.purchasedescription) || txt(d.displayname) || txt(d.itemid),
          composition: '',
          product_long_name: txt(d.purchasedescription)
        }],

        // Always present, even when the row has no NDC — the reference build
        // sends the block with an empty value rather than dropping it.
        update_product_identifiers: !util.blank(u.ndc),
        product_identifiers: [{ identifier_code: 'US_NDC', value: txt(u.ndc) }],

        pack_size: txt(u.packSize),
        // The reference build resolved this from a hardcoded map of NetSuite
        // unit internal ids, which cannot survive a second account. It is read
        // from the Pack Size Type Map on the configuration instead, keyed on
        // the Saleable Unit's display text.
        pack_size_type_id: txt(packSizeType),

        update_requirements: false,
        update_packaging: false,

        class_pharmaceutical__strength: txt(d[f.strength]),
        class_pharmaceutical__dosage_form: txt(unit.dosageCode),
        class_pharmaceutical__generic_name: txt(d[f.generic]),

        is_leaf_product: isLeaf,
        is_override_products_packaging_type_validation: false,
        gtin14: txt(u.gtin),

        // What this pack is made of: the UUID of the item's base-unit product
        // and how many of them this row holds. Empty on a leaf row and on a
        // pack whose item has no base-unit row.
        //
        // The gate is not decoration. TrackTraceRX: setting
        // update_composition true with an empty composition REMOVES the whole
        // composition from the product, so it is true only when there is
        // something to send.
        update_composition: !util.blank(composition.json),
        // A JSON-ENCODED STRING, as the reference build sends it — not an
        // object. Keep it that way: txt() collapses an array to '' rather than
        // encoding it, so returning an array from compositionOf would empty
        // this key silently.
        composition: txt(composition.json)
      };

      // NEW keys. Bin state is only claimed when the account feature, the
      // configuration flag and the item checkbox all agree; the feature state is
      // reported separately so the Middleware can tell "not bin managed" from
      // "bins not available".
      Object.assign(payload, binState(d, cfg));

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
     *
     * Every value comes straight off the NetSuite address subrecord. Nothing is
     * looked up or translated: the state goes out as the record spells it, the
     * same way the reference build sends it.
     */
    const buildAddress = (addr, cfg, parentName) => {
      // The FULL reference address key set. Every key always present.
      const body = {
        address_nickname: txt(addr.nickname) || 'Main Address',
        // NEW key on the NetSuite side: there is no address-level GS1 Id field
        // yet, so it is sent empty. Add a custom field on the Address subrecord
        // if TrackTraceRX requires a value.
        address_gs1_id: '',
        gs1_sgln: txt(addr.sgln),
        recipient_name: txt(addr.addressee) || txt(parentName),
        line1: txt(addr.addr1),
        line2: txt(addr.addr2),
        country_code: txt(addr.country),
        // Free text, exactly as held on the address. The Middleware state-list
        // lookup that used to turn this into a state_id has been removed: it
        // cost a call per country, and an unmatched state produced an empty id
        // that told the Middleware less than the spelling does.
        state: txt(addr.state),
        city: txt(addr.city),
        zip: txt(addr.zip),
        phone: txt(addr.phone),
        is_licence_required: false
      };

      // No state_id. The reference address contract does not carry one, and the
      // key set above is now exactly the reference set.
      // // NEW key. The Middleware's own state list resolved from the country, so
      // // a state is identified rather than spelled. Sent empty when the country
      // // or the state cannot be matched — never guessed, never omitted.
      // const stateId = resolveStateId(addr.country, addr.state, cfg);
      // body.state_id = (stateId === null || stateId === undefined) ? '' : stateId;

      return body;
    };

    /** The address fields that belong in the parent's comparison. */

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
      if (entry.key === 'UOM') return runUomRow(recordId, cfg, trigger, correlation, o.newRecord);

      if (entry.implemented === false || !builders[entry.builder]) {
        const msg = 'No builder for "' + entry.builder + '". ' + entry.key +
          ' is declared in the dispatch table but not implemented in ' +
          'this phase. Remove the deployment or add the builder.';
        const u = resolveUnits(entry, recordId, recordType, cfg, o);
        if (u.list.length) logIo.stampTry(u.list[0], C.TRY.FAIL_PRE_API, null, msg);
        logIo.exception(entry, { type: recordType, id: recordId }, new Error(msg));
        return [{ ok: false, notImplemented: true }];
      }

      // §8.1 — eligibility, the first gate. An ineligible item is not an error.
      if (entry.requiresEligibility && !isEligible(entry, recordId, recordType, cfg)) {
        logIo.stampTry(itemStampUnit(entry, recordId, recordType),
          C.TRY.SKIP_INELIGIBLE, null, '');
        // The save may have come from a UOM Detail row. Its item is what was
        // judged ineligible, so say so ON THE ROW as well — otherwise the row
        // the user just saved shows nothing at all.
        if (o.onlyUomRowId)
          logIo.stampTry(uomStampUnit(o.onlyUomRowId), C.TRY.SKIP_INELIGIBLE, null,
            'The parent item is not marked eligible for RapidBridge, so none of ' +
            'its UOM Detail rows is published.');
        return [{ skipped: true, reason: 'not eligible' }];
      }

      const units = resolveUnits(entry, recordId, recordType, cfg, o);

      if (units.blocked) {
        // A blocked item still gets a work item, so it lands on the
        // reconciliation page instead of vanishing.
        const stampUnit = units.stampUomRowId
          ? uomStampUnit(units.stampUomRowId)
          : (entry.key === 'ITEM'
            ? itemStampUnit(entry, recordId, recordType) : null);
        if (units.blockedTry && stampUnit) {
          logIo.openDeferred({
            entry: entry, unit: stampUnit, cfg: cfg,
            reason: units.reason || C.REASON.NO_UOM,
            status: C.STATUS.OPEN_REVIEW,          // a person must fix this
            outcome: C.OUTCOME.SKIPPED,            // no call was made
            trigger: trigger, note: units.blocked,
            correlation: correlation
          });
          logIo.stampTry(stampUnit, units.blockedTry, null, units.blocked);
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
          // A gate that needs a person says so ON THE RECORD. A routine skip
          // clears any error left over from an earlier evaluation.
          logIo.stampTry(unit, gate.tryResult, null,
            gate.needsHuman ? (gate.note || gate.reason) : '');
          results.push({ skipped: true, reason: gate.reason });
          return;
        }

        // ── step 1b: ADDRESSES FIRST when the parent is already known to the
        //    Middleware.
        //
        //    The trading-partner payload names its default billing and shipping
        //    addresses BY ADDRESS UUID, so the parent payload depends on the
        //    addresses, not the other way round. Building the parent first
        //    costs two calls for one edit: the first goes out with the default
        //    still empty because the new address has no UUID yet, the address
        //    pass then creates it, and the UUID that comes back changes the
        //    parent payload a second time.
        //
        //    Sending the addresses first collapses that into one call — by the
        //    time the parent payload is built, every address that could appear
        //    in it already has its identifier.
        //
        //    A parent with no UUID cannot do this: an address is created UNDER
        //    its parent, so the parent has to exist remotely first. That case
        //    keeps the old order and pays for the follow-up update in
        //    refreshPartnerDefaults.
        //
        //    BEFORE the parent-hierarchy block below, deliberately. An address
        //    belongs to THIS record and does not name the record's own parent,
        //    so a sub-customer whose parent has not synced yet must still be
        //    able to push its address changes. Blocking those too would strand
        //    them until someone syncs an unrelated record.
        if (entry.hasChildren && cfg.useAddress && !util.blank(unit.storedUuid)
          && !willRemoveRemotely(unit, cfg)) {
          let addressesWritten = false;
          try {
            addressesWritten = maybeSyncAddresses(entry, unit, cfg, correlation, trigger, unit.storedUuid, false);
          } catch (e) {
            // The address pass now runs BEFORE the parent call, so anything
            // escaping it would stop the parent syncing at all — a regression
            // on the old order, where the parent went first. The addresses log
            // their own failures; this is the last net under them.
            log.error('Error @ address pre-pass ' + unit.recordType + '/' + unit.recordId, e);
            logIo.exception(entry, { type: unit.recordType, id: unit.recordId }, e);
          }

          // Writing a UUID back onto an address line saves the parent, which
          // re-fires the User Event; that nested run may have sent the parent
          // update already. Re-read what the record holds NOW, so the
          // comparison below is against the Middleware's latest state and not
          // against values read before the address pass. Only when something
          // was written — otherwise nothing can have moved.
          if (addressesWritten) refreshStoredState(entry, unit);
        }

        // A hierarchical record must not name a parent the Middleware has
        // never seen. Location names its parent location; a sub-customer or
        // sub-vendor names its parent trading partner.
        if (entry.parentField) {
          const parentId = textOf(unit.data[entry.parentField]);
          if (parentId && String(parentId) !== String(unit.recordId)) {
            const pu = ensureParentRecord(entry, unit.recordType, parentId, cfg, correlation);
            if (!pu) {
              const what = entry.key === 'LOCATION' ? 'location' : 'trading partner';
              logIo.openDeferred({
                entry: entry, unit: unit, cfg: cfg,
                reason: C.REASON.MISSING_PARENT,
                status: C.STATUS.OPEN_PENDING,     // resolves once the parent syncs
                outcome: C.OUTCOME.SKIPPED,
                trigger: trigger,
                note: 'Parent ' + what + ' ' + parentId + ' has no Middleware UUID yet.',
                correlation: correlation
              });
              logIo.stampTry(unit, C.TRY.BLOCK_NO_PARENT, null,
                'The parent ' + what + ' (' + parentId + ') has no Middleware ' +
                'UUID yet, so this record cannot name its parent. Sync the ' +
                'parent first.');
              results.push({ ok: false, blocked: 'parent not synced' });
              return;
            }
            unit.parentUuid = pu;
          }
        }

        const payload = builders[entry.builder](unit, cfg, entry);    // step 2
        // step 3. The COMPARISON string leaves custom_uuid out: it is empty on
        // the create and holds the TrackTrace UUID afterwards, so including it
        // would make writing that UUID back look like an edit and fire a
        // pointless update on the very next save. The SENT body still carries
        // it — see sendBody below.
        const payloadStr = util.canonicalCompare(payload);
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
          logIo.stampTry(unit, C.TRY.NO_CHANGE, null, '');
          results.push({ skipped: true, noChange: true });
          maybeSyncAddresses(entry, unit, cfg, correlation, trigger, null, true);
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
          mirrorUomRow(unit, { uuid: prior.uuid });
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

        // A create that the Middleware ACCEPTED but answered without a UUID
        // leaves the record with no identifier. The next changed save would
        // resolve to CREATE again and make a second copy remotely. Refuse it
        // and put a person on it instead.
        if (prior && !prior.uuid && !unit.storedUuid && !util.blank(prior.logId)) {
          logIo.openDeferred({
            entry: entry, unit: unit, cfg: cfg,
            reason: C.REASON.AWAITING_DECISION,
            status: C.STATUS.OPEN_REVIEW, outcome: C.OUTCOME.SKIPPED,
            trigger: trigger, payload: payloadStr,
            note: 'This record was already created in the Middleware (Sync Log ' +
              prior.logId + ') but the response carried no UUID, so NetSuite ' +
              'cannot address it. Sending again would create a duplicate.',
            correlation: correlation
          });
          logIo.stampTry(unit, C.TRY.FAIL_PRE_API, null,
            'Created in the Middleware but no UUID was returned, so this record ' +
            'cannot be updated. Enter the UUID from TrackTraceRX in the ' +
            'RapidBridge External UUID field, then save again.');
          results.push({ ok: false, blocked: 'created without a UUID' });
          return;
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
          maybeSyncAddresses(entry, unit, cfg, correlation, trigger, null, true);
          return;
        }

        // A pack cannot be published before the product it is made of. Its
        // composition names the base-unit product BY UUID, and sending the
        // pack without it would create it in the Middleware with no contents
        // and nothing to say so. The base row is synced first (the rows are
        // ordered that way), so this only bites when the base row itself could
        // not be accepted.
        if (entry.key === 'ITEM') {
          const comp = compositionOf(unit, cfg);
          if (comp.waitingFor) {
            logIo.openDeferred({
              entry: entry, unit: unit, cfg: cfg,
              reason: C.REASON.MISSING_PARENT,
              status: C.STATUS.OPEN_PENDING,   // resolves once the base row syncs
              outcome: C.OUTCOME.SKIPPED,
              trigger: trigger,
              note: 'Base unit row ' + comp.waitingFor.id + ' (' +
                (comp.waitingFor.unit || 'base unit') + ') has no Middleware ' +
                'UUID yet, so this pack cannot state its composition.',
              correlation: correlation
            });
            logIo.stampTry(unit, C.TRY.BLOCK_NO_PARENT, null,
              'This row is a pack of the ' + (comp.waitingFor.unit || 'base unit') +
              ' row (' + comp.waitingFor.id + '), which has not been accepted by ' +
              'the Middleware yet. Sync that row first.');
            results.push({ ok: false, blocked: 'base unit not synced' });
            return;
          }
        }

        const operation = operationFor(unit, payload);

        // Inactivate Method = DELETE: express the inactivation as a remote
        // delete instead of an update. Falls back to the update when this sync
        // type has no delete endpoint, rather than silently doing nothing.
        if (operation === C.OPERATION.INACTIVATE && deleteOnInactivate(cfg)) {
          if (entry.endpoints && entry.endpoints.remove) {
            results.push(inactivateByDelete(entry, unit, cfg, trigger, correlation));
            return;
          }
          log.audit({
            title: 'RB Inactivate Method is DELETE but ' + entry.key +
              ' has no delete endpoint',
            details: {
              recordType: unit.recordType, recordId: unit.recordId,
              fallingBackTo: 'PUT is_active:false'
            }
          });
        }

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

        if (res.ok) {
          const finalUuid = res.uuid || unit.storedUuid || '';
          log.debug("Call For Write Back Success", { details: { uuid: finalUuid } });   // step 7

          // The payload IS stored even here, so the next save does not fire the
          // API again for the same unchanged record — the false re-trigger this
          // whole change is about. What is not done is calling it finished.
          writeBackSuccess(entry, unit, finalUuid, payloadStr, cfg);

          if (util.blank(finalUuid)) {
            // Accepted, but we have no way to name the object again. Every
            // later UPDATE is impossible and every later CREATE is a duplicate.
            logIo.closeNeedsReview(target, res,
              'The record was accepted but the response carried no UUID, so ' +
              'nothing could be written back and this record cannot be updated.',
              'Read the object UUID from TrackTraceRX and enter it in the ' +
              'RapidBridge External UUID field on this record. Until then no ' +
              'update can be sent for it.');
            logIo.stampTry(unit, C.TRY.SYNCED, null,
              'Accepted by the Middleware, but no UUID was returned. Enter it ' +
              'by hand before this record is edited again.');
            results.push({ ok: true, uuid: '', noUuid: true });
            return;
          }

          logIo.closeSuccess(target, res);
          results.push({ ok: true, uuid: finalUuid });

          maybeSyncAddresses(entry, unit, cfg, correlation, trigger,
            res.uuid || unit.storedUuid, true);

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

          // Dry run has to show EVERY call the save would have made, not only
          // the parent's; the environment gate is treated the same way.
          //
          // Usually a no-op now, because a record that HAS a UUID ran its
          // address pass before the parent payload was built and the
          // once-per-unit guard stops it running twice. It stays because that
          // pre-pass has conditions of its own: lose any of them and this is
          // the only thing that still shows the addresses in a dry run.
          maybeSyncAddresses(entry, unit, cfg, correlation, trigger, null, true);

        } else if (res.skipped) {
          // Kill switch. The change is real and STILL UNSENT, so the work item
          // stays open on purpose — but parked, not "retrying".
          logIo.parkUnsent(target, res, cfg, C.REASON.AWAITING_DECISION,
            res.errorMessage || 'Kill switch is on; no call was made.');
          logIo.stampTry(unit, C.TRY.FAIL_PRE_API, null,
            res.errorMessage || 'Kill switch is on; no call was made.');
          results.push({ ok: false, skipped: true });

          // Same reasoning as the dry-run branch above, and the same caveat:
          // normally the pre-pass has already run and this is a no-op.
          maybeSyncAddresses(entry, unit, cfg, correlation, trigger, null, true);

        } else {
          writeBackFailure(entry, unit, res.errorMessage);
          logIo.closeFailure(target, res, cfg);
          results.push({ ok: false, error: res.errorMessage });
        }
      });

      if (entry.key === 'ITEM')
        rollUpItem(entry, recordId, recordType, results, !!o.onlyUomRowId);  // step 8

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
    const runUomRow = (uomRowId, cfg, trigger, correlation, newRecord) => {
      const U = C.MASTER.customrecord_jj_rb_uom_detail.fields;
      let itemId = null;
      try {
        const v = search.lookupFields({ type: C.REC.UOM, id: uomRowId, columns: [U.item] });
        itemId = textOf(v[U.item]);
      } catch (e) {
        log.debug("Error @ runUomRow lookupFields: ", e);
        /* fall through to the record itself */
      }

      // The row that was just saved is in hand. Read the item off it rather
      // than deciding there is no parent because one search would not answer.
      if (!itemId && newRecord) {
        try { itemId = textOf(newRecord.getValue({ fieldId: U.item })); }
        catch (e) { log.debug("Error @ runUomRow newRecord read: ", e); }
      }

      if (!itemId) {
        logIo.exception(C.MASTER.customrecord_jj_rb_uom_detail,
          { type: C.REC.UOM, id: uomRowId },
          new Error('UOM Detail row has no parent item — nothing to sync.'));
        return [{ ok: false, blocked: 'no parent item' }];
      }

      const itemType = itemTypeOf(itemId);
      if (!itemType) {
        // Silence here is what made a UOM Detail save look like it did nothing:
        // no call, no Sync Log row, no stamp on the record, nothing in the
        // execution log. It is a condition a person has to look at.
        const msg = 'The parent item (' + itemId + ') of this UOM Detail row is ' +
          'not one of the item types this SuiteApp synchronizes, or its type ' +
          'could not be read. No product can be published for the row.';
        logIo.exception(C.MASTER.customrecord_jj_rb_uom_detail,
          { type: C.REC.UOM, id: uomRowId }, new Error(msg));
        try {
          logIo.stampTry({
            recordType: C.REC.UOM, recordId: uomRowId, uomId: uomRowId,
            lastTryField: U.lastTry, tryResultField: U.tryResult, errorField: U.error
          }, C.TRY.FAIL_PRE_API, null, msg);
        } catch (e) { /* the exception above is the record that matters */ }
        return [{ ok: false, blocked: 'parent item type unresolved' }];
      }

      log.debug({
        title: 'RB UOM Detail row delegating to its item',
        details: { uomRowId: uomRowId, itemId: itemId, itemType: itemType }
      });

      return run({
        entry: C.MASTER[itemType], recordId: itemId, recordType: itemType,
        cfg: cfg, trigger: trigger, correlation: correlation,
        onlyUomRowId: uomRowId
      });
    };

    /**
     * Which of the five item record types is this? The dispatch entry needs it.
     *
     * Three ways of asking, cheapest first, because an account that will not
     * answer the first two must not take the whole UOM Detail sync down with
     * it — that failure was silent, and a row saved on its own looked as though
     * nothing had happened at all.
     */
    const itemTypeOf = (itemId) => {
      const known = (t) => {
        const k = String(t || '').toLowerCase();
        return (k && C.MASTER[k] && C.MASTER[k].key === 'ITEM') ? k : null;
      };

      // 1. The direct read. `recordtype` is a field on the generic item type,
      //    and this is the cheapest way to ask which of the five it is.
      try {
        const v = search.lookupFields({
          type: 'item', id: itemId, columns: ['recordtype']
        });
        const hit = known(textOf(v.recordtype));
        if (hit) return hit;
        log.debug({
          title: 'RB itemTypeOf lookupFields',
          details: { itemId: itemId, recordtype: textOf(v.recordtype) || null }
        });
      } catch (e) {
        log.debug({ title: 'RB itemTypeOf lookupFields failed', details: (e && e.message) || String(e) });
      }

      // 2. The same question as a search. Some accounts refuse `recordtype` as
      //    a search COLUMN on item even though the field reads fine above, and
      //    that refusal used to take the whole UOM Detail sync down with it.
      try {
        let t = null;
        search.create({
          type: 'item',
          filters: [['internalid', 'anyof', itemId]],
          columns: ['recordtype']
        }).run().each((r) => { t = r.getValue('recordtype'); return false; });
        const hit = known(t);
        if (hit) return hit;
      } catch (e) {
        log.debug({ title: 'RB itemTypeOf search failed', details: (e && e.message) || String(e) });
      }

      // 3. Ask each item type in turn. Five cheap lookups, and only ever
      //    reached when the two calls above could not answer — but it means a
      //    UOM Detail row still synchronizes instead of failing silently.
      const types = Object.keys(C.MASTER).filter((k) => C.MASTER[k].key === 'ITEM');
      for (let i = 0; i < types.length; i++) {
        try {
          search.lookupFields({ type: types[i], id: itemId, columns: ['itemid'] });
          log.audit({
            title: 'RB item type resolved by probe',
            details: { itemId: itemId, type: types[i] }
          });
          return types[i];
        } catch (e) { /* not this type */ }
      }

      return null;
    };

    /** §8.1 — only regulated items sync. Read from the CONFIGURED field id. */
    const isEligible = (entry, recordId, recordType, cfg) => {
      const fieldId = cfg.eligField || entry.fields.eligible;
      if (!fieldId) return true;
      let raw;
      try {
        const v = search.lookupFields({ type: recordType, id: recordId, columns: [fieldId] });
        raw = labelOf(v[fieldId]) || textOf(v[fieldId]);
      } catch (e) {
        // NOT the same as the field saying no. The configured Eligibility Field
        // is free text, so a typo, a field the account never deployed, or one
        // that is not valid on this item type all land here — and used to make
        // every item silently ineligible with nothing written anywhere.
        log.error({
          title: 'RB eligibility field could not be read: ' + fieldId,
          details: {
            recordType: recordType, recordId: recordId,
            error: (e && e.message) || String(e),
            note: 'Treated as not eligible. Check the Eligibility Field setting ' +
              'on the RapidBridge Configuration.'
          }
        });
        return false;
      }

      const s = String(raw).toUpperCase();
      if (s === 'TRUE' || s === 'T' || s === 'YES') return true;
      if (s === 'FALSE' || s === 'F' || s === 'NO') return false;
      // AUTO has no agreed rule yet — §18 question 3. Refuse rather than guess.
      return false;
    };

    /** A stamp-only unit for the ITEM record itself (it has no uuid of its own). */
    /**
     * A stamp target for the UOM Detail ROW rather than its item.
     *
     * A row saved on its own delegates to its parent item, and every gate from
     * that point on names the item. Stamping only the item leaves the row the
     * user is looking at completely untouched, which reads as "the save did
     * nothing" — so any gate that can end a single-row run stamps the row too.
     */
    const uomStampUnit = (uomRowId) => {
      const U = C.MASTER.customrecord_jj_rb_uom_detail.fields;
      return Object.assign({
        recordType: C.REC.UOM, recordId: uomRowId, uomId: uomRowId, data: {}
      }, unitFields(U));
    };

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
      // Inactivate Method = DELETE, record inactive, no UUID: the remote
      // object was deliberately deleted by that policy. Creating it again on
      // the next save would undo the inactivation every time the record is
      // touched. This has to be checked BEFORE sync_inactive, because it
      // applies whichever way that flag is set.
      if (util.truthy(unit.data.isinactive) && !unit.storedUuid && deleteOnInactivate(cfg))
        return {
          tryResult: C.TRY.SKIP_INELIGIBLE,
          reason: 'inactive; the remote object was deleted by Inactivate Method policy'
        };

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

    /**
     * §18 q2 — `Inactivate Method` on the configuration decides HOW an
     * inactivation reaches the Middleware. It is a TEXT field:
     *
     *   PUT_IS_ACTIVE_FALSE (default) — the ordinary update carries
     *     is_active:false. The remote object survives and keeps its UUID, so a
     *     later reactivation is another update.
     *
     *   DELETE — the remote object is REMOVED. The UUID must then be cleared
     *     locally, or a later reactivation would PUT to a UUID that no longer
     *     exists and take a 404 for ever.
     *
     * It governs the is_active flip ONLY. A real NetSuite record delete always
     * means a remote delete, whatever this is set to (see handleDelete).
     */
    const deleteOnInactivate = (cfg) =>
      String((cfg && cfg.inactiveMethod) || '').toUpperCase().indexOf('DELETE') !== -1;

    /**
     * True when this save is going to remove the record from the Middleware
     * rather than update it — an inactivation under `Inactivate Method =
     * DELETE`.
     *
     * Checked before the address pre-pass: pushing addresses onto a parent that
     * is about to be deleted spends calls on children that vanish with it.
     */
    const willRemoveRemotely = (unit, cfg) =>
      util.truthy(unit.data && unit.data.isinactive) && deleteOnInactivate(cfg);

    /**
     * Inactivation expressed as a remote DELETE.
     *
     * On success the record forgets its remote identity: UUID and stored
     * payload are cleared and synced goes false, because the Middleware no
     * longer holds this record at all. `synced = true` would claim the
     * Middleware has its current payload, and it has nothing.
     *
     * The consequence is deliberate: reactivating the record later finds no
     * UUID, so operationFor returns CREATE and it is pushed as a new object.
     * That is the only correct outcome once the old one has been deleted.
     */
    const inactivateByDelete = (entry, unit, cfg, trigger, correlation) => {
      const target = logIo.resolveLogTarget({
        entry: entry, unit: unit, operation: C.OPERATION.DELETE,
        payload: '', cfg: cfg, reason: reasonFor(unit), correlation: correlation
      });

      const res = client.call({
        entry: entry, unit: unit, cfg: cfg, target: target,
        endpoint: entry.endpoints.remove, pathParams: { uuid: unit.storedUuid },
        body: null, operation: C.OPERATION.DELETE, payload: '',
        trigger: trigger, correlation: correlation, requestUuid: correlation
      });

      log.debug({
        title: 'RB inactivate by DELETE ' + unit.recordType + '/' + unit.recordId,
        details: {
          uuid: unit.storedUuid, ok: res.ok, httpStatus: res.httpStatus,
          suppressed: res.suppressed, dryRun: res.dryRun, skipped: res.skipped
        }
      });

      if (res.ok || res.httpStatus === 404) {
        clearRemoteIdentity(entry, unit);
        logIo.closeSuccess(target, res);
        return { ok: true, inactivatedByDelete: true };
      }
      if (res.suppressed || res.dryRun) {
        logIo.closeNoAction(target, res,
          res.suppressed
            ? 'Environment gate: ' + (res.errorMessage || 'call suppressed') + '.'
            : 'Dry-run mode is on; the inactivation delete was not sent.');
        logIo.stampTry(unit, res.suppressed ? C.TRY.SUPPRESSED_ENV : C.TRY.DRY_RUN);
        return { ok: false, suppressed: true };
      }
      if (res.skipped) {
        logIo.parkUnsent(target, res, cfg, C.REASON.AWAITING_DECISION,
          res.errorMessage || 'Kill switch is on; the inactivation delete was not sent.');
        logIo.stampTry(unit, C.TRY.FAIL_PRE_API, null,
          res.errorMessage || 'Kill switch is on; no call was made.');
        return { ok: false, skipped: true };
      }
      writeBackFailure(entry, unit, res.errorMessage);
      // The record still exists here, so a retry COULD run — but retrying a
      // delete that the Middleware refused usually means the object is in a
      // state only TrackTrace can resolve. Put it in front of a person.
      logIo.closeNeedsReview(target, res,
        'Inactivate Method is DELETE and the Middleware refused the delete: ' +
        (res.errorMessage || 'no message') + '. The NetSuite record is ' +
        'inactive; the remote object is not.',
        'Confirm with TrackTrace whether ' + unit.storedUuid + ' can be ' +
        'deleted. If it cannot, switch Inactivate Method to ' +
        'PUT_IS_ACTIVE_FALSE and re-save the record.');
      return { ok: false, error: res.errorMessage };
    };

    /**
     * The Middleware no longer holds this record. Forget the remote identity so
     * nothing ever PUTs to a dead UUID again.
     */
    const clearRemoteIdentity = (entry, unit) => {
      const values = {};
      if (unit.uuidField) values[unit.uuidField] = '';
      if (unit.payloadField) values[unit.payloadField] = '';
      if (unit.syncedField) values[unit.syncedField] = false;
      if (unit.errorField) values[unit.errorField] = '';
      if (unit.lastSyncField) values[unit.lastSyncField] = new Date();
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
        mirrorUomRow(unit, {
          uuid: unit.storedUuid, payload: payloadStr, synced: true
        });
      } catch (e) {
        logIo.exception(entry, { type: unit.recordType, id: unit.recordId }, e);
      }
    };

    const syncLocationStorageArea = (entry, unit, cfg, locationUuid) => {
      const fieldId = C.MASTER.location.fields.storageAreaUuid;

      // The guard is restored. It must agree with the payload: the default
      // storage area is only requested when the account is NOT on Bin
      // Management, so there is nothing to read back when it is. Reading and
      // saving one anyway would point the Location at a storage area that
      // competes with its real bins.
      if (!fieldId || !cfg || cfg.useBins === true) return;
      if (util.blank(locationUuid)) return;

      log.debug({
        title: 'RB storage area lookup ' + unit.recordType + '/' + unit.recordId,
        details: { locationUuid: locationUuid }
      });

      try {
        // The real call. The test stub that returned TEST-STORAGE-AREA-UUID-001
        // has been removed — it wrote a fake identifier onto live records.
        const storageAreaCall = client.call({
          entry: entry,
          unit: unit,
          cfg: cfg,
          target: { mode: 'MAIN' },
          endpoint: C.EP.STORAGE_AREAS,
          pathParams: { uuid: locationUuid },
          body: undefined,
          operation: C.OPERATION.QUERY,
          payload: '',
          trigger: C.TRIGGER.INITIAL,
          correlation: util.uuid(),
          requestUuid: util.uuid()
        });

        if (!storageAreaCall || !storageAreaCall.ok) {
          // Not fatal to the Location sync, which already succeeded. Record it
          // and move on rather than failing a work item that is closed.
          log.audit({
            title: 'RB storage area lookup did not return a result',
            details: {
              recordId: unit.recordId, locationUuid: locationUuid,
              httpStatus: storageAreaCall && storageAreaCall.httpStatus,
              error: storageAreaCall && storageAreaCall.errorMessage
            }
          });
          return;
        }

        const body = storageAreaCall.body || {};
        const rows = Array.isArray(body) ? body
          : (Array.isArray(body.data) ? body.data
            : (Array.isArray(body.storage_areas) ? body.storage_areas : []));

        const first = rows.length ? rows[0] : null;
        const storageAreaUuid = first
          ? (first.uuid || first.id || first.storage_area_uuid || null) : null;

        log.debug({
          title: 'RB storage area resolved',
          details: { returned: rows.length, storageAreaUuid: storageAreaUuid }
        });

        if (!storageAreaUuid) return;

        record.submitFields({
          type: unit.recordType,
          id: unit.recordId,
          values: { [fieldId]: storageAreaUuid },
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) {
        logIo.exception(entry, { type: unit.recordType, id: unit.recordId }, e);
      }
    };

    /**
     * Carry a UOM row's new identity onto the row object its siblings share.
     *
     * Every unit of one item holds the SAME array of row objects
     * (unit.uomRows), and a pack row reads its base sibling's UUID out of it to
     * state its composition. Whenever a row's identity moves — accepted by the
     * Middleware, adopted back from the Sync Log, healed from it — the shared
     * copy has to move with it, or the pack rows evaluated later in the same
     * execution will read a blank UUID and be held back for a base row that is
     * perfectly synchronized.
     */
    const mirrorUomRow = (unit, values) => {
      if (!unit || !unit.uomId || !Array.isArray(unit.uomRows)) return;
      for (let i = 0; i < unit.uomRows.length; i++) {
        if (String(unit.uomRows[i].id) !== String(unit.uomId)) continue;
        if (!util.blank(values.uuid)) unit.uomRows[i].uuid = values.uuid;
        if (values.payload !== undefined) unit.uomRows[i].payload = values.payload;
        if (values.synced !== undefined) unit.uomRows[i].synced = values.synced;
        return;
      }
    };

    const writeBackSuccess = (entry, unit, uuid, payloadStr, cfg) => {
      log.debug("Write Back Success", { details: { uuid: uuid, payloadLength: payloadStr.length } });
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

        // Keep the in-memory unit in step with the record that was just
        // written. Anything running later in this same execution — the address
        // pass, refreshPartnerDefaults, operationFor — must compare against
        // what the Middleware has now ACCEPTED, not against the values that
        // were read before the call.
        if (uuid) unit.storedUuid = uuid;
        unit.storedPayload = payloadStr;
        unit.storedSynced = true;

        mirrorUomRow(unit, { uuid: uuid, payload: payloadStr, synced: true });

        if (entry.key === 'LOCATION' && unit.recordType === 'location' && uuid && cfg) {
          syncLocationStorageArea(entry, unit, cfg, uuid);
        }
      } catch (e) {
        log.error("Error @ writeBackSuccess: ", e);
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
    const rollUpItem = (entry, itemId, itemType, results, partial) => {
      const f = entry.fields;
      const failed = results.filter((r) => r.ok === false).length;
      const deferred = results.filter((r) => r.deferred).length;
      const sent = results.filter((r) => r.ok === true).length;
      const allOk = failed === 0 && deferred === 0 && results.length > 0;

      // NOTHING WAS EVALUATED. Not a failure — there is no outcome to report,
      // and stamping one said "Failed - API error" with an empty Last Error on
      // a save where no call was even attempted.
      if (!results.length) {
        log.audit({
          title: 'RB item roll-up skipped ' + itemType + '/' + itemId,
          details: 'No UOM Detail row was evaluated on this save.'
        });
        return;
      }

      // ONE ROW OF MANY. A UOM Detail row saved on its own says nothing about
      // its siblings, so it must not restate the whole item as synced or wipe
      // an error another row raised. A failure still has to be visible, so it
      // raises the flag and leaves the rest alone.
      if (partial) {
        const pv = {};
        if (f.lastTry) pv[f.lastTry] = new Date();
        if (!allOk) {
          if (f.attention) pv[f.attention] = true;
          if (f.error) pv[f.error] = summarise(results);
          if (f.tryResult) pv[f.tryResult] = lists.id(C.LIST.tryResult,
            deferred ? C.TRY.DEFERRED : C.TRY.FAIL_API);
        }
        try {
          record.submitFields({
            type: itemType, id: itemId, values: pv,
            options: { ignoreMandatoryFields: true }
          });
        } catch (e) {
          logIo.exception(entry, { type: itemType, id: itemId }, e);
        }
        return;
      }

      const values = {};
      if (f.synced) values[f.synced] = allOk;
      if (f.attention) values[f.attention] = !allOk;
      if (f.error) values[f.error] = allOk ? '' : summarise(results);
      // Only a row that actually reached the Middleware moves the item's Last
      // Sync. A run in which every row compared equal synchronized nothing.
      if (allOk && sent && f.lastSync) values[f.lastSync] = new Date();
      if (f.lastTry) values[f.lastTry] = new Date();
      if (f.tryResult) values[f.tryResult] = lists.id(C.LIST.tryResult,
        allOk ? (sent ? C.TRY.SYNCED : C.TRY.NO_CHANGE)
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
      if (!results.length) return '';
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

    /**
     * The Middleware UUID of a parent record, synchronizing it first if it does
     * not have one yet.
     *
     * Used by Location (its own hierarchy) and by Customer and Vendor (a
     * sub-customer or sub-vendor naming its parent trading partner). Same rule
     * in both: a child cannot name a parent the Middleware has never seen.
     *
     * The pre-sync is attempted once per parent per execution, so a cycle in
     * the data cannot produce an endless cascade.
     */
    const ensureParentRecord = (parentEntry, parentType, parentId, cfg, correlation) => {
      if (!parentEntry || !parentEntry.fields || !parentEntry.fields.uuid) return null;
      const key = parentType + '|' + parentId;

      const readUuid = () => {
        try {
          const v = search.lookupFields({
            type: parentType, id: parentId, columns: [parentEntry.fields.uuid]
          });
          return textOf(v[parentEntry.fields.uuid]) || null;
        } catch (e) { return null; }
      };

      const existing = readUuid();
      if (existing) return existing;

      if (PRESYNCED[key]) return null;      // already tried in this execution
      PRESYNCED[key] = true;

      log.audit({
        title: 'RB pre-syncing parent ' + parentType + '/' + parentId,
        details: 'the child cannot be sent until the parent holds a UUID'
      });

      run({
        entry: parentEntry, recordId: parentId, recordType: parentType, cfg: cfg,
        trigger: C.TRIGGER.PRESYNC, correlation: correlation
      });

      return readUuid();
    };

    /** Kept for callers that name the Location case directly. */
    const ensureParentLocation = (parentId, cfg, correlation) =>
      ensureParentRecord(C.MASTER.location, 'location', parentId, cfg, correlation);

    // ═══════════════════════════════════════════════════════════════════════════
    // Addresses — §10.5
    // ═══════════════════════════════════════════════════════════════════════════

    const readSub = (sub, f) => {
      try { return sub.getValue({ fieldId: f }) || ''; } catch (e) { return ''; }
    };

    const addrFromSub = (sub, nickname, line, nsId) => {
      let subId = null;
      try { subId = sub.id || null; } catch (e) { subId = null; }

      const a = {
        nickname: nickname || 'Main Address',
        addressee: readSub(sub, 'addressee'),
        addr1: readSub(sub, 'addr1'), addr2: readSub(sub, 'addr2'),
        city: readSub(sub, 'city'), state: readSub(sub, 'state'),
        zip: readSub(sub, 'zip'), country: readSub(sub, 'country'),
        phone: readSub(sub, 'addrphone'),
        sgln: readSub(sub, C.ADDR.sgln),
        uuid: readSub(sub, C.ADDR.uuid),
        // What this address last had accepted. Without it every parent update
        // re-sent every address.
        payload: readSub(sub, C.ADDR.payload),
        // The NetSuite address id. The line index is only a position.
        // Read live from NetSuite each time. It is NetSuite's own id for this
        // address; it is recorded on the Sync Log, not copied onto the address.
        nsId: nsId || subId || '',
        line: (line === undefined ? null : line)
      };
      return (!a.addr1 && !a.city && !a.zip) ? null : a;
    };

    /** A Location carries ONE `mainaddress` subrecord, not a sublist. */
    const locationAddresses = (unit) => {
      if (unit.addresses !== undefined) return unit.addresses;
      unit.addresses = [];
      try {
        const rec = unit.sourceRecord || record.load({
          type: 'location',
          id: unit.recordId,
          isDynamic: false
        });
        unit.sourceRecord = rec;
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
          let nsId = '';
          try {
            nsId = rec.getSublistValue({
              sublistId: 'addressbook', fieldId: 'internalid', line: i
            }) || '';
          } catch (e) { /* not exposed on this record type */ }

          const a = addrFromSub(sub, label || ('Address ' + (i + 1)), i, nsId);
          if (a) {
            // Which line is the default billing and which the default shipping.
            // The Middleware names them by ADDRESS UUID, so the flags are read
            // here and resolved to UUIDs once the addresses have been synced.
            try {
              a.defaultBilling = util.truthy(rec.getSublistValue({
                sublistId: 'addressbook', fieldId: 'defaultbilling', line: i
              }));
              a.defaultShipping = util.truthy(rec.getSublistValue({
                sublistId: 'addressbook', fieldId: 'defaultshipping', line: i
              }));
            } catch (e) { /* not on this record type */ }
            unit.addresses.push(a);
          }
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
    /**
     * Addresses are evaluated on EVERY save of the parent, whether or not the
     * parent itself had anything to send.
     *
     * The parent's own comparison no longer carries the address set, so a save
     * that changes only an address is a no-change for the parent — and if the
     * address pass only ran after a successful parent call, that address would
     * never be sent at all.
     */
    /**
     * Delete remotely the addresses that no longer exist in NetSuite.
     *
     * Every address the Middleware has accepted is listed in the Sync Log under
     * this parent, keyed by the NetSuite address id. Any of those ids that is
     * not among the lines present now has been removed from the address book,
     * and its remote counterpart is an orphan that would otherwise stay on a
     * trading partner for ever.
     *
     * A 404 counts as done — already gone is the outcome that was asked for.
     */
    const deleteRemovedAddresses = (entry, unit, current, parentUuid, cfg, correlation, trigger) => {

      const endpoint = entry.endpoints && entry.endpoints.childRemove;
      if (!endpoint) return;

      const lines = current || [];
      const live = {};
      lines.forEach((a) => { if (a.nsId) live[String(a.nsId)] = true; });

      // A line whose NetSuite address id could not be read is indistinguishable
      // from a line that is gone — and the Sync Log key falls back to the line
      // position when the id is missing, so the two keyspaces stop matching. In
      // an account where `internalid` is not exposed on the addressbook
      // sublist, EVERY accepted address would then look removed and be deleted
      // remotely while it is still sitting on the record. Deleting is not
      // reversible, so an unreadable id stops the diff instead of driving it.
      const unidentified = lines.filter((a) => !a.nsId).length;
      if (unidentified) {
        log.audit({
          title: 'RB address delete check skipped',
          details: {
            recordType: unit.recordType, recordId: unit.recordId,
            linesWithoutInternalId: unidentified,
            note: 'Cannot tell a removed address from one whose NetSuite ' +
              'internal id could not be read, so nothing is deleted remotely.'
          }
        });
        return;
      }

      const accepted = logIo.syncedAddresses(unit.recordType, unit.recordId);
      const gone = accepted.filter((a) => a.nsAddressId && !live[a.nsAddressId]);
      if (!gone.length) return;

      log.audit({
        title: 'RB addresses removed in NetSuite',
        details: {
          recordType: unit.recordType, recordId: unit.recordId,
          removing: gone.map((a) => a.nsAddressId)
        }
      });

      const addrEntry = {
        key: 'ADDRESS', syncType: C.SYNCTYPE.ADDRESS, builder: 'address',
        implemented: true, logSubjectField: entry.logSubjectField,
        fields: {}, endpoints: { remove: endpoint }
      };

      gone.forEach((a) => {
        const addrUnit = Object.assign({
          recordType: unit.recordType, recordId: unit.recordId, uomId: null,
          logNsId: a.logNsId,
          storedUuid: a.uuid || null, storedPayload: null, storedSynced: true,
          // The NetSuite address line is already gone, so there is nothing left
          // to write back to. Its work item is the only place this is recorded.
          subjectDeleted: true,
          data: {}
        }, unitFields({}));

        if (util.blank(a.uuid)) {
          // Accepted once but never identified. Nothing can be addressed.
          logIo.recordNoCall({
            entry: addrEntry, unit: addrUnit, cfg: cfg,
            operation: C.OPERATION.DELETE,
            status: C.STATUS.OPEN_REVIEW, outcome: C.OUTCOME.SKIPPED,
            trigger: trigger, correlation: correlation,
            reason: C.REASON.AWAITING_DECISION,
            note: 'NetSuite address ' + a.nsAddressId + ' was deleted, but no ' +
              'Middleware UUID was ever recorded for it, so it cannot be ' +
              'removed remotely. Delete it in TrackTraceRX by hand.'
          });
          return;
        }

        // Any work item still open for this address is dead — nothing will ever
        // sync that line again.
        logIo.closeStaleWorkItem(addrUnit,
          'Cancelled: the NetSuite address line was deleted.',
          C.STATUS.CLOSED_CANCELLED);

        const target = logIo.resolveLogTarget({
          entry: addrEntry, unit: addrUnit, operation: C.OPERATION.DELETE,
          payload: '', cfg: cfg, correlation: correlation
        });

        const res = client.call({
          entry: addrEntry, unit: addrUnit, cfg: cfg, target: target,
          endpoint: endpoint,
          pathParams: { uuid: parentUuid, address_uuid: a.uuid },
          body: null, operation: C.OPERATION.DELETE, payload: '',
          trigger: trigger, correlation: correlation, requestUuid: correlation
        });

        log.debug({
          title: 'RB address delete ' + a.uuid,
          details: {
            nsAddressId: a.nsAddressId, ok: res.ok, httpStatus: res.httpStatus
          }
        });

        if (res.ok || res.httpStatus === 404) logIo.closeSuccess(target, res);
        else if (res.suppressed || res.dryRun)
          logIo.closeNoAction(target, res,
            res.suppressed
              ? 'Environment gate: ' + (res.errorMessage || 'call suppressed') + '.'
              : 'Dry-run mode is on; the address delete was not sent.');
        else if (res.skipped)
          logIo.parkUnsent(target, res, cfg, C.REASON.AWAITING_DECISION,
            res.errorMessage || 'Kill switch is on; the address delete was not sent.');
        else
          // No retry path: the NetSuite line is gone, so nothing will rebuild
          // this payload. It needs a person.
          logIo.closeNeedsReview(target, res,
            'The NetSuite address line was deleted but the Middleware refused ' +
            'the delete: ' + (res.errorMessage || 'no message') + '.',
            'Delete address ' + a.uuid + ' under ' + parentUuid + ' in ' +
            'TrackTraceRX by hand. NetSuite cannot retry this \u2014 the address ' +
            'line it belonged to no longer exists.');
      });
    };

    /**
     * Re-read the record's sync-control state: the UUID the Middleware issued
     * and the payload it last accepted.
     *
     * Needed because the address pass writes a UUID back onto an address line,
     * and that write saves the PARENT record, which re-fires the User Event. A
     * nested run can therefore have sent the parent update and moved the stored
     * payload on while this execution still holds the values it read at the
     * start. Comparing against the stale copy sends the same call twice.
     */
    const refreshStoredState = (entry, unit) => {
      const f = entry.fields || {};
      if (!f.payload) return;
      try {
        const fresh = lookupSafe(unit.recordType, unit.recordId,
          [f.payload, f.uuid, f.synced]).values;
        unit.storedPayload = textOf(fresh[f.payload]) || null;
        if (f.uuid) {
          const freshUuid = textOf(fresh[f.uuid]);
          if (freshUuid) unit.storedUuid = freshUuid;
        }
        if (f.synced) unit.storedSynced = util.truthy(fresh[f.synced]);
      } catch (e) {
        log.error('Error @ refreshStoredState: ' +
          unit.recordType + '/' + unit.recordId, e);
      }
    };

    /**
     * The Middleware UUID of the address line flagged as the default billing or
     * default shipping address. Empty when the flag is not set on any line, or
     * when the line it is set on has not been accepted yet.
     */
    const defaultAddressUuid = (unit, cfg, entry, flag) => {
      // Address sync off ⇒ no address is ours to name, and reading the address
      // book would cost a record.load on every partner build for nothing.
      if (!cfg || cfg.useAddress !== true) return '';
      if (!entry || !entry.hasChildren) return '';
      const addrs = entityAddresses(unit);
      for (let i = 0; i < addrs.length; i++)
        if (addrs[i][flag] && !util.blank(addrs[i].uuid)) return String(addrs[i].uuid);
      return '';
    };

    /**
     * The follow-up update that names the default billing and shipping
     * addresses on the trading partner.
     *
     * THE CREATE PATH ONLY. A partner that already holds a UUID has its
     * addresses synced BEFORE its own payload is built (see step 1b in run), so
     * the identifiers are in the first and only call and this does nothing.
     *
     * A partner being created cannot work that way: an address is created under
     * its parent, so the parent must exist remotely first. Its create therefore
     * goes out with both defaults empty, the address pass creates the addresses,
     * and the partner is then told which of them is which.
     *
     * Nothing special is needed to avoid a loop: the payload comparison decides
     * whether this call happens at all, and after it succeeds the stored
     * payload matches, so the next save is a no-change.
     */
    const refreshPartnerDefaults = (entry, unit, cfg, correlation, trigger, parentUuid, addressesWritten) => {
      if (entry.key !== 'CUSTOMER' && entry.key !== 'VENDOR') return;
      if (util.blank(parentUuid)) return;
      if (!entry.endpoints || !entry.endpoints.update) return;

      // Re-read the address lines: the pass that has just run may have written
      // a UUID onto one of them, and the cached copy predates that.
      unit.addresses = undefined;

      // Only if an address line was written: that save re-fires the User
      // Event, and the nested run it starts may have sent this update already.
      if (addressesWritten) refreshStoredState(entry, unit);

      const payload = builders[entry.builder](unit, cfg, entry);
      const payloadStr = util.canonicalCompare(payload);

      if (util.samePayload(payloadStr, unit.storedPayload)) {
        log.debug({
          title: 'RB default addresses unchanged ' + unit.recordType + '/' + unit.recordId,
          details: {
            billing: payload.default_billing_address_uuid || null,
            shipping: payload.default_shipping_address_uuid || null
          }
        });
        return;
      }

      log.audit({
        title: 'RB updating default addresses on ' + unit.recordType + '/' + unit.recordId,
        details: {
          billing: payload.default_billing_address_uuid || null,
          shipping: payload.default_shipping_address_uuid || null
        }
      });

      const target = logIo.resolveLogTarget({
        entry: entry, unit: unit, operation: C.OPERATION.UPDATE,
        payload: payloadStr, cfg: cfg, reason: C.REASON.PAYLOAD_CHANGED,
        correlation: correlation
      });

      const res = client.call({
        entry: entry, unit: unit, cfg: cfg, target: target,
        endpoint: entry.endpoints.update, pathParams: { uuid: parentUuid },
        body: util.stripCompare(payload), operation: C.OPERATION.UPDATE,
        payload: payloadStr, trigger: trigger,
        correlation: correlation, requestUuid: correlation
      });

      if (res.ok) {
        writeBackSuccess(entry, unit, parentUuid, payloadStr, cfg);
        logIo.closeSuccess(target, res);
      } else if (res.suppressed || res.dryRun) {
        logIo.closeNoAction(target, res,
          res.suppressed
            ? 'Environment gate: ' + (res.errorMessage || 'call suppressed') + '.'
            : 'Dry-run mode is on; the default-address update was not sent.');
      } else if (res.skipped) {
        logIo.parkUnsent(target, res, cfg, C.REASON.AWAITING_DECISION,
          res.errorMessage || 'Kill switch is on; no call was made.');
      } else {
        writeBackFailure(entry, unit, res.errorMessage);
        logIo.closeFailure(target, res, cfg);
      }
    };

    /**
     * The address pass. Runs ONCE per unit per execution.
     *
     * It is called from both sides of the parent call — before it when the
     * parent already has a UUID, after it on every exit of the parent when it
     * did not — and whichever side gets there first is the one that runs. The
     * guard is what lets the pre-pass exist without every post-parent exit
     * having to know whether it already happened.
     *
     * @param {boolean} afterParent  true when the parent call has already been
     *   decided in this execution. Only then can the default billing and
     *   shipping addresses need a follow-up update: the parent payload was
     *   built before the addresses had identifiers.
     */
    const maybeSyncAddresses = (entry, unit, cfg, correlation, trigger, parentUuid, afterParent) => {
      if (!entry.hasChildren || !cfg.useAddress) return false;
      if (unit.addressesDone) return false;  // the pre-pass already ran
      const uuid = parentUuid || unit.storedUuid;
      if (util.blank(uuid)) return false;    // nothing to hang an address on yet
      unit.addressesDone = true;

      const wrote = syncChildAddresses(entry, unit, uuid, cfg, correlation, trigger);

      // Only when the parent went out first. Running before the parent, the
      // addresses already hold their identifiers and the parent payload built
      // straight after this picks them up — no follow-up call, and no second
      // sync of the same trading partner for one edit.
      if (afterParent)
        refreshPartnerDefaults(entry, unit, cfg, correlation, trigger, uuid,
          wrote === true);

      return wrote === true;
    };

    const syncChildAddresses = (entry, unit, parentUuid, cfg, correlation, trigger) => {
      log.debug("RB syncChildAddresses");
      // The caller already checks entry.hasChildren; this is the second lock on
      // the same door, so a future caller cannot push addresses for a record
      // type whose address sync is switched off.
      if (!entry.hasChildren || !entry.endpoints || !entry.endpoints.child) {
        log.debug({
          title: 'RB address sync is off for ' + entry.key,
          details: { recordType: unit.recordType, recordId: unit.recordId }
        });
        return;
      }

      const addrs = readAddresses(entry, unit);

      log.debug("Addresses to sync", addrs);

      if (util.blank(parentUuid)) {
        // Every address endpoint is addressed by the parent. Without the parent
        // UUID there is nothing to send anything to.
        log.audit({
          title: 'RB addresses not sent: parent has no UUID',
          details: { recordType: unit.recordType, recordId: unit.recordId }
        });
        return;
      }

      // ── Removed addresses FIRST, and before the empty check below.
      //    NetSuite raises no event for a deleted address book line: it is
      //    simply absent on the next save. The only record of what used to be
      //    there is the Sync Log, so that is what is compared. Deleting the
      //    LAST address leaves this list empty, which is exactly the case an
      //    early return on `addrs.length` would have skipped.
      deleteRemovedAddresses(entry, unit, addrs, parentUuid, cfg, correlation, trigger);

      if (!addrs.length) {
        // Not an error and not a silence. An entity with no address book line
        // carrying a street, city or postal code simply has nothing to push.
        log.debug({
          title: 'RB no addresses to sync ' + unit.recordType + '/' + unit.recordId,
          details: 'no address line carries a street, city or postal code'
        });
        return;
      }

      const cap = Number(cfg.maxInline) || 5;
      const parentName = txt(unit.data.companyname) || txt(unit.data.name) ||
        txt(unit.data.entityid);

      const addrEntry = {
        key: 'ADDRESS', syncType: C.SYNCTYPE.ADDRESS, builder: 'address',
        implemented: true, logSubjectField: entry.logSubjectField,
        fields: {},
        endpoints: {
          create: entry.endpoints.child,
          update: entry.endpoints.childUpdate || null
        }
      };

      // Every write-back is buffered and applied in ONE save at the end.
      //
      // Saving the parent per address re-fired the User Event per address, and
      // each of those nested runs rebuilt the trading-partner payload from a
      // half-finished set of address UUIDs — which is how one edit could send
      // the partner more than once. One save at the end means one nested run,
      // and it sees every identifier already in place.
      const pendingWrites = [];
      let sent = 0;

      addrs.forEach((addr) => {
        const body = buildAddress(addr, cfg, parentName);
        const addrPayload = util.canonicalCompare(body);

        log.debug("RB address payload", addrPayload);

        // ── The address trigger test. The address endpoint CREATES; there is
        //    no update. Re-POSTing an unchanged address is not a wasted call,
        //    it is a DUPLICATE address in the Middleware — and every edit to
        //    the parent used to do exactly that to every one of its addresses.
        // The stored payload is written ONLY after the Middleware accepted the
        // address, so a match means "already sent" — with or without a UUID
        // having come back with it. Requiring the UUID as well is what made an
        // address that was accepted without one get POSTed again on every
        // parent save, leaving one more duplicate each time.
        if (util.samePayload(addrPayload, addr.payload)) {
          log.debug({
            title: 'RB address unchanged ' + unit.recordType + '/' + unit.recordId,
            details: { nsAddressId: addr.nsId || null, uuid: addr.uuid || null }
          });
          return;
        }

        const addrUnit = Object.assign({
          recordType: unit.recordType, recordId: unit.recordId, uomId: null,
          // The Sync Log subject key for an address. Without it every address
          // shared one work-item key with its parent and with its siblings, so
          // the NetSuite address could not be identified from the log and
          // closing the parent's work item closed the addresses' too.
          logNsId: String(unit.recordId) + '#addr:' +
            (addr.nsId || ('line' + (addr.line === null ? 'main' : addr.line))),
          storedUuid: addr.uuid || null, storedPayload: addr.payload || null,
          storedSynced: !util.blank(addr.uuid), data: {}
        }, unitFields({}));

        log.debug("RB address unit", addrUnit);

        // The cap limits CALLS, not line positions. Counting positions meant an
        // entity with eight addresses of which only the last had changed
        // deferred that one change while making no calls at all.
        if (sent >= cap) {
          logIo.openDeferred({
            entry: addrEntry, unit: addrUnit, cfg: cfg,
            reason: C.REASON.PAYLOAD_CHANGED,
            status: C.STATUS.OPEN_PENDING, outcome: C.OUTCOME.SKIPPED,
            trigger: trigger, payload: addrPayload,
            note: 'Beyond the inline cap of ' + cap + ' address calls for this save.',
            correlation: correlation
          });
          return;
        }
        // ── Create or update, decided the same way as every other subject:
        //    by whether this address already holds a UUID.
        //
        //    An address CAN be updated — PUT to the address inside its parent,
        //    two path parameters. This is how the reference build does it, and
        //    it replaces the manual-review branch that used to sit here back
        //    when only a create endpoint was known.
        const isUpdate = !util.blank(addr.uuid);
        const endpoint = isUpdate ? addrEntry.endpoints.update : addrEntry.endpoints.create;

        if (!endpoint) {
          // Only reachable if a record type declares a create endpoint and no
          // update one. Say so rather than sending a create and duplicating.
          logIo.openDeferred({
            entry: addrEntry, unit: addrUnit, cfg: cfg,
            reason: C.REASON.AWAITING_DECISION,
            status: C.STATUS.OPEN_REVIEW, outcome: C.OUTCOME.SKIPPED,
            trigger: trigger, payload: addrPayload,
            note: 'This address changed after it was accepted, but ' + entry.key +
              ' has no address update endpoint configured. Sending it again ' +
              'would add a duplicate.',
            correlation: correlation
          });
          pendingWrites.push({
            addr: addr, values: {
              [C.ADDR.error]: 'Changed after acceptance and no address update ' +
                'endpoint is configured for ' + entry.key + '.'
            }
          });
          return;
        }

        sent++;        // counted here: a call is now certain

        const operation = isUpdate ? C.OPERATION.UPDATE : C.OPERATION.CREATE;

        const target = logIo.resolveLogTarget({
          entry: addrEntry, unit: addrUnit, operation: operation,
          payload: addrPayload, cfg: cfg, correlation: correlation
        });

        log.debug({
          title: 'RB address ' + operation + ' ' + unit.recordType + '/' + unit.recordId,
          details: {
            nsAddressId: addr.nsId || null, addressUuid: addr.uuid || null,
            parentUuid: parentUuid, endpoint: endpoint.path,
            payloadLength: addrPayload.length
          }
        });

        const res = client.call({
          entry: addrEntry, unit: addrUnit, cfg: cfg, target: target,
          endpoint: endpoint,
          // The create needs the parent only; the update needs the parent AND
          // the address. Both are passed either way — buildUrl substitutes what
          // the path asks for and ignores the rest.
          pathParams: { uuid: parentUuid, address_uuid: addr.uuid || '' },
          body: body, operation: operation, payload: addrPayload,
          trigger: trigger, correlation: correlation, requestUuid: correlation
        });

        if (res.ok) {
          // On an UPDATE the response need not repeat the identifier — we
          // already hold it. Only a CREATE that answers without one leaves us
          // unable to name the address.
          const newUuid = res.uuid || addr.uuid || '';

          if (util.blank(newUuid)) {
            // The address now exists remotely and we cannot name it. Writing a
            // blank UUID and calling it done is how an address ends up with
            // nothing in any field and no complaint anywhere — and the next
            // parent edit would create it all over again.
            logIo.closeNeedsReview(target, res,
              'The address was accepted but the response carried no UUID, so ' +
              'nothing could be written back to the NetSuite address line.',
              'Read the address UUID from TrackTraceRX and enter it in the ' +
              'RapidBridge External UUID field on this address line. Until ' +
              'then every parent edit will create another copy of it.');
            // The payload IS stored here, unlike on a failure. The address
            // was accepted; what is missing is its identifier. Without the
            // payload the next pass sees it as changed and POSTs it again,
            // leaving a duplicate in the Middleware every time the parent is
            // saved — the exact outcome the work item above is warning about.
            pendingWrites.push({
              addr: addr, values: {
                [C.ADDR.payload]: addrPayload,
                [C.ADDR.error]: 'Accepted by the Middleware but no UUID was ' +
                  'returned. Enter it by hand before editing this record again.'
              }
            });

            log.debug("RB address accepted but no UUID returned", {
              recordType: unit.recordType, recordId: unit.recordId,
              line: addr.line, payloadLength: addrPayload.length
            });
            return;
          }

          logIo.closeSuccess(target, res);
          // Hold the identifier on the in-memory line too. The parent payload
          // built after this pass names its default billing and shipping
          // addresses by UUID and reads them from this same list; without this
          // it would read the line as still unidentified and the default would
          // go out empty.
          addr.uuid = newUuid;
          addr.payload = addrPayload;
          // One save: the identifier, what was accepted, the NetSuite address
          // id and a cleared error.
          pendingWrites.push({
            addr: addr, values: {
              [C.ADDR.uuid]: newUuid,
              [C.ADDR.payload]: addrPayload,
              [C.ADDR.error]: ''
            }
          });

          log.debug("RB address accepted and written back", {
            recordType: unit.recordType, recordId: unit.recordId,
            line: addr.line, uuid: newUuid, payloadLength: addrPayload.length
          });

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
          // The payload is deliberately NOT written on a failure, so the next
          // save tries again instead of comparing equal for ever.
          pendingWrites.push({
            addr: addr, values: {
              [C.ADDR.error]: util.clip(res.errorMessage, 900)
            }
          });

          log.debug("RB address failed to sync", {
            recordType: unit.recordType, recordId: unit.recordId,
            line: addr.line, payloadLength: addrPayload.length,
            error: res.errorMessage
          });
        }
      });

      return flushAddressWrites(entry, unit.recordType, unit.recordId, pendingWrites);
    };

    /**
     * Apply every buffered address write-back in ONE load and ONE save.
     *
     * Two reasons this is batched rather than done per address:
     *
     *   1. Correctness. Saving the parent re-fires its User Event. A save per
     *      address meant a nested run per address, each rebuilding the trading
     *      partner from a partly-identified address set, and each able to send
     *      the partner again. One save means one nested run, and by then every
     *      address holds its identifier.
     *   2. Cost. Three fields on three addresses used to be nine executions.
     *
     * A field that is not deployed on the Address record is logged and skipped;
     * it must not cost the rest of the write-back, the UUID above all.
     *
     * @param {Array<{addr:Object, values:Object}>} writes
     */
    const flushAddressWrites = (entry, recordType, recordId, writes) => {
      const list = (writes || []).filter(
        (w) => w && w.values && Object.keys(w.values).length);
      if (!list.length) return false;

      log.debug({
        title: 'RB address write-back (batched)',
        details: {
          recordType: recordType, recordId: recordId, addresses: list.length,
          lines: list.map((w) => w.addr.line)
        }
      });

      try {
        const rec = record.load({ type: recordType, id: recordId, isDynamic: false });
        let applied = 0;

        list.forEach((w) => {
          const line = w.addr.line;
          let sub = null;
          try {
            sub = (line === null || line === undefined)
              ? rec.getSubrecord({ fieldId: 'mainaddress' })
              : rec.getSublistSubrecord({
                sublistId: 'addressbook',
                fieldId: 'addressbookaddress', line: line
              });
          } catch (e) { sub = null; }

          if (!sub) {
            log.error({
              title: 'RB address write-back found no subrecord',
              details: { recordType: recordType, recordId: recordId, line: line }
            });
            return;
          }

          Object.keys(w.values).forEach((f) => {
            try {
              // Only a REAL change counts, and only a real change saves.
              //
              // This save re-fires the User Event. Writing a value that is
              // already there still saves, still re-fires, and the next pass
              // writes the same value again — an error message that never
              // clears is enough to make that a loop, and on the
              // accepted-without-a-UUID path every turn of it POSTs the
              // address again and leaves another duplicate in the Middleware.
              // Comparing first is what makes the write-back converge.
              const now = sub.getValue({ fieldId: f });
              const next = w.values[f];
              if (String(now === null || now === undefined ? '' : now)
                === String(next === null || next === undefined ? '' : next)) return;
              sub.setValue({ fieldId: f, value: next });
              applied++;
            }
            catch (e) {
              log.error({
                title: 'RB address field not writable: ' + f,
                details: (e && e.message) || String(e)
              });
            }
          });
        });

        if (!applied) {
          log.debug({
            title: 'RB address write-back had nothing to change',
            details: { recordType: recordType, recordId: recordId }
          });
          return false;                       // no save, so no nested run
        }
        rec.save({ ignoreMandatoryFields: true, enableSourcing: false });
        return true;
      } catch (e) {
        logIo.exception(entry, { type: recordType, id: recordId }, e);
        return false;
      }
    };

    // /**
    //  * Country → state id. Free text where an id is expected fails silently, so
    //  * an unresolvable state is OMITTED rather than guessed.
    //  */
    // const resolveStateId = (countryCode, stateValue, cfg) => {
    //   if (util.blank(countryCode) || util.blank(stateValue)) return null;
    //   const key = String(countryCode).toUpperCase();

    //   if (!STATE_CACHE[key]) {
    //     const map = {};
    //     const res = client.call({
    //       entry: {
    //         key: 'STATES', syncType: C.SYNCTYPE.ADDRESS, implemented: true,
    //         fields: {}, endpoints: {}
    //       },
    //       unit: {
    //         recordType: 'location', recordId: 0, uomId: null, storedUuid: null,
    //         payloadField: null, tryResultField: null, lastTryField: null, data: {}
    //       },
    //       cfg: cfg, target: { mode: 'MAIN' },
    //       endpoint: C.EP.STATES, pathParams: { countryId: key },
    //       body: null, operation: C.OPERATION.QUERY, trigger: C.TRIGGER.INITIAL
    //     });
    //     if (res.ok && res.body) {
    //       const rows = res.body.data || res.body.states || res.body;
    //       if (Array.isArray(rows)) rows.forEach((s) => {
    //         if (s && s.name) map[String(s.name).toLowerCase()] = s.id || s.uuid;
    //         if (s && s.code) map[String(s.code).toLowerCase()] = s.id || s.uuid;
    //       });
    //     }
    //     STATE_CACHE[key] = map;
    //   }
    //   const id = STATE_CACHE[key][String(stateValue).toLowerCase()];
    //   return id === undefined ? null : id;
    // };

    // ═══════════════════════════════════════════════════════════════════════════
    // User Event helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /** Fields a user legitimately edits. Everything else of ours is locked. */
    const USER_OWNED = {
      // Dosage Form
      code: 1, isDefault: 1,
      // Location — our own fields
      sgln: 1, gs1Id: 1, holdBin: 1, goodBin: 1,
      // Location — NATIVE NetSuite fields read into the payload. They are
      // listed here for documentation; the nativeField guard below is what
      // actually protects them, and it protects any future one for free.
      locationType: 1, latitude: 1, longitude: 1,
      // Bin
      props: 1,
      // Item
      eligible: 1, dosage: 1, strength: 1, generic: 1,
      // Customer / Vendor
      gln: 1,
      // UOM Detail — every value on the row is entered by a user
      item: 1, unit: 1, qty: 1, upc: 1, gtin: 1, ndc: 1,
      gs1Prefix: 1, packSize: 1
    };

    /**
     * ENGINE-OWNED, locked on every form: uuid, payload, synced, lastSync,
     * lastTry, tryResult, error, attention, storageAreaUuid. Nothing else.
     */

    /**
     * A dispatch entry may map a NATIVE NetSuite field — Location reads
     * locationtype, latitude and longitude straight off the record. Those are
     * the user's fields, not ours, and locking one would stop a NetSuite user
     * maintaining their own data.
     *
     * Everything the SuiteApp owns is a custom field, so the test is simply
     * whether the id is one of ours. This holds for any native field a future
     * builder reads, without anyone having to remember to update USER_OWNED.
     */
    const OURS = /^(custrecord|custentity|custitem|custcol|custbody)_/i;
    const isOurField = (fieldId) => OURS.test(String(fieldId || ''));

    const lockSyncFields = (form, entry) => {
      if (!form || !entry || !entry.fields) return;
      Object.keys(entry.fields).forEach((k) => {
        if (USER_OWNED[k]) return;
        if (!isOurField(entry.fields[k])) return;     // never lock a native field
        try {
          const fld = form.getField({ id: entry.fields[k] });
          if (fld) fld.updateDisplayType({ displayType: 'inline' });
        } catch (e) { /* field not on this form */ }
      });
    };

    /** COPY — a copy has synced nothing. §11.9. */
    const clearAllSyncFields = (newRecord, entry) => {
      if (!newRecord || !entry || !entry.fields) return;
      // storageAreaUuid belongs here too: a copied Location would otherwise
      // inherit the source location's remote storage area and point at it.
      ['uuid', 'payload', 'synced', 'lastSync', 'lastTry', 'tryResult', 'error',
        'attention', 'storageAreaUuid']
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

    /** afterSubmit on DELETE — always fires for a configured endpoint, and only with a UUID. */
    /**
     * What has to be deleted remotely, and where its UUID comes from.
     *
     * DELETE_CACHE is filled in beforeSubmit — and in SuiteScript each User
     * Event entry point is its OWN execution, so module-level state does NOT
     * survive from beforeSubmit into afterSubmit. That is why the log read
     * `{"DELETE_CACHE": {}}` and no delete was ever sent: the cache can never
     * be the only source. It is still tried first, for the case where both run
     * in one execution.
     *
     * Order of resolution:
     *   1. DELETE_CACHE   — same execution, if it happens to be populated
     *   2. ctx.oldRecord  — populated in afterSubmit on DELETE
     *   3. the Sync Log   — the only witness left once the record is gone
     *
     * @returns {Array<{uomId:string|null, uuid:string, from:string}>}
     */
    const resolveDeleteUuids = (entry, oldRecord, cfg) => {
      const cached = DELETE_CACHE[oldRecord.type + '|' + oldRecord.id] || {};
      const out = [];
      const seen = {};
      const add = (uuid, uomId, from) => {
        const u = String(uuid || '');
        if (!u || seen[u]) return;
        seen[u] = true;
        out.push({ uuid: u, uomId: uomId || null, from: from });
      };

      if (entry.key === 'ITEM') {
        (cached.uomUuids || []).forEach((u) => add(u, null, 'DELETE_CACHE'));

        // UOM rows are not searched after item deletion because the item link is
        // already cleared; use the Sync Log as the fallback source for UOM UUIDs.
        if (!out.length)
          logIo.syncedUnitUuids(entry, oldRecord.id)
            .forEach((u) => add(u.uuid, u.uomId, 'Sync Log'));

      } else {
        add(cached.uuid, null, 'DELETE_CACHE');

        if (!out.length && entry.fields && entry.fields.uuid) {
          try { add(oldRecord.getValue({ fieldId: entry.fields.uuid }), null, 'oldRecord'); }
          catch (e) { /* fall through to the log */ }
        }

        if (!out.length) {
          const prior = logIo.lastSuccess(
            { recordType: oldRecord.type, recordId: oldRecord.id, uomId: null }, entry);
          if (prior && prior.uuid) add(prior.uuid, null, 'Sync Log ' + prior.logId);
        }
      }

      log.debug({
        title: 'RB resolveDeleteUuids ' + oldRecord.type + '/' + oldRecord.id,
        details: {
          key: entry.key, found: out.length, units: out,
          cacheWasEmpty: !Object.keys(cached).length
        }
      });
      return out;
    };

    /**
     * An orphaned UOM Detail row forgets the product it used to be.
     *
     * Its parent item has been deleted, so the row itself survives with a null
     * item link. Leaving the UUID and stored payload on it would mean a row
     * that claims to be in sync with something that no longer exists.
     */
    const forgetUomRow = (uomRowId) => {
      const U = C.MASTER.customrecord_jj_rb_uom_detail.fields;
      try {
        record.submitFields({
          type: C.REC.UOM, id: uomRowId,
          values: {
            [U.uuid]: '', [U.payload]: '', [U.synced]: false,
            [U.lastTry]: new Date(),
            [U.tryResult]: lists.id(C.LIST.tryResult, C.TRY.SYNCED)
          },
          options: { ignoreMandatoryFields: true }
        });
        log.debug({
          title: 'RB orphaned UOM row cleared ' + uomRowId,
          details: 'parent item deleted; UUID and stored payload removed'
        });
      } catch (e) {
        log.error({ title: 'RB forgetUomRow ' + uomRowId, details: e });
      }
    };

    const handleDelete = (entry, oldRecord, cfg) => {
      try {
        return runDelete(entry, oldRecord, cfg);
      } catch (e) {
        // A delete has no master record left to stamp and no retry path, so an
        // exception here is invisible unless it becomes a work item.
        logIo.exception(entry, { type: oldRecord.type, id: oldRecord.id }, e, {
          cfg: cfg, operation: C.OPERATION.DELETE, errorCode: 'DELETE_EXCEPTION',
          subjectDeleted: true,
          note: 'The NetSuite record was deleted but the SuiteApp threw while ' +
            'removing it from the Middleware.',
          suggested: 'Check whether the remote object still exists and delete ' +
            'it by hand if it does. Read the execution log for the ' +
            'stack, fix the cause, then mark this work item Resolved.'
        });
        return [];
      }
    };

    const runDelete = (entry, oldRecord, cfg) => {
      log.debug({
        title: 'RB delete ' + oldRecord.type + '/' + oldRecord.id,
        details: { key: entry.key, endpoints: entry.endpoints }
      });

      const correlation = util.uuid();
      const subject = {
        recordType: oldRecord.type, recordId: oldRecord.id, uomId: null,
        itemId: entry.key === 'ITEM' ? oldRecord.id : null,
        // The NetSuite record is gone. Its internal id is no longer a legal
        // value for the typed subject reference fields on the log, so those are
        // left blank and Record Type + NetSuite Internal ID carry the identity.
        subjectDeleted: true
      };

      // Nothing can ever sync this record again, so an open work item for it is
      // dead. Cancel it here or it sits on the reconciliation page for ever
      // describing a record that no longer exists.
      logIo.closeStaleWorkItem(subject,
        'Cancelled: the NetSuite record was deleted.', C.STATUS.CLOSED_CANCELLED);

      // Inactivate Method governs only the is_active flip (§18 q2). A real
      // NetSuite DELETE always means a remote delete, whatever that is set to.
      if (!entry.endpoints || !entry.endpoints.remove) {
        logIo.recordNoCall({
          entry: entry, unit: subject, cfg: cfg,
          operation: C.OPERATION.DELETE,
          status: C.STATUS.CLOSED_CANCELLED, outcome: C.OUTCOME.SKIPPED,
          trigger: C.TRIGGER.INITIAL, correlation: correlation,
          reason: C.REASON.AWAITING_DECISION,
          note: 'The record was deleted in NetSuite, but ' + entry.key +
            ' has no Middleware delete endpoint configured, so nothing ' +
            'was sent. The remote object, if any, is now an orphan.'
        });
        return [];
      }

      const units = resolveDeleteUuids(entry, oldRecord, cfg);

      if (!units.length) {
        // Not an error, and it still has to be visible: the master record is
        // gone, so the log is the only place this can be recorded.
        logIo.recordNoCall({
          entry: entry, unit: subject, cfg: cfg,
          operation: C.OPERATION.DELETE,
          status: C.STATUS.CLOSED_NO_ACTION, outcome: C.OUTCOME.SKIPPED,
          trigger: C.TRIGGER.INITIAL, correlation: correlation,
          note: 'The record was deleted in NetSuite. No Middleware UUID could ' +
            'be found for it in the record or in the Sync Log, so it had ' +
            'never been accepted remotely and there was nothing to delete.'
        });
        return [];
      }

      return units.map((u) => {
        const unit = Object.assign({
          recordType: oldRecord.type, recordId: oldRecord.id,
          uomId: u.uomId, itemId: subject.itemId,
          subjectDeleted: true,
          storedUuid: u.uuid, storedPayload: null, storedSynced: true, data: {}
        }, unitFields({}));

        // Per-unit for an item: each UOM row is its own work item.
        if (u.uomId)
          logIo.closeStaleWorkItem(unit,
            'Cancelled: the parent NetSuite item was deleted.',
            C.STATUS.CLOSED_CANCELLED);

        const target = logIo.resolveLogTarget({
          entry: entry, unit: unit,
          operation: C.OPERATION.DELETE, payload: '', cfg: cfg,
          correlation: correlation
        });

        const res = client.call({
          entry: entry, unit: unit, cfg: cfg, target: target,
          endpoint: entry.endpoints.remove, pathParams: { uuid: u.uuid },
          body: null, operation: C.OPERATION.DELETE, payload: '',
          trigger: C.TRIGGER.INITIAL, correlation: correlation,
          requestUuid: correlation
        });

        log.debug({
          title: 'RB delete call ' + u.uuid,
          details: {
            uuidFrom: u.from, uomId: u.uomId, ok: res.ok,
            httpStatus: res.httpStatus, suppressed: res.suppressed,
            dryRun: res.dryRun, skipped: res.skipped,
            errorMessage: res.errorMessage || null
          }
        });

        // A 404 on a delete means it is already gone, which is the outcome
        // asked for. Success, not a work item nobody can close.
        if (res.ok || res.httpStatus === 404) {
          logIo.closeSuccess(target, res);
          // The item is gone but its UOM Detail rows are NOT — the item link is
          // onparentdelete=SET_NULL, so they survive as orphans. Strip the
          // remote identity from the row we just deleted, or it keeps a UUID
          // pointing at a Middleware product that no longer exists.
          if (u.uomId) forgetUomRow(u.uomId);
        }
        else if (res.suppressed || res.dryRun)
          logIo.closeNoAction(target, res,
            res.suppressed
              ? 'Environment gate: ' + (res.errorMessage || 'call suppressed') +
              '. The NetSuite record is deleted; the remote object is not.'
              : 'Dry-run mode is on; the delete was not sent.');
        else if (res.skipped)
          logIo.parkUnsent(target, res, cfg, C.REASON.AWAITING_DECISION,
            res.errorMessage || 'Kill switch is on; the delete was not sent.');
        else
          // NOT closeFailure. The retry sweep rebuilds the payload from the
          // master record, and for a delete that record is gone — this would
          // back off for ever and never be retried, while the Middleware keeps
          // an object NetSuite has thrown away.
          logIo.closeNeedsReview(target, res,
            'The NetSuite record was deleted but the Middleware refused the ' +
            'delete: ' + (res.errorMessage || 'no message') + '.',
            'Delete ' + entry.key + ' ' + u.uuid + ' in the Middleware by hand, ' +
            'or ask TrackTrace to remove it. NetSuite cannot retry this — the ' +
            'record it belonged to no longer exists. Mark this work item ' +
            'Resolved once the remote object is gone.');

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
      ensureParentLocation, isEligible,
      packSizeTypeOf, isLeafRow, compositionOf,
      locationAddresses, entityAddresses,
      // resolveStateId, 
    };
  });