'use strict';
/**
 * Build fe/patches-141.json + srv/patches-107.json:
 * Monthly Close badge for apartments whose selected (or upcoming) month is
 * fully sold, so they can be cleared before the month actually ends.
 * Run: node scripts/_build-mc-ready-badge.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function applyKind(kind, untilName) {
  const baseName = kind === 'fe' ? 'index.html' : 'server.js';
  let src = fs.readFileSync(path.join(root, baseName), 'utf8').replace(/\r\n/g, '\n');
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
    if (name === untilName) break;
    const file = path.join(root, kind, name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (spec.baseSha256 && sha256(src) !== spec.baseSha256) {
      throw new Error(kind + '/' + name + ' base drift');
    }
    for (const p of spec.patches || []) {
      const parts = src.split(p.find);
      if (parts.length - 1 !== (p.count || 1)) {
        throw new Error(kind + '/' + name + ' anchor: ' + p.note);
      }
      src = parts.join(p.replace);
    }
    if (spec.expectedSha256 && sha256(src) !== spec.expectedSha256) {
      throw new Error(kind + '/' + name + ' expected sha');
    }
  }
  return src;
}

function writePatch(kind, fileName, src, patches, extra) {
  let out = src;
  for (const [i, p] of patches.entries()) {
    const parts = out.split(p.find);
    if (parts.length - 1 !== (p.count || 1)) {
      throw new Error(kind + ' patch ' + (i + 1) + ' (' + p.note + '): count ' + (parts.length - 1));
    }
    out = parts.join(p.replace);
  }
  const cfg = Object.assign({
    baseSha256: sha256(src),
    expectedSha256: sha256(out),
    patches: patches,
  }, extra);
  fs.writeFileSync(path.join(root, kind, fileName), JSON.stringify(cfg, null, 1) + '\n');
  console.log('wrote', kind + '/' + fileName, cfg.expectedSha256);
  return out;
}

const feSrc = applyKind('fe', 'patches-141.json');
const srvSrc = applyKind('srv', 'patches-107.json');

const fillHelpers = `    return out;
  }
  // Calendar fill for a close month: DISTINCT nights covered by bookings (sold)
  // plus owner/maintenance blocks (unsellable). Overlapping stays cannot push a
  // night above 100%. An apartment is ready to clear when every night of the
  // month is covered — nothing left that can still be sold. Groups are ready
  // only when every member is.
  var MC_READY_FROM_DAY = 20;
  function mcUpcomingYm(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function mcNearMonthEnd(d) { return (d || new Date()).getDate() >= MC_READY_FROM_DAY; }
  function mcMonthBounds(month) {
    var p = String(month || mcMonth).split('-');
    var yr = parseInt(p[0], 10), mo = parseInt(p[1], 10);
    var start = Date.UTC(yr, mo - 1, 1), end = Date.UTC(yr, mo, 1);
    return { start: start, end: end, days: Math.round((end - start) / 86400000), month: month || mcMonth };
  }
  function mcBkUtc(v) {
    var s = String(v || '').trim();
    var m = s.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    m = s.match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (typeof parseD === 'function') {
      var d = parseD(v);
      if (d && !isNaN(d)) return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    }
    return 0;
  }
  function mcFillOne(aptId, month) {
    var b = mcMonthBounds(month), DAY = 86400000, sold = {}, blocked = {};
    (S.bks || []).forEach(function (bk) {
      if (!bk || bk.cancelled || String(bk.aptId) !== String(aptId)) return;
      var t0 = mcBkUtc(bk.checkIn), t1 = mcBkUtc(bk.checkOut);
      if (!t0 || !t1) return;
      var from = Math.max(t0, b.start), to = Math.min(t1, b.end);
      if (!(to > from)) return;
      var isSold = typeof isRevenueBooking !== 'function' || isRevenueBooking(bk);
      for (var t = from; t < to; t += DAY) {
        if (isSold) sold[t] = 1; else blocked[t] = 1;
      }
    });
    var soldN = 0, blockedOnly = 0;
    Object.keys(sold).forEach(function () { soldN++; });
    Object.keys(blocked).forEach(function (k) { if (!sold[k]) blockedOnly++; });
    var covered = soldN + blockedOnly;
    return { days: b.days, sold: soldN, blocked: blockedOnly, covered: covered, ready: b.days > 0 && covered >= b.days };
  }
  function mcFill(a, month) {
    if (a == null) return { days: 0, sold: 0, blocked: 0, covered: 0, ready: false };
    var ids = (typeof a === 'string' || typeof a === 'number')
      ? [String(a)]
      : ((a.members && a.members.length) ? a.members : [String(a.id)]);
    var parts = ids.map(function (id) { return mcFillOne(id, month); });
    var out = parts.reduce(function (s, p) {
      s.days += p.days; s.sold += p.sold; s.blocked += p.blocked; s.covered += p.covered; return s;
    }, { days: 0, sold: 0, blocked: 0, covered: 0, ready: false });
    out.ready = parts.length > 0 && parts.every(function (p) { return p.ready; });
    return out;
  }
  function mcReady(a, month) { return !!mcFill(a, month).ready; }
  function mcReadyBadge(a, size) {
    if (typeof complete === 'function' && complete(a)) return '';
    if (typeof mcSkipped === 'function' && mcSkipped(a.id)) return '';
    var f = mcFill(a);
    if (!f.ready) return '';
    var bits = [f.sold + '/' + f.days + ' nights sold'];
    if (f.blocked) bits.push(f.blocked + ' blocked');
    bits.push('can be cleared now');
    return '<span class="mcbadge ready' + (size ? ' ' + size : '') + '" title="' + esc(bits.join(' · ')) + '">Ready to clear</span>';
  }
  window.mcFillOne = mcFillOne;
  window.mcFill = mcFill;
  window.mcReady = mcReady;
  window.mcUpcomingYm = mcUpcomingYm;
  window.mcNearMonthEnd = mcNearMonthEnd;
  // What is owed for the month, built with the report's own engine so the figure`;

const fePatches = [
  {
    note: 'Monthly Close: Ready-to-clear badge styles',
    find: '#tab-mt .mcbadge.leased{color:#059669;border-color:#059669}',
    replace: '#tab-mt .mcbadge.leased{color:#059669;border-color:#059669}\n#tab-mt .mcbadge.ready{color:#92400E;border-color:#C9A84C;background:#C9A84C22}\n#tab-mt .mc-readycount{margin-left:4px;background:var(--bg);border:1px solid #C9A84C;color:#92400E;border-radius:20px;padding:4px 11px;font-size:11.5px;cursor:pointer;white-space:nowrap}\n#tab-mt .mc-readycount b{font-weight:700}\n#tab-mt .mc-readybanner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#C9A84C18;border:1px solid #C9A84C;color:var(--tx);border-radius:var(--r);padding:9px 12px;margin-bottom:12px;cursor:pointer;font-size:13px}\n#tab-mt .mc-readybanner .go{margin-left:auto;font-weight:600;color:#92400E;white-space:nowrap}',
    count: 1,
  },
  {
    note: 'Monthly Close: calendar-fill helpers (sold + blocked nights)',
    find: '    return out;\n  }\n  // What is owed for the month, built with the report\'s own engine so the figure',
    replace: fillHelpers,
    count: 1,
  },
  {
    note: 'Monthly Close: jump to a named month (upcoming August from the banner)',
    find: '  window.mcShiftMonth = function (d) {\n    var p = mcMonth.split(\'-\'), dt = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1 + d, 1);\n    mcMonth = dt.getFullYear() + \'-\' + String(dt.getMonth() + 1).padStart(2, \'0\');\n    focusId = null; renderMt();\n  };',
    replace: '  window.mcShiftMonth = function (d) {\n    var p = mcMonth.split(\'-\'), dt = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1 + d, 1);\n    mcMonth = dt.getFullYear() + \'-\' + String(dt.getMonth() + 1).padStart(2, \'0\');\n    focusId = null; renderMt();\n  };\n  window.mcGoMonth = function (ym) {\n    if (!/^\\d{4}-\\d{2}$/.test(String(ym || \'\'))) return;\n    mcMonth = ym; focusId = null; renderMt();\n  };\n  window.mcShowReady = function () { view = \'list\'; statusFilter = \'ready\'; renderMt(); };',
    count: 1,
  },
  {
    note: 'Monthly Close: Focus queue leads with apartments that can be cleared now',
    find: '  function queue() { return pool().filter(function (a) { return !complete(a) && !mcSkipped(a.id); }); }',
    replace: '  function queue() {\n    return pool().filter(function (a) { return !complete(a) && !mcSkipped(a.id); })\n      .sort(function (a, b) { return (mcReady(b) ? 1 : 0) - (mcReady(a) ? 1 : 0); });\n  }',
    count: 1,
  },
  {
    note: 'Monthly Close: count apartments whose calendar is fully sold',
    find: '    var _need = Math.max(0, tot - skipN);   // apartments that actually need clearing\n    var pct = _need ? Math.round(done / _need * 100) : 100;',
    replace: '    var _need = Math.max(0, tot - skipN);   // apartments that actually need clearing\n    var pct = _need ? Math.round(done / _need * 100) : 100;\n    var readyN = 0;\n    all.forEach(function (a) {\n      if (mcSkipped(a.id) || complete(a)) return;\n      if (mcReady(a)) readyN += (a.members || [a.id]).length;\n    });\n    var _upYm = mcUpcomingYm(), _upN = 0;\n    if (mcNearMonthEnd() && _upYm !== mcMonth) {\n      apts().forEach(function (a) {\n        if (mcReady(a, _upYm)) _upN += (a.members || [a.id]).length;\n      });\n    }',
    count: 1,
  },
  {
    note: 'Monthly Close: legend chip for ready-to-clear count',
    find: '(skipN ? \'<span><i class="mcd todo" style="background:#94A3B8"></i>\' + skipN + \' not needed</span>\' : \'\') + _pace + \'</div></div>\'',
    replace: '(skipN ? \'<span><i class="mcd todo" style="background:#94A3B8"></i>\' + skipN + \' not needed</span>\' : \'\') + (readyN ? \'<span class="mc-readycount" onclick="mcShowReady()" title="Every night of \' + esc(mLabel(mcMonth)) + \' is sold — these can be cleared now"><b>\' + readyN + \'</b> ready to clear</span>\' : \'\') + _pace + \'</div></div>\'',
    count: 1,
  },
  {
    note: 'Monthly Close: banner when the upcoming month has fully sold apartments',
    find: '    h += \'<div class="mc-controls"><div class="mc-tabs">\'',
    replace: '    if (_upN) {\n      h += \'<div class="mc-readybanner" onclick="mcGoMonth(\\\'\' + _upYm + \'\\\')">\'\n        + \'<span class="mcbadge ready">Ready to clear</span>\'\n        + \'<span><b>\' + _upN + \'</b> apartment\' + (_upN === 1 ? \'\' : \'s\') + \' in \' + esc(mLabel(_upYm)) + \' have every night sold and can be cleared now</span>\'\n        + \'<span class="go">Open \' + esc(mLabel(_upYm)) + \' →</span></div>\';\n    }\n    h += \'<div class="mc-controls"><div class="mc-tabs">\'',
    count: 1,
  },
  {
    note: 'Monthly Close: List filter includes Ready to clear',
    find: '+ (view === \'list\' ? \'<select class="mc-sel" onchange="mcStatus(this.value)">\' + [[\'all\', \'All status\'], [\'todo\', \'Not started\'], [\'doing\', \'In progress\'], [\'done\', \'Sent\'], [\'flag\', \'Flagged\']].map(function (o) {',
    replace: '+ (view === \'list\' ? \'<select class="mc-sel" onchange="mcStatus(this.value)">\' + [[\'all\', \'All status\'], [\'ready\', \'Ready to clear\'], [\'todo\', \'Not started\'], [\'doing\', \'In progress\'], [\'done\', \'Sent\'], [\'flag\', \'Flagged\']].map(function (o) {',
    count: 1,
  },
  {
    note: 'Monthly Close: Focus card shows the Ready to clear badge',
    find: '+ \'<span class="mc-name">\' + esc(cur.name) + \'</span>\'\n          + (cur.owner ? \'<span class="mc-owner">\' + esc(cur.owner) + \'</span>\' : \'\')',
    replace: '+ \'<span class="mc-name">\' + esc(cur.name) + \'</span>\'\n          + mcReadyBadge(cur)\n          + (cur.owner ? \'<span class="mc-owner">\' + esc(cur.owner) + \'</span>\' : \'\')',
    count: 1,
  },
  {
    note: 'Monthly Close: Up-next rows show the Ready to clear badge',
    find: '+ \'<span class="mc-upname">\' + esc(a.name) + \'</span><span class="mc-upnext2">\'',
    replace: '+ \'<span class="mc-upname">\' + esc(a.name) + \'</span>\' + mcReadyBadge(a, \'sm\') + \'<span class="mc-upnext2">\'',
    count: 1,
  },
  {
    note: 'Monthly Close: Batch rows show the Ready to clear badge',
    find: 'return \'<div class="mc-brow"><span class="mcbadge sm \' + a.type + \'">\' + TYPE_SHORT[a.type] + \'</span><span class="mc-bname">\' + esc(a.name) + \'</span>\'\n            + \'<span class="mc-spacer"></span>\'',
    replace: 'return \'<div class="mc-brow"><span class="mcbadge sm \' + a.type + \'">\' + TYPE_SHORT[a.type] + \'</span><span class="mc-bname">\' + esc(a.name) + \'</span>\' + mcReadyBadge(a, \'sm\')\n            + \'<span class="mc-spacer"></span>\'',
    count: 1,
  },
  {
    note: 'Monthly Close: List filter keeps Ready to clear apartments',
    find: '        if (statusFilter === \'flag\') { var r = mcRec(a.id); if (!(r && r.flag)) return false; }',
    replace: '        if (statusFilter === \'ready\' && (complete(a) || mcSkipped(a.id) || !mcReady(a))) return false;\n        if (statusFilter === \'flag\') { var r = mcRec(a.id); if (!(r && r.flag)) return false; }',
    count: 1,
  },
  {
    note: 'Monthly Close: List rows show the Ready to clear badge',
    find: '+ \'<span class="mc-lname">\' + esc(a.name) + \'</span>\'\n          + \'<span class="mc-dots">\'',
    replace: '+ \'<span class="mc-lname">\' + esc(a.name) + \'</span>\' + mcReadyBadge(a, \'sm\')\n          + \'<span class="mc-dots">\'',
    count: 1,
  },
  {
    note: 'Monthly Close: footer explains the Ready to clear badge',
    find: '+ \'Report, receipt/invoice and email tick themselves from what you do in the app; TAKK lines still need their proof.</div>\';',
    replace: '+ \'Report, receipt/invoice and email tick themselves from what you do in the app; TAKK lines still need their proof. From the 20th, apartments with every night of the upcoming month sold show <b>Ready to clear</b>.</div>\';',
    count: 1,
  },
];

writePatch('fe', 'patches-141.json', feSrc, fePatches, {
  builtAt: '2026-08-31 Monthly Close ready-to-clear badge',
  assertions: [
    { has: 'function mcFillOne(aptId, month)', note: 'per-apartment calendar fill' },
    { has: 'function mcReady(a, month)', note: 'ready-to-clear helper' },
    { has: 'Ready to clear', note: 'badge copy' },
    { has: 'window.mcGoMonth', note: 'banner jumps to the upcoming month' },
    { has: "statusFilter = 'ready'", note: 'list filter for ready apartments' },
    { has: 'mcNearMonthEnd', note: 'banner only near month-end' },
    { has: 'MC_READY_FROM_DAY = 20', note: 'upcoming-month banner from the 20th' },
  ],
});

const srvPatches = [
  {
    note: 'FE bootstrap through patches-160 so FE 141 applies',
    find: 'for (let cn = 2; cn <= 140; cn++) { /* legacy note: cn <= 40 */ /* cn <= 80 */ /* cn <= 90 */ /* cn <= 100 */ /* cn <= 120 */',
    replace: 'for (let cn = 2; cn <= 160; cn++) { /* legacy note: cn <= 40 */ /* cn <= 80 */ /* cn <= 90 */ /* cn <= 100 */ /* cn <= 120 */ /* cn <= 140 */',
    count: 1,
  },
];

writePatch('srv', 'patches-107.json', srvSrc, srvPatches, {
  builtAt: '2026-08-31 FE chain through 160 (ready-to-clear badge)',
  assertions: [
    { has: 'cn <= 160', note: 'FE bootstrap through 160' },
  ],
});
