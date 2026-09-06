"""
Meridian — Golden Breakout Backtest Engine
============================================================================
This is the AUTHORITATIVE backtest implementation. It reflects the final,
LOCKED five-gate Golden Breakout model, validated against 5 years of real
NSE price history. Read this docstring in full before extending anything —
several tempting-looking additions below have already been tested and
rejected, with the evidence to show why, specifically so they aren't
re-derived from scratch.

VALIDATED RESULT — re-run 2026-09-06 against the full 2,089-instrument
universe, with freshly corporate-action-adjusted history AND the MA semantics
corrected to match the production engine (see rolling_sma below):
    20-trading-day horizon: 55.3% win rate, +4.55% mean return, 2,847 episodes
    60-trading-day horizon: 59.8% win rate, +12.57% mean return, 2,592 episodes

    ON THE ORIGINAL 742-STOCK FILE, freshness<=10, these same corrections give
    59.6%/+4.09% at 20d over 478 episodes. The figure published before this work
    was 58.6%/+4.06% over 467. The ~1pp gap is NOT noise and NOT a regression:
    the old backtest silently dropped any stock-day whose 200-row window
    contained a missing bar, so it was scoring a slightly different population
    than production ever ran on. Both now agree — verify_port.py asserts the
    Node engine and this file select an identical candidate set.

    Reading the universe difference: widening 742 -> 2,089 lowers the win rate
    ~3.6pp but RAISES mean return (+4.09 -> +5.35 at 20d on a like-for-like
    <=10d gate) — smaller caps are noisier but higher beta. Widening freshness
    10 -> 15 costs ~0.7pp of win rate and roughly doubles the opportunity set.

THE FIVE LOCKED GATES (see `passes_golden_breakout()` — this is the ONLY
gate function that should run in production or in any new backtest):
    1. Golden Cross structure: price > 50DMA > 200DMA
    2. 200DMA rising (20-trading-day slope > 0)
    3. Separation: (50DMA - 200DMA) / 200DMA >= 3%
    4. Freshness: golden-cross state streak <= 15 trading days (was 10 until 2026-09-05)
    5. Short-term trend intact: price > 8DMA

DO NOT RE-ADD THE FOLLOWING WITHOUT A GENUINELY NEW REASON — each was
implemented, backtested, and rejected on real data. Reference implementations
are preserved below in the REJECTED PARAMETERS section specifically so they
can be re-run for verification, NOT so they get silently merged back into
the main model:

    - RS Rating as a Stage-B gate/filter. Neutral-to-harmful at every
      threshold tested (RS>=70 dropped 20d win rate from 59.0% to 54.4%).
      Root cause: RS Rating is backward-looking; Golden Breakout is designed
      to catch early turnarounds that haven't built trailing RS yet. These
      two signals are in structural tension, not complementary.
    - "Whipsaw" / prior-duration filter (require the pre-cross state to have
      lasted >= 30 days). Removing it was flat-to-better on every metric
      while expanding the opportunity set 11% (238 -> 264 episodes). The
      squeeze/freshness/200DMA-slope combination already caught what this
      was meant to catch.
    - Bollinger Band compression ("squeeze") as a 6th gate. IMPORTANT: an
      earlier version of this exact test had a directional bug in the
      percentile formula that made it LOOK like tight squeeze helped
      (58.0% -> 59.0% -> 60.8% win rate as the threshold tightened). The
      bug was found and fixed; the CORRECTED result is the opposite —
      genuine compression HURTS performance, worsening as it tightens
      (60-day win rate fell to 33.3% at what was originally recommended as
      the "best" threshold). The corrected, bug-free formula is preserved
      below for anyone who wants to re-verify this.
    - ATR-based volatility contraction. A second, independently-computed
      volatility measure (true range, not closing-price dispersion) was
      tested specifically to confirm the Bollinger finding wasn't a fluke
      of one formula. Same negative result, same direction, at every
      threshold tested.
    - Market-cap bucketing / per-bucket top-N selection. Tested head-to-head
      against a simple universe-wide ranking — result was a wash (58.5%/
      62.2% bucketed vs 58.2%/62.7% universe-wide). Removed entirely from
      the production model, not just deprioritized.
    - Bearish/"Death Cross" mirror (price < 50DMA < 200DMA, etc.). This is
      NOT a simple sign-flip of the working bullish model — tested and
      found to underperform a coin flip (42.5%/35.9% win rate, wrong
      direction — stocks flagged as bearish were MORE likely to rise).
      Reflects a well-documented real asymmetry: bearish technical signals
      reliably underperform bullish ones in markets with positive drift.
      If a genuine short signal is wanted later, it needs distinct logic
      (breakdown velocity, distribution volume, relative weakness vs a
      rising market) — not an inverted copy of this model.

DATA LOADING — ADAPT THIS FOR SUPABASE:
    The loader below (`load_price_data_from_csv`) reads from local CSV,
    matching how this was developed against Meridian's exported price
    history. Once Supabase is live, replace this function's body with a
    query against the `prices_daily` table (see meridian-requirements.md
    §6.4 for the schema) — everything downstream (signal computation,
    the gate, the backtest runner) is written against a plain wide
    DataFrame (dates x ISIN, values = Close) and does not care where that
    DataFrame came from.

METHODOLOGY NOTE — episode-level vs raw signal-day counting:
    Every result in this project is reported BOTH ways: raw signal-days
    (every day a stock happens to still qualify) and independent episodes
    (only the first day of each qualifying streak). Raw counts overstate
    apparent sample size because streaks persist across many consecutive
    days. Episode-level is the more honest number and should be treated as
    primary; raw counts are reported for cross-checking only.
============================================================================
"""

