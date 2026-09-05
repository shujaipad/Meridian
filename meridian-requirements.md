# Meridian — Formal Requirements & Architecture Document

**Status:** Living reference, consolidated from the full design/build history to date.
**Purpose:** (1) a complete, standalone record of every locked decision and validated
methodology; (2) the intended brief for the eventual Claude Code migration, so that
transition starts with full context rather than from zero.

**Owner:** Personal project — not affiliated with any firm or organization.

---

## 1. Product Vision

Meridian is a fundamental + technical screening and idea-generation tool for the Indian
equity market (plus Commodities, Global Indices, and Crypto), built around one core
belief: **nothing ships without evidence.** Every scoring model, threshold, and signal in
this document was either backtested against 5 years of real price history or explicitly
rejected because it didn't hold up — including cases where the evidence contradicted the
person's own initial intuition, and one case where a bug in the backtest itself was
caught and corrected before being trusted (see §4.3).

The long-term goal is a self-updating, always-current production application. The
current state is a fully-featured but manually-operated prototype, built as a
single-file client-side artifact, with a clear, locked architecture for what production
looks like (§6–§8).

---

## 2. Current State — What Exists Today

Meridian today is a single React artifact (`meridian.jsx`), running client-side with
no backend. It is feature-complete for its current phase but **not production-infrastructure** —
data is user-uploaded each session, nothing persists reliably at scale (see §6.1 for why),
and there is no automation.

### 2.1 Structure
Four top-level asset-class tabs, each color-accented for quick visual orientation:

| Asset class | Sub-tabs | Data status |
|---|---|---|
| **Equities** | Stocks, Golden Breakout, Sectoral, Sectoral Breakout, Market Breadth | Real data: 742 of ~1,977 qualifying stocks (full universe re-sourcing in progress) |
| **Commodities** | Base data, Golden Breakout | Sample/synthetic data (25 instruments); real sourcing not yet done |
| **Global Indices** | Base data, Golden Breakout | Sample/synthetic data (25 instruments); real sourcing not yet done |
| **Crypto** | Base data, Golden Breakout | Sample/synthetic data (25 instruments); real sourcing not yet done |

Equities uses a specialized, fully-featured screen (watchlists, universe management,
alerts, fundamentals). Commodities/Indices/Crypto share one **generic, reusable**
component pair (`GenericAssetScreen` for base data, `GenericGoldenBreakoutScreen` for
signals), driven by a config object — not three copy-pasted screens. This was a
deliberate architectural choice made once the shape of "N similar asset classes" became
concrete, specifically to avoid the maintenance burden of near-duplicate screens
drifting apart over time.

**Note on naming:** the project was originally named "Bharat Screener" during the
earliest pilot-build phase, before being renamed to "Meridian." Purely historical —
every reference in this document and the current codebase uses "Meridian."

### 2.2 The Excel Workbook — a real, parallel deliverable, not an afterthought
From the very first architecture discussion, the build was explicitly scoped as a
**hybrid**: a computation engine feeding an interactive dashboard (the artifact,
covered above), *plus* a board-shareable static Excel workbook as a secondary output —
not a nice-to-have bolted on later.

**Structure (unchanged since the original design):**
- **Instructions** — usage notes, explains which sheets are input (yellow-filled,
  blue-font cells) vs. output (live formulas).
- **Company Master** — input sheet: ISIN, Symbol, Name, Sector, MarketCap, PE.
  (Originally included PB; removed per an explicit later instruction — see below.)
- **Fundamentals Raw** — input sheet, wide format, one row per stock per fiscal year
  (last 4 years). Originally raw P&L/balance-sheet line items (NetProfit, Equity, EBIT,
  CapitalEmployed, TotalDebt) with ROE/ROCE/D-E computed *in-sheet*; **superseded once
  real fundamentals data arrived pre-computed** (ROE_Pct, ROCE_Pct, DebtEquity as direct
  ratios, not derivable line items) — the sheet's formulas were updated to read these
  directly rather than derive them, mirroring the same schema correction made in the
  dashboard's `computeFundamentalBlock`.
- **Price History** — input sheet, one row per stock per trading day.
- **Screener** — the output sheet. Every cell is a live formula referencing the input
  sheets; changing an input recalculates the sheet. No hardcoded results, per the
  project's xlsx skill requirements.

**Core formula technique (established early, still in use):** since Excel has no native
"latest row per group" function, every input sheet carries a computed **rank column**
(`YrRank` for fundamentals, `DayRank` for prices) — 1 = most recent — via `COUNTIFS`
counting how many later dates/years exist for the same stock. The Screener sheet then
pulls "current" values via `SUMPRODUCT` matching on (ISIN, rank=1), and moving
averages/52-week ranges via `AVERAGEIFS`/`MAXIFS`/`MINIFS` filtered on `rank<=N`. This
pattern is what makes the whole sheet formula-driven rather than requiring VBA or manual
recalculation.

**Features added over time, tracking the dashboard (kept in sync at each step):**
RS Rating (via `RANK()`, not `RANK.EQ` — the latter needs an `_xlfn.` prefix and
silently fails in LibreOffice's recalc engine, which this project's verification
pipeline depends on), % from 52-week high/low, CMP/52w-low ratio, Volume Breakout %
(repurposed from the removed P/B column, not a new one — see below), computed P/E
(CMP ÷ latest EPS, with fallback to the manual value), 200DMA Slope% + Rising flag, and
the full Composite Fundamental Score + 5-tier quintile system with the financial-sector
exemption (§4.2) — including a `OR(...)` formula enumerating the 11 verified financial
Industry Name categories directly, since Excel has no clean equivalent to a JS `Set`.

**A real bug found and fixed in the Excel pipeline specifically, worth recording:** the
LibreOffice-based recalculation step (`recalc.py`, used to verify every formula
evaluates before shipping) was found to silently **un-hide several helper columns**
(RS RawScore and the percentile-ranking helpers behind the Composite Score) on every
run, regardless of what was set beforehand — and re-hiding them via openpyxl afterward
was found to strip the recalculated cached values in the process (a real
openpyxl/LibreOffice round-trip limitation, not something fixable by retrying). Net
effect: those specific helper columns ship visible rather than hidden. Cosmetic, not a
correctness issue — the values and formulas themselves are unaffected — but a real,
diagnosed platform limitation, not an oversight.

