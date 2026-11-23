/* DL-13 live paper dashboard: fetch + render. PAPER ONLY: no orders, no keys, public prices only. */
(function () {
  'use strict';
  const C = window.LiveCore;
  const $ = (s) => document.querySelector(s);
  const PASS_KEY = 'aidesk_live_pass';
  const state = { data: null, tab: 'home', a2View: { A2: 'total', A2W26: 'total' }, nmTest: 'NM-LS', range: 'all', px: null, nmPx: null, fetchedAt: null, source: '', warn: [] };

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
    if (!Object.keys(nm).length) return {};
    const need = C.neededNmSymbols(nm);
    const from = Math.min(...Object.values(nm).map((t) => windowStart(t.start_kst, 7)));
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
  const metric = (label, value, detail, tn) => `<div class="metric"><div class="ml">${label}</div><div class="mv ${tn || ''}">${value}</div><div class="md">${detail || ''}</div></div>`;

  function a2View(key) {
    const b = state.data.a2[key], r = a2Result(key);
    if (!r) return '<div class="card">자료 없음</div>';
    const n = r.times.length - 1, cap = r.capital;
    const v = r.total.A2[n], b0 = r.total.B0[n], ew = r.total.EW[n];
    const view = state.a2View[key];
    let times = r.times, base = cap, A = r.total.A2, B0 = r.total.B0, EW = r.total.EW;
    if (view !== 'total') { const s = r.sleeves.find((x) => x.tranche === view); base = r.nav; A = s.series.A2; B0 = s.series.B0; EW = s.series.EW; }
    if (view === 'total' && r.older.length) { times = r.older.map((o) => o.t).concat(times); A = r.older.map((o) => o.A2).concat(A); B0 = r.older.map((o) => o.B0).concat(B0); EW = r.older.map((o) => o.EW).concat(EW); }
    const c = cut(times, [A, B0, EW]);
    const P = (arr) => arr.map((x) => (x / base - 1) * 100);
    let h = `<div class="card"><h2>${esc(b.name)} 합산 (모의 원금 ${won(cap)})</h2><div class="metrics">`
      + metric('지금 평가액', won(v), pct(v / cap - 1) + ' 원금 대비', tone(v / cap - 1))
      + metric('BTC·ETH 50/50 대비', pct(v / b0 - 1), '50/50 ' + won(b0), tone(v / b0 - 1))
      + metric('16개 균등 보유 대비', pct(v / ew - 1), '균등 ' + won(ew), tone(v / ew - 1))
      + metric('누적 매매 비용', won(r.sleeves.reduce((a, s) => a + (s.cost || 0), 0)), '매수·매도 각 0.04%')
      + `</div></div>`;
    h += `<div class="card"><h2>누적 수익률 곡선 <small>원금 대비 %, 10분 단위</small></h2>`
      + `<div class="seg small" data-act="a2view" data-k="${key}">${Object.entries(SLOT).map(([k2, l]) => `<button class="${view === k2 ? 'on' : ''}" data-v="${k2}">${l}</button>`).join('')}</div>${rangeSel()}`
      + chart(c.times, [{ name: b.name, values: P(c.arrs[0]), color: '#2563eb', width: 2.2 }, { name: '50/50', values: P(c.arrs[1]), color: '#f59e0b' }, { name: '균등', values: P(c.arrs[2]), color: '#94a3b8', dash: 1 }])
      + `<div class="muted">10분마다 한 점. 마지막 점은 방금 받은 시세. ${r.older.length ? '10분 단위 이전 구간은 리밸런스 시점 장부 값.' : ''}</div></div>`;
    h += `<div class="card"><h2>슬리브 4개</h2><table><tr><th>슬리브</th><th>평가액</th><th>원금 대비</th><th>상태</th></tr>`
      + r.sleeves.map((s) => { const x = s.series.A2[n]; return `<tr><td>${SLOT[s.tranche]}${s.unaudited ? '<span class="tag">추가 점검 전</span>' : ''}</td><td>${won(x)}</td><td class="${tone(x / r.nav - 1)}">${s.started ? pct(x / r.nav - 1) : '-'}</td><td>${s.started ? '운용 중 · 다음 교체 ' + (s.next ? C.fmtKst(s.next) : '-') : '대기 · ' + C.fmtKst(s.start) + ' 시작'}</td></tr>`; }).join('') + `</table></div>`;
    h += `<div class="card"><h2>지금 보유 코인</h2><table><tr><th>슬리브·코인</th><th>매수가</th><th>현재가</th><th>등락</th><th>평가액</th></tr>`;
    r.sleeves.forEach((s) => s.holdings.forEach((x) => { h += `<tr><td>${SLOT[s.tranche]} · <b>${esc(x.coin)}</b><br><span class="muted">${esc(x.role || '')} · ${C.fmtKst(x.since)} 매수</span></td><td>${price(x.entry)}</td><td>${price(x.now)}</td><td class="${tone(x.chg)}">${pct(x.chg)}</td><td>${won(x.value)}</td></tr>`; }));
    h += `</table></div>`;
    const checks = r.sleeves.filter((s) => s.check);
    h += `<div class="card"><h2>장부 대조 <small>마지막 리밸런스 시점</small></h2><table><tr><th>슬리브</th><th>시점</th><th>장부 값</th><th>화면 계산</th><th>차이</th></tr>`
      + checks.map((s) => { const k = s.check; const diff = k.fetched == null ? null : k.fetched - k.engine; return `<tr><td>${SLOT[s.tranche]}</td><td>${C.fmtKst(k.t)}</td><td>${won(k.engine)}</td><td>${k.fetched == null ? '시세 없음' : won(k.fetched)}</td><td>${diff == null ? '-' : won(diff)}</td></tr>`; }).join('')
      + `</table><div class="muted">장부 값 = 자동 실행이 기록한 평가액. 화면 계산 = 장부의 보유 수량 × 방금 받은 빗썸 10분봉 시가. 같으면 0원.</div></div>`;
    const lr = b.last_run || {};
    h += `<div class="card"><h2>장부 상태</h2><div class="kv"><div>마지막 자동 실행</div><div>${esc((lr.run_kst || '').replace('T', ' ').slice(5, 16))} KST · ${lr.rc === 0 ? '정상' : '결과 코드 ' + esc(lr.rc)}</div><div>장부</div><div>${b.ledger.events}건 · 해시 체인 ${b.ledger.chain_ok ? '정상' : '<b class="down">이상</b>'}</div><div>멈춤 규칙</div><div>${b.stop_rules && b.stop_rules.halted ? '<b class="down">멈춤</b>' : '정상'} (균등 대비 낙폭 −20% 경고, −36% 멈춤)</div></div></div>`;
    return h;
  }

  function nmView() {
    const tests = Object.keys(state.data.nm || {});
    if (!tests.length) return '<div class="card">자료 없음</div>';
    const t = state.nmTest, x = state.data.nm[t], r = nmResult(t);
    if (!r) return '<div class="card">시세를 받는 중…</div>';
    const n = r.times.length - 1, cap = r.capital, v = r.eq[n];
    let times = r.times, E = r.eq.map((e) => (e / cap - 1) * 100), Bt = r.btc.map((b) => (b - 1) * 100);
    if (r.older.length) { times = r.older.map((o) => o.t).concat(times); E = r.older.map((o) => o.ret * 100).concat(E); Bt = r.older.map((o) => o.btc * 100).concat(Bt); }
    const c = cut(times, [E, Bt]);
    let h = `<div class="seg" data-act="nmtest">${tests.map((k) => `<button class="${t === k ? 'on' : ''}" data-v="${k}">${esc(k)}</button>`).join('')}</div>`;
    h += `<div class="card"><h2>${esc(t)} · ${esc(x.name)} (모의 원금 ${usd(cap)})</h2><div class="metrics">`
      + metric('지금 평가액', usd(v), pct(v / cap - 1) + ' 원금 대비', tone(v / cap - 1))
      + metric('BTC 보유 대비', pct((v / cap) / r.btc[n] - 1), 'BTC ' + pct(r.btc[n] - 1), tone((v / cap) / r.btc[n] - 1))
      + metric('상태', esc(x.status), '장부 정산 평가액 ' + usd(x.ledger_equity))
      + `</div><div class="muted">펀딩비(선물 보유 수수료)는 하루 한 번 정산 때 반영되어 화면 실시간 값에는 빠져 있습니다.</div></div>`;
    h += `<div class="card"><h2>누적 수익률 곡선 <small>원금 대비 %, 10분 단위</small></h2>${rangeSel()}`
      + chart(c.times, [{ name: t, values: c.arrs[0], color: '#2563eb', width: 2.2 }, { name: 'BTC 보유', values: c.arrs[1], color: '#f59e0b' }])
      + `<div class="muted">매일 09:00 KST에 보유 비중을 다시 정합니다. 10분 단위 이전 구간은 하루 한 점(장부 값).</div></div>`;
    h += `<div class="card"><h2>지금 보유 (${C.fmtKst(r.lastBoundary)} 기준 비중)</h2><table><tr><th>코인</th><th>비중</th><th>시작가</th><th>현재가</th><th>기여</th></tr>`
      + r.holdings.map((q) => `<tr><td><b>${esc(q.coin)}</b> <span class="tag ${q.w < 0 ? 'short' : ''}">${q.w < 0 ? '공매도' : '매수'}</span></td><td>${(q.w * 100).toFixed(2)}%</td><td>${price(q.entry)}</td><td>${price(q.now)}</td><td class="${tone(q.contrib)}">${q.contrib == null ? '-' : (q.contrib * 100 >= 0 ? '+' : '') + (q.contrib * 100).toFixed(3) + '%p'}</td></tr>`).join('')
      + `</table><div class="muted">비중 = 자본 대비. 지금은 5개 묶음 중 일부만 채워져 있어 나머지는 현금입니다.</div></div>`;
    return h;
  }

  function homeView() {
    let rows = '';
    for (const [k, b] of Object.entries(state.data.a2 || {})) {
      const r = a2Result(k); const v = r.total.A2[r.times.length - 1], ew = r.total.EW[r.times.length - 1];
      rows += `<tr data-go="${k}"><td><b>${esc(b.name)}</b><br><span class="muted">빗썸 16개 코인</span></td><td>${won(v)}</td><td class="${tone(v / r.capital - 1)}">${pct(v / r.capital - 1)}</td><td class="${tone(v / ew - 1)}">${pct(v / ew - 1)}</td></tr>`;
    }
    for (const [k, x] of Object.entries(state.data.nm || {})) {
      const r = nmResult(k); if (!r) continue; const v = r.eq[r.times.length - 1];
      rows += `<tr data-go="nm" data-t="${k}"><td><b>${esc(k)}</b><br><span class="muted">${esc(x.name)}</span></td><td>${usd(v)}</td><td class="${tone(v / r.capital - 1)}">${pct(v / r.capital - 1)}</td><td class="${tone((v / r.capital) / r.btc[r.times.length - 1] - 1)}">${pct((v / r.capital) / r.btc[r.times.length - 1] - 1)}<br><span class="muted">BTC 대비</span></td></tr>`;
    }
    return `<div class="card"><h2>모든 시험 · 지금 평가</h2><table><tr><th>시험</th><th>평가액</th><th>원금 대비</th><th>비교 대비</th></tr>${rows}</table><div class="muted">A2 계열의 비교 대상은 16개 균등 보유, Numerai는 BTC 보유. 줄을 누르면 자세히 봅니다.</div></div>`
      + `<div class="card"><h2>숫자가 바뀌는 방식</h2><div class="kv"><div>평가액·곡선</div><div>이 화면을 열거나 새로고침을 누를 때 공개 시세로 바로 다시 계산 (열어 두면 10분마다 자동)</div><div>보유 코인</div><div>자동 실행이 장부를 갱신할 때 바뀜 (A2 하루 4번, Numerai 하루 1번)</div><div>자료 파일</div><div>${esc(String(state.data.generated_kst).replace('T', ' ').slice(5, 16))} KST에 만듦</div></div></div>`;
  }

  function render() {
    const d = state.data; if (!d) return;
    const tabs = [['home', '한눈에']].concat(Object.entries(d.a2 || {}).map(([k, b]) => [k, b.name])).concat(Object.keys(d.nm || {}).length ? [['nm', 'Numerai 바이낸스']] : []);
    $('#tabs').innerHTML = tabs.map(([v, l]) => `<button class="${state.tab === v ? 'on' : ''}" data-v="${v}">${esc(l)}</button>`).join('');
    const src = state.px && state.px.source === 'bithumb' ? '빗썸 원화 공개 시세 10분봉' : state.px && state.px.source === 'binance-ratio' ? '<b class="down">빗썸 접속 실패</b> → 바이낸스 달러 시세의 등락률로 추정' : '-';
    const a2b = Object.values(d.a2 || {})[0]; const lrA = a2b && a2b.last_run ? String(a2b.last_run.run_kst || '').replace('T', ' ').slice(5, 16) : '-'; const lrN = d.nm_meta ? String(d.nm_meta.generated_kst || '').slice(5, 16) : '-';
    $('#meta').innerHTML = `시세 기준 <b>${C.fmtKst(state.fetchedAt)} KST</b> · 장부 A2 ${esc(lrA)} · Numerai ${esc(lrN)} KST<br>평가 시세: A2 계열 ${src}, Numerai 바이낸스 공개 시세` + (state.warn.length ? `<br><span class="down">${esc(state.warn.join(' / '))}</span>` : '');
    let h = '';
    if (state.tab === 'home') h = homeView(); else if (state.tab === 'nm') h = nmView(); else h = a2View(state.tab);
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
      else if (act === 'nmtest') state.nmTest = v;
      render(); return;
    }
    const tr = ev.target.closest('tr[data-go]');
    if (tr) { state.tab = tr.dataset.go; if (tr.dataset.t) state.nmTest = tr.dataset.t; render(); window.scrollTo(0, 0); }
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
