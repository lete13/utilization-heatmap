'use strict';
/**
 * Build fe/patches-142.json:
 * Law 5170 issued-on / due dates were wiped because picking a date rebuilt
 * the whole Property Info tab (native date pickers fire an empty change as
 * the input is destroyed) and because dates never auto-saved.
 * SRV 107 already walks the FE chain through 160, so no new server patch.
 * Run: node scripts/_build-pinfo-dates.js
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
    if (spec.baseSha256 && sha256(src) !== spec.baseSha256) throw new Error(kind + '/' + name + ' base drift');
    for (const p of spec.patches || []) {
      const parts = src.split(p.find);
      if (parts.length - 1 !== (p.count || 1)) throw new Error(kind + '/' + name + ' anchor: ' + p.note);
      src = parts.join(p.replace);
    }
    if (spec.expectedSha256 && sha256(src) !== spec.expectedSha256) throw new Error(kind + '/' + name + ' expected sha');
  }
  return src;
}

function writePatch(kind, filename, src, patches, builtAt, assertions) {
  let out = src;
  for (const [i, p] of patches.entries()) {
    const parts = out.split(p.find);
    if (parts.length - 1 !== (p.count || 1)) {
      throw new Error(kind + ' patch ' + (i + 1) + ' (' + p.note + '): anchor count ' + (parts.length - 1));
    }
    out = parts.join(p.replace);
  }
  const cfg = {
    baseSha256: sha256(src),
    expectedSha256: sha256(out),
    builtAt: builtAt,
    patches: patches,
    assertions: assertions,
  };
  fs.writeFileSync(path.join(root, kind, filename), JSON.stringify(cfg, null, 1) + '\n');
  console.log('wrote', kind + '/' + filename, cfg.expectedSha256);
  return out;
}

const feSrc = applyKind('fe', 'patches-142.json');

writePatch('fe', 'patches-142.json', feSrc, [
  {
    note: 'Property Info: keep a debounce timer so date picks can persist without clobbering the tab',
    find: '  let _loading = false, _dirty = false;',
    replace: '  let _loading = false, _dirty = false, _pinfoSaveTimer = null;',
    count: 1,
  },
  {
    note: 'Property Info: switching apartments flushes unsaved dates first',
    find: "  window.pinfoSelectRental = function (id) { _selRentalId = id || null; _view = 'edit'; if (id) _load(id); else renderPropInfo(); };",
    replace: "  window.pinfoSelectRental = async function (id) {\n    if (_pinfoSaveTimer) { clearTimeout(_pinfoSaveTimer); _pinfoSaveTimer = null; }\n    if (_dirty && _selRentalId && id !== _selRentalId) await _save(true);\n    _selRentalId = id || null; _view = 'edit'; if (id) _load(id); else renderPropInfo();\n  };",
    count: 1,
  },
  {
    note: 'Property Info: issued-on / due date keep in _cur, paint in place, persist immediately',
    find:
      '  window.pinfoIssued = function (itemId, val) {\n' +
      '    const rec = _cur.compliance[itemId] = _cur.compliance[itemId] || {};\n' +
      '    rec.issuedOn = val;\n' +
      '    if (val && CADENCE[itemId] && (!rec.due || rec.dueAuto)) {\n' +
      '      const d = new Date(val + \'T00:00:00\'); d.setMonth(d.getMonth() + CADENCE[itemId]);\n' +
      '      rec.due = d.toISOString().slice(0, 10); rec.dueAuto = true;\n' +
      '    }\n' +
      '    _dirty = true; renderPropInfo();\n' +
      '  };\n' +
      '  window.pinfoCompDate = function (itemId, val) {\n' +
      '    const rec = _cur.compliance[itemId] = _cur.compliance[itemId] || {};\n' +
      '    rec.due = val; rec.dueAuto = false; _dirty = true; renderPropInfo();\n' +
      '  };',
    replace:
      '  function _pinfoAddMonthsISO(iso, months) {\n' +
      '    const m = String(iso || \'\').match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);\n' +
      '    if (!m) return \'\';\n' +
      '    let y = +m[1], mo = +m[2] - 1, d = +m[3];\n' +
      '    mo += months;\n' +
      '    y += Math.floor(mo / 12);\n' +
      '    mo = ((mo % 12) + 12) % 12;\n' +
      '    const last = new Date(y, mo + 1, 0).getDate();\n' +
      '    d = Math.min(d, last);\n' +
      '    return y + \'-\' + String(mo + 1).padStart(2, \'0\') + \'-\' + String(d).padStart(2, \'0\');\n' +
      '  }\n' +
      '  window._pinfoAddMonthsISO = _pinfoAddMonthsISO;\n' +
      '  function _pinfoSaveSoon() {\n' +
      '    if (_pinfoSaveTimer) clearTimeout(_pinfoSaveTimer);\n' +
      '    _pinfoSaveTimer = setTimeout(function () { _pinfoSaveTimer = null; _save(true); }, 250);\n' +
      '  }\n' +
      '  function _pinfoPaintCompliance(itemId) {\n' +
      '    const rec = _cur.compliance[itemId] || {};\n' +
      '    const issued = document.getElementById(\'pinfo-issued-\' + itemId);\n' +
      '    const due = document.getElementById(\'pinfo-due-\' + itemId);\n' +
      '    const pill = document.getElementById(\'pinfo-pill-\' + itemId);\n' +
      '    const lbl = document.getElementById(\'pinfo-due-lbl-\' + itemId);\n' +
      '    if (issued && issued.value !== String(rec.issuedOn || \'\')) issued.value = rec.issuedOn || \'\';\n' +
      '    if (due && due.value !== String(rec.due || \'\')) due.value = rec.due || \'\';\n' +
      '    if (pill) pill.innerHTML = _pill(_complianceStatus(rec.due));\n' +
      '    if (lbl) lbl.innerHTML = \'due date\' + (rec.dueAuto ? \' <span style="color:#C9A84C">· auto</span>\' : \'\');\n' +
      '  }\n' +
      '  window.pinfoIssued = function (itemId, val) {\n' +
      '    const rec = _cur.compliance[itemId] = _cur.compliance[itemId] || {};\n' +
      '    rec.issuedOn = val;\n' +
      '    if (val && CADENCE[itemId] && (!rec.due || rec.dueAuto)) {\n' +
      '      rec.due = _pinfoAddMonthsISO(val, CADENCE[itemId]); rec.dueAuto = true;\n' +
      '    }\n' +
      '    _dirty = true; _pinfoPaintCompliance(itemId); _markDirty(); _pinfoSaveSoon();\n' +
      '  };\n' +
      '  window.pinfoCompDate = function (itemId, val) {\n' +
      '    const rec = _cur.compliance[itemId] = _cur.compliance[itemId] || {};\n' +
      '    rec.due = val; rec.dueAuto = false;\n' +
      '    _dirty = true; _pinfoPaintCompliance(itemId); _markDirty(); _pinfoSaveSoon();\n' +
      '  };',
    count: 1,
  },
  {
    note: 'Property Info: silent date saves must not rebuild the tab (that wiped the picker)',
    find:
      "        if (!silent && typeof toast === 'function') toast('Saved.', 'ok');\n" +
      '        renderPropInfo();\n' +
      '        if (window._cmplRefresh) window._cmplRefresh();\n' +
      '        return;',
    replace:
      "        if (!silent && typeof toast === 'function') toast('Saved.', 'ok');\n" +
      '        if (silent) _markClean();\n' +
      '        else renderPropInfo();\n' +
      '        if (window._cmplRefresh) window._cmplRefresh();\n' +
      '        return;',
    count: 1,
  },
  {
    note: 'Property Info: date inputs keep stable ids so the row can update without a full render',
    find:
      '        \'<div style="margin-top:3px">\' + _pill(st) + \'</div></div>\' +\n' +
      '        \'<div style="flex:2;min-width:240px">\' + _fileChips(it.id) + \'</div>\' +\n' +
      '        \'<div style="display:flex;gap:10px">\' +\n' +
      '        \'<div style="display:flex;flex-direction:column;gap:2px"><span style="font-size:9px;color:var(--tx3)">issued on</span>\' +\n' +
      '        \'<input type="date" value="\' + _esc(rec.issuedOn) + \'" onchange="pinfoIssued(\\\'\' + it.id + \'\\\',this.value)" style="\' + IN + \'"></div>\' +\n' +
      '        \'<div style="display:flex;flex-direction:column;gap:2px"><span style="font-size:9px;color:var(--tx3)">due date\' + (rec.dueAuto ? \' <span style="color:#C9A84C">· auto</span>\' : \'\') + \'</span>\' +\n' +
      '        \'<input type="date" value="\' + _esc(rec.due) + \'" onchange="pinfoCompDate(\\\'\' + it.id + \'\\\',this.value)" style="\' + IN + \'"></div>\' +',
    replace:
      '        \'<div style="margin-top:3px" id="pinfo-pill-\' + it.id + \'">\' + _pill(st) + \'</div></div>\' +\n' +
      '        \'<div style="flex:2;min-width:240px">\' + _fileChips(it.id) + \'</div>\' +\n' +
      '        \'<div style="display:flex;gap:10px">\' +\n' +
      '        \'<div style="display:flex;flex-direction:column;gap:2px"><span style="font-size:9px;color:var(--tx3)">issued on</span>\' +\n' +
      '        \'<input type="date" id="pinfo-issued-\' + it.id + \'" value="\' + _esc(rec.issuedOn) + \'" onchange="pinfoIssued(\\\'\' + it.id + \'\\\',this.value)" style="\' + IN + \'"></div>\' +\n' +
      '        \'<div style="display:flex;flex-direction:column;gap:2px"><span id="pinfo-due-lbl-\' + it.id + \'" style="font-size:9px;color:var(--tx3)">due date\' + (rec.dueAuto ? \' <span style="color:#C9A84C">· auto</span>\' : \'\') + \'</span>\' +\n' +
      '        \'<input type="date" id="pinfo-due-\' + it.id + \'" value="\' + _esc(rec.due) + \'" onchange="pinfoCompDate(\\\'\' + it.id + \'\\\',this.value)" style="\' + IN + \'"></div>\' +',
    count: 1,
  },
  {
    note: 'Property Info: tell operators that Law 5170 dates persist as soon as they are picked',
    find: 'Attach the item photo, certificate and payment receipt per requirement — files preview in a new tab, ⬇ downloads. “Issued on” auto-fills the due date for periodic items.',
    replace: 'Attach the item photo, certificate and payment receipt per requirement — files preview in a new tab, ⬇ downloads. “Issued on” auto-fills the due date for periodic items. Issued-on and due dates save as soon as you pick them.',
    count: 1,
  },
  {
    note: 'Property Info: silent save can mark the button Saved without rebuilding the form',
    find:
      '  function _markDirty() {\n' +
      '    const b = document.getElementById(\'pinfo-save\');\n' +
      '    if (b) { b.disabled = false; b.textContent = \'💾 Save changes\'; b.style.opacity = \'1\'; }\n' +
      '    const d = document.getElementById(\'pinfo-dirty\'); if (d) d.style.display = \'\';\n' +
      '  }',
    replace:
      '  function _markDirty() {\n' +
      '    const b = document.getElementById(\'pinfo-save\');\n' +
      '    if (b) { b.disabled = false; b.textContent = \'💾 Save changes\'; b.style.opacity = \'1\'; }\n' +
      '    const d = document.getElementById(\'pinfo-dirty\'); if (d) d.style.display = \'\';\n' +
      '  }\n' +
      '  function _markClean() {\n' +
      '    _dirty = false;\n' +
      '    const b = document.getElementById(\'pinfo-save\');\n' +
      '    if (b) { b.disabled = true; b.textContent = \'💾 Saved\'; b.style.opacity = \'.5\'; }\n' +
      '    const d = document.getElementById(\'pinfo-dirty\'); if (d) d.style.display = \'none\';\n' +
      '  }',
    count: 1,
  },
], '2026-08-31 Keep Law 5170 issued-on and due dates', [
  { has: 'function _pinfoAddMonthsISO(iso, months)', note: 'calendar-safe due date from issued on' },
  { has: '_pinfoSaveSoon()', note: 'dates persist without waiting for Save' },
  { has: 'function _pinfoPaintCompliance(itemId)', note: 'date row updates in place' },
  { has: 'id="pinfo-issued-\' + it.id', note: 'issued-on input keeps a stable id' },
  { has: 'id="pinfo-due-\' + it.id', note: 'due date input keeps a stable id' },
  { has: 'if (silent) _markClean();', note: 'silent save does not rebuild the tab' },
  { has: 'Issued-on and due dates save as soon as you pick them.', note: 'copy tells operators dates persist' },
  { hasNot: "d.toISOString().slice(0, 10); rec.dueAuto = true;", note: 'UTC toISOString no longer shifts the due date' },
  { hasNot: '_dirty = true; renderPropInfo();\n  };\n  window.pinfoCompDate', note: 'date pick no longer destroys the form' },
]);