**Known, explicit gap — the Excel workbook is meaningfully behind the dashboard today.**
It reflects the state of the model *before* the Golden Breakout redesign (§4.3) and the
multi-asset framework (§2.1). It does **not** currently have: the five-gate Golden
Breakout logic, the multi-asset structure, Sectoral computation, or Market Breadth. This
gap was explicitly flagged during the build and has not yet been closed — bringing Excel
current with the dashboard's present state is real, scoped, not-yet-done work, not an
oversight to silently carry forward.

### 2.3 Known limitations of the current (artifact) implementation
- **Hard storage ceiling.** Client-side artifact storage caps at **20MB total**, across
  all data combined. The real Equities price history alone is ~75MB as stored data —
  structurally larger than the entire budget, chunked or not. This is not a bug; it is a
  platform limit that cannot be engineered around inside this environment. It is the
  primary reason production requires a real backend.
- **No automation.** All data is uploaded manually, every session.
- **No live internet access from this chat environment**, meaning no fetch script has
  ever been tested against a live server from here — only reasoned about and validated
  in isolation.

---

## 3. Data & Universe Requirements

### 3.1 Equities universe
- **Definition:** user-defined, by ISIN, via a maintenance screen kept separate from the
  main analytics UI (clean-visuals, filter-driven experience is not to be cluttered with
  data-maintenance concerns).
- **Review cadence:** quarterly, on calendar-quarter-end dates — Mar 31 / Jun 30 / Sep 30
  / Dec 31 — aligned with the original >₹500 Cr market-cap threshold convention.
- **Gap / data-completeness policy (locked):**
  - Historical data needing correction is corrected via **corporate-action adjustment**
    (splits, bonuses, etc.) — not treated as a "missing data" problem.
  - A stock with **genuinely unavailable history for the full look-back period**
    (overwhelmingly: recent listings without enough trading history yet) is **excluded
    from the universe entirely**, not carried with a partial series.
  - **Accepted tradeoff:** this reduces breadth — promising recent listings will not
    appear in the universe until they've accumulated sufficient history. This was
    explicitly accepted, not an oversight.
- **Removal policy:** stocks dropping out of the universe get a **permanent hard delete**
  of their data — not a soft-archive. Accepted deliberately, consistent with keeping the
  database lean (see §6.4).
- **Audit trail:** every quarterly addition/removal is logged (`universe_change_log`,
  §6.4) so "why is this stock gone" has a permanent answer.

### 3.2 Commodities / Global Indices / Crypto
- **Definition:** small, static, manually-curated lists (~25–30 instruments each).
- **Maintenance model:** **not** on the quarterly automated cycle. Changes are manual,
  on-demand actions through the same maintenance screen used for equities — adding an
  instrument triggers a scoped one-time historical backfill (reusing the same backfill
  mechanism as §3.3); removing one triggers the same permanent-erase policy as equities.
  One underlying mechanism, two different triggers (scheduled vs. manual) — not two
  separate systems.

### 3.3 Sectoral (Industry Pools)
- **Not a separate data source.** A synthetic, equal-weighted price index built entirely
  from already-loaded Equities data, grouped by the broader `IndustryGroup` field
  (29 categories — see §4.4 for why this field was chosen over the more granular
  127-category Industry Name field). Requires no independent maintenance; it is
  recomputed whenever the underlying stock data changes.

### 3.4 Historical price sourcing
- **One-time activity:** full historical backfill at initial setup.
- **Recurring:** the same backfill logic runs quarterly, scoped to whatever's newly
  added to the universe that cycle, plus a full-universe re-pull as a backup
  reconciliation check (§3.5).
- Sourcing scripts exist (Python/yfinance-based) for this exact "bulk historical pull"
  shape — see §7 for evaluation and reuse plan.

### 3.5 Daily maintenance (prices)
- **Daily fetch:** incremental — today's new bar(s) only, not a re-pull of full history.
  *No existing script does this yet; it is new engineering* (see §7.3).
- **Corporate-action reconciliation (locked):** the daily job re-fetches and
  **overwrites** a **trailing 60-trading-day window** (not just the newest day) with
  freshly adjusted data each run. This ensures a split or bonus issue is corrected
  within ~1 day, rather than left as a discontinuity until the next quarterly cycle.
  - *Rationale:* corporate actions retroactively re-adjust a stock's entire historical
    series, not just the date of the event. A pure day-by-day append would create a
    silent, uncorrected discontinuity in stored data exactly where MA-based signals
    (including Golden Breakout) are most sensitive to it.
  - *Known residual risk, stated explicitly rather than assumed away:* there is no way
    to verify from this environment how promptly or completely Yahoo Finance's
    adjustment data reflects a corporate action for smaller Indian listings specifically.
    The 60-day window is a safety margin against that uncertainty, not a guarantee.
- **Quarterly full re-pull stays in place** as a backup check on top of daily
  reconciliation — explicitly confirmed as *not* made redundant by the daily process.

### 3.6 Fundamentals
- **Frequency:** annual, refreshed automatically around **June 30**, with an email
  notification to the user when complete.
- **Source:** Yahoo Finance (`yfinance`) — direct pull of Income Statement and Balance
  Sheet data, computing ROE/ROCE/D-E mathematically rather than relying on a
  pre-aggregated third-party summary. See §7.1 for script evaluation.
- **Expected depth:** typically 4 usable fiscal years from Yahoo's free tier (consistent
  with what was also found from the original Trendlyne-sourced data — labeled "5-year,"
  usably 4 in both cases).
- **Known definitional note:** Yahoo's "Fixed Assets" equivalent is **Net PPE**
  (post-depreciation). If prior data used a different definition (e.g., gross block),
  switching sources may show a visible step-change in Fixed-Assets-derived metrics
  (CWIP%, Asset Turnover) at the transition point — not a data error, a definitional
  shift worth being aware of.

---

## 4. Validated Computational Methodology

This is the core intellectual property of the project — every figure below was
backtested against 5 years of real price history for the loaded equity universe, using
consistent methodology (episode-level independent-event counting, not just raw
signal-day counting, to guard against clustering inflating apparent sample size).

### 4.1 RS Rating (Relative Strength)
IBD-style, percentile-ranked against the loaded universe (not a fixed benchmark index —
deliberately dropped in favor of pure population-relative ranking).

