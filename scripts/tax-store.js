'use strict';
// Greek tax store + worker for the Elysian Command Center server.
//
// Taxes are fetched ONCE per booking into the booking_taxes table and refreshed
// only when the booking changes (fingerprint), when a fetch failed, or on a slow
// weekly re-check of recent bookings. runSync never fetches taxes itself: it
// reads this table, so a wiped-and-rebuilt bks list gets the same taxes back
// every cycle. A booking without a stored answer is flagged taxPending, never 0.
//
// Rate limits: small per-run budget, low concurrency, Retry-After honoured on
// 429 (the run stops, the budget halves, it resumes after the pause). A failed
// call never overwrites a stored answer.
//
// Wired in by srv/patches-108.json:
//   const taxStore = require('./scripts/tax-store.js').install({ app, fetch, hhH, BASE, getPool, getApiKey });
// Env: TAX_TICK_MS (180000), TAX_BUDGET (150), TAX_CONCURRENCY (3), TAX_PAUSE_MIN_S (60).

module.exports.install = function install(deps) {
  const { app, fetch, hhH, BASE, getPool, getApiKey } = deps;
  const TAX_TICK_MS = Math.max(60000, parseInt(process.env.TAX_TICK_MS || '180000', 10) || 180000);
  const TAX_BUDGET_MIN = 20, TAX_BUDGET_MAX = 400;
  const TAX_BUDGET_DEFAULT = Math.min(TAX_BUDGET_MAX, Math.max(TAX_BUDGET_MIN, parseInt(process.env.TAX_BUDGET || '150', 10) || 150));
  const TAX_CONCURRENCY = Math.min(6, Math.max(1, parseInt(process.env.TAX_CONCURRENCY || '3', 10) || 3));
  const TAX_RECHECK_DAYS = 90;        // bookings with checkout in the last N days...
  const TAX_RECHECK_EVERY_DAYS = 7;   // ...are re-verified once every N days
  const TAX_PAUSE_MIN_S = Math.max(1, parseInt(process.env.TAX_PAUSE_MIN_S || '60', 10) || 60);
  const TAX_STATE_KEY = 'tax_worker_state';
  let _taxTableReady = false;
  let _taxRunning = false;
  let _taxState = null;
  let _taxTimer = null;

  function taxFingerprint(ev) {
    const c = v => (v && typeof v === 'object') ? String(v.cents == null ? '' : v.cents) : String(v == null ? '' : v);
    return [ev.date_from, ev.date_to, ev.nights, c(ev.booking_value), c(ev.cleaning_fee), c(ev.other_fees), c(ev.taxes),
            c(ev.total_price), c(ev.guest_paid), c(ev.total_payout), ev.is_visible === false ? 'x' : 'v'].join('|');
  }
  function taxHasData(b) { return !!(b && ((+b.ct || 0) || (+b.vat || 0) || (+b.at || 0) || (+b.bvPrevat || 0))); }
  function taxIsEmpty(json) {
    const cents = v => (v && typeof v === 'object') ? (+v.cents || 0) : (+v || 0);
    return !(cents(json.climate_tax) || cents(json.vat) || cents(json.accommodation_tax) || cents(json.booking_value_pre_vat));
  }
  function taxSeedFrom(p) {
    const c = v => ({ cents: Math.round((+v || 0) * 100) });
    return { climate_tax: c(p.ct), booking_value_pre_vat: c(p.bvPrevat), vat: c(p.vat), accommodation_tax: c(p.at),
             net_value: c(p.nbv), total_booking_value: c(p.gross), _seed: true };
  }
  async function ensureTaxTable() {
    const pool = getPool();
    if (!pool) return false;
    if (_taxTableReady) return true;
    await pool.query(`CREATE TABLE IF NOT EXISTS booking_taxes (
      event_id   TEXT PRIMARY KEY,
      fp_now     TEXT,
      fp         TEXT,
      date_to    TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',
      data       JSONB,
      http       INTEGER,
      error      TEXT,
      attempts   INTEGER NOT NULL DEFAULT 0,
      source     TEXT,
      fetched_at TIMESTAMPTZ,
      next_try   TIMESTAMPTZ,
      seen_at    TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS booking_taxes_status_idx ON booking_taxes (status, seen_at)`);
    _taxTableReady = true;
    return true;
  }
  async function taxLoadState() {
    const pool = getPool();
    if (_taxState) return _taxState;
    let st = null;
    try { const r = await pool.query(`SELECT data FROM app_data WHERE key = $1`, [TAX_STATE_KEY]); st = r.rows[0]?.data || null; } catch (e) {}
    _taxState = Object.assign({ budget: TAX_BUDGET_DEFAULT, pausedUntil: null, lastRun: null, runs: 0 }, st || {});
    return _taxState;
  }
  async function taxSaveState() {
    const pool = getPool();
    if (!pool || !_taxState) return;
    try {
      await pool.query(`INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
        [TAX_STATE_KEY, JSON.stringify(_taxState)]);
    } catch (e) { console.error('[taxes] state save failed:', e.message); }
  }
  // Called by runSync: register every booking seen this sync, seed rows that
  // have no answer yet from the values the app already holds (pre-store era),
  // and return { map, pending } for the mapping step.
  async function taxSyncRegister(bookingEvs, prevBkById, log) {
    const pool = getPool();
    const map = {}; const pending = new Set();
    const fpByEv = {};
    bookingEvs.forEach(ev => { fpByEv[String(ev.id)] = taxFingerprint(ev); });
    if (!pool) { bookingEvs.forEach(ev => pending.add(String(ev.id))); return { map, pending }; }
    await ensureTaxTable();
    const ids = bookingEvs.map(ev => String(ev.id));
    const fps = ids.map(id => fpByEv[id]);
    const dts = bookingEvs.map(ev => (ev.date_to ? String(ev.date_to).slice(0, 10) : null));
    if (ids.length) {
      await pool.query(`INSERT INTO booking_taxes (event_id, fp_now, date_to, seen_at, status)
         SELECT e, f, d, NOW(), 'pending' FROM unnest($1::text[], $2::text[], $3::text[]) AS t(e, f, d)
         ON CONFLICT (event_id) DO UPDATE SET fp_now = EXCLUDED.fp_now, date_to = EXCLUDED.date_to, seen_at = NOW()`, [ids, fps, dts]);
    }
    const rows = ids.length ? (await pool.query(`SELECT event_id, fp, status, data FROM booking_taxes WHERE event_id = ANY($1::text[])`, [ids])).rows : [];
    const byId = {}; rows.forEach(r => { byId[r.event_id] = r; });
    const seedIds = [], seedData = [];
    ids.forEach(id => {
      const row = byId[id];
      if (row && (row.status === 'ok' || row.status === 'empty') && row.data) {
        map[id] = row.data;
        if (row.fp && row.fp !== fpByEv[id]) pending.add(id);   // booking changed since the fetch: worker refreshes it
        return;
      }
      const prev = prevBkById[id];
      if (prev && taxHasData(prev)) {
        const d = taxSeedFrom(prev);
        map[id] = d; seedIds.push(id); seedData.push(JSON.stringify(d));
        return;
      }
      pending.add(id);
    });
    if (seedIds.length) {
      await pool.query(`UPDATE booking_taxes AS t SET status = 'ok', source = 'seed', data = s.d::jsonb, fp = NULL, fetched_at = NOW(), updated_at = NOW()
         FROM unnest($1::text[], $2::text[]) AS s(e, d) WHERE t.event_id = s.e AND t.status NOT IN ('ok', 'empty')`, [seedIds, seedData]);
      log(`  Taxes: seeded ${seedIds.length} booking(s) from the values already in the app`);
    }
    return { map, pending };
  }
  async function taxFetchOne(id, apiKey) {
    const r = await fetch(`${BASE}/calendar-events/${encodeURIComponent(id)}/calendar-event-gr-taxes`, { headers: hhH(apiKey), timeout: 20000 });
    const text = await r.text().catch(() => '');
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { http: r.status, json: (json && typeof json === 'object' && !Array.isArray(json)) ? json : null, retryAfter: r.headers.get('retry-after') };
  }
  async function taxWorkerRun(trigger, opts) {
    opts = opts || {};
    const sum = { trigger, at: new Date().toISOString(), queued: 0, fetched: 0, ok: 0, empty: 0, gone: 0, errors: 0, throttled: false };
    if (_taxRunning) { sum.skipped = 'running'; return sum; }
    const apiKey = getApiKey(); const pool = getPool();
    if (!apiKey || !pool) { sum.skipped = !apiKey ? 'no HOSTHUB_API_KEY' : 'no database'; return sum; }
    _taxRunning = true;
    try {
      await ensureTaxTable();
      const st = await taxLoadState();
      if (st.pausedUntil && Date.parse(st.pausedUntil) > Date.now()) { sum.skipped = 'paused until ' + st.pausedUntil; return sum; }
      const budget = opts.ids ? Math.min(200, opts.ids.length) : Math.max(TAX_BUDGET_MIN, Math.min(TAX_BUDGET_MAX, +st.budget || TAX_BUDGET_DEFAULT));
      const q = opts.ids
        ? (await pool.query(`SELECT event_id, fp_now, status, attempts FROM booking_taxes WHERE event_id = ANY($1::text[])`, [opts.ids.map(String).slice(0, 200)])).rows
        : (await pool.query(`SELECT event_id, fp_now, status, attempts FROM booking_taxes
             WHERE seen_at >= NOW() - interval '2 days' AND (next_try IS NULL OR next_try <= NOW()) AND (
                   status IN ('pending', 'error')
                OR (status IN ('ok', 'empty', 'gone') AND fp IS NOT NULL AND fp IS DISTINCT FROM fp_now)
                OR (status = 'empty' AND attempts < 3)
                OR (status = 'ok' AND fp IS NULL)
                OR (status = 'ok' AND source = 'api' AND date_to >= to_char(CURRENT_DATE - $2::int, 'YYYY-MM-DD') AND fetched_at < NOW() - ($3::int * interval '1 day')))
             ORDER BY CASE WHEN status = 'pending' THEN 0 WHEN status = 'error' THEN 1
                           WHEN fp IS NOT NULL AND fp IS DISTINCT FROM fp_now THEN 2
                           WHEN status = 'empty' THEN 3 WHEN fp IS NULL THEN 4 ELSE 5 END,
                      date_to DESC NULLS LAST
             LIMIT $1`, [budget, TAX_RECHECK_DAYS, TAX_RECHECK_EVERY_DAYS])).rows;
      sum.queued = q.length;
      const results = {};
      const deadline = Date.now() + Math.floor(TAX_TICK_MS * 0.8);
      let i = 0, stop = false, errStreak = 0;
      const one = async () => {
        while (!stop && i < q.length && Date.now() < deadline) {
          const row = q[i++];
          let res;
          try { res = await taxFetchOne(row.event_id, apiKey); }
          catch (e) { res = { http: 0, json: null, err: e.message }; }
          sum.fetched++;
          if (res.http === 429) {
            stop = true; sum.throttled = true;
            const ra = Math.max(TAX_PAUSE_MIN_S, Math.min(3600, parseInt(res.retryAfter || '0', 10) || 0));
            st.pausedUntil = new Date(Date.now() + ra * 1000).toISOString();
            st.budget = Math.max(TAX_BUDGET_MIN, Math.floor((+st.budget || TAX_BUDGET_DEFAULT) / 2));
            console.warn(`[taxes] 429 from Hosthub - pausing ${ra}s, budget now ${st.budget}`);
            continue;
          }
          if (res.http === 401 || res.http === 403) {
            stop = true; sum.authError = res.http;
            st.pausedUntil = new Date(Date.now() + 15 * 60000).toISOString();
            console.error(`[taxes] HTTP ${res.http} from Hosthub - check HOSTHUB_API_KEY`);
            continue;
          }
          if (res.http === 200 && res.json) {
            const empty = taxIsEmpty(res.json);
            const attempts = empty ? ((+row.attempts || 0) + 1) : 0;
            const nextTry = empty ? (attempts === 1 ? "NOW() + interval '1 day'" : attempts === 2 ? "NOW() + interval '7 days'" : 'NULL') : 'NULL';
            await pool.query(`UPDATE booking_taxes SET status = $2, data = $3::jsonb, fp = fp_now, http = 200, error = NULL, attempts = $4, source = 'api',
                                fetched_at = NOW(), next_try = ${nextTry}, updated_at = NOW() WHERE event_id = $1`,
              [row.event_id, empty ? 'empty' : 'ok', JSON.stringify(res.json), attempts]);
            results[row.event_id] = res.json;
            if (empty) sum.empty++; else sum.ok++;
            errStreak = 0;
            continue;
          }
          if (res.http === 404 || res.http === 410) {
            await pool.query(`UPDATE booking_taxes SET status = CASE WHEN status IN ('ok', 'empty') THEN status ELSE 'gone' END, fp = fp_now, http = $2,
                                error = 'not found', next_try = NULL, updated_at = NOW() WHERE event_id = $1`, [row.event_id, res.http]);
            sum.gone++;
            continue;
          }
          // 5xx, network error, bad JSON: keep any stored answer, back off, retry later.
          const attempts = (+row.attempts || 0) + 1;
          const mins = 5 * Math.pow(2, Math.min(attempts, 8));
          await pool.query(`UPDATE booking_taxes SET status = CASE WHEN status IN ('ok', 'empty') THEN status ELSE 'error' END, http = $2, error = $3, attempts = $4,
                              next_try = NOW() + ($5::int * interval '1 minute'), updated_at = NOW() WHERE event_id = $1`,
            [row.event_id, res.http || 0, String(res.err || (res.http === 200 ? 'bad response' : 'HTTP ' + res.http)).slice(0, 200), attempts, mins]);
          sum.errors++;
          if (++errStreak >= 8) { stop = true; sum.aborted = 'error streak'; }
        }
      };
      await Promise.all(Array.from({ length: TAX_CONCURRENCY }, one));
      if (!sum.throttled && !sum.authError && !opts.ids && q.length >= budget) st.budget = Math.min(TAX_BUDGET_MAX, (+st.budget || TAX_BUDGET_DEFAULT) + 25);
      if (!sum.throttled && !sum.authError) st.pausedUntil = null;
      st.lastRun = sum; st.runs = (+st.runs || 0) + 1;
      await taxSaveState();
      if (sum.fetched) console.log(`[taxes] ${trigger}: ${sum.fetched} fetched - ${sum.ok} ok, ${sum.empty} empty, ${sum.gone} gone, ${sum.errors} errors${sum.throttled ? ', throttled' : ''} (budget ${st.budget})`);
      sum.results = results;
      return sum;
    } catch (e) {
      console.error('[taxes] run failed:', e.message);
      sum.error = e.message;
      return sum;
    } finally { _taxRunning = false; }
  }
  function taxWorkerKick(trigger, delayMs) {
    if (_taxTimer) clearTimeout(_taxTimer);
    _taxTimer = setTimeout(() => { _taxTimer = null; taxWorkerRun(trigger).catch(() => {}); }, Math.max(0, delayMs || 0));
  }

  app.get('/api/taxes/status', async (req, res) => {
    const pool = getPool();
    if (!pool) return res.status(503).json({ error: 'no database' });
    try {
      await ensureTaxTable();
      const st = await taxLoadState();
      const counts = { pending: 0, ok: 0, empty: 0, error: 0, gone: 0 };
      (await pool.query(`SELECT status, count(*)::int AS n FROM booking_taxes WHERE seen_at >= NOW() - interval '2 days' GROUP BY status`)).rows
        .forEach(r => { counts[r.status] = r.n; });
      const x = (await pool.query(`SELECT
          count(*) FILTER (WHERE status IN ('ok', 'empty') AND fp IS NOT NULL AND fp IS DISTINCT FROM fp_now)::int AS changed,
          count(*) FILTER (WHERE status = 'ok' AND fp IS NULL)::int AS unverified,
          count(*) FILTER (WHERE next_try > NOW())::int AS waiting
        FROM booking_taxes WHERE seen_at >= NOW() - interval '2 days'`)).rows[0];
      res.json({ counts, changed: x.changed, unverified: x.unverified, waiting: x.waiting, running: _taxRunning,
                 budget: st.budget, pausedUntil: st.pausedUntil, lastRun: st.lastRun, runs: st.runs, tickMs: TAX_TICK_MS, hasKey: !!getApiKey() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/taxes/run', async (req, res) => {
    const sum = await taxWorkerRun('manual');
    delete sum.results;
    res.json(sum);
  });
  // Fetch specific bookings now (Reports "Fetch taxes" button). Only ids the
  // sync has registered are fetched, so a stale client id can never create junk.
  app.post('/api/taxes/fetch', async (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String).filter(Boolean).slice(0, 200) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    const sum = await taxWorkerRun('fetch', { ids });
    const results = sum.results || {}; delete sum.results;
    res.json(Object.assign({}, sum, { results, missing: ids.filter(id => !(id in results)) }));
  });

  setTimeout(() => taxWorkerKick('boot', 0), 45000);
  setInterval(() => taxWorkerKick('tick', 0), TAX_TICK_MS);

  return { syncRegister: taxSyncRegister, hasData: taxHasData, seedFrom: taxSeedFrom, fingerprint: taxFingerprint, run: taxWorkerRun, kick: taxWorkerKick };
};
