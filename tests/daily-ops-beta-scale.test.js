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
assert(panel.innerHTML.includes('Priority / late / sofa'), 'color legend lists hot tone');
assert(panel.innerHTML.includes('ob-tone-legend'), 'color legend is on the board');
assert(panel.innerHTML.includes('Καθαρίστριες'), 'roster manage button present');
assert(panel.innerHTML.includes('ob-cchip') || panel.innerHTML.includes('Καθαρίστρια'), 'cleaner chips / add field present');
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
assert(/ob-nchip hot[^>]*>PRIORITY</.test(panel.innerHTML), 'PRIORITY chip is hot/red');
assert(/ob-nchip hot[^>]*>Late Checkout: 12:00</.test(panel.innerHTML), 'Late chip is hot/red');
assert(/ob-nchip cool[^>]*>Prepare 1 sofa bed</.test(panel.innerHTML), 'sofa chip is cool/blue');
assert(/ob-nchip cool[^>]*>Early check-in</.test(panel.innerHTML), 'Early chip is cool/blue');

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
assert(panel.innerHTML.includes('Άφιξη'), 'arrival-only chip rendered under Open');
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
assert(panel.innerHTML.includes('ακίνητα'), 'group headers summarise their section');
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

// Contextual bulk bar: idle affordance until something is selected.
listeners.click(event('clear-selection'));
assert(panel.innerHTML.includes('ob-bulk-idle'), 'bulk bar is idle with an empty selection');
listeners.change(event('select-page', { checked: true }));
assert(panel.innerHTML.includes('ob-bulk active'), 'bulk bar activates on selection');
assert(/data-ob-action="select-page"[^>]*checked/.test(panel.innerHTML), 'page checkbox reflects the selection after rerender');
listeners.click(event('clear-selection'));
assert(panel.innerHTML.includes('ob-bulk-idle'), 'clearing the selection restores the idle bar');

// Restored parity: schedule-check mount, plain-text copy list, no window.prompt.
assert(panel.innerHTML.includes('id="ops-schedcheck"'), 'schedule-check OCR panel has a mount point');
listeners.click(event('bar-menu'));
assert(panel.innerHTML.includes('data-ob-action="copy-list"'), 'plain-text copy list is exposed');
assert(panel.innerHTML.includes('data-ob-action="ops-image"'), 'Ops image export is exposed');
assert(panel.innerHTML.includes('data-ob-action="cleaner-image"'), 'cleaner image export is exposed');
assert(panel.innerHTML.includes('data-ob-action="schedule-check"'), 'schedule check upload is exposed');
assert(panel.innerHTML.includes('data-ob-action="restart"'), 'restart cleans is exposed');
listeners.click(event('bar-menu'));

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

// Responsive: the table collapses into cards below desktop.
assert(/@media \(max-width: 1180px\)/.test(css), 'card breakpoint defined below desktop');
assert(/grid-template-areas/.test(css), 'rows become cards via grid areas');

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
  /data-ob-action="row-menu"[^>]*aria-label="Ενέργειες γραμμής"/.test(panel.innerHTML),
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
  /#tab-ops \.ob-menu button \{[^}]*grid-template-columns:\s*13px 18px 1fr/.test(css),
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
assert(/@media \(max-width: 540px\)/.test(css), 'a narrow tier exists below the tablet card');
assert(
  /@media \(max-width: 900px\)[^@]*\.ob-rail\s*\{[^}]*height:\s*auto/.test(css),
  'the rail grows with its content instead of clipping to a fixed height'
);
assert(
  /@media \(max-width: 900px\)[^@]*\.ob-command\s*\{[^}]*position:\s*static/.test(css),
  'the day bar stops being sticky on narrow screens'
);
assert(
  /@media \(max-width: 900px\)[^@]*\.ob-rail\s*\{[^}]*top:\s*0/.test(css),
  'the rail takes over as the pinned strip so filters stay reachable'
);
assert(/\.ob-segs\s*\{[^}]*overflow-x:\s*auto/.test(css), 'filter chips scroll horizontally');
assert(
  /\.ob-segs\s*\{[^}]*radial-gradient\(farthest-side at 100% 50%/.test(css),
  'chips carry a scroll-shadow affordance showing there is more to reach'
);
assert(
  !/@media \(max-width: 540px\)[^@]*\.ob-segs\s*\{[^}]*display:\s*none/.test(css),
  'the rail is never hidden on a phone'
);

// 4. Mobile day bar and console header get room to breathe instead of clipping.
assert(
  /@media \(max-width: 900px\)[^@]*\.ob-command\s*\{[^}]*flex-wrap:\s*wrap/.test(css),
  'the day bar wraps rather than overflowing'
);
assert(
  /@media \(max-width: 900px\)[^@]*\.ob-board-head\s*\{[^}]*flex-direction:\s*column/.test(css),
  'the dispatch console header stacks on narrow screens'
);
assert(
  /@media \(max-width: 900px\)[^@]*\.ob-progress\s*\{[^}]*width:\s*100%/.test(css),
  'the progress bar takes the full width once the header stacks'
);
assert(
  /@media \(max-width: 540px\)[^@]*grid-template-columns:\s*20px 24px minmax\(0, 1fr\) auto/.test(css),
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

console.log('daily-ops-beta-scale: ok (dispatch console + no-tooltip controls, aligned menus, phone rail, row removal)');