- **Weighted price-performance formula**, most recent quarter double-weighted vs. each
  prior quarter:
  - 63 trading days (~3 months): 40%
  - 126 trading days (~6 months): 20%
  - 189 trading days (~9 months): 20%
  - 252 trading days (~12 months): 20%
- **Output:** 1–99 percentile rank, banded (Red <60, Amber 60–79, Green ≥80), with a
  streak counter (consecutive days in the current band).

### 4.2 Composite Fundamental Score
Seven-factor, percentile-weighted model. **Not** used as a gate anywhere in the current
Golden Breakout model (§4.4) — retained purely as a **display-only reference column**
(Fund Tier) for manual cross-referencing, per explicit decision.

**Standard weighting:**
| Factor | Weight |
|---|---|
| ROCE (3yr avg) | 20% |
| ROE (3yr avg) | 15% |
| EPS growth (mean YoY, **not CAGR** — see rationale below) | 15% |
| Sales growth (mean YoY) | 15% |
| Debt/Equity (latest, inverted — lower is better) | 20% |
| Asset Turnover (latest) | 10% |
| Capex Intensity (CWIP % of Fixed Assets) | 5% |

**Financial-sector exemption:** for the 11 verified Industry Name categories below,
Debt/Equity, Asset Turnover, and Capex Intensity are excluded entirely (a lender's
leverage is its business model, not a risk flag), and their combined 35% weight
redistributes to ROE (+17.5% → 32.5%) and EPS growth (+17.5% → 32.5%):

> Banks · Finance (including NBFCs) · Housing Finance · Microfinance Institutions ·
> Financial Institutions · Asset Management Cos. · Capital Markets · Investment
> Companies · General Insurance · Life Insurance · Other Financial Services

*(This list was verified against real Company Master data, not assumed — a naive
substring match on "housing" would have wrongly caught "Warehousing & Logistics";
this was caught and corrected.)*

**Hard penalty overrides:**
- Debt/Equity > 2.0 (non-exempt stocks only): **–20 points**
- Negative EPS growth (mean, 3yr): score **capped at 40**, regardless of other factors
- Final score clamped to [0, 100]

**Tiers:** population-rank quintiles (exactly 20% each by rank position, not fixed score
thresholds) — High / Good / Average / Weak / Poor. This was a deliberate redesign from
an earlier fixed-threshold version that had an unintended scoring gap (51.0–59.9 fell
into no tier at all).

**Why mean growth, not CAGR:** the original design used CAGR for EPS/Sales growth. This
is mathematically undefined whenever the first or last year's value is ≤0 — a real,
common case for cyclical or recovering businesses — and would either error or silently
exclude affected stocks. Replaced with mean year-over-year growth, which handles
negative bases gracefully.

**Partial-data handling:** if a stock is missing some inputs, the score rescales over
whatever metrics *are* available (weights re-normalized), rather than filling gaps with
a neutral/average value. This was a deliberate choice against an alternative
(neutral-fill) approach evaluated and rejected during the review of a third-party
scoring script (§7.2) — neutral-fill treats "unknown" as "exactly average," which is
more misleading than the rescale approach.

### 4.3 Golden Breakout Model — Full Validated Specification

**Scope:** Bullish only, equities-only in terms of validated thresholds (see caveat
below). Single flat ranked list — **no market-cap bucketing** (explicitly removed after
being part of an earlier iteration; see §4.3.4 for why).

**Five Stage-A gates — every one individually backtested, all must pass:**

| # | Gate | Threshold |
|---|---|---|
| 1 | Golden Cross structure | Price > 50DMA > 200DMA |
| 2 | Trend strengthening | 200DMA rising (20-trading-day slope > 0) |
| 3 | Cross separation | (50DMA − 200DMA) / 200DMA ≥ **3%** |
| 4 | Freshness | Golden-cross state streak ≤ **15 trading days** |
| 5 | Short-term trend intact | Price > 8DMA |

**Update (2026-09-05):** Freshness threshold widened from ≤10 to ≤15 trading days per
explicit instruction. Not re-backtested against this specific threshold — the win-rate
and mean-return figures in the backtest table below still reflect the ≤10-day gate;
re-running the backtest at ≤15 days is open, tracked work, not yet done.

**Ranking of survivors:** separation width (descending), then freshness (ascending —
ties broken toward the more recently-triggered signal). Explicitly labeled in the app as
*"sorted by conviction strength,"* not claimed as a second layer of proven edge — a
direct correlation check found none of the remaining factors meaningfully predict
forward returns **within** the already-gate-qualified population (correlations near
zero: freshness 0.02, separation 0.06, squeeze-tightness −0.04 in the now-discarded
squeeze test).

