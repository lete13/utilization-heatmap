/* Daily Ops v2 — the approved design, wired to the live data layer.
 *
 * Renders into #tab-ops and replaces classic renderOps(). Every number, row,
 * cleaner and staff block on screen comes from the real app state (S.daily,
 * _opsRows / _opsAutoRows via _opsLoadData, _opsPrepareCleanDay, …) — this file
 * owns presentation and interaction only, never its own copy of the data.
 *
 * Structure
 * ---------
 *   .ob-command   slim top bar  — wordmark, title, day nav, save state, panel
 *   .ob-cards     summary       — open tasks (largest, first), progress ring,
 *                                 unassigned, arrivals
 *   .ob-rail      filters       — discriminating chips + search + group + sort
 *   .ob-list      the board     — dense grouped rows inside the capture wrapper
 *   .ob-panel     side panel    — cleaners, staff, routes, notes, schedule
 *                                 check (#ops-schedcheck), export
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
    composer: false, // inline task composer
    draftText: '',
    draftApt: '',
    panelOpen: true, // docked side panel (desktop)
    drawerOpen: false, // overlay drawer (tablet / phone)
  };

  var state = window._opsBetaState = window._opsBetaState || {};
  // Merge defaults without clobbering a state object restored from a previous
  // render (or seeded by tests) — new keys must not reset existing ones.
  for (var dk in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, dk) && state[dk] === undefined) state[dk] = DEFAULTS[dk];
  }
  if (!state.selected) state.selected = {};
  // Section disclosure has to live here: a full repaint rebuilds the panel, so
  // an open section would snap shut on the next render. The marker lets a state
  // object left behind by an older layout be replaced rather than half-merged.
  if (!state.open || state.open.v2 !== true) {
    state.open = { v2: true, cleaners: true, staff: true, routes: false, notes: true, sched: true, exports: true };
  }
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

  // The shared helper renders Greek weekday/month names; the redesign is
  // English-only, so format locally and keep the helper as the fallback.
  function dateLabel(value) {
    var parts = String(value || '').split('-');
    if (parts.length === 3) {
      var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      if (!isNaN(d.getTime())) {
        try {
          return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        } catch (e) { /* fall through to the shared helper */ }
      }
    }
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

  // Sentence case reads as part of the design language; OPS_KINDS ships its
  // labels in shouting caps for the legacy square buttons.
  function sentence(text) {
    var raw = String(text || '').trim();
    if (!raw) return '';
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }

  function cleanType(row) {
    var t = String((row && row.cleanType) || 'turnover');
    if (t === 'refresh') return { label: 'Refresh', cls: 'ob-k-preparation', exception: true };
    if (t === 'sofa_bed') return { label: 'Sofa bed', cls: 'ob-k-owner', exception: true };
    return { label: 'Turnover', cls: '', exception: false };
  }

  function taskList() {
    return (typeof OPS_CLEAN_TASKS !== 'undefined' && Array.isArray(OPS_CLEAN_TASKS))
      ? OPS_CLEAN_TASKS
      : [['katharismos', 'Καθαρισμός'], ['prepare_sofa', 'Prepare sofa bed'], ['episkeui', 'Επισκευή βλάβης'], ['extra', 'Extra']];
  }

  // OPS_CLEAN_TASKS ships Greek labels on the shared (untouchable) data layer.
  // Values stay verbatim so writes keep the same contract; only display text
  // is translated, and unknown keys fall back to whatever the data layer says.
  var TASK_LABELS = {
    katharismos: 'Cleaning',
    prepare_sofa: 'Prepare sofa bed',
    episkeui: 'Repair',
    extra: 'Extra'
  };

  function taskLabel(value, fallback) {
    return TASK_LABELS[String(value)] || fallback || String(value);
  }

  function taskOptions(current) {
    return taskList().map(function (item) {
      return '<option value="' + esc(item[0]) + '"' + (String(current || 'katharismos') === String(item[0]) ? ' selected' : '') + '>' + esc(taskLabel(item[0], item[1])) + '</option>';
    }).join('');
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
      setSaveState('Saved ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), true);
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
    var snap = { scroll: null, focus: '', start: null, end: null, panel: null, segs: null };
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
      // The panel scrolls on its own and the filter chips scroll sideways, so
      // both would silently jump back to the start on every repaint.
      var panel = document.getElementById('ops-beta-panel');
      if (panel) snap.panel = panel.scrollTop;
      var segs = document.getElementById('ops-beta-segs');
      if (segs) snap.segs = segs.scrollLeft;
    } catch (e) {}
    return snap;
  }

  function restoreContext(snap) {
    if (!snap) return;
    try {
      if (snap.scroll != null && typeof window.scrollTo === 'function') window.scrollTo(0, snap.scroll);
      var panel = document.getElementById('ops-beta-panel');
      if (panel && snap.panel != null) panel.scrollTop = snap.panel;
      var segs = document.getElementById('ops-beta-segs');
      if (segs && snap.segs != null) segs.scrollLeft = snap.segs;
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
      return names.length ? names.join(' · ') : 'No cleaner assigned';
    }
    var area = '';
    if (typeof window.aptAreaLabel === 'function' && typeof _opsAptOf === 'function') {
      area = window.aptAreaLabel(_opsAptOf(item.row)) || '';
    }
    return area || 'No area';
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
    // A long stay is a fact about the booking, not an exception to chase, so it
    // reads as information. Warm tags stay reserved for things that need a
    // decision today.
    if (part === tagEarly() || part === tagPark() || /sofa bed/i.test(part) || /^Long stay/i.test(part)) return ' cool';
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

  // Stored tags arrive shouting ("PRIORITY"); the chip is a label, so it is
  // presented in sentence case while the stored token is left untouched.
  function noteChipsHtml(note, index, extra) {
    var parts = managedParts(note);
    if (!parts.length) return '';
    return '<div class="ob-nchips">' + parts.map(function (part) {
      var flag = extra ? '' : flagForPart(part);
      var remove = flag
        ? '<button type="button" data-ob-action="flag" data-ob-index="' + index + '" data-ob-flag="' + flag + '" aria-label="Remove ' + esc(part) + '">×</button>'
        : '';
      return '<span class="ob-nchip' + partTone(part) + '"><span>' + esc(sentence(part)) + '</span>' + remove + '</span>';
    }).join('') + '</div>';
  }

  // ── row pieces ───────────────────────────────────────────────────────────
  // One human-readable cluster instead of four separate columns:
  //   "Check-in yes · 2 guests · 15:00 · 3 nights"
  // The check-in state cycles on click; guests and ETA are inline-editable and
  // stay borderless until they take focus.
  function detailsHtml(item) {
    var row = item.row || {};
    var index = item.index;
    var segs = [];

    if (item.extra) {
      segs.push({ filled: true, html: '<span class="ob-ci ob-static">Extra clean</span>' });
    } else if (isArrivalOnly(row)) {
      segs.push({ filled: true, html: '<span class="ob-ci ob-yes ob-static">Arrival</span>' });
    } else {
      var stateName = row.checkinSameDay || 'unknown';
      var cfg = stateName === 'yes'
        ? { cls: 'ob-yes', text: 'Check-in yes' }
        : stateName === 'no'
          ? { cls: '', text: 'Check-in no' }
          : { cls: 'ob-unknown', text: 'Check-in unknown' };
      segs.push({
        filled: true,
        html: '<button type="button" class="ob-ci ' + cfg.cls + '" data-ob-action="checkin" data-ob-index="' + index +
          '" aria-label="' + esc(cfg.text) + ' — click to cycle">' + esc(cfg.text) + '</button>'
      });
    }

    var pax = String(row.people == null ? '' : row.people);
    if (item.extra) {
      segs.push({
        filled: !!pax,
        html: '<span class="ob-paxwrap' + (pax ? '' : ' ob-ph') + '"><span class="ob-inline">' + esc(pax || '—') + '</span>' +
          (pax ? '<span class="ob-unit">guests</span>' : '') + '</span>'
      });
    } else {
      // The unit only earns its space next to a number; "— guests" was reading
      // as a broken value rather than as an empty field.
      segs.push({
        filled: !!pax,
        html: '<span class="ob-paxwrap' + (pax ? '' : ' ob-ph') + '">' +
          '<input class="ob-input ob-inline ob-row-pax" type="number" min="0" max="20" value="' + esc(pax) +
          '" data-ob-action="row-field" data-ob-index="' + index + '" data-ob-field="people" data-ob-focus="pax:' + index +
          '" placeholder="—" aria-label="Guests">' + (pax ? '<span class="ob-unit">guests</span>' : '') + '</span>'
      });
      var eta = String(row.arrivalTime || '');
      segs.push({
        filled: !!eta,
        html: '<span class="ob-etawrap' + (eta ? '' : ' ob-ph') + '">' +
          '<input class="ob-input ob-inline ob-row-eta' + (eta ? '' : ' ob-eta-empty') + '" value="' + esc(eta) +
          '" data-ob-action="row-field" data-ob-index="' + index + '" data-ob-field="arrivalTime" data-ob-focus="eta:' + index +
          '" placeholder="—" aria-label="Arrival time"></span>'
      });
    }

    if (!item.extra && row.nextNights && (row.checkinSameDay === 'yes' || isArrivalOnly(row))) {
      segs.push({ filled: true, html: '<span class="ob-nights">' + esc(row.nextNights) + ' nights</span>' });
    }

    // An interpunct only ever joins two segments that carry a value. Separating
    // the empty slots too left a trail of "· — · —" behind most rows and, once
    // the column was tight, pushed the real values out of view.
    var html = '';
    var prevFilled = false;
    segs.forEach(function (seg) {
      if (seg.filled && prevFilled) html += '<span class="ob-dot-sep">·</span>';
      html += seg.html;
      if (seg.filled) prevFilled = true;
    });
    return '<div class="ob-details">' + html + '</div>';
  }

  var FLAG_DEFS = [
    ['late', '⏰', 'Late checkout', 'lateCheckout'],
    ['priority', '❗', 'Priority', 'isPriority'],
    ['park', '👶', 'Park bed', 'parkBed'],
    ['early', '☀️', 'Early check-in', 'earlyCheckin'],
  ];

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

  // Status always reads as a coloured dot AND a word — the colour alone was
  // never enough, and the word alone lost the at-a-glance scan.
  function statusOf(item) {
    var row = item.row || {};
    var target = item.target;
    if (target && target.cleanDone) return { cls: 'done', word: 'Done' };
    if (!target && !isArrivalOnly(row)) return { cls: 'excluded', word: 'No clean' };
    // "Unassigned" is the more actionable read of an unstaffed row, and it has
    // its own rail segment; reserve the blocking word for the other causes so
    // the status column keeps discriminating. The Blocking filter is unchanged.
    if (target && !cleaners(target).length) return { cls: 'unassigned', word: 'Unassigned' };
    if (itemBlocking(item)) return { cls: 'blocking', word: 'Blocking' };
    return { cls: 'ready', word: 'Ready' };
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
  function assignPopHtml(key, load, assigned) {
    var roster = cleanerRoster();
    var peak = 1;
    roster.forEach(function (name) { peak = Math.max(peak, load[name] || 0); });
    var rows = roster.map(function (name) {
      var n = load[name] || 0;
      var pct = Math.round((n / peak) * 100);
      var band = n === 0 || n <= peak / 3 ? ' ob-low' : (n >= peak ? ' ob-high' : '');
      var has = assigned.indexOf(name) >= 0;
      return '<button type="button" class="ob-pop-row" data-ob-action="assign-pick" data-ob-key="' + encoded(key) + '" data-ob-name="' + esc(name) + '">' +
        '<span class="ob-mi-state">' + (has ? '✓' : '') + '</span>' +
        '<span class="ob-nm-txt">' + esc(name) + '</span>' +
        '<span class="ob-ld' + band + '"><u><b style="width:' + pct + '%"></b></u>' + n + '</span>' +
        '</button>';
    }).join('');
    return '<div class="ob-pop">' +
      '<h6>Assign cleaner · workload today</h6>' +
      (rows || '<div class="ob-pop-empty">No cleaners on the roster yet.</div>') +
      '<input class="ob-input" list="ops-beta-cleaners" value="" placeholder="Add cleaner…" data-ob-action="cleaner-add" data-ob-focus="assign:' + esc(key) + '" data-ob-key="' + encoded(key) + '" aria-label="Add cleaner">' +
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
      return '<span class="ob-cchip"><span>' + esc(nm) + '</span>' +
        '<button type="button" data-ob-action="cleaner-remove" data-ob-key="' + encoded(key) + '" data-ob-idx="' + ni + '" aria-label="Remove ' + esc(nm) + '">×</button></span>';
    }).join('');
    // One uniform navy-tinted pill with a hairline — never dashed, never gold.
    var trigger = names.length
      ? '<button type="button" class="ob-assign ob-plus" data-ob-action="assign-open" data-ob-id="' + encoded(id) + '" aria-label="Assign another cleaner">＋</button>'
      : '<button type="button" class="ob-assign" data-ob-action="assign-open" data-ob-id="' + encoded(id) + '">Assign</button>';
    return '<div class="ob-cchips-wrap">' +
      (chips ? '<div class="ob-cchips">' + chips + '</div>' : '') +
      trigger +
      (open ? assignPopHtml(key, load, names) : '') +
      '</div>';
  }

  // Every menu row is the same three-column shape — state tick, icon, label —
  // so items with an emoji and items without still line their text up. The two
  // gutters are fixed-width in CSS and stay in the flow when they are empty.
  function menuItemHtml(attrs, icon, label, on, extraClass) {
    return '<button type="button" class="ob-mi' + (on ? ' ob-on' : '') + (extraClass ? ' ' + extraClass : '') + '" ' + attrs +
      (on ? ' aria-pressed="true"' : '') + '>' +
      '<span class="ob-mi-state">' + (on ? '✓' : '') + '</span>' +
      '<span class="ob-mi-icon">' + (icon || '') + '</span>' +
      '<span class="ob-mi-label">' + esc(label) + '</span>' +
      '</button>';
  }

  function rowMenuHtml(item) {
    var row = item.row || {};
    var kinds = (typeof OPS_KINDS !== 'undefined' && Array.isArray(OPS_KINDS)) ? OPS_KINDS : [];
    var flagButtons = FLAG_DEFS.map(function (f) {
      return menuItemHtml(
        'data-ob-action="flag" data-ob-index="' + item.index + '" data-ob-flag="' + f[0] + '"',
        f[1], f[2], !!row[f[3]]
      );
    }).join('');
    // OPS_KINDS carries short word icons ("Mnt", "Prep") meant for the legacy
    // square buttons. They do not fit an 18px gutter and only repeat the label
    // next to them, so the kind rows leave the icon track empty and rely on the
    // tick to show state.
    var kindButtons = kinds.map(function (kind) {
      return menuItemHtml(
        'data-ob-action="kind" data-ob-index="' + item.index + '" data-ob-kind="' + esc(kind.key) + '"',
        '', sentence(kind.label || kind.key), !!row[kind.key]
      );
    }).join('');
    return '<div class="ob-menu">' +
      '<h6>Flags</h6>' + flagButtons +
      (kindButtons ? '<hr><h6>Kind override</h6>' + kindButtons : '') +
      '<hr>' +
      menuItemHtml('data-ob-action="row-remove" data-ob-index="' + item.index + '"', '×', 'Remove row', false, 'ob-danger') +
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
    var note = String(row.comments || row.cleanTaskNote || '');
    var status = statusOf(item);
    var toneClass = rowToneClass(item);

    // Only exceptions earn a coloured badge; the type always stays readable on
    // the sub line so nothing is dropped for the common turnover case.
    var badges = (kind ? '<span class="ob-badge ob-k-' + esc(String(kind.key || '').replace(/^is/, '').toLowerCase()) + '">' + esc(sentence(kind.label)) + '</span>' : '') +
      (row.isOwner ? '<span class="ob-badge ob-k-owner">Owner</span>' : '') +
      (isArrivalOnly(row) ? '<span class="ob-badge ob-k-arrival">Arrival only</span>' : '') +
      (type && type.exception ? '<span class="ob-badge ' + type.cls + '">' + esc(type.label) + '</span>' : '');
    // The area already titles the group it sits under, so repeating it on every
    // sub line spent the row's remaining width on a word the operator just read.
    var subArea = state.group === 'area' ? '' : area;
    var sub = [type ? type.label : 'No clean', subArea, lines.addr].filter(Boolean).join(' · ');

    // In card mode every cell becomes its own line, so a cell holding nothing
    // but an em-dash placeholder is dead weight — flag it for the card tiers.
    var blank = target ? '' : ' ob-cell-empty';
    var cleanControl = target
      ? '<button type="button" class="ob-tick' + (done ? ' ob-on' : '') + '" data-ob-action="clean" data-ob-key="' + encoded(item.key) + '" aria-pressed="' + (done ? 'true' : 'false') + '" aria-label="Mark clean">✓</button>'
      : '<span class="ob-row-muted">—</span>';
    var taskControl = target
      ? '<select class="ob-select ob-row-task" data-ob-action="clean-field" data-ob-key="' + encoded(item.key) + '" data-ob-field="cleanTask" data-ob-focus="task:' + esc(item.key) + '" aria-label="Task">' + taskOptions(target.cleanTask) + '</select>'
      : '<span class="ob-row-muted">—</span>';
    var noteInput = item.extra
      ? '<input class="ob-input ob-row-note" value="' + esc(freeNoteText(note)) + '" data-ob-action="clean-field" data-ob-key="' + encoded(item.key) + '" data-ob-field="comments" data-ob-focus="note:' + esc(item.key) + '" placeholder="Note" aria-label="Note">'
      : '<input class="ob-input ob-row-note" value="' + esc(freeNoteText(note)) + '" data-ob-action="comment" data-ob-index="' + item.index + '"' +
        (target ? ' data-ob-key="' + encoded(item.key) + '"' : '') + ' data-ob-focus="note:' + item.index + '" placeholder="Note" aria-label="Note">';
    var menuOpen = state.menuFor === id;
    var actions = item.extra
      ? ''
      : '<button type="button" class="ob-rowmenu-btn' + (menuOpen ? ' ob-on' : '') + '" data-ob-action="row-menu" data-ob-id="' + encoded(id) + '" aria-label="Row actions" aria-haspopup="true">⋯</button>' +
        (menuOpen ? rowMenuHtml(item) : '');

    return '<tr class="ob-dispatch-row ' + status.cls + ' ' + toneClass + (selected ? ' selected' : '') + '" data-ob-id="' + encoded(id) + '">' +
      '<td class="ob-c-sel ob-center"><input type="checkbox" class="ob-sel-check" data-ob-action="select" data-ob-id="' + encoded(id) + '"' + (selected ? ' checked' : '') + (target ? '' : ' disabled') + ' aria-label="Select ' + esc(lines.name || row.aptName) + '"></td>' +
      '<td class="ob-c-tick ob-center' + blank + '">' + cleanControl + '</td>' +
      '<td class="ob-c-prop"><div class="ob-nm"><span class="ob-num">' + displayNumber + '</span><b>' + esc(lines.name || row.aptName || 'Apartment') + '</b>' + badges + '</div><div class="ob-sub">' + esc(sub) + '</div></td>' +
      '<td class="ob-c-stay">' + detailsHtml(item) + '</td>' +
      '<td class="ob-c-crew' + blank + '">' + cleanerChipsHtml(item, load) + '</td>' +
      '<td class="ob-c-task' + blank + '">' + taskControl + '</td>' +
      '<td class="ob-c-note"><div class="ob-note-cell">' + noteChipsHtml(note, item.index, item.extra) + noteInput + '</div></td>' +
      '<td class="ob-c-status"><span class="ob-row-status ' + status.cls + '"><i></i>' + status.word + '</span></td>' +
      '<td class="ob-c-act ob-act-cell">' + actions + '</td>' +
      '</tr>';
  }

  function groupRowHtml(group, colspan) {
    var total = group.items.length;
    var done = group.items.filter(function (i) { return i.target && i.target.cleanDone; }).length;
    return '<tr class="ob-grp"><td colspan="' + colspan + '"><div class="ob-grp-line">' +
      '<b>' + esc(group.label) + '</b>' +
      '<em>' + total + (total === 1 ? ' property' : ' properties') + '</em>' +
      '<span class="ob-gclean' + (total && done === total ? ' ob-allclean' : '') + '">' + done + '/' + total + ' clean</span>' +
      '</div></td></tr>';
  }

  // ── chrome ───────────────────────────────────────────────────────────────
  // Contextual by design: the bar only exists while rows are selected.
  function bulkBarHtml(filtered, allItems) {
    var count = selectedItems(allItems).length;
    if (!count) return '';
    var actionable = filtered.filter(function (item) { return !!item.target; });
    var allFilteredSelected = !!actionable.length && actionable.every(function (item) { return !!state.selected[itemId(item)]; });
    var options = '<option value="">Assign cleaner…</option>' + cleanerRoster().map(function (name) {
      return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
    }).join('');
    var taskOpts = '<option value="">Set task…</option>' + taskOptions('__none__').replace(/ selected/g, '');
    return '<div class="ob-bulk active">' +
      '<b>' + count + ' selected</b>' +
      '<button class="ob-btn" data-ob-action="select-all-results"' + (!actionable.length || allFilteredSelected ? ' disabled' : '') + '>Select all ' + actionable.length + ' actionable</button>' +
      '<select class="ob-select" data-ob-action="bulk-cleaner" aria-label="Assign cleaner to selected rows">' + options + '</select>' +
      '<select class="ob-select" data-ob-action="bulk-task" aria-label="Set task on selected rows">' + taskOpts + '</select>' +
      '<button class="ob-btn" data-ob-action="bulk-done">Mark clean</button>' +
      '<button class="ob-btn" data-ob-action="bulk-open">Reopen</button>' +
      '<span class="ob-spacer"></span>' +
      '<button class="ob-btn ob-quiet" data-ob-action="clear-selection">Clear selection</button>' +
      '</div>';
  }

  function footHtml(page, pageCount, total, shown) {
    var all = !Number(state.pageSize);
    var sizes = [[0, 'Fit all rows'], [25, '25 per page'], [50, '50 per page'], [100, '100 per page']];
    return '<div class="ob-listfoot">' +
      '<div class="ob-pager">' +
        '<button class="ob-step" data-ob-action="page" data-ob-page="' + (page - 1) + '"' + (page <= 1 || all ? ' disabled' : '') + ' aria-label="Previous page">‹</button>' +
        '<b>' + (all ? 'Showing all' : ('Page ' + page + ' / ' + pageCount)) + '</b>' +
        '<button class="ob-step" data-ob-action="page" data-ob-page="' + (page + 1) + '"' + (page >= pageCount || all ? ' disabled' : '') + ' aria-label="Next page">›</button>' +
      '</div>' +
      '<select class="ob-select" data-ob-action="page-size" aria-label="Rows shown in the table">' +
        sizes.map(function (s) {
          return '<option value="' + s[0] + '"' + (Number(state.pageSize) === s[0] ? ' selected' : '') + '>' + esc(s[1]) + '</option>';
        }).join('') +
      '</select>' +
      '<span class="ob-showing">' + (all ? ('Showing all ' + total) : ('Showing ' + shown + ' of ' + total)) + ' matching rows</span>' +
      legendHtml() +
      '</div>';
  }

  // The dots repeat the row status colours; the second line is the key to the
  // flag vocabulary the ⋯ menu writes into the notes column.
  function legendHtml() {
    return '<div class="ob-tone-legend" aria-label="Board colour key">' +
      '<span class="ob-tone-lg"><i class="tone-hot"></i>Blocking</span>' +
      '<span class="ob-tone-lg"><i class="tone-warn"></i>Unassigned / check-in unknown</span>' +
      '<span class="ob-tone-lg"><i class="tone-done"></i>Done</span>' +
      '<span class="ob-tone-lg"><i class="tone-open"></i>Neutral — nothing to flag</span>' +
      '<span class="ob-tone-lg">Flags: ⏰ Late checkout · ❗ Priority · 👶 Park bed · ☀️ Early check-in</span>' +
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

  // ── summary cards ────────────────────────────────────────────────────────
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
    return '<option value="">No property</option>' + list.map(function (apt) {
      return '<option value="' + esc(apt.id) + '"' + (String(current || '') === String(apt.id) ? ' selected' : '') + '>' + esc(apt.name) + '</option>';
    }).join('');
  }

  function taskRowHtml(task) {
    var apt = task.aptName || '';
    if (!apt && task.aptId) {
      var hit = (S.apts || []).find(function (a) { return a.id === task.aptId; });
      apt = hit ? hit.name : '';
    }
    return '<div class="ob-task' + (task.completed ? ' ob-task-done' : '') + '">' +
      '<button type="button" class="ob-rcheck' + (task.completed ? ' ob-on' : '') + '" data-ob-action="task-toggle" data-ob-id="' + esc(task.id) + '" aria-pressed="' + (task.completed ? 'true' : 'false') + '" aria-label="Toggle task">✓</button>' +
      '<span class="ob-tx">' + esc(task.text) + '</span>' +
      (apt ? '<span class="ob-tapt">' + esc(apt) + '</span>' : '') +
      '<button type="button" class="ob-xdel" data-ob-action="task-delete" data-ob-id="' + esc(task.id) + '" aria-label="Delete task">×</button>' +
      '</div>';
  }

  function composerHtml() {
    if (!state.composer) return '';
    return '<div class="ob-composer">' +
      '<input class="ob-input" data-ob-action="task-text" data-ob-focus="task-text" value="' + esc(state.draftText) + '" placeholder="New task for ' + esc(dateLabel(_opsDate)) + '…" aria-label="New task">' +
      '<select class="ob-select" data-ob-action="task-apt" aria-label="Property">' + aptOptionsHtml(state.draftApt) + '</select>' +
      '<button class="ob-btn ob-primary" data-ob-action="task-save">Add</button>' +
      '<button class="ob-btn ob-quiet" data-ob-action="task-cancel">Cancel</button>' +
      '</div>';
  }

  function ringHtml(pct) {
    var r = 27;
    var circ = 2 * Math.PI * r;
    var off = circ * (1 - (pct / 100));
    return '<svg class="ob-ring" viewBox="0 0 64 64" aria-hidden="true">' +
      '<circle cx="32" cy="32" r="' + r + '" fill="none" stroke="#e4dccf" stroke-width="4"></circle>' +
      '<circle cx="32" cy="32" r="' + r + '" fill="none" stroke="#0e5fa7" stroke-width="4" stroke-linecap="round" ' +
        'stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 32 32)"></circle>' +
      '</svg>';
  }

  function cardsHtml(cleanDay, pct, summary, tasks) {
    var openTasks = tasks.filter(function (t) { return !t.completed; }).length;
    return '<section class="ob-cards">' +
      '<div class="ob-card ob-card-tasks">' +
        '<div class="ob-tasks-in">' +
          '<div class="ob-tasks-num">' +
            '<span class="ob-card-label">Open tasks</span>' +
            '<span class="ob-bignum">' + openTasks + '</span>' +
            (state.composer ? '' : '<button type="button" class="ob-addtask" data-ob-action="task-open">＋ Add task</button>') +
          '</div>' +
          '<div class="ob-tasks-body"><div class="ob-tasklist">' +
            (tasks.length ? tasks.map(taskRowHtml).join('') : '<div class="ob-card-foot">No tasks for this day</div>') +
          '</div></div>' +
        '</div>' +
        composerHtml() +
      '</div>' +
      '<div class="ob-card ob-card-prog">' +
        '<div class="ob-card-label">Cleaning progress</div>' +
        '<div class="ob-ringwrap">' + ringHtml(pct) +
          '<div><div class="ob-ring-num">' + cleanDay.done + ' / ' + cleanDay.total + '</div><div class="ob-ring-sub">' + pct + '% cleaned</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="ob-card">' +
        '<div class="ob-card-label">Unassigned</div>' +
        '<div class="ob-bignum">' + summary.unassigned + '</div>' +
        '<div class="ob-card-foot"><i style="background:#c08a2c"></i>need a cleaner</div>' +
      '</div>' +
      '<div class="ob-card ob-card-arrivals">' +
        '<div class="ob-card-label">Arrivals</div>' +
        '<div class="ob-bignum">' + summary.arrivals + '</div>' +
        '<div class="ob-card-foot"><i style="background:#16283a"></i>check-ins today</div>' +
      '</div>' +
      '</section>' +
      '<div class="ob-progstrip"><span>Cleaning progress</span><span class="ob-striptrack"><i style="width:' + pct + '%"></i></span>' +
      '<span>' + cleanDay.done + ' / ' + cleanDay.total + '</span></div>';
  }

  // ── side panel ───────────────────────────────────────────────────────────
  function sectionHtml(key, title, body) {
    var open = !!state.open[key];
    return '<div class="ob-sec">' +
      '<button type="button" class="ob-sechead' + (open ? ' ob-open' : '') + '" data-ob-action="section" data-ob-panel="' + esc(key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      esc(title) + '<span class="ob-arw">▾</span></button>' +
      (open ? '<div class="ob-secbody">' + body + '</div>' : '') +
      '</div>';
  }

  function cleanersBody(load) {
    var roster = cleanerRoster();
    var list = roster.length
      ? roster.map(function (name) {
        var n = load[name] || 0;
        return '<div class="ob-prow"><span class="ob-pname">' + esc(name) + '</span>' +
          '<span class="ob-pload">' + n + ' today</span></div>';
      }).join('')
      : '<div class="ob-empty-line">No cleaners on the roster yet.</div>';
    return list + '<div class="ob-addrow"><span class="ob-spacer"></span>' +
      '<button type="button" class="ob-addlink" data-ob-action="manage-cleaners">＋ Manage cleaners</button></div>';
  }

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
    return '<select class="ob-select" data-ob-action="staff" data-ob-block="' + esc(block) + '" data-ob-index="' + index + '" aria-label="Person">' + options + '</select>';
  }

  function staffBlockHtml(title, block, baseRows, extra, leave) {
    var rowExtra = Number((extra._rows || {})[block] || 0);
    var count = baseRows + rowExtra;
    var values = extra[block] || {};
    var html = '<div class="ob-subhead">' + esc(title) + '</div>';
    for (var i = 0; i < count; i++) {
      html += '<div class="ob-staff-row">' + personSelect(block, i, String(values[i] || ''));
      if (leave) {
        var days = Number(((extra.adeiesDur || {})[i]) || 1);
        html += '<input class="ob-input ob-days" type="number" min="1" max="30" value="' + days + '" data-ob-action="leave-days" data-ob-index="' + i + '" data-ob-focus="leave:' + i + '" aria-label="Days of leave">';
      }
      html += '</div>';
    }
    return html + '<div class="ob-addrow"><span class="ob-spacer"></span>' +
      '<button type="button" class="ob-addlink" data-ob-action="staff-add" data-ob-block="' + esc(block) + '">＋ Add</button></div>';
  }

  function staffBody() {
    if (typeof _opsSyncUnassignedToRepo === 'function') {
      try { _opsSyncUnassignedToRepo(); } catch (e) {}
    }
    _opsEnsure();
    var extra = (S.daily.extra && S.daily.extra[_opsDate]) || {};
    return staffBlockHtml('On call', 'oncall', 1, extra, false) +
      staffBlockHtml('Day off', 'repo', 5, extra, false) +
      staffBlockHtml('Leave', 'adeies', 5, extra, true) +
      staffBlockHtml('Linen · Cholargos', 'imatismos_cholargos', 1, extra, false) +
      staffBlockHtml('Linen · Thessaloniki', 'imatismos_thess', 1, extra, false);
  }

  function routeStops(index) {
    if (typeof _opsDriverRoutes === 'function') return _opsDriverRoutes(index) || [];
    var day = (S.daily.extra && S.daily.extra[_opsDate]) || {};
    if (!day.odigoiRoutes) day.odigoiRoutes = {};
    if (!Array.isArray(day.odigoiRoutes[index])) day.odigoiRoutes[index] = [];
    return day.odigoiRoutes[index];
  }

  function routesBody() {
    _opsEnsure();
    var extra = (S.daily.extra && S.daily.extra[_opsDate]) || {};
    var count = 2 + Number((extra._rows || {}).odigoi || 0);
    var values = extra.odigoi || {};
    var aptOptions = (typeof _opsScheduleAptOptions === 'function') ? _opsScheduleAptOptions() : [];
    var html = '';
    for (var i = 0; i < count; i++) {
      var stops = routeStops(i);
      html += '<div class="ob-driver">' +
        '<div class="ob-staff-row"><input class="ob-input" list="ops-beta-drivers" value="' + esc(values[i] || '') + '" data-ob-action="staff" data-ob-block="odigoi" data-ob-index="' + i + '" data-ob-focus="driver:' + i + '" placeholder="Driver" aria-label="Driver"></div>' +
        '<div class="ob-stops">' + (stops.length ? stops.map(function (stop, stopIndex) {
          return '<span class="ob-stop">' + esc(stop.name || stop.key) +
            '<button type="button" data-ob-action="route-remove" data-ob-driver="' + i + '" data-ob-stop="' + stopIndex + '" aria-label="Remove stop">×</button></span>';
        }).join('') : '<span class="ob-empty-line">No stops yet</span>') + '</div>' +
        '<select class="ob-select" style="width:100%" data-ob-action="route-add" data-ob-driver="' + i + '" aria-label="Add stop"><option value="">＋ Add apartment stop…</option>' +
        aptOptions.map(function (opt) {
          var used = stops.some(function (stop) { return stop.key === opt.key; });
          return '<option value="' + esc(opt.key) + '"' + (used ? ' disabled' : '') + '>' + esc(opt.title || opt.name) + '</option>';
        }).join('') + '</select>' +
        '</div>';
    }
    return html + '<div class="ob-addrow"><span class="ob-spacer"></span>' +
      '<button type="button" class="ob-addlink" data-ob-action="staff-add" data-ob-block="odigoi">＋ Add driver</button></div>';
  }

  function notesBody() {
    return '<textarea class="ob-notes" data-ob-action="notes" data-ob-focus="daily-notes" placeholder="Notes for the day…" aria-label="Daily notes">' + esc(_opsNotes) + '</textarea>';
  }

  function schedBody() {
    return '<label class="ob-filebtn">☁ Upload cleaning schedule photo' +
      '<input type="file" accept="image/*" data-ob-action="schedule-file" id="ops-beta-schedule-file"></label>' +
      '<div class="ob-schedcheck" id="ops-schedcheck"></div>';
  }

  function exportBody() {
    return '<div class="ob-exports">' +
      '<button type="button" class="ob-exbtn" data-ob-action="ops-image"><i>▦</i>Ops image</button>' +
      '<button type="button" class="ob-exbtn" data-ob-action="cleaner-image"><i>✦</i>Cleaner image</button>' +
      '<button type="button" class="ob-exbtn" data-ob-action="copy-list"><i>⎘</i>Copy list (text)</button>' +
      '<button type="button" class="ob-exbtn ob-danger" data-ob-action="restart">Restart cleans</button>' +
      '</div>';
  }

  function panelHtml(load) {
    return '<aside class="ob-panel' + (state.drawerOpen ? ' ob-open' : '') + '" id="ops-beta-panel">' +
      sectionHtml('cleaners', 'Cleaners', cleanersBody(load)) +
      sectionHtml('staff', 'Staff', staffBody()) +
      sectionHtml('routes', 'Routes', routesBody()) +
      sectionHtml('notes', 'Notes', notesBody()) +
      sectionHtml('sched', 'Schedule check', schedBody()) +
      sectionHtml('exports', 'Export', exportBody()) +
      '</aside>';
  }

  // ── staff / routes writes ────────────────────────────────────────────────
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
    var arrivals = items.filter(function (item) {
      var row = item.row || {};
      return isArrivalOnly(row) || row.checkinSameDay === 'yes';
    }).length;
    return { open: open, unassigned: unassigned, decisions: decisions, unknown: unknown, arrivals: arrivals };
  }

  // ── top bar + rail ───────────────────────────────────────────────────────
  var COLSPAN = 9;

  function commandBarHtml(isToday) {
    return '<header class="ob-command">' +
      '<span class="ob-brand">Elysian</span>' +
      '<h1 class="ob-screen-title">Daily Ops</h1>' +
      '<div class="ob-datebar">' +
        '<button type="button" class="ob-step" data-ob-action="nav" data-ob-days="-1" aria-label="Previous day">‹</button>' +
        '<button type="button" class="ob-pill' + (isToday ? ' ob-on' : '') + '" data-ob-action="today">Today</button>' +
        '<button type="button" class="ob-step" data-ob-action="nav" data-ob-days="1" aria-label="Next day">›</button>' +
        '<input class="ob-input ob-dateinput" type="date" value="' + esc(_opsDate) + '" data-ob-action="date" data-ob-focus="date" aria-label="Date">' +
        '<span class="ob-datelabel">' + esc(dateLabel(_opsDate)) + '</span>' +
      '</div>' +
      '<span class="ob-spacer"></span>' +
      '<span class="ob-savestate"><i></i><span id="ops-beta-save-state">Auto-save on</span></span>' +
      '<button type="button" class="ob-pill ob-ghost ob-toppanel" data-ob-action="toggle-panel">▤ Panel</button>' +
      '</header>';
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
      // The chip already reads "Label N" on screen, so a title= would only
      // duplicate it as a native tooltip. aria-label carries the same string
      // for assistive tech (and for the tests) without the hover popup.
      var plain = seg[1] + ' ' + seg[2];
      return '<button type="button" class="ob-filter' + (state.filter === seg[0] ? ' on' : '') +
        '" data-ob-action="filter" data-ob-filter="' + seg[0] + '" aria-label="' + esc(plain) + '">' +
        (seg[3] ? '<i class="' + seg[3] + '"></i>' : '') + esc(seg[1]) + ' <em>' + seg[2] + '</em></button>';
    }).join('');
    return '<div class="ob-rail">' +
      '<div class="ob-segs" id="ops-beta-segs">' + filters + '</div>' +
      '<div class="ob-railtools">' +
        '<input class="ob-input ob-search" type="search" value="' + esc(state.search) + '" data-ob-action="search" data-ob-focus="search" placeholder="Search property, cleaner, note…" aria-label="Search property, cleaner or note">' +
        '<span class="ob-field"><label for="ops-beta-group">Group</label>' +
          '<select class="ob-select" id="ops-beta-group" data-ob-action="group">' +
            '<option value="area"' + (state.group === 'area' ? ' selected' : '') + '>Area</option>' +
            '<option value="cleaner"' + (state.group === 'cleaner' ? ' selected' : '') + '>Cleaner</option>' +
            '<option value="none"' + (state.group === 'none' ? ' selected' : '') + '>None</option>' +
          '</select></span>' +
        '<span class="ob-field"><label for="ops-beta-sort">Sort</label>' +
          '<select class="ob-select" id="ops-beta-sort" data-ob-action="sort">' +
            '<option value="status"' + (state.sort === 'status' ? ' selected' : '') + '>Status</option>' +
            '<option value="cleaner"' + (state.sort === 'cleaner' ? ' selected' : '') + '>Cleaner / route</option>' +
            '<option value="default"' + (state.sort === 'default' ? ' selected' : '') + '>Default (ungrouped)</option>' +
          '</select></span>' +
      '</div>' +
      '</div>';
  }

  // ── render ───────────────────────────────────────────────────────────────
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
    var actionableVisible = visibleItems.filter(function (item) { return !!item.target; }).length;
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
      body = '<tr><td colspan="' + COLSPAN + '"><div class="ob-emptystate">No rows match this view. Try another filter or clear the search.</div></td></tr>';
    }

    root.innerHTML = '<div class="ob-shell">' +
      commandBarHtml(isToday) +
      '<div class="ob-wrap"><div class="ob-layout' + (state.panelOpen ? '' : ' ob-no-panel') + '">' +
        '<main class="ob-main">' +
          cleanerDatalist() + driverDatalist() +
          cardsHtml(cleanDay, pct, summary, tasks) +
          railHtml(allItems, summary, cleanDay) +
          bulkBarHtml(visibleItems, allItems) +
          '<div id="ops-beta-board-capture"><div class="ob-list">' +
            '<div class="ob-list-head">' +
              '<h2>Dispatch board</h2>' +
              '<small>' + esc(dateLabel(_opsDate)) + ' · showing ' + pageItems.length + ' of ' + visibleItems.length + ' matching rows</small>' +
              '<span class="ob-spacer"></span>' +
              '<button class="ob-btn ob-quiet ob-selectall" data-ob-action="select-all-results"' + (actionableVisible ? '' : ' disabled') + '>Select all ' + actionableVisible + '</button>' +
              '<span class="ob-clean-count">' + cleanDay.done + ' / ' + cleanDay.total + ' clean</span>' +
              '<div class="ob-progress"><span style="width:' + pct + '%"></span></div>' +
            '</div>' +
            '<div class="ob-table-wrap"><table class="ob-dispatch-table"><thead><tr>' +
              '<th class="ob-c-sel ob-center"><input type="checkbox" class="ob-sel-check" data-ob-action="select-page"' + (pageAllSelected ? ' checked' : '') + ' aria-label="Select this page"></th>' +
              '<th class="ob-c-tick ob-center">Clean</th>' +
              '<th class="ob-c-prop">Property</th>' +
              '<th class="ob-c-stay">Stay</th>' +
              '<th class="ob-c-crew">Cleaner</th>' +
              '<th class="ob-c-task">Task</th>' +
              '<th class="ob-c-note">Notes</th>' +
              '<th class="ob-c-status">Status</th>' +
              '<th class="ob-c-act"></th>' +
            '</tr></thead><tbody>' + body + '</tbody></table></div>' +
          '</div></div>' +
          footHtml(state.page, pageCount, visibleItems.length, pageItems.length) +
        '</main>' +
        panelHtml(load) +
      '</div></div>' +
      '<div class="ob-backdrop' + (state.drawerOpen ? ' ob-on' : '') + '" data-ob-action="drawer-close"></div>' +
      '<button type="button" class="ob-fab" data-ob-action="drawer-toggle">▤ Panel</button>' +
      '</div>';

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

  // Removal defers to the host's opsRemoveRow when it exists so the beta board
  // and the legacy board delete rows through exactly one code path (it owns the
  // confirm, the splice and the autosave). It reports nothing back, so the
  // array length before/after is what tells us whether the operator confirmed.
  function removeRow(index) {
    var row = _opsRows[index];
    if (!row) return false;
    var before = _opsRows.length;
    if (typeof opsRemoveRow === 'function') {
      opsRemoveRow(index);
    } else {
      var name = row.aptName || 'this property';
      if (!window.confirm('Remove ' + name + " from today's list?")) return false;
      _opsRows.splice(index, 1);
      persist(true);
    }
    if (_opsRows.length === before) return false;
    // The row is gone from _opsRows but still in the day snapshot until we
    // persist, and _opsLoadData would rebuild it straight back from the live
    // bookings — so write the shortened list out and repaint from it.
    forgetSelection(row);
    closeOverlays();
    persist(true);
    state.skipReload = true;
    rerender();
    return true;
  }

  // A removed row must not keep a phantom entry in the bulk selection.
  function forgetSelection(row) {
    var target = (typeof _opsCleanTarget === 'function') ? _opsCleanTarget(row) : row;
    var key = (target && typeof _opsCleanStorageKey === 'function') ? _opsCleanStorageKey(target) : '';
    Object.keys(state.selected).forEach(function (id) {
      if (key && id.indexOf(key) >= 0) delete state.selected[id];
    });
  }

  // ── tasks (inline composer — no window.prompt) ───────────────────────────
  function toggleTask(id) {
    var task = (S.daily.tasks || []).find(function (item) { return item.id === id; });
    if (!task) return;
    task.completed = !task.completed;
    task.completedDate = task.completed ? _opsDate : null;
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
          backgroundColor: '#faf9f7',
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

  // The panel is docked on desktop and an overlay drawer below the layout
  // breakpoint, so the same button has to mean two different things. matchMedia
  // is absent from the bare test context, hence the guard.
  function drawerMode() {
    try {
      if (typeof window.matchMedia !== 'function') return false;
      return window.matchMedia('(max-width: 1400px)').matches;
    } catch (e) {
      return false;
    }
  }

  // ── events ───────────────────────────────────────────────────────────────
  function bind(root) {
    if (root.dataset.opsBetaBound === '1') return;
    root.dataset.opsBetaBound = '1';

    root.addEventListener('click', function (event) {
      var button = event.target.closest('[data-ob-action]');
      if (!button || !root.contains(button)) {
        if (state.menuFor || state.assignFor) { closeOverlays(); rerender(); }
        return;
      }
      var action = button.dataset.obAction;
      if (action === 'section') {
        event.preventDefault();
        var panel = button.dataset.obPanel;
        state.open[panel] = !state.open[panel];
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
      } else if (action === 'toggle-panel') {
        if (drawerMode()) state.drawerOpen = !state.drawerOpen;
        else state.panelOpen = !state.panelOpen;
        rerender();
      } else if (action === 'drawer-toggle') {
        state.drawerOpen = !state.drawerOpen; rerender();
      } else if (action === 'drawer-close') {
        state.drawerOpen = false; rerender();
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
      } else if (action === 'clean') {
        var tickRow = findClean(decoded(button.dataset.obKey));
        if (tickRow) {
          tickRow.cleanDone = !tickRow.cleanDone;
          persist(true);
          if (typeof _opsMaybeAdvanceAfterCleans === 'function') _opsMaybeAdvanceAfterCleans();
          rerender();
        }
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
      } else if (action === 'manage-cleaners') {
        closeOverlays();
        if (typeof opsManageCleaners === 'function') opsManageCleaners();
        rerender();
      } else if (action === 'copy-list') {
        closeOverlays();
        if (typeof opsCopyCleanList === 'function') opsCopyCleanList();
      } else if (action === 'task-open') {
        state.composer = true; rerender();
      } else if (action === 'task-cancel') {
        state.composer = false; state.draftText = ''; state.draftApt = ''; rerender();
      } else if (action === 'task-save') {
        saveTask();
      } else if (action === 'task-toggle') {
        event.preventDefault(); toggleTask(button.dataset.obId);
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
        copyBetaImage();
      } else if (action === 'cleaner-image') {
        if (typeof opsCopyCleaningImage === 'function') opsCopyCleaningImage();
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
      if (event.key === 'Escape') {
        if (state.menuFor || state.assignFor) { closeOverlays(); rerender(); return; }
        if (state.drawerOpen) { state.drawerOpen = false; rerender(); }
        return;
      }
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
        if (input.dataset.obField === 'arrivalTime' && input.classList) {
          input.classList.toggle('ob-eta-empty', !input.value);
        }
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
