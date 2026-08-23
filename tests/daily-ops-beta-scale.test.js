'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
const listeners = {};
const panel = {
  dataset: {},
  innerHTML: '',
  addEventListener(type, handler) { listeners[type] = handler; },
  contains() { return true; },
  querySelector() { return null; },
};

const rows = Array.from({ length: 200 }, (_, index) => ({
  aptId: 'a' + (index + 1),
  aptName: 'Apartment ' + String(index + 1).padStart(3, '0'),
  checkinSameDay: index % 5 === 0 ? 'unknown' : 'yes',
  nextNights: 2 + (index % 6),
  people: 1 + (index % 5),
  arrivalTime: (14 + (index % 8)) + ':00',
  comments: index % 11 === 0 ? 'PRIORITY' : (index % 13 === 0 ? 'Prepare 1 sofa bed' : ''),
  isPriority: index % 11 === 0,
  lateCheckout: index % 17 === 0,
  earlyCheckin: index % 19 === 0,
  cleanType: 'turnover',
  cleanTask: 'katharismos',
  cleanerNames: index % 4 === 0 ? [] : [['Maria', 'Eleni', 'Katerina'][index % 3]],
  cleanerName: index % 4 === 0 ? '' : ['Maria', 'Eleni', 'Katerina'][index % 3],
  cleanDone: index % 7 === 0,
}));

const apartments = rows.map((row, index) => ({
  id: row.aptId,
  name: row.aptName,
  address: (index + 1) + ' Example St',
  area: ['Athens', 'Piraeus', 'Thessaloniki'][index % 3],
}));

const S = {
  apts: apartments,
  bks: [],
  cleaners: ['Maria', 'Eleni', 'Katerina'],
  drivers: ['Yannis'],
  daily: {
    snapshots: {},
    tasks: [],
    extra: {
      '2026-08-15': {
        oncall: {}, repo: {}, adeies: {}, adeiesDur: {},
        imatismos_cholargos: {}, imatismos_thess: {}, odigoi: {},
        odigoiRoutes: {}, _rows: {},
      },
    },
  },
};

const context = {
  console, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
  Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, isFinite,
  URL, navigator: {}, ClipboardItem() {}, confirm: () => true, prompt: () => '',
  S, _opsDate: '2026-08-15', _opsRows: [], _opsCleanExtras: [], _opsNotes: '',
  _dbAvailable: false,
  OPS_CLEAN_TASKS: [
    ['katharismos', 'Cleaning'], ['prepare_sofa', 'Sofa'],
    ['episkeui', 'Repair'], ['extra', 'Extra'],
  ],
  OPS_TAG_LATE: 'Late Checkout: 12:00',
  OPS_TAG_PRIORITY: 'PRIORITY',
  OPS_TAG_EARLY: 'Early check-in',
  OPS_TAG_PARK: 'Παρκοκρεβάτο',
  OPS_KINDS: [
    { key: 'isMaintenance', manual: 'maintenanceManual' },
    { key: 'isPreparation', manual: 'preparationManual' },
    { key: 'isExtended', manual: 'extendedManual' },
  ],
  document: {
    getElementById(id) { return id === 'tab-ops' ? panel : null; },
    createElement() { return { style: {}, setAttribute() {}, click() {}, remove() {} }; },
    head: { appendChild() {} },
    body: { appendChild() {} },
  },
};

context.window = context;
context.window._opsBetaState = {
  filter: 'all', sort: 'default', search: '', selected: {},
  selectionDate: '', focusId: '', page: 1, pageSize: 50,
};
context.window.requestAnimationFrame = (fn) => fn();
context.window.showTab = function () {};
Object.assign(context, {
  startDbPoll() {}, save() {}, saveToDb() {}, _opsSaveNow() {}, _opsEnsure() {},
  _opsTodayStr: () => '2026-08-15',
  _opsDefaultOpsDate: () => '2026-08-15',
  _opsDayLabel: () => '15 August 2026',
  _opsLoadData: () => ({ rows, notes: '' }),
  _opsPrepareCleanDay() {
    context._opsCleanExtras = [];
    return { done: rows.filter((row) => row.cleanDone).length, total: rows.length, clean: rows, extras: [] };
  },
  _opsCleanTarget: (row) => row,
  _opsCleanStorageKey: (row) => (row.aptId || row.aptName) + '::' + (row.cleanType || 'turnover'),
  _opsFindCleanRow: (key) => rows.find((row) => row.aptId + '::' + (row.cleanType || 'turnover') === key),
  _opsCleanerList: (row) => row ? (row.cleanerNames || []) : [],
  _opsKindOf: () => null,
  _opsAptOf: (row) => apartments.find((apt) => apt.id === row.aptId),
  _opsAptLines(row) {
    const apt = apartments.find((candidate) => candidate.id === row.aptId);
    return { name: apt.name, addr: apt.address };
  },
  _opsAvailableCleaners: () => S.cleaners,
  _opsScheduleAptOptions: () => [],
  _opsDriverRoutes: () => [],
  _opsSyncUnassignedToRepo() {}, _opsApplySofaCommentsAll() {},
  _opsApplySameDayPriorityAll() {}, _opsPrefetchRentalInfo() {},
  aptAreaLabel: (apt) => apt.area || '',
});

vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(rootDir, 'fe', 'daily-ops-beta.js'), 'utf8'), context);
context.renderOpsBeta();