**Volume Breakout % (today's volume ÷ 30-day average) is computed and displayed but is
purely informational** — not a gate, not part of ranking. Explicitly demoted from an
earlier iteration where it was a hard filter.

**Backtest result (5-gate model, real 5-year data, 742-stock universe):**

| Horizon | Win rate | Mean return | Independent episodes |
|---|---|---|---|
| 20 trading days | 58.6% | +4.06% | 467 |
| 60 trading days | 64.2% | +12.05% | 467 |

#### 4.3.1 Parameters tested and explicitly rejected (not toggles — removed entirely)
Per an explicit standing principle: *"any parameter that is not adding value should not
be part of the model — we don't even need a toggle."*

- **RS Rating as a Stage-B filter/gate.** Tested at ≥50/≥70/≥80 thresholds layered on
  top of the 5-gate baseline — neutral to actively harmful (RS≥70 dropped 20-day win
  rate from 59.0% to 54.4%). **Root cause understood, not just observed:** RS Rating is
  inherently backward-looking (3–12 months of trailing performance); Golden Breakout is
  designed to catch *early* turnarounds, which by definition haven't had time to build a
  high trailing RS yet. The two signals are in structural tension, not complementary.
- **Prior-duration / "whipsaw" filter** (require the pre-cross state to have lasted
  ≥30 days). Removing it was flat-to-slightly-better on every metric while expanding the
  opportunity set by 11% (238 → 264 episodes) — the theoretical rationale was sound, but
  the squeeze/freshness/200DMA-slope combination was already catching what this was
  meant to catch. Redundant, not harmful, but redundant filters cost real candidates for
  no return.
- **Bollinger Band compression ("squeeze") as a 6th gate.** This has a real history
  worth recording precisely, because it involved catching and correcting an actual
  analytical error:
  1. Initial backtest (25th percentile squeeze threshold) appeared to show genuine
     improvement (58.0%→59.0% win rate, 63.7%→68.1% at 60 days).
  2. Tightening further, sweeping to 15th percentile, appeared to show the pattern
     continuing (60.8% 20-day win rate — the best result in the sweep).
  3. **While translating this logic into the production JS code, a directional bug was
     found in the original Python percentile formula** — it was actually selecting the
     *widest* bands in each stock's history, not the tightest. Verified directly with an
     unambiguous test case before proceeding.
  4. **Re-ran the corrected version:** genuine compression **does not help** — it
     actively **hurts** performance, worsening as the squeeze tightens (60-day win rate
     fell to 33.3% at the originally-recommended 15th-percentile setting).
  5. **Independently confirmed with a second, differently-computed volatility measure**
     (ATR-based contraction, using true range including gaps rather than closing-price
     dispersion) — same negative pattern, same direction, at every threshold tested.
  6. **Conclusion, now with two independent confirmations:** no volatility-contraction
     measure of any kind belongs in this model. Plausible explanation: a golden cross
     emerging from very low volatility may indicate an illiquid, thinly-traded stock
     rather than a "coiled spring" — thin trading can produce artificially tight ranges
     without the pressure-building dynamic the theory assumes.
- **52-week-high proximity** (originally a hard gate + 20% of ranking weight in an
  earlier pre-Golden-Cross model iteration) — explicitly dropped per instruction; not
  part of the validated model.
- **Fundamental floor** (requiring minimum Composite Score) — explicitly declined;
  Composite Score retained as reference-only.

#### 4.3.2 Bearish / "Death Cross" mirror — tested and rejected
A direct mirror of the bullish model (price < 50DMA < 200DMA, 200DMA falling, etc.) was
built and backtested. **Result: does not work, and should not be treated as a simple
sign-flip of the working bullish model.**

| Horizon | Win rate (price actually fell) | Mean return |
|---|---|---|
| 20 trading days | 42.5% | +4.31% (positive — wrong direction for a short) |
| 60 trading days | 35.9% (worse with more time, not better) | +12.98% |

Confirmed at the independent-episode level too (197 episodes; 58.4% of the time price
actually rose, the opposite of the intended signal). **This reflects a well-documented,
real asymmetry in technical trading** — bearish signals reliably underperform their
bullish counterparts in markets with positive long-term drift, which the Indian
market broadly exhibited across the backtested window. **Status: shelved.** If a genuine
short/bearish signal is wanted later, it needs distinct logic (e.g., breakdown velocity,
distribution volume, relative weakness *versus* a rising market) — not an inverted copy
of the bullish design.

#### 4.3.3 Sector (Industry Group) Relative Strength — built, evidence inconclusive
An equal-weighted synthetic sector index (§3.3), ranked the same percentile way as
stock-level RS, tested as an additional gate. **Result: inconclusive/mixed** — no
meaningful improvement over the simpler universe-wide model, while cutting the candidate
pool by roughly 22%. Not included in the final locked model. The underlying computation
engine (`computeSectoralSeries`) remains in the codebase and powers the standalone
**Sectoral** and **Sectoral Breakout** views (§2.1) — it was not wasted work, but it did
not earn a place as a gate.

#### 4.3.4 Market-cap bucketing — built, tested, then removed from the model entirely
An earlier iteration bucketed the universe by market-cap rank (ranks 1–1000 in hundreds,
then two-hundreds thereafter) with per-bucket top-5 lists, specifically to prevent
micro-cap noise from crowding out a single flat ranking. **Bucketed RS was tested
head-to-head against simple universe-wide RS** — result was a wash (58.5%/62.2% vs.
58.2%/62.7% win rates), with the caveat that the 742-stock sample skews toward large
caps, so this wasn't a full test of where bucketing should matter most (small/micro-cap
separation). **Bucketing was subsequently removed from the Golden Breakout model
entirely** per explicit instruction, in favor of a single flat ranked list. The
computation utilities remain available if bucketing is reconsidered later, but they are
not part of the current locked model.

### 4.4 Market Breadth
Whole-universe (not bucketed — bucketing was removed here too, for the same
simplification reasons as §4.3.4), Equities-only:
- **% of loaded stocks above their own 200DMA**, with 30/100/200-day smoothing overlays
  on the *same* real series (an earlier iteration mistakenly replaced the real series
  with three different threshold measures instead of adding smoothing on top of it —
  caught and corrected when the person noticed the real data line had disappeared).
- **New-highs vs. new-lows ratio** (stocks within ~1% of 52-week high vs. ~1% of
  52-week low).
- Computed as a genuine time series (walking the full history), not just today's
  snapshot — enabling the trend charts.

### 4.5 Classification field choices (verified against real data, not assumed)
- **Stock-level classification:** Industry Name (127 categories) — used for the
  financial-sector exemption list (§4.2) and general sector filtering.
- **Sectoral / Industry Pool grouping:** the broader `IndustryGroup`/`sector_name`
  field (29 categories) — deliberately **not** the 127-category field, because 24 of
  those 127 categories have fewer than 5 constituent stocks in the real data (8 have
  fewer than 3, 3 have exactly one) — too thin to form a meaningful synthetic index.
  The 29-category field has a verified minimum group size of 7.

---

## 5. Application Behavior — UX Principles

- **Meridian is (and in production, must remain) a display and filtering layer, not a
  compute layer** (see §6.2 for the full architectural implication).
- Sortable/filterable tables throughout, consistent interaction pattern across all
  asset classes (sticky headers, per-column range filters via popovers, dropdown-expand
  detail rows).
- Color accents per asset class (gold=Equities, copper=Commodities, blue=Global
  Indices, purple=Crypto) — implemented as accent-prop overrides on a consistent base
  visual language, not full re-themes per asset class.
- Persistent (until-marked-done) in-app alerts for recurring maintenance triggers —
  **acknowledged limitation:** this is a reminder that fires only when the app happens
  to be opened, not a proactive push notification. Production replaces this with real
  email notifications (§6.5).

