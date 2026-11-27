/* DL-13 live paper dashboard: fetch + render. PAPER ONLY: no orders, no keys, public prices only. */
(function () {
  'use strict';
  const C = window.LiveCore;
  const $ = (s) => document.querySelector(s);
  const PASS_KEY = 'aidesk_live_pass';
  const state = { data: null, tab: 'home', a2View: { A2: 'total', A2W26: 'total' }, a2Slot: { A2: '18h', A2W26: '18h' }, nmTest: 'NM-LS', trTest: 'T25', aiLog: null, ev: null, range: 'all', px: null, nmPx: null, fetchedAt: null, source: '', warn: [] };

  /* ---------- crypto ---------- */
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function decrypt(enc, pass) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(enc.salt), iterations: enc.iter }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, key, b64(enc.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function loadData(pass) {
    const r = await fetch('data.enc.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('자료 파일을 받지 못했습니다 (' + r.status + ')');
    return decrypt(await r.json(), pass);
  }

  /* ---------- public prices ---------- */
  async function getJson(url, tries) {
    for (let i = 0; i < (tries || 3); i++) {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 800 * (i + 1))); continue; }
        if (!r.ok) throw new Error(String(r.status));
        return await r.json();
      } catch (e) { if (i === (tries || 3) - 1) throw e; await new Promise((ok) => setTimeout(ok, 400)); }
    }
    throw new Error('429');
  }
  async function pool(items, n, fn) {
    const out = new Array(items.length); let k = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i], i); } }));
    return out;
  }
  const kstStr = (ms) => C.fmtKstFull(ms);
  async function bithumbCandles(coin, fromMs) {
    const rows = []; let to = null;
    for (let page = 0; page < 30; page++) {
      const url = 'https://api.bithumb.com/v1/candles/minutes/10?market=KRW-' + coin + '&count=200' + (to ? '&to=' + encodeURIComponent(kstStr(to)) : '');
      const a = await getJson(url);
      if (!Array.isArray(a)) throw new Error('bithumb ' + coin + ' 응답 이상');
      if (!a.length) break;
      let earliest = Infinity;
      for (const x of a) { const t = C.parseKst(x.candle_date_time_kst); rows.push({ t, o: +x.opening_price, c: +x.trade_price }); earliest = Math.min(earliest, t); }
      if (earliest <= fromMs || a.length < 200) break;
      to = earliest;
    }
    return rows;
  }
  async function binanceKlines(market, symbol, fromMs) {
    const base = market === 'fut' ? 'https://fapi.binance.com/fapi/v1/klines' : 'https://api.binance.com/api/v3/klines';
    const lim = market === 'fut' ? 1500 : 1000;
    const rows = []; let st = fromMs;
    for (let page = 0; page < 10; page++) {
      const a = await getJson(`${base}?symbol=${encodeURIComponent(symbol)}&interval=5m&startTime=${st}&limit=${lim}`);
      if (!Array.isArray(a) || !a.length) break;
      for (const x of a) rows.push({ t: +x[0], o: +x[1], c: +x[4] });
      if (a.length < lim) break;
      st = +a[a.length - 1][0] + 1;
    }
    return rows;
  }
  function windowStart(startKst, days) { return Math.max(C.parseKst(startKst), Date.now() - days * 86400000) - 10 * 60000; }

  async function fetchA2Prices(d, progress) {
    const coins = [...new Set(Object.values(d.a2 || {}).flatMap((b) => b.coins))];
    const books = Object.values(d.a2 || {});
    if (!books.length) return { px: {}, source: 'none' };
    const from = Math.min(...books.map((b) => windowStart(b.start_kst, 14)));
    const px = {}; let done = 0;
    try {
      await pool(coins, 6, async (c) => { px[c] = C.makeSeries(await bithumbCandles(c, from)); progress(++done, coins.length, '빗썸'); });
      return { px, source: 'bithumb' };
    } catch (e) {
      // Bithumb blocked (for example outside Korea): fall back to Binance USDT price ratios anchored on ledger prices
      const ratio = {}; done = 0;
      await pool(coins, 6, async (c) => { try { ratio[c] = C.makeSeries(await binanceKlines('spot', c + 'USDT', from)); } catch (e2) { /* coin stays at ledger price */ } progress(++done, coins.length, '바이낸스'); });
      return { px: {}, ratio, source: 'binance-ratio', err: String(e.message || e) };
    }
  }
  async function fetchNmPrices(d, progress) {
    const nm = d.nm || {};
    const tr = Object.assign({}, d.trend || {}, d.ai || {});
    if (!Object.keys(nm).length && !Object.keys(tr).length) return {};
    const need = C.neededNmSymbols(nm);
    for (const s of (C.neededTrendSymbols(tr) || [])) if (!need.fut.includes(s)) need.fut.push(s);
    const starts = Object.values(nm).map((t) => windowStart(t.start_kst, 7)).concat(Object.values(tr).map((t) => windowStart(t.start_kst, 7)));
    const from = Math.min(...starts);
    const out = { fut: {}, spot: {} }; const jobs = need.fut.map((s) => ['fut', s]).concat(need.spot.map((s) => ['spot', s])); let done = 0;
    const errs = [];
    await pool(jobs, 6, async ([m, s]) => { try { out[m][s] = C.makeSeries(await binanceKlines(m, s, from)); } catch (e) { errs.push(s); } progress(++done, jobs.length, '바이낸스'); });
    out.errs = errs;
    return out;
  }

  /* ---------- formatting ---------- */
  const won = (v) => (v == null || !isFinite(v) ? '-' : Math.round(v).toLocaleString('ko-KR') + '원');
  const usd = (v) => (v == null || !isFinite(v) ? '-' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const pct = (v, dg) => (v == null || !isFinite(v) ? '-' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dg == null ? 2 : dg) + '%');
  const price = (v) => (v == null ? '-' : v >= 100 ? Math.round(v).toLocaleString('ko-KR') : v >= 1 ? v.toFixed(2) : v.toPrecision(4));
  const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SLOT = { total: '합산', '00h': '0시', '06h': '6시', '12h': '12시', '18h': '18시' };

  /* ---------- chart (SVG, no library) ---------- */
  function chart(times, lines, opts) {
    const W = 340, H = 200, L = 44, R = 8, T = 10, B = 24;
    const n = times.length; if (n < 2) return '<div class="muted">곡선을 그릴 만큼 시간이 지나지 않았습니다.</div>';
    const all = lines.flatMap((l) => l.values).filter((v) => isFinite(v));
    let lo = Math.min(...all, 0), hi = Math.max(...all, 0); const padv = Math.max(0.1, (hi - lo) * 0.1); lo -= padv; hi += padv;
    const t0 = times[0], t1 = times[n - 1];
    const X = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
    const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" data-t0="${t0}" data-t1="${t1}">`;
    for (let i = 0; i <= 4; i++) { const v = lo + (i * (hi - lo)) / 4; s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 4}" y="${Y(v) + 3}" class="ax" text-anchor="end">${v.toFixed(Math.abs(hi - lo) < 2 ? 2 : 1)}%</text>`; }
    s += `<line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" class="zero"/>`;
    for (let i = 0; i <= 3; i++) { const t = t0 + (i * (t1 - t0)) / 3; s += `<text x="${X(t)}" y="${H - 6}" class="ax" text-anchor="${i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}">${C.fmtKst(t)}</text>`; }
    lines.slice().reverse().forEach((l) => {
      const d = l.values.map((v, i) => (isFinite(v) ? `${i ? 'L' : 'M'}${X(times[i]).toFixed(1)},${Y(v).toFixed(1)}` : '')).join('');
      s += `<path d="${d}" fill="none" stroke="${l.color}" stroke-width="${l.width || 1.5}" ${l.dash ? 'stroke-dasharray="4 3"' : ''}/>`;
    });
    s += `<line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/></svg>`;
    const legend = lines.map((l) => `<span><i style="background:${l.color}"></i>${esc(l.name)} <b class="${tone(l.values[n - 1])}">${l.values[n - 1] >= 0 ? '+' : ''}${l.values[n - 1].toFixed(2)}%</b></span>`).join('');
    const id = 'c' + Math.random().toString(36).slice(2);
    chartData[id] = { times, lines, L, R, W };
    return `<div class="chartbox" id="${id}">${s}<div class="tip" style="display:none"></div></div><div class="legend">${legend}</div>`;
  }
  const chartData = {};
  function bindCharts() {
    document.querySelectorAll('.chartbox').forEach((box) => {
      const cd = chartData[box.id]; if (!cd) return;
      const svg = box.querySelector('svg'), tip = box.querySelector('.tip'), cross = box.querySelector('.cross');
      const show = (ev) => {
        const r = svg.getBoundingClientRect(); const cx = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / r.width * cd.W;
        const t0 = cd.times[0], t1 = cd.times[cd.times.length - 1];
        const tt = t0 + ((cx - cd.L) / (cd.W - cd.L - cd.R)) * (t1 - t0);
        let k = 0; for (let i = 0; i < cd.times.length; i++) if (Math.abs(cd.times[i] - tt) < Math.abs(cd.times[k] - tt)) k = i;
        const x = cd.L + ((cd.times[k] - t0) / (t1 - t0 || 1)) * (cd.W - cd.L - cd.R);
        cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.display = '';
        tip.innerHTML = `<b>${C.fmtKst(cd.times[k])}</b><br>` + cd.lines.map((l) => `${esc(l.name)} ${l.values[k] >= 0 ? '+' : ''}${l.values[k].toFixed(2)}%`).join('<br>');
        tip.style.display = ''; tip.style.left = Math.min(r.width - 130, Math.max(0, (x / cd.W) * r.width - 60)) + 'px';
      };
      svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show);
      svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.style.display = 'none'; });
    });
  }
  function cut(times, arrs) {
    const days = state.range === '24h' ? 1 : state.range === '3d' ? 3 : 99;
    const from = times[times.length - 1] - days * 86400000; let i = 0; while (i < times.length - 1 && times[i] < from) i++;
    return { times: times.slice(i), arrs: arrs.map((a) => a.slice(i)) };
  }
  const rangeSel = () => `<div class="seg small" data-act="range">${[['24h', '24시간'], ['3d', '3일'], ['all', '전체']].map(([v, l]) => `<button class="${state.range === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>`;

  /* ---------- views ---------- */
  function a2Result(key) {
    const b = state.data.a2[key]; if (!b) return null;
    const lastPriceT = state.fetchedAt;
    return C.a2Compute(b, state.px.px || {}, { nowMs: lastPriceT, lastPriceT, ratio: state.px.ratio });
  }
  function nmResult(t) {
    const x = state.data.nm[t]; if (!x || !state.nmPx) return null;
    return C.nmCompute(x, state.nmPx[x.market] || {}, { nowMs: state.fetchedAt, lastPriceT: state.fetchedAt });
  }
  function trendResult(t) {
    const x = state.data.trend && state.data.trend[t]; if (!x || !state.nmPx) return null;
    return C.nmCompute(x, state.nmPx.fut || {}, { nowMs: state.fetchedAt, lastPriceT: state.fetchedAt });
  }
  function aiResult(k) {
    const x = state.data.ai && state.data.ai[k]; if (!x || !state.nmPx) return null;
    return C.nmCompute(x, state.nmPx.fut || {}, { nowMs: state.fetchedAt, lastPriceT: state.fetchedAt });
  }
  const metric = (label, value, detail, tn) => `<div class="metric"><div class="ml">${label}</div><div class="mv ${tn || ''}">${value}</div><div class="md">${detail || ''}</div></div>`;

  const ABOUT = {
    A2: '하루 4번(0·6·12·18시) 시각별로 따로 운용하는 4개 슬리브의 모의 성적입니다. 고른 코인은 슬리브마다 정해진 기간(1·3·5일) 보유합니다. 매주 월요일 조합을 고를 때 최근 2년을 봅니다.',
    A2W26: 'A2와 규칙이 같고 한 가지만 다릅니다. 매주 월요일 조합을 고를 때 최근 26주만 봄(A2는 최근 2년). 기존 A2와 별개의 시험이며 서로의 결과로 규칙을 바꾸지 않습니다.',
  };
  const NM_SHORT = { 'NM-LS': 'Numerai 롱숏', 'LV-LS': '단순 순위 롱숏', 'NM-L': 'Numerai 현물 매수' };
  const TR_SHORT = { T25: '하루 추세 25%', T40: '하루 추세 40%' };
  const TR_DESC = {
    T25: '바이낸스 선물 12개 코인 롱숏. 지난 24시간 움직임이 최근 30일 중 상위 5%로 강할 때만 그 방향으로 바꾸고, 그 사이에는 들고 갑니다. 비중은 하루 한 번, 방향 점검은 12시간마다. 계좌 출렁임 목표는 연 25%이며 규모는 0.25~2배로 제한합니다. 코인별 손절·익절은 없습니다.',
    T40: '규칙이 T25와 같고, 계좌 출렁임 목표만 연 40%입니다.',
  };
  const NM_DESC = {
    'NM-LS': '바이낸스 선물. Numerai 순위 상위 20% 매수, 하위 20% 중 공매도 수수료(펀딩비)를 받는 코인만 공매도.',
    'LV-LS': 'NM-LS와 똑같고, 순위만 Numerai 대신 \'덜 흔들리는 코인\' 순으로 매김.',
    'NM-L': '바이낸스 현물. Numerai 순위 상위 20%를 사기만 함.',
  };
  const RC_TEXT = { 0: '정상', 2: '설정 오류', 3: '다른 실행이 잠금 중', 4: '장부 이상', 5: '멈춤', 6: '보류', 7: '시세 조회 실패' };
  const kv = (rows) => `<div class="kv">${rows.filter(Boolean).map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('')}</div>`;
  const ks = (s) => (s ? esc(String(s).replace('T', ' ').slice(5, 16)) : '-');
  const pp = (v, unit) => (v == null || !isFinite(v) ? '-' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + (unit || '%'));
  const RUN_SLOTS = { A2: '매일 0·6·12·18시 26분 무렵 KST', A2W26: '매일 0·6·12·18시 26분 무렵 KST (A2 바로 뒤)' };
  // a sleeve whose boundary time has passed but is not in the ledger yet
  function pendingNote(ls, nowMs) {
    const nb = ls.started ? ls.next_boundary_kst : ls.start_boundary_kst; if (!nb) return null;
    const t = C.parseKst(nb); if (nowMs < t) return null;
    return `${C.fmtKst(t)} 교체 시각은 지났지만 아직 장부에 기록 전입니다. 다음 자동 실행 때 그 시간의 첫 거래 가격으로 소급 기록되고, 곡선도 그 시각부터 다시 계산됩니다.`;
  }

  function a2View(key) {
    const b = state.data.a2[key], r = a2Result(key);
    if (!r) return '<div class="card">자료 없음</div>';
    const n = r.times.length - 1, cap = r.capital, nowMs = r.times[n];
    const v = r.total.A2[n], b0 = r.total.B0[n], ew = r.total.EW[n];
    const view = state.a2View[key];
    const LS = {}; (b.ledger_sleeves || []).forEach((x) => { LS[x.tranche] = x; });
    let times = r.times, base = cap, A = r.total.A2, B0 = r.total.B0, EW = r.total.EW;
    if (view !== 'total') { const s = r.sleeves.find((x) => x.tranche === view); base = r.nav; A = s.series.A2; B0 = s.series.B0; EW = s.series.EW; }
    if (view === 'total' && r.older.length) { times = r.older.map((o) => o.t).concat(times); A = r.older.map((o) => o.A2).concat(A); B0 = r.older.map((o) => o.B0).concat(B0); EW = r.older.map((o) => o.EW).concat(EW); }
    const c = cut(times, [A, B0, EW]);
    const P = (arr) => arr.map((x) => (x / base - 1) * 100);
    let h = `<div class="card"><h2>${esc(b.name)}는 이런 시험입니다</h2><div class="txt">${esc(ABOUT[key] || '')}</div></div>`;
    const pend = r.sleeves.map((s) => pendingNote(LS[s.tranche] || {}, nowMs)).filter(Boolean);
    if (pend.length) h += `<div class="card warn"><b>기록 대기</b><br>${pend.map(esc).join('<br>')}</div>`;
    h += `<div class="card"><h2>합산 성적 (모의 원금 ${won(cap)})</h2><div class="metrics">`
      + metric('지금 평가액', won(v), pct(v / cap - 1) + ' 원금 대비', tone(v / cap - 1))
      + metric('BTC·ETH 50/50 대비', pct(v / b0 - 1), '50/50 ' + won(b0), tone(v / b0 - 1))
      + metric('16개 균등 보유 대비', pct(v / ew - 1), '균등 ' + won(ew), tone(v / ew - 1))
      + metric('누적 매매 비용', won(r.sleeves.reduce((a, s) => a + (s.cost || 0), 0)), '매수·매도 각 0.04%')
      + `</div><div class="muted">장부(마지막 교체 시점 가격) 기준 합산 ${won(b.ledger_total.value_krw)}. 위 숫자는 같은 보유 수량을 방금 받은 시세로 다시 평가한 값입니다.</div></div>`;
    h += `<div class="card"><h2>누적 수익률 곡선 <small>원금 대비 %, 10분 단위</small></h2>`
      + `<div class="seg small" data-act="a2view" data-k="${key}">${Object.entries(SLOT).map(([k2, l]) => `<button class="${view === k2 ? 'on' : ''}" data-v="${k2}">${l}</button>`).join('')}</div>${rangeSel()}`
      + chart(c.times, [{ name: b.name, values: P(c.arrs[0]), color: '#2563eb', width: 2.2 }, { name: '50/50', values: P(c.arrs[1]), color: '#f59e0b' }, { name: '균등', values: P(c.arrs[2]), color: '#94a3b8', dash: 1 }])
      + `<div class="muted">10분마다 한 점. 마지막 점은 방금 받은 시세. ${r.older.length ? '10분 단위 이전 구간은 교체 시점 장부 값.' : ''}</div></div>`;
    h += `<div class="card"><h2>슬리브 4개 요약</h2><table><tr><th>슬리브</th><th>평가액</th><th>원금 대비</th><th>균등 대비</th><th>상태</th></tr>`
      + r.sleeves.map((s) => { const x = s.series.A2[n], e = s.series.EW[n]; const pn = pendingNote(LS[s.tranche] || {}, nowMs);
        return `<tr><td>${SLOT[s.tranche]}${s.unaudited ? '<span class="tag">추가 점검 전</span>' : ''}</td><td>${won(x)}</td><td class="${tone(x / r.nav - 1)}">${s.started ? pct(x / r.nav - 1) : '-'}</td><td class="${tone(x / e - 1)}">${s.started ? pct(x / e - 1) : '-'}</td><td>${s.started ? '운용 중' : '대기'}${pn ? '<br><span class="tag warn">기록 대기</span>' : ''}</td></tr>`; }).join('') + `</table></div>`;
    // sleeve detail
    const slot = state.a2Slot[key];
    const s = r.sleeves.find((x) => x.tranche === slot) || r.sleeves[0]; const L = LS[s.tranche] || {};
    h += `<div class="card"><h2>슬리브 상세</h2><div class="seg small" data-act="a2slot" data-k="${key}">${['00h', '06h', '12h', '18h'].map((k2) => `<button class="${slot === k2 ? 'on' : ''}" data-v="${k2}">${SLOT[k2]}</button>`).join('')}</div>`
      + (s.unaudited ? `<div class="note">이 시각(6시·18시)은 과거 실험에는 포함됐지만 추가 점검은 아직 하지 않은 슬롯입니다.</div>` : '')
      + kv([['지금 평가액', won(s.series.A2[n]) + ' · ' + (s.started ? pct(s.series.A2[n] / r.nav - 1) : '대기')],
            ['50/50 · 균등 보유였다면', won(s.series.B0[n]) + ' · ' + won(s.series.EW[n])],
            ['장부 평가액 (교체 시점)', won(L.value_krw)],
            ['누적 비용', won(L.cost_krw)],
            ['마지막 교체', L.last_boundary_kst ? ks(L.last_boundary_kst) + ' KST' : '아직 없음 (' + ks(L.start_boundary_kst) + ' 시작)'],
            ['다음 교체', ks(L.next_boundary_kst) + ' KST (장부 기록은 ' + ks(L.next_processable_kst) + ' 이후 자동 실행 때)'],
            ['처리한 교체 횟수', (L.boundaries_done || 0) + '회']]);
    if (s.holdings.length) {
      h += `<h3>지금 보유 중</h3><table><tr><th>코인</th><th>비중</th><th>매수가 → 현재가</th><th>평가액</th><th>청산 예정</th></tr>`
        + s.holdings.map((x) => { const m = (L.holdings || []).find((q) => q.symbol === x.coin) || {};
          return `<tr><td><b>${esc(x.coin)}</b><br><span class="muted">${String(x.role).startsWith('앵커') ? '앵커' : '급등'}</span></td><td>${m.weight != null ? (m.weight * 100).toFixed(1) + '%' : '-'}</td><td>${price(x.entry)} → ${price(x.now)}<br><span class="${tone(x.chg)}">${pct(x.chg)}</span></td><td>${won(x.value)}</td><td>${m.planned_exit_kst ? ks(m.planned_exit_kst) : '다음 교체 때'}</td></tr>`; }).join('') + `</table>`;
    }
    const fills = (L.fills || []).slice().reverse().slice(0, 30);
    if (fills.length) h += `<details><summary>최근 매매 기록 (${fills.length}건)</summary><table><tr><th>시각</th><th>코인</th><th>매수/매도</th><th>가격</th><th>금액</th></tr>`
      + fills.map((f) => `<tr><td>${ks(f.boundary_kst)}</td><td>${esc(f.symbol)}</td><td>${f.side === 'BUY' ? '매수' : '매도'}</td><td>${price(f.price)}</td><td>${won(f.notional_krw)}</td></tr>`).join('') + `</table></details>`;
    h += `</div>`;
    h += `<div class="card"><h2>지금 보유 코인 (전체 슬리브)</h2><table><tr><th>슬리브·코인</th><th>매수가</th><th>현재가</th><th>등락</th><th>평가액</th></tr>`;
    r.sleeves.forEach((s2) => s2.holdings.forEach((x) => { h += `<tr><td>${SLOT[s2.tranche]} · <b>${esc(x.coin)}</b><br><span class="muted">${C.fmtKst(x.since)} 매수</span></td><td>${price(x.entry)}</td><td>${price(x.now)}</td><td class="${tone(x.chg)}">${pct(x.chg)}</td><td>${won(x.value)}</td></tr>`; }));
    h += `</table></div>`;
    const checks = r.sleeves.filter((x) => x.check);
    h += `<div class="card"><h2>장부 대조 <small>마지막 교체 시점</small></h2><table><tr><th>슬리브</th><th>시점</th><th>장부 값</th><th>화면 계산</th><th>차이</th></tr>`
      + checks.map((x) => { const k = x.check; const diff = k.fetched == null ? null : k.fetched - k.engine; return `<tr><td>${SLOT[x.tranche]}</td><td>${C.fmtKst(k.t)}</td><td>${won(k.engine)}</td><td>${k.fetched == null ? '시세 없음' : won(k.fetched)}</td><td>${diff == null ? '-' : won(diff)}</td></tr>`; }).join('')
      + `</table><div class="muted">장부 값 = 자동 실행이 기록한 평가액. 화면 계산 = 장부의 보유 수량 × 방금 받은 빗썸 10분봉 시가. 같으면 0원.</div></div>`;
    const sr = b.stop_rules || {};
    h += `<div class="card"><h2>멈춤 규칙</h2>` + kv([
      ['상태', sr.halted ? '<b class="down">멈춤 · ' + esc(sr.halt_reason || '') + '</b>' : sr.k1_relative_dd_now == null ? '4개 슬리브 모두 시작 후 계산' : '정상'],
      ['균등 보유 대비 고점 하락(현재)', pct(sr.k1_relative_dd_now, 1)],
      ['지금까지 최대 하락', pct(sr.k1_max_dd, 1)],
      ['경고 · 멈춤 기준', pct(sr.warn_at, 0) + ' 경고 · ' + pct(sr.halt_at, 0) + ' 멈춤'],
      (sr.warnings || []).length ? ['경고', esc(sr.warnings.join(', '))] : null,
      (sr.holds || []).length ? ['보류', esc(sr.holds.join(', '))] : null]) + `<div class="muted">멈춤 규칙은 장부(교체 시점) 값으로 판단합니다.</div></div>`;
    const lr = b.last_run || {};
    h += `<div class="card"><h2>자동 실행 상태</h2>` + kv([
      ['자동 실행 시각', RUN_SLOTS[key] || '-'],
      ['마지막 실행', ks(lr.run_kst) + ' KST · ' + esc(RC_TEXT[lr.rc] || ('코드 ' + lr.rc))],
      ['실행 메모', esc(lr.msg || '-')],
      ['장부 기록 수', b.ledger.events + '건'],
      ['장부 무결성', b.ledger.chain_ok ? '정상' : '<b class="down">이상</b>']]) + `</div>`;
    return h;
  }

  function nmView() {
    const tests = Object.keys(state.data.nm || {});
    if (!tests.length) return '<div class="card">자료 없음</div>';
    const meta = state.data.nm_meta || {}, D = meta.dash || {}, DT = D.tests || {};
    const t = state.nmTest, x = state.data.nm[t], r = nmResult(t);
    if (!r) return '<div class="card">시세를 받는 중…</div>';
    const R = {}; tests.forEach((k) => { R[k] = nmResult(k); });
    const n = r.times.length - 1, cap = r.capital, v = r.eq[n];
    const ret = (k) => R[k].eq[R[k].eq.length - 1] / R[k].capital - 1;
    const vsBtc = (k) => (1 + ret(k)) / R[k].btc[R[k].btc.length - 1] - 1;
    let h = `<div class="card"><h2>Numerai 바이낸스는 이런 시험입니다</h2><table><tr><th>시험</th><th>하는 일</th></tr>${tests.map((k) => `<tr><td><b>${esc(k)}</b><br><span class="muted">${esc(NM_SHORT[k] || '')}</span></td><td>${esc(NM_DESC[k] || '')}</td></tr>`).join('')}</table>`
      + `<div class="txt">세 시험 모두 ${ks(x.start_kst)} KST에 시작하고, 매일 09:00 KST 바이낸스 가격으로 하루 1번 비중을 맞춥니다. 시험마다 모의 원금은 ${usd(cap)}(약 1,000만 원 상당)입니다.</div>`
      + `<div class="txt">NM-LS의 '펀딩비 받는 코인만 공매도' 규칙은 과거 결과를 본 뒤에 만든 규칙이라, 앞으로의 기록으로 확인하는 것이 이 시험의 목적입니다.</div></div>`;
    h += `<div class="card"><h2>세 시험 성적</h2><table><tr><th>시험</th><th>원금 대비</th><th>균등 대비<br><span class="muted">장부</span></th><th>BTC 대비</th><th>상태</th></tr>`
      + tests.map((k) => `<tr><td><b>${esc(k)}</b></td><td class="${tone(ret(k))}">${pct(ret(k))}</td><td class="${tone((DT[k] || {}).vs_ew_pctp)}">${pp((DT[k] || {}).vs_ew_pctp, '%p')}</td><td class="${tone(vsBtc(k))}">${pct(vsBtc(k))}</td><td>${esc(state.data.nm[k].status)}</td></tr>`).join('')
      + `</table><div class="muted">원금·BTC 대비는 지금 시세로 다시 계산한 값, 균등 대비는 매일 09:00 정산 때 장부 값입니다(같은 대상 코인 50여 개를 똑같은 비중으로 들고 있었을 때).</div></div>`;
    const nmLv = R['NM-LS'] && R['LV-LS'] ? (ret('NM-LS') - ret('LV-LS')) * 100 : null;
    h += `<div class="card"><h2>핵심 질문: Numerai가 단순 순위보다 나은가</h2>` + kv([
      ['NM-LS − LV-LS (원금 대비)', pp(nmLv, '%p') + ' <span class="muted">지금 시세</span>'],
      ['쌓인 기록', (D.days_booked || 0) + '일 / 판단까지 ' + (D.judge_after_days || 84) + '일(12주)'],
      ['판단', D.judge_ready ? '판단 가능' : '12주 전에는 판단하지 않음']]) + `</div>`;
    let times = r.times, E = r.eq.map((e) => (e / cap - 1) * 100), Bt = r.btc.map((b) => (b - 1) * 100);
    if (r.older.length) { times = r.older.map((o) => o.t).concat(times); E = r.older.map((o) => o.ret * 100).concat(E); Bt = r.older.map((o) => o.btc * 100).concat(Bt); }
    const c = cut(times, [E, Bt]);
    h += `<div class="seg" data-act="nmtest">${tests.map((k) => `<button class="${t === k ? 'on' : ''}" data-v="${k}">${esc(k)}</button>`).join('')}</div>`;
    h += `<div class="card"><h2>${esc(t)} · ${esc(x.name)}</h2><div class="metrics">`
      + metric('지금 평가액', usd(v), pct(v / cap - 1) + ' 원금 대비', tone(v / cap - 1))
      + metric('BTC 보유 대비', pct((v / cap) / r.btc[n] - 1), 'BTC ' + pct(r.btc[n] - 1), tone((v / cap) / r.btc[n] - 1))
      + metric('상태', esc(x.status), '장부 정산 평가액 ' + usd(x.ledger_equity))
      + `</div><div class="muted">펀딩비(선물 보유 수수료)는 하루 한 번 정산 때 반영되어 화면 실시간 값에는 빠져 있습니다.</div></div>`;
    h += `<div class="card"><h2>누적 수익률 곡선 <small>원금 대비 %, 10분 단위</small></h2>${rangeSel()}`
      + chart(c.times, [{ name: t, values: c.arrs[0], color: '#2563eb', width: 2.2 }, { name: 'BTC 보유', values: c.arrs[1], color: '#f59e0b' }])
      + `<div class="muted">매일 09:00 KST에 보유 비중을 다시 정합니다. 10분 단위 이전 구간은 하루 한 점(장부 값). 균등 보유 비교는 위 표의 장부 값으로 봅니다.</div></div>`;
    const T = DT[t] || {}; const isLS = t !== 'NM-L';
    h += `<div class="card"><h2>시험 상세 <small>장부(09:00 정산) 기준</small></h2>` + kv([
      ['이름', esc(T.name || x.name)],
      ['장부 평가액', usd(T.equity_usdt) + ' · ' + pp(T.ret_pct)],
      [isLS ? '가격 손익 · 펀딩비 · 비용' : '가격 손익 · 비용', isLS ? pp(T.cum_gross_pct) + ' · ' + pp(T.cum_fund_pct) + ' · ' + pp(-T.cum_cost_pct) : pp(T.cum_gross_pct) + ' · ' + pp(-T.cum_cost_pct)],
      ['고점 대비 하락', pp(T.dd_pct)],
      isLS ? null : ['균등 보유 대비 상대 하락', pp(T.rel_dd_pct)],
      [isLS ? '매수 · 공매도 비중' : '매수 비중', isLS ? `${T.gross_long_pct}% (${T.n_long}개) · ${T.gross_short_pct}% (${T.n_short}개)` : `${T.gross_long_pct}% (${T.n_long}개)`],
      ['오늘 대상 코인 · 채워진 묶음', `${T.n_elig}개 · ${T.tranches_live}/5`],
      T.holdings_day ? ['비중 기준일', ks(T.holdings_day + 'T09:00') + ' KST'] : null]) + `</div>`;
    h += `<div class="card"><h2>지금 보유 (${C.fmtKst(r.lastBoundary)} 기준 비중)</h2><table><tr><th>코인</th><th>비중</th><th>시작가</th><th>현재가</th><th>기여</th></tr>`
      + r.holdings.map((q) => `<tr><td><b>${esc(q.coin)}</b> <span class="tag ${q.w < 0 ? 'short' : ''}">${q.w < 0 ? '공매도' : '매수'}</span></td><td>${(q.w * 100).toFixed(2)}%</td><td>${price(q.entry)}</td><td>${price(q.now)}</td><td class="${tone(q.contrib)}">${q.contrib == null ? '-' : (q.contrib * 100 >= 0 ? '+' : '') + (q.contrib * 100).toFixed(3) + '%p'}</td></tr>`).join('')
      + `</table><div class="muted">비중 = 자본 대비. 지금은 5개 묶음 중 일부만 채워져 있어 나머지는 현금입니다.</div></div>`;
    const sr = D.stop_rules || meta.stop_rules || {};
    h += `<div class="card"><h2>멈춤 규칙</h2>` + kv([
      ['롱숏 두 시험', `고점 대비 ${sr.ls_warn_dd_pct}% 경고 · ${sr.ls_stop_dd_pct}% 멈춤`],
      ['현물 매수(NM-L)', `균등 보유 대비 ${sr.l_rel_warn_pct}% 경고 · ${sr.l_rel_stop_pct}% 멈춤, 자체 하락 ${sr.l_abs_warn_pct}%는 경고만`]]
      .concat(tests.map((k) => [k + ' 상태', esc(state.data.nm[k].status)]))) + `</div>`;
    const lr = D.last_run || meta.last_run || {}; const sg = D.signal || meta.signal;
    h += `<div class="card"><h2>실행 상태</h2>` + kv([
      ['실행 주기', '하루 1번 · 09:00 KST 가격 기준 (09:15 무렵 실행)'],
      ['마지막 실행', esc(String(lr.at_kst || '-').slice(5)) + ' · ' + esc(lr.status || '') + (lr.msg ? ' · ' + esc(lr.msg) : '')],
      ['마지막 처리 경계', D.last_boundary_kst ? esc(String(D.last_boundary_kst).slice(5)) : '아직 없음'],
      sg ? ['사용한 Numerai 파일', `${sg.round}회차 · ${esc(String(sg.data_date).slice(5).replace('-', '/'))} 데이터 · ${esc(String(sg.published_kst).slice(5))} 공개`] : null,
      ['장부', (D.ledger && D.ledger.ok) || meta.ledger ? '정상 · ' + ((D.ledger && D.ledger.rows) || (meta.ledger || {}).rows) + '건' : '이상']]) + `</div>`;
    return h;
  }


  function trendView() {
    const tests = Object.keys(state.data.trend || {});
    if (!tests.length) return '<div class="card">자료 없음</div>';
    const meta = state.data.trend_meta || {}, D = meta.dash || {}, DT = D.tests || {};
    const t = state.trTest, x = state.data.trend[t], r = trendResult(t);
    if (!r) return '<div class="card">시세를 받는 중…</div>';
    const R = {}; tests.forEach((k) => { R[k] = trendResult(k); });
    const n = r.times.length - 1, cap = r.capital, v = r.eq[n];
    const ret = (k) => R[k].eq[R[k].eq.length - 1] / R[k].capital - 1;
    const vsBh = (k) => (1 + ret(k)) / R[k].btc[R[k].btc.length - 1] - 1;
    let h = `<div class="card"><h2>하루 추세 롱숏은 이런 시험입니다</h2><table><tr><th>시험</th><th>하는 일</th></tr>${tests.map((k) => `<tr><td><b>${esc(k)}</b><br><span class="muted">${esc(TR_SHORT[k] || '')}</span></td><td>${esc(TR_DESC[k] || '')}</td></tr>`).join('')}</table>`
      + `<div class="txt">두 시험 모두 ${ks(x.start_kst)} KST에 시작했고, 방향은 매일 09:00·21:00 KST 시세(다음 봉 시가)로 점검합니다. 루틴은 그 5분 뒤(09:05, 21:05)에 실행합니다. 시험마다 모의 원금은 ${won(cap)}입니다. 비교 선은 같은 12개 코인을 출렁임 역수 비중으로 사서 들고 있는 경우입니다.</div>`
      + `<div class="txt">이 장부는 앞으로의 기록을 쌓아 보는 관찰용입니다. 과거 시험에서 잘 나왔다고 해서 앞으로도 그럴지는 아직 모릅니다. 최소 6개월은 지켜본 뒤에 판단합니다.</div></div>`;
    h += `<div class="card"><h2>두 시험 성적</h2><table><tr><th>시험</th><th>원금 대비</th><th>단순 보유 대비</th><th>상태</th></tr>`
      + tests.map((k) => `<tr><td><b>${esc(k)}</b></td><td class="${tone(ret(k))}">${pct(ret(k))}</td><td class="${tone(vsBh(k))}">${pct(vsBh(k))}</td><td>${esc(state.data.trend[k].status || '관찰 중')}</td></tr>`).join('')
      + `</table><div class="muted">지금 시세로 다시 계산한 값입니다. 단순 보유는 같은 12개 코인을 사서 계속 들고 있는 경우입니다. 펀딩비는 12시간마다 정산될 때 반영되어, 화면의 실시간 값에는 아직 없을 수 있습니다.</div></div>`;
    let times = r.times, E = r.eq.map((e) => (e / cap - 1) * 100), Bt = r.btc.map((b) => (b - 1) * 100);
    if (r.older.length) { times = r.older.map((o) => o.t).concat(times); E = r.older.map((o) => o.ret * 100).concat(E); Bt = r.older.map((o) => o.btc * 100).concat(Bt); }
    const c = cut(times, [E, Bt]);
    h += `<div class="seg" data-act="trtest">${tests.map((k) => `<button class="${t === k ? 'on' : ''}" data-v="${k}">${esc(k)} · ${esc(TR_SHORT[k] || '')}</button>`).join('')}</div>`;
    h += `<div class="card"><h2>${esc(t)} · ${esc(x.name)}</h2><div class="metrics">`
      + metric('지금 평가액', won(v), pct(v / cap - 1) + ' 원금 대비', tone(v / cap - 1))
      + metric('단순 보유 대비', pct((v / cap) / r.btc[n] - 1), '단순 보유 ' + pct(r.btc[n] - 1), tone((v / cap) / r.btc[n] - 1))
      + metric('지금 규모', (x.scale != null ? (x.scale).toFixed(2) + '배' : '-'), '총노출 ' + (x.gross != null ? (x.gross * 100).toFixed(1) + '%' : '-'))
      + `</div><div class="muted">장부(마지막 점검 시점) 평가액 ${won(x.ledger_equity)}. 위 숫자는 같은 보유를 방금 받은 시세로 다시 평가한 값입니다. 모의 계산이며 실제 성과가 아닙니다.</div></div>`;
    h += `<div class="card"><h2>누적 수익률 곡선 <small>원금 대비 %, 10분 단위</small></h2>${rangeSel()}`
      + chart(c.times, [{ name: TR_SHORT[t] || t, values: c.arrs[0], color: '#2563eb', width: 2.2 }, { name: '동일위험 단순 보유', values: c.arrs[1], color: '#f59e0b' }])
      + `<div class="muted">방향 점검은 12시간마다, 코인 비중은 하루 한 번입니다. 10분 단위 이전 구간은 점검 시점 장부 값입니다.</div></div>`;
    const T = DT[t] || {};
    h += `<div class="card"><h2>시험 상세 <small>마지막 점검 장부 기준</small></h2>` + kv([
      ['이름', esc(T.name || x.name)],
      ['장부 평가액', won(T.equity_krw) + ' · ' + pp(T.ret_pct)],
      ['규모(출렁임 맞추기)', (T.scale != null ? Number(T.scale).toFixed(3) + '배 (상한 2배)' : '-')],
      ['총노출 · 매수 · 공매도', `${pp((T.gross || 0) * 100).replace('%','')}% · ${T.gross_long_pct}% (${T.n_long}개) · ${T.gross_short_pct}% (${T.n_short}개)`.replace('++','+')],
      ['누적 비용 · 펀딩비', pp(-T.cum_cost_pct) + ' · ' + pp(T.cum_fund_pct)],
      ['고점 대비 하락', pp(T.dd_pct)],
      T.holdings_boundary ? ['마지막 점검', ks(T.holdings_boundary) + ' KST'] : null]) + `</div>`;
    h += `<div class="card"><h2>지금 보유 (${C.fmtKst(r.lastBoundary)} 기준 비중)</h2><table><tr><th>코인</th><th>비중</th><th>시작가</th><th>현재가</th><th>기여</th></tr>`
      + r.holdings.map((q) => `<tr><td><b>${esc(q.coin)}</b> <span class="tag ${q.w < 0 ? 'short' : ''}">${q.w < 0 ? '공매도' : '매수'}</span></td><td>${(q.w * 100).toFixed(2)}%</td><td>${price(q.entry)}</td><td>${price(q.now)}</td><td class="${tone(q.contrib)}">${q.contrib == null ? '-' : (q.contrib * 100 >= 0 ? '+' : '') + (q.contrib * 100).toFixed(3) + '%p'}</td></tr>`).join('')
      + `</table><div class="muted">비중 = 모의 원금 대비. 지금은 시장이 한쪽으로 기울어 매수·공매도 개수가 비슷하지 않을 수 있습니다.</div></div>`;
    const lr = (D.last_run || meta.last_run || {});
    h += `<div class="card"><h2>실행 상태</h2>` + kv([
      ['실행 주기', '하루 2번 · 09:05, 21:05 KST (09:00·21:00 시가 기준)'],
      ['마지막 실행', esc(String(lr.at_kst || '-').slice(5)) + ' · ' + esc(lr.status || '')],
      ['마지막 처리 경계', meta.last_boundary_kst ? esc(String(meta.last_boundary_kst).replace('T', ' ').slice(5)) : '아직 없음'],
      ['장부', (meta.ledger && meta.ledger.ok) ? '정상 · ' + (meta.ledger.rows || 0) + '건' : '확인 필요']]) + `</div>`;
    return h;
  }


  /* ---------- DL-23: 10시 비교 (T25 09시 / 10시 순수 / 10시 AI) ---------- */
  const AI_BADGE = { ok: ['봇 의견 반영', ''], base_only: ['기본안 그대로', 'warn'], rejected_late: ['시한 초과 · 기본안 그대로', 'warn'] };
  function aiLogHtml() {
    const lg = state.aiLog;
    if (!lg || !(lg.days || []).length) return '<div class="muted">아직 봇 의견 기록이 없습니다. 첫 기록은 시범 첫날(11/28) 10시 전에 올라옵니다.</div>';
    const days = lg.days.slice().reverse();
    const one = (dd) => {
      const b = AI_BADGE[dd.status] || [esc(dd.status), 'warn'];
      const cs = Object.entries(dd.coins || {});
      const adj = cs.filter(([, e]) => e.m !== 1);
      const roles = dd.roles || {};
      const rl = ['QR', 'MI', 'SK'].map((r) => { const q = roles[r] || {}; const nm = { QR: '퀀트', MI: '마켓인텔', SK: '회의론자' }[r]; const st = r === 'SK' && q.needed === false ? '생략(조용한 날)' : q.valid ? '정상' + (q.received_kst ? ' ' + esc((String(q.received_kst).match(/\d\d:\d\d/) || [''])[0]) : '') : (q.late ? '지각' : '없음/무효'); return `${nm} ${st}`; }).join(' · ');
      let t = `<h3>${esc(dd.day)} <span class="tag ${b[1]}">${b[0]}</span> <span class="muted">봉인 ${esc(String(dd.sealed_kst || '').slice(11, 16))}${dd.seal_target_met ? '' : ' (09:55 넘김)'}</span></h3><div class="muted">${rl}${dd.status_reason ? '<br>' + esc(dd.status_reason) : ''}</div>`;
      if (!adj.length) return t + '<div class="muted">조정 없음 · 12개 코인 전부 기본안 그대로</div>';
      t += `<table><tr><th>코인</th><th>비중 기본→AI</th><th>배수</th><th>근거 · 출처</th><th>이후 24시간</th></tr>`
        + adj.map(([c, e]) => `<tr><td><b>${esc(c)}</b><br><span class="muted">${e.base_w < 0 ? '공매도' : '매수'}</span></td><td>${(e.base_w * 100).toFixed(2)}% → ${(e.ai_w * 100).toFixed(2)}%</td><td><b>${Number(e.m).toFixed(2)}</b></td><td>${esc(e.why || '')}<br><span class="muted">제안 ${esc((e.proposed_by || []).join(', ') || '-')}${(e.challenged_by || []).length ? ' · 반박 ' + esc(e.challenged_by.join(', ')) : ''} · 출처 ${esc((e.sources || []).join(', ') || '-')}</span></td><td>${e.ret24h_after == null ? '<span class="muted">대기</span>' : `<span class="${tone(e.ret24h_after)}">${pct(e.ret24h_after)}</span><br><span class="muted">효과 ${pp(e.effect_pctp, '%p')}</span>`}</td></tr>`).join('') + '</table>';
      const si = dd.source_index || {}; const used = [...new Set(adj.flatMap(([, e]) => e.sources || []))].filter((i) => si[i]);
      if (used.length) t += `<div class="muted">출처 ` + used.map((i) => `${esc(i)}: ${esc(si[i].title || '')} (${esc(si[i].src || '')})`).join(' · ') + `</div>`;
      return t + `<div class="muted">나머지 ${cs.length - adj.length}개 코인은 기본안 그대로.</div>`;
    };
    return days.slice(0, 5).map(one).join('') + (days.length > 5 ? `<details><summary>이전 기록 ${days.length - 5}일</summary>${days.slice(5).map(one).join('')}</details>` : '');
  }
  function aiBars(daily) {
    if (!daily || !daily.length) return '<div class="muted">끝난 날이 생기면 막대가 나타납니다(하루 = 10시~다음 날 10시).</div>';
    const W = 340, H = 120, L = 40, R = 8, T = 8, B = 20, n = daily.length;
    const mx = Math.max(0.05, ...daily.map((d) => Math.abs(d.diff_pp)));
    const bw = Math.min(26, (W - L - R) / n - 4), y0 = T + (H - T - B) / 2, sc = ((H - T - B) / 2) / mx;
    let s = `<svg viewBox="0 0 ${W} ${H}" class="chart"><line x1="${L}" x2="${W - R}" y1="${y0}" y2="${y0}" class="zero"/><text x="${L - 4}" y="${T + 8}" class="ax" text-anchor="end">+${mx.toFixed(2)}</text><text x="${L - 4}" y="${H - B}" class="ax" text-anchor="end">-${mx.toFixed(2)}</text>`;
    daily.forEach((d, i) => { const x = L + 6 + i * ((W - L - R) / n), h = d.diff_pp * sc; s += `<rect x="${x}" y="${h >= 0 ? y0 - h : y0}" width="${bw}" height="${Math.max(1, Math.abs(h))}" fill="${d.diff_pp >= 0 ? '#dc2626' : '#2563eb'}"/>` + (n <= 14 ? `<text x="${x + bw / 2}" y="${H - 6}" class="ax" text-anchor="middle">${esc(d.day.slice(5))}</text>` : ''); });
    return s + '</svg>';
  }
  function aiView() {
    const meta = state.data.ai_meta || {}, A = state.data.ai || {};
    let h = `<div class="card"><h2>10시 비교 · 봇 의견은 도움이 될까?</h2><div class="txt">같은 기본안(T25 신호)을 <b>10:00 KST 시가</b>에 잡는 장부 두 개를 나란히 둡니다. <b>10시 순수</b>는 기본안 그대로, <b>10시 AI</b>는 09:05에 퀀트 리서처·마켓 인텔·회의론자가 낸 의견으로 코인별 규모만 0~1.5배 조정합니다(방향은 못 바꿈). 시각·가격·비용이 같아서 두 장부의 차이가 곧 <b>봇 의견만의 효과</b>입니다. 기존 T25(09시 적용)는 참고로 그대로 둡니다. 21:00 방향 점검은 봇 없이 양쪽 모두 기본 규칙대로 합니다.</div>`
      + `<div class="note">시범 3일(11/28~11/30)은 호출·시한·사용량 점검용입니다. 6개월(일별 관측 180개) 전에는 낫다·못하다를 판단하지 않습니다. 모두 모의 계산이며 실제 성과가 아닙니다.</div></div>`;
    const rA = aiResult('T25-10A'), rP = aiResult('T25-10P'), rB = aiResult('BH10');
    if (!rA || !rP || !rB) {
      return h + `<div class="card"><h2>시작 전</h2><div class="txt">첫 체결은 ${esc(ks(meta.start_kst))} KST 입니다. 시작되면 이 화면에 세 장부가 나란히 나타납니다.</div></div><div class="card"><h2>봇 조정 기록 <small>공개</small></h2>${aiLogHtml()}</div>`;
    }
    const cap = rA.capital, n = rA.times.length - 1;
    const startMs = C.parseKst(meta.start_kst);
    const tr = trendResult('T25'), trS = (state.data.trend && state.data.trend.T25 && state.data.trend.T25.series) || [];
    // 시간축: 이전(장부 점) + 최근(10분 단위)
    const sA = A['T25-10A'].series || [], sP = A['T25-10P'].series || [], sB = A.BH10.series || [];
    const older = sA.map((r) => C.parseKst(r[0])).filter((t) => t < rA.times[0]);
    const times = older.concat(rA.times);
    const lv = (r, arr) => Object.fromEntries(r.times.map((t, i) => [t, arr[i]]));
    const mapA = lv(rA, rA.eq), mapP = lv(rP, rP.eq), mapB = lv(rB, rB.eq), mapT = tr ? lv(tr, tr.eq) : {};
    const retOf = (m, ser, T) => (m[T] != null ? m[T] / cap - 1 : C.stepAt(ser, T));
    const x0 = C.stepAt(trS, startMs);
    const tCap = tr ? tr.capital : cap;
    const ret = {
      A: times.map((T) => retOf(mapA, sA, T)), P: times.map((T) => retOf(mapP, sP, T)), B: times.map((T) => retOf(mapB, sB, T)),
      T: times.map((T) => (mapT[T] != null ? mapT[T] / tCap - 1 : C.stepAt(trS, T))),
    };
    const pc = (xs) => xs.map((x) => x * 100);
    const T25r = C.rebasePct(ret.T, x0);
    const c = cut(times, [pc(ret.A), pc(ret.P), pc(ret.B), T25r, C.diffPct(times.map((T) => (1 + (retOf(mapA, sA, T))) * cap), times.map((T) => (1 + (retOf(mapP, sP, T))) * cap), cap)]);
    const last = (xs) => xs[xs.length - 1];
    const dd = (xs) => C.maxDrawdown(xs.map((x) => 1 + x));
    const eqA = rA.eq[n], eqP = rP.eq[n], eqB = rB.eq[n];
    const xA = A['T25-10A'], xP = A['T25-10P'];
    const diffNow = (eqA - eqP) / cap * 100;
    const row = (name, sub, v, rr, ex) => `<tr><td><b>${name}</b><br><span class="muted">${sub}</span></td><td>${won(v)}</td><td class="${tone(rr)}">${pct(rr)}</td><td>${ex}</td></tr>`;
    h += `<div class="card"><h2>세 장부 · 지금 평가</h2><table><tr><th>장부</th><th>평가액</th><th>시작 이후</th><th>최대낙폭 · 규모</th></tr>`
      + row('10시 AI', '봇 의견 반영', eqA, eqA / cap - 1, `${pct(dd(ret.A))} · ${xA.scale != null ? Number(xA.gross).toFixed(2) + '배' : '-'}`)
      + row('10시 순수', '기본안 그대로', eqP, eqP / cap - 1, `${pct(dd(ret.P))} · ${xP.gross != null ? Number(xP.gross).toFixed(2) + '배' : '-'}`)
      + row('T25 (09시)', '참고 · 시작 시점부터 다시 센 값', tr ? cap * (1 + last(T25r) / 100) : null, last(T25r) / 100, tr ? '-' : '-')
      + row('단순 보유', '같은 12코인 · 10시 기준', eqB, eqB / cap - 1, pct(dd(ret.B)))
      + `</table><div class="muted">${esc(ks(meta.start_kst))} KST 시작 · 원금 각 ${won(cap)} · 지금 시세로 다시 평가한 값입니다.</div></div>`;
    h += `<div class="card"><h2>AI 의견만의 효과 <small>(같은 시각·같은 비용) · 10시 AI − 10시 순수</small></h2><div class="metrics">`
      + metric('누적 차이', pp(diffNow, '%p'), `${won(eqA - eqP)}`, tone(diffNow))
      + metric('조정한 날', String((meta.ops || []).filter((o) => Object.keys(o.adjusted || {}).length).length) + '일', `기록된 날 ${(meta.ops || []).length}일`)
      + metric('회전율 누적', `${xA.turnover_cum != null ? Number(xA.turnover_cum).toFixed(2) : '-'} vs ${xP.turnover_cum != null ? Number(xP.turnover_cum).toFixed(2) : '-'}`, 'AI vs 순수 (Σ|비중변화|)')
      + `</div>` + rangeSel()
      + chart(c.times, [{ name: 'AI − 순수 (%p)', values: c.arrs[4], color: '#dc2626', width: 2.2 }])
      + `<h3>하루 단위 차이 <small class="muted">%p · 10시~다음 날 10시</small></h3>${aiBars(meta.daily)}`
      + `<div class="muted">차이가 +이면 봇 의견이 도움이 된 날입니다. 하루 이틀 숫자로 판단하지 않습니다.</div></div>`;
    h += `<div class="card"><h2>누적 수익률 곡선 <small>시작 시점 대비 %, 10분 단위</small></h2>${rangeSel()}`
      + chart(c.times, [{ name: '10시 AI', values: c.arrs[0], color: '#dc2626', width: 2.4 }, { name: '10시 순수', values: c.arrs[1], color: '#2563eb', width: 2 },
        { name: 'T25 (09시, 참고)', values: c.arrs[3], color: '#6b7280', dash: true }, { name: '동일위험 단순 보유', values: c.arrs[2], color: '#f59e0b' }])
      + `<div class="muted">T25(09시)와 10시 순수의 차이는 "같은 포지션을 1시간 늦게 잡은 효과"입니다. 이전 구간은 점검 시점의 장부 값입니다.</div></div>`;
    h += `<div class="card"><h2>봇 조정 기록 <small>공개 · 암호화 없음</small></h2>${aiLogHtml()}<div class="muted">효과 = (배수−1) × 기본 비중 × 그 코인의 10시~다음 날 10시 수익률 (원금 대비 %p, 비용 제외 추정). 근거 한 줄과 출처는 봇이 입력 자료 안에서만 적습니다.</div></div>`;
    const hold = (xk, nm) => { const r = xk === 'A' ? rA : rP; return `<div class="card"><h2>${nm} 지금 보유 <small>(${C.fmtKst(r.lastBoundary)} 기준)</small></h2><table><tr><th>코인</th><th>비중</th><th>시작가</th><th>현재가</th><th>기여</th></tr>`
      + r.holdings.map((q) => `<tr><td><b>${esc(q.coin)}</b> <span class="tag ${q.w < 0 ? 'short' : ''}">${q.w < 0 ? '공매도' : '매수'}</span></td><td>${(q.w * 100).toFixed(2)}%</td><td>${price(q.entry)}</td><td>${price(q.now)}</td><td class="${tone(q.contrib)}">${q.contrib == null ? '-' : (q.contrib * 100 >= 0 ? '+' : '') + (q.contrib * 100).toFixed(3) + '%p'}</td></tr>`).join('') + '</table></div>'; };
    h += hold('A', '10시 AI') + hold('P', '10시 순수');
    const lr = meta.last_run || {};
    h += `<div class="card"><h2>실행 상태</h2>` + kv([
      ['체결 시각', '10:00 KST(봇 의견 반영) · 21:00 KST(방향 점검, 봇 없음)'],
      ['마지막 실행', esc(String(lr.at_kst || '-').slice(5)) + ' · ' + esc(lr.status || '')],
      ['장부', (meta.ledger && meta.ledger.ok) ? '정상 · ' + (meta.ledger.rows || 0) + '건' : '확인 필요']]) + `</div>`;
    return h;
  }

  function homeView() {
    let rows = '';
    const nowMs = state.fetchedAt;
    for (const [k, b] of Object.entries(state.data.a2 || {})) {
      const r = a2Result(k); const n = r.times.length - 1; const v = r.total.A2[n], ew = r.total.EW[n];
      const started = r.sleeves.filter((s) => s.started).length;
      const pend = (b.ledger_sleeves || []).some((ls) => pendingNote(ls, nowMs));
      const st = b.stop_rules && b.stop_rules.halted ? '<b class="down">멈춤</b>' : (b.stop_rules && (b.stop_rules.warnings || []).length ? '운용 중 · 경고' : '운용 중 · 슬리브 ' + started + '/4') + (pend ? '<br><span class="tag warn">기록 대기 있음</span>' : '');
      rows += `<tr data-go="${k}"><td><b>${esc(b.name)}</b><br><span class="muted">빗썸 16개 코인</span></td><td>${won(v)}</td><td class="${tone(v / r.capital - 1)}">${pct(v / r.capital - 1)}</td><td class="${tone(v / ew - 1)}">${pct(v / ew - 1)}<br><span class="muted">균등 대비</span></td><td>${st}</td></tr>`;
    }
    for (const [k, x] of Object.entries(state.data.nm || {})) {
      const r = nmResult(k); if (!r) continue; const n = r.times.length - 1; const v = r.eq[n];
      rows += `<tr data-go="nm" data-t="${k}"><td><b>${esc(k)}</b><br><span class="muted">${esc(NM_SHORT[k] || x.name)}</span></td><td>${usd(v)}</td><td class="${tone(v / r.capital - 1)}">${pct(v / r.capital - 1)}</td><td class="${tone((v / r.capital) / r.btc[n] - 1)}">${pct((v / r.capital) / r.btc[n] - 1)}<br><span class="muted">BTC 대비</span></td><td>${esc(x.status === '정상' ? '운용 중' : x.status)}</td></tr>`;
    }
    for (const [k, x] of Object.entries(state.data.trend || {})) {
      const r = trendResult(k); if (!r) continue; const n = r.times.length - 1; const v = r.eq[n];
      rows += `<tr data-go="trend" data-t="${k}"><td><b>${esc(k)}</b><br><span class="muted">${esc(TR_SHORT[k] || x.name)}</span></td><td>${won(v)}</td><td class="${tone(v / r.capital - 1)}">${pct(v / r.capital - 1)}</td><td class="${tone((v / r.capital) / r.btc[n] - 1)}">${pct((v / r.capital) / r.btc[n] - 1)}<br><span class="muted">단순 보유 대비</span></td><td>관찰 중</td></tr>`;
    }
    for (const [k, x] of Object.entries(state.data.ai || {})) {
      if (k === 'BH10') continue;
      const r = aiResult(k); if (!r) continue; const n = r.times.length - 1; const v = r.eq[n];
      const bh = aiResult('BH10');
      rows += `<tr data-go="ai"><td><b>${esc(k === 'T25-10A' ? '10시 AI' : '10시 순수')}</b><br><span class="muted">T25 신호 · 10시 적용${k === 'T25-10A' ? ' · 봇 의견' : ''}</span></td><td>${won(v)}</td><td class="${tone(v / r.capital - 1)}">${pct(v / r.capital - 1)}</td><td class="${tone(bh ? v / bh.eq[bh.eq.length - 1] - 1 : 0)}">${bh ? pct(v / bh.eq[bh.eq.length - 1] - 1) : '-'}<br><span class="muted">단순 보유 대비</span></td><td>시범 중</td></tr>`;
    }
    const a2b = Object.values(state.data.a2 || {})[0], meta = state.data.nm_meta || {}, tmeta = state.data.trend_meta || {};
    return `<div class="card"><h2>모든 시험 요약 · 지금 평가</h2><table><tr><th>시험</th><th>평가액</th><th>원금 대비</th><th>비교</th><th>상태</th></tr>${rows}</table><div class="muted">A2와 A2-W26은 빗썸 16개 코인 균등 보유와, Numerai 세 시험은 BTC 보유와, 하루 추세 두 시험은 같은 12개 코인 단순 보유와 비교합니다. 줄을 누르면 자세히 봅니다. 모두 모의 계산이며 실제 성과가 아닙니다.</div></div>`
      + `<div class="card"><h2>시작과 갱신</h2>` + kv([
        ['A2 · A2-W26', `11/22 18:00 KST 시작 · 장부는 하루 4번 갱신 · 마지막 ${a2b && a2b.last_run ? ks(a2b.last_run.run_kst) : '-'} KST`],
        ['Numerai 바이낸스', `${ks((Object.values(state.data.nm || {})[0] || {}).start_kst)} KST 시작 · 장부는 하루 1번 갱신 · 마지막 ${esc(String(meta.generated_kst || '-').slice(5))}`],
        Object.keys(state.data.trend || {}).length ? ['하루 추세 롱숏', `${ks((Object.values(state.data.trend || {})[0] || {}).start_kst)} KST 시작 · 장부는 하루 2번(09:05·21:05) 갱신 · 마지막 ${esc(String(tmeta.generated_kst || '-').slice(5))}`] : null,
        ['평가액·곡선', '이 화면을 열거나 새로고침을 누를 때 공개 시세로 바로 다시 계산 (열어 두면 10분마다 자동)'],
        ['판단 시점', '어느 시험이든 12주가 쌓이기 전에는 낫다·못하다를 판단하지 않습니다'],
        ['자료 파일', ks(state.data.generated_kst) + ' KST에 만듦']]) + `</div>`;
  }

  // ---- 상장폐지 사건 장부 (EV-A / EV-B / EV-AI) : event/evbook.json (평문 공개, 모의)
  function evView() {
    const E = state.ev;
    const won2 = (x) => (x == null ? '-' : Math.round(x).toLocaleString('ko-KR') + '원');
    const pc2 = (x) => (x == null ? '-' : (x >= 0 ? '+' : '') + Number(x).toFixed(2) + '%');
    const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
    let h = `<div class="card"><h2>상장폐지 공매도 · 세 장부 <small class="down">모의(실제 돈 아님)</small></h2><div class="txt">바이낸스가 어떤 코인을 <b>현물에서 상장폐지</b>한다고 공지하면, 15분마다 도는 PC 점검이 그 공지를 찾아 그 코인 선물을 모의로 공매도합니다. 세 장부는 같은 시각·같은 가격에 들어가고 나가는 규칙만 다릅니다.</div>`;
    if (!E) return h + `<div class="txt">아직 자료가 없습니다(event/evbook.json). PC 점검이 시작되면 나타납니다.</div></div>`;
    const R = (E.meta || {}).rules || {};
    h += `<table><tr><th>장부</th><th>규칙</th></tr>` + ['EV-A', 'EV-B', 'EV-AI', 'ALL', 'monitoring'].map((k) => `<tr><td><b>${esc(k === 'ALL' ? '공통' : k === 'monitoring' ? '모니터링' : k)}</b></td><td>${esc(R[k] || '')}</td></tr>`).join('') + `</table>`;
    h += `<div class="note">${esc((E.meta || {}).cost_note || '')} · ${esc((E.meta || {}).delist_time_note || '')} · 자료 ${esc((E.meta || {}).generated_kst || '-')} KST · 원금은 장부당 1,000만 원(원화는 표시 단위)</div></div>`;
    h += `<div class="card"><h2>장부 성적</h2><table><tr><th>장부</th><th>평가액</th><th>확정 손익</th><th>끝난 거래</th><th>보유 중</th></tr>` + Object.entries(E.books || {}).map(([k, b]) => `<tr><td><b>${esc(k)}</b></td><td>${won2(b.equity_krw)}</td><td class="${cls(b.realized_krw)}">${won2(b.realized_krw)}</td><td>${b.n_closed}</td><td>${b.n_open}</td></tr>`).join('') + `</table>`;
    const eq = (E.equity || []).slice(-400);
    if (eq.length > 1) {
      const W = 640, Hh = 140, ks = Object.keys(eq[0].eq), all = eq.flatMap((p) => ks.map((k) => p.eq[k])), lo = Math.min(...all), hi = Math.max(...all) || 1, sp = hi - lo || 1;
      const col = { 'EV-A': '#2a7', 'EV-B': '#27c', 'EV-AI': '#c52' };
      h += `<svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto">` + ks.map((k) => `<polyline fill="none" stroke="${col[k] || '#888'}" stroke-width="1.6" points="${eq.map((p, i) => `${(i / (eq.length - 1)) * (W - 10) + 5},${Hh - 8 - ((p.eq[k] - lo) / sp) * (Hh - 16)}`).join(' ')}"/>`).join('') + `</svg><div class="muted">${ks.map((k) => `<span style="color:${col[k]}">■</span> ${esc(k)}`).join(' &nbsp; ')} · ${esc(eq[0].t_kst)} ~ ${esc(eq[eq.length - 1].t_kst)} KST</div>`;
    }
    h += `</div>`;
    const op = E.open || [];
    h += `<div class="card"><h2>보유 중 (${op.length})</h2>` + (op.length ? `<table><tr><th>장부·코인</th><th>진입</th><th>진입가 → 현재</th><th>손익</th><th>최악 구간</th><th>나갈 때</th></tr>` + op.map((p) => `<tr><td><b>${esc(p.book)}</b> ${esc(p.sym)}${p.open_frac < 1 ? ` <span class="muted">(${Math.round(p.open_frac * 100)}%)</span>` : ''}</td><td>${esc(p.entry_kst)}<br><span class="muted">공지 후 ${esc(p.delay_min)}분</span></td><td>${price(p.entry_px)} → ${price(p.mark_px)}</td><td class="${cls(p.unreal_ret_pct)}">${pc2(p.unreal_ret_pct)}</td><td class="neg">+${esc(p.mae_pct ?? 0)}% 상승</td><td>${esc(p.exit_plan)}${p.settle_kst ? `<br><span class="muted">선물 정산 ${esc(p.settle_kst)}</span>` : ''}</td></tr>`).join('') + `</table>` : `<div class="txt">없음</div>`) + `</div>`;
    const rv = (E.reviews || []).slice().reverse().slice(0, 30);
    const KIND = { '4h_decision': '4시간 판단', periodic: '4시간마다 점검', urgent_rule_notice: '규칙 변경 긴급', ambiguous_notice: '애매한 공지' };
    const sg = (E.signals || []).slice().reverse();
    h += `<div class="card"><h2>경고 후보 기록 <small>거래에 안 씀</small></h2><div class="txt">공지 후 30분 미결제약정 증가(+60% 이상이면 상위 25%), 펀딩 1시간 주기 전환, 펀딩 하한 도달. 앞으로 쌓아서 효과가 있는지만 봅니다.</div>` + (sg.length ? `<table><tr><th>코인·공지</th><th>30분 미결제약정</th><th>1시간 주기 전환</th><th>펀딩 하한</th></tr>` + sg.map((g) => `<tr><td><b>${esc(g.sym)}</b><br><span class="muted">${esc(g.notice_kst)}</span></td><td>${g.oi30_growth == null ? '자료 없음' : (g.oi30_growth >= 0 ? '+' : '') + (g.oi30_growth * 100).toFixed(0) + '%' + (g.oi30_topq ? ' <b>(상위)</b>' : '')}</td><td>${esc(g.funding_1h_first_kst || '-')}</td><td>${esc(g.funding_floor_first_kst || '-')}</td></tr>`).join('') + `</table>` : `<div class="txt">아직 없음</div>`) + `</div>`;
    h += `<div class="card"><h2>AI 팀 판단 기록 <small>공개</small></h2><div class="txt">시한까지 판단이 오지 않으면 <b>청산</b>(=EV-A 규칙)합니다. AI는 보유·절반 청산·전량 청산·기권만 고를 수 있고, +30% 손절과 폐지 24시간 전 청산은 AI가 못 바꿉니다. 분류: HOLD 보유, VETO 줄이거나 청산, ABSTAIN 기권→청산, DEFAULT 무응답→청산, NO_REVIEW 요청 못 보냄→청산.</div>` + (rv.length ? `<table><tr><th>종류·대상</th><th>시한</th><th>결과</th><th>분류</th><th>이유</th></tr>` + rv.map((r) => `<tr><td>${esc(KIND[r.kind] || r.kind)}<br><span class="muted">${esc(r.pid || (r.notice_title || '').slice(0, 60))}</span></td><td>${esc(r.deadline_kst)}</td><td>${esc(r.decision ? r.decision.action : r.status)}</td><td>${esc(r.outcome_class || '')}</td><td>${esc(r.decision ? r.decision.reason : r.status === 'default_applied' ? '시한까지 판단 없음 → 청산' : '')}</td></tr>`).join('') + `</table>` : `<div class="txt">아직 없음</div>`) + `</div>`;
    const tr = (E.trades || []).slice().reverse().slice(0, 60);
    h += `<div class="card"><h2>끝난 거래 (최근 ${tr.length})</h2>` + (tr.length ? `<table><tr><th>장부·코인</th><th>기간(KST)</th><th>수익률</th><th>손익</th><th>최악 구간</th><th>나간 이유</th></tr>` + tr.map((t) => `<tr><td><b>${esc(t.book)}</b> ${esc(t.sym)}</td><td>${esc(t.entry_kst)}<br>→ ${esc(t.exit_kst)}</td><td class="${cls(t.ret_pct)}">${pc2(t.ret_pct)}</td><td class="${cls(t.pnl_krw)}">${won2(t.pnl_krw)}</td><td class="neg">+${esc(t.mae_pct ?? 0)}%</td><td>${esc(t.reason)}</td></tr>`).join('') + `</table>` : `<div class="txt">아직 없음</div>`) + `</div>`;
    const KN = { spot_delist: '현물 폐지', futures_delist: '선물 폐지', monitoring: '모니터링 지정', rule_change: '선물 규칙 변경', other: '기타(애매)' };
    const nt = (E.notices || []).slice().reverse().slice(0, 40);
    h += `<div class="card"><h2>바이낸스 공지와 분류 (최근 ${nt.length})</h2>` + (nt.length ? `<table><tr><th>게시(KST)</th><th>제목</th><th>분류</th><th>한 일</th></tr>` + nt.map((n) => `<tr><td>${esc(n.release_kst)}<br><span class="muted">발견 +${esc(n.detect_delay_min)}분</span></td><td>${esc(n.title)}</td><td>${esc(KN[n.kind] || n.kind)}${n.ambiguous ? ' <b>(AI 확인)</b>' : ''}</td><td>${esc(n.action)}</td></tr>`).join('') + `</table>` : `<div class="txt">아직 없음</div>`) + `</div>`;
    return h;
  }

  function render() {
    const d = state.data; if (!d) return;
    const tabs = [['home', '한눈에']].concat(Object.entries(d.a2 || {}).map(([k, b]) => [k, b.name])).concat(Object.keys(d.nm || {}).length ? [['nm', 'Numerai 바이낸스']] : []).concat(Object.keys(d.trend || {}).length ? [['trend', '하루 추세']] : []).concat(d.ai_meta ? [['ai', '10시 비교']] : []).concat([['ev', '상장폐지']]);
    $('#tabs').innerHTML = tabs.map(([v, l]) => `<button class="${state.tab === v ? 'on' : ''}" data-v="${v}">${esc(l)}</button>`).join('');
    const src = state.px && state.px.source === 'bithumb' ? '빗썸 원화 공개 시세 10분봉' : state.px && state.px.source === 'binance-ratio' ? '<b class="down">빗썸 접속 실패</b> → 바이낸스 달러 시세의 등락률로 추정' : '-';
    const a2b = Object.values(d.a2 || {})[0]; const lrA = a2b && a2b.last_run ? String(a2b.last_run.run_kst || '').replace('T', ' ').slice(5, 16) : '-'; const lrN = d.nm_meta ? String(d.nm_meta.generated_kst || '').slice(5, 16) : '-'; const lrT = d.trend_meta ? String(d.trend_meta.generated_kst || '').slice(5, 16) : '-';
    $('#meta').innerHTML = `시세 기준 <b>${C.fmtKst(state.fetchedAt)} KST</b> · 장부 A2 ${esc(lrA)} · Numerai ${esc(lrN)} · 하루 추세 ${esc(lrT)} KST<br>평가 시세: A2 계열 ${src}, Numerai·하루 추세 바이낸스 공개 시세` + (state.warn.length ? `<br><span class="down">${esc(state.warn.join(' / '))}</span>` : '');
    let h = '';
    if (state.tab === 'home') h = homeView(); else if (state.tab === 'nm') h = nmView(); else if (state.tab === 'trend') h = trendView(); else if (state.tab === 'ai') h = aiView(); else if (state.tab === 'ev') h = evView(); else h = a2View(state.tab);
    $('#main').innerHTML = h; bindCharts();
  }

  async function refresh() {
    const pass = state.pass; if (!pass) return;
    const btn = $('#refresh'); btn.disabled = true; btn.textContent = '받는 중…';
    try {
      state.data = await loadData(pass);
      state.warn = (state.data.problems || []).slice();
      const prog = (a, b, w) => { $('#prog').textContent = `${w} 시세 받는 중 ${a}/${b}`; };
      const [px, nmPx] = await Promise.all([fetchA2Prices(state.data, prog), fetchNmPrices(state.data, prog)]);
      state.px = px; state.nmPx = nmPx; state.fetchedAt = Date.now();
      try { const lr = await fetch('ai/log.json?t=' + Date.now(), { cache: 'no-store' }); state.aiLog = lr.ok ? await lr.json() : null; } catch (e) { state.aiLog = null; }
      try { const er = await fetch('event/evbook.json?t=' + Date.now(), { cache: 'no-store' }); state.ev = er.ok ? await er.json() : null; } catch (e) { state.ev = null; }
      if (nmPx.errs && nmPx.errs.length) state.warn.push('바이낸스 시세 못 받은 코인: ' + nmPx.errs.join(', '));
      $('#prog').textContent = '';
      render();
    } catch (e) {
      $('#prog').textContent = '오류: ' + (e.message || e);
    } finally { btn.disabled = false; btn.textContent = '새로고침'; }
  }

  async function unlock(pass, remember) {
    $('#lockmsg').textContent = '여는 중…';
    try {
      state.data = await loadData(pass); state.pass = pass;
      if (remember) localStorage.setItem(PASS_KEY, pass); else localStorage.removeItem(PASS_KEY);
      $('#lock').style.display = 'none'; $('#app').style.display = '';
      await refresh();
    } catch (e) {
      $('#lockmsg').textContent = e.name === 'OperationError' ? '비밀번호가 맞지 않습니다.' : '열지 못했습니다: ' + (e.message || e);
      localStorage.removeItem(PASS_KEY);
    }
  }

  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-v]');
    if (b) {
      const act = b.parentElement.dataset.act, v = b.dataset.v;
      if (b.parentElement.id === 'tabs') state.tab = v;
      else if (act === 'range') state.range = v;
      else if (act === 'a2view') state.a2View[b.parentElement.dataset.k] = v;
      else if (act === 'a2slot') state.a2Slot[b.parentElement.dataset.k] = v;
      else if (act === 'nmtest') state.nmTest = v;
      else if (act === 'trtest') state.trTest = v;
      render(); return;
    }
    const tr = ev.target.closest('tr[data-go]');
    if (tr) { state.tab = tr.dataset.go; if (tr.dataset.t) { if (tr.dataset.go === 'trend') state.trTest = tr.dataset.t; else state.nmTest = tr.dataset.t; } render(); window.scrollTo(0, 0); }
  });
  $('#refresh').addEventListener('click', refresh);
  $('#lockform').addEventListener('submit', (ev) => { ev.preventDefault(); unlock($('#pw').value.trim(), $('#remember').checked); });
  $('#logout').addEventListener('click', () => { localStorage.removeItem(PASS_KEY); location.reload(); });
  setInterval(() => { if (document.visibilityState === 'visible' && state.pass && Date.now() - (state.fetchedAt || 0) > 10 * 60000) refresh(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.pass && Date.now() - (state.fetchedAt || 0) > 10 * 60000) refresh(); });
  const saved = localStorage.getItem(PASS_KEY);
  if (saved) unlock(saved, true);
  window.__liveDash = state;   // for local testing
})();