import glob

import numpy as np
import pandas as pd


# ============================================================================
# DATA LOADING — swap this out for a Supabase query when the pipeline is live
# ============================================================================

def load_price_data_from_csv(path):
    """
    Loads a long-format price CSV (columns: ISIN, Date, High, Low, Close,
    Volume — matching Meridian's price_history export schema) and returns
    a wide DataFrame: index = Date, columns = ISIN, values = Close.

    `path` may be a glob. The full history ships as three parts (a single
    file exceeds GitHub's 100MB limit), split by instrument and never
    mid-series, so concatenating them is safe in any order.

    TO ADAPT FOR SUPABASE: replace the body of this function with a query
    against `prices_daily`, then pivot the same way. Nothing else in this
    file needs to change.
    """
    paths = sorted(glob.glob(path)) or [path]
    df = pd.concat([pd.read_csv(p, parse_dates=["Date"]) for p in paths], ignore_index=True)
    close = df.pivot(index="Date", columns="ISIN", values="Close").sort_index()
    return close


# ============================================================================
# CORE SIGNAL COMPUTATION — mirrors meridian.jsx's computeTechnicalBlock
# exactly, so results here are traceable back to the production JS logic,
# not a parallel reimplementation with its own drift risk.
# ============================================================================

def rolling_sma(close, n):
    """
    Simple moving average over each instrument's own last `n` bars.

    NOT `close.rolling(n).mean()` on the pivoted grid. That grid has a row for
    every date any instrument traded, so an instrument that missed a session
    carries a NaN there, and a plain rolling window spanning that NaN returns
    NaN — blanking the MA, and with it every gate, for a stock whose only sin
    was not trading one day. Seven instruments were silently dropped from the
    2026-09-04 candidate set that way.

    meridian-engine.js walks each instrument's own bar series and is right to:
    a 200-day moving average means 200 of *that stock's* trading days. Dropping
    NaNs per column before the roll reproduces that exactly, and the port parity
    check (verify_port.py) fails if the two ever diverge again.
    """
    return close.apply(lambda s: s.dropna().rolling(n).mean().reindex(s.index))


def compute_200dma_slope(ma200, lookback=20):
    """
    Is the 200DMA itself rising? Compares today's MA200 to its value
    `lookback` trading days ago. A stock above a DECLINING 200DMA is often
    a dead-cat bounce, not a genuine Stage-2 uptrend — this is why "price
    above 200DMA" alone (without this slope check) is not gate #1 on its
    own; gates #1 and #2 work together.
    """
    slope_pct = (ma200 - ma200.shift(lookback)) / ma200.shift(lookback).abs() * 100
    return slope_pct, slope_pct > 0


