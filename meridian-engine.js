/**
 * Meridian — computation engine
 * ===========================================================================
 * Every pure computation behind the app: technicals, RS Rating, the Composite
 * Fundamental Score, Market Breadth, the synthetic sectoral indices, and the
 * five-gate Golden Breakout model.
 *
 * Extracted from meridian.jsx so the production compute job (§6.2) can import
 * these *directly* rather than keeping a second copy. That was the explicit
 * requirement — "reuses Meridian's existing, already-validated JS functions
 * directly and unmodified" — and a copy would recreate exactly the
 * dual-codebase drift risk §7.2 rejected.
 *
 * Nothing here touches React, the DOM, or window.storage. It operates on plain
 * arrays and returns plain objects, so it runs unchanged in Node and in the
 * browser. Keep it that way: anything needing a browser API belongs in
 * meridian.jsx, anything needing a database belongs in the pipeline.
 */

// ---------- Computation engine ----------
export function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

// ---------- Sectoral: synthetic equal-weighted price index per Industry Name ----------
// Derived entirely from stock data already loaded — not a separate upload. Builds a
// real, date-aligned synthetic price series per sector (not just a ranking, unlike the
// earlier sector-RS-only version), so it can run through the full technical engine —
// same MAs, same golden cross, same everything — exactly like a real instrument would.
//
// Grouped on the GRANULAR field (`Sector`, Trendlyne's 127-category "Industry Name"),
// per an explicit 2026-09-06 decision that superseded the earlier choice of the broader
// 29-category field. The thin-group risk that motivated the original choice is real and
// measured — at 2,165 stocks, 6 categories have under 3 constituents — but it is handled
// by the minimum-constituents guard below rather than by coarsening the whole taxonomy.
export function computeSectoralSeries(masterList, prices) {
  const priceByISIN = {};
  prices.forEach((r) => { (priceByISIN[r.ISIN] ||= []).push(r); });
  const allDates = Array.from(new Set(prices.map((r) => r.Date))).sort();

  const bySector = {};
  masterList.forEach((m) => {
    const g = m.Sector;
    const rows = priceByISIN[m.ISIN];
    if (!g || !rows || !rows.length) return;
    const byDate = {};
    rows.forEach((r) => { byDate[r.Date] = r.Close; });
    (bySector[g] ||= []).push(byDate);
  });

  const result = {}; // { sectorName: [{ISIN, Date, Close, Volume}, ...] }
  Object.entries(bySector).forEach(([sector, stockDateMaps]) => {
    if (stockDateMaps.length < 3) return; // too thin a sample to form a meaningful synthetic index
    let level = 100;
    const lastKnown = new Array(stockDateMaps.length).fill(null);
    const synthetic = [];
    allDates.forEach((date) => {
      const rets = [];
      stockDateMaps.forEach((byDate, idx) => {
        const c = byDate[date];
        if (c != null) {
          if (lastKnown[idx] != null && lastKnown[idx] !== 0) rets.push(c / lastKnown[idx]);
          lastKnown[idx] = c;
        }
      });
      if (rets.length) {
        level = level * avg(rets);
        synthetic.push({ ISIN: sector, Date: date, Close: level, Volume: 1000000 });
      }
    });
    result[sector] = synthetic;
  });
  return result;
}

export function flagFor(lastYr, avg3, invert = false) {
  if (lastYr == null || avg3 == null || avg3 === 0) return { flag: "neutral", variationPct: null };
  const variationPct = ((lastYr - avg3) / Math.abs(avg3)) * 100;
  let flag = "neutral";
  if (Math.abs(variationPct) >= 3) {
    const better = invert ? lastYr < avg3 : lastYr > avg3;
    flag = better ? "improvement" : "deterioration";
  }
  return { flag, variationPct };
}

