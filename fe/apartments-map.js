/* apartments-map.js — "Apartments Map" tab
 *
 * A Leaflet map of every property that has coordinates, with one pin each.
 * Pin colour answers a single question — is this place free right now?
 *
 *   green  = available          (no stay covers the chosen moment)
 *   blue   = reserved           (a guest booking covers it)
 *   red    = blocked            (an owner/maintenance block covers it)
 *
 * Hovering a pin shows the property, its status and the stay behind it, so
 * the map doubles as a proximity check: which free flat is nearest to X.
 *
 * Self-contained on purpose: it injects its own nav button and panel at
 * runtime and never edits index.html, so the release patch chain (which
 * verifies index.html by sha256) is left completely untouched.
 */
(function () {
  'use strict';

  var LEAFLET_CSS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
  var LEAFLET_JS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';

  var COLOR = { free: '#2e9e6b', booked: '#2f6fb5', blocked: '#c0483e' };
  var LABEL = { free: 'Available', booked: 'Reserved', blocked: 'Blocked' };

  // A teardrop pin drawn as inline SVG: reads as a map marker rather than a
  // dot, keeps its colour meaning, and stays crisp at every zoom level.
  function pinIcon(kind, selected, shortlisted) {
    var fill = COLOR[kind];
    var html =
      '<div class="amap-pin amap-pin-' + kind +
        (selected ? ' amap-pin-sel' : '') +
        (shortlisted ? ' amap-pin-near' : '') + '">' +
        '<svg width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">' +
          '<path d="M13 33.2C13 33.2 24.6 20.9 24.6 13A11.6 11.6 0 1 0 1.4 13c0 7.9 11.6 20.2 11.6 20.2z" ' +
            'fill="' + fill + '" stroke="#ffffff" stroke-width="2.2" stroke-linejoin="round"/>' +
          '<circle cx="13" cy="12.8" r="4.1" fill="#ffffff" fill-opacity=".92"/>' +
        '</svg>' +
      '</div>';
    return L.divIcon({
      html: html,
      className: 'amap-pin-wrap',
      iconSize: [26, 34],
      iconAnchor: [13, 33],   // tip of the drop sits on the coordinate
      tooltipAnchor: [0, -30]
    });
  }

  var map = null;          // Leaflet map instance
  var layer = null;        // marker layer group
  var built = false;       // panel markup created
  var leafletLoading = false;
  var rentalInfo = null;   // Property Info records from the database
  var rentalInfoLoading = false;
  var selA = null;         // first apartment picked for a distance measurement
  var selB = null;         // second one
  var lineLayer = null;    // the drawn connection
  var nearList = null;     // results of a "nearest that can take them" search

  // The capacity a property can actually take: the stated maximum, falling
  // back to its base capacity when no maximum was ever set.
  function capNumber(apt) {
    var c = capacityOf(apt);
    return c.max != null ? c.max : c.base;
  }

  // The five closest properties that could host the same party — same
  // capacity or larger. Used when a stay has to be moved somewhere else.
  function nearestBigEnough(origin, limit) {
    var oc = coordsOf(origin);
    if (!oc) return [];
    var need = capNumber(origin);

    return apartments()
      .filter(function (a) {
        if (String(a.id) === String(origin.id)) return false;
        if (!coordsOf(a)) return false;
        if (need == null) return true;          // nothing to compare against
        var c = capNumber(a);
        return c != null && c >= need;
      })
      .map(function (a) {
        return { apt: a, km: distanceKm(oc, coordsOf(a)) };
      })
      .sort(function (x, y) { return x.km - y.km; })
      .slice(0, limit || 5);
  }

  function runNearestSearch() {
    if (!selA) return;
    selB = null;
    nearList = nearestBigEnough(selA, 5);
    draw();
  }

  function clearNearest() {
    nearList = null;
    draw();
  }

  function inNearList(apt) {
    if (!nearList) return false;
    for (var i = 0; i < nearList.length; i++) {
      if (String(nearList[i].apt.id) === String(apt.id)) return true;
    }
    return false;
  }

  // Straight-line distance in km. Real travel is always longer, so this is a
  // comparison tool ("which of these is nearer"), not a routing estimate.
  function distanceKm(a, b) {
    var R = 6371;
    var rad = function (d) { return d * Math.PI / 180; };
    var dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function coordsOf(apt) {
    var la = parseFloat(apt.lat), ln = parseFloat(apt.lng);
    return (isFinite(la) && isFinite(ln)) ? { lat: la, lng: ln } : null;
  }

  // Clicking pins picks the two ends of a measurement: first click sets A,
  // second sets B, a third starts a fresh pair.
  function pickForMeasure(apt) {
    if (selA && selB) { selA = apt; selB = null; nearList = null; }
    else if (!selA) { selA = apt; nearList = null; }
    else if (String(apt.id) === String(selA.id)) { selA = null; nearList = null; }
    else { selB = apt; }
    draw();
  }

  function clearMeasure() {
    selA = null; selB = null; nearList = null;
    draw();
  }

  function isSelected(apt) {
    return (selA && String(selA.id) === String(apt.id)) ||
           (selB && String(selB.id) === String(apt.id));
  }

  function renderMeasureBar() {
    var bar = byId('amap-measure');
    if (!bar) return;

    if (!selA) {
      bar.className = 'amap-measure amap-measure-idle';
      bar.innerHTML = '<span class="amap-measure-hint">Click a pin to measure distances or find nearby options.</span>';
      renderNearList();
      return;
    }
    if (!selB) {
      var need = capNumber(selA);
      bar.className = 'amap-measure amap-measure-half';
      bar.innerHTML =
        '<span class="amap-measure-from"><b>' + esc(selA.name || selA.id) + '</b> selected' +
          (need != null ? ' <span class="amap-measure-cap">sleeps ' + need + '</span>' : '') + '</span>' +
        '<span class="amap-measure-hint">— click a second pin to measure</span>' +
        '<button type="button" class="amap-measure-find" id="amap-find">' +
          'Nearest 5' + (need != null ? ' that sleep ' + need + '+' : '') +
        '</button>' +
        '<button type="button" class="amap-measure-clear" id="amap-clear">Clear</button>';
      wireClear();
      wireFind();
      renderNearList();
      return;
    }

    var ca = coordsOf(selA), cb = coordsOf(selB);
    var km = (ca && cb) ? distanceKm(ca, cb) : null;
    bar.className = 'amap-measure amap-measure-done';
    bar.innerHTML =
      '<span class="amap-measure-pair"><b>' + esc(selA.name || selA.id) + '</b>' +
        '<span class="amap-measure-arrow">→</span>' +
        '<b>' + esc(selB.name || selB.id) + '</b></span>' +
      '<span class="amap-measure-km">' + (km == null ? '—' : (km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km')) + '</span>' +
      '<span class="amap-measure-note">straight line</span>' +
      '<button type="button" class="amap-measure-clear" id="amap-clear">Clear</button>';
    wireClear();
    renderNearList();
  }

  function wireClear() {
    var b = byId('amap-clear');
    if (b) b.addEventListener('click', clearMeasure);
  }

  function wireFind() {
    var b = byId('amap-find');
    if (b) b.addEventListener('click', runNearestSearch);
  }

  // The result list doubles as a shortlist: each row shows how far it is, how
  // many it sleeps and whether it is actually free at the chosen moment, so a
  // relocation decision can be made without leaving the map.
  function renderNearList() {
    var box = byId('amap-near');
    if (!box) return;

    if (!nearList) { box.innerHTML = ''; box.className = 'amap-near'; return; }

    if (!nearList.length) {
      box.className = 'amap-near amap-near-on';
      box.innerHTML = '<div class="amap-near-empty">No other property on the map can take that many guests.</div>';
      return;
    }

    var when = chosenMoment();
    var rows = nearList.map(function (hit, i) {
      var st = statusOf(hit.apt, when);
      var cap = capNumber(hit.apt);
      return '<div class="amap-near-row">' +
        '<span class="amap-near-rank">' + (i + 1) + '</span>' +
        '<span class="amap-near-name">' + esc(hit.apt.name || hit.apt.id) + '</span>' +
        '<span class="amap-near-cap">sleeps ' + (cap == null ? '—' : cap) + '</span>' +
        '<span class="amap-near-status" style="color:' + COLOR[st.key] + '">' + LABEL[st.key] + '</span>' +
        '<span class="amap-near-km">' +
          (hit.km < 1 ? Math.round(hit.km * 1000) + ' m' : hit.km.toFixed(1) + ' km') +
        '</span>' +
      '</div>';
    }).join('');

    box.className = 'amap-near amap-near-on';
    box.innerHTML =
      '<div class="amap-near-head">Closest options for <b>' + esc(selA.name || selA.id) + '</b>' +
        '<button type="button" class="amap-near-close" id="amap-near-x">Hide</button></div>' +
      rows;

    var x = byId('amap-near-x');
    if (x) x.addEventListener('click', clearNearest);
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function byId(id) { return document.getElementById(id); }

  // The app's own date parser handles both D/M/YYYY and YYYY-MM-DD; fall back
  // to Date only if it is somehow unavailable.
  function pd(v) {
    if (typeof parseD === 'function') {
      var d = parseD(v);
      if (d && !isNaN(d)) return d;
      return null;
    }
    var f = new Date(v);
    return isNaN(f) ? null : f;
  }

  // A stay counts as a real reservation unless the app classes it as a block
  // (owner stay, maintenance, etc). Reuse the app's rule so the map can never
  // disagree with the rest of the system.
  function isBlockBooking(b) {
    if (typeof isRevenueBooking === 'function') return !isRevenueBooking(b);
    return false;
  }

  function apartments() {
    return (typeof S !== 'undefined' && Array.isArray(S.apts)) ? S.apts : [];
  }

  // Max capacity, read the same way Daily Ops reads it so the two can never
  // disagree: the saved Property Info record (Postgres, via /api/rental-info)
  // wins, then the base capacity mirrored onto the apartment itself.
  function capacityOf(apt) {
    var rules = {};
    var id = apt && apt.id;
    try {
      // our own copy, fetched straight from the database
      if (id && rentalInfo && rentalInfo[id] && rentalInfo[id].houseRules) {
        rules = rentalInfo[id].houseRules;
      // otherwise reuse whatever Daily Ops already loaded
      } else if (typeof _opsRentalInfo !== 'undefined' && _opsRentalInfo && id &&
                 _opsRentalInfo[id] && _opsRentalInfo[id].houseRules) {
        rules = _opsRentalInfo[id].houseRules;
      }
    } catch (e) { rules = {}; }

    var max = rules.maximum_guests;
    var base = (rules.base_capacity != null && rules.base_capacity !== '')
      ? rules.base_capacity
      : (apt && apt.baseCapacity);

    var maxN = parseInt(max, 10);
    var baseN = parseInt(base, 10);
    return {
      max: isFinite(maxN) && maxN > 0 ? maxN : null,
      base: isFinite(baseN) && baseN > 0 ? baseN : null
    };
  }

  // Pull the Property Info records (house rules incl. maximum_guests) from the
  // database. The map must not depend on Daily Ops having been opened first,
  // so it asks for them itself and redraws when they land.
  function ensureCapacityData() {
    if (rentalInfo || rentalInfoLoading) return;
    // if Daily Ops already has them, start from that and skip the round trip
    try {
      if (typeof _opsRentalInfo !== 'undefined' && _opsRentalInfo &&
          Object.keys(_opsRentalInfo).length) {
        rentalInfo = _opsRentalInfo;
        return;
      }
    } catch (e) { /* fall through to the fetch */ }

    rentalInfoLoading = true;
    fetch('/api/rental-info')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (data) {
        rentalInfo = data || {};
        rentalInfoLoading = false;
        // share it back so Daily Ops does not repeat the request
        try {
          if (typeof _opsRentalInfo !== 'undefined' && !_opsRentalInfo) _opsRentalInfo = rentalInfo;
        } catch (e) {}
        if (map) draw();
      })
      .catch(function () {
        rentalInfo = {};
        rentalInfoLoading = false;
      });
  }

  function bookings() {
    return (typeof S !== 'undefined' && Array.isArray(S.bks)) ? S.bks : [];
  }

  // Which stay, if any, covers `when` for this apartment?
  // Check-out day is treated as free: the guest leaves, the flat is available.
  function stayAt(apt, when) {
    var t = when.getTime();
    var list = bookings();
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b.cancelled) continue;
      var sameApt = (b.aptId && apt.id && String(b.aptId) === String(apt.id)) ||
                    (b.aptName && apt.name && String(b.aptName) === String(apt.name));
      if (!sameApt) continue;
      var ci = pd(b.checkIn), co = pd(b.checkOut);
      if (!ci || !co) continue;
      if (t >= ci.getTime() && t < co.getTime()) return b;
    }
    return null;
  }

  function statusOf(apt, when) {
    var b = stayAt(apt, when);
    if (!b) return { key: 'free', booking: null };
    return { key: isBlockBooking(b) ? 'blocked' : 'booked', booking: b };
  }

  function fmt(d) {
    if (!d) return '—';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
  }

  // ── asset loading ─────────────────────────────────────────────────────────
  function loadLeaflet(cb) {
    if (window.L && window.L.map) { cb(); return; }
    if (leafletLoading) { setTimeout(function () { loadLeaflet(cb); }, 120); return; }
    leafletLoading = true;

    if (!document.querySelector('link[data-amap-css]')) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      link.setAttribute('data-amap-css', '1');
      document.head.appendChild(link);
    }
    var s = document.createElement('script');
    s.src = LEAFLET_JS;
    s.onload = function () { leafletLoading = false; cb(); };
    s.onerror = function () {
      leafletLoading = false;
      var host = byId('amap-canvas');
      if (host) {
        host.innerHTML = '<div class="amap-error">The map library could not be loaded. ' +
          'Check the connection and reopen this tab.</div>';
      }
    };
    document.head.appendChild(s);
  }

  // ── panel markup ──────────────────────────────────────────────────────────
  function ensurePanel() {
    if (built && byId('tab-map')) return;

    // panel — dropped next to the other tab panels so showTab can find it
    var anchor = byId('tab-ops') || document.querySelector('.tab-panel');
    if (!anchor || !anchor.parentNode) return;

    var panel = byId('tab-map');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'tab-map';
      panel.className = 'tab-panel';
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    }

    panel.innerHTML =
      '<div class="amap-wrap">' +
        '<div class="amap-head">' +
          '<div>' +
            '<h2 class="amap-title">Apartments Map</h2>' +
            '<div class="amap-sub">Every property with coordinates, coloured by whether it is free at the moment you pick.</div>' +
          '</div>' +
          '<div class="amap-controls">' +
            '<label class="amap-lbl" for="amap-when">Status at</label>' +
            '<input type="datetime-local" id="amap-when" class="amap-input">' +
            '<button type="button" id="amap-now" class="amap-btn">Now</button>' +
          '</div>' +
        '</div>' +
        '<div class="amap-legend">' +
          '<span class="amap-lg"><i style="background:' + COLOR.free + '"></i>Available <b id="amap-n-free">0</b></span>' +
          '<span class="amap-lg"><i style="background:' + COLOR.booked + '"></i>Reserved <b id="amap-n-booked">0</b></span>' +
          '<span class="amap-lg"><i style="background:' + COLOR.blocked + '"></i>Blocked <b id="amap-n-blocked">0</b></span>' +
          '<span class="amap-lg amap-lg-muted" id="amap-missing-wrap">No coordinates <b id="amap-n-missing">0</b></span>' +
        '</div>' +
        '<div id="amap-measure" class="amap-measure amap-measure-idle"></div>' +
        '<div id="amap-near" class="amap-near"></div>' +
        '<div id="amap-canvas" class="amap-canvas"></div>' +
        '<div id="amap-missing" class="amap-missing"></div>' +
      '</div>';

    // default to right now, rounded to the minute
    var when = byId('amap-when');
    if (when && !when.value) when.value = localNowValue();

    if (when) when.addEventListener('change', draw);
    var now = byId('amap-now');
    if (now) now.addEventListener('click', function () {
      var el = byId('amap-when');
      if (el) { el.value = localNowValue(); draw(); }
    });

    built = true;
  }

  function localNowValue() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function chosenMoment() {
    var el = byId('amap-when');
    if (el && el.value) {
      var d = new Date(el.value);
      if (!isNaN(d)) return d;
    }
    return new Date();
  }

  // ── nav button ────────────────────────────────────────────────────────────
  function ensureNavButton() {
    if (byId('nav-map')) return;
    // sit next to Keys Hubs, which is the other location-flavoured tab
    var sibling = byId('nav-keys') || byId('nav-pinfo') || byId('nav-perf');
    if (!sibling || !sibling.parentNode) return;

    var btn = document.createElement('button');
    btn.className = 'nav-btn';
    btn.id = 'nav-map';
    btn.setAttribute('data-tab', 'map');
    btn.textContent = 'Apartments Map';
    btn.addEventListener('click', function () { showTab('map', btn); });
    sibling.parentNode.insertBefore(btn, sibling.nextSibling);
  }

  // ── drawing ───────────────────────────────────────────────────────────────
  function draw() {
    if (!window.L || !byId('amap-canvas')) return;
    var when = chosenMoment();

    if (!map) {
      map = L.map('amap-canvas', {
        scrollWheelZoom: true,
        zoomControl: false,
        attributionControl: true
      });
      // A muted, low-contrast basemap: the pins are the information here, the
      // map is context. The default OSM style fights the markers for attention.
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 20,
        subdomains: 'abcd',
        attribution: '&copy; OpenStreetMap &copy; CARTO'
      }).addTo(map);
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      map.setView([38.2, 23.8], 6); // Greece, until we know the real bounds
    }
    if (layer) { layer.clearLayers(); } else { layer = L.layerGroup().addTo(map); }

    var counts = { free: 0, booked: 0, blocked: 0 };
    var missing = [];
    var points = [];

    apartments().forEach(function (apt) {
      var la = parseFloat(apt.lat), ln = parseFloat(apt.lng);
      if (!isFinite(la) || !isFinite(ln)) { missing.push(apt.name || apt.id || '—'); return; }

      var st = statusOf(apt, when);
      counts[st.key]++;
      points.push([la, ln]);

      var marker = L.marker([la, ln], {
        icon: pinIcon(st.key, isSelected(apt), inNearList(apt)),
        riseOnHover: true,
        title: ''
      });
      marker.on('click', function () { pickForMeasure(apt); });

      var b = st.booking;
      var detail = '';
      if (b) {
        var ci = pd(b.checkIn), co = pd(b.checkOut);
        detail = '<div class="amap-tip-line">' + fmt(ci) + ' → ' + fmt(co) + '</div>';
        if (st.key === 'booked' && b.guestName) {
          detail += '<div class="amap-tip-line">' + esc(b.guestName) + '</div>';
        }
      }

      // Max capacity — the question that usually follows "is it free?"
      var cap = capacityOf(apt);
      var capLine = '';
      if (cap.max) {
        capLine = '<div class="amap-tip-cap">Sleeps up to <b>' + cap.max + '</b>' +
          (cap.base && cap.base !== cap.max ? ' <span>(' + cap.base + ' beds + sofa)</span>' : '') +
          '</div>';
      } else if (cap.base) {
        capLine = '<div class="amap-tip-cap">Base capacity <b>' + cap.base + '</b></div>';
      } else {
        capLine = '<div class="amap-tip-cap amap-tip-cap-none">Capacity not set</div>';
      }

      // When occupied, show how full it actually is against that capacity
      var guestsLine = '';
      if (b && st.key === 'booked') {
        var g = parseInt(b.guests, 10);
        if (isFinite(g) && g > 0) {
          guestsLine = '<div class="amap-tip-line">' + g + ' guest' + (g === 1 ? '' : 's') +
            (cap.max ? ' of ' + cap.max : '') + '</div>';
        }
      }

      marker.bindTooltip(
        '<div class="amap-tip">' +
          '<div class="amap-tip-name">' + esc(apt.name || apt.id || '—') + '</div>' +
          '<div class="amap-tip-status" style="color:' + COLOR[st.key] + '">' + LABEL[st.key] + '</div>' +
          capLine +
          guestsLine +
          detail +
          (apt.city ? '<div class="amap-tip-city">' + esc(apt.city) + '</div>' : '') +
        '</div>',
        { direction: 'top', opacity: 1, className: 'amap-tooltip' }
      );
      marker.addTo(layer);
    });

    var setTxt = function (id, v) { var el = byId(id); if (el) el.textContent = v; };
    setTxt('amap-n-free', counts.free);
    setTxt('amap-n-booked', counts.booked);
    setTxt('amap-n-blocked', counts.blocked);
    setTxt('amap-n-missing', missing.length);

    var mw = byId('amap-missing-wrap');
    if (mw) mw.style.display = missing.length ? '' : 'none';

    var mbox = byId('amap-missing');
    if (mbox) {
      mbox.innerHTML = missing.length
        ? '<b>Not on the map</b> — no coordinates on record for: ' +
          missing.map(esc).join(' · ') +
          '. Run a Hosthub sync to fill these in.'
        : '';
    }

    if (points.length) {
      map.fitBounds(L.latLngBounds(points).pad(0.15));
      if (points.length === 1) map.setZoom(14);
    }

    // draw (or clear) the measured connection
    if (lineLayer) { map.removeLayer(lineLayer); lineLayer = null; }
    if (selA && selB) {
      var ca = coordsOf(selA), cb = coordsOf(selB);
      if (ca && cb) {
        lineLayer = L.polyline([[ca.lat, ca.lng], [cb.lat, cb.lng]], {
          color: '#0f1e2e',
          weight: 2.5,
          opacity: 0.85,
          dashArray: '6 6'
        }).addTo(map);
        // frame both ends so the measurement is actually visible
        map.fitBounds(L.latLngBounds([[ca.lat, ca.lng], [cb.lat, cb.lng]]).pad(0.35));
      }
    } else if (selA && nearList && nearList.length) {
      // spokes from the origin to each shortlisted property
      var oc = coordsOf(selA);
      if (oc) {
        var spokes = [];
        var frame = [[oc.lat, oc.lng]];
        nearList.forEach(function (hit) {
          var c = coordsOf(hit.apt);
          if (!c) return;
          spokes.push([[oc.lat, oc.lng], [c.lat, c.lng]]);
          frame.push([c.lat, c.lng]);
        });
        lineLayer = L.polyline(spokes, {
          color: '#0f1e2e',
          weight: 1.8,
          opacity: 0.5,
          dashArray: '4 6'
        }).addTo(map);
        map.fitBounds(L.latLngBounds(frame).pad(0.3));
      }
    }
    renderMeasureBar();
  }

  // Leaflet needs a size recalculation when its container becomes visible.
  function activate() {
    ensurePanel();
    ensureCapacityData();
    loadLeaflet(function () {
      draw();
      setTimeout(function () { if (map) map.invalidateSize(); }, 60);
    });
  }

  // ── wire into the app ─────────────────────────────────────────────────────
  function hookShowTab() {
    var original = window.showTab;
    if (typeof original !== 'function' || original.__amapWrapped) return;

    var wrapped = function (name, btn) {
      if (name === 'map') {
        ensurePanel();
        // mirror the app's own tab switching, then render
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
        document.querySelectorAll('.nav-btn').forEach(function (b) { b.classList.remove('active'); });
        var panel = byId('tab-map');
        if (panel) panel.classList.add('active');
        if (btn && btn.classList) btn.classList.add('active');
        requestAnimationFrame(activate);
        return;
      }
      return original.apply(this, arguments);
    };
    wrapped.__amapWrapped = true;
    window.showTab = wrapped;
  }

  function init() {
    try {
      ensureNavButton();
      hookShowTab();
    } catch (e) {
      if (window.console && console.warn) console.warn('[apartments-map] init failed:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  // the app builds its shell asynchronously after login, so retry briefly
  var tries = 0;
  var t = setInterval(function () {
    if (byId('nav-map') || tries++ > 40) { clearInterval(t); return; }
    init();
  }, 400);

  window.renderApartmentsMap = activate;
})();
