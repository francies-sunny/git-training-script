/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * jj_rb_txn — the transaction orchestrator and its payload builders.
 *
 * PHASE 1, OUTBOUND ONLY: Sales Order and Purchase Order, NetSuite → the
 * configured Middleware. Item Fulfilment and Item Receipt are created INBOUND
 * by the Middleware calling the RESTlet, so nothing here pushes them — see the
 * Transaction Developer Guide v3.1 §2.2, §10.2 and §11.1.
 *
 * WHAT IS REUSED, AND IT IS MOST OF IT:
 *   jj_rb_core   — every id, the dispatch table, the payload comparison
 *   jj_rb_io     — the Sync Log writer and the HTTP client, unchanged (§7.1)
 *   jj_rb_sync   — the write-back, the dependency pre-sync, the address reader
 *
 * WHAT THIS FILE ADDS, and it is exactly the three concepts of §2:
 *   Concept 3 — the line filter, and the roll-ups that make it visible
 *   §7.3.1    — the approval gate, evaluated BEFORE the payload comparison
 *   §8.5/§9.3 — the two payload builders, which differ by four address roles
 *               and one key
 *
 * Dependency direction, unchanged: core ← io ← sync ← txn ← entry points.
 *
 * Transaction Developer Guide v3.1 §6, §7.4, §8, §9.
 */
