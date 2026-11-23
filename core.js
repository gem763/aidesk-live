/* DL-13 live paper dashboard: pure computation (no DOM). PAPER ONLY. */
(function (G) {
  'use strict';
  const STEP = 10 * 60 * 1000;
  const parseKst = (s) => Date.parse(String(s).replace(' ', 'T').slice(0, 19) + '+09:00');
  const pad = (n) => String(n).padStart(2, '0');
  function kstParts(ms) {
    const d = new Date(ms + 9 * 3600 * 1000);
    return { y: d.getUTCFullYear(), mo: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()), h: pad(d.getUTCHours()), mi: pad(d.getUTCMinutes()), s: pad(d.getUTCSeconds()) };
  }
  const fmtKst = (ms) => { const p = kstParts(ms); return `${p.mo}/${p.d} ${p.h}:${p.mi}`; };
  const fmtKstFull = (ms) => { const p = kstParts(ms); return `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}:${p.s}`; };

  /* candles: array of {t (start ms), o, c}. Price at time T = open of the candle starting at T,
     else close of the latest candle that started before T (carry forward through gaps). */
  function makeSeries(rows) {
    const a = rows.slice().sort((x, y) => x.t - y.t);
    const ts = a.map((x) => x.t);
    function at(T) {
      let lo = 0, hi = ts.length - 1, k = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= T) { k = m; lo = m + 1; } else hi = m - 1; }
      if (k < 0) return null;
      return ts[k] === T ? a[k].o : a[k].c;
    }
    const last = a.length ? a[a.length - 1] : null;
    return { at, last: last ? last.c : null, lastT: last ? last.t : null, n: a.length, first: a.length ? a[0].t : null };
  }

  function grid(fromMs, toMs) {
    const out = [];
    let t = Math.ceil(fromMs / STEP) * STEP;
    for (; t <= toMs; t += STEP) out.push(t);
    return out;
  }

  /* ---------- A2 / A2-W26 ----------
     sleeve value(T) = tranche_nav * sum(units_c * P_c(T)) using the latest ledger BOOK at or before T.
     Before a sleeve's first boundary it is cash = tranche_nav. */
  function a2Compute(book, px, opts) {
    const o = opts || {};
    const nowMs = o.nowMs;
    const start = parseKst(book.start_kst);
    const from = Math.max(start, nowMs - (o.windowDays || 14) * 86400000);
    let times = grid(from, nowMs);
    const lastPriceT = o.lastPriceT || nowMs;
    if (!times.length || times[times.length - 1] < lastPriceT) times.push(lastPriceT);
    const nav = book.tranche_nav;
    const BOOKS = ['A2', 'B0', 'EW'];
    const priceOf = (c, T, seg) => {
      const s = px[c];
      let p = null;
      if (s) p = (T === lastPriceT && s.last != null) ? s.last : s.at(T);
      if (p == null && o.ratio && o.ratio[c]) {           // fallback: ledger boundary price x (Binance now / Binance at boundary)
        const r = o.ratio[c], b0 = r.at(parseKst(seg.t)), b1 = T === lastPriceT ? r.last : r.at(T);
        if (b0 && b1 && seg.prices[c]) p = seg.prices[c] * b1 / b0;
      }
      if (p == null) p = seg.prices[c] != null ? seg.prices[c] : null;
      return p;
    };
    const missing = new Set();
    const sleeves = book.sleeves.map((sl) => {
      const segs = sl.segments.map((s) => Object.assign({ ms: parseKst(s.t) }, s)).sort((a, b) => a.ms - b.ms);
      const val = (T, bk) => {
        let seg = null;
        for (const s of segs) if (s.ms <= T) seg = s;
        if (!seg || !seg.books[bk]) return nav;
        let v = 0;
        for (const [c, u] of Object.entries(seg.books[bk].units)) {
          const p = priceOf(c, T, seg);
          if (p == null) { missing.add(c); continue; }
          v += u * p;
        }
        return nav * v;
      };
      const series = {};
      BOOKS.forEach((bk) => { series[bk] = times.map((T) => val(T, bk)); });
      // ledger cross-check at the last boundary: value with ledger prices vs value with fetched prices vs engine value
      let check = null;
      const last = segs[segs.length - 1];
      if (last && last.books.A2) {
        let vLedger = 0, vFetched = 0, ok = true;
        for (const [c, u] of Object.entries(last.books.A2.units)) {
          vLedger += u * (last.prices[c] || 0);
          const s = px[c]; const p = s ? s.at(last.ms) : null;
          if (p == null) ok = false; else vFetched += u * p;
        }
        check = { t: last.ms, ledger: nav * vLedger, fetched: ok ? nav * vFetched : null, engine: sl.ledger_value_krw };
      }
      const holdings = [];
      if (last && last.books.A2) {
        const T = times[times.length - 1];
        for (const [c, u] of Object.entries(last.books.A2.units)) {
          const p0 = last.prices[c], p1 = priceOf(c, T, last);
          const meta = (sl.holdings || []).find((h) => h.symbol === c) || {};
          holdings.push({ coin: c, role: meta.role || '', entry: p0, now: p1, chg: p0 && p1 ? p1 / p0 - 1 : null, value: p1 != null ? nav * u * p1 : null, since: last.ms });
        }
      }
      return { tranche: sl.tranche, started: segs.length > 0 && segs[0].ms <= times[times.length - 1], unaudited: sl.unaudited,
               start: parseKst(sl.start_boundary_kst), next: sl.next_boundary_kst ? parseKst(sl.next_boundary_kst) : null,
               lastBoundary: last ? last.ms : null, series, check, holdings, cost: sl.cost_krw };
    });
    const total = {};
    BOOKS.forEach((bk) => { total[bk] = times.map((_, i) => sleeves.reduce((a, s) => a + s.series[bk][i], 0)); });
    // older history (before the 10-minute window): ledger boundary points
    const older = (book.combined_series || []).map((r) => ({ t: parseKst(r.ts), A2: r.A2, B0: r.B0, EW: r.EW })).filter((r) => r.t < times[0]);
    return { times, sleeves, total, older, capital: book.capital, nav, missing: [...missing] };
  }

  /* ---------- Numerai books (Binance USDT) ----------
     equity(T) = eq0 * (1 + sum_c w_c * (P_c(T)/open_c - 1) - cost)   (funding is settled once a day by the engine; not included live) */
  function nmCompute(test, px, opts) {
    const o = opts || {};
    const nowMs = o.nowMs;
    const start = parseKst(test.start_kst);
    const from = Math.max(start, nowMs - (o.windowDays || 7) * 86400000);
    const lastPriceT = o.lastPriceT || nowMs;
    const times = grid(from, nowMs);
    if (!times.length || times[times.length - 1] < lastPriceT) times.push(lastPriceT);
    const segs = test.segments.map((s) => Object.assign({ ms: parseKst(s.t) }, s)).sort((a, b) => a.ms - b.ms);
    const series = test.series || [];
    const btcBase = (day) => { let b = 1; for (const r of series) if (r[0] < day) b = 1 + r[3]; return b; };
    const sym = (c) => test.pmap[c] || (c + 'USDT');
    const P = (c, T) => { const s = px[sym(c)]; if (!s) return null; return T === lastPriceT && s.last != null ? s.last : s.at(T); };
    const openOf = (seg, c) => (seg.open && seg.open[c] != null ? seg.open[c] : P(c, seg.ms));
    const missing = new Set();
    const eqAt = (T) => {
      let seg = null; for (const s of segs) if (s.ms <= T) seg = s;
      if (!seg) return { eq: test.capital, btc: 1 };
      let g = 0;
      for (const [c, w] of Object.entries(seg.W)) {
        const p0 = openOf(seg, c), p1 = P(c, T);
        if (p0 && p1) g += w * (p1 / p0 - 1); else missing.add(c);
      }
      const b0 = P('BTC', seg.ms), b1 = P('BTC', T);
      return { eq: seg.eq0 * (1 + g - seg.cost), btc: btcBase(seg.day) * (b0 && b1 ? b1 / b0 : 1) };
    };
    const pts = times.map(eqAt);
    const last = segs[segs.length - 1];
    const holdings = [];
    if (last) {
      const T = times[times.length - 1];
      for (const [c, w] of Object.entries(last.W)) {
        const p0 = openOf(last, c), p1 = P(c, T);
        holdings.push({ coin: c, w, entry: p0, now: p1, chg: p0 && p1 ? p1 / p0 - 1 : null, contrib: p0 && p1 ? w * (p1 / p0 - 1) : null });
      }
      holdings.sort((a, b) => b.w - a.w);
    }
    const older = series.map((r) => ({ t: parseKst(r[0] + 'T09:00:00') + 86400000, ret: r[1], btc: r[3] })).filter((r) => r.t < times[0]);
    return { times, eq: pts.map((p) => p.eq), btc: pts.map((p) => p.btc), holdings, capital: test.capital, older,
             lastBoundary: last ? last.ms : null, missing: [...missing] };
  }

  function neededNmSymbols(nm) {
    const fut = new Set(), spot = new Set();
    for (const t of Object.values(nm || {})) {
      const set = t.market === 'spot' ? spot : fut;
      for (const s of t.segments) for (const c of Object.keys(s.W)) set.add(t.pmap[c] || c + 'USDT');
      set.add(t.pmap.BTC || 'BTCUSDT');
    }
    return { fut: [...fut], spot: [...spot] };
  }

  G.LiveCore = { STEP, parseKst, fmtKst, fmtKstFull, makeSeries, grid, a2Compute, nmCompute, neededNmSymbols };
})(typeof window !== 'undefined' ? window : globalThis);