---

## 6. Production Architecture (Locked)

### 6.1 Why the current artifact cannot become the production app as-is
Client-side artifact storage has a **20MB total cap across all stored data combined**
(distinct from, and in addition to, a per-key ~5MB limit). The real Equities price
history alone is roughly 75MB — a structural, not incidental, mismatch. No amount of
optimization within this environment closes that gap. This is the decisive reason
production requires a real backend and database, not a preference.

### 6.2 Core architectural decision: backend precompute, thin frontend
**Locked model:** raw data storage, computation, and final output are all backend
concerns, in dedicated database tables, independent of Meridian itself. **Meridian
becomes a pure display/filter layer** — it reads already-computed output from the
database when the user opens the app, and all in-app filtering/sorting/searching
happens against that already-computed data. Meridian does **no** computation of its own
in production.

**Compute language: Node.js, not Python — explicitly confirmed.** The backend
compute job reuses Meridian's existing, already-validated JS functions
(`computeTechnicalBlock`, `computeRSUniverse`, `runGoldenBreakoutScreener`,
`computeFundamentalScores`, etc.) directly and unmodified, rather than porting the
logic to Python. **Rationale:** these functions are already pure functions operating on
plain arrays, with no framework dependency — genuinely portable to a Node.js context as-is.
Reimplementing the same logic in a second language would recreate exactly the
dual-codebase drift risk that was identified and explicitly rejected when evaluating a
third-party fundamental-scoring script that had silently reintroduced bugs already found
and fixed in Meridian's own logic (§7.2).

### 6.3 Pipeline (nightly + quarterly)
```
Fetch (Yahoo Finance)
  → 60-trading-day corporate-action reconciliation (§3.5)
  → Compute (Node.js, reusing Meridian's JS engine)
  → Write to output tables
```
The same chain runs nightly (incremental) and quarterly (full universe, post-review).

**Atomicity (locked, 2026-09-05):** the compute step writes into `_staging` copies of
every output table, then a single Postgres transaction renames the live tables to `_old`,
renames `_staging` into their place, and drops `_old` — across all affected tables
together, not one at a time. If compute fails partway, the swap simply never runs and the
previous night's data stays live and consistent. This is what makes it safe for
`technicals_daily`/`sectoral_technicals_daily` to be wholesale-replaced snapshots (§6.4)
rather than append-only history — readers never see a half-updated table.

### 6.4 Database schema (locked)

Full DDL and RLS policies: `supabase-schema.sql`.

**Raw data tables** (one set per asset class where applicable):
- `universe` — asset class, identifier (ISIN for equities, Yahoo ticker for
  Commodities/Indices/Crypto — the identifier column is not uniform across asset
  classes, per §3.2), Symbol, Name, Sector/IndustryGroup, MarketCap, status,
  added/removed dates
- `prices_daily` — adjusted OHLCV time series
- `fundamentals_annual` — Equities only

**Computed output tables** (refreshed by the pipeline; read-only from Meridian's
perspective). **`technicals_daily` and `sectoral_technicals_daily` are SNAPSHOT
tables — one row per instrument, replaced wholesale each run, not a growing daily
history** (locked 2026-09-05; see the storage-sizing note in §9 for why this distinction
matters). The frontend has no requirement to chart historical technicals as a time
series — streaks and bands are scalars recomputed fresh from `prices_daily`'s real
history on every run, not something needing their own persisted history:
- `technicals_daily` — CMP, MAs, RSI, S/M signals + streaks, RS Rating, Volume
  Breakout %, 200DMA slope, Golden Cross state/streak/separation
- `fundamentals_scored` — Composite Score, Tier, full per-metric detail
- `golden_breakout_candidates` — today's qualifying list, precomputed
- `market_breadth_daily` — the breadth series, precomputed once (not recomputed per
  session). This one **is** a genuine time series (one row per trading day, whole-market,
  not per-stock) — it stays small regardless, so the snapshot-vs-history distinction
  above doesn't apply to it.
- `sectoral_technicals_daily` — same shape as `technicals_daily`, keyed by
  IndustryGroup

**Operational tables:**
- `fetch_job_log` — success/failure per run, per asset class; feeds the email
  notification system (§6.5) and closes the "silent failure" gap identified during
  Python script review (§7)
- `universe_change_log` — audit trail of quarterly additions/removals (§3.1)

**User consent:**
- `user_consent` — one row per user, backing the mandatory tracking-disclosure gate
  (§6.6). The one table where the frontend writes directly (owner-only RLS); every
  other table is written only by the service-role pipeline.

**Open gap surfaced while designing RLS (§6.6): no write path exists for the
maintenance screen.** The quarterly Excel universe upload (§3.1) and the "Add Security"
action (§3.2) both require writing to `universe` (and triggering a backfill into
`prices_daily`) — but the RLS design below deliberately grants `authenticated` no write
access to either table, only the service-role pipeline can write. This means those
maintenance actions **cannot run through the public Meridian frontend as currently
scoped** — they need either a separate admin-only tool using the service-role key
directly, or a server-side function (Supabase Edge Function) that authenticates
specifically as the admin and never exposes the service-role key to the browser. Not
yet decided which.

### 6.5 Hosting & notifications (locked)
- **Database:** Supabase (managed Postgres), free tier. Verified against current
  (2026) limits: 500MB storage, 5GB bandwidth, free indefinitely (not a trial).
  Chosen over AWS specifically — AWS's free-tier model changed materially in July 2025
  (now a 6-month, ~$200 expiring credit for new accounts, not a permanent free tier),
  and its billing/setup complexity (6 separate billing dimensions on RDS, VPC/IAM setup)
  is a poor fit for this project's stated priorities.
- **Compute host:** DigitalOcean VPS, ~$5–6/month, running the Node.js cron pipeline.
- **Notifications:** email — quarterly universe-review prompts, annual fundamentals
  completion, and (via `fetch_job_log`) failure alerts for the daily/quarterly jobs.

### 6.6 Access control & analytics (locked)
**Meridian is not public.** Nothing in the architecture above includes access control by
default — left as-is, a thin frontend querying Supabase directly would be open to
anyone with the URL. This was explicitly identified and closed, not an oversight.