export function computeFundamentalBlock(fundRows) {
  const rows = [...fundRows].sort((a, b) => a.FY.localeCompare(b.FY));
  const last4 = rows.slice(-4);
  const last3 = rows.slice(-3);
  if (last3.length < 1) return null;

  // ROE/ROCE/Debt-Equity arrive PRE-COMPUTED from the fundamentals source (not derived
  // from NetProfit/Equity/EBIT/CapitalEmployed, which the source doesn't provide) — read
  // them directly. Only Sales, EPS, FixedAssets, CWIP are raw line items here.
  const roeSeries = last3.map((r) => r.ROE_Pct).filter((v) => v != null);
  const roceSeries = last3.map((r) => r.ROCE_Pct).filter((v) => v != null);
  const deSeries = last3.map((r) => r.DebtEquity).filter((v) => v != null);
  const atSeries = last3.map((r) => (r.FixedAssets ? r.Sales / r.FixedAssets : null)).filter((v) => v != null);

  const growth = (key) => {
    const g = [];
    for (let i = 1; i < last4.length; i++) {
      const prev = last4[i - 1][key], cur = last4[i][key];
      if (prev) g.push(((cur - prev) / Math.abs(prev)) * 100);
    }
    return g;
  };
  const epsG = growth("EPS");
  const salesG = growth("Sales");

  const latest = last4[last4.length - 1];

  const build = (series, growthSeries, invert = false) => {
    const useSeries = growthSeries || series;
    const a3 = avg(useSeries.slice(0, useSeries.length));
    const lastVal = useSeries.length ? useSeries[useSeries.length - 1] : null;
    const { flag, variationPct } = flagFor(lastVal, a3, invert);
    return { avg3: a3, lastYr: lastVal, variationPct, flag };
  };

  return {
    roe: build(roeSeries),
    roce: build(roceSeries),
    epsGrowth: build(null, epsG),
    salesGrowth: build(null, salesG),
    debtEquity: build(deSeries, null, true),
    assetTurns: build(atSeries),
    cwipPct: latest && latest.FixedAssets ? (latest.CWIP / latest.FixedAssets) * 100 : null,
    latestFY: latest ? latest.FY : null,
    epsLatest: latest && latest.EPS != null ? latest.EPS : null,
  };
}

// ---------- Composite Fundamental Score (population-wide, 7-factor quality model) ----------
// Industry Name categories exempted from Fixed Assets / CWIP / D-E scoring (their weight
// redistributes to ROE + EPS growth instead) — verified against the real Company Master
// data, not guessed. Deliberately excludes "Warehousing & Logistics", which a naive
// substring match on "housing" would wrongly catch.
export const FINANCIAL_INDUSTRIES = new Set([
  "Banks", "Finance (including NBFCs)", "Housing Finance", "Microfinance Institutions",
  "Financial Institutions", "Asset Management Cos.", "Capital Markets", "Investment Companies",
  "General Insurance", "Life Insurance", "Other Financial Services",
  // Added 2026-09-06. Holds Bajaj Finserv, Aditya Birla Capital, Cholamandalam Financial
  // Holdings, JM Financial, Tata Investment Corp — financial firms that were being scored
  // on D/E like operating companies (Chola Financial Holdings, D/E 13.61, was taking the
  // full -20 penalty). Also removes an inconsistency: "Investment Companies" was already
  // exempt while its near-identical sibling category was not.
  "Holding Companies",
]);

// Rank-based percentile, 0 (worst) to 100 (best). `invert` flips direction for metrics
// where lower is better (Debt/Equity).
export function percentileRank0to100(pairs, invert = false) {
  const sorted = [...pairs].sort((a, b) => a[1] - b[1]); // ascending by value
  const n = sorted.length;
  const map = {};
  sorted.forEach(([id], i) => {
    let p = n > 1 ? (i / (n - 1)) * 100 : 100;
    if (invert) p = 100 - p;
    map[id] = p;
  });
  return map;
}