define(['N/record', 'N/search', 'N/format', './jj_rb_core', './jj_rb_io', './jj_rb_sync'],
  (record, search, format, core, io, sync) => {

    const { C, util, config } = core;
    const { logIo, client } = io;

    // ═══════════════════════════════════════════════════════════════════════════
    // Small readers — the same three this SuiteApp uses everywhere
    // ═══════════════════════════════════════════════════════════════════════════

    /** A search/lookupFields value that may arrive as [{value,text}]. */
    const textOf = (v) => {
      if (Array.isArray(v)) return v.length ? (v[0].value || '') : '';
      return (v === undefined || v === null) ? '' : String(v);
    };
    const labelOf = (v) => {
      if (Array.isArray(v)) return v.length ? (v[0].text || '') : '';
      return '';
    };

    const entryFor = (t) => C.TXNMAP[String(t || '').toLowerCase()] || null;

    /** Eligibility, read from a value that may be a list text or a checkbox. */
    const eligibleValue = (raw) => {
      const s = String(raw || '').toUpperCase();
      if (s === 'TRUE' || s === 'T' || s === 'YES') return true;
      // AUTO has no agreed rule yet — the master engine refuses rather than
      // guessing, and a transaction line must not decide differently.
      return false;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Concept 3 — the line filter
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * beforeSubmit. Classify every line, resolve its destination product, and
     * roll the answer up to the body.
     *
     * TWO searches for the whole order, not two lookups per line (§17.4 rule
     * 3): one for the items' eligibility, one for their UOM Detail rows.
     *
     * The three line columns are written HERE, inside the user's own save,
     * rather than after the call. Writing them afterwards would mean loading
     * and saving the order again, and a save that touches only sublist values
     * changes no BODY field — so the recursion guard (which compares body
     * fields) would not recognise it as ours and the whole sync would run a
     * second time. Doing it in beforeSubmit costs no extra save at all.
     *
     * NOTHING HERE BLOCKS A SAVE. A mixed order is normal and is never refused
     * — proposal v4 §8.2, guide §7.3 and §9.4. If you find a throw in this
     * function it is a leftover from v1.0's `Block` mixed-line policy.
     *
     * @returns {{total:number, serialized:number}} counts, for the caller's log
     */
    const classifyLines = (newRecord, entry, cfg) => {
      const out = { total: 0, serialized: 0 };
      if (!newRecord || !entry) return out;

      const L = entry.lineFields || C.LINE;
      const eligField = (cfg && cfg.eligField) || 'custitem_jj_rb_eligible';

      let count = 0;
      try { count = newRecord.getLineCount({ sublistId: 'item' }); }
      catch (e) { return out; }
      if (count <= 0) return out;

      // THE SOURCED COLUMN. `custcol_jj_rb_item_eligible` is wired in the
      // object to Source List = Item, Source From = TrackTrace Eligibility, so
      // NetSuite has already put the item's own answer on the line and no
      // search is needed to find it.
      //
      // It is trusted only while the configured Eligibility Field is still the
      // shipped one: sourcing is fixed in the field definition and cannot
      // follow a client who points eligibility at their own item field. When
      // it can't be trusted — or when a line predates the column, as on an
      // order imported before it was deployed — the search below answers for
      // exactly the items the column could not.
      const trustSourced = String(eligField) === C.SOURCED_ELIG_FIELD;

      // Pass 1 — the item on each line, and what the sourced column says.
      const items = [];
      const seen = {};
      const lineItem = [];
      const eligible = {};
      for (let i = 0; i < count; i++) {
        let id = '';
        try {
          id = newRecord.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
        } catch (e) { id = ''; }
        id = String(id || '');
        lineItem.push(id);
        if (!id) continue;
        if (!seen[id]) { seen[id] = true; items.push(id); }
        if (!trustSourced || eligible[id] !== undefined) continue;
        const sourced = lineSourcedEligibility(newRecord, i, L);
        if (sourced) eligible[id] = eligibleValue(sourced);
      }
      if (!items.length) return out;

      // Pass 2 — ONE search, and only for the items the column left unanswered.
      const unknown = items.filter((id) => eligible[id] === undefined);
      if (unknown.length) {
        try {
          search.create({
            type: 'item',
            filters: [['internalid', 'anyof', unknown]],
            columns: [eligField]
          }).run().each((r) => {
            eligible[String(r.id)] =
              eligibleValue(r.getText(eligField) || r.getValue(eligField));
            return true;
          });
        } catch (e) {
          // The Eligibility Field is configurable free text, so a typo or a
          // field the account never deployed lands here. Treated as "not
          // classified" rather than "not eligible": saying nothing is better
          // than marking a regulated order as containing no regulated lines.
          log.error({
            title: 'RB txn eligibility field could not be read: ' + eligField,
            details: {
              recordType: newRecord.type, recordId: newRecord.id || null,
              error: (e && e.message) || String(e),
              unresolved: unknown.length,
              note: 'Check the Eligibility Field setting on the RapidBridge ' +
                'Configuration. Those items were not classified on this save.'
            }
          });
          if (Object.keys(eligible).length === 0) return out;
        }
      }

      // Pass 3 — the destination product for every unit these items sell in.
      const products = productMap(items);

      // Pass 4 — stamp the lines and roll up.
      let anySerial = false;
      let anyOther = false;
      for (let i = 0; i < count; i++) {
        const id = lineItem[i];
        if (!id) continue;                       // description / subtotal line
        out.total++;
        const isSerial = eligible[id] === true;
        if (isSerial) { out.serialized++; anySerial = true; } else { anyOther = true; }
        setLine(newRecord, i, L.serialized, isSerial);

        // The two informational columns. They describe what WOULD travel, so
        // they are filled only for a line that is actually in scope: a line
        // that never reaches the destination has no product identifier there
        // and no quantity there, and showing one would be a lie.
        const inScope = isSerial && !lineClosed(newRecord, i) && lineQty(newRecord, i) > 0;
        setLine(newRecord, i, L.productUuid,
          inScope ? productFor(products, id, lineUnit(newRecord, i)).uuid : '');
        setLine(newRecord, i, L.qtySynced,
          inScope ? lineQty(newRecord, i) : '');
      }

      setBody(newRecord, entry.fields.allSerial, out.total > 0 && !anyOther && anySerial);
      setBody(newRecord, entry.fields.containsNonSerial, anyOther);
      return out;
    };

    const setBody = (rec, fieldId, value) => {
      if (!fieldId) return;
      try { rec.setValue({ fieldId: fieldId, value: value }); }
      catch (e) { /* not on this form */ }
    };

    const setLine = (rec, line, fieldId, value) => {
      if (!fieldId) return;
      try {
        rec.setSublistValue({
          sublistId: 'item', fieldId: fieldId, line: line, value: value
        });
      } catch (e) { /* the column is not on this form */ }
    };

    /**
     * What the sourced column says about this line's item.
     *
     * The TEXT, because that is the list label the eligibility test reads, and
     * because the internal id of a list value is a deployment detail. Blank
     * when the column is not on the form, not deployed, or the line predates
     * it — every one of which falls back to the search.
     */
    const lineSourcedEligibility = (rec, line, L) => {
      if (!L || !L.itemEligible) return '';
      try {
        const t = rec.getSublistText({
          sublistId: 'item', fieldId: L.itemEligible, line: line
        });
        if (t) return t;
      } catch (e) { /* not on this form */ }
      return '';
    };

    const lineQty = (rec, line) => {
      try {
        return Number(rec.getSublistValue({
          sublistId: 'item', fieldId: 'quantity', line: line
        })) || 0;
      } catch (e) { return 0; }
    };

    const lineUnit = (rec, line) => {
      // The TEXT of the unit, because that is what a UOM Detail row's Saleable
      // Unit is matched on. The internal id would tie the mapping to a list
      // deployment rather than to the client's own vocabulary.
      try {
        const t = rec.getSublistText({ sublistId: 'item', fieldId: 'units', line: line });
        if (t) return t;
      } catch (e) { /* not on this form */ }
      try {
        return rec.getSublistValue({ sublistId: 'item', fieldId: 'units', line: line }) || '';
      } catch (e) { return ''; }
    };

    const lineClosed = (rec, line) => {
      try {
        return util.truthy(rec.getSublistValue({
          sublistId: 'item', fieldId: 'isclosed', line: line
        }));
      } catch (e) { return false; }
    };

    /**
     * A unit of measure compared as data, not as prose.
     *
     * ── READ THIS BEFORE CHANGING IT ────────────────────────────────────────
     * A transaction line's unit does NOT come back as the bare unit name. It
     * carries the conversion rate:
     *
     *     line unit text       "Each(1)"        "Case(24)"
     *     UOM Detail row       "Each"           "Case"
     *
     * so a literal comparison finds nothing and every order is blocked with
     * `Blocked - missing parent UUID` — which reads as "the item has not
     * synced" when the item is perfectly fine. The parenthesised part is
     * dropped, and the rest is reduced to letters and digits so that spacing
     * and punctuation ("Fl. Oz", "FL OZ") cannot separate two spellings of one
     * unit. Both sides of the comparison go through here.
     */
    const unitKey = (v) => String(v === null || v === undefined ? '' : v)
      .replace(/\([^)]*\)/g, ' ')          // "Each(1)" -> "Each "
      .replace(/[^a-z0-9]/gi, '')
      .toUpperCase();

    /**
     * itemId -> { UNIT KEY: uuid }. A row with no uuid is KEPT, with its uuid
     * empty: "the row exists but the item has not synced" and "there is no row
     * for that unit" are different problems with different fixes, and the
     * caller has to be able to tell them apart.
     */
    const productMap = (items) => {
      const U = C.MASTER.customrecord_jj_rb_uom_detail.fields;
      const map = {};
      if (!items.length) return map;
      try {
        search.create({
          type: C.REC.UOM,
          filters: [[U.item, 'anyof', items], 'AND', ['isinactive', 'is', 'F']],
          columns: [U.item, U.unit, U.uuid]
        }).run().each((r) => {
          const itemId = textOf(r.getValue(U.item));
          const unit = unitKey(r.getText(U.unit) || r.getValue(U.unit));
          if (!itemId || !unit) return true;
          if (!map[itemId]) map[itemId] = {};
          map[itemId][unit] = textOf(r.getValue(U.uuid));
          return true;
        });
      } catch (e) {
        log.error('Error @ txn productMap', e);
      }
      return map;
    };

    /**
     * What the map says about one line.
     *
     * @returns {{uuid:string, reason:string, available:Array<string>}}
     *          reason is '' when it resolved, 'NO_ROW' when the item has no
     *          UOM Detail row for that unit, 'NO_UUID' when it has one and the
     *          item has not been accepted by the Middleware yet.
     */
    const productFor = (map, itemId, unitText) => {
      const rows = map[itemId] || {};
      const available = Object.keys(rows);
      let key = unitKey(unitText);
      // A line with no unit at all — an item with no unit of measure — falls
      // back to the base unit, which proposal v4 §5.2 fixes at Each.
      if (!key) key = C.BASE_UNIT;
      if (!Object.prototype.hasOwnProperty.call(rows, key))
        return { uuid: '', reason: 'NO_ROW', available: available };
      if (util.blank(rows[key]))
        return { uuid: '', reason: 'NO_UUID', available: available };
      return { uuid: String(rows[key]), reason: '', available: available };
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // §7.3.1 — the approval gate. The one thing to get right
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * HAS THIS ORDER REACHED A STATUS IN WHICH IT MAY BE SENT?
     *
     * THREE return values, and each one means something different:
     *
     *   false  not eligible yet      → stamp `Deferred - awaiting approval`,
     *                                  make NO call, write NO log record
     *   true   JUST became eligible  → send, and BYPASS the payload comparison
     *   null   already eligible      → send only if the payload changed
     *
     * Testing only the CURRENT status makes every save of an eligible order
     * look like a transition, so an order edited four times would send four
     * creates instead of one create and three updates. Reading the OLD status
     * is what distinguishes them, and `oldRecord` is null on create — which is
     * why `was` is false rather than assumed.
     *
     * ── THE ONE QUESTION THIS ASKS, AND THE ONE IT DOES NOT ─────────────────
     * It asks whether NetSuite has put the order in a status where it can be
     * fulfilled or received. It does NOT ask whether the account uses approval
     * routing, and it must not: an account with no approval workflow never
     * produces `Pending Approval` at all, so anything keyed to an approval
     * status would sync nothing there. Both kinds of account fall out of the
     * same test:
     *
     *   WITH approval routing — the order sits in `Pending Approval`, which is
     *   not eligible, so it defers. The approval moves it to `Pending
     *   Fulfillment`; `was` was not eligible and `now` is, so THAT save sends.
     *
     *   WITHOUT approval routing — NetSuite creates the order directly in
     *   `Pending Fulfillment`. `oldRecord` is null, so `was` is false and the
     *   CREATE is itself the transition. That save sends. No branch, no
     *   detection, and nothing to configure.
     *
     * ── AND WHY THE ELIGIBLE SET IS A RANGE, NOT ONE STATUS ─────────────────
     * An order stays eligible through fulfilment and billing (TXN_STATUS), so
     * an edit to a partly fulfilled or fully billed order is an UPDATE. Under
     * a single-status test it would fall out of the set and every later edit
     * would be silently deferred as "awaiting approval".
     */
    const atSyncStatus = (entry, ctx) => {
      const type = ctx.newRecord.type;
      const now = statusOf(ctx.newRecord, true);
      const was = ctx.oldRecord ? statusOf(ctx.oldRecord, false) : null;

      const nowRow = syncRow(entry, type, now, true);
      const wasRow = ctx.oldRecord ? syncRow(entry, type, was, false) : null;

      log.debug({
        title: 'RB txn atSyncStatus ' + type + '/' + ctx.newRecord.id,
        details: {
          was: was, wasEligible: !!(wasRow && wasRow.sync),
          now: now, nowEligible: !!(nowRow && nowRow.sync),
          eligible: util.syncStatusNames(type)
        }
      });

      if (!nowRow || !nowRow.sync) return false;   // not eligible yet
      if (!wasRow || !wasRow.sync) return true;    // JUST became eligible
      return null;                                 // already eligible: compare
    };

    /**
     * The TXN_STATUS row a status value names.
     *
     * A value that matches NOTHING is reported rather than swallowed: it means
     * NetSuite handed back a status this table does not know — a new one, a
     * custom transaction status, or a spelling nobody anticipated — and the
     * visible symptom would otherwise be an order that never syncs with no
     * explanation anywhere.
     */
    const syncRow = (entry, recordType, value, loud) => {
      const rows = entry.statuses;
      if (!rows) return null;                      // a type with no table
      const row = util.statusEntry(recordType, value);
      if (!row && loud && !util.blank(value)) {
        log.audit({
          title: 'RB txn unrecognised status: ' + value,
          details: {
            recordType: recordType,
            known: rows.map((r) => r.name).join(' | '),
            note: 'Treated as not eligible to sync. If this is a status the ' +
              'account genuinely uses, it belongs in C.TXN_STATUS.'
          }
        });
      }
      return row;
    };

    /**
     * The status as a comparable value.
     *
     * For the NEW record the committed value is read back from the database:
     * `getValue('status')` on a transaction returns different things on
     * different record types and in different contexts, and afterSubmit runs
     * after the save, so the database is both cheaper to trust and correct.
     * For the OLD record there is nothing to read back, so the in-memory value
     * is all there is — and statusEntry() matches the id, the `SalesOrd:B`
     * form, the camelCase form and the display text alike, so it does not
     * matter which shape comes back.
     */
    const statusOf = (rec, fromDatabase) => {
      if (!rec) return '';
      if (fromDatabase && rec.id) {
        try {
          const v = search.lookupFields({
            type: rec.type, id: rec.id, columns: ['status']
          });
          const raw = textOf(v.status) || labelOf(v.status);
          if (raw) return raw;
        } catch (e) { /* fall through to the in-memory value */ }
      }
      try {
        const val = rec.getValue({ fieldId: 'status' });
        if (val) return val;
      } catch (e) { /* not every type exposes it this way */ }
      try { return rec.getText({ fieldId: 'status' }) || ''; }
      catch (e) { return ''; }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Reading the order
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * The order's own values — the seven-field bundle plus what the payload
     * needs from the header. One lookupFields, one unit of governance.
     *
     * ── WHAT MUST NOT GO IN THIS LIST ───────────────────────────────────────
     * `billaddresslist` and `shipaddresslist` are FIELDS on the record but not
     * SEARCH COLUMNS, and asking for one fails the whole read with
     *
     *   SSS_INVALID_SRCH_COL — An nlobjSearchColumn contains an invalid
     *   column, or is not in proper syntax: billaddresslist.
     *
     * `billaddress` and `shipaddress` ARE valid, and are the wrong thing: they
     * return the address as FORMATTED TEXT — several lines of name, street and
     * city — not an identifier, so nothing can be matched against them. The
     * order's address identifiers are read separately, off the order's own
     * address records — see orderAddressUuids().
     */
    const readHeader = (entry, recordType, recordId) => {
      const f = entry.fields;
      const cols = [
        f.uuid, f.payload, f.synced,
        'tranid', 'trandate', 'entity', 'location', 'subsidiary', 'status'
      ];
      try {
        return search.lookupFields({ type: recordType, id: recordId, columns: cols });
      } catch (e) {
        log.error('Error @ txn readHeader ' + recordType + '/' + recordId, e);
        return null;
      }
    };

    /**
     * The Middleware identifiers of the addresses THIS ORDER actually used.
     *
     * A transaction carries its own copies of the billing and shipping
     * addresses — taken from the entity when the address was applied — and the
     * address custom fields ride along with them. So the identifier is read
     * off the order through the `billingAddress` / `shippingAddress` joins,
     * which is the only place it can be read from without knowing which of the
     * entity's addresses was chosen.
     *
     * Blank is normal and not an error: the copy predates the identifier
     * whenever the address was synchronized AFTER this order was raised. The
     * caller falls back to the entity's default addresses for that case.
     *
     * @returns {{billing:string, shipping:string}}
     */
    const orderAddressUuids = (recordType, recordId) => {
      const out = { billing: '', shipping: '' };
      const A = C.ADDR.uuid;
      try {
        search.create({
          type: 'transaction',
          filters: [
            ['internalid', 'anyof', recordId], 'AND',
            ['mainline', 'is', 'T']
          ],
          columns: [
            search.createColumn({ name: A, join: 'billingAddress' }),
            search.createColumn({ name: A, join: 'shippingAddress' })
          ]
        }).run().each((r) => {
          out.billing = textOf(r.getValue({ name: A, join: 'billingAddress' }));
          out.shipping = textOf(r.getValue({ name: A, join: 'shippingAddress' }));
          return false;
        });
      } catch (e) {
        // Not fatal. An account that has never deployed the address custom
        // field, or a transaction type with no address join, lands here and
        // the entity defaults answer instead.
        log.audit({
          title: 'RB txn order address identifiers could not be read',
          details: {
            recordType: recordType, recordId: recordId,
            error: (e && e.message) || String(e),
            note: 'Falling back to the entity default billing and shipping addresses.'
          }
        });
      }
      return out;
    };

    /**
     * Every item line of the order, in one search.
     *
     * `mainline is F` drops the header row; the tax, COGS and shipping filters
     * drop the rows NetSuite adds that are not item lines. `closed` is read
     * because a closed line has nothing left to ship or receive and must not
     * appear in the destination's line set.
     */
    const readLines = (entry, recordType, recordId, cfg) => {
      const L = entry.lineFields || C.LINE;
      // The classification stamped in beforeSubmit is the answer. The SOURCED
      // column is the backstop for a line that never got one — a CSV import
      // whose sublist write did not stick, or an order that predates the
      // column — and it is trusted on the same condition as everywhere else:
      // only while the configured Eligibility Field is still the shipped one.
      const trustSourced =
        String((cfg && cfg.eligField) || C.SOURCED_ELIG_FIELD) === C.SOURCED_ELIG_FIELD;
      const rows = [];
      try {
        search.create({
          type: 'transaction',
          filters: [
            ['internalid', 'anyof', recordId], 'AND',
            ['mainline', 'is', 'F'], 'AND',
            ['taxline', 'is', 'F'], 'AND',
            ['cogs', 'is', 'F'], 'AND',
            ['shipping', 'is', 'F']
          ],
          columns: [
            'line', 'item', 'quantity', 'unit', 'closed', 'location',
            L.serialized, L.itemEligible
          ]
        }).run().each((r) => {
          const itemId = textOf(r.getValue('item'));
          if (!itemId) return true;
          rows.push({
            line: textOf(r.getValue('line')),
            itemId: itemId,
            quantity: Number(r.getValue('quantity')) || 0,
            unit: r.getText('unit') || textOf(r.getValue('unit')),
            closed: util.truthy(r.getValue('closed')),
            location: textOf(r.getValue('location')),
            serialized: util.truthy(r.getValue(L.serialized))
              || (trustSourced && eligibleValue(r.getText(L.itemEligible)))
          });
          return true;
        });
      } catch (e) {
        log.error('Error @ txn readLines ' + recordType + '/' + recordId, e);
      }
      return rows;
    };

    /**
     * Concept 3 applied. Only Scenario 1 lines travel, and a closed or
     * zero-quantity line is not one of them.
     *
     * The quantities in the destination will NOT match the NetSuite order when
     * the order is mixed. That is correct and intended — §2.3 — and it is why
     * `Lines in payload` and `Lines sent` are both written to the Sync Log.
     */
    const filterLines = (rows) => {
      const inScope = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.serialized) continue;
        if (r.closed) continue;
        if (!(r.quantity > 0)) continue;
        inScope.push(r);
      }
      return inScope;
    };

    /**
     * §8.3 step 6 — a line's destination product identifier.
     *
     *   line → item → the item's UOM Detail rows → the row whose Saleable Unit
     *   matches the line's unit → that row's stored product UUID
     *
     * ONE search for every line on the order. Matching is on the DISPLAY TEXT
     * of the Saleable Unit, uppercased, which is the same key the pack size
     * map uses and survives a redeployed list whose internal ids differ.
     *
     * @returns {{map:Object, missing:Array}}
     */
    const resolveProducts = (lines, o) => {
      if (!lines.length) return { map: {}, missing: [] };

      const items = [];
      const seen = {};
      lines.forEach((l) => {
        if (seen[l.itemId]) return;
        seen[l.itemId] = true;
        items.push(l.itemId);
      });

      let map = productMap(items);
      let missing = applyProducts(lines, map);

      // §8.3 step 6 — an item that has a row for this unit but no identifier
      // has simply not been published yet. Publish it and ask again, ONCE.
      // A missing ROW is not retried: syncing the item cannot create one, and
      // that is a data gap only a person can close.
      const unsynced = dedupe(missing
        .filter((m) => m.reason === 'NO_UUID')
        .map((m) => m.itemId));

      if (unsynced.length && o && presyncItems(unsynced, o)) {
        map = productMap(items);
        missing = applyProducts(lines, map);
      }

      log.debug({
        title: 'RB txn resolveProducts',
        details: {
          items: items.length, lines: lines.length,
          presynced: unsynced, missing: missing
        }
      });
      return { map: map, missing: missing };
    };

    /** Stamp every line from the map, and report the ones that could not be. */
    const applyProducts = (lines, map) => {
      const missing = [];
      lines.forEach((l) => {
        const hit = productFor(map, l.itemId, l.unit);
        l.productUuid = hit.uuid;
        if (!hit.uuid) {
          missing.push({
            line: l.line, itemId: l.itemId, unit: l.unit,
            reason: hit.reason, available: hit.available
          });
        }
      });
      return missing;
    };

    const dedupe = (a) => a.filter((v, i) => a.indexOf(v) === i);

    /**
     * Publish the items behind these lines, so the order can name their
     * products.
     *
     * ONCE PER ITEM PER EXECUTION. An item that still has no identifier after
     * its own sync has a real problem of its own — it is not eligible, it has
     * no UOM Detail row, the call failed — and re-driving it here would turn
     * one order's save into an unbounded cascade. The order blocks instead,
     * and the item's own Last Sync Try Result says what went wrong.
     *
     * @returns {boolean} true when at least one item was actually pushed
     */
    const presyncItems = (itemIds, o) => {
      const todo = itemIds.filter((id) => !PRESYNCED[id]);
      if (!todo.length) return false;
      todo.forEach((id) => { PRESYNCED[id] = true; });

      const types = {};
      try {
        search.create({
          type: 'item',
          filters: [['internalid', 'anyof', todo]],
          columns: ['recordtype']
        }).run().each((r) => {
          types[String(r.id)] = String(r.getValue('recordtype') || '').toLowerCase();
          return true;
        });
      } catch (e) {
        log.error('Error @ txn presyncItems recordtype', e);
        return false;
      }

      let pushed = false;
      todo.forEach((id) => {
        const t = types[id];
        const entry = t ? C.MASTER[t] : null;
        if (!entry || entry.key !== 'ITEM') {
          log.audit({
            title: 'RB txn cannot pre-sync item ' + id,
            details: 'Its record type (' + (t || 'unknown') + ') is not one the ' +
              'master dispatch table publishes.'
          });
          return;
        }
        log.audit({
          title: 'RB txn pre-syncing item ' + t + '/' + id,
          details: 'An order line names it and it has no Middleware product ' +
            'identifier yet.'
        });
        try {
          sync.run({
            entry: entry, recordId: id, recordType: t, cfg: o.cfg,
            trigger: C.TRIGGER.PRESYNC, correlation: o.correlation
          });
          pushed = true;
        } catch (e) {
          log.error('Error @ txn pre-sync item ' + t + '/' + id, e);
        }
      });
      return pushed;
    };

    /**
     * Items already pre-synced in THIS execution.
     *
     * Module state does not survive between User Event entry points, and that
     * is fine: this only has to stop one afterSubmit re-driving the same item
     * twice, which is exactly the span it lives for.
     */
    const PRESYNCED = {};

    // ═══════════════════════════════════════════════════════════════════════════
    // Addresses — §8.5, §9.3
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * The trading partner's address identifiers for this order.
     *
     * TWO SOURCES, IN THIS ORDER, and the order matters:
     *
     *   1. THE ORDER'S OWN address records (orderAddressUuids). This is the
     *      only source that knows WHICH of the entity's addresses this order
     *      used, so it is asked first and it costs one search.
     *
     *   2. The entity's DEFAULT billing and shipping addresses. Reached only
     *      when the first came back blank — which happens when the address was
     *      synchronized after the order was raised, so the order's copy
     *      predates the identifier. It costs a record load, so it is not paid
     *      for unless it is needed.
     *
     * @returns {{billing:string, shipping:string}}
     */
    const partnerAddresses = (entry, cfg, entityType, entityId, recordType, recordId) => {
      const out = { billing: '', shipping: '' };
      // Address sync off ⇒ no address is ours to name.
      if (!cfg || cfg.useAddress !== true) return out;

      const own = orderAddressUuids(recordType, recordId);
      out.billing = own.billing;
      out.shipping = own.shipping;
      if (out.billing && out.shipping) return out;
      if (!entityType || !entityId) return out;

      let addrs = [];
      try {
        addrs = sync.entityAddresses({
          recordType: entityType, recordId: entityId
        }) || [];
      } catch (e) {
        log.error('Error @ txn partnerAddresses ' + entityType + '/' + entityId, e);
        return out;
      }

      const byFlag = (flag) => {
        for (let i = 0; i < addrs.length; i++)
          if (addrs[i][flag] && !util.blank(addrs[i].uuid)) return String(addrs[i].uuid);
        return '';
      };
      if (!out.billing) out.billing = byFlag('defaultBilling');
      if (!out.shipping) out.shipping = byFlag('defaultShipping');

      log.debug({
        title: 'RB txn partner addresses ' + recordType + '/' + recordId,
        details: {
          fromOrder: own, resolved: out,
          note: 'a blank in fromOrder means the address was synced after this ' +
            'order was raised, so the entity default answered instead'
        }
      });
      return out;
    };

    /**
     * The location's address identifier — the ship-from and sold-by end of a
     * sale, and the billing and ship-to end of a purchase.
     *
     * ═══ READ THIS BEFORE FILING A BUG ═══════════════════════════════════════
     * LOCATION ADDRESS SYNC IS CURRENTLY OFF. `C.MASTER.location.hasChildren`
     * is null, so no NetSuite location address has ever been given a Middleware
     * identifier, and this returns EMPTY for every order. The two keys still go
     * on the wire, empty, because the Middleware expects the full fixed key set
     * — an omitted key is not the same as an empty one.
     *
     * Nothing here needs to change to fix that: switch `hasChildren` back to
     * 'addressbook' on the Location entry, let the locations re-sync, and this
     * function starts returning identifiers on the next order.
     *
     * The reference build filled these by calling GET /locations/{uuid}/
     * addresses on every order and taking the default. That is one extra HTTP
     * call inside a user's save, against a flow this SuiteApp has switched off
     * — so it is deliberately NOT done here. §17.4 budgets one call per save.
     */
    const locationAddressUuid = (cfg, locationId) => {
      if (!locationId) return '';
      const loc = C.MASTER.location;
      if (!loc || !loc.hasChildren) return '';     // location address sync is off
      if (!cfg || cfg.useAddress !== true) return '';
      try {
        const addrs = sync.locationAddresses({
          recordType: 'location', recordId: locationId
        }) || [];
        for (let i = 0; i < addrs.length; i++)
          if (!util.blank(addrs[i].uuid)) return String(addrs[i].uuid);
      } catch (e) {
        log.error('Error @ txn locationAddressUuid ' + locationId, e);
      }
      return '';
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // The payload builders — §8.5, §9.3
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * The full fixed key set, in the order the reference build sends it.
     *
     * A key is never omitted because it is empty. The Middleware's form encoder
     * expects every key on every call, and an omitted key is not the same as an
     * empty one.
     *
     * `transaction_uuid` is on the wire but OUT of the comparison
     * (util.COMPARE_IGNORE): it is empty on the create and holds the
     * destination identifier afterwards, so comparing it would make writing
     * that identifier back look like an edit and fire a pointless update on the
     * very next save.
     */
    const buildTxn = (o) => {
      const { entry, unit, cfg, lines } = o;
      const h = o.header || {};

      const items = lines.map((l) => ({
        product_uuid: l.productUuid,
        // The quantity in the LINE's own unit, against the product resolved
        // FOR that unit — a line for 2 Cases sends the Case product with
        // quantity 2, which is what the reference build sends and what the
        // destination's own line model expects.
        //
        // The guide (§10.4) also says "convert to the base unit,
        // unconditionally". The two readings only differ when an item has a
        // Case row AND an Each row; this build follows the reference, writes
        // what it sent to `custcol_jj_rb_qty_synced`, and the question is
        // carried as one to confirm with TrackTraceRX.
        quantity: l.quantity,
        sort_order: l.line
      }));

      const body = {
        transaction_uuid: unit.storedUuid || '',
        custom_id: textOf(h.tranid),
        location_uuid: o.locationUuid || '',
        trading_partner_uuid: o.partnerUuid || '',
        transaction_date: o.transactionDate || '',
        billing_address_uuid: o.addr.billing || '',
        ship_from_address_uuid: o.addr.shipFrom || '',
        ship_to_address_uuid: o.addr.shipTo || '',
        sold_by_address_uuid: o.addr.soldBy || '',
        line_items: JSON.stringify(items),
        // §8.6 — FIXED VALUES, and the second one is the important one.
        //
        // approve TRUE: nothing is sent until the order is at its gate, so the
        // remote transaction is created in the state that matches it.
        //
        // create-shipment FALSE, ALWAYS: setting it asserts that everything
        // ordered ships, in one event, now. Partial fulfilment is supported
        // (§10.7), so a partial pick against an order whose shipment was
        // already created for the full quantity leaves the destination holding
        // a shipment that did not happen — and there is no parity
        // reconciliation in this phase to find it.
        is_approved: true,
        is_approved_is_ship_transaction: false,
        is_manually_close_transaction: false,
        enforce_oci: false,
        order_nbr: textOf(h.tranid),
        po_nbr: textOf(h.tranid)
      };

      // §8.4 — sent EXPLICITLY on a sale, so NetSuite knows what it created
      // without an extra read. §9.3 — IGNORED on a purchase, so not sent.
      if (entry.subType) body.outbound_transaction_sub_type = entry.subType;

      return body;
    };

    const builders = {
      salesTxn: buildTxn,
      purchaseTxn: buildTxn
      // transferTxn, rmaTxn, vendorReturnTxn — Phase 2. The dispatch rows name
      // them and are marked implemented:false, so deploying to one of those
      // record types fails loudly instead of doing nothing.
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // The unit
    // ═══════════════════════════════════════════════════════════════════════════

    /** The field-id block the shared write-back and stamping expect. */
    const txnUnit = (entry, recordType, recordId, header) => {
      const f = entry.fields;
      return {
        recordType: recordType,
        recordId: recordId,
        uomId: null,
        storedUuid: header ? textOf(header[f.uuid]) : '',
        storedPayload: header ? textOf(header[f.payload]) : '',
        storedSynced: header ? util.truthy(header[f.synced]) : false,
        data: header || {},
        uuidField: f.uuid, payloadField: f.payload, syncedField: f.synced,
        lastSyncField: f.lastSync, lastTryField: f.lastTry,
        tryResultField: f.tryResult, errorField: f.error
      };
    };

    /** A stamp target that needs no header read — for the gates before it. */
    const stampUnit = (entry, recordType, recordId) => {
      const f = entry.fields;
      return {
        recordType: recordType, recordId: recordId, uomId: null,
        storedUuid: '', storedPayload: '', storedSynced: false, data: {},
        uuidField: f.uuid, payloadField: f.payload, syncedField: f.synced,
        lastSyncField: f.lastSync, lastTryField: f.lastTry,
        tryResultField: f.tryResult, errorField: f.error
      };
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // run — the transaction pattern
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Steps 1 to 7 are the SAME engine as master data:
     *   filter → resolve → depend → build → compare → call → write back → stamp
     *
     * What transactions add is the filter (Concept 3) and the fact that step 5
     * can be BYPASSED by a status crossing the caller has already detected
     * (§7.3.1) — an order reaching its gate changes no field in the payload, so
     * a comparison-first engine would skip the one save that matters.
     *
     * In this phase the sequence of §7.4 step 5 is one call: approve at create,
     * ship from the scan. There is no second step to plan.
     *
     * @param {Object} o
     * @param {Object} o.entry       C.TXNMAP row
     * @param {Object} o.flow        config.flow(entry)
     * @param {string} o.recordType
     * @param {string} o.recordId
     * @param {Object} o.cfg
     * @param {boolean} o.forceSend  the order JUST crossed its gate
     */
    const run = (o) => {
      const { entry, cfg, recordType, recordId } = o;
      const trigger = o.trigger || C.TRIGGER.INITIAL;
      const correlation = o.correlation || util.uuid();

      log.debug({
        title: 'RB txn.run ' + recordType + '/' + recordId,
        details: {
          key: entry && entry.key, syncType: entry && entry.syncType,
          trigger: trigger, correlation: correlation, forceSend: !!o.forceSend
        }
      });

      // A row that is declared but has no builder yet fails LOUDLY. Silence
      // here looks exactly like a script that did not run.
      if (entry.implemented === false || !builders[entry.builder]) {
        const msg = 'No builder for "' + entry.builder + '". ' + entry.key +
          ' is declared in the transaction dispatch table but is not built in ' +
          'this phase. Remove the deployment or add the builder.';
        logIo.stampTry(stampUnit(entry, recordType, recordId),
          C.TRY.FAIL_PRE_API, null, msg);
        logIo.exception(entry, { type: recordType, id: recordId }, new Error(msg));
        return [{ ok: false, notImplemented: true }];
      }

      // ── step 0: the order's own values.
      const header = readHeader(entry, recordType, recordId);
      if (!header) {
        const msg = 'The order could not be read, so nothing could be built.';
        logIo.stampTry(stampUnit(entry, recordType, recordId),
          C.TRY.FAIL_PRE_API, null, msg);
        return [{ ok: false, blocked: msg }];
      }
      const unit = txnUnit(entry, recordType, recordId, header);

      // ── step 1: Concept 3. Filter the lines.
      const allLines = readLines(entry, recordType, recordId, cfg);
      const lines = filterLines(allLines);

      log.debug({
        title: 'RB txn lines ' + recordType + '/' + recordId,
        details: { total: allLines.length, inScope: lines.length }
      });

      if (!lines.length) {
        // No call, and NO log record. §8.8, §16.2: most orders in a mixed
        // catalogue carry no regulated product at all, and a log row for every
        // one of them would bury the rows that matter.
        logIo.closeStaleWorkItem(unit,
          'Closed without a call: no line on this order is a trackable, ' +
          'serialized item, so there is nothing to send.');
        logIo.stampTry(unit, C.TRY.SKIP_NO_SERIAL, null, '');
        return [{ skipped: true, reason: 'no serialized lines' }];
      }

      // ── step 2: each line's destination product identifier. An item that
      //    has a row but no identifier is published first and asked again.
      const resolved = resolveProducts(lines, { cfg: cfg, correlation: correlation });
      if (resolved.missing.length) {
        const note = missingProductNote(resolved.missing);
        logIo.openDeferred({
          entry: entry, unit: unit, cfg: cfg,
          reason: C.REASON.MISSING_PARENT,
          status: C.STATUS.OPEN_PENDING,        // resolves once the item syncs
          outcome: C.OUTCOME.SKIPPED,
          trigger: trigger, note: note, correlation: correlation
        });
        logIo.stampTry(unit, C.TRY.BLOCK_NO_PARENT, null, note);
        return [{ ok: false, blocked: 'product not synced' }];
      }

      // ── step 3: dependency pre-sync. A transaction names its trading partner
      //    and its location BY UUID, so neither can be a stranger.
      const locationId = textOf(header.location) ||
        (lines.length ? lines[0].location : '');
      const entityId = textOf(header.entity);
      const entityType = entry.partnerType === 'VENDOR' ? 'vendor' : 'customer';

      let locationUuid = '';
      if (locationId)
        locationUuid = sync.ensureParentLocation(locationId, cfg, correlation) || '';

      let partnerUuid = '';
      if (entityId) {
        const pe = C.MASTER[entityType];
        partnerUuid = sync.ensureParentRecord(pe, entityType, entityId, cfg, correlation) || '';
      }

      if (!locationUuid || !partnerUuid) {
        const what = [];
        if (!locationUuid) what.push('the location (' + (locationId || 'not set') + ')');
        if (!partnerUuid) what.push('the ' + entityType + ' (' + (entityId || 'not set') + ')');
        const note = 'This order cannot be sent until ' + what.join(' and ') +
          ' has a Middleware UUID. The dependency was pre-synced and still has ' +
          'none, so it has to be looked at.';
        logIo.openDeferred({
          entry: entry, unit: unit, cfg: cfg,
          reason: C.REASON.MISSING_PARENT,
          status: C.STATUS.OPEN_PENDING,
          outcome: C.OUTCOME.SKIPPED,
          trigger: trigger, note: note, correlation: correlation
        });
        logIo.stampTry(unit, C.TRY.BLOCK_NO_PARENT, null, note);
        return [{ ok: false, blocked: 'dependency not synced' }];
      }

      // ── step 4: the four addresses, in the roles this record type gives them.
      const pa = partnerAddresses(entry, cfg, entityType, entityId, recordType, recordId);
      const la = locationAddressUuid(cfg, locationId);
      const roles = entry.addressRoles || {};
      // §9.3 — the four roles are REVERSED between a sale and a purchase, and
      // that reversal is the whole difference between the two builders. On the
      // partner side the billing role takes the partner's billing address and
      // the three delivery roles take its shipping address.
      const fromPartner = (role) => roles[role] === 'PARTNER';
      const addr = {
        billing: fromPartner('billing') ? pa.billing : la,
        shipTo: fromPartner('shipTo') ? pa.shipping : la,
        shipFrom: fromPartner('shipFrom') ? pa.shipping : la,
        soldBy: fromPartner('soldBy') ? pa.billing : la
      };

      // ── step 5: build, then compare.
      const payload = builders[entry.builder]({
        entry: entry, unit: unit, cfg: cfg, header: header, lines: lines,
        locationUuid: locationUuid, partnerUuid: partnerUuid,
        transactionDate: isoDate(header.trandate), addr: addr
      });
      const payloadStr = util.canonicalCompare(payload);
      const sendBody = util.stripCompare(payload);

      if (!o.forceSend
        && util.samePayload(payloadStr, unit.storedPayload)
        && unit.storedSynced === true && unit.storedUuid) {
        log.debug({
          title: 'RB txn no change ' + recordType + '/' + recordId,
          details: { uuid: unit.storedUuid, payloadLength: payloadStr.length }
        });
        logIo.closeStaleWorkItem(unit,
          'Closed without a call: the order now matches the payload the ' +
          'Middleware last accepted, so the change this work item was opened ' +
          'for no longer exists.');
        logIo.stampTry(unit, C.TRY.NO_CHANGE, null, '');
        return [{ skipped: true, noChange: true }];
      }

      // ── step 5b: the Sync Log's memory, for a record that has lost its own.
      //    Without this an order whose identifier was cleared by hand resolves
      //    to CREATE and the destination reports a duplicate custom id.
      const prior = logIo.lastSuccess(unit, entry);
      if (prior && prior.uuid && !unit.storedUuid) {
        log.audit({
          title: 'RB txn adopted UUID from Sync Log',
          details: {
            recordType: recordType, recordId: recordId, uuid: prior.uuid,
            logId: prior.logId,
            note: 'the order had no UUID; a CREATE here would have duplicated it'
          }
        });
        unit.storedUuid = prior.uuid;
        try {
          record.submitFields({
            type: recordType, id: recordId,
            values: { [unit.uuidField]: prior.uuid },
            options: { ignoreMandatoryFields: true }
          });
        } catch (e) {
          log.error({ title: 'RB txn could not write adopted UUID', details: e });
        }
      }

      const operation = unit.storedUuid ? C.OPERATION.UPDATE : C.OPERATION.CREATE;
      const endpoint = unit.storedUuid ? entry.endpoints.update : entry.endpoints.create;

      // ── step 6: the call. §6.3 — the path token is per OPERATION, not per
      //    record type: create wants `sales`, the list wants `sale`.
      const tokenMap = unit.storedUuid ? C.TOKENS.TXN_UPDATE : C.TOKENS.TXN_CREATE;
      const txnToken = tokenMap[String(recordType).toLowerCase()];

      const target = logIo.resolveLogTarget({
        entry: entry, unit: unit, operation: operation, payload: payloadStr,
        cfg: cfg, reason: reasonFor(unit), triggeringParentId: o.parentId
      });

      const res = client.call({
        entry: entry, unit: unit, cfg: cfg, target: target,
        endpoint: endpoint,
        pathParams: { txnType: txnToken, uuid: unit.storedUuid },
        body: sendBody, operation: operation, payload: payloadStr,
        trigger: trigger, correlation: correlation, requestUuid: correlation
      });

      // §5.4.2 — `Lines in payload` and `Lines sent`. total ≠ sent is the
      // visible signal that a partial line set travelled, and it is the first
      // thing a support person needs when the destination quantities do not
      // match NetSuite.
      stampLineCounts(res.logId, allLines.length, lines.length);

      // ── step 7: write back.
      if (res.ok) {
        const finalUuid = res.uuid || unit.storedUuid || '';
        // The body fields only. The three line columns were written inside the
        // user's own save, in beforeSubmit — see classifyLines.
        sync.writeBackSuccess(entry, unit, finalUuid, payloadStr, cfg);

        if (util.blank(finalUuid)) {
          logIo.closeNeedsReview(target, res,
            'The order was accepted but the response carried no transaction ' +
            'UUID, so nothing could be written back and this order cannot be ' +
            'updated.',
            'Read the transaction UUID from TrackTraceRX and enter it in the ' +
            'TrackTrace Transaction UUID field on this order. Until then no ' +
            'update can be sent for it.');
          logIo.stampTry(unit, C.TRY.SYNCED, null,
            'Accepted by the Middleware, but no transaction UUID was returned. ' +
            'Enter it by hand before this order is edited again.');
          return [{ ok: true, uuid: '', noUuid: true }];
        }

        logIo.closeSuccess(target, res);
        return [{ ok: true, uuid: finalUuid }];
      }

      if (res.suppressed || res.dryRun) {
        logIo.closeNoAction(target, res,
          res.suppressed
            ? 'Environment gate: ' + (res.errorMessage || 'call suppressed') +
            '. The payload is stored; nothing was sent.'
            : 'Dry-run mode is on. The payload is stored; nothing was sent.');
        logIo.stampTry(unit, res.suppressed ? C.TRY.SUPPRESSED_ENV : C.TRY.DRY_RUN);
        return [{ ok: false, suppressed: true }];
      }

      if (res.skipped) {
        logIo.parkUnsent(target, res, cfg, C.REASON.AWAITING_DECISION,
          res.errorMessage || 'Kill switch is on; no call was made.');
        logIo.stampTry(unit, C.TRY.FAIL_PRE_API, null,
          res.errorMessage || 'Kill switch is on; no call was made.');
        return [{ ok: false, skipped: true }];
      }

      sync.writeBackFailure(entry, unit, res.errorMessage);
      logIo.closeFailure(target, res, cfg);
      return [{ ok: false, error: res.errorMessage }];
    };

    /**
     * Why these lines could not be sent, in words that name the fix.
     *
     * The two causes need different actions, and saying "sync the item first"
     * for both sends somebody to re-sync an item that is already synchronized.
     */
    const missingProductNote = (missing) => {
      const parts = [];

      const noRow = missing.filter((m) => m.reason === 'NO_ROW');
      if (noRow.length) {
        parts.push('No UOM Detail row matches the unit on these lines: ' +
          noRow.map((m) => 'line ' + m.line + ', item ' + m.itemId +
            ', unit "' + (m.unit || 'none') + '"' +
            (m.available.length
              ? ' (the item has rows for: ' + m.available.join(', ') + ')'
              : ' (the item has no active UOM Detail row at all)')).join('; ') +
          '. Add a UOM Detail row whose Saleable Unit matches the unit the ' +
          'line is sold in — the unit name and the Saleable Unit are compared ' +
          'ignoring case, spacing and any conversion rate in brackets, so ' +
          '"Each(1)" matches "Each".');
      }

      const noUuid = missing.filter((m) => m.reason === 'NO_UUID');
      if (noUuid.length) {
        parts.push('These items have the right UOM Detail row but no Middleware ' +
          'product identifier, and publishing them from here did not produce ' +
          'one: ' + dedupe(noUuid.map((m) => 'item ' + m.itemId)).join(', ') +
          '. Open the item and read its RapidBridge Last Sync Try Result — it ' +
          'is usually eligibility, or a failed call.');
      }

      return parts.join(' ');
    };

    const reasonFor = (unit) => {
      if (!unit.storedUuid) return C.REASON.NEVER_SYNCED;
      if (!unit.storedSynced) return C.REASON.LAST_FAILED;
      return C.REASON.PAYLOAD_CHANGED;
    };

    /**
     * yyyy-mm-dd, which is what the destination's date field takes.
     *
     * The value arrives in the ACCOUNT'S date format, so it is parsed with
     * N/format rather than handed to `new Date()`: on a dd/mm/yyyy account
     * `new Date('08/09/2026')` reads September as August and every transaction
     * date is quietly wrong by months.
     */
    const isoDate = (raw) => {
      const v = textOf(raw);
      if (!v) return '';
      let d = null;
      try { d = format.parse({ value: v, type: format.Type.DATE }); }
      catch (e) { d = null; }
      if (!d || isNaN(d.getTime())) {
        const fallback = new Date(v);
        if (isNaN(fallback.getTime())) return v;   // already in some agreed form
        d = fallback;
      }
      const p = (n) => (n < 10 ? '0' + n : String(n));
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    };

    const stampLineCounts = (logId, total, sent) => {
      if (!logId) return;
      try {
        record.submitFields({
          type: C.REC.LOG, id: logId,
          values: { [C.LOG.lineTotal]: total, [C.LOG.lineSent]: sent },
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) { /* a decoration; never worth failing the call over */ }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // User Event helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /** Our fields are ours. Everything the engine writes is display-only. */
    const lockSyncFields = (form, entry) => sync.lockSyncFields(form, entry);

    /**
     * COPY — §15.6. Every integration field on the copy is cleared, including
     * the line columns.
     *
     * The consequence of getting this wrong is worse than for master data: two
     * NetSuite orders claiming one remote transaction, and an update sent for
     * one of them silently replacing the other's line set.
     */
    const clearAllSyncFields = (newRecord, entry) => {
      if (!newRecord || !entry || !entry.fields) return;
      const f = entry.fields;
      ['uuid', 'payload', 'synced', 'lastSync', 'lastTry', 'tryResult', 'error',
        'shipmentUuid', 'requestUuid', 'scanSession', 'allSerial',
        'containsNonSerial'].forEach((k) => {
          const fid = f[k];
          if (!fid) return;
          const off = (k === 'synced' || k === 'allSerial' || k === 'containsNonSerial');
          try { newRecord.setValue({ fieldId: fid, value: off ? false : '' }); }
          catch (e) { /* not on the form */ }
        });

      const L = entry.lineFields || C.LINE;
      let n = 0;
      try { n = newRecord.getLineCount({ sublistId: 'item' }); } catch (e) { n = 0; }
      for (let i = 0; i < n; i++) {
        setLine(newRecord, i, L.productUuid, '');
        setLine(newRecord, i, L.qtySynced, '');
      }
    };

    /**
     * The flow is switched off in the configuration. Still an evaluation, and
     * it has to be visible — §11.5.
     */
    const stampFlowDisabled = (entry, recordType, recordId) => {
      const unit = stampUnit(entry, recordType, recordId);
      logIo.closeStaleWorkItem(unit,
        'Cancelled: the ' + entry.syncType + ' flow was switched off in the ' +
        'RapidBridge configuration, so this sync is no longer wanted.',
        C.STATUS.CLOSED_CANCELLED);
      logIo.stampTry(unit, C.TRY.SKIP_FEATURE, null, '');
    };

    /**
     * A dispatch row that is declared but has no builder. It fails LOUDLY:
     * silence here looks exactly like a script that did not run, and the
     * status test below would have deferred it forever with a reason that is
     * not the real one.
     */
    const stampNotImplemented = (entry, recordType, recordId) => {
      const msg = entry.key + ' is declared in the transaction dispatch table ' +
        'but is not built in this phase. Remove the deployment, or add the "' +
        entry.builder + '" builder.';
      log.audit({ title: 'RB txn not implemented: ' + recordType, details: msg });
      logIo.stampTry(stampUnit(entry, recordType, recordId),
        C.TRY.FAIL_PRE_API, null, msg);
    };

    /**
     * Not in a sendable status yet. The most common outcome in a live account,
     * and NOT an error — it is the count of orders nobody has released.
     */
    const stampDeferred = (entry, recordType, recordId) => {
      logIo.stampTry(stampUnit(entry, recordType, recordId),
        C.TRY.DEFER_APPROVAL, null,
        'Not sent: this order is not yet in a status from which it can be ' +
        'synchronized. It will be sent as soon as it reaches one of: ' +
        util.syncStatusNames(recordType).join(', ') + '. This is not an error.');
    };

    return {
      run, builders, entryFor,
      classifyLines, filterLines, resolveProducts, atSyncStatus,
      lockSyncFields, clearAllSyncFields,
      stampFlowDisabled, stampDeferred, stampNotImplemented
    };
  });