# Mirrors maAbove() in meridian-engine.js. Two moving averages are mathematically
# EQUAL whenever price is flat across both windows, and a bare `>` then resolves on
# floating-point noise instead of on the market. pandas' rolling mean happens to
# return exactly 0.0 for such a tie while a naive JS summation drifts ~1e-13 above,
# so the two implementations disagreed on golden-cross state and their freshness
# streaks diverged 195 days vs 4. Same relative tolerance, same tie-breaking, both
# languages.
MA_TIE_EPSILON = 1e-9


def ma_above(a, b):
    """a > b, treating a floating-point tie as 'not above'."""
    return (a - b) > b.abs() * MA_TIE_EPSILON


def compute_golden_cross_state_and_streaks(ma50, ma200):
    """
    Golden Cross state (True = 50DMA > 200DMA) plus two derived series per
    stock:
      - `streak`: how many consecutive trading days the CURRENT state has
        held (this is "freshness" when state=True and streak is small).
      - `prior_duration`: how long the PREVIOUS (opposite) state lasted
        before the most recent flip. This was the basis of the now-removed
        "whipsaw filter" — kept here only because `prior_duration` is a
        genuinely reusable computation, not because the filter itself
        should be reintroduced.

    Both are leak-free: `streak` only ever uses data up to and including
    today, and `prior_duration` only reflects a fully-completed prior
    episode — never data from the future relative to any day being
    evaluated.
    """
    state = ma_above(ma50, ma200)
    streak = pd.DataFrame(index=state.index, columns=state.columns, dtype=float)
    prior_duration = pd.DataFrame(index=state.index, columns=state.columns, dtype=float)

    # Counted over each instrument's own bars, not over grid rows. On a date an
    # instrument did not trade, its MAs are NaN and `ma_above` yields False —
    # injecting a phantom state flip that resets the streak. Since the streak IS
    # gate #4 (freshness), that would silently mis-gate any stock with a gap.
    # Restricting to rows where the MAs exist matches meridian-engine.js, which
    # only ever sees real bars.
    valid = ma50.notna() & ma200.notna()

    for col in state.columns:
        s = state[col][valid[col]]
        if s.empty:
            continue
        grp = (s != s.shift(1)).cumsum()
        streak.loc[s.index, col] = s.groupby(grp).cumcount() + 1
        grp_sizes = s.groupby(grp).size()
        prior_duration.loc[s.index, col] = grp.map(lambda g: grp_sizes.get(g - 1, np.nan))

    return state, streak, prior_duration


def compute_separation_pct(ma50, ma200):
    """(50DMA - 200DMA) / 200DMA, as a percentage. Positive = golden, negative = death."""
    return (ma50 - ma200) / ma200.abs() * 100


def compute_all_signals(close):
    """
    Runs every signal Meridian's Golden Breakout model needs, on a wide
    (Date x ISIN) close-price DataFrame. Returns a dict of DataFrames, all
    aligned to the same index/columns as `close`.
    """
    ma8 = rolling_sma(close, 8)
    ma50 = rolling_sma(close, 50)
    ma200 = rolling_sma(close, 200)

    ma200_slope_pct, ma200_rising = compute_200dma_slope(ma200)
    golden_state, golden_streak, golden_prior_duration = compute_golden_cross_state_and_streaks(ma50, ma200)
    separation_pct = compute_separation_pct(ma50, ma200)

    return {
        "close": close, "ma8": ma8, "ma50": ma50, "ma200": ma200,
        "ma200_slope_pct": ma200_slope_pct, "ma200_rising": ma200_rising,
        "golden_state": golden_state, "golden_streak": golden_streak,
        "golden_prior_duration": golden_prior_duration,
        "separation_pct": separation_pct,
    }


# ============================================================================
# THE LOCKED MODEL — five gates, exactly as specified in the docstring above.
# This is the only gate function that should be used for production signals
# or any new backtest run.
# ============================================================================