**RLS policies (locked, 2026-09-05):** full design in `supabase-schema.sql`. Default-deny
on every table (RLS enabled everywhere); `authenticated` gets read-only `SELECT` on the
tables Meridian's UI displays (`universe`, `prices_daily`, `technicals_daily`,
`sectoral_technicals_daily`, `fundamentals_scored`, `golden_breakout_candidates`,
`market_breadth_daily`); `fundamentals_annual`, `fetch_job_log`, and
`universe_change_log` get no policy at all — locked to the service-role pipeline only,
since the frontend never displays raw fundamentals or operational logs directly.
`user_consent` is the one exception with owner-scoped read/write (`auth.uid() = user_id`)
for the tracking-disclosure gate below. Table-level `GRANT`s are also restricted to
`authenticated` (never `anon`), so both API-layer and RLS-layer checks require a real
session. See §6.4 for the resulting maintenance-screen write-path gap this surfaced.

- **Access model:** invite-only, up to **100 registered users** — not open
  self-registration, not a single shared passcode. Accounts are created/invited
  individually. All authenticated users see the same shared data (no per-user
  personalization) — access control governs *who gets in*, not what they see once
  inside.
- **Mechanism: Supabase Auth**, chosen specifically because Supabase is already the
  database — no separate auth provider needed.
- **A real, easy-to-miss distinction: a login screen alone is not access control.** If
  the frontend queries Supabase directly (the natural pattern for a thin display
  layer), its API key is visible in the browser regardless of any login UI in front of
  it — someone could call the database directly and skip the login entirely. **Real
  enforcement happens at the database level, via Row Level Security (RLS) policies**
  that reject unauthenticated requests outright. The login screen is the front door;
  RLS is the actual lock.
- **Two-key model, already a natural fit for the existing pipeline:** the nightly
  Node.js compute job (§6.2, §6.3) uses Supabase's privileged **service role** key
  (trusted backend process, bypasses RLS by design); the frontend uses the restricted
  **anon** key (gated by RLS policies). No change needed to the pipeline itself — this
  distinction was already implicit in how Supabase separates trust levels.
- **Analytics: PostHog**, free cloud tier. Verified current limits: free up to 1 million
  tracked events/month — at 100 users with casual, regular use, this ceiling would not
  be approached. No self-hosting required, consistent with the project's low-cost,
  low-ops-burden priorities throughout.
  - Chosen specifically over simpler alternatives (Plausible, Umami) because those are
    built for anonymous pageview counting, not for tying tracked activity to an
    authenticated identity — PostHog natively supports identifying a logged-in user
    (via Supabase Auth) and tracking what *that specific person* did.
  - **Time-on-site is automatic**, no setup needed.
  - **"Features explored" requires deliberate instrumentation** — a tracked event per
    meaningful action (e.g., opening the Golden Breakout tab vs. Sectoral vs. Market
    Breadth) — real, scoped frontend work, not something that comes for free just by
    installing the tool.
- **Courtesy note → formal requirement, upgraded per explicit instruction.** Disclosure
  of usage tracking is not just a nice-to-have aside — it is now a real, gated part of
  the login flow: on first access (and reasonably, on any material change to what's
  tracked), the user is shown a plain-language message explaining what's tracked
  (visitor activity, time spent, features used) before they can proceed. **If the user
  declines, they are logged out** — tracking consent is a condition of using the site,
  not an optional toggle that leaves an untracked-but-still-usable path. This is a
  real, deliberate design choice (all-or-nothing consent, not granular opt-out), not a
  default — worth remembering as the reason if it's ever questioned later.
- **Revoking a user's access — the discontinuation mechanism.** Because access is
  enforced at the database level via RLS keyed to a valid Supabase Auth session (not
  just a frontend login screen), revocation is genuinely effective, not cosmetic:
  - **Ban** a user in Supabase Auth — reversible, blocks sign-in while preserving the
    account record. Good fit for "pause," not permanent removal.
  - **Delete** a user — permanent, consistent with the same hard-delete philosophy
    already chosen for the universe/removed-stock policy (§3.1).
  - **A real nuance, not just theoretical:** banning or deleting an account does not
    necessarily kill an *already-active* session instantly. Supabase also supports
    explicitly invalidating a user's active sessions ("sign out everywhere") — the
    belt-and-suspenders step to make revocation take effect immediately rather than
    waiting for a token to expire naturally.
  - At the current scale (~100 invited users), this is a manual action directly in the
    Supabase dashboard — no custom admin UI needed inside Meridian itself. Worth
    revisiting only if user count or revocation frequency grows enough to make the
    manual step genuinely burdensome.
  - **Historical PostHog data is deliberately retained, not purged, on revocation.**
    Revoking access stops *future* tracking (they can no longer log in to generate new
    activity); it does not delete what was already collected about them. Explicit
    decision, made specifically because that history has real, ongoing value for
    future feature development — not an oversight or a privacy afterthought.

### 6.7 Explicitly out of scope for the production app itself
- **Backtesting / parameter experimentation is not an in-app feature.** It has never
  been part of Meridian at any point in this project — every backtest referenced in §4
  was run separately, directly against raw data, outside the app. This is a deliberate,
  confirmed decision, not an oversight: keeping Meridian narrowly focused on displaying
  validated, locked signals avoids reintroducing the kind of untested-parameter-toggle
  sprawl that was deliberately removed from the Golden Breakout model (§4.3.1).
- Backtesting work will live in **Claude Code**, querying Supabase directly for live
  data (avoiding manual CSV export/ETL) — a separate, occasional workflow alongside the
  production app, not inside it.

---

## 7. Data Sourcing Scripts — Evaluation & Reuse Plan

Three existing Python/Colab scripts were reviewed in detail. None can run unattended
as-is (all use Colab-specific `files.upload()`/`files.download()` I/O and broad
`except: pass`/`continue` error-swallowing that would hide failures in an unattended
job) — but they differ significantly in how much of their *logic* is reusable.

### 7.1 Historical fundamentals fetch (Yahoo Finance)
**Reusable as-is (once I/O is swapped for Supabase read/write):**
- ISIN→ticker mapping via official NSE (`EQUITY_L.csv`, `SME_EQUITY_L.csv`) and BSE
  (`scrip.txt`) master lists — reliable, structurally sound approach.
