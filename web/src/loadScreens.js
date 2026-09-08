/**
 * Reads the published screens out of Supabase and shapes them into the dataset
 * meridian.jsx's App expects (§6.2). No model logic lives here — every value was
 * computed by meridian-engine.js in compute_and_publish.mjs and is passed through.
 *
 * The one thing this file does compute is the sectoral breakout, by calling the
 * engine's own runGoldenBreakoutScreener over the 120 already-published industry
 * rows. That is the identical function the pipeline runs, not a reimplementation,
 * and it is O(120) — cheap enough that publishing a table for it would be more
 * machinery than it saves.
 */

import { runGoldenBreakoutScreener } from "@meridian/meridian-engine.js";
import { supabase } from "./supabase.js";

// PostgREST caps a response at 1,000 rows and returns the first page without
// complaining. technicals_daily is 2,089 rows, so an unpaged read would silently
// drop half the universe — the same trap the loader and the compute step both had
// to handle, and the reason this is a shared helper rather than three ad-hoc loops.
const PAGE = 1000;
async function readAll(table, columns) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) return out;
  }
}

// PostgREST returns `numeric` as a JSON string once it exceeds double precision,
// so a bare value can arrive as "1309.5000". The UI calls .toFixed() on these, which
// would throw on a string — coerce every numeric at the boundary rather than
// scattering guards through the screens.
const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

export async function loadScreens() {
  const [universe, technicals, scored, candidates, sectoral, breadth] = await Promise.all([
    readAll("universe", "id,identifier,symbol,name,sector,industry_group,market_cap"),
    readAll("technicals_daily", "*"),
    readAll("fundamentals_scored", "*"),
    readAll("golden_breakout_candidates", "*"),
    readAll("sectoral_technicals_daily", "*"),
    readAll("market_breadth_daily", "*"),
  ]);

  const uniById = Object.fromEntries(universe.map((u) => [u.id, u]));
  const techById = Object.fromEntries(technicals.map((t) => [t.universe_id, t]));
  const scoreById = Object.fromEntries(scored.map((f) => [f.universe_id, f]));

  const techOf = (t) => t && ({
    cmp: n(t.cmp), changePct: n(t.change_pct),
    high52: n(t.high52), low52: n(t.low52),
    pctFromHigh52: n(t.pct_from_high52), pctFromLow52: n(t.pct_from_low52),
    mas: { 3: n(t.ma3), 8: n(t.ma8), 30: n(t.ma30), 50: n(t.ma50), 100: n(t.ma100), 200: n(t.ma200) },
    sSignals: t.s_signals || {}, mSignals: t.m_signals || {},
    sStreaks: t.s_streaks || {}, mStreaks: t.m_streaks || {},
    rsi: n(t.rsi),
    ma200SlopePct: n(t.ma200_slope_pct), ma200Rising: t.ma200_rising,
    goldenCrossState: t.golden_cross_state,
    goldenCrossStreak: { streak: t.golden_cross_streak, capped: false },
    separationPct: n(t.separation_pct), volBreakoutPct: n(t.vol_breakout_pct),
    rsRating: t.rs_rating == null ? null : {
      rating: n(t.rs_rating), band: t.rs_band,
      streakDays: t.rs_streak_days, capped: t.rs_capped ?? false,
    },
  });

  const computed = universe.map((u) => {
    const t = techOf(techById[u.id]);
    const f = scoreById[u.id];
    const per = f?.per_metric || null;
    const fund = per && {
      ...per,
      score: { score: n(f.composite_score), tier: f.tier, exempt: per.exempt ?? false },
    };
    return {
      ISIN: u.identifier, Symbol: u.symbol, Name: u.name,
      Sector: u.sector, IndustryGroup: u.industry_group, MarketCap: n(u.market_cap),
      // P/E is CMP over the latest reported EPS, exactly as the prototype derives it —
      // arithmetic over two published values, not a model output, so it is computed
      // here rather than stored.
      PE: t && per?.epsLatest ? t.cmp / per.epsLatest : null,
      tech: t || null, fund: fund || null,
    };
  });

  const byId = Object.fromEntries(computed.map((c) => [c.ISIN, c]));
  const idToIsin = Object.fromEntries(universe.map((u) => [u.id, u.identifier]));
  const goldenBreakoutCandidates = candidates
    .slice().sort((a, b) => a.rank - b.rank)
    .map((c) => byId[idToIsin[c.universe_id]])
    .filter(Boolean);

  // Shaped like an instrument so the same screen components render it — the
  // prototype does exactly this with its synthetic industry indices.
  const sectoralComputed = sectoral.map((s) => ({
    ISIN: s.industry_group, Name: s.industry_group, Symbol: s.industry_group,
    Sector: s.industry_group, Constituents: s.constituents, fund: null,
    tech: {
      cmp: n(s.cmp), changePct: n(s.change_pct), rsi: n(s.rsi),
      mas: { 8: n(s.ma8), 50: n(s.ma50), 200: n(s.ma200) },
      sSignals: {}, mSignals: {}, sStreaks: {}, mStreaks: {},
      ma200SlopePct: n(s.ma200_slope_pct), ma200Rising: s.ma200_rising,
      goldenCrossState: s.golden_cross_state,
      goldenCrossStreak: { streak: s.golden_cross_streak, capped: false },
      separationPct: n(s.separation_pct),
      rsRating: s.rs_rating == null ? null : {
        rating: n(s.rs_rating), band: s.rs_band, streakDays: s.rs_streak_days, capped: false,
      },
    },
  }));

  const breadthSeries = breadth
    .slice().sort((a, b) => a.trade_date.localeCompare(b.trade_date))
    .map((b, i) => ({
      dayIndex: i, date: b.trade_date,
      pctAbove200: n(b.pct_above_200dma),
      pctAbove200MA30: n(b.pct_above_200dma_ma30),
      pctAbove200MA100: n(b.pct_above_200dma_ma100),
      pctAbove200MA200: n(b.pct_above_200dma_ma200),
      newHighs: b.new_highs, newLows: b.new_lows,
      hlRatio: n(b.high_low_ratio),
    }));

  // The as-of date comes from the published screen, not the clock — a morning the
  // pipeline has not run must read as yesterday (§5).
  const asOfIso = technicals.reduce((m, t) => (t.as_of_date > m ? t.as_of_date : m), "") || null;
  const stale = technicals.filter((t) => t.as_of_date < asOfIso).length;

  return {
    computed,
    goldenBreakoutCandidates,
    sectoralComputed,
    sectoralBreakoutCandidates: runGoldenBreakoutScreener(sectoralComputed),
    breadthSeries,
    asOf: { iso: asOfIso, stale },
  };
}