// stocks: array of { ISIN, Sector, fund } — Sector here holds Industry Name (per the
// earlier decision to classify by the 127-category field). Returns { [ISIN]: {score, tier, exempt} }.
export function computeFundamentalScores(stocks) {
  const collect = { roce: [], roe: [], epsG: [], salesG: [], de: [], assetTurn: [], capex: [] };
  stocks.forEach((s) => {
    const f = s.fund;
    if (!f) return;
    if (f.roce?.avg3 != null) collect.roce.push([s.ISIN, f.roce.avg3]);
    if (f.roe?.avg3 != null) collect.roe.push([s.ISIN, f.roe.avg3]);
    if (f.epsGrowth?.avg3 != null) collect.epsG.push([s.ISIN, f.epsGrowth.avg3]);
    if (f.salesGrowth?.avg3 != null) collect.salesG.push([s.ISIN, f.salesGrowth.avg3]);
    if (f.debtEquity?.lastYr != null) collect.de.push([s.ISIN, f.debtEquity.lastYr]);
    if (f.assetTurns?.lastYr != null) collect.assetTurn.push([s.ISIN, f.assetTurns.lastYr]);
    if (f.cwipPct != null) collect.capex.push([s.ISIN, f.cwipPct]);
  });

  const pct = {
    roce: percentileRank0to100(collect.roce),
    roe: percentileRank0to100(collect.roe),
    epsG: percentileRank0to100(collect.epsG),
    salesG: percentileRank0to100(collect.salesG),
    de: percentileRank0to100(collect.de, true), // inverted: lower D/E is better
    assetTurn: percentileRank0to100(collect.assetTurn),
    capex: percentileRank0to100(collect.capex),
  };

  const rawResults = [];
  stocks.forEach((s) => {
    const f = s.fund;
    if (!f) { rawResults.push([s.ISIN, null, false]); return; }
    const exempt = FINANCIAL_INDUSTRIES.has(s.Sector);
    let score = 0, usedWeight = 0;
    const add = (p, w) => { if (p != null) { score += p * w; usedWeight += w; } };

    if (exempt) {
      // Fixed Assets / CWIP / D-E dropped; their combined 35% weight redistributes to
      // ROE and EPS growth (15%+17.5% each), matching the original pillar design.
      add(pct.roce[s.ISIN], 0.20);
      add(pct.roe[s.ISIN], 0.325);
      add(pct.epsG[s.ISIN], 0.325);
      add(pct.salesG[s.ISIN], 0.15);
    } else {
      add(pct.roce[s.ISIN], 0.20);
      add(pct.roe[s.ISIN], 0.15);
      add(pct.epsG[s.ISIN], 0.15);
      add(pct.salesG[s.ISIN], 0.15);
      add(pct.de[s.ISIN], 0.20);
      add(pct.assetTurn[s.ISIN], 0.10);
      add(pct.capex[s.ISIN], 0.05);
    }
    if (usedWeight === 0) { rawResults.push([s.ISIN, null, exempt]); return; }
    let finalScore = score / usedWeight; // normalize over whatever metrics were actually available

    // Hard penalty overrides
    if (!exempt && f.debtEquity?.lastYr != null && f.debtEquity.lastYr > 2.0) finalScore -= 20;
    if (f.epsGrowth?.avg3 != null && f.epsGrowth.avg3 < 0) finalScore = Math.min(finalScore, 40);
    finalScore = Math.max(0, Math.min(100, finalScore));

    rawResults.push([s.ISIN, finalScore, exempt]);
  });

  // Quintile tiers assigned by population rank, not fixed score thresholds — guarantees
  // exactly 20% per bucket regardless of how the scores are distributed.
  const scored = rawResults.filter(([, score]) => score != null).sort((a, b) => b[1] - a[1]);
  const n = scored.length;
  const tierOf = (rankFrac) => {
    if (rankFrac < 0.2) return "High";
    if (rankFrac < 0.4) return "Good";
    if (rankFrac < 0.6) return "Average";
    if (rankFrac < 0.8) return "Weak";
    return "Poor";
  };

  const out = {};
  const rankByIsin = {};
  scored.forEach(([isin], i) => { rankByIsin[isin] = i; });
  rawResults.forEach(([isin, score, exempt]) => {
    if (score == null) { out[isin] = { score: null, tier: null, exempt }; return; }
    out[isin] = { score, tier: tierOf(rankByIsin[isin] / n), exempt };
  });
  return out;
}


