/* Daily Ops — dispatch console
 *
 * Renders into #tab-ops and replaces classic renderOps(). Shares S.daily /
 * _ops* persistence with the rest of the app (cleaners, staff, crew poster).
 *
 * Structure
 * ---------
 *   .ob-command   day bar   — date, progress, KPIs, save state, share menu
 *   .ob-rail      triage    — discriminating segments + search + sort + grouping
 *   .ob-page      body      — tasks, schedule check, bulk bar, board, aux panels
 *
 * Rendering contract: the whole tab is produced as ONE innerHTML string and all
 * interaction runs through delegated [data-ob-action] handlers bound once on the
 * root. Nothing on the initial render path may touch DOM APIs beyond
 * getElementById/innerHTML/addEventListener, because tests drive this file
 * against a minimal stub panel.
 *
 * Because a full render replaces every node, renderKeepingContext() snapshots
 * the window scroll offset and the focused control (via data-ob-focus, plus its
 * selection range) and restores both afterwards. Free-text typing never
 * re-renders at all — it only schedules a save.
 */
(function () {
  'use strict';

  var DEFAULTS = {
    filter: 'all',
    sort: 'status',
    search: '',
    saveTimer: null,
    searchTimer: null,
    selected: {},
    selectionDate: '',
    focusId: '',
    page: 1,
    pageSize: 0, // 0 = show every matching row (table height follows the day)
    group: 'area', // 'area' | 'cleaner' | 'none'
    menuFor: '', // row id whose ⋯ actions menu is open
    assignFor: '', // row id whose crew popover is open
    barMenu: false, // day-bar share/actions menu
    composer: false, // inline task composer
    draftText: '',
    draftApt: '',
  };

  var state = window._opsBetaState = window._opsBetaState || {};
  // Merge defaults without clobbering a state object restored from a previous
  // render (or seeded by tests) — new keys must not reset existing ones.
  for (var dk in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, dk) && state[dk] === undefined) state[dk] = DEFAULTS[dk];
  }
  if (!state.selected) state.selected = {};
  // Disclosure state has to live here: a full repaint rebuilds every <details>,
  // so a natively-open panel would snap shut on the next render.
  if (!state.open || typeof state.open !== 'object') state.open = { tasks: false, staff: false, notes: false };
  if (state.pageSize == null) state.pageSize = 0;
  if (!state.page) state.page = 1;

  function rootEl() {
    return document.getElementById('tab-ops');
  }

  function pageSizeFor(total) {
    var size = Number(state.pageSize);
    if (!isFinite(size) || size <= 0) return Math.max(1, total || 1);
    return size;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function encoded(value) {
    return encodeURIComponent(String(value == null ? '' : value));
  }

  function decoded(value) {
    try { return decodeURIComponent(String(value || '')); }
    catch (e) { return String(value || ''); }
  }

  function today() {
    return (typeof _opsTodayStr === 'function') ? _opsTodayStr() : new Date().toISOString().slice(0, 10);
  }

  function dateLabel(value) {
    if (typeof _opsDayLabel === 'function') return _opsDayLabel(value);
    if (typeof _opsFmtDate === 'function') return _opsFmtDate(value);
    return value;
  }

  function cleanKey(row) {
    if (!row) return '';
    if (typeof _opsCleanStorageKey === 'function') return _opsCleanStorageKey(row);
    return String(row.aptId || row.aptName || '') + '::' + String(row.cleanType || 'turnover');
  }

  function cleanTarget(row) {
    if (!row) return null;
    return (typeof _opsCleanTarget === 'function') ? _opsCleanTarget(row) : row;
  }

  function cleaners(row) {
    if (!row) return [];
    if (typeof _opsCleanerList === 'function') return _opsCleanerList(row);
    if (Array.isArray(row.cleanerNames)) return row.cleanerNames.filter(Boolean);
    return row.cleanerName ? [row.cleanerName] : [];
  }

  function kindOf(row) {
    return (row && typeof _opsKindOf === 'function') ? _opsKindOf(row) : null;
  }

  function cleanType(row) {
    var t = String((row && row.cleanType) || 'turnover');
    if (t === 'refresh') return { label: 'REFRESH', cls: 'ob-blue' };
    if (t === 'sofa_bed') return { label: 'SOFA', cls: 'ob-red' };
    return { label: 'TURNOVER', cls: 'ob-green' };
  }

  function taskList() {
    return (typeof OPS_CLEAN_TASKS !== 'undefined' && Array.isArray(OPS_CLEAN_TASKS))
      ? OPS_CLEAN_TASKS
      : [['katharismos', 'Καθαρισμός'], ['prepare_sofa', 'Prepare sofa bed'], ['episkeui', 'Επισκευή βλάβης'], ['extra', 'Extra']];
  }

  function taskOptions(current) {
    return taskList().map(function (item) {
      return '<option value="' + esc(item[0]) + '"' + (String(current || 'katharismos') === String(item[0]) ? ' selected' : '') + '>' + esc(item[1]) + '</option>';
    }).join('');
  }

  function initials(name) {
    var t = String(name || '').trim();
    if (!t) return '?';
    var parts = t.split(/\s+/);
    if (parts.length > 1) return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
    return t.slice(0, 2).toUpperCase();
  }

  // ── saving ───────────────────────────────────────────────────────────────
  function setSaveState(text, ok) {
    var el = document.getElementById('ops-beta-save-state');
    if (!el) return;
    el.textContent = text;
    el.style.color = ok === false ? 'var(--ob-red)' : 'var(--ob-muted)';
  }

  function persist(immediateDb) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    try {
      if (typeof _opsSaveNow === 'function') _opsSaveNow();
      else if (typeof save === 'function') save();
      if (immediateDb && typeof saveToDb === 'function' && typeof _dbAvailable !== 'undefined' && _dbAvailable) saveToDb();
      setSaveState('Saved ' + new Date().toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' }), true);
    } catch (e) {
      setSaveState('Save failed: ' + (e.message || e), false);
    }
  }

  function queueSave() {
    clearTimeout(state.saveTimer);
    setSaveState('Saving…', true);
    state.saveTimer = setTimeout(function () { persist(true); }, 500);
  }

  // ── scroll / focus preservation across a full re-render ──────────────────
  // A full innerHTML swap drops the caret and collapses document height, which
  // used to throw the operator hundreds of pixels back up the page. Snapshot
  // before, restore after. Everything is feature-detected so the render path
  // still runs in the bare test context.
  function captureContext() {
    var snap = { scroll: null, focus: '', start: null, end: null };
    try {
      if (typeof window !== 'undefined' && typeof window.scrollY === 'number') snap.scroll = window.scrollY;
      var active = (typeof document !== 'undefined') ? document.activeElement : null;
      if (active && active.dataset && active.dataset.obFocus) {
        snap.focus = String(active.dataset.obFocus);
        if (typeof active.selectionStart === 'number') {
          snap.start = active.selectionStart;
          snap.end = active.selectionEnd;
        }
      }
    } catch (e) {}
    return snap;
  }

  function restoreContext(snap) {
    if (!snap) return;
    try {
      if (snap.scroll != null && typeof window.scrollTo === 'function') window.scrollTo(0, snap.scroll);
    } catch (e) {}
    if (!snap.focus) return;
    try {
      var root = rootEl();
      if (!root || typeof root.querySelector !== 'function') return;
      var el = root.querySelector('[data-ob-focus="' + snap.focus + '"]');
      if (!el || typeof el.focus !== 'function') return;
      el.focus();
      if (snap.start != null && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(snap.start, snap.end); } catch (e) {}
      }
    } catch (e) {}
  }


  // ── item model ───────────────────────────────────────────────────────────
  function mainAndExtras() {
    var main = (_opsRows || []).map(function (row, index) {
      var target = cleanTarget(row);
      return { row: row, index: index, target: target, extra: false, key: target ? cleanKey(target) : '' };
    });
    var attached = {};
    main.forEach(function (item) {
      if (item.target && item.target !== item.row) attached[cleanKey(item.target)] = true;
    });
    var extra = (_opsCleanExtras || []).filter(function (row) {
      return !attached[cleanKey(row)];
    }).map(function (row) {
      return { row: row, index: -1, target: row, extra: true, key: cleanKey(row) };
    });
    return main.concat(extra);
  }

  function isArrivalOnly(row) {
    return !!(row && (row.isCheckinOnly || row.checkinSameDay === 'checkin_only'));
  }

  function sofaPending(row) {
    return /Prepare [12] sofa bed/i.test(String((row && (row.comments || row.cleanTaskNote)) || ''));
  }

  // _opsApplySameDayPriority auto-sets isPriority on every same-day turnover, so
  // it is true for most of the board and cannot mean "urgent". Only an operator
  // escalation (priorityManual) is a real signal.
  function escalated(row) {
    return (row && row.priorityManual === true);
  }

  // "Blocking" answers a real question — what still stops the day from closing?
  // Finished work and rows that simply have a crew on them are deliberately
  // excluded, which is what makes this segment worth clicking.
  function itemBlocking(item) {
    var row = item.row || {};
    var target = item.target;
    if (isArrivalOnly(row)) return true;
    if (!target) return false;
    if (target.cleanDone) return false;
    if (!cleaners(target).length) return true;
    if (escalated(row) || row.lateCheckout) return true;
    return sofaPending(row);
  }

  function itemUnknownCheckin(item) {
    var row = item.row || {};
    return row.checkinSameDay === 'unknown';
  }

  function itemOpen(item) {
    return isArrivalOnly(item.row) || !!(item.target && !item.target.cleanDone);
  }

  function filteredItems(items) {
    var q = String(state.search || '').toLowerCase().trim();
    var out = items.filter(function (item) {
      var target = item.target;
      var row = item.row || {};
      if (state.filter === 'attention' && !itemBlocking(item)) return false;
      if (state.filter === 'unknown' && !itemUnknownCheckin(item)) return false;
      // Arrival-only check-ins have no clean target — still count as open work.
      if (state.filter === 'open' && !isArrivalOnly(row) && (!target || target.cleanDone)) return false;
      if (state.filter === 'done' && (!target || !target.cleanDone)) return false;
      if (state.filter === 'unassigned' && (!target || cleaners(target).length > 0)) return false;
      if (!q) return true;
      var hay = [item.row.aptName, item.row.comments, item.row.cleanTaskNote, cleaners(target).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    if (state.sort === 'cleaner') {
      out.sort(function (a, b) {
        var ac = String(cleaners(a.target)[0] || 'zzz');
        var bc = String(cleaners(b.target)[0] || 'zzz');
        var byCleaner = ac.localeCompare(bc, 'el', { sensitivity: 'base' });
        if (byCleaner) return byCleaner;
        if (typeof window.aptProximityCompare === 'function') return window.aptProximityCompare(_opsAptOf(a.row), _opsAptOf(b.row));
        return String(a.row.aptName || '').localeCompare(String(b.row.aptName || ''));
      });
    } else if (state.sort === 'status') {
      out.sort(function (a, b) {
        function rank(item) {
          if (isArrivalOnly(item.row)) return 0;
          if (!item.target) return 4;
          if (item.target.cleanDone) return 3;
          if (!cleaners(item.target).length || item.row.checkinSameDay === 'unknown' || escalated(item.row) || item.row.lateCheckout) return 0;
          return 1;
        }
        var diff = rank(a) - rank(b);
        if (diff) return diff;
        return String(a.row.aptName || '').localeCompare(String(b.row.aptName || ''), 'el', { numeric: true });
      });
    }
    return out;
  }

  function itemId(item) {
    var row = (item && item.row) || {};
    var base = item && item.key ? item.key : String(row.aptId || row.aptName || item.index || 'row');
    return (item && item.extra ? 'extra:' : 'row:') + base;
  }

  function selectedItems(items) {
    return items.filter(function (item) { return !!state.selected[itemId(item)]; });
  }

  function resetSelectionForDate() {
    if (state.selectionDate === _opsDate) return;
    state.selectionDate = _opsDate;
    state.selected = {};
    state.focusId = '';
    state.page = 1;
  }

  // ── grouping ─────────────────────────────────────────────────────────────
  // "Sort: default" means the order the data layer produced — it is the one
  // mode that must never be reordered or regrouped on the client.
  function groupingActive() {
    return state.group !== 'none' && state.sort !== 'default';
  }

  function groupLabelFor(item) {
    if (state.group === 'cleaner') {
      var names = cleaners(item.target);
      return names.length ? names.join(' · ') : 'Χωρίς συνεργείο';
    }
    var area = '';
    if (typeof window.aptAreaLabel === 'function' && typeof _opsAptOf === 'function') {
      area = window.aptAreaLabel(_opsAptOf(item.row)) || '';
    }
    return area || 'Χωρίς περιοχή';
  }

  function groupItems(items) {
    if (!groupingActive()) return [{ label: '', items: items }];
    var order = [];
    var byLabel = {};
    items.forEach(function (item) {
      var label = groupLabelFor(item);
      if (!byLabel[label]) { byLabel[label] = []; order.push(label); }
      byLabel[label].push(item);
    });
    return order.map(function (label) { return { label: label, items: byLabel[label] }; });
  }

  // ── notes: managed tags vs operator text ─────────────────────────────────
  // row.comments is the single source of truth the rest of the app reads, so it
  // keeps holding the joined string. The UI just presents the managed tags as
  // chips and gives the operator an input that only owns the free-text part —
  // so editing a note can no longer silently delete a PRIORITY tag.
  var NOTE_SEP = ' · ';

  function tagLate() { return (typeof OPS_TAG_LATE !== 'undefined') ? OPS_TAG_LATE : 'Late Checkout: 12:00'; }
  function tagPriority() { return (typeof OPS_TAG_PRIORITY !== 'undefined') ? OPS_TAG_PRIORITY : 'PRIORITY'; }
  function tagEarly() { return (typeof OPS_TAG_EARLY !== 'undefined') ? OPS_TAG_EARLY : 'Early check-in'; }
  function tagPark() { return (typeof OPS_TAG_PARK !== 'undefined') ? OPS_TAG_PARK : 'Παρκοκρεβάτο'; }

  function splitNotes(note) {
    if (typeof _opsSplitComments === 'function') return _opsSplitComments(note);
    return String(note || '').split(/\s*[·|;]\s*|\n+/).map(function (part) {
      return String(part || '').trim();
    }).filter(Boolean);
  }

  // Flag-backed tags can be removed from the chip, because clearing them has a
  // well-defined owner (_opsSetManagedComment + the row flag). Auto-derived tags
  // (long stay, sofa bed) are read-only: the app re-derives them every render.
  function flagForPart(part) {
    if (part === tagPriority()) return 'priority';
    if (part === tagLate() || /^Late Checkout/i.test(part)) return 'late';
    if (part === tagEarly()) return 'early';
    if (part === tagPark()) return 'park';
    return '';
  }

  function partTone(part) {
    if (part === tagPriority() || part === tagLate() || /^Late Checkout/i.test(part)) return ' hot';
    if (part === tagEarly() || part === tagPark() || /sofa bed/i.test(part)) return ' cool';
    if (/^Long stay/i.test(part)) return ' hot';
    return '';
  }

  function isManagedPart(part) {
    return !!flagForPart(part) || /sofa bed/i.test(part) || /^Long stay/i.test(part);
  }

  function managedParts(note) {
    return splitNotes(note).filter(isManagedPart);
  }

  function freeNoteText(note) {
    return splitNotes(note).filter(function (p) { return !isManagedPart(p); }).join(NOTE_SEP);
  }

  function composeNote(note, freeText) {
    var parts = managedParts(note);
    String(freeText || '').split(/\s*·\s*/).forEach(function (p) {
      var t = String(p || '').trim();
      if (t) parts.push(t);
    });
    return parts.join(NOTE_SEP);
  }

  function noteChipsHtml(note, index, extra) {
    var parts = managedParts(note);
    if (!parts.length) return '';
    return '<div class="ob-nchips">' + parts.map(function (part) {
      var flag = extra ? '' : flagForPart(part);
      var remove = flag
        ? '<button type="button" data-ob-action="flag" data-ob-index="' + index + '" data-ob-flag="' + flag + '" title="Αφαίρεση">×</button>'
        : '';
      return '<span class="ob-nchip' + partTone(part) + '">' + esc(part) + remove + '</span>';
    }).join('') + '</div>';
  }

  // ── row pieces ───────────────────────────────────────────────────────────
  function checkinHtml(row, index) {
    if (row.isCheckinOnly || row.checkinSameDay === 'checkin_only') {
      return '<span class="ob-chip ob-blue">Άφιξη' + (row.nextNights ? ' · ' + esc(row.nextNights) + ' νύχτες' : '') + '</span>';
    }
    var stateName = row.checkinSameDay || 'unknown';
    var cfg = stateName === 'yes'
      ? { cls: 'ob-green', text: 'Ναι' + (row.nextNights ? ' · ' + row.nextNights + ' νύχτες' : '') }
      : stateName === 'no'
        ? { cls: 'ob-red', text: 'Όχι' }
        : { cls: 'ob-amber', text: 'Δεν ξέρουμε' };
    return '<button class="ob-chip ob-checkin ' + cfg.cls + '" data-ob-action="checkin" data-ob-index="' + index + '" title="Εναλλαγή check-in">' + esc(cfg.text) + '</button>';
  }

  var FLAG_DEFS = [
    ['late', '⏰', 'Late checkout', 'lateCheckout', 'hot'],
    ['priority', '❗', 'Priority', 'isPriority', 'hot'],
    ['park', '👶', 'Παρκοκρεβάτο', 'parkBed', 'cool'],
    ['early', '☀️', 'Early check-in', 'earlyCheckin', 'cool'],
  ];

  // Only ACTIVE signals get a cell. Setting an inactive flag happens in the row
  // ⋯ menu, which is what removes ~4 permanent buttons from every single row.
  function signalsHtml(row, index, extra) {
    if (extra) return '<span class="ob-row-muted">—</span>';
    var html = FLAG_DEFS.filter(function (f) {
      // A same-day auto priority is true on most of the board, so it renders as
      // a quiet solid icon instead of a labelled chip.
      return row[f[3]] && !(f[0] === 'priority' && !escalated(row));
    }).map(function (f) {
      return '<button type="button" class="ob-sig ' + f[4] + '" data-ob-action="flag" data-ob-index="' + index + '" data-ob-flag="' + f[0] + '" title="' + esc(f[2]) + ' — κλικ για αφαίρεση">' + f[1] + ' ' + esc(f[2]) + '</button>';
    }).join('');
    if (row.isPriority && !escalated(row)) {
      html += '<button type="button" class="ob-mini-flag hot on" data-ob-action="flag" data-ob-index="' + index + '" data-ob-flag="priority" title="Priority (αυτόματο same-day)" aria-label="Priority">❗</button>';
    }
    if (row.checkinSameDay === 'unknown') {
      html += '<span class="ob-chip ob-amber" title="Άγνωστο check-in">? check-in</span>';
    }
    return '<div class="ob-row-flags">' + (html || '<span class="ob-row-muted">—</span>') + '</div>';
  }

  function rowToneClass(item) {
    var row = (item && item.row) || {};
    var target = item && item.target;
    if (target && target.cleanDone) return 'tone-done';
    if (!target && !isArrivalOnly(row)) return 'tone-excluded';
    if (escalated(row) || row.lateCheckout || sofaPending(row)) return 'tone-hot';
    if (target && !cleaners(target).length) return 'tone-warn';
    if (row.checkinSameDay === 'unknown') return 'tone-warn';
    if (isArrivalOnly(row) || row.checkinSameDay === 'yes' || row.earlyCheckin) return 'tone-same';
    return 'tone-open';
  }

  function cleanerRoster() {
    var out = [];
    (Array.isArray(S.cleaners) ? S.cleaners : []).forEach(function (entry) {
      var name = typeof entry === 'string' ? entry : (entry && entry.name);
      if (!name || out.indexOf(name) >= 0) return;
      if (typeof _opsIsCleanerRole === 'function' && !_opsIsCleanerRole(name)) return;
      out.push(name);
    });
    return out.sort(function (a, b) { return String(a).localeCompare(String(b), 'el', { sensitivity: 'base' }); });
  }

  function workloadMap(items) {
    var load = {};
    items.forEach(function (item) {
      cleaners(item.target).forEach(function (name) {
        load[name] = (load[name] || 0) + 1;
      });
    });
    return load;
  }

  // Assigning crew is the primary action on this board, so it gets a real
  // popover that shows today's load per person instead of a bare datalist.
  function assignPopHtml(key, load) {
    var roster = cleanerRoster();
    var peak = 1;
    roster.forEach(function (name) { peak = Math.max(peak, load[name] || 0); });
    var rows = roster.map(function (name) {
      var n = load[name] || 0;
      var pct = Math.round((n / peak) * 100);
      var band = n === 0 || n <= peak / 3 ? ' ob-low' : (n >= peak ? ' ob-high' : '');
      return '<button type="button" class="ob-pop-row" data-ob-action="assign-pick" data-ob-key="' + encoded(key) + '" data-ob-name="' + esc(name) + '">' +
        '<span class="ob-av">' + esc(initials(name)) + '</span>' +
        '<span class="ob-nm">' + esc(name) + '</span>' +
        '<span class="ob-ld' + band + '"><u><b style="width:' + pct + '%"></b></u>' + n + '</span>' +
        '</button>';
    }).join('');
    return '<div class="ob-pop">' +
      '<h6>Ανάθεση συνεργείου · φόρτος ημέρας</h6>' + rows +
      '<input class="ob-input ob-row-cleaner" list="ops-beta-cleaners" value="" placeholder="Καθαρίστρια…" data-ob-action="cleaner-add" data-ob-focus="assign:' + esc(key) + '" data-ob-key="' + encoded(key) + '">' +
      '</div>';
  }

  function cleanerChipsHtml(item, load) {
    var target = item.target;
    if (!target) return '<span class="ob-row-muted">—</span>';
    var key = cleanKey(target);
    var id = itemId(item);
    var names = cleaners(target);
    var open = state.assignFor === id;
    var chips = names.map(function (nm, ni) {
      return '<span class="ob-cchip">' + esc(nm) +
        '<button type="button" data-ob-action="cleaner-remove" data-ob-key="' + encoded(key) + '" data-ob-idx="' + ni + '" title="Αφαίρεση">×</button></span>';
    }).join('');
    var trigger = names.length
      ? '<button type="button" class="ob-cadd" data-ob-action="assign-open" data-ob-id="' + encoded(id) + '" title="Προσθήκη ατόμου">+</button>'
      : '<button type="button" class="ob-assign" data-ob-action="assign-open" data-ob-id="' + encoded(id) + '">+ Ανάθεση</button>';
    return '<div class="ob-cchips-wrap">' +
      (chips ? '<div class="ob-cchips">' + chips + '</div>' : '') +
      trigger +
      (open ? assignPopHtml(key, load) : '') +
      '</div>';
  }

  function rowMenuHtml(item) {
    var row = item.row || {};
    var kinds = (typeof OPS_KINDS !== 'undefined' && Array.isArray(OPS_KINDS)) ? OPS_KINDS : [];
    var flagButtons = FLAG_DEFS.map(function (f) {
      var on = !!row[f[3]];
      return '<button type="button" class="' + (on ? 'ob-on' : '') + '" data-ob-action="flag" data-ob-index="' + item.index + '" data-ob-flag="' + f[0] + '">' +
        f[1] + ' ' + esc(f[2]) + (on ? ' ✓' : '') + '</button>';
    }).join('');
    var kindButtons = kinds.map(function (kind) {
      var on = !!row[kind.key];
      return '<button type="button" class="' + (on ? 'ob-on' : '') + '" data-ob-action="kind" data-ob-index="' + item.index + '" data-ob-kind="' + esc(kind.key) + '">' +
        (on ? '✓ ' : '') + esc(kind.label || kind.key) + '</button>';
    }).join('');
    return '<div class="ob-menu">' +
      '<h6>Σήματα</h6>' + flagButtons +
      (kindButtons ? '<hr><h6>Τύπος κράτησης</h6>' + kindButtons : '') +
      '<hr>' +
      '<button type="button" class="ob-danger" data-ob-action="row-remove" data-ob-index="' + item.index + '">Αφαίρεση γραμμής</button>' +
      '</div>';
  }

  function dispatchRowHtml(item, displayNumber, load) {
    var row = item.row || {};
    var target = item.target;
    var id = itemId(item);
    var selected = !!state.selected[id];
    var done = !!(target && target.cleanDone);
    var lines = (typeof _opsAptLines === 'function') ? _opsAptLines(row) : { name: row.aptName || '', addr: '' };
    var area = (typeof window.aptAreaLabel === 'function' && typeof _opsAptOf === 'function') ? window.aptAreaLabel(_opsAptOf(row)) : '';
    var type = target ? cleanType(target) : null;
    var kind = kindOf(row);
    var names = cleaners(target).join(', ');
    var note = String(row.comments || row.cleanTaskNote || '');
    var keyAttr = target ? ' data-ob-key="' + encoded(item.key) + '"' : '';
    var statusClass = done ? 'done' : (!target ? 'excluded' : (!names ? 'unassigned' : 'open'));
    var toneClass = rowToneClass(item);
    var statusText = done ? 'DONE' : (!target ? 'NO CLEAN' : (!names ? 'UNASSIGNED' : 'OPEN'));
    var checkin = item.extra ? '<span class="ob-row-muted">—</span>' : checkinHtml(row, item.index);
    var cleanControl = target
      ? '<input class="ob-clean-check" type="checkbox" data-ob-action="clean" data-ob-key="' + encoded(item.key) + '"' + (done ? ' checked' : '') + ' title="Καθαρίστηκε">'
      : '<span class="ob-row-muted">—</span>';
    var cleanerControl = cleanerChipsHtml(item, load);
    var taskControl = target
      ? '<select class="ob-select ob-row-task" data-ob-action="clean-field" data-ob-key="' + encoded(item.key) + '" data-ob-field="cleanTask" data-ob-focus="task:' + esc(item.key) + '">' + taskOptions(target.cleanTask) + '</select>'
      : '<span class="ob-row-muted">—</span>';
    var paxControl = item.extra
      ? '<span class="ob-row-muted">' + esc(row.people || '—') + '</span>'
      : '<input class="ob-input ob-row-pax" type="number" min="0" max="20" value="' + esc(row.people || '') + '" data-ob-action="row-field" data-ob-index="' + item.index + '" data-ob-field="people" data-ob-focus="pax:' + item.index + '" placeholder="—" title="Άτομα">';
    var etaControl = item.extra
      ? '<span class="ob-row-muted">—</span>'
      : '<input class="ob-input ob-row-eta" value="' + esc(row.arrivalTime || '') + '" data-ob-action="row-field" data-ob-index="' + item.index + '" data-ob-field="arrivalTime" data-ob-focus="eta:' + item.index + '" placeholder="ETA" title="Ώρα άφιξης">';
    var noteInput = item.extra
      ? '<input class="ob-input ob-row-note" value="' + esc(freeNoteText(note)) + '" data-ob-action="clean-field" data-ob-key="' + encoded(item.key) + '" data-ob-field="comments" data-ob-focus="note:' + esc(item.key) + '" placeholder="Σημείωση…">'
      : '<input class="ob-input ob-row-note" value="' + esc(freeNoteText(note)) + '" data-ob-action="comment" data-ob-index="' + item.index + '"' + keyAttr + ' data-ob-focus="note:' + item.index + '" placeholder="Σημείωση…">';
    var noteControl = '<div class="ob-note-cell">' + noteChipsHtml(note, item.index, item.extra) + noteInput + '</div>';
    var badges = (type ? '<span class="ob-row-type ' + type.cls + '">' + esc(type.label) + '</span>' : '') +
      (kind ? '<span class="ob-row-type ob-amber">' + esc(kind.label) + '</span>' : '') +
      (row.isOwner ? '<span class="ob-row-type ob-red">OWNER</span>' : '');
    var stayLabel = row.isCheckinOnly ? 'Μόνο άφιξη' : 'CO';
    // Card mode hides cells that carry nothing, so a bare arrival does not
    // spend four empty bands of vertical space.
    var emptySig = item.extra || !(row.lateCheckout || row.parkBed || row.earlyCheckin || row.isPriority || row.checkinSameDay === 'unknown');
    var emptyCrew = !target;
    var emptyTask = !target;
    var menuOpen = state.menuFor === id;
    var actions = item.extra
      ? ''
      : '<button type="button" class="ob-rowmenu-btn" data-ob-action="row-menu" data-ob-id="' + encoded(id) + '" title="Ενέργειες γραμμής" aria-label="Ενέργειες γραμμής">⋯</button>' +
        (menuOpen ? rowMenuHtml(item) : '');

    return '<tr class="ob-dispatch-row ' + statusClass + ' ' + toneClass + (selected ? ' selected' : '') + '" data-ob-id="' + encoded(id) + '">' +
      '<td class="ob-c-sel ob-center"><input type="checkbox" class="ob-sel-check" data-ob-action="select" data-ob-id="' + encoded(id) + '"' + (selected ? ' checked' : '') + (target ? '' : ' disabled') + ' aria-label="Επιλογή ' + esc(lines.name || row.aptName) + '"></td>' +
      '<td class="ob-c-tick ob-center">' + cleanControl + '</td>' +
      '<td class="ob-c-prop ob-property-cell"><div class="ob-property-line"><span class="ob-num">' + displayNumber + '</span><b>' + esc(lines.name || row.aptName || 'Apartment') + '</b>' + badges + '</div><small>' + esc([area, lines.addr].filter(Boolean).join(' · ')) + '</small></td>' +
      '<td class="ob-c-stay"><div class="ob-stay-line"><span class="ob-stay-co">' + stayLabel + '</span>' + checkin + '</div><div class="ob-stay-line">' + paxControl + etaControl + '</div></td>' +
      '<td class="ob-c-sig' + (emptySig ? ' ob-cell-empty' : '') + '">' + signalsHtml(row, item.index, item.extra) + '</td>' +
      '<td class="ob-c-crew' + (emptyCrew ? ' ob-cell-empty' : '') + '">' + cleanerControl + '</td>' +
      '<td class="ob-c-task' + (emptyTask ? ' ob-cell-empty' : '') + '">' + taskControl + '</td>' +
      '<td class="ob-c-note">' + noteControl + '</td>' +
      '<td class="ob-c-status"><span class="ob-row-status ' + statusClass + '"><i></i>' + statusText + '</span></td>' +
      '<td class="ob-c-act ob-act-cell">' + actions + '</td>' +
      '</tr>';
  }

  function groupRowHtml(group, colspan) {
    var total = group.items.length;
    var done = group.items.filter(function (i) { return i.target && i.target.cleanDone; }).length;
    var crew = {};
    group.items.forEach(function (i) { cleaners(i.target).forEach(function (n) { crew[n] = true; }); });
    var crewCount = Object.keys(crew).length;
    var pct = total ? Math.round((done * 100) / total) : 0;
    return '<tr class="ob-grp"><td colspan="' + colspan + '"><div class="ob-grp-line">' +
      '<span>' + esc(group.label) + '</span>' +
      '<em>' + total + ' ακίνητα · ' + crewCount + ' συνεργεία</em>' +
      '<span class="ob-spacer"></span>' +
      '<span class="ob-grp-bar"><span style="width:' + pct + '%"></span></span>' +
      '<em>' + done + '/' + total + '</em>' +
      '</div></td></tr>';
  }

  // ── chrome ───────────────────────────────────────────────────────────────
  function bulkBarHtml(filtered, allItems) {
    var selected = selectedItems(allItems);
    var count = selected.length;
    var actionable = filtered.filter(function (item) { return !!item.target; });
    var allFilteredSelected = !!actionable.length && actionable.every(function (item) { return !!state.selected[itemId(item)]; });
    var roster = cleanerRoster();
    var options = '<option value="">Assign cleaner…</option>' + roster.map(function (name) {
      return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
    }).join('');
    var taskOpts = '<option value="">Set task…</option>' + taskOptions('__none__').replace(/ selected/g, '');
    if (!count) {
      return '<div class="ob-bulk-idle">' +
        '<span>Επίλεξε γραμμές για μαζικές ενέργειες.</span>' +
        '<button class="ob-btn ob-sm" data-ob-action="select-all-results"' + (!actionable.length || allFilteredSelected ? ' disabled' : '') + '>Select all ' + actionable.length + ' actionable</button>' +
        '</div>';
    }
    return '<div class="ob-bulk active">' +
      '<b>' + count + ' selected</b>' +
      '<button class="ob-btn ob-sm" data-ob-action="select-all-results"' + (!actionable.length || allFilteredSelected ? ' disabled' : '') + '>Select all ' + actionable.length + ' actionable</button>' +
      '<select class="ob-select" data-ob-action="bulk-cleaner">' + options + '</select>' +
      '<select class="ob-select" data-ob-action="bulk-task">' + taskOpts + '</select>' +
      '<button class="ob-btn ob-sm ob-success" data-ob-action="bulk-done">✓ Mark clean</button>' +
      '<button class="ob-btn ob-sm" data-ob-action="bulk-open">Reopen</button>' +
      '<span class="ob-spacer"></span>' +
      '<button class="ob-btn ob-sm" data-ob-action="clear-selection">Clear</button>' +
      '</div>';
  }

  function pagerHtml(page, pageCount, total, size) {
    var all = !Number(state.pageSize);
    return '<div class="ob-pager"><span>' + total + ' matching rows' + (all ? '' : (' · page size ' + size)) + '</span><span class="ob-spacer"></span>' +
      '<button class="ob-btn ob-square" data-ob-action="page" data-ob-page="' + (page - 1) + '"' + (page <= 1 || all ? ' disabled' : '') + ' aria-label="Προηγούμενη σελίδα">←</button>' +
      '<b>' + (all ? 'Showing all' : ('Page ' + page + ' / ' + pageCount)) + '</b>' +
      '<button class="ob-btn ob-square" data-ob-action="page" data-ob-page="' + (page + 1) + '"' + (page >= pageCount || all ? ' disabled' : '') + ' aria-label="Επόμενη σελίδα">→</button>' +
      '<select class="ob-select" data-ob-action="page-size" title="Rows shown in the table">' +
      '<option value="0"' + (all ? ' selected' : '') + '>Fit all rows</option>' +
      '<option value="25"' + (state.pageSize === 25 ? ' selected' : '') + '>25 rows</option>' +
      '<option value="50"' + (state.pageSize === 50 ? ' selected' : '') + '>50 rows</option>' +
      '<option value="100"' + (state.pageSize === 100 ? ' selected' : '') + '>100 rows</option>' +
      '</select></div>';
  }

  function colorLegendHtml() {
    return '<div class="ob-tone-legend" title="Reservation color coding">' +
      '<span class="ob-tone-lg"><i class="tone-hot"></i>Priority / late / sofa</span>' +
      '<span class="ob-tone-lg"><i class="tone-warn"></i>Unassigned / CI unknown</span>' +
      '<span class="ob-tone-lg"><i class="tone-same"></i>Same-day / Early</span>' +
      '<span class="ob-tone-lg"><i class="tone-open"></i>Normal open</span>' +
      '<span class="ob-tone-lg"><i class="tone-done"></i>Clean ✓ done</span>' +
      '<span class="ob-spacer"></span>' +
      '<span class="ob-tone-lg">Σήματα: ⏰ Late checkout · ❗ Priority · 👶 Παρκοκρεβάτο · ☀️ Early check-in</span>' +
      '</div>';
  }

  function cleanerDatalist() {
    var names = [];
    if (Array.isArray(S.cleaners)) {
      S.cleaners.forEach(function (entry) {
        var name = typeof entry === 'string' ? entry : (entry && entry.name);
        if (name && names.indexOf(name) < 0) names.push(name);
      });
    }
    return '<datalist id="ops-beta-cleaners">' + names.sort().map(function (name) { return '<option value="' + esc(name) + '"></option>'; }).join('') + '</datalist>';
  }

  function activeTasks() {
    if (!S.daily || !Array.isArray(S.daily.tasks)) return [];
    return S.daily.tasks.filter(function (task) {
      if (task.createdDate > _opsDate) return false;
      if (task.completed && task.completedDate < _opsDate) return false;
      return true;
    });
  }

  function aptOptionsHtml(current) {
    var list = (S.apts || []).slice().sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''), 'el');
    });
    return '<option value="">Χωρίς ακίνητο</option>' + list.map(function (apt) {
      return '<option value="' + esc(apt.id) + '"' + (String(current || '') === String(apt.id) ? ' selected' : '') + '>' + esc(apt.name) + '</option>';
    }).join('');
  }

  function tasksHtml(tasks) {
    var html = '<div class="ob-tasks">';
    if (!tasks.length) html += '<span style="font-size:11px;color:var(--ob-muted)">No tasks for this day</span>';
    tasks.forEach(function (task) {
      var apt = task.aptName || '';
      if (!apt && task.aptId) {
        var hit = (S.apts || []).find(function (a) { return a.id === task.aptId; });
        apt = hit ? hit.name : '';
      }
      html += '<label class="ob-task' + (task.completed ? ' ob-task-done' : '') + '"><input type="checkbox" data-ob-action="task-toggle" data-ob-id="' + esc(task.id) + '"' + (task.completed ? ' checked' : '') + '>' +
        '<span>' + (apt ? '<b>' + esc(apt) + ':</b> ' : '') + esc(task.text) + '</span>' +
        '<button type="button" data-ob-action="task-delete" data-ob-id="' + esc(task.id) + '" title="Διαγραφή">×</button></label>';
    });
    html += '<span class="ob-spacer"></span>';
    if (!state.composer) html += '<button class="ob-btn ob-sm" data-ob-action="task-open">+ Add task</button>';
    html += '</div>';
    if (state.composer) {
      html += '<div class="ob-composer">' +
        '<input class="ob-input" data-ob-action="task-text" data-ob-focus="task-text" value="' + esc(state.draftText) + '" placeholder="Νέα εργασία για ' + esc(dateLabel(_opsDate)) + '…">' +
        '<select class="ob-select" data-ob-action="task-apt">' + aptOptionsHtml(state.draftApt) + '</select>' +
        '<button class="ob-btn ob-sm ob-primary" data-ob-action="task-save">Προσθήκη</button>' +
        '<button class="ob-btn ob-sm" data-ob-action="task-cancel">Άκυρο</button>' +
        '</div>';
    }
    return html;
  }

  // ── staff / routes ───────────────────────────────────────────────────────
  function personNamesFor(block, current) {
    var list = [];
    if (typeof _opsAvailableCleaners === 'function') list = _opsAvailableCleaners(current || '', block) || [];
    else if (Array.isArray(S.cleaners)) list = S.cleaners.map(function (x) { return typeof x === 'string' ? x : x.name; }).filter(Boolean);
    if (current && list.indexOf(current) < 0) list.unshift(current);
    return list;
  }

  function personSelect(block, index, current) {
    var options = '<option value="">—</option>' + personNamesFor(block, current).map(function (name) {
      return '<option value="' + esc(name) + '"' + (String(name).toLowerCase() === String(current || '').toLowerCase() ? ' selected' : '') + '>' + esc(name) + '</option>';
    }).join('');
    return '<select class="ob-select" data-ob-action="staff" data-ob-block="' + esc(block) + '" data-ob-index="' + index + '">' + options + '</select>';
  }

  function staffCard(title, block, baseRows, extra, leave) {
    var rowExtra = Number((extra._rows || {})[block] || 0);
    var count = baseRows + rowExtra;
    var values = extra[block] || {};
    var html = '<div class="ob-staff-card"><h4>' + esc(title) + '</h4>';
    for (var i = 0; i < count; i++) {
      html += '<div class="ob-staff-row">' + personSelect(block, i, String(values[i] || ''));
      if (leave) {
        var days = Number(((extra.adeiesDur || {})[i]) || 1);
        html += '<input class="ob-input" style="width:52px;flex:0 0 52px" type="number" min="1" max="30" value="' + days + '" data-ob-action="leave-days" data-ob-index="' + i + '" data-ob-focus="leave:' + i + '" title="Ημέρες άδειας">';
      }
      html += '</div>';
    }
    return html + '<button class="ob-btn ob-staff-add" data-ob-action="staff-add" data-ob-block="' + esc(block) + '">+ row</button></div>';
  }

  function routeStops(index) {
    if (typeof _opsDriverRoutes === 'function') return _opsDriverRoutes(index) || [];
    var day = (S.daily.extra && S.daily.extra[_opsDate]) || {};
    if (!day.odigoiRoutes) day.odigoiRoutes = {};
    if (!Array.isArray(day.odigoiRoutes[index])) day.odigoiRoutes[index] = [];
    return day.odigoiRoutes[index];
  }

  function driversHtml(extra) {
    var count = 2 + Number((extra._rows || {}).odigoi || 0);
    var values = extra.odigoi || {};
    var aptOptions = (typeof _opsScheduleAptOptions === 'function') ? _opsScheduleAptOptions() : [];
    var html = '<div class="ob-staff-card ob-wide"><h4>ΟΔΗΓΟΙ / ΔΙΑΔΡΟΜΕΣ</h4><div class="ob-drivers-grid">';
    for (var i = 0; i < count; i++) {
      var stops = routeStops(i);
      html += '<div class="ob-driver"><div class="ob-staff-row"><input class="ob-input" list="ops-beta-drivers" value="' + esc(values[i] || '') + '" data-ob-action="staff" data-ob-block="odigoi" data-ob-index="' + i + '" data-ob-focus="driver:' + i + '" placeholder="οδηγός"></div>' +
        '<div class="ob-route-chips">' + stops.map(function (stop, stopIndex) {
          return '<span class="ob-route-chip">' + esc(stop.name || stop.key) + '<button type="button" data-ob-action="route-remove" data-ob-driver="' + i + '" data-ob-stop="' + stopIndex + '">×</button></span>';
        }).join('') + '</div>' +
        '<select class="ob-select" style="width:100%" data-ob-action="route-add" data-ob-driver="' + i + '"><option value="">+ apartment stop…</option>' +
        aptOptions.map(function (opt) {
          var used = stops.some(function (stop) { return stop.key === opt.key; });
          return '<option value="' + esc(opt.key) + '"' + (used ? ' disabled' : '') + '>' + esc(opt.title || opt.name) + '</option>';
        }).join('') + '</select></div>';
    }
    return html + '</div><button class="ob-btn ob-staff-add" data-ob-action="staff-add" data-ob-block="odigoi">+ driver</button></div>';
  }

  function driverDatalist() {
    var names = [];
    if (Array.isArray(S.drivers)) {
      S.drivers.forEach(function (entry) {
        var name = typeof entry === 'string' ? entry : (entry && entry.name);
        if (name && names.indexOf(name) < 0) names.push(name);
      });
    }
    return '<datalist id="ops-beta-drivers">' + names.map(function (name) { return '<option value="' + esc(name) + '"></option>'; }).join('') + '</datalist>';
  }

  function staffHtml() {
    if (typeof _opsSyncUnassignedToRepo === 'function') {
      try { _opsSyncUnassignedToRepo(); } catch (e) {}
    }
    _opsEnsure();
    var extra = S.daily.extra[_opsDate] || {};
    return '<div class="ob-staff-grid">' +
      staffCard('ΕΦΗΜΕΡΙΑ', 'oncall', 1, extra, false) +
      staffCard('ΡΕΠΟ', 'repo', 5, extra, false) +
      staffCard('ΑΔΕΙΕΣ', 'adeies', 5, extra, true) +
      '<div class="ob-staff-card"><h4>ΙΜΑΤΙΣΜΟΣ</h4><div class="ob-label">Χολαργός</div><div class="ob-staff-row">' + personSelect('imatismos_cholargos', 0, String(((extra.imatismos_cholargos || {})[0]) || '')) + '</div>' +
      '<div class="ob-label" style="margin-top:8px">Θεσσαλονίκη</div><div class="ob-staff-row">' + personSelect('imatismos_thess', 0, String(((extra.imatismos_thess || {})[0]) || '')) + '</div></div>' +
      driversHtml(extra) + '</div>' + driverDatalist();
  }

  function setStaff(block, index, value) {
    _opsEnsure();
    if (!S.daily.extra[_opsDate]) S.daily.extra[_opsDate] = {};
    if (!S.daily.extra[_opsDate][block]) S.daily.extra[_opsDate][block] = {};
    var previous = S.daily.extra[_opsDate][block][index];
    S.daily.extra[_opsDate][block][index] = value;
    if (block === 'adeies' && typeof _opsSyncAdeiaRange === 'function') _opsSyncAdeiaRange(index);
    if (block === 'odigoi' && String(previous || '') !== String(value || '') && typeof _opsRewriteDriverRouteComments === 'function') {
      _opsRewriteDriverRouteComments(index, previous, value);
    }
    if (block !== 'repo' && typeof _opsSyncUnassignedToRepo === 'function') _opsSyncUnassignedToRepo();
    if (typeof save === 'function') save();
    if (typeof saveToDb === 'function' && typeof _dbAvailable !== 'undefined' && _dbAvailable) saveToDb();
  }

  function addStaffRow(block) {
    _opsEnsure();
    if (!S.daily.extra[_opsDate]) S.daily.extra[_opsDate] = {};
    if (!S.daily.extra[_opsDate]._rows) S.daily.extra[_opsDate]._rows = {};
    S.daily.extra[_opsDate]._rows[block] = Number(S.daily.extra[_opsDate]._rows[block] || 0) + 1;
    if (typeof save === 'function') save();
  }

  function setLeaveDays(index, value) {
    _opsEnsure();
    if (!S.daily.extra[_opsDate]) S.daily.extra[_opsDate] = {};
    if (!S.daily.extra[_opsDate].adeiesDur) S.daily.extra[_opsDate].adeiesDur = {};
    var days = parseInt(value, 10);
    if (!isFinite(days) || days < 1) days = 1;
    if (days > 30) days = 30;
    S.daily.extra[_opsDate].adeiesDur[index] = days;
    if (typeof _opsSyncAdeiaRange === 'function') _opsSyncAdeiaRange(index);
    if (typeof save === 'function') save();
  }

  function addRoute(driverIndex, aptKey) {
    if (!aptKey) return;
    var options = (typeof _opsScheduleAptOptions === 'function') ? _opsScheduleAptOptions() : [];
    var hit = options.find(function (option) { return option.key === aptKey; });
    if (!hit) return;
    var stops = routeStops(driverIndex);
    if (stops.some(function (stop) { return stop.key === aptKey; })) return;
    stops.push({ key: hit.key, name: hit.name });
    var day = (S.daily.extra && S.daily.extra[_opsDate]) || {};
    var driver = String(((day.odigoi || {})[driverIndex]) || '').trim();
    var row = (typeof _opsFindRow === 'function') ? _opsFindRow(aptKey) : null;
    var tag = (typeof _opsDriverRouteTag === 'function') ? _opsDriverRouteTag(driver || ('Driver ' + (driverIndex + 1))) : '';
    if (row && tag && typeof _opsSetManagedComment === 'function') _opsSetManagedComment(row, tag, true);
    persist(true);
  }

  function removeRoute(driverIndex, stopIndex) {
    var stops = routeStops(driverIndex);
    var stop = stops[stopIndex];
    if (!stop) return;
    stops.splice(stopIndex, 1);
    var day = (S.daily.extra && S.daily.extra[_opsDate]) || {};
    var driver = String(((day.odigoi || {})[driverIndex]) || '').trim();
    var row = (typeof _opsFindRow === 'function') ? _opsFindRow(stop.key) : null;
    var tag = (typeof _opsDriverRouteTag === 'function') ? _opsDriverRouteTag(driver || ('Driver ' + (driverIndex + 1))) : '';
    if (row && tag && typeof _opsSetManagedComment === 'function') _opsSetManagedComment(row, tag, false);
    persist(true);
  }

  function statusSummary(items) {
    var open = items.filter(itemOpen).length;
    var unassigned = items.filter(function (item) { return item.target && !cleaners(item.target).length; }).length;
    var decisions = items.filter(itemBlocking).length;
    var unknown = items.filter(itemUnknownCheckin).length;
    var arrivals = items.filter(function (item) { return isArrivalOnly(item.row); }).length;
    return { open: open, unassigned: unassigned, decisions: decisions, unknown: unknown, arrivals: arrivals };
  }

  // ── render ───────────────────────────────────────────────────────────────
  var COLSPAN = 10;

  function dayBarHtml(cleanDay, pct, summary, tasks, isToday) {
    var dash = 88;
    var offset = Math.round(dash - (dash * pct) / 100);
    var menu = state.barMenu
      ? '<div class="ob-menu">' +
          '<h6>Κοινοποίηση</h6>' +
          '<button type="button" data-ob-action="ops-image">📋 Ops image</button>' +
          '<button type="button" data-ob-action="cleaner-image">🧹 Cleaner image</button>' +
          '<button type="button" data-ob-action="copy-list">📝 Αντιγραφή λίστας (κείμενο)</button>' +
          '<hr>' +
          '<h6>Πρόγραμμα</h6>' +
          '<button type="button" data-ob-action="schedule-check">📸 Check schedule</button>' +
          '<button type="button" data-ob-action="manage-cleaners">🧑‍🤝‍🧑 Καθαρίστριες</button>' +
          '<hr>' +
          '<button type="button" class="ob-danger" data-ob-action="restart">Restart ✓ (μηδενισμός)</button>' +
        '</div>'
      : '';
    return '<div class="ob-command">' +
      '<div class="ob-title"><span class="ob-title-mark">OPS</span><b>Daily Ops</b></div>' +
      '<div class="ob-datenav">' +
        '<button class="ob-btn ob-square" data-ob-action="nav" data-ob-days="-1" title="Προηγούμενη ημέρα" aria-label="Προηγούμενη ημέρα">←</button>' +
        '<button class="ob-btn' + (isToday ? ' ob-primary' : '') + '" data-ob-action="today">Today</button>' +
        '<button class="ob-btn ob-square" data-ob-action="nav" data-ob-days="1" title="Επόμενη ημέρα" aria-label="Επόμενη ημέρα">→</button>' +
      '</div>' +
      '<input class="ob-input ob-date" type="date" value="' + esc(_opsDate) + '" data-ob-action="date" data-ob-focus="date">' +
      '<div class="ob-ring" title="' + pct + '% καθαρισμένα">' +
        '<svg width="34" height="34"><circle cx="17" cy="17" r="14" fill="none" stroke="#e8ecf1" stroke-width="4"></circle>' +
        '<circle cx="17" cy="17" r="14" fill="none" stroke="#15764c" stroke-width="4" stroke-linecap="round" stroke-dasharray="' + dash + '" stroke-dashoffset="' + offset + '"></circle></svg>' +
        '<b>' + pct + '%</b></div>' +
      '<div class="ob-kpis">' +
        '<div class="ob-kpi"><b>' + cleanDay.done + '/' + cleanDay.total + '</b><span>Clean</span></div>' +
        '<div class="ob-kpi' + (summary.unassigned ? ' ob-alert' : '') + '"><b>' + summary.unassigned + '</b><span>Unassigned</span></div>' +
        '<div class="ob-kpi"><b>' + summary.arrivals + '</b><span>Arrivals</span></div>' +
        '<div class="ob-kpi ob-hide-sm"><b>' + tasks.filter(function (t) { return !t.completed; }).length + '</b><span>Tasks</span></div>' +
      '</div>' +
      '<span class="ob-spacer"></span>' +
      '<span class="ob-save-state"><i></i><span id="ops-beta-save-state">Auto-save on</span></span>' +
      '<button class="ob-btn ob-hide-sm" data-ob-action="manage-cleaners" title="Add or remove cleaners">Καθαρίστριες</button>' +
      '<div class="ob-menu-host">' +
        '<button class="ob-btn ob-primary" data-ob-action="bar-menu">Κοινοποίηση ▾</button>' + menu +
      '</div>' +
      '<input type="file" id="ops-beta-schedule-file" accept="image/*" data-ob-action="schedule-file" hidden>' +
      '</div>';
  }

  function railHtml(allItems, summary, cleanDay) {
    var segs = [
      ['all', 'All', allItems.length, ''],
      ['attention', 'Blocking', summary.decisions, 'ob-d-hot'],
      ['unknown', 'Unknown check-in', summary.unknown, 'ob-d-warn'],
      ['open', 'Open', summary.open, 'ob-d-cool'],
      ['unassigned', 'Unassigned', summary.unassigned, 'ob-d-warn'],
      ['done', 'Done', cleanDay.done, 'ob-d-ok'],
    ];
    var filters = segs.map(function (seg) {
      // The plain "Label N" title doubles as the accessible name for the pill.
      var plain = seg[1] + ' ' + seg[2];
      return '<button class="ob-filter' + (state.filter === seg[0] ? ' on' : '') + (seg[0] === 'attention' ? ' ob-blocking' : '') +
        '" data-ob-action="filter" data-ob-filter="' + seg[0] + '" title="' + esc(plain) + '" aria-label="' + esc(plain) + '">' +
        (seg[3] ? '<i class="' + seg[3] + '"></i>' : '') + esc(seg[1]) + ' <em>' + seg[2] + '</em></button>';
    }).join('');
    return '<div class="ob-rail"><div class="ob-segs">' + filters + '</div>' +
      '<div class="ob-railtools">' +
        '<input class="ob-input ob-search" value="' + esc(state.search) + '" data-ob-action="search" data-ob-focus="search" placeholder="Search apartment, cleaner or comment…">' +
        '<select class="ob-select" data-ob-action="group" title="Ομαδοποίηση">' +
          '<option value="area"' + (state.group === 'area' ? ' selected' : '') + '>Group: area</option>' +
          '<option value="cleaner"' + (state.group === 'cleaner' ? ' selected' : '') + '>Group: cleaner</option>' +
          '<option value="none"' + (state.group === 'none' ? ' selected' : '') + '>Group: none</option>' +
        '</select>' +
        '<select class="ob-select" data-ob-action="sort">' +
          '<option value="status"' + (state.sort === 'status' ? ' selected' : '') + '>Sort: status</option>' +
          '<option value="cleaner"' + (state.sort === 'cleaner' ? ' selected' : '') + '>Sort: cleaner / route</option>' +
          '<option value="default"' + (state.sort === 'default' ? ' selected' : '') + '>Sort: default (ungrouped)</option>' +
        '</select>' +
      '</div>' +
      '</div>';
  }

  function paint() {
    var root = document.getElementById('tab-ops');
    if (!root) return;
    window._opsFastSave = true;
    if (typeof startDbPoll === 'function') {
      try { startDbPoll(); } catch (e) {}
    }
    if (typeof _opsEnsure !== 'function' || typeof _opsLoadData !== 'function') {
      root.innerHTML = '<div style="padding:24px;color:var(--tx-err)">Daily Ops data helpers are not available.</div>';
      return;
    }
    _opsEnsure();
    if (!_opsDate) _opsDate = (typeof _opsDefaultOpsDate === 'function') ? _opsDefaultOpsDate() : today();
    if (typeof _opsPrefetchRentalInfo === 'function') _opsPrefetchRentalInfo();
    // _opsLoadData rebuilds _opsRows from the saved snapshot, so a repaint that
    // lands inside the 500ms save debounce (notably the background DB poll)
    // would throw away whatever the operator is typing right now. Flush first.
    if (state.saveTimer) persist(false);

    // Row removal is board-local in Daily Ops (legacy opsRemoveRow only repainted
    // the tbody): _opsAutoRows rebuilds from live bookings, so a reload here
    // would resurrect the row immediately. Repaint from the current array.
    var loaded;
    if (state.skipReload) {
      state.skipReload = false;
      loaded = { rows: _opsRows || [], notes: _opsNotes || '' };
    } else {
      loaded = _opsLoadData(_opsDate);
    }
    _opsRows = loaded.rows || [];
    _opsNotes = loaded.notes || '';
    if (typeof _opsApplySofaCommentsAll === 'function') _opsApplySofaCommentsAll();
    if (typeof _opsApplySameDayPriorityAll === 'function') _opsApplySameDayPriorityAll();
    var cleanDay = (typeof _opsPrepareCleanDay === 'function') ? _opsPrepareCleanDay() : { done: 0, total: 0, extras: [] };
    var allItems = mainAndExtras();
    resetSelectionForDate();
    var visibleItems = filteredItems(allItems);
    var size = pageSizeFor(visibleItems.length);
    var pageCount = Math.max(1, Math.ceil((visibleItems.length || 1) / size));
    if (state.page > pageCount) state.page = pageCount;
    if (state.page < 1) state.page = 1;
    var pageStart = (state.page - 1) * size;
    var pageItems = visibleItems.slice(pageStart, pageStart + size);
    var actionableOnPage = pageItems.filter(function (item) { return !!item.target; });
    var pageAllSelected = actionableOnPage.length > 0 && actionableOnPage.every(function (item) { return !!state.selected[itemId(item)]; });
    var summary = statusSummary(allItems);
    var load = workloadMap(allItems);
    var tasks = activeTasks();
    var isToday = _opsDate === today();
    var pct = cleanDay.total ? Math.round((cleanDay.done * 100) / cleanDay.total) : 0;

    var counter = pageStart;
    var body = '';
    if (pageItems.length) {
      groupItems(pageItems).forEach(function (group) {
        if (group.label) body += groupRowHtml(group, COLSPAN);
        group.items.forEach(function (item) {
          counter += 1;
          body += dispatchRowHtml(item, counter, load);
        });
      });
    } else {
      body = '<tr><td colspan="' + COLSPAN + '"><div class="ob-empty">No rows match this view.</div></td></tr>';
    }

    root.innerHTML = '<div class="ob-shell">' +
      dayBarHtml(cleanDay, pct, summary, tasks, isToday) +
      railHtml(allItems, summary, cleanDay) +
      '<div class="ob-page">' + cleanerDatalist() +
        '<details class="ob-collapsible ob-task-drawer"' + (state.open.tasks || state.composer ? ' open' : '') + '><summary data-ob-action="disclose" data-ob-panel="tasks">Tasks <b>' + tasks.filter(function (t) { return !t.completed; }).length + ' open</b></summary>' + tasksHtml(tasks) + '</details>' +
        '<div class="ob-schedcheck" id="ops-schedcheck"></div>' +
        bulkBarHtml(visibleItems, allItems) +
        '<div id="ops-beta-board-capture">' +
          '<div class="ob-board-head"><div><h2>DISPATCH CONSOLE · CHECKOUT &amp; CLEANING</h2><small>' + esc(dateLabel(_opsDate)) + ' · showing ' + pageItems.length + ' of ' + visibleItems.length + ' matching rows</small></div><span class="ob-spacer"></span><b>' + cleanDay.done + ' / ' + cleanDay.total + ' clean</b><div class="ob-progress"><span style="width:' + pct + '%"></span></div></div>' +
          colorLegendHtml() +
          '<div class="ob-dispatch-layout"><div class="ob-dispatch-main">' +
            '<div class="ob-table-wrap"><table class="ob-dispatch-table"><thead><tr>' +
              '<th class="ob-c-sel ob-center"><input type="checkbox" class="ob-sel-check" data-ob-action="select-page"' + (pageAllSelected ? ' checked' : '') + ' title="Select this page" aria-label="Select this page"></th>' +
              '<th class="ob-c-tick ob-center">✓</th>' +
              '<th class="ob-c-prop">Property</th>' +
              '<th class="ob-c-stay">Stay / check-in</th>' +
              '<th class="ob-c-sig" title="⏰ Late checkout · ❗ Priority · 👶 Παρκοκρεβάτο · ☀️ Early check-in">Signals</th>' +
              '<th class="ob-c-crew">Cleaner</th>' +
              '<th class="ob-c-task">Task</th>' +
              '<th class="ob-c-note">Notes</th>' +
              '<th class="ob-c-status">Status</th>' +
              '<th class="ob-c-act"></th>' +
            '</tr></thead><tbody>' + body + '</tbody></table></div>' + pagerHtml(state.page, pageCount, visibleItems.length, size) +
          '</div></div>' +
        '</div>' +
        '<div class="ob-aux-grid"><details class="ob-collapsible"' + (state.open.staff ? ' open' : '') + '><summary data-ob-action="disclose" data-ob-panel="staff">Staff, leave, linen &amp; driver routes</summary><div class="ob-section"><h3>Same saved data as Daily Ops</h3>' + staffHtml() + '</div></details>' +
          '<details class="ob-collapsible"' + (state.open.notes ? ' open' : '') + '><summary data-ob-action="disclose" data-ob-panel="notes">Daily notes</summary><div class="ob-section"><textarea class="ob-notes" data-ob-action="notes" data-ob-focus="daily-notes" placeholder="General notes for the day…">' + esc(_opsNotes) + '</textarea></div></details>' +
        '</div>' +
      '</div></div>';

    bind(root);
    // Paste/drag schedule capture + repaint the OCR panel into the mount above.
    if (typeof _opsSchedBindOnce === 'function') { try { _opsSchedBindOnce(); } catch (e) {} }
    if (typeof _opsSchedRepaint === 'function') { try { _opsSchedRepaint(); } catch (e) {} }
    prefetchOpsImageLib();
  }

  // Every entry point goes through here, including the background DB poll that
  // calls renderOps() while an operator is mid-sentence in a notes field.
  //
  // Replacing root.innerHTML blurs whatever was focused, and a blur can fire a
  // change event whose handler calls back into render(). Re-entering the swap
  // detaches nodes mid-assignment ("node to be removed is no longer a child"),
  // so nested calls are collapsed into one trailing repaint.
  var painting = false;
  var repaintQueued = false;

  function render() {
    if (painting) { repaintQueued = true; return; }
    var snap = captureContext();
    painting = true;
    try {
      paint();
    } finally {
      painting = false;
    }
    restoreContext(snap);
    if (repaintQueued) {
      repaintQueued = false;
      render();
    }
  }

  function rerender() {
    render();
  }

  // Refresh only the derived note chips for one row. Typing must not rebuild the
  // board, but changing pax can add/remove an auto sofa/long-stay tag.
  function refreshNoteChips(index) {
    var root = rootEl();
    if (!root || typeof root.querySelector !== 'function') return false;
    var row = _opsRows[index];
    if (!row) return false;
    var host = root.querySelector('[data-ob-focus="note:' + index + '"]');
    if (!host || !host.parentNode) return false;
    var cell = host.parentNode;
    var existing = cell.querySelector ? cell.querySelector('.ob-nchips') : null;
    var html = noteChipsHtml(String(row.comments || row.cleanTaskNote || ''), index, false);
    if (existing) existing.outerHTML = html;
    else if (html && typeof cell.insertAdjacentHTML === 'function') cell.insertAdjacentHTML('afterbegin', html);
    return true;
  }

  function findClean(key) {
    return (typeof _opsFindCleanRow === 'function') ? _opsFindCleanRow(key) : null;
  }

  function closeOverlays() {
    state.menuFor = '';
    state.assignFor = '';
    state.barMenu = false;
  }

  // ── row mutations ────────────────────────────────────────────────────────
  function toggleFlag(index, flag) {
    var row = _opsRows[index];
    if (!row) return;
    if (flag === 'late') {
      row.lateCheckout = !row.lateCheckout;
      if (typeof _opsSetManagedComment === 'function') _opsSetManagedComment(row, OPS_TAG_LATE, row.lateCheckout);
    } else if (flag === 'priority') {
      row.isPriority = !row.isPriority;
      row.priorityManual = !!row.isPriority;
      if (typeof _opsSetManagedComment === 'function') _opsSetManagedComment(row, OPS_TAG_PRIORITY, row.isPriority);
    } else if (flag === 'park') {
      row.parkBed = !row.parkBed;
      if (typeof _opsSetManagedComment === 'function') _opsSetManagedComment(row, OPS_TAG_PARK, row.parkBed);
    } else if (flag === 'early') {
      row.earlyCheckin = !row.earlyCheckin;
      if (typeof _opsSetManagedComment === 'function') _opsSetManagedComment(row, OPS_TAG_EARLY, row.earlyCheckin);
    }
    persist(true);
    rerender();
  }

  function toggleCheckin(index) {
    var row = _opsRows[index];
    if (!row || row.isCheckinOnly) return;
    var cycle = { yes: 'no', no: 'unknown', unknown: 'yes' };
    row.checkinSameDay = cycle[row.checkinSameDay] || 'unknown';
    row.checkinManual = true;
    delete row.priorityManual;
    if (typeof _opsApplySameDayPriority === 'function') _opsApplySameDayPriority(row);
    persist(true);
    // checkinSameDay is not in OPS_OVERLAY, so _opsLoadData recomputes it from
    // live bookings. Legacy opsToggleCheckin repainted only the tbody for the
    // same reason — keep the operator's click visible the same way.
    state.skipReload = true;
    rerender();
  }

  function toggleKind(index, key) {
    var row = _opsRows[index];
    if (!row || typeof OPS_KINDS === 'undefined') return;
    var now = !row[key];
    OPS_KINDS.forEach(function (kind) {
      if (kind.key === key) { row[kind.key] = now; row[kind.manual] = now; }
      else if (now) { row[kind.key] = false; row[kind.manual] = false; }
    });
    if (now) row.isCheckinOnly = false;
    else if (!row.checkoutGuest && row.checkinSameDay === 'checkin_only' && typeof _opsIsSpecial === 'function' && !_opsIsSpecial(row)) row.isCheckinOnly = true;
    if (typeof _opsOrder === 'function') _opsRows = _opsOrder(_opsRows);
    persist(true);
    rerender();
  }

  function updateRowField(index, field, value) {
    var row = _opsRows[index];
    if (!row) return;
    row[field] = value;
    if (field === 'people') {
      if (typeof _opsApplySofaComment === 'function') _opsApplySofaComment(row);
      if (typeof _opsApplyLongStayComment === 'function') _opsApplyLongStayComment(row);
    }
    queueSave();
  }

  function updateComment(index, key, value) {
    var row = _opsRows[index];
    if (!row) return;
    var next = composeNote(String(row.comments || row.cleanTaskNote || ''), value);
    row.comments = next;
    row.cleanTaskNote = next;
    var target = findClean(key);
    if (target && target !== row) {
      target.comments = next;
      target.cleanTaskNote = next;
    }
    queueSave();
  }

  function updateCleanField(key, field, value) {
    var row = findClean(key);
    if (!row) return;
    if (field === 'comments') {
      var next = composeNote(String(row.comments || row.cleanTaskNote || ''), value);
      row.comments = next;
      row.cleanTaskNote = next;
    } else {
      row[field] = value;
    }
    queueSave();
  }

  function updateCleaners(key, value) {
    var row = findClean(key);
    if (!row) return;
    var list = String(value || '').split(/\s*[·,;|/]\s*/).map(function (name) { return name.trim(); }).filter(Boolean);
    if (typeof _opsWriteCleaners === 'function') _opsWriteCleaners(row, list);
    else {
      row.cleanerNames = list;
      row.cleanerName = list.join(' · ');
    }
    queueSave();
  }

  function addCleanerChip(key, value) {
    if (!String(value || '').trim()) return;
    closeOverlays();
    if (typeof opsAddCleanerKey === 'function') {
      opsAddCleanerKey(key, value);
      return;
    }
    var row = findClean(key);
    if (!row) return;
    var add = String(value || '').split(/\s*[·,;|/]\s*/).map(function (name) { return name.trim(); }).filter(Boolean);
    if (!add.length) return;
    var list = cleaners(row).concat(add);
    if (typeof _opsWriteCleaners === 'function') _opsWriteCleaners(row, list);
    else { row.cleanerNames = list; row.cleanerName = list.join(' · '); }
    persist(true);
    rerender();
  }

  function removeCleanerChip(key, idx) {
    if (typeof opsRemoveCleanerAt === 'function') {
      opsRemoveCleanerAt(key, idx);
      return;
    }
    var row = findClean(key);
    if (!row) return;
    var list = cleaners(row).slice();
    if (idx < 0 || idx >= list.length) return;
    list.splice(idx, 1);
    if (typeof _opsWriteCleaners === 'function') _opsWriteCleaners(row, list);
    else { row.cleanerNames = list; row.cleanerName = list.join(' · '); }
    persist(true);
    rerender();
  }

  function selectItems(items, checked) {
    items.forEach(function (item) {
      var id = itemId(item);
      if (checked && item.target) state.selected[id] = true;
      else delete state.selected[id];
    });
  }

  function currentFilteredItems() {
    return filteredItems(mainAndExtras());
  }

  function currentPageItems() {
    var filtered = currentFilteredItems();
    var size = pageSizeFor(filtered.length);
    var start = (state.page - 1) * size;
    return filtered.slice(start, start + size);
  }

  function applySelected(callback, after) {
    var items = selectedItems(mainAndExtras());
    if (!items.length) return false;
    items.forEach(function (item) { if (item.target) callback(item.target, item); });
    persist(true);
    if (typeof after === 'function') after();
    rerender();
    return true;
  }

  function bulkCleaner(name) {
    if (!name) return;
    applySelected(function (target) {
      if (typeof _opsWriteCleaners === 'function') _opsWriteCleaners(target, [name]);
      else { target.cleanerNames = [name]; target.cleanerName = name; }
    });
  }

  function bulkTask(task) {
    if (!task) return;
    applySelected(function (target) { target.cleanTask = task; });
  }

  function bulkDone(done) {
    applySelected(function (target) { target.cleanDone = !!done; }, function () {
      if (done && typeof _opsMaybeAdvanceAfterCleans === 'function') _opsMaybeAdvanceAfterCleans();
    });
  }

  function removeRow(index) {
    if (!_opsRows[index]) return;
    if (!window.confirm('Remove this row from the selected day?')) return;
    _opsRows.splice(index, 1);
    closeOverlays();
    persist(true);
    state.skipReload = true;
    rerender();
  }

  // ── tasks (inline composer — no window.prompt) ───────────────────────────
  function toggleTask(id, checked) {
    var task = (S.daily.tasks || []).find(function (item) { return item.id === id; });
    if (!task) return;
    task.completed = !!checked;
    task.completedDate = checked ? _opsDate : null;
    if (typeof save === 'function') save();
    if (typeof saveToDb === 'function' && typeof _dbAvailable !== 'undefined' && _dbAvailable) saveToDb();
    rerender();
  }

  function saveTask() {
    var text = String(state.draftText || '').trim();
    if (!text) return;
    var hit = state.draftApt ? (S.apts || []).find(function (apt) { return String(apt.id) === String(state.draftApt); }) : null;
    _opsEnsure();
    S.daily.tasks.push({
      id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      aptId: hit ? hit.id : '',
      aptName: hit ? hit.name : '',
      text: text,
      createdDate: _opsDate,
      completed: false,
      completedDate: null,
    });
    state.draftText = '';
    state.draftApt = '';
    state.composer = false;
    if (typeof save === 'function') save();
    if (typeof saveToDb === 'function' && typeof _dbAvailable !== 'undefined' && _dbAvailable) saveToDb();
    rerender();
  }

  function deleteTask(id) {
    S.daily.tasks = (S.daily.tasks || []).filter(function (task) { return task.id !== id; });
    if (typeof save === 'function') save();
    if (typeof saveToDb === 'function' && typeof _dbAvailable !== 'undefined' && _dbAvailable) saveToDb();
    rerender();
  }

  function restartCleans() {
    if (typeof opsRestartCleaningSchedule === 'function') {
      opsRestartCleaningSchedule();
      return;
    }
    if (!window.confirm('Clear only the cleaning ✓ marks for ' + dateLabel(_opsDate) + '? Cleaners, comments, flags and staff blocks will stay.')) return;
    mainAndExtras().forEach(function (item) { if (item.target) item.target.cleanDone = false; });
    _opsEnsure();
    if (S.daily.cleansCompleteFor) delete S.daily.cleansCompleteFor[_opsDate];
    persist(true);
    rerender();
  }

  // ── image export ─────────────────────────────────────────────────────────
  function loadHtml2CanvasPro(opts) {
    // html2canvas 1.4.1 dies on modern CSS color()/color-mix computed styles.
    // Pro fork keeps the same API and parses those colors.
    var quiet = !!(opts && opts.quiet);
    if (window.__opsHtml2CanvasPro) return Promise.resolve(window.__opsHtml2CanvasPro);
    if (window.__opsHtml2CanvasProLoading) return window.__opsHtml2CanvasProLoading;
    if (!quiet && typeof toast === 'function') toast('Loading image export…', 'warn');
    window.__opsHtml2CanvasProLoading = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/html2canvas-pro@1.5.11/dist/html2canvas-pro.min.js';
      script.onload = function () {
        window.__opsHtml2CanvasPro = window.html2canvas;
        window.__opsHtml2CanvasProLoading = null;
        resolve(window.__opsHtml2CanvasPro);
      };
      script.onerror = function (err) {
        window.__opsHtml2CanvasProLoading = null;
        reject(err);
      };
      document.head.appendChild(script);
    });
    return window.__opsHtml2CanvasProLoading;
  }

  function prefetchOpsImageLib() {
    try { loadHtml2CanvasPro({ quiet: true }); } catch (e) {}
  }

  function flattenCloneColors(clonedDoc) {
    if (!clonedDoc) return;
    var probe = clonedDoc.createElement('canvas');
    var ctx = probe.getContext && probe.getContext('2d');
    function toRgb(value) {
      var raw = String(value || '');
      if (!raw || raw === 'transparent') return raw;
      if (/^(#|rgb\(|rgba\(|hsl\(|hsla\()/i.test(raw)) return raw;
      if (!ctx) return '#ffffff';
      try {
        ctx.fillStyle = '#000000';
        ctx.fillStyle = raw;
        return ctx.fillStyle || '#ffffff';
      } catch (e) {
        return '#ffffff';
      }
    }
    var nodes = clonedDoc.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || !node.style) continue;
      var cs = clonedDoc.defaultView && clonedDoc.defaultView.getComputedStyle
        ? clonedDoc.defaultView.getComputedStyle(node)
        : null;
      if (!cs) continue;
      ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor'].forEach(function (prop) {
        var val = cs[prop];
        if (!val) return;
        if (/color\s*\(|color-mix\s*\(|oklch\s*\(|oklab\s*\(|lab\s*\(|lch\s*\(/i.test(val)) {
          node.style[prop] = toRgb(val);
        }
      });
    }
  }

  function downloadOpsPng(blob) {
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'daily-ops-' + (_opsDate || 'today') + '.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { try { URL.revokeObjectURL(link.href); } catch (e) {} }, 1500);
  }

  function isClipboardFocusError(error) {
    var msg = String((error && error.message) || error || '').toLowerCase();
    return msg.indexOf('document is not focused') >= 0
      || msg.indexOf('not allowed') >= 0
      || msg.indexOf('clipboard') >= 0 && msg.indexOf('focus') >= 0;
  }

  async function copyOpsPngToClipboard(blob) {
    if (!(navigator.clipboard && window.ClipboardItem)) {
      throw new Error('Clipboard API unavailable');
    }
    try {
      if (typeof window.focus === 'function') window.focus();
      if (document.body && typeof document.body.focus === 'function') {
        try { document.body.focus(); } catch (e) {}
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return 'copied';
    } catch (error) {
      if (!isClipboardFocusError(error)) throw error;
      // Long async capture (first load / heavy board) often loses the transient
      // user-activation + focus token. Fall back to a file download instead of
      // failing the whole Ops image action.
      downloadOpsPng(blob);
      return 'downloaded';
    }
  }

  function copyBetaImage() {
    var el = document.getElementById('ops-beta-board-capture');
    if (!el) return;
    var run = async function () {
      var capture = await loadHtml2CanvasPro({ quiet: !!window.__opsHtml2CanvasPro || !!window.__opsHtml2CanvasProLoading });
      if (typeof toast === 'function') toast('Capturing Daily Ops…');
      if (el.classList) el.classList.add('ob-capture');
      var canvas;
      try {
        canvas = await capture(el, {
          scale: 2,
          backgroundColor: '#f5f7fa',
          useCORS: true,
          logging: false,
          onclone: function (clonedDoc) { flattenCloneColors(clonedDoc); },
        });
      } finally {
        if (el.classList) el.classList.remove('ob-capture');
      }
      var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
      if (!blob) throw new Error('Could not build PNG');
      if (navigator.clipboard && window.ClipboardItem) {
        var mode = await copyOpsPngToClipboard(blob);
        if (typeof toast === 'function') {
          toast(mode === 'copied'
            ? 'Ops board copied — paste into chat'
            : 'Clipboard busy — downloaded Ops board PNG instead', mode === 'copied' ? 'ok' : 'warn');
        }
      } else {
        downloadOpsPng(blob);
        if (typeof toast === 'function') toast('Downloaded Ops board PNG', 'ok');
      }
    };
    run().catch(function (error) {
      if (typeof toast === 'function') toast('Screenshot failed: ' + (error && error.message ? error.message : error), 'err');
    });
  }

  // ── events ───────────────────────────────────────────────────────────────
  function bind(root) {
    if (root.dataset.opsBetaBound === '1') return;
    root.dataset.opsBetaBound = '1';

    root.addEventListener('click', function (event) {
      var button = event.target.closest('[data-ob-action]');
      if (!button || !root.contains(button)) {
        if (state.menuFor || state.assignFor || state.barMenu) { closeOverlays(); rerender(); }
        return;
      }
      var action = button.dataset.obAction;
      if (action === 'disclose') {
        event.preventDefault();
        var panel = button.dataset.obPanel;
        state.open[panel] = !state.open[panel];
        if (panel === 'tasks' && !state.open.tasks) state.composer = false;
        rerender();
        return;
      }
      if (action === 'nav') {
        persist(false);
        closeOverlays();
        _opsDate = (typeof _opsAddDays === 'function') ? _opsAddDays(_opsDate, Number(button.dataset.obDays || 0)) : _opsDate;
        rerender();
      } else if (action === 'today') {
        persist(false); closeOverlays(); _opsDate = today(); rerender();
      } else if (action === 'filter') {
        state.filter = button.dataset.obFilter || 'all'; state.page = 1; closeOverlays(); rerender();
      } else if (action === 'page') {
        state.page = Math.max(1, Number(button.dataset.obPage || 1)); closeOverlays(); rerender();
      } else if (action === 'select-all-results') {
        selectItems(currentFilteredItems(), true); rerender();
      } else if (action === 'clear-selection') {
        state.selected = {}; rerender();
      } else if (action === 'bulk-done') {
        bulkDone(true);
      } else if (action === 'bulk-open') {
        bulkDone(false);
      } else if (action === 'flag') {
        toggleFlag(Number(button.dataset.obIndex), button.dataset.obFlag);
      } else if (action === 'checkin') {
        toggleCheckin(Number(button.dataset.obIndex));
      } else if (action === 'cleaner-remove') {
        removeCleanerChip(decoded(button.dataset.obKey), Number(button.dataset.obIdx));
      } else if (action === 'assign-open') {
        var openId = decoded(button.dataset.obId);
        state.assignFor = state.assignFor === openId ? '' : openId;
        state.menuFor = '';
        rerender();
      } else if (action === 'assign-pick') {
        addCleanerChip(decoded(button.dataset.obKey), button.dataset.obName);
      } else if (action === 'row-menu') {
        var menuId = decoded(button.dataset.obId);
        state.menuFor = state.menuFor === menuId ? '' : menuId;
        state.assignFor = '';
        rerender();
      } else if (action === 'kind') {
        closeOverlays();
        toggleKind(Number(button.dataset.obIndex), button.dataset.obKind);
      } else if (action === 'row-remove') {
        removeRow(Number(button.dataset.obIndex));
      } else if (action === 'bar-menu') {
        state.barMenu = !state.barMenu; state.menuFor = ''; state.assignFor = ''; rerender();
      } else if (action === 'manage-cleaners') {
        closeOverlays();
        if (typeof opsManageCleaners === 'function') opsManageCleaners();
        rerender();
      } else if (action === 'copy-list') {
        closeOverlays();
        if (typeof opsCopyCleanList === 'function') opsCopyCleanList();
        rerender();
      } else if (action === 'task-open') {
        state.composer = true; state.open.tasks = true; rerender();
      } else if (action === 'task-cancel') {
        state.composer = false; state.draftText = ''; state.draftApt = ''; rerender();
      } else if (action === 'task-save') {
        saveTask();
      } else if (action === 'task-delete') {
        event.preventDefault(); deleteTask(button.dataset.obId);
      } else if (action === 'staff-add') {
        addStaffRow(button.dataset.obBlock); rerender();
      } else if (action === 'route-remove') {
        removeRoute(Number(button.dataset.obDriver), Number(button.dataset.obStop)); rerender();
      } else if (action === 'restart') {
        closeOverlays();
        restartCleans();
      } else if (action === 'ops-image') {
        state.barMenu = false;
        rerender();
        copyBetaImage();
      } else if (action === 'cleaner-image') {
        state.barMenu = false;
        rerender();
        if (typeof opsCopyCleaningImage === 'function') opsCopyCleaningImage();
      } else if (action === 'schedule-check') {
        state.barMenu = false;
        var file = document.getElementById('ops-beta-schedule-file'); if (file) file.click();
      }
    });

    root.addEventListener('change', function (event) {
      var input = event.target.closest('[data-ob-action]');
      if (!input || !root.contains(input)) return;
      var action = input.dataset.obAction;
      if (action === 'date') {
        persist(false); closeOverlays(); _opsDate = input.value || today(); rerender();
      } else if (action === 'sort') {
        state.sort = input.value || 'status'; state.page = 1; rerender();
      } else if (action === 'group') {
        state.group = input.value || 'area'; state.page = 1; rerender();
      } else if (action === 'page-size') {
        state.pageSize = Number(input.value);
        if (!isFinite(state.pageSize) || state.pageSize < 0) state.pageSize = 0;
        state.page = 1;
        rerender();
      } else if (action === 'select') {
        var selectId = decoded(input.dataset.obId);
        if (input.checked) state.selected[selectId] = true;
        else delete state.selected[selectId];
        rerender();
      } else if (action === 'select-page') {
        selectItems(currentPageItems(), !!input.checked); rerender();
      } else if (action === 'bulk-cleaner') {
        bulkCleaner(input.value);
      } else if (action === 'bulk-task') {
        bulkTask(input.value);
      } else if (action === 'clean') {
        var clean = findClean(decoded(input.dataset.obKey));
        if (clean) {
          clean.cleanDone = !!input.checked;
          persist(true);
          if (typeof _opsMaybeAdvanceAfterCleans === 'function') _opsMaybeAdvanceAfterCleans();
          rerender();
        }
      } else if (action === 'row-check') {
        updateRowField(Number(input.dataset.obIndex), input.dataset.obField, !!input.checked); persist(true);
      } else if (action === 'row-field') {
        updateRowField(Number(input.dataset.obIndex), input.dataset.obField, input.value);
        // pax can add/remove a derived sofa or long-stay tag: refresh just those
        // chips instead of rebuilding the whole board under the operator.
        if (input.dataset.obField === 'people' && !refreshNoteChips(Number(input.dataset.obIndex))) rerender();
      } else if (action === 'comment') {
        updateComment(Number(input.dataset.obIndex), decoded(input.dataset.obKey), input.value);
      } else if (action === 'clean-field') {
        updateCleanField(decoded(input.dataset.obKey), input.dataset.obField, input.value);
        if (input.tagName === 'SELECT') rerender();
      } else if (action === 'cleaner-add') {
        addCleanerChip(decoded(input.dataset.obKey), input.value);
        input.value = '';
      } else if (action === 'task-apt') {
        state.draftApt = input.value || '';
      } else if (action === 'task-toggle') {
        toggleTask(input.dataset.obId, input.checked);
      } else if (action === 'staff') {
        setStaff(input.dataset.obBlock, Number(input.dataset.obIndex), input.value); rerender();
      } else if (action === 'leave-days') {
        setLeaveDays(Number(input.dataset.obIndex), input.value); rerender();
      } else if (action === 'route-add') {
        addRoute(Number(input.dataset.obDriver), input.value); rerender();
      } else if (action === 'schedule-file') {
        if (input.files && input.files[0] && typeof opsScheduleCheck === 'function') opsScheduleCheck(input.files[0]);
        input.value = '';
      }
    });

    root.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      var add = event.target.closest('[data-ob-action="cleaner-add"]');
      if (add && root.contains(add)) {
        event.preventDefault();
        addCleanerChip(decoded(add.dataset.obKey), add.value);
        add.value = '';
        return;
      }
      var draft = event.target.closest('[data-ob-action="task-text"]');
      if (draft && root.contains(draft)) {
        event.preventDefault();
        state.draftText = draft.value || '';
        saveTask();
      }
    });

    root.addEventListener('input', function (event) {
      var input = event.target.closest('[data-ob-action]');
      if (!input || !root.contains(input)) return;
      var action = input.dataset.obAction;
      if (action === 'search') {
        state.search = input.value || '';
        state.page = 1;
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(function () { rerender(); }, 140);
      } else if (action === 'row-field') {
        updateRowField(Number(input.dataset.obIndex), input.dataset.obField, input.value);
      } else if (action === 'comment') {
        updateComment(Number(input.dataset.obIndex), decoded(input.dataset.obKey), input.value);
      } else if (action === 'clean-field' && input.tagName !== 'SELECT') {
        updateCleanField(decoded(input.dataset.obKey), input.dataset.obField, input.value);
      } else if (action === 'task-text') {
        state.draftText = input.value || '';
      } else if (action === 'notes') {
        _opsNotes = input.value;
        queueSave();
      }
    });
  }

  window.renderOpsBeta = render;
  // Promote the dispatch console to the canonical Daily Ops tab.
  window.renderOps = render;
})();