MIN_SEPARATION_PCT = 3
FRESHNESS_MAX_DAYS = 15   # widened from 10 on 2026-09-05; see requirements §4.3


def passes_golden_breakout(signals, min_separation_pct=MIN_SEPARATION_PCT, freshness_max_days=FRESHNESS_MAX_DAYS):
    """
    Returns a boolean DataFrame (Date x ISIN), True wherever a stock clears
    all five locked gates on that day. This is a direct, deliberate mirror
    of `passesGoldenBreakout()` in meridian.jsx — same five conditions, same
    order, same thresholds. If you change a threshold here, change it in
    the production JS too (or better: change it in JS and re-derive this
    from it), so the two never quietly diverge.
    """
    close = signals["close"]
    return (
        signals["golden_state"] &                                   # gate 1a: 50DMA > 200DMA
        (close > signals["ma50"]) &                                  # gate 1b: price > 50DMA
        signals["ma200_rising"] &                                    # gate 2
        (signals["separation_pct"] >= min_separation_pct) &          # gate 3
        (signals["golden_streak"] <= freshness_max_days) &           # gate 4
        (close > signals["ma8"])                                     # gate 5
    )


# ============================================================================
# BACKTEST RUNNER — forward returns, win rate, both raw and episode-level.
# ============================================================================

def run_backtest(signal, close, horizons=(20, 60)):
    """
    `signal`: boolean DataFrame from a gate function (e.g. passes_golden_breakout).
    `close`: the same wide close-price DataFrame the signals were built from.

    Returns a dict keyed by horizon, each containing raw and episode-level
    win rate / mean return / sample size.
    """
    results = {}
    for h in horizons:
        fwd_return = close.shift(-h) / close - 1

        # Raw signal-day level
        mask = signal.values
        raw_returns = fwd_return.values[mask]
        raw_returns = raw_returns[~np.isnan(raw_returns)]

        # Episode-level: only the FIRST day of each qualifying streak counts
        # as one independent event — this is the primary, more honest number.
        episode_returns = []
        for col in signal.columns:
            s = signal[col].values
            if not s.any():
                continue
            starts = np.where(s & ~np.concatenate([[False], s[:-1]]))[0]
            for i in starts:
                r = fwd_return.iloc[i][col]
                if not np.isnan(r):
                    episode_returns.append(r)
        episode_returns = np.array(episode_returns)

        results[h] = {
            "raw_signal_days": int(mask.sum()),
            "raw_win_rate_pct": float((raw_returns > 0).mean() * 100) if len(raw_returns) else None,
            "raw_mean_return_pct": float(raw_returns.mean() * 100) if len(raw_returns) else None,
            "episodes": len(episode_returns),
            "episode_win_rate_pct": float((episode_returns > 0).mean() * 100) if len(episode_returns) else None,
            "episode_mean_return_pct": float(episode_returns.mean() * 100) if len(episode_returns) else None,
        }
    return results


def print_results(label, results):
    print(f"\n=== {label} ===")
    for h, r in results.items():
        print(f"  {h}-day horizon:")
        print(f"    Raw signal-days: {r['raw_signal_days']} | win rate {r['raw_win_rate_pct']:.1f}% | mean return {r['raw_mean_return_pct']:.2f}%" if r['raw_signal_days'] else "    (no signals)")
        print(f"    Episodes:        {r['episodes']} | win rate {r['episode_win_rate_pct']:.1f}% | mean return {r['episode_mean_return_pct']:.2f}%" if r['episodes'] else "    (no episodes)")


# ============================================================================
# REJECTED PARAMETERS — preserved for verification only. NOT called by
# default. Do not wire these into `passes_golden_breakout()` without a
# genuinely new reason and a fresh backtest — the reasons they were removed
# are documented in the module docstring above.
# ============================================================================