// Full rolling-window SMA series (one value per day, null until enough history exists).
// O(len) via a running sum — used both for today's MA value and for walking the
// signal's history backward to compute streaks.
export function rollingSMASeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < n) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= n) sum -= closes[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// Walks a per-day true/false series backward from the latest day, counting how many
// consecutive days match today's state — resets to 1 the moment the state flips.
// `capped` means the walk hit the lookback limit or ran out of price history before
// finding a flip, so the true streak may be longer than shown.
// Two moving averages are mathematically EQUAL whenever price is flat across
// both windows — and then a bare `a > b` is decided by floating-point summation
// noise rather than by the market. Found by cross-checking against the Python
// backtest: for one stock in a flat patch this sum came out 1.7e-13 above zero
// in JS and exactly zero in pandas, so the two implementations disagreed on the
// golden-cross state and their freshness streaks diverged 195 days vs 4 — which
// is gate #4 of the model, not a cosmetic difference.
//
// The tolerance is relative, and enormous compared to the ~1e-15 relative noise
// while being far below anything economically meaningful (gate #3 alone demands
// 3% separation). A tie therefore resolves to "not above", consistently and in
// both languages.
export const MA_TIE_EPSILON = 1e-9;

export function maAbove(a, b) {
  if (a == null || b == null) return null;
  return a - b > Math.abs(b) * MA_TIE_EPSILON;
}

export function streakFromStateSeries(stateSeries, maxLookback = 750) {
  const len = stateSeries.length;
  if (len === 0) return { value: null, streak: null, capped: false };
  const current = stateSeries[len - 1];
  if (current == null) return { value: null, streak: null, capped: false };
  let streak = 1, capped = false;
  for (let steps = 1; steps <= maxLookback; steps++) {
    const i = len - 1 - steps;
    if (i < 0) { capped = true; break; }
    const s = stateSeries[i];
    if (s == null) { capped = true; break; }
    if (s === current) streak++; else break;
    if (steps === maxLookback) capped = true;
  }
  return { value: current, streak, capped };
}

export function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeTechnicalBlock(priceRows) {
  const rows = [...priceRows].sort((a, b) => a.Date.localeCompare(b.Date));
  if (!rows.length) return null;
  const closes = rows.map((r) => r.Close);
  const latest = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;

  const changeAbs = prev ? latest.Close - prev.Close : null;
  const changePct = prev ? (changeAbs / prev.Close) * 100 : null;

  const window52w = rows.slice(-252);
  const high52 = Math.max(...window52w.map((r) => r.Close));
  const low52 = Math.min(...window52w.map((r) => r.Close));

  const vol30 = avg(rows.slice(-30).map((r) => r.Volume));

  const maPeriods = [3, 8, 30, 50, 100, 200];
  const maSeries = {};
  maPeriods.forEach((n) => { maSeries[n] = rollingSMASeries(closes, n); });
  const mas = {};
  maPeriods.forEach((n) => { mas[n] = maSeries[n][maSeries[n].length - 1]; });

  // Per-day state series (true/false/null) for every S and M signal, then the current
  // value + streak from each — same reset-on-reversal logic as RS Rating's streak.
  const sStateSeries = {};
  maPeriods.forEach((n) => {
    sStateSeries[n] = closes.map((c, i) => (maSeries[n][i] != null ? c > maSeries[n][i] : null));
  });
  const mPairs = { 3: [3, 8], 8: [8, 30], 30: [30, 100], 100: [100, 200] };
  const mStateSeries = {};
  Object.entries(mPairs).forEach(([key, [a, b]]) => {
    mStateSeries[key] = closes.map((_, i) => maAbove(maSeries[a][i], maSeries[b][i]));
  });

  const sSignals = {}, sStreaks = {};
  maPeriods.forEach((n) => {
    const { value, streak, capped } = streakFromStateSeries(sStateSeries[n]);
    sSignals[n] = value; sStreaks[n] = { streak, capped };
  });
  const mSignals = {}, mStreaks = {};
  Object.keys(mPairs).forEach((key) => {
    const { value, streak, capped } = streakFromStateSeries(mStateSeries[key]);
    mSignals[key] = value; mStreaks[key] = { streak, capped };
  });

  const rsi = computeRSI(closes, 14);

  const pctFromHigh52 = high52 ? (latest.Close / high52 - 1) * 100 : null;
  const pctFromLow52 = low52 ? (latest.Close / low52 - 1) * 100 : null;
  const cmpOverLow52 = low52 ? latest.Close / low52 : null;
  // Volume breakout: today's volume vs its own trailing 30-day average, as a percentage.
  // >100% means today traded above its recent normal volume — the more it exceeds
  // 100%, the more a price move today is backed by unusually heavy participation.
  const volBreakoutPct = vol30 ? (latest.Volume / vol30) * 100 : null;

  // 200DMA slope: is the long moving average itself rising, not just "is price above it".
  // A stock above a DECLINING 200DMA is often a dead-cat bounce, not a real Stage-2 uptrend.
  const ma200Series = maSeries[200];
  const SLOPE_LOOKBACK = 20;
  let ma200SlopePct = null, ma200Rising = null;
  if (ma200Series.length > SLOPE_LOOKBACK) {
    const nowMA = ma200Series[ma200Series.length - 1];
    const pastMA = ma200Series[ma200Series.length - 1 - SLOPE_LOOKBACK];
    if (nowMA != null && pastMA != null && pastMA !== 0) {
      ma200SlopePct = ((nowMA - pastMA) / Math.abs(pastMA)) * 100;
      ma200Rising = ma200SlopePct > 0;
    }
  }

  // Volatility contraction: trading range over a short recent window as a % of price.
  // Tighter (lower) = a coiled consolidation, which research shows breaks out more
  // reliably than a breakout from wide, choppy price action. Uses High/Low when the
  // price feed provides them (more accurate true range); falls back to Close-only
  // range when it doesn't (e.g. demo data), which is a coarser but reasonable proxy.
  const VOLATILITY_WINDOW = 10;
  let volatilityContractionPct = null;
  if (rows.length >= VOLATILITY_WINDOW) {
    const window = rows.slice(-VOLATILITY_WINDOW);
    const hasHighLow = window.every((r) => r.High != null && r.Low != null);
    const hi = hasHighLow ? Math.max(...window.map((r) => r.High)) : Math.max(...window.map((r) => r.Close));
    const lo = hasHighLow ? Math.min(...window.map((r) => r.Low)) : Math.min(...window.map((r) => r.Close));
    volatilityContractionPct = latest.Close ? ((hi - lo) / latest.Close) * 100 : null;
  }

  // ---------- Golden Breakout model inputs ----------
  // Golden Cross state: MA50 above MA200 (Death Cross is simply the inverse — not
  // computed separately, since the bearish mirror was backtested and rejected).
  const goldenStateSeries = closes.map((_, i) => maAbove(maSeries[50][i], maSeries[200][i]));
  const goldenStreakResult = streakFromStateSeries(goldenStateSeries);
  const goldenCrossState = goldenStreakResult.value;      // true = golden, false = death, null = insufficient history
  const goldenCrossStreak = { streak: goldenStreakResult.streak, capped: goldenStreakResult.capped };
  const separationPct = (mas[50] != null && mas[200]) ? ((mas[50] - mas[200]) / Math.abs(mas[200])) * 100 : null;

  return {
    cmp: latest.Close, changeAbs, changePct, high52, low52, pctFromHigh52, pctFromLow52, cmpOverLow52,
    volToday: latest.Volume, vol30, volBreakoutPct,
    mas, sSignals, mSignals, sStreaks, mStreaks, rsi,
    ma200SlopePct, ma200Rising, volatilityContractionPct,
    goldenCrossState, goldenCrossStreak, separationPct,
    closes, dates: rows.map((r) => r.Date), // exposed for population-level computations (breadth, backtest)
  };
}

// ---------- RS Rating (IBD-style percentile rank, 1-99) ----------
// Ranks each stock's weighted recent price performance against every OTHER
// stock in the currently-loaded universe — this is relative to the universe,
// not to a fixed benchmark, so it will shift as the universe grows.
// Weighting matches the standard convention: most recent quarter counted
// double vs. each of the prior three quarters.
export const RS_COMPONENTS = [
  { lag: 63, weight: 0.4 },   // ~3 months
  { lag: 126, weight: 0.2 },  // ~6 months
  { lag: 189, weight: 0.2 },  // ~9 months
  { lag: 252, weight: 0.2 },  // ~12 months
];

export function closesByKeyFromPrices(rows, keyField) {
  const grouped = {};
  rows.forEach((r) => { (grouped[r[keyField]] ||= []).push(r); });
  const closes = {};
  Object.entries(grouped).forEach(([k, arr]) => {
    closes[k] = arr.slice().sort((a, b) => a.Date.localeCompare(b.Date)).map((r) => r.Close);
  });
  return closes;
}

export function rawRSScoreAsOf(closes, daysAgo) {
  const n = closes.length - daysAgo;
  if (n <= 0) return null;
  const priceAt = (offset) => { const i = n - 1 - offset; return i >= 0 ? closes[i] : null; };
  const now = priceAt(0);
  if (now == null || now <= 0) return null;
  let score = 0, totalW = 0;
  for (const { lag, weight } of RS_COMPONENTS) {
    const past = priceAt(lag);
    if (past != null && past > 0) { score += weight * (now / past); totalW += weight; }
  }
  if (totalW === 0) return null;
  return score / totalW;
}

export function bandOfRSRating(rating) {
  if (rating == null) return null;
  if (rating < 60) return "red";
  if (rating < 80) return "amber";
  return "green";
}

// Returns { [id]: { rating, band, streakDays, capped } } for every id in closesById.
// streakDays = consecutive trading days (including today) the rating has stayed
// in its current color band; capped = true if it never changed within maxLookbackDays.
export function computeRSUniverse(closesById, maxLookbackDays = 500) {
  const ids = Object.keys(closesById);
  const ratingsAsOf = (daysAgo) => {
    const raws = [];
    for (const id of ids) {
      const raw = rawRSScoreAsOf(closesById[id], daysAgo);
      if (raw != null) raws.push([id, raw]);
    }
    raws.sort((a, b) => a[1] - b[1]);
    const n = raws.length;
    const map = {};
    raws.forEach(([id], i) => { map[id] = n > 1 ? Math.round(1 + (98 * i) / (n - 1)) : 99; });
    return map;
  };

  const todayMap = ratingsAsOf(0);
  const band = {};
  const streak = {};
  ids.forEach((id) => { if (todayMap[id] != null) { band[id] = bandOfRSRating(todayMap[id]); streak[id] = 1; } });
  let active = new Set(Object.keys(band));

  for (let d = 1; d <= maxLookbackDays && active.size > 0; d++) {
    const map = ratingsAsOf(d);
    for (const id of Array.from(active)) {
      const r = map[id];
      if (r == null) { active.delete(id); continue; }
      if (bandOfRSRating(r) === band[id]) streak[id]++; else active.delete(id);
    }
  }
  const capped = active; // still active when the loop ran out — band never changed within the window

  const result = {};
  ids.forEach((id) => {
    if (todayMap[id] == null) { result[id] = { rating: null, band: null, streakDays: null, capped: false }; return; }
    result[id] = { rating: todayMap[id], band: band[id], streakDays: streak[id], capped: capped.has(id) };
  });
  return result;
}


// ---------- Market Breadth (whole-universe, over time) ----------
// % of the whole loaded universe above its own 200DMA, and new-52w-highs vs new-52w-lows,
// computed for every trading day so it can be charted as a trend, not just today's snapshot.
export function computeBreadthSeries(stockList, closesById, lookbackDays = 500) {
  const ids = stockList.map((s) => s.ISIN).filter((id) => closesById[id]);
  const ma200SeriesById = {};
  ids.forEach((id) => { ma200SeriesById[id] = rollingSMASeries(closesById[id], 200); });

  const maxLen = Math.max(0, ...ids.map((id) => closesById[id].length));
  const rawPoints = [];
  const startIdx = Math.max(0, maxLen - lookbackDays);
  for (let i = startIdx; i < maxLen; i++) {
    let above = 0, total = 0, newHighs = 0, newLows = 0, hlTotal = 0;
    ids.forEach((id) => {
      const closes = closesById[id];
      const idx = closes.length - maxLen + i;
      if (idx < 0 || closes[idx] == null) return;
      const ma = ma200SeriesById[id][idx];
      if (ma != null) { total++; if (closes[idx] > ma) above++; }
      const windowStart = Math.max(0, idx - 251);
      const window = closes.slice(windowStart, idx + 1);
      if (window.length >= 20) {
        const hi = Math.max(...window), lo = Math.min(...window);
        hlTotal++;
        if (closes[idx] >= hi * 0.99) newHighs++;
        else if (closes[idx] <= lo * 1.01) newLows++;
      }
    });
    if (total === 0 && hlTotal === 0) continue;
    rawPoints.push({
      dayIndex: i,
      pctAbove200: total ? (above / total) * 100 : null, // the actual, real daily breadth reading
      hlRatio: newLows > 0 ? newHighs / newLows : (newHighs > 0 ? null : 1), // null = "infinite" (no new lows at all)
      newHighs, newLows,
    });
  }

  // Smoothing overlays: 30/100/200-day moving averages OF the breadth line itself (not a
  // different threshold — genuine trend-smoothing on top of the same real series above).
  // Null-tolerant (unlike the general rollingSMASeries): early days can have no valid
  // breadth reading yet, and those must be skipped, not treated as 0.
  const rawSeries = rawPoints.map((p) => p.pctAbove200);
  const rollingSMASkipNulls = (series, n) => {
    const out = new Array(series.length).fill(null);
    for (let i = 0; i < series.length; i++) {
      const window = series.slice(Math.max(0, i - n + 1), i + 1).filter((v) => v != null);
      if (window.length >= Math.min(n, i + 1)) out[i] = avg(window);
    }
    return out;
  };
  const smooth = { 30: rollingSMASkipNulls(rawSeries, 30), 100: rollingSMASkipNulls(rawSeries, 100), 200: rollingSMASkipNulls(rawSeries, 200) };
  return rawPoints.map((p, i) => ({
    ...p,
    pctAbove200MA30: smooth[30][i],
    pctAbove200MA100: smooth[100][i],
    pctAbove200MA200: smooth[200][i],
  }));
}

// ---------- Breakout Screener: Stage A funnel + Stage B ranking, per bucket ----------
// Every threshold and gate here is a toggleable setting, not a hardcoded rule — this
// backtested as genuinely inconclusive on the current 742-stock sample (sector RS +
// regime adjustment showed no reliable improvement over the simpler universe-wide RS
// version), so the design needs to stay easy to flip back or retune as more data arrives.
// ---------- Golden Breakout Model ----------
// Five gates, every one backtested and validated against 5 years of real price history
// (no toggles — parameters that didn't earn their place through evidence were removed
// entirely rather than left as optional: RS Rating, the prior-duration/whipsaw filter,
// and Bollinger/ATR volatility-contraction were all tested and rejected). Bullish only —
// the bearish/death-cross mirror was tested and rejected (worse than a coin flip; shelved
// for a future non-mirrored redesign, not part of this model). No bucketing — a single
// flat, ranked list across the whole universe.
export const GOLDEN_BREAKOUT_PARAMS = {
  minSeparationPct: 3,   // 50DMA must be at least this far above 200DMA
  freshnessMaxDays: 15,  // the golden-cross state must be this recent or fresher
};

export function passesGoldenBreakout(stock, params = GOLDEN_BREAKOUT_PARAMS) {
  const t = stock.tech;
  if (!t) return false;
  if (t.goldenCrossState !== true) return false;                          // gate 1a: 50DMA > 200DMA
  if (t.sSignals?.[50] !== true) return false;                            // gate 1b: price > 50DMA (together with 1a: price > 50DMA > 200DMA)
  if (t.ma200Rising !== true) return false;                               // gate 2: 200DMA itself rising
  if (t.separationPct == null || t.separationPct < params.minSeparationPct) return false; // gate 3
  if (t.goldenCrossStreak?.streak == null || t.goldenCrossStreak.streak > params.freshnessMaxDays) return false; // gate 4
  if (t.sSignals?.[8] !== true) return false;                             // gate 5: short-term trend intact
  return true;
}

// Sort order is a presentation choice, not a second layer of proven edge — the
// correlation check found none of these remaining factors predict returns *within*
// the already-qualified population. Separation width (descending) leads, freshness
// (ascending — earliest in its window first) breaks ties.
export function rankGoldenBreakoutCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const sepDiff = (b.tech.separationPct ?? -Infinity) - (a.tech.separationPct ?? -Infinity);
    if (sepDiff !== 0) return sepDiff;
    return (a.tech.goldenCrossStreak?.streak ?? Infinity) - (b.tech.goldenCrossStreak?.streak ?? Infinity);
  });
}

export function runGoldenBreakoutScreener(computedStocks, params = GOLDEN_BREAKOUT_PARAMS) {
  const candidates = computedStocks.filter((s) => passesGoldenBreakout(s, params));
  return rankGoldenBreakoutCandidates(candidates);
}

export function computeAll(master, fundamentals, prices) {
  const fundByISIN = {};
  fundamentals.forEach((r) => { (fundByISIN[r.ISIN] ||= []).push(r); });
  const priceByISIN = {};
  prices.forEach((r) => { (priceByISIN[r.ISIN] ||= []).push(r); });

  return master.map((m) => {
    const fund = computeFundamentalBlock(fundByISIN[m.ISIN] || []);
    const tech = computeTechnicalBlock(priceByISIN[m.ISIN] || []);
    return { ...m, fund, tech };
  });
}