- Direct extraction from `tk.financials` / `tk.balance_sheet` with fallback field-name
  matching (`safe_get()`).
- **Output schema matches Meridian's existing fundamentals pipeline schema closely** —
  a genuinely favorable finding, meaning this can plausibly replace the dropped
  Trendlyne source with minimal downstream disruption.

**Needs fixing before production use:**
- Add real logging (per-stock success/failure), not silent exception-swallowing.
- Add rate-limiting between the ~2,000 sequential Yahoo calls.
- Note: no meaningful "incremental" version needed — fundamentals only change annually;
  the real fix needed is making the *existing* bulk logic unattended and idempotent
  (upsert by ISIN+Year), not building a new incremental mode.

### 7.2 Standalone fundamental composite-scoring script — discarded
Reviewed and found to reintroduce four issues already identified and fixed in
Meridian's own logic:
1. CAGR-based growth calculation (the exact mathematical landmine — undefined for
   negative base years — that Meridian's mean-growth approach was built to avoid).
2. No financial-sector exemption at all.
3. Fixed 80/60/40 tier thresholds (the version with the known 51–59.9 scoring gap,
   already replaced in Meridian with population-quintile tiers).
4. Neutral-fill (50.0) for missing metrics rather than rescaling weights over available
   data.

**Locked decision: discarded entirely, not merged.** Meridian's own Composite Score
logic remains the single source of truth (§4.2, §6.2).

### 7.3 Historical price fetch (Yahoo Finance) — reusable for bulk, not for daily
**Reusable as-is (once I/O is fixed):** ISIN/ticker mapping (shared with §7.1), batched
`yf.download(threads=True)` mechanics, `auto_adjust=True` for corporate actions. This is
a strong fit for the one-time initial backfill and the quarterly full-universe re-pull
(§3.4).

**Not reusable for the daily job — needs new engineering, not adaptation:**
The script re-fetches the full 5-year window on every run. A true daily incremental job
needs a fundamentally different design:
- A stored **watermark** (last successfully-fetched date) per instrument, in Supabase.
- A hard distinction between **"no new data"** and **"fetch failed"** — a failure must
  not advance the watermark, so the next run naturally retries the missed day. This is
  the single most important correctness property for the daily job.
- **Idempotent writes** (upsert by ISIN+Date), not blind append.
- The 60-trading-day corporate-action reconciliation window (§3.5) layered on top.

---

## 8. Explicitly Locked Decisions — Consolidated Checklist

For quick reference; each item traces to a fuller explanation above.

- [x] Universe: user-defined ISINs, quarterly review, corporate-action-adjust-or-exclude
      gap policy, permanent hard delete on removal
- [x] Commodities/Indices/Crypto: static lists, manual on-demand maintenance
- [x] Sectoral: derived compute on `IndustryGroup` (29-category field), not separately
      maintained
- [x] Daily price job: incremental + 60-day corporate-action reconciliation window
- [x] Quarterly full re-pull retained as backup check, not redundant with daily job
- [x] Compute: backend, Node.js, reusing Meridian's existing JS functions unmodified
- [x] Meridian: pure display/filter layer in production, zero compute
- [x] Database: Supabase (Postgres, free tier)
- [x] Compute host: DigitalOcean VPS (~$5–6/mo)
- [x] Notifications: email
- [x] Table schema: as specified in §6.4
- [x] Fundamentals/price source: Yahoo Finance (Trendlyne dropped — API-vs-manual
      status was never resolved, and became moot)
- [x] Fundamental-scoring methodology: Meridian's own logic only, third-party script
      discarded
- [x] Golden Breakout model: 5-gate bullish-only model as specified in §4.3, no
      toggles for rejected parameters
- [x] Backtesting: stays outside the production app, moves to Claude Code long-term,
      querying Supabase directly
- [x] Access control: invite-only, up to 100 users, Supabase Auth + Row Level Security
      (not just a frontend login screen)
- [x] Analytics: PostHog free cloud tier, tied to authenticated identity, tracking
      visitor counts, time spent, and feature usage
- [x] Tracking disclosure: mandatory, gated login step — decline logs the user out
      (all-or-nothing consent, not an optional toggle)
- [x] User revocation: Supabase Auth ban (reversible) or delete (permanent), plus
      explicit active-session invalidation, handled manually via the Supabase
      dashboard at current scale; historical PostHog data is retained, not purged, on
      revocation — deliberately kept for future feature-development value

---

## 9. Open Items — Not Yet Resolved

1. ~~Precise Supabase storage-footprint calculation.~~ **Resolved (2026-09-05), against
   real data.** `prices_daily` dominates the footprint by a wide margin (fundamentals and
   universe tables are trivial even at full scale). Using the real 742-stock price file
   (807,339 rows, 67.4MB as CSV) as a baseline: a normalized table (surrogate `stock_id`
   instead of repeating the ISIN text, `numeric`/`date` types instead of full-precision
   text floats) plus its index lands around 60–70MB at today's partial universe, scaling
   to **roughly 150–200MB at the full ~1,800–2,000-stock target** — comfortably under the
   500MB free tier, **provided `technicals_daily`/`sectoral_technicals_daily` are built
   as snapshot tables, not append-only daily history** (now locked, §6.4) — that
   distinction was the single biggest swing factor and is why this is resolved rather
   than still open.
2. **Real data sourcing for Commodities, Global Indices, and Crypto** — currently
   sample/synthetic data only; real sourcing plan (also via Yahoo Finance, per §3.6's
   asset-class-agnostic coverage) not yet scoped in detail.
3. **Golden Breakout thresholds for non-Equity asset classes and Sectoral are
   unvalidated.** The 5-gate model (§4.3) was backtested exclusively against equities.
   Commodities/Indices/Crypto/Sectoral currently reuse the identical thresholds with an
   explicit in-app disclaimer that they haven't been separately tested — not a
   confirmed-safe assumption.
4. **Timing of the Claude Code migration** — deliberately deferred ("closer to
   production" was the original trigger condition); this document is intended to make
   that transition low-friction whenever it happens, not to force the timing.
5. **Whether a genuine, non-mirrored bearish/short signal gets built eventually** —
   shelved, not abandoned (§4.3.2).
6. **Where the Meridian frontend itself gets served from in production.** The
   DigitalOcean VPS (§6.5) was scoped specifically for the cron pipeline, not
   necessarily for hosting the web app itself — a separate static host (Vercel,
   Netlify, Cloudflare Pages, often free at this scale) serving the React frontend,
   which then talks to Supabase directly, is a common, low-cost pattern, but this
   hasn't been explicitly decided.
7. **PostHog event instrumentation is not yet scoped.** Which specific actions get
   tracked (which tabs, which interactions) beyond the automatic visitor/time-on-site
   metrics has not been defined — a real, small design task, not just a config setting.

---

## 10. File Inventory — Inputs & Outputs

A complete, verified accounting of every file associated with the project, checked
directly against the actual workspace rather than reconstructed from memory — meant to
be the authoritative list of what belongs in the GitHub repository.

### 10.1 Current, relevant files (repository-ready)

| Type | File | What it is |
|---|---|---|
| Input | `meridian-company-master-742.csv` | Real Equities master data |
| Input | `meridian-price-history-742.csv` | Real Equities price history (~67MB) |
| Input | `meridian-fundamentals-742.csv` | Real Equities fundamentals |
| Input | `meridian-commodities-master-sample.csv` + `-prices-sample.csv` | Sample data, Commodities |
| Input | `meridian-indices-master-sample.csv` + `-prices-sample.csv` | Sample data, Global Indices |
| Input | `meridian-crypto-master-sample.csv` + `-prices-sample.csv` | Sample data, Crypto |
| Output | `meridian.jsx` | The application |
| Output | `meridian-sample.xlsx` | The parallel Excel workbook deliverable (§2.2) |
| Output | `meridian-requirements.md` | This document (vision, methodology, locked architecture) |
| Output | `meridian_backtest.py` | The consolidated, authoritative backtest script |

**Status check (2026-09-05):** `meridian-price-history-742.csv` is now present in the
repository (67.4MB, delivered compressed and reconstituted directly rather than through
GitHub's web uploader, which caps well below this file's size). Verified directly:
`ISIN,Date,High,Low,Close,Volume` schema matching `meridian_backtest.py`'s loader, 742
distinct ISINs matching the Company Master, no duplicate (ISIN, Date) rows, no malformed
or null fields, date range 2021-08-09 to 2026-08-07 (~5 years).

**A finding surfaced during that verification, corrected after clarification:** row
counts per ISIN range from 159 to 1,239 trading days (a full 5-year span is ~1,250). An
initial read flagged this against the *5-year backtest depth* and looked like a large
policy violation — but the 5-year depth is a backtest-sample-size need, not what the
*live* signals require. The longest lookback any production signal actually needs is
~252 trading days (RS Rating's 12-month window; the 200DMA itself needs 200). Measured
against that, the real bar, the picture is materially smaller:

- **707 of 742 stocks (95.3%)** have ≥252 days — fully fine for every live signal.
- **16 stocks (2.2%)** have 200–251 days — enough for the 200DMA-based Golden Breakout
  gates, just short of full RS Rating depth.
- **19 stocks (2.6%)** have <200 days — genuinely can't support live signals yet. Checked
  against the Company Master by name: these are all identifiable recent IPOs (e.g. ICICI
  Prudential AMC, Meesho, Groww, Lenskart, Pine Labs, PhysicsWallah, Wakefit, Capillary
  Technologies) — exactly the "recent listings without enough trading history yet" case
  §3.1 already anticipated, not a data-quality problem.

**Still an open decision:** whether those 19 should be hard-excluded from the universe
now per §3.1's literal wording ("excluded entirely, not carried with a partial series"),
or left in with their signals naturally null until they age past 200 days — both are
defensible once "look-back period" is understood as the ~200–252-day production
requirement rather than the 5-year backtest window.

### 10.2 Deliberately excluded — historical, not current

Kept out of the repository-ready set on purpose, not by oversight. Listed here so a
later reader doesn't wonder why an earlier-referenced file is missing, or mistake it
for something still current:

- **`bharat-screener.jsx` and `bharat-screener-sample.xlsx`** — the project's original
  pre-rename files, from before the Golden Breakout redesign and multi-asset framework
  (§2.1 notes the original "Bharat Screener" name). Superseded completely, not
  incrementally, by `meridian.jsx` and `meridian-sample.xlsx`.
- **`nifty50-company-master.csv` and the two `meridian-universe-isins-*.xlsx` files** —
  early-stage universe-scoping artifacts from before the 742-stock Company Master
  became the real, current input.
- **`refresh_technicals.py`** — the original NSE bhavcopy daily-automation script. This
  predates the later, locked decision to use Yahoo Finance for daily fetching (§3.6,
  §7.3), and it was never tested against a live server from within this chat
  environment (§2.3). Excluded specifically so it isn't mistaken for current guidance
  when it no longer reflects the locked architecture.

### 10.3 A real redundancy, resolved by context rather than by data difference

The 8 split price-history files (`meridian-price-history-742-part1of8.csv` through
`part8of8.csv`) contain the exact same underlying data as the single
`meridian-price-history-742.csv` — they were created specifically as a workaround for a
browser-based upload crash encountered while using the client-side artifact (§2.3).
**Excluded from the repository set:** Claude Code reads files directly from the
repository rather than through a browser upload flow, so the crash they were built to
work around does not apply in that context, and the split files add no value there.

---

## 11. Source of Truth for Code

`meridian.jsx` in this repository is the current, authoritative application source —
read it directly rather than a copy. This document covers the *why* (vision, validated
methodology, locked architecture decisions and their rationale); the code itself,
along with `meridian_backtest.py` and `supabase-schema.sql`, covers the *what*.

**Not embedded here on purpose, as of 2026-09-05.** An earlier version of this document
carried the complete `meridian.jsx` source verbatim in this section. That was useful
early on, but it created a real, demonstrated maintenance cost: a single one-line
threshold change (the Golden Breakout freshness gate, §4.3) had to be hand-synced across
two files, and this document briefly went stale relative to the code as a result. Going
forward, any future backend implementation (§6.2) should extract the pure computation
functions — `computeTechnicalBlock`, `computeRSUniverse`, `runGoldenBreakoutScreener`,
`computeFundamentalScores`, `computeSectoralSeries`, `computeBreadthSeries`, and their
supporting helpers — directly from `meridian.jsx`, not from a snapshot in this document.