const renderedRows = () => (panel.innerHTML.match(/class="ob-dispatch-row/g) || []).length;
const event = (action, extra = {}) => ({
  target: Object.assign({ dataset: { obAction: action }, tagName: 'INPUT', closest() { return this; } }, extra),
  preventDefault() {},
});

assert.strictEqual(renderedRows(), 50, 'paged mode still renders one 50-row page');
assert(panel.innerHTML.includes('Page 1 / 4'), '200 rows produce four pages when page size is 50');
assert(panel.innerHTML.includes('showing 50 of 200'), 'visible and total counts are explicit');

listeners.change(event('select-page', { checked: true }));
assert.strictEqual(Object.keys(context._opsBetaState.selected).length, 50, 'select-page selects 50 rows');

listeners.change(event('bulk-cleaner', { value: 'Maria', tagName: 'SELECT' }));
assert(rows.slice(0, 50).every((row) => row.cleanerName === 'Maria'), 'bulk cleaner assignment updates the page');

listeners.click(event('page', { dataset: { obAction: 'page', obPage: '2' } }));
assert(panel.innerHTML.includes('Page 2 / 4'), 'paging advances without expanding the DOM');

listeners.click(event('select-all-results'));
assert.strictEqual(Object.keys(context._opsBetaState.selected).length, 200, 'select-all covers every filtered result');

listeners.change(event('bulk-cleaner', { value: 'Eleni', tagName: 'SELECT' }));
assert(rows.every((row) => row.cleanerName === 'Eleni'), 'bulk bar assigns all selected rows from the main table');

listeners.change(event('page-size', { value: '0', tagName: 'SELECT' }));
assert.strictEqual(renderedRows(), 200, 'Fit all rows shows every matching row');
assert(panel.innerHTML.includes('Showing all'), 'pager reports showing all rows');
assert(panel.innerHTML.includes('showing 200 of 200'), 'board head matches full day length');
assert(panel.innerHTML.includes('Fit all rows'), 'fit-all option is available');

assert(!panel.innerHTML.includes('Crew workload'), 'crew workload side panel removed');
assert(!panel.innerHTML.includes('Reservation details'), 'reservation details side panel removed');
assert(panel.innerHTML.includes('>Notes<'), 'notes stay on the main table');
assert(panel.innerHTML.includes('⏰'), 'late checkout uses a clock icon');
assert(panel.innerHTML.includes('❗'), 'priority uses an exclamation icon');
assert(panel.innerHTML.includes('👶'), 'park bed uses a baby icon');
assert(panel.innerHTML.includes('☀️'), 'early check-in uses a sun icon');
assert(!/>L</.test(panel.innerHTML) && !/>P</.test(panel.innerHTML), 'letter flag labels are gone');

assert(panel.innerHTML.includes('tone-hot'), 'ops-urgency hot tone is rendered');
assert(panel.innerHTML.includes('tone-warn'), 'ops-urgency warn tone is rendered');
assert(panel.innerHTML.includes('tone-done'), 'ops-urgency done tone is rendered');
assert(panel.innerHTML.includes('ob-tone-legend'), 'color legend is on the board');
assert(panel.innerHTML.includes('>Blocking</span>') || /tone-hot"><\/i>Blocking/.test(panel.innerHTML), 'legend names the blocking tone');
assert(panel.innerHTML.includes('Neutral — nothing to flag'), 'legend names the neutral tone');
assert(panel.innerHTML.includes('data-ob-action="manage-cleaners"'), 'roster manage control present');
assert(panel.innerHTML.includes('Manage cleaners'), 'roster manage control is labelled in English');
assert(panel.innerHTML.includes('ob-cchip') || panel.innerHTML.includes('Add cleaner'), 'cleaner chips / add field present');
assert(!panel.innerHTML.includes('BETA'), 'Beta badge removed after promote');
assert(typeof context.renderOps === 'function', 'renderOps overwritten by promoted UI');
assert.strictEqual(context.renderOps, context.renderOpsBeta, 'renderOps and renderOpsBeta are the same renderer');

// Seed a row with all colored note tags and re-render.
rows[0].comments = 'PRIORITY · Late Checkout: 12:00 · Prepare 1 sofa bed · Early check-in';
rows[0].isPriority = true;
rows[0].lateCheckout = true;
rows[0].earlyCheckin = true;
rows[0].cleanDone = false;
context._opsBetaState.pageSize = 0;
context.renderOps();
assert(panel.innerHTML.includes('ob-nchip hot'), 'PRIORITY / Late notes render as red chips');
assert(panel.innerHTML.includes('ob-nchip cool'), 'sofa / Early notes render as blue chips');
// The tag text sits in its own span so a long tag can ellipsize inside the chip
// without pushing the remove button out of the notes cell.
// Chips label the tag rather than echo the stored token, so PRIORITY is shown
// in sentence case while the underlying comment string is left alone. The notes
// column is ~138px wide and also holds the free-text field, so only the leading
// tag is drawn and the remainder becomes a hover-titled count.
assert(/ob-nchip hot"><span>Priority</.test(panel.innerHTML), 'the actionable flag leads and is hot/red');
assert(!/>PRIORITY</.test(panel.innerHTML), 'no chip shouts the raw stored token');
assert(rows[0].comments.includes('PRIORITY'), 'the stored comment token itself is untouched');
assert(
  /ob-nchip hot"><span>Priority<\/span><button[^>]*data-ob-flag="priority"/.test(panel.innerHTML),
  'a flag-backed tag stays removable straight from its chip'
);
const moreChip = new RegExp(
  '<span class="ob-nchip ob-nmore"><span aria-hidden="true">\\+(\\d+)</span>' +
  '<span class="ob-sr">([^<]*)</span></span>'
).exec(panel.innerHTML);
assert(moreChip, 'the tags that do not fit collapse into a count');
assert(Number(moreChip[1]) === 3, 'the count covers the three remaining tags');
['Late 12:00', 'Prepare 1 sofa bed', 'Early check-in'].forEach((label) => {
  assert(moreChip[2].includes(label), 'the count names ' + label + ' for assistive tech');
});

const css = fs.readFileSync(path.join(rootDir, 'fe', 'daily-ops-beta.css'), 'utf8');
assert(/\.ob-nchip\.hot/.test(css) && /\.ob-nchip\.cool/.test(css), 'note chip color styles present');
assert(!/#tab-opsbeta/.test(css), 'CSS retargeted off #tab-opsbeta');
assert(/#tab-ops\s*\{/.test(css), 'CSS scoped to #tab-ops');
assert(/\.ob-cchip/.test(css), 'cleaner chip styles present');
assert(!/ob-table-wrap\s*\{[^}]*max-height/.test(css), 'table wrap has no fixed max-height');
assert(/ob-table-wrap\s*\{[^}]*overflow-y:\s*visible/.test(css), 'table height follows row count');
assert(/\.ob-dispatch-row\.tone-hot td/.test(css), 'hot tone styles present');
assert(/\.ob-dispatch-row\.tone-same td/.test(css), 'same-day tone styles present');
assert(!/color-mix\s*\(/.test(css), 'Daily Ops CSS avoids color-mix for html2canvas compatibility');
assert(!/oklch\s*\(|color\s*\(srgb/i.test(css), 'Daily Ops CSS avoids modern color() forms that break screenshots');

const betaJs = fs.readFileSync(path.join(rootDir, 'fe', 'daily-ops-beta.js'), 'utf8');
assert(betaJs.includes('html2canvas-pro@1.5.11'), 'Ops image loads html2canvas-pro');
assert(betaJs.includes('flattenCloneColors'), 'Ops image flattens unsupported colors in the clone');
assert(betaJs.includes('onclone'), 'Ops image uses onclone color sanitize');
assert(betaJs.includes('prefetchOpsImageLib'), 'Ops image library is prefetched on tab render');
assert(betaJs.includes('copyOpsPngToClipboard'), 'Ops image clipboard helper present');
assert(betaJs.includes('Clipboard busy — downloaded Ops board PNG instead') || betaJs.includes('downloaded Ops board PNG instead'), 'clipboard focus failure falls back to download');
assert(betaJs.includes('Document is not focused') || betaJs.includes('document is not focused'), 'clipboard focus error is detected');

// Bare arrival-only rows (no clean target) must stay visible under Open + Attention.
const bareArrival = {
  aptId: 'arrival-1',
  aptName: 'Arrival Studio',
  checkoutGuest: '',
  isCheckinOnly: true,
  checkinSameDay: 'checkin_only',
  nextNights: 3,
  nextGuest: 'Arriving Guest',
  people: 2,
  arrivalTime: '15:00',
  comments: '',
  cleanType: undefined,
  cleanerNames: [],
  cleanerName: '',
  cleanDone: false,
};
rows.push(bareArrival);
apartments.push({ id: 'arrival-1', name: 'Arrival Studio', address: '1 Arrival St', area: 'Athens' });
context._opsCleanTarget = (row) => (row && row.isCheckinOnly ? null : row);
context._opsBetaState.filter = 'open';
context._opsBetaState.pageSize = 0;
context._opsBetaState.page = 1;
context.renderOps();
assert(panel.innerHTML.includes('Arrival Studio'), 'Open filter keeps arrival-only rows');
assert(panel.innerHTML.includes('>Arrival<'), 'arrival-only rows say so in the details cluster');
assert(panel.innerHTML.includes('Arrival only'), 'arrival-only rows carry a badge next to the name');
assert(/Open \d+/.test(panel.innerHTML), 'Open filter badge still present');

context._opsBetaState.filter = 'attention';
context.renderOps();
assert(panel.innerHTML.includes('Arrival Studio'), 'Attention filter keeps arrival-only rows');

context._opsBetaState.filter = 'all';
context.renderOps();
assert(panel.innerHTML.includes('Arrival Studio'), 'All filter still shows arrival-only rows');

// ── dispatch console redesign ───────────────────────────────────────────────

// The triage rail must discriminate, not just restate "all". Every segment
// carries a plain "Label N" accessible name so counts are assertable.
['all', 'attention', 'unknown', 'open', 'unassigned', 'done'].forEach((key) => {
  assert(
    panel.innerHTML.includes('data-ob-filter="' + key + '"'),
    'triage rail keeps the ' + key + ' segment'
  );
});
assert(panel.innerHTML.includes('Blocking'), 'rail exposes a Blocking segment');
assert(panel.innerHTML.includes('Unknown check-in'), 'rail exposes an Unknown check-in segment');

const railCount = (label) => {
  const hit = panel.innerHTML.match(new RegExp('aria-label="' + label + ' (\\d+)"'));
  return hit ? Number(hit[1]) : -1;
};
const blocking = railCount('Blocking');
const openCount = railCount('Open');
const allCount = railCount('All');
assert(blocking > 0 && openCount > 0 && allCount > 0, 'rail segments carry live counts');
assert(blocking < openCount, 'Blocking is narrower than Open (segment actually discriminates)');
assert(openCount < allCount, 'Open is narrower than All');

// Done work never blocks, and neither does a row that already has a crew.
assert(
  blocking <= allCount - railCount('Done'),
  'finished rows are excluded from Blocking'
);

// Grouping: "default" sort means source order, so it must never regroup.
assert(!panel.innerHTML.includes('ob-grp'), 'default sort renders an ungrouped board');
context._opsBetaState.sort = 'status';
context.renderOps();
assert(panel.innerHTML.includes('ob-grp'), 'status sort renders grouped sections');
assert(/<em>\d+ propert(y|ies)<\/em>/.test(panel.innerHTML), 'group headers summarise their section');
assert(/class="ob-gclean[^"]*">\d+\/\d+ clean</.test(panel.innerHTML), 'group headers anchor an n/N clean pill');
const groupCount = (panel.innerHTML.match(/class="ob-grp"/g) || []).length;
assert(groupCount >= 2, 'area grouping produces more than one section');
assert(
  (panel.innerHTML.match(/class="ob-dispatch-row/g) || []).length > groupCount,
  'group header rows are not counted as dispatch rows'
);
context._opsBetaState.group = 'none';
context.renderOps();
assert(!panel.innerHTML.includes('ob-grp'), 'grouping can be switched off');
context._opsBetaState.group = 'area';
context._opsBetaState.sort = 'default';
context.renderOps();

// Row ⋯ menu restores the kind override and remove-row parity gaps.
const rowId = (panel.innerHTML.match(/<tr class="ob-dispatch-row[^>]*data-ob-id="([^"]+)"/) || [])[1];
assert(rowId, 'dispatch rows carry a stable id');
assert(panel.innerHTML.includes('data-ob-action="row-menu"'), 'rows expose an actions menu');
listeners.click(event('row-menu', { dataset: { obAction: 'row-menu', obId: rowId } }));
assert(panel.innerHTML.includes('data-ob-action="kind"'), 'row menu restores the kind override');
assert(panel.innerHTML.includes('data-ob-action="row-remove"'), 'row menu restores remove row');
assert(/data-ob-action="flag"[^>]*data-ob-flag="park"/.test(panel.innerHTML), 'row menu can set an inactive flag');
listeners.click(event('row-menu', { dataset: { obAction: 'row-menu', obId: rowId } }));
assert(!panel.innerHTML.includes('data-ob-action="row-remove"'), 'row menu closes again');

// Cleaner assignment is the primary board action: a workload-aware popover.
assert(panel.innerHTML.includes('data-ob-action="assign-open"'), 'rows expose an assign control');
listeners.click(event('assign-open', { dataset: { obAction: 'assign-open', obId: rowId } }));
assert(panel.innerHTML.includes('ob-pop'), 'assign popover renders');
assert(panel.innerHTML.includes('data-ob-action="assign-pick"'), 'assign popover offers the roster');
assert(panel.innerHTML.includes('ob-ld'), 'assign popover shows per-cleaner workload');
listeners.click(event('assign-open', { dataset: { obAction: 'assign-open', obId: rowId } }));

// The bulk bar is contextual: it does not exist at all until rows are selected,
// so "select all matching rows" has to live somewhere that is always reachable
// (the list head, which survives the card breakpoint that hides <thead>).
listeners.click(event('clear-selection'));
assert(!panel.innerHTML.includes('ob-bulk'), 'no bulk bar while nothing is selected');
assert(
  /class="ob-btn ob-quiet ob-selectall" data-ob-action="select-all-results"/.test(panel.innerHTML),
  'select-all stays reachable without the bulk bar'
);
listeners.change(event('select-page', { checked: true }));
assert(panel.innerHTML.includes('ob-bulk active'), 'bulk bar appears on selection');
assert(/<b>\d+ selected<\/b>/.test(panel.innerHTML), 'bulk bar leads with the selection count');
assert(/data-ob-action="select-page"[^>]*checked/.test(panel.innerHTML), 'page checkbox reflects the selection after rerender');
listeners.click(event('clear-selection'));
assert(!panel.innerHTML.includes('ob-bulk'), 'clearing the selection removes the bulk bar again');

// ── side panel ──────────────────────────────────────────────────────────────
// The exports and the schedule check moved out of a day-bar dropdown into the
// side panel, so they are visible rather than hidden behind a menu.
assert(panel.innerHTML.includes('id="ops-beta-panel"'), 'the side panel is rendered');
['Cleaners', 'Staff', 'Routes', 'Notes', 'Schedule check', 'Export'].forEach((title) => {
  assert(
    panel.innerHTML.includes('>' + title + '<span class="ob-arw">'),
    'side panel keeps the ' + title + ' section'
  );
});
assert(panel.innerHTML.includes('id="ops-schedcheck"'), 'schedule-check OCR panel has a mount point');
assert(panel.innerHTML.includes('data-ob-action="schedule-file"'), 'schedule photo upload is exposed');
assert(panel.innerHTML.includes('data-ob-action="copy-list"'), 'plain-text copy list is exposed');
assert(panel.innerHTML.includes('data-ob-action="ops-image"'), 'Ops image export is exposed');
assert(panel.innerHTML.includes('data-ob-action="cleaner-image"'), 'cleaner image export is exposed');
assert(panel.innerHTML.includes('data-ob-action="restart"'), 'restart cleans is exposed');
assert(panel.innerHTML.includes('data-ob-action="toggle-panel"'), 'the top bar can hide/show the panel');
assert(panel.innerHTML.includes('data-ob-action="drawer-toggle"'), 'a floating control opens the panel as a drawer');

// Panel sections are collapsible, and the open/closed state has to survive the
// full innerHTML swap or every repaint would slam them shut.
assert(panel.innerHTML.includes('data-ob-action="section"'), 'panel sections are collapsible');
assert(panel.innerHTML.includes('data-ob-panel="routes"'), 'routes section has a disclosure control');
assert(!panel.innerHTML.includes('data-ob-action="route-add"'), 'routes start collapsed');
listeners.click(event('section', { dataset: { obAction: 'section', obPanel: 'routes' } }));
assert(panel.innerHTML.includes('data-ob-action="route-add"'), 'opening routes reveals its body');
listeners.click(event('section', { dataset: { obAction: 'section', obPanel: 'routes' } }));

// Inline task composer replaces the old window.prompt() flow.
listeners.click(event('task-open'));
assert(panel.innerHTML.includes('ob-composer'), 'inline task composer renders');
assert(panel.innerHTML.includes('data-ob-action="task-text"'), 'composer has a text field');
assert(panel.innerHTML.includes('data-ob-action="task-apt"'), 'composer can attach an apartment');
assert(panel.innerHTML.includes('data-ob-action="task-save"'), 'composer can save');
listeners.click(event('task-cancel'));

// Every capability the board exposed before must still be reachable.
[
  'nav', 'today', 'date', 'filter', 'sort', 'search', 'page', 'page-size',
  'select', 'select-page', 'select-all-results', 'clear-selection',
  'bulk-cleaner', 'bulk-task', 'bulk-done', 'bulk-open',
  'clean', 'checkin', 'flag', 'row-field', 'comment', 'clean-field',
  'cleaner-add', 'cleaner-remove', 'manage-cleaners',
  'task-toggle', 'task-delete', 'staff', 'staff-add', 'leave-days',
  'route-add', 'route-remove', 'notes', 'schedule-file', 'group',
].forEach((action) => {
  assert(
    betaJs.includes('data-ob-action="' + action + '"'),
    'feature preserved: ' + action
  );
});
assert(!/window\.prompt\(/.test(betaJs), 'task creation no longer uses window.prompt');

// Scroll + focus survival across a full innerHTML swap.
assert(betaJs.includes('captureContext') && betaJs.includes('restoreContext'), 'render snapshots and restores UI context');
assert(betaJs.includes('data-ob-focus'), 'focusable controls carry a stable restore key');
assert(/typeof window\.scrollTo === 'function'/.test(betaJs), 'scroll restore is feature-detected');
assert(/setSelectionRange/.test(betaJs), 'caret position is restored after rerender');
assert(/if \(state\.saveTimer\) persist\(false\)/.test(betaJs), 'pending edits flush before a repaint reloads rows');

// Sticky day bar / rail / table header must not sit in a scroll container.
assert(!/ob-table-wrap\s*\{[^}]*overflow-x:\s*auto/.test(css), 'table wrap is not a horizontal scroll container');
assert(/\.ob-command\s*\{[^}]*position:\s*sticky/.test(css), 'day command bar is sticky');
assert(/\.ob-rail\s*\{[^}]*position:\s*sticky/.test(css), 'triage rail is sticky');
assert(/\.ob-dispatch-table th\s*\{[^}]*position:\s*sticky/.test(css), 'column header is sticky');
assert(/--ob-stick/.test(css), 'sticky offsets come from one shared token');

// Responsive tiers. #tab-ops only ever gets about (viewport - 264px) because the
// app shell keeps a fixed 216px nav and #main-content pads 24px a side, so the
// breakpoints are higher than the tab widths they are chosen for.
assert(/@media \(max-width: 1400px\)/.test(css), 'panel becomes an overlay drawer below the widest tier');
assert(
  /@media \(max-width: 1400px\)[^@]*\.ob-panel\s*\{[^}]*position:\s*fixed/.test(css),
  'the drawer panel is pulled out of the layout grid'
);
assert(/@media \(max-width: 1100px\)/.test(css), 'card breakpoint defined below desktop');
assert(/grid-template-areas/.test(css), 'rows become cards via grid areas');
assert(
  /@media \(max-width: 1100px\)[^@]*\.ob-dispatch-table thead\s*\{[^}]*display:\s*none/.test(css),
  'column headers stand down once rows are cards'
);

// ── video-review defects ────────────────────────────────────────────────────

// 1. No native tooltips. Chrome renders title= as a black popup on click, which
// read as a debug toast ("Blocking 10", "Ενέργειες γραμμής") during review.
// Accessible names move to aria-label, which never paints anything.
assert(!/title="/.test(betaJs), 'no control emits a native title= tooltip');
assert(
  /data-ob-action="filter"[^>]*aria-label="/.test(panel.innerHTML),
  'filter pills keep an accessible name without a tooltip'
);
assert(
  !/data-ob-action="filter"[^>]*title=/.test(panel.innerHTML),
  'clicking a filter pill pops up nothing'
);
assert(
  /data-ob-action="row-menu"[^>]*aria-label="Row actions"/.test(panel.innerHTML),
  'row actions button is labelled for assistive tech'
);
assert(
  !/data-ob-action="row-menu"[^>]*title=/.test(panel.innerHTML),
  'opening the row actions menu pops up nothing'
);

// 2. Menu rows share one three-track grid so ticked, icon-only and bare items
// all align on the same text column.
listeners.click(event('row-menu', { dataset: { obAction: 'row-menu', obId: rowId } }));
const menuItems = panel.innerHTML.match(/<button type="button" class="ob-mi[^"]*"[^>]*>/g) || [];
assert(menuItems.length >= 5, 'row menu is built from shared menu items');
const menuHtml = panel.innerHTML.slice(panel.innerHTML.indexOf('<div class="ob-menu">'));
['ob-mi-state', 'ob-mi-icon', 'ob-mi-label'].forEach((cls) => {
  assert(menuHtml.includes(cls), 'menu items carry the ' + cls + ' gutter');
});
assert(
  (menuHtml.match(/ob-mi-state/g) || []).length === (menuHtml.match(/ob-mi-label/g) || []).length,
  'every menu item has both a state gutter and a label, so none can shift left'
);
assert(
  /class="ob-mi[^"]*ob-danger"/.test(panel.innerHTML),
  'the destructive item uses the same aligned shape as the rest'
);
assert(
  /#tab-ops \.ob-menu button \{[^}]*grid-template-columns:\s*16px 18px 1fr/.test(css),
  'menu gutters are fixed tracks so empty ones still reserve their width'
);
assert(
  /\.ob-mi-state,\s*#tab-ops \.ob-mi-icon \{[^}]*justify-self:\s*stretch/.test(css),
  'gutters fill their track, so glyphs of different widths cannot shift the row'
);
listeners.click(event('row-menu', { dataset: { obAction: 'row-menu', obId: rowId } }));

// 3. The triage rail has to survive a phone. It is the sticky element there
// (the day bar stands down), it grows instead of clipping, and the chips scroll
// behind a shadow affordance rather than silently ending.
assert(/@media \(max-width: 520px\)/.test(css), 'a narrow tier exists below the tablet card');
assert(
  /#tab-ops \.ob-rail\s*\{[^}]*min-height:\s*var\(--ob-rail\)/.test(css) &&
    !/#tab-ops \.ob-rail\s*\{[^}]*[^-]height:\s*\d/.test(css),
  'the rail grows with its content instead of clipping to a fixed height'
);
assert(
  /@media \(max-width: 760px\)[^@]*\.ob-command\s*\{[^}]*position:\s*static/.test(css),
  'the day bar stops being sticky on narrow screens'
);
assert(
  /@media \(max-width: 760px\)[^@]*\.ob-rail\s*\{[^}]*top:\s*0/.test(css),
  'the rail takes over as the pinned strip so filters stay reachable'
);
assert(/\.ob-segs\s*\{[^}]*overflow-x:\s*auto/.test(css), 'filter chips scroll horizontally');
assert(
  /\.ob-segs\s*\{[^}]*radial-gradient\(farthest-side at 100% 50%/.test(css),
  'chips carry a scroll-shadow affordance showing there is more to reach'
);
[1100, 760, 520].forEach((tier) => {
  assert(
    !new RegExp('@media \\(max-width: ' + tier + 'px\\)[^@]*\\.ob-segs\\s*\\{[^}]*display:\\s*none').test(css),
    'the rail is never hidden at the ' + tier + 'px tier'
  );
});

// The app shell keeps a ~216px nav at every width, so the tab runs ~300px
// narrower than the viewport. "Not display:none" was not enough on its own: at
// 768 the non-shrinking tools cluster starved the chip strip down to 8px, which
// reads exactly like the filters being gone. The tools must take their own line
// from the card tier down, and the sticky offsets must follow the taller rail.
const tabletRail = /@media \(max-width: 1100px\)[^@]*/.exec(css);
assert(tabletRail, 'the card tier exists');
assert(
  /#tab-ops \.ob-rail\s*\{[^}]*flex-wrap:\s*wrap/.test(tabletRail[0]),
  'the rail wraps at the card tier instead of crushing the chips'
);
assert(
  /#tab-ops \.ob-segs\s*\{[^}]*flex:\s*1 1 100%/.test(tabletRail[0]),
  'the chip strip claims a full line of the wrapped rail'
);
assert(
  /#tab-ops \.ob-railtools\s*\{[^}]*width:\s*100%/.test(tabletRail[0]),
  'search / group / sort drop to their own line rather than starving the chips'
);
assert(
  /--ob-rail:\s*80px/.test(tabletRail[0]) && /--ob-stick:\s*130px/.test(tabletRail[0]),
  'the sticky offsets are re-pointed to the taller wrapped rail'
);
// --ob-stick is documented as a literal sum of the bar and rail; keep it true so
// the bulk bar and the pinned area headers cannot creep under the rail.
const barPx = Number(/--ob-bar:\s*(\d+)px/.exec(css)[1]);
const railPx = Number(/--ob-rail:\s*(\d+)px/.exec(tabletRail[0])[1]);
const stickPx = Number(/--ob-stick:\s*(\d+)px/.exec(tabletRail[0])[1]);
assert(
  stickPx === barPx + railPx,
  'the card-tier sticky offset stays the sum of the bar and the wrapped rail'
);

// 4. Mobile day bar and list header get room to breathe instead of clipping.
assert(
  /@media \(max-width: 760px\)[^@]*\.ob-command\s*\{[^}]*flex-wrap:\s*wrap/.test(css),
  'the day bar wraps rather than overflowing'
);
assert(
  /@media \(max-width: 760px\)[^@]*\.ob-list-head\s*\{[^}]*flex-direction:\s*column/.test(css),
  'the list header stacks on narrow screens'
);
assert(
  /@media \(max-width: 760px\)[^@]*\.ob-progress\s*\{[^}]*width:\s*100%/.test(css),
  'the progress bar takes the full width once the header stacks'
);
assert(
  /@media \(max-width: 520px\)[^@]*grid-template-columns:\s*20px 22px minmax\(0, 1fr\) 22px/.test(css),
  'the narrow card drops a track so its bands cannot overflow'
);

// 5. Remove row must actually remove the row.
context._opsBetaState.filter = 'all';
context._opsBetaState.pageSize = 0;
context._opsBetaState.page = 1;
context.renderOps();

const removeTarget = rows[3];
const removeTargetName = removeTarget.aptName;
const beforeRemove = renderedRows();
const beforeLength = rows.length;
assert(panel.innerHTML.includes(removeTargetName), 'the row to remove is on the board first');

// Cancelling at the confirm must change nothing.
context.confirm = () => false;
listeners.click(event('row-remove', { dataset: { obAction: 'row-remove', obIndex: '3' } }));
assert.strictEqual(rows.length, beforeLength, 'declining the confirm keeps the row in the day');
assert.strictEqual(renderedRows(), beforeRemove, 'declining the confirm leaves the board untouched');
assert(panel.innerHTML.includes(removeTargetName), 'the row is still rendered after cancelling');

// Confirming must drop it from _opsRows and from the repaint.
context.confirm = () => true;
listeners.click(event('row-remove', { dataset: { obAction: 'row-remove', obIndex: '3' } }));
assert.strictEqual(rows.length, beforeLength - 1, 'confirming removes exactly one row from the day');
assert.strictEqual(renderedRows(), beforeRemove - 1, 'the removed row is gone from the repaint');
assert(!rows.some((row) => row.aptName === removeTargetName), 'the removed row is out of the array');
assert(!panel.innerHTML.includes(removeTargetName), 'the removed row is off the board');
assert(
  panel.innerHTML.includes('showing ' + (beforeRemove - 1) + ' of ' + (beforeRemove - 1)),
  'the board head count follows the removal'
);

// It must go through the host's remove helper when the app provides one, so the
// beta board and the legacy board delete rows the same way.
let delegated = 0;
context.opsRemoveRow = (index) => { delegated += 1; rows.splice(index, 1); };
const beforeDelegate = rows.length;
listeners.click(event('row-remove', { dataset: { obAction: 'row-remove', obIndex: '2' } }));
assert.strictEqual(delegated, 1, 'removal defers to the host opsRemoveRow when it exists');
assert.strictEqual(rows.length, beforeDelegate - 1, 'the delegated removal took the row out');

// A host helper that declines (user cancelled) must not repaint a phantom.
const beforeDecline = rows.length;
const paintedBefore = panel.innerHTML;
context.opsRemoveRow = () => {};
listeners.click(event('row-remove', { dataset: { obAction: 'row-remove', obIndex: '2' } }));
assert.strictEqual(rows.length, beforeDecline, 'a declined host removal changes nothing');
assert.strictEqual(panel.innerHTML, paintedBefore, 'a declined host removal does not repaint');
delete context.opsRemoveRow;

// ── v2 design port (fe/daily-ops-v2-prototype.html) ─────────────────────────

context._opsBetaState.filter = 'all';
context._opsBetaState.sort = 'default';
context._opsBetaState.group = 'area';
context._opsBetaState.pageSize = 0;
context._opsBetaState.page = 1;
// the bulk-assign runs above left every row staffed; the status column can only
// be checked for discrimination if at least one row is back to having no crew
rows[1].cleanerNames = [];
rows[1].cleanerName = '';
rows[1].cleanDone = false;
context.renderOps();

// The slim top bar: wordmark, screen title, prev / Today / next / date input,
// save-state indicator and the panel toggle, in that order.
const bar = panel.innerHTML.slice(
  panel.innerHTML.indexOf('<header class="ob-command">'),
  panel.innerHTML.indexOf('</header>')
);
assert(bar.includes('class="ob-brand">Elysian'), 'top bar carries the wordmark');
assert(bar.includes('class="ob-screen-title">Daily Ops</h1>'), 'top bar names the screen');
[
  ['data-ob-action="nav" data-ob-days="-1"', 'previous day'],
  ['data-ob-action="today"', 'Today'],
  ['data-ob-action="nav" data-ob-days="1"', 'next day'],
  ['data-ob-action="date"', 'date input'],
].forEach(([needle, what]) => assert(bar.includes(needle), 'top bar keeps the ' + what + ' control'));
assert(bar.includes('id="ops-beta-save-state"'), 'top bar shows the save state');
assert(bar.includes('data-ob-action="toggle-panel"'), 'top bar toggles the side panel');
assert(bar.indexOf('ob-brand') < bar.indexOf('ob-screen-title'), 'wordmark precedes the title');
assert(bar.indexOf('ob-screen-title') < bar.indexOf('ob-datebar'), 'title precedes the date controls');

// Labels are English throughout. _opsDayLabel would hand back Greek month and
// weekday names, so the renderer formats the date itself.
assert(/>Saturday, 15 August 2026</.test(panel.innerHTML), 'the day label is written in English');
// OPS_TAG_PARK is a stored comment token, not chrome, so it is the one Greek
// string allowed through — everything else the renderer writes is English.
assert(!/[\u0386-\u03CE]/.test(panel.innerHTML.replace(/Παρκοκρεβάτο/g, '')), 'no Greek copy leaks into the rendered board');
assert(/TASK_LABELS/.test(betaJs), 'Greek OPS_CLEAN_TASKS labels are mapped to English for display');
assert(
  /taskLabel\(item\[0\], item\[1\]\)/.test(betaJs),
  'the task option value stays the data-layer key while only the label is translated'
);

// Tasks-led cards: Open tasks first and largest, then the progress ring,
// Unassigned and Arrivals.
const cardOrder = ['ob-card-tasks', 'ob-card-prog', '>Unassigned<', '>Arrivals<']
  .map((needle) => panel.innerHTML.indexOf(needle));
assert(cardOrder.every((i) => i > -1), 'all four summary cards render');
assert(cardOrder.every((v, i, a) => i === 0 || a[i - 1] < v), 'Open tasks leads the card row');
assert(/class="ob-card ob-card-tasks"/.test(panel.innerHTML), 'the tasks card is the wide one');
assert(panel.innerHTML.includes('<svg class="ob-ring"'), 'cleaning progress is a ring');
assert(/data-ob-action="task-toggle"/.test(betaJs) && /data-ob-action="task-delete"/.test(betaJs),
  'tasks keep their check and delete affordances');

// Dense list: no vertical padding on cells, a fixed row height and a real
// height budget — the prototype fits 18 rows in 1440x900.
assert(
  /\.ob-dispatch-table td \{[^}]*height:\s*28px[^}]*padding:\s*0 5px/.test(css),
  'list rows keep the prototype density (28px cells, no vertical padding)'
);
// The flexible columns must leave room for the four px control columns. Two
// ways of writing this were measured against the live board at 1440px and both
// clipped the stay cluster mid-word: percentages summing to 100% over-constrain
// the row (stay collapsed to 156px), and a calc() percentage is treated as
// `auto` by Chrome under table-layout: fixed, which split the leftover equally
// (every flexible column came out at 142px).
const flexCols = ['ob-c-prop', 'ob-c-stay', 'ob-c-crew', 'ob-c-task', 'ob-c-note'].map((cls) => {
  const rule = new RegExp('#tab-ops \\.' + cls + ' \\{[^}]*\\}').exec(css);
  assert(rule, cls + ' declares a width');
  assert(!/calc\(/.test(rule[0]), cls + ' avoids calc(): Chrome ignores it on a fixed-layout column');
  const share = /width:\s*([\d.]+)%/.exec(rule[0]);
  assert(share, cls + ' is a plain percentage');
  return Number(share[1]);
});
const flexTotal = flexCols.reduce((sum, share) => sum + share, 0);
assert(
  flexTotal > 74 && flexTotal < 82,
  'the flexible columns leave the px control columns their ~21% instead of claiming the whole table'
);
['ob-c-sel', 'ob-c-tick', 'ob-c-status', 'ob-c-act'].forEach((cls) => {
  assert(
    new RegExp('#tab-ops \\.' + cls + ' \\{ width: \\d+px').test(css),
    cls + ' stays a fixed pixel column because it holds a fixed-size control'
  );
});
assert(
  /@media \(max-width: 1100px\)[^@]*\.ob-dispatch-row td \{[^}]*height:\s*auto/.test(css),
  'the fixed cell height is released once rows become cards'
);

// The details cluster: check-in cycles on click, guests and ETA are inline and
// borderless until focused.
assert(/data-ob-action="checkin"[^>]*aria-label="Check-in [a-z]+ — click to cycle"/.test(panel.innerHTML),
  'check-in cycles from the details cluster');
assert(/class="ob-input ob-inline ob-row-pax"/.test(panel.innerHTML), 'guests are inline-editable');
assert(/class="ob-input ob-inline ob-row-eta/.test(panel.innerHTML), 'the ETA is inline-editable');
assert(/\.ob-inline \{[^}]*border:\s*0[^}]*background:\s*transparent/.test(css), 'inline fields are borderless at rest');
assert(/\.ob-inline:focus \{[^}]*box-shadow:\s*inset/.test(css), 'inline fields grow a hairline on focus');
// ob-empty is the no-results block (34px of padding); the ETA modifier must not
// collide with it or every row inflates to 95px.
assert(!/ob-row-eta ob-empty"/.test(panel.innerHTML), 'the blank-ETA modifier does not reuse the empty-state class');
assert(/\.ob-row-eta\.ob-eta-empty/.test(css), 'the blank-ETA modifier has its own class');

// Assign is the primary row action: one uniform tinted pill with a hairline —
// never dashed and never confused with the solid active-selection treatment.
const assignCss = (css.match(/#tab-ops \.ob-assign \{[^}]*\}/) || [''])[0];
assert(/border-radius:\s*999px/.test(assignCss), 'the assign control is a pill');
assert(/box-shadow:\s*inset 0 0 0 1px rgba\(22, 40, 58/.test(assignCss), 'the pill carries a navy hairline');
assert(!/dashed/.test(assignCss), 'the assign pill is not dashed');

// Status is always a coloured dot AND a word, and it discriminates: a row with
// no crew reads "Unassigned" rather than being swallowed by "Blocking".
assert(/<span class="ob-row-status [a-z]+"><i><\/i>[A-Z]/.test(panel.innerHTML), 'status pairs a dot with a word');
const statusWords = [...panel.innerHTML.matchAll(/<span class="ob-row-status [a-z]+"><i><\/i>([^<]+)</g)]
  .map((m) => m[1]);
assert(statusWords.includes('Unassigned'), 'unstaffed rows read as Unassigned');
assert(new Set(statusWords).size >= 3, 'the status column tells more than one story');

// Blocking rows get an inset accent, never a full-bleed red fill.
assert(/\.ob-dispatch-row\.tone-hot td \{[^}]*background:\s*transparent/.test(css), 'blocking rows are not filled red');
assert(
  /\.ob-dispatch-row\.tone-hot td:first-child \{[^}]*box-shadow:\s*inset 3px 0 0/.test(css),
  'blocking rows earn an inset left edge instead'
);

// Aegean Editorial is a full visual system, not a colour-only swap: limestone
// canvas, ivory surfaces, Mediterranean blue selection, editorial serif
// hierarchy and softer geometry all arrive together.
const aegean = css.slice(css.indexOf('/* ── Aegean Editorial'));
assert(aegean.length > 1000, 'the Aegean Editorial overlay is present');
assert(/--ob-canvas:\s*#f2eee5/.test(aegean), 'the canvas is limestone');
assert(/--ob-surface:\s*#fffdf8/.test(aegean), 'surfaces are sun-washed ivory');
assert(/--ob-accent:\s*#0e5fa7/.test(aegean), 'Mediterranean blue owns the accent');
assert(/--ob-serif:\s*Georgia/.test(aegean), 'editorial headings use a serif voice');
assert(/--ob-r-lg:\s*18px/.test(aegean), 'cards use the softer Aegean geometry');
assert(
  /\.ob-filter\.on\s*\{[^}]*background:\s*var\(--ob-accent\)[^}]*color:\s*#ffffff/.test(aegean),
  'the active filter is a solid Mediterranean-blue selection'
);
assert(/stroke="#0e5fa7"/.test(betaJs), 'the progress ring carries the Aegean accent');

// Presentation refinements: empty slots stop rendering as broken data, repeated
// chrome recedes until the row is worked, and the area head closes with a rule
// instead of flinging its clean count to the far edge.
assert(
  /if \(seg\.filled && prevFilled\) html \+= '<span class="ob-dot-sep">/.test(betaJs),
  'interpuncts only join segments that actually carry a value'
);
// A single line needed 225px against the ~175px the column can give, and a flex
// row cannot ellipsize, so the surplus was hard-clipped mid-word ("7 ni").
assert(
  /class="ob-det-line ob-det-lead"/.test(panel.innerHTML) && /class="ob-det-line ob-det-sub"/.test(panel.innerHTML),
  'the stay cell reads as a lead line and a sub line rather than one long row'
);
const leadLine = /<div class="ob-det-line ob-det-lead">(.*?)<\/div>/.exec(panel.innerHTML);
assert(leadLine && /ob-ci/.test(leadLine[1]), 'the check-in state leads the stay cell');
assert(!/ob-row-pax/.test(leadLine[1]), 'the editable particulars are not on the lead line');
assert(
  /#tab-ops \.ob-det-lead \{[^}]*font-size:\s*11px/.test(css) &&
    /#tab-ops \.ob-det-sub \{[^}]*font-size:\s*10\.5px/.test(css),
  'the sub line is typographically subordinate to the lead line'
);
assert(/nights === 1 \? ' night' : ' nights'/.test(betaJs), 'a single night is not written as "1 nights"');
assert(
  /\(pax \? '<span class="ob-unit">guests<\/span>' : ''\)/.test(betaJs),
  'the "guests" unit is dropped when there is no number beside it'
);
assert(/ob-ph/.test(betaJs), 'empty editable slots are flagged');
assert(
  /#tab-ops \.ob-ph \{[^}]*opacity:\s*0/.test(css) &&
    /#tab-ops \.ob-dispatch-row:hover \.ob-ph[^{]*\{[^}]*opacity:\s*1/.test(css),
  'empty slots stay hidden at rest and return on row hover or focus'
);
assert(
  /\.ob-row-note::placeholder \{ color: transparent/.test(css),
  'the per-row Note placeholder does not repeat down the whole column'
);
// The × gives its ~9px back to the label at rest, which is what let the leading
// tag stop rendering as "Lat…" in a 138px column.
assert(/#tab-ops \.ob-nchip button \{ display: none/.test(css), 'the × leaves the layout at rest');
assert(
  /#tab-ops \.ob-dispatch-row:hover \.ob-nchip button \{ display: inline-block/.test(css),
  'the × returns on the row being worked'
);
assert(/\.ob-row-note:focus \{[^}]*min-width:\s*96px/.test(css), 'the note field claims room to type on focus');
assert(
  /#tab-ops \.ob-nchip\.ob-nmore \{[^}]*flex:\s*none/.test(css),
  'the overflow count never shrinks into an ellipsis itself'
);
assert(
  /#tab-ops \.ob-sr \{[^}]*clip-path:\s*inset\(50%\)/.test(css),
  'the collapsed tag names are visually hidden rather than a tooltip'
);
assert(/function chipLabel\(part\)/.test(betaJs), 'chips present a label rather than the stored token');
assert(
  /if \(\/\^Long stay\/i\.test\(text\)\) return 'Long stay';/.test(betaJs),
  'a long-stay tag drops the nights the Stay column already states'
);
assert(
  !/\/\^Long stay\/i\.test\(part\)\) return ' hot'/.test(betaJs),
  'a long stay reads as information rather than as an exception'
);
assert(
  /#tab-ops \.ob-grp-line::after \{[^}]*flex:\s*1 1 auto/.test(css),
  'the area head closes with a rule so the clean count stays anchored to it'
);
assert(
  !/#tab-ops \.ob-gclean \{[^}]*margin-left:\s*auto/.test(css),
  'the clean pill is no longer pushed to the far right edge'
);
assert(
  /#tab-ops \.ob-num \{[^}]*min-width:\s*15px[^}]*text-align:\s*right/.test(css),
  'the row numeral gutter is fixed width so names align'
);
assert(
  /state\.group === 'area' \? '' : area/.test(betaJs),
  'the sub line drops the area when the board is already grouped by it'
);
assert(
  /#tab-ops \.ob-ci\.ob-unknown \{ color: var\(--ob-muted\)/.test(css),
  'an unanswered check-in is muted, leaving amber to the status column'
);

// Card mode: a cell that would hold nothing but an em-dash is dropped rather
// than becoming its own empty band.
assert(/ob-cell-empty/.test(betaJs), 'placeholder cells are flagged for the card tiers');
assert(
  /@media \(max-width: 1100px\)[^@]*td\.ob-cell-empty \{[^}]*display:\s*none/.test(css),
  'flagged placeholder cells are hidden once rows are cards'
);

// The panel opens by default on desktop and its inputs look like real inputs.
assert(/panelOpen: true/.test(betaJs), 'the side panel is open by default on desktop');
assert(
  /#tab-ops \.ob-input,\s*#tab-ops \.ob-select \{[^}]*background:\s*var\(--ob-surface\)[^}]*box-shadow:\s*inset/.test(css),
  'panel inputs are white with a hairline and a subtle inset'
);
assert(/class="ob-addtask"/.test(panel.innerHTML) || /ob-addlink/.test(betaJs), 'the panel uses quiet text links to add');

console.log('daily-ops-beta-scale: ok (v2 design port + dispatch console, aligned menus, phone rail, row removal)');