def compute_rs_rating(close, weights=(0.4, 0.2, 0.2, 0.2), windows=(63, 126, 189, 252)):
    """
    RS Rating engine — this itself is NOT rejected (it's used correctly
    elsewhere in Meridian, e.g. the Stocks screen). What's rejected is using
    it as a Golden Breakout gate (see docstring). Kept here for anyone who
    wants to re-verify that specific finding.
    """
    raw_score = sum(w * (close / close.shift(win)) for w, win in zip(weights, windows))
    return raw_score.rank(axis=1, pct=True) * 98 + 1


def compute_bollinger_squeeze_percentile_CORRECTED(close, bb_window=20, lookback_window=120):
    """
    Bollinger Band width, percentile-ranked against its own trailing
    history. THIS IS THE BUG-FIXED VERSION — low percentile = genuinely
    tight (today's width is small relative to its own recent range).

    An earlier version of this exact computation had the comparison
    direction backwards (used `x.iloc[-1] <= x` instead of `x <= x.iloc[-1]`),
    which silently selected the WIDEST bands while appearing to test
    "squeeze." That bug produced a false-positive "improvement" result
    before being caught and corrected. This corrected version confirmed
    the opposite: genuine compression hurts this model's performance. Do
    not reintroduce the old formula direction.
    """
    bb_mid = close.rolling(bb_window).mean()
    bb_std = close.rolling(bb_window).std()
    bb_width = (4 * bb_std) / bb_mid * 100
    return bb_width.rolling(lookback_window).apply(
        lambda x: (x <= x.iloc[-1]).mean() * 100 if x.notna().all() else np.nan, raw=False
    )


def compute_atr_contraction_percentile(high, low, close, atr_window=14, lookback_window=120):
    """
    ATR-based volatility contraction — a second, independently-computed
    measure (true range including gaps, not closing-price dispersion),
    used specifically to confirm the Bollinger squeeze finding wasn't an
    artifact of one formula. Same result: rejected, same direction.
    Requires High/Low data, not just Close.
    """
    prev_close = close.shift(1)
    true_range = np.maximum(np.maximum(high - low, (high - prev_close).abs()), (low - prev_close).abs())
    atr = true_range.rolling(atr_window).mean()
    atr_pct = atr / close * 100
    return atr_pct.rolling(lookback_window).apply(
        lambda x: (x <= x.iloc[-1]).mean() * 100 if x.notna().all() else np.nan, raw=False
    )


def compute_market_cap_buckets(market_caps):
    """
    market_caps: dict or Series of {ISIN: market_cap}.
    Ranks 1-1000 in buckets of 100, then buckets of 200 thereafter.
    Rejected as a Golden Breakout mechanism (see docstring) — preserved
    only because bucketing may still be useful for OTHER purposes (e.g.
    Market Breadth was also bucketed at one point, then simplified to a
    single flat reading for different reasons — see requirements doc §4.4).
    """
    ranked = pd.Series(market_caps).rank(ascending=False, method="first")

    def bucket_of(rank):
        if pd.isna(rank):
            return None
        rank = int(rank)
        if rank <= 1000:
            return (rank - 1) // 100
        return 10 + (rank - 1001) // 200

    return ranked.apply(bucket_of)


# ============================================================================
# MAIN — runs the canonical, locked backtest. This is what should execute
# by default; nothing above this point runs unless explicitly called.
# ============================================================================

if __name__ == "__main__":
    import sys

    csv_path = sys.argv[1] if len(sys.argv) > 1 else "meridian-price-history-2090-part*of3.csv"
    print(f"Loading price data from {csv_path} ...")
    close = load_price_data_from_csv(csv_path)
    print(f"Loaded {close.shape[1]} instruments, {close.shape[0]} trading days.")

    signals = compute_all_signals(close)
    signal = passes_golden_breakout(signals)

    results = run_backtest(signal, close)
    print_results("Golden Breakout — 5-gate locked model", results)

    print(
        "\nExpected (from the validated production run): "
        "20d ~58.6% win / +4.06% mean (467 episodes); "
        "60d ~64.2% win / +12.05% mean.\n"
        "If your numbers differ meaningfully, check whether the underlying "
        "price data (universe, date range, adjustment for corporate actions) "
        "matches what was used to establish this baseline before assuming "
        "the model itself has changed."
    )
