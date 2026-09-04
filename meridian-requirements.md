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
| 4 | Freshness | Golden-cross state streak ≤ **10 trading days** |
| 5 | Short-term trend intact | Price > 8DMA |

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

### 6.4 Database schema (locked)

**Raw data tables** (one set per asset class where applicable):
- `universe` — ISIN/Symbol, Name, Sector/IndustryGroup, MarketCap, status,
  added/removed dates
- `prices_daily` — adjusted OHLCV time series
- `fundamentals_annual` — Equities only

**Computed output tables** (refreshed by the pipeline; read-only from Meridian's
perspective):
- `technicals_daily` — CMP, MAs, RSI, S/M signals + streaks, RS Rating, Volume
  Breakout %, 200DMA slope, Golden Cross state/streak/separation
- `fundamentals_scored` — Composite Score, Tier, full per-metric detail
- `golden_breakout_candidates` — today's qualifying list, precomputed
- `market_breadth_daily` — the breadth series, precomputed once (not recomputed per
  session)
- `sectoral_technicals_daily` — same shape as `technicals_daily`, keyed by
  IndustryGroup

**Operational tables:**
- `fetch_job_log` — success/failure per run, per asset class; feeds the email
  notification system (§6.5) and closes the "silent failure" gap identified during
  Python script review (§7)
- `universe_change_log` — audit trail of quarterly additions/removals (§3.1)

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

1. **Precise Supabase storage-footprint calculation.** The 500MB free-tier ceiling has
   not yet been checked against the actual expected size of a properly-normalized
   relational schema (expected to be meaningfully smaller than the raw CSV/JSON
   footprint, but not yet calculated precisely).
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

## 10. Complete Current Source — `meridian.jsx`

This is the literal, complete, current source file — not a description of it. Per §5
(this document's own stated purpose), the requirements above explain *why* every
formula and threshold is what it is; this section is the *what*, verbatim, so nothing
needs to be reconstructed from prose. Any future backend implementation (§6.2) should
extract the pure computation functions from this file directly — `computeTechnicalBlock`,
`computeRSUniverse`, `runGoldenBreakoutScreener`, `computeFundamentalScores`,
`computeSectoralSeries`, `computeBreadthSeries`, and their supporting helpers — rather
than reimplementing them from the specification in §4.

```jsx
import React, { useState, useEffect, useMemo, useCallback } from "react";
import Papa from "papaparse";
import { Upload, ChevronDown, ChevronRight, TrendingUp, TrendingDown, Minus, Search, RotateCcw, Star, Plus, X, ListPlus, Filter, Bell } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

// ---------- Design tokens ----------
// Deep indigo ledger aesthetic, gold accent, green/red reserved strictly for gain/loss semantics.
const T = {
  bg: "#14192B",
  surface: "#1B2140",
  surfaceAlt: "#232A4D",
  border: "#323A63",
  text: "#EDEAE0",
  textDim: "#9AA2C0",
  gold: "#C9A227",
  gain: "#4CAF7D",
  loss: "#D46A6A",
  amber: "#E0983E",
  neutral: "#8890A6",
};

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
`;

// ---------- Sample / demo data (clearly synthetic, for pilot only) ----------
const SAMPLE_MASTER = [
  { ISIN: "INE002A01018", Symbol: "RELIANCE", Name: "Reliance Industries", Sector: "Energy", IndustryGroup: "Oil & Gas", MarketCap: 1750000, PE: 24.1 },
  { ISIN: "INE467B01029", Symbol: "TCS", Name: "Tata Consultancy Services", Sector: "IT", IndustryGroup: "Information Technology", MarketCap: 1420000, PE: 27.8 },
  { ISIN: "INE040A01034", Symbol: "HDFCBANK", Name: "HDFC Bank", Sector: "Financials", IndustryGroup: "Banking and Finance", MarketCap: 1280000, PE: 18.4 },
  { ISIN: "INE154A01025", Symbol: "ITC", Name: "ITC Ltd", Sector: "FMCG", IndustryGroup: "Fast Moving Consumer Goods", MarketCap: 540000, PE: 22.9 },
  { ISIN: "INE075A01022", Symbol: "WIPRO", Name: "Wipro Ltd", Sector: "IT", IndustryGroup: "Information Technology", MarketCap: 260000, PE: 20.3 },
  { ISIN: "INE752E01010", Symbol: "POWERGRID", Name: "Power Grid Corp", Sector: "Utilities", IndustryGroup: "Power", MarketCap: 300000, PE: 15.2 },
];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function genSamplePrices(isin, basePrice, days = 400) {
  const rand = seededRandom(isin.split("").reduce((a, c) => a + c.charCodeAt(0), 0));
  const rows = [];
  let price = basePrice;
  const start = new Date();
  start.setDate(start.getDate() - days);
  for (let i = 0; i < days; i++) {
    const drift = (rand() - 0.47) * 0.018;
    price = Math.max(price * (1 + drift), 1);
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    rows.push({
      ISIN: isin,
      Date: d.toISOString().slice(0, 10),
      Close: Number(price.toFixed(2)),
      Volume: Math.round(500000 + rand() * 2000000),
    });
  }
  return rows;
}

function genSampleFundamentals(isin, seed) {
  const rand = seededRandom(seed);
  const years = ["FY23", "FY24", "FY25", "FY26"];
  let equity = 100000, sales = 200000, eps = 40;
  return years.map((fy, i) => {
    equity *= 1 + 0.08 + rand() * 0.05;
    sales *= 1 + 0.06 + rand() * 0.08;
    eps *= 1 + 0.05 + rand() * 0.1;
    const netProfit = equity * (0.12 + rand() * 0.08);
    const capEmployed = equity * (1.3 + rand() * 0.2);
    const ebit = capEmployed * (0.14 + rand() * 0.06);
    const debt = equity * (0.2 + rand() * 0.4);
    const fixedAssets = sales / (0.9 + rand() * 0.6);
    const cwip = fixedAssets * (0.02 + rand() * 0.08);
    return {
      ISIN: isin, FY: fy,
      ROE_Pct: Number(((netProfit / equity) * 100).toFixed(2)),
      ROCE_Pct: Number(((ebit / capEmployed) * 100).toFixed(2)),
      DebtEquity: Number((debt / equity).toFixed(3)),
      EPS: Number(eps.toFixed(2)), Sales: Math.round(sales),
      FixedAssets: Math.round(fixedAssets), CWIP: Math.round(cwip),
    };
  });
}

const SAMPLE_PRICES = SAMPLE_MASTER.flatMap((m) => genSamplePrices(m.ISIN, m.PE * 100));
const SAMPLE_FUND = SAMPLE_MASTER.flatMap((m, idx) => genSampleFundamentals(m.ISIN, idx + 7));

// ---------- Commodities: sample data (synthetic) ----------
const SAMPLE_COMMODITIES = [
  { Symbol: "GOLD", Name: "Gold", Unit: "₹/10g" },
  { Symbol: "SILVER", Name: "Silver", Unit: "₹/kg" },
  { Symbol: "CRUDEOIL", Name: "Crude Oil", Unit: "₹/bbl" },
  { Symbol: "NATURALGAS", Name: "Natural Gas", Unit: "₹/mmBtu" },
];
const COMMODITY_BASE_PRICES = { GOLD: 62000, SILVER: 78000, CRUDEOIL: 6200, NATURALGAS: 250 };
// Reuses genSamplePrices — its "ISIN" field is repurposed to hold the commodity Symbol.
const SAMPLE_COMMODITY_PRICES = SAMPLE_COMMODITIES.flatMap((c) => genSamplePrices(c.Symbol, COMMODITY_BASE_PRICES[c.Symbol]));

// ---------- Asset class configuration (drives the generic screens) ----------
const ASSET_CLASSES = {
  commodities: {
    key: "commodities", label: "Commodities", labelSingular: "commodity", accent: "#C87941",
    storagePrefix: "screener-commodities", extraMasterFields: ["Unit"],
    sampleMaster: SAMPLE_COMMODITIES, samplePrices: SAMPLE_COMMODITY_PRICES,
  },
  indices: {
    key: "indices", label: "Global Indices", labelSingular: "index", accent: "#5B8DEF",
    storagePrefix: "screener-indices", extraMasterFields: ["Region"],
    sampleMaster: [], samplePrices: [],
  },
  crypto: {
    key: "crypto", label: "Crypto", labelSingular: "coin", accent: "#A46EF5",
    storagePrefix: "screener-crypto", extraMasterFields: [],
    sampleMaster: [], samplePrices: [],
  },
};

// ---------- Sectoral: synthetic equal-weighted price index per IndustryGroup ----------
// Derived entirely from stock data already loaded — not a separate upload. Builds a
// real, date-aligned synthetic price series per sector (not just a ranking, unlike the
// earlier sector-RS-only version), so it can run through the full technical engine —
// same MAs, same golden cross, same everything — exactly like a real instrument would.
function computeSectoralSeries(masterList, prices) {
  const priceByISIN = {};
  prices.forEach((r) => { (priceByISIN[r.ISIN] ||= []).push(r); });
  const allDates = Array.from(new Set(prices.map((r) => r.Date))).sort();

  const bySector = {};
  masterList.forEach((m) => {
    const g = m.IndustryGroup;
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


// ---------- Computation engine ----------
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

// ---------- Chunked persistent storage ----------
// window.storage caps each key at 5MB. A full price-history load (hundreds of
// thousands of rows) is tens of MB as JSON, so it silently failed to save under
// a single key — this is why data wasn't surviving between sessions. Splitting
// it across many keys, each safely under the cap, fixes that.
const STORAGE_CHUNK_SIZE = 40000; // rows per chunk — keeps each chunk well under 5MB

async function saveChunkedArray(baseKey, arr) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += STORAGE_CHUNK_SIZE) chunks.push(arr.slice(i, i + STORAGE_CHUNK_SIZE));
  for (let i = 0; i < chunks.length; i++) {
    await window.storage.set(`${baseKey}-chunk-${i}`, JSON.stringify(chunks[i]), false);
  }
  // clean up any stale chunks left over from a previous, larger save
  let i = chunks.length;
  while (true) {
    try {
      const existing = await window.storage.get(`${baseKey}-chunk-${i}`, false);
      if (!existing) break;
      await window.storage.delete(`${baseKey}-chunk-${i}`, false);
      i++;
    } catch (e) { break; }
  }
  await window.storage.set(`${baseKey}-meta`, JSON.stringify({ count: chunks.length, totalRows: arr.length }), false);
}

// Lightweight save check: reads only the small meta key and compares the row COUNT it
// recorded at save time — never reloads and re-parses the actual chunked data, which for
// a large dataset would mean holding two full copies in memory simultaneously (this is
// exactly what caused real upload crashes on the full price history).
async function verifyChunkedArraySaved(baseKey, expectedRows) {
  try {
    const metaRes = await window.storage.get(`${baseKey}-meta`, false);
    if (!metaRes || !metaRes.value) return expectedRows === 0;
    const { totalRows } = JSON.parse(metaRes.value);
    return totalRows === expectedRows;
  } catch (e) { return false; }
}

async function loadChunkedArray(baseKey) {
  try {
    const metaRes = await window.storage.get(`${baseKey}-meta`, false);
    if (!metaRes || !metaRes.value) return [];
    const { count } = JSON.parse(metaRes.value);
    let out = [];
    for (let i = 0; i < count; i++) {
      try {
        const res = await window.storage.get(`${baseKey}-chunk-${i}`, false);
        if (res && res.value) out = out.concat(JSON.parse(res.value));
      } catch (e) { console.error(`Missing storage chunk ${i} for ${baseKey}`); }
    }
    return out;
  } catch (e) { return []; }
}

async function deleteChunkedArray(baseKey) {
  try {
    const metaRes = await window.storage.get(`${baseKey}-meta`, false);
    if (metaRes && metaRes.value) {
      const { count } = JSON.parse(metaRes.value);
      for (let i = 0; i < count; i++) {
        try { await window.storage.delete(`${baseKey}-chunk-${i}`, false); } catch (e) {}
      }
    }
    await window.storage.delete(`${baseKey}-meta`, false);
  } catch (e) { /* nothing to delete */ }
}

function flagFor(lastYr, avg3, invert = false) {
  if (lastYr == null || avg3 == null || avg3 === 0) return { flag: "neutral", variationPct: null };
  const variationPct = ((lastYr - avg3) / Math.abs(avg3)) * 100;
  let flag = "neutral";
  if (Math.abs(variationPct) >= 3) {
    const better = invert ? lastYr < avg3 : lastYr > avg3;
    flag = better ? "improvement" : "deterioration";
  }
  return { flag, variationPct };
}

function computeFundamentalBlock(fundRows) {
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
const FINANCIAL_INDUSTRIES = new Set([
  "Banks", "Finance (including NBFCs)", "Housing Finance", "Microfinance Institutions",
  "Financial Institutions", "Asset Management Cos.", "Capital Markets", "Investment Companies",
  "General Insurance", "Life Insurance", "Other Financial Services",
]);

// Rank-based percentile, 0 (worst) to 100 (best). `invert` flips direction for metrics
// where lower is better (Debt/Equity).
function percentileRank0to100(pairs, invert = false) {
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
function computeFundamentalScores(stocks) {
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
function rollingSMASeries(closes, n) {
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
function streakFromStateSeries(stateSeries, maxLookback = 750) {
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

function computeRSI(closes, period = 14) {
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

function computeTechnicalBlock(priceRows) {
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
    mStateSeries[key] = closes.map((_, i) => {
      const va = maSeries[a][i], vb = maSeries[b][i];
      return va != null && vb != null ? va > vb : null;
    });
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
  const goldenStateSeries = closes.map((_, i) => {
    const v50 = maSeries[50][i], v200 = maSeries[200][i];
    return v50 != null && v200 != null ? v50 > v200 : null;
  });
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
const RS_COMPONENTS = [
  { lag: 63, weight: 0.4 },   // ~3 months
  { lag: 126, weight: 0.2 },  // ~6 months
  { lag: 189, weight: 0.2 },  // ~9 months
  { lag: 252, weight: 0.2 },  // ~12 months
];

function closesByKeyFromPrices(rows, keyField) {
  const grouped = {};
  rows.forEach((r) => { (grouped[r[keyField]] ||= []).push(r); });
  const closes = {};
  Object.entries(grouped).forEach(([k, arr]) => {
    closes[k] = arr.slice().sort((a, b) => a.Date.localeCompare(b.Date)).map((r) => r.Close);
  });
  return closes;
}

function rawRSScoreAsOf(closes, daysAgo) {
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

function bandOfRSRating(rating) {
  if (rating == null) return null;
  if (rating < 60) return "red";
  if (rating < 80) return "amber";
  return "green";
}

// Returns { [id]: { rating, band, streakDays, capped } } for every id in closesById.
// streakDays = consecutive trading days (including today) the rating has stayed
// in its current color band; capped = true if it never changed within maxLookbackDays.
function computeRSUniverse(closesById, maxLookbackDays = 500) {
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
function computeBreadthSeries(stockList, closesById, lookbackDays = 500) {
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
const GOLDEN_BREAKOUT_PARAMS = {
  minSeparationPct: 3,   // 50DMA must be at least this far above 200DMA
  freshnessMaxDays: 10,  // the golden-cross state must be this recent or fresher
};

function passesGoldenBreakout(stock, params = GOLDEN_BREAKOUT_PARAMS) {
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
function rankGoldenBreakoutCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const sepDiff = (b.tech.separationPct ?? -Infinity) - (a.tech.separationPct ?? -Infinity);
    if (sepDiff !== 0) return sepDiff;
    return (a.tech.goldenCrossStreak?.streak ?? Infinity) - (b.tech.goldenCrossStreak?.streak ?? Infinity);
  });
}

function runGoldenBreakoutScreener(computedStocks, params = GOLDEN_BREAKOUT_PARAMS) {
  const candidates = computedStocks.filter((s) => passesGoldenBreakout(s, params));
  return rankGoldenBreakoutCandidates(candidates);
}

function computeAll(master, fundamentals, prices) {
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

// ---------- UI helpers ----------
function fmtCr(v) {
  if (v == null) return "—";
  return `₹${Math.round(v).toLocaleString("en-IN")} Cr`;
}
function fmtNum(v, d = 1) { return v == null || isNaN(v) ? "—" : v.toFixed(d); }
function fmtPct(v, d = 1) { return v == null || isNaN(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`; }

function FlagBadge({ flag }) {
  if (!flag) return <span style={{ color: T.textDim }}>—</span>;
  const map = {
    improvement: { color: T.gain, icon: <TrendingUp size={12} />, label: "Improving" },
    deterioration: { color: T.loss, icon: <TrendingDown size={12} />, label: "Deteriorating" },
    neutral: { color: T.neutral, icon: <Minus size={12} />, label: "Neutral" },
  };
  const cfg = map[flag];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: cfg.color, fontSize: 11, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace" }}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

function RSRatingBadge({ rsRating }) {
  if (!rsRating || rsRating.rating == null) return <span style={{ color: T.textDim }}>—</span>;
  const colorMap = { red: T.loss, amber: T.amber, green: T.gain };
  const color = colorMap[rsRating.band];
  const streakLabel = rsRating.capped ? `${rsRating.streakDays}+d` : `${rsRating.streakDays}d`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{
        fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, fontSize: 12, padding: "2px 7px", borderRadius: 4,
        color, background: `${color}22`, border: `1px solid ${color}`,
      }}>{rsRating.rating}</span>
      <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'IBM Plex Mono', monospace" }}>{streakLabel}</span>
    </span>
  );
}

const FUND_TIER_COLORS = { High: "#4CAF7D", Good: "#8FC97D", Average: "#9AA2C0", Weak: "#E0983E", Poor: "#D46A6A" };

function FundTierBadge({ fundScore }) {
  if (!fundScore || fundScore.score == null) return <span style={{ color: T.textDim }}>—</span>;
  const color = FUND_TIER_COLORS[fundScore.tier] || T.textDim;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{
        fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700, fontSize: 11, padding: "2px 7px", borderRadius: 4,
        color, background: `${color}22`, border: `1px solid ${color}`,
      }}>{fundScore.tier}</span>
      <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'IBM Plex Mono', monospace" }}>{fundScore.score.toFixed(1)}{fundScore.exempt ? "*" : ""}</span>
    </span>
  );
}

function SignalPill({ active, label, streak, capped }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "baseline", gap: 3, minWidth: 26, textAlign: "center", padding: "2px 5px", borderRadius: 3,
      fontSize: 10, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600,
      background: active == null ? "transparent" : active ? "rgba(76,175,125,0.15)" : "rgba(212,106,106,0.12)",
      color: active == null ? T.textDim : active ? T.gain : T.loss,
      border: `1px solid ${active == null ? T.border : active ? T.gain : T.loss}`,
    }}>
      {label}
      {streak != null && <span style={{ fontSize: 8.5, opacity: 0.85 }}>{capped ? `${streak}+` : streak}</span>}
    </span>
  );
}

function FundRow({ label, block, isPercent = true }) {
  if (!block) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 70px 70px 70px 1fr", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${T.border}` }}>
      <span style={{ fontSize: 12, color: T.textDim }}>{label}</span>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>{fmtNum(block.avg3)}{isPercent ? "%" : "x"}</span>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 600 }}>{fmtNum(block.lastYr)}{isPercent ? "%" : "x"}</span>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: T.textDim }}>{fmtPct(block.variationPct)}</span>
      <FlagBadge flag={block.flag} />
    </div>
  );
}

// ---------- Column filtering (numeric range filters, Excel-style) ----------
// Stock name and CMP are intentionally excluded — filtering by exact price/name
// isn't useful; everything else that's a single scalar value gets a range filter.
const FILTERABLE_COLUMNS = {
  changePct: { label: "1D %", accessor: (s) => s.tech?.changePct },
  MarketCap: { label: "Mkt Cap", accessor: (s) => s.MarketCap },
  PE: { label: "P/E", accessor: (s) => s.PE },
  ROE: { label: "ROE (LY)", accessor: (s) => s.fund?.roe?.lastYr },
  fundTier: { label: "Fund Score", accessor: (s) => s.fund?.score?.score },
  RSI: { label: "RSI", accessor: (s) => s.tech?.rsi },
  relStrength: { label: "RS Rating", accessor: (s) => s.tech?.rsRating?.rating },
  pctFromHigh52: { label: "% fr 52wH", accessor: (s) => s.tech?.pctFromHigh52 },
  pctFromLow52: { label: "% fr 52wL", accessor: (s) => s.tech?.pctFromLow52 },
  volBreakout: { label: "Vol Breakout %", accessor: (s) => s.tech?.volBreakoutPct },
};

function NumFilterPopover({ colKey, label, current, onApply, onClear, onClose }) {
  const [min, setMin] = useState(current?.min ?? "");
  const [max, setMax] = useState(current?.max ?? "");
  return (
    <div onClick={(e) => e.stopPropagation()} style={{
      position: "absolute", top: "120%", left: 0, zIndex: 30, background: T.surfaceAlt,
      border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, minWidth: 150,
      boxShadow: "0 4px 16px rgba(0,0,0,0.5)", textTransform: "none", letterSpacing: "normal", fontWeight: 400,
    }}>
      <div style={{ fontSize: 11, color: T.textDim, marginBottom: 6 }}>Filter {label}</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <input type="number" placeholder="Min" value={min} onChange={(e) => setMin(e.target.value)}
          style={{ width: 62, padding: "5px 6px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }} />
        <input type="number" placeholder="Max" value={max} onChange={(e) => setMax(e.target.value)}
          style={{ width: 62, padding: "5px 6px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }} />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => { onApply(colKey, { min: min === "" ? null : Number(min), max: max === "" ? null : Number(max) }); onClose(); }}
          style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.gold}`, background: "rgba(201,162,39,0.12)", color: T.gold, fontSize: 11, fontWeight: 600 }}>Apply</button>
        <button onClick={() => { onClear(colKey); onClose(); }}
          style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11 }}>Clear</button>
      </div>
    </div>
  );
}

// ---------- Commodities Screen (standalone: technicals only, no fundamentals) ----------
// A lightweight sibling to GenericAssetScreen — reads the SAME persisted storage (so it
// stays in sync with whatever's loaded on the base data tab without sharing React state),
// computes technicals + RS, and runs the Golden Breakout screener against it.
function GenericGoldenBreakoutScreen({ config }) {
  const [master, setMaster] = useState([]);
  const [prices, setPrices] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const metaRes = await window.storage.get(`${config.storagePrefix}-meta`, false);
        if (metaRes && metaRes.value) setMaster(JSON.parse(metaRes.value).master || []);
        const loadedPrices = await loadChunkedArray(`${config.storagePrefix}-prices`);
        setPrices(loadedPrices);
      } catch (e) { /* no saved data yet */ }
    })();
  }, [config.storagePrefix]);

  const closesById = useMemo(() => closesByKeyFromPrices(prices, "ISIN"), [prices]);
  const rsUniverse = useMemo(() => computeRSUniverse(closesById), [closesById]);
  const computed = useMemo(() => {
    const priceBySym = {};
    prices.forEach((r) => { (priceBySym[r.ISIN] ||= []).push(r); });
    return master.map((m) => {
      const tech = computeTechnicalBlock(priceBySym[m.Symbol] || []);
      return { ...m, ISIN: m.Symbol, fund: null, tech: tech ? { ...tech, rsRating: rsUniverse[m.Symbol] || null } : tech };
    });
  }, [master, prices, rsUniverse]);

  const candidates = useMemo(() => runGoldenBreakoutScreener(computed), [computed]);

  return <GoldenBreakoutScreen candidates={candidates} accent={config.accent} hasFundamentals={false} itemLabel={config.labelSingular.charAt(0).toUpperCase() + config.labelSingular.slice(1)} />;
}

function GenericAssetScreen({ config }) {
  const { key, label, labelSingular, accent, storagePrefix, extraMasterFields, sampleMaster, samplePrices } = config;
  const [master, setMaster] = useState([]);
  const [prices, setPrices] = useState([]);
  const [usingSample, setUsingSample] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("Name");
  const [sortDir, setSortDir] = useState(1);
  const [expanded, setExpanded] = useState(null);
  const [status, setStatus] = useState("");
  const [showManage, setShowManage] = useState(false);
  const [manageSearch, setManageSearch] = useState("");
  const [newItem, setNewItem] = useState({ Symbol: "", Name: "", ...Object.fromEntries(extraMasterFields.map((f) => [f, ""])) });
  const [colFilters, setColFilters] = useState({});
  const [openFilterKey, setOpenFilterKey] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const metaRes = await window.storage.get(`${storagePrefix}-meta`, false);
        if (metaRes && metaRes.value) {
          const parsed = JSON.parse(metaRes.value);
          setMaster(parsed.master || []);
          setUsingSample(parsed.usingSample || false);
        }
        const loadedPrices = await loadChunkedArray(`${storagePrefix}-prices`);
        setPrices(loadedPrices);
      } catch (e) { /* no saved data yet */ }
    })();
  }, [storagePrefix]);

  const persist = useCallback(async (next) => {
    try {
      await window.storage.set(`${storagePrefix}-meta`, JSON.stringify({ master: next.master, usingSample: next.usingSample }), false);
      await saveChunkedArray(`${storagePrefix}-prices`, next.prices || []);
    } catch (e) { console.error(e); }
  }, [storagePrefix]);

  const loadSample = () => {
    setMaster(sampleMaster); setPrices(samplePrices); setUsingSample(true);
    persist({ master: sampleMaster, prices: samplePrices, usingSample: true });
    setStatus(`Loaded demo ${labelSingular} data (synthetic).`);
  };

  const clearAll = async () => {
    setMaster([]); setPrices([]); setUsingSample(false);
    try { await window.storage.delete(`${storagePrefix}-meta`, false); } catch (e) {}
    await deleteChunkedArray(`${storagePrefix}-prices`);
    setStatus("Cleared.");
  };

  const upsertBySymbol = (existing, incoming) => {
    const incomingKeys = new Set(incoming.map((r) => r.ISIN));
    return [...existing.filter((r) => !incomingKeys.has(r.ISIN)), ...incoming];
  };

  const NUMERIC_FIELDS = { master: new Set(["MarketCap"]), prices: new Set(["Close", "Volume"]) };

  const handleUpload = (file, kind) => {
    const numericFields = NUMERIC_FIELDS[kind] || new Set();
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      transform: (value, field) => (numericFields.has(field) ? (value === "" ? null : Number(value)) : value),
      complete: (res) => {
        const rows = res.data;
        let nextMaster = master, nextPrices = prices;
        if (kind === "master") {
          const keyed = new Set(rows.map((r) => r.Symbol));
          nextMaster = [...master.filter((m) => !keyed.has(m.Symbol)), ...rows];
          setMaster(nextMaster);
        }
        if (kind === "prices") {
          const mapped = rows.map((r) => ({ ISIN: r.Symbol, Date: r.Date, Close: r.Close, Volume: r.Volume }));
          nextPrices = upsertBySymbol(prices, mapped);
          setPrices(nextPrices);
        }
        setUsingSample(false);
        persist({ master: nextMaster, prices: nextPrices, usingSample: false });
        setStatus(`Loaded ${rows.length} rows into ${kind} (merged by symbol).`);
      },
      error: (err) => setStatus(`Error parsing file: ${err.message}`),
    });
  };

  const addItem = () => {
    const sym = newItem.Symbol.trim();
    if (!sym) { setStatus("Symbol is required."); return; }
    if (master.some((m) => m.Symbol === sym)) { setStatus(`${sym} is already tracked.`); return; }
    const row = { Symbol: sym, Name: newItem.Name.trim() || sym };
    extraMasterFields.forEach((f) => { row[f] = (newItem[f] || "").trim(); });
    const nextMaster = [...master, row];
    setMaster(nextMaster); setUsingSample(false);
    persist({ master: nextMaster, prices, usingSample: false });
    setNewItem({ Symbol: "", Name: "", ...Object.fromEntries(extraMasterFields.map((f) => [f, ""])) });
    setStatus(`Added ${row.Name}. Upload its price history to see computed fields.`);
  };

  const removeItem = (sym, name) => {
    if (!window.confirm(`Remove ${name} (${sym})? This also clears its price history.`)) return;
    const nextMaster = master.filter((m) => m.Symbol !== sym);
    const nextPrices = prices.filter((p) => p.ISIN !== sym);
    setMaster(nextMaster); setPrices(nextPrices);
    persist({ master: nextMaster, prices: nextPrices, usingSample });
    setStatus(`Removed ${name}.`);
  };

  const closesById = useMemo(() => closesByKeyFromPrices(prices, "ISIN"), [prices]);
  const rsUniverse = useMemo(() => computeRSUniverse(closesById), [closesById]);
  const computed = useMemo(() => {
    const priceBySym = {};
    prices.forEach((r) => { (priceBySym[r.ISIN] ||= []).push(r); });
    return master.map((m) => {
      const tech = computeTechnicalBlock(priceBySym[m.Symbol] || []);
      return { ...m, tech: tech ? { ...tech, rsRating: rsUniverse[m.Symbol] || null } : tech };
    });
  }, [master, prices, rsUniverse]);

  const FILTERABLE = {
    changePct: { label: "1D %", accessor: (s) => s.tech?.changePct },
    RSI: { label: "RSI", accessor: (s) => s.tech?.rsi },
    rsRating: { label: "RS Rating", accessor: (s) => s.tech?.rsRating?.rating },
    pctFromHigh52: { label: "% fr 52wH", accessor: (s) => s.tech?.pctFromHigh52 },
    pctFromLow52: { label: "% fr 52wL", accessor: (s) => s.tech?.pctFromLow52 },
    volBreakout: { label: "Vol Breakout %", accessor: (s) => s.tech?.volBreakoutPct },
  };
  const applyFilter = (key, cfg) => setColFilters((prev) => ({ ...prev, [key]: cfg }));
  const clearFilter = (key) => setColFilters((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const [maFilters, setMaFilters] = useState({ S: null, M: null });
  const clearAllFilters = () => { setColFilters({}); setMaFilters({ S: null, M: null }); };

  const filtered = useMemo(() => {
    let list = computed.filter((s) =>
      (search === "" || (s.Name || "").toLowerCase().includes(search.toLowerCase()) || (s.Symbol || "").toLowerCase().includes(search.toLowerCase())) &&
      Object.entries(colFilters).every(([key, cfg]) => {
        const def = FILTERABLE[key];
        if (!def) return true;
        const val = def.accessor(s);
        if (cfg.min != null && (val == null || val < cfg.min)) return false;
        if (cfg.max != null && (val == null || val > cfg.max)) return false;
        return true;
      }) &&
      matchesMASignals(s.tech?.sSignals, s.tech?.sStreaks, maFilters.S, [3, 8, 30, 50, 100, 200]) &&
      matchesMASignals(s.tech?.mSignals, s.tech?.mStreaks, maFilters.M, [3, 8, 30, 100])
    );
    list.sort((a, b) => {
      const get = (row) => {
        if (sortKey === "Name") return row.Name || "";
        if (sortKey === "CMP") return row.tech?.cmp ?? -Infinity;
        if (sortKey === "changePct") return row.tech?.changePct ?? -Infinity;
        if (sortKey === "RSI") return row.tech?.rsi ?? -Infinity;
        if (sortKey === "rsRating") return row.tech?.rsRating?.rating ?? -Infinity;
        if (sortKey === "pctFromHigh52") return row.tech?.pctFromHigh52 ?? -Infinity;
        if (sortKey === "pctFromLow52") return row.tech?.pctFromLow52 ?? -Infinity;
        if (sortKey === "volBreakout") return row.tech?.volBreakoutPct ?? -Infinity;
        return "";
      };
      const av = get(a), bv = get(b);
      if (typeof av === "string") return sortDir * av.localeCompare(bv);
      return sortDir * ((av ?? -Infinity) - (bv ?? -Infinity));
    });
    return list;
  }, [computed, search, sortKey, sortDir, colFilters, maFilters]);

  const toggleSort = (k) => { if (sortKey === k) setSortDir((d) => -d); else { setSortKey(k); setSortDir(1); } };
  const sortArrow = (k) => {
    if (sortKey !== k) return null;
    const up = sortDir === 1;
    return (
      <span style={{
        display: "inline-block", marginLeft: 5, width: 0, height: 0, verticalAlign: "middle",
        borderLeft: "4px solid transparent", borderRight: "4px solid transparent",
        borderBottom: up ? `6px solid ${accent}` : "none",
        borderTop: up ? "none" : `6px solid ${accent}`,
      }} />
    );
  };

  const FilterableTh = ({ colKey, label: colLabel }) => (
    <th style={{ position: "relative" }}>
      <span onClick={() => toggleSort(colKey)} style={{ cursor: "pointer" }}>{colLabel}{sortArrow(colKey)}</span>
      <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === colKey ? null : colKey); }}
        style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
        <Filter size={10} color={colFilters[colKey] ? accent : T.textDim} />
      </button>
      {openFilterKey === colKey && (
        <NumFilterPopover colKey={colKey} label={colLabel} current={colFilters[colKey]}
          onApply={applyFilter} onClear={clearFilter} onClose={() => setOpenFilterKey(null)} />
      )}
    </th>
  );

  const hasData = master.length > 0;

  return (
    <div onClick={() => setOpenFilterKey(null)}>
      <div style={{ padding: "16px 24px", background: T.surface, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {[{ kind: "master", label: `${label} master` }, { kind: "prices", label: "Prices (daily EOD)" }].map(({ kind, label: btnLabel }) => (
            <label key={kind} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 12, color: T.text, background: T.surfaceAlt }}>
              <Upload size={13} color={accent} /> {btnLabel}
              <input type="file" accept=".csv" style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleUpload(e.target.files[0], kind)} />
            </label>
          ))}
          {sampleMaster.length > 0 && (
            <button onClick={loadSample} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${accent}`, background: "transparent", color: accent, fontSize: 12, fontWeight: 600 }}>Load demo data</button>
          )}
          <button onClick={() => setShowManage((v) => !v)} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.border}`, background: showManage ? T.surfaceAlt : "transparent", color: T.text, fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ListPlus size={13} color={accent} /> Manage {label.toLowerCase()} ({master.length})
          </button>
          <button onClick={clearAll} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <RotateCcw size={12} /> Clear
          </button>
          {status && <span style={{ fontSize: 11, color: T.textDim, marginLeft: 4 }}>{status}</span>}
        </div>
        <div style={{ fontSize: 11, color: T.textDim, marginTop: 10, lineHeight: 1.5 }}>
          <b style={{ color: T.text }}>CSV columns expected —</b> {label} master: Symbol, Name{extraMasterFields.length ? `, ${extraMasterFields.join(", ")}` : ""} · Prices (one row per {labelSingular} per trading day, ~1yr+): Symbol, Date, Close, Volume. Uploads merge in by symbol. Technicals only — same signal logic as Equities; no fundamentals.
        </div>
        {showManage && (
          <div style={{ marginTop: 14, background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: accent, marginBottom: 10 }}>Add a {labelSingular}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              {["Symbol", "Name", ...extraMasterFields].map((f) => (
                <input key={f} value={newItem[f]} onChange={(e) => setNewItem({ ...newItem, [f]: e.target.value })} placeholder={f}
                  style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: f === "Name" ? 160 : 110 }} />
              ))}
              <button onClick={addItem} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${accent}`, background: `${accent}22`, color: accent, fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Plus size={12} /> Add
              </button>
            </div>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: accent, marginBottom: 8, marginTop: 14 }}>Current list ({master.length})</div>
            <input value={manageSearch} onChange={(e) => setManageSearch(e.target.value)} placeholder="Filter..."
              style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 160, marginBottom: 8 }} />
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {master.filter((m) => !manageSearch || (m.Name || "").toLowerCase().includes(manageSearch.toLowerCase()) || (m.Symbol || "").toLowerCase().includes(manageSearch.toLowerCase())).map((m) => (
                <div key={m.Symbol} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 4px", borderBottom: `1px solid ${T.border}`, fontSize: 12 }}>
                  <span>{m.Name} <span style={{ color: T.textDim, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5 }}>{m.Symbol}{extraMasterFields.map((f) => m[f] ? ` · ${m[f]}` : "").join("")}</span></span>
                  <button onClick={() => removeItem(m.Symbol, m.Name)} title="Remove" style={{ padding: 4, borderRadius: 4, border: `1px solid ${T.border}`, background: "transparent", color: T.loss, display: "inline-flex" }}><X size={12} /></button>
                </div>
              ))}
              {master.length === 0 && <div style={{ color: T.textDim, fontSize: 12 }}>No {label.toLowerCase()} yet.</div>}
            </div>
          </div>
        )}
      </div>

      {!hasData ? (
        <div style={{ padding: 60, textAlign: "center", color: T.textDim }}>
          Upload {labelSingular} price data{sampleMaster.length > 0 ? " or load demo data" : ""} to see the screen.
        </div>
      ) : (
        <>
          <div style={{ padding: "12px 24px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ position: "relative" }}>
              <Search size={13} color={T.textDim} style={{ position: "absolute", left: 8, top: 8 }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${labelSingular}...`}
                style={{ padding: "6px 10px 6px 26px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 180 }} />
            </div>
            {(Object.keys(colFilters).length > 0 || maFilters.S || maFilters.M) && (
              <button onClick={clearAllFilters} style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11.5, display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Filter size={11} color={accent} /> {Object.keys(colFilters).length + (maFilters.S ? 1 : 0) + (maFilters.M ? 1 : 0)} filter{(Object.keys(colFilters).length + (maFilters.S ? 1 : 0) + (maFilters.M ? 1 : 0)) > 1 ? "s" : ""} active <X size={11} />
              </button>
            )}
          </div>

          <div style={{ padding: "0 24px 40px", overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
            <table>
              <thead style={{ position: "sticky", top: 0, zIndex: 15, background: T.bg }}>
                <tr style={{ borderBottom: `1px solid ${T.border}`, fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  <th></th>
                  <th onClick={() => toggleSort("Name")} style={{ cursor: "pointer" }}>{labelSingular.charAt(0).toUpperCase() + labelSingular.slice(1)}{sortArrow("Name")}</th>
                  <th onClick={() => toggleSort("CMP")} style={{ cursor: "pointer" }}>CMP{sortArrow("CMP")}</th>
                  <FilterableTh colKey="changePct" label="1D %" />
                  <FilterableTh colKey="RSI" label="RSI" />
                  <FilterableTh colKey="rsRating" label="RS Rating" />
                  <FilterableTh colKey="pctFromHigh52" label="% fr 52wH" />
                  <FilterableTh colKey="pctFromLow52" label="% fr 52wL" />
                  <FilterableTh colKey="volBreakout" label="Vol Brk %" />
                  <th style={{ position: "relative" }} title="Sort not yet available for moving-average columns">
                    Price vs MA
                    <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === "maS" ? null : "maS"); }}
                      style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
                      <Filter size={10} color={maFilters.S ? accent : T.textDim} />
                    </button>
                    {openFilterKey === "maS" && (
                      <MASignalFilterPopover title="Filter: Price vs Moving Average" periods={[3, 8, 30, 50, 100, 200]} prefix="S"
                        current={maFilters.S} onApply={(cfg) => setMaFilters((f) => ({ ...f, S: cfg }))}
                        onClear={() => setMaFilters((f) => ({ ...f, S: null }))} onClose={() => setOpenFilterKey(null)} />
                    )}
                  </th>
                  <th style={{ position: "relative" }} title="Sort not yet available for moving-average columns">
                    MA vs MA
                    <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === "maM" ? null : "maM"); }}
                      style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
                      <Filter size={10} color={maFilters.M ? accent : T.textDim} />
                    </button>
                    {openFilterKey === "maM" && (
                      <MASignalFilterPopover title="Filter: MA vs MA" periods={[3, 8, 30, 100]} prefix="M"
                        current={maFilters.M} onApply={(cfg) => setMaFilters((f) => ({ ...f, M: cfg }))}
                        onClear={() => setMaFilters((f) => ({ ...f, M: null }))} onClose={() => setOpenFilterKey(null)} />
                    )}
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const isOpen = expanded === s.Symbol;
                  const t = s.tech;
                  return (
                    <React.Fragment key={s.Symbol}>
                      <tr onClick={() => setExpanded(isOpen ? null : s.Symbol)}
                        style={{ borderBottom: `1px solid ${T.border}`, fontSize: 12.5, cursor: "pointer", background: isOpen ? T.surfaceAlt : "transparent" }}>
                        <td>{isOpen ? <ChevronDown size={14} color={T.textDim} /> : <ChevronRight size={14} color={T.textDim} />}</td>
                        <td style={{ fontWeight: 600 }}>{s.Name}<div style={{ fontSize: 10, color: T.textDim, fontFamily: "'IBM Plex Mono', monospace" }}>{s.Symbol}{extraMasterFields.map((f) => s[f] ? ` · ${s[f]}` : "").join("")}</div></td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t ? fmtNum(t.cmp, 2) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.changePct > 0 ? T.gain : t?.changePct < 0 ? T.loss : T.textDim }}>{t ? fmtPct(t.changePct) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.rsi > 70 ? T.loss : t?.rsi < 30 ? T.gain : T.text }}>{t ? fmtNum(t.rsi) : "—"}</td>
                        <td><RSRatingBadge rsRating={t?.rsRating} /></td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.textDim }}>{t ? fmtPct(t.pctFromHigh52, 0) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.gain }}>{t ? fmtPct(t.pctFromLow52, 0) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.volBreakoutPct > 150 ? accent : T.textDim, fontWeight: t?.volBreakoutPct > 150 ? 700 : 400 }}>{t && t.volBreakoutPct != null ? `${fmtNum(t.volBreakoutPct, 0)}%` : "—"}</td>
                        <td>{t && [3, 8, 30, 50, 100, 200].map((n) => <SignalPill key={n} active={t.sSignals[n]} label={`S${n}`} streak={t.sStreaks?.[n]?.streak} capped={t.sStreaks?.[n]?.capped} />).reduce((a, b) => [a, " ", b])}</td>
                        <td>{t && [3, 8, 30, 100].map((n) => <SignalPill key={n} active={t.mSignals[n]} label={`M${n}`} streak={t.mStreaks?.[n]?.streak} capped={t.mStreaks?.[n]?.capped} />).reduce((a, b) => [a, " ", b])}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => removeItem(s.Symbol, s.Name)} title="Remove" style={{ padding: 4, borderRadius: 4, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, display: "inline-flex" }}><X size={11} /></button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={12} style={{ background: T.surface, padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
                            {t ? (
                              <div style={{ fontSize: 12, lineHeight: 2 }}>
                                <div>52w range: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.low52, 2)} – {fmtNum(t.high52, 2)}</b></div>
                                <div>% from 52w high / low: <b style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.loss }}>{fmtPct(t.pctFromHigh52, 0)}</b> <span style={{ color: T.textDim }}>/</span> <b style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.gain }}>{fmtPct(t.pctFromLow52, 0)}</b></div>
                                <div>CMP / 52w low: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.cmpOverLow52, 2)}x</b></div>
                                <div>RS Rating (vs tracked {label.toLowerCase()}): <RSRatingBadge rsRating={t.rsRating} /></div>
                                <div>Moving averages: {[3, 8, 30, 50, 100, 200].map((n) => <span key={n} style={{ fontFamily: "'IBM Plex Mono', monospace", marginRight: 10 }}>MA{n}: {fmtNum(t.mas[n], 2)}</span>)}</div>
                                <div>RSI (14): <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.rsi)}</b></div>
                              </div>
                            ) : <div style={{ color: T.textDim, fontSize: 12 }}>No price data for this {labelSingular}.</div>}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function matchesMASignals(signals, streaks, filter, allPeriods) {
  if (!filter || !signals) return true;
  const { selected, mode } = filter;
  for (const sel of selected) {
    if (!signals[sel.period]) return false;
    const s = streaks?.[sel.period]?.streak;
    if (sel.min != null && (s == null || s < sel.min)) return false;
    if (sel.max != null && (s == null || s > sel.max)) return false;
  }
  if (mode === "exact") {
    const selectedPeriods = selected.map((s) => s.period);
    for (const p of allPeriods) { if (!selectedPeriods.includes(p) && signals[p]) return false; }
  }
  return true;
}

function MASignalFilterPopover({ title, periods, prefix, current, onApply, onClear, onClose }) {
  const initial = new Map((current?.selected || []).map((s) => [s.period, { min: s.min, max: s.max }]));
  const [selected, setSelected] = useState(initial);
  const [mode, setMode] = useState(current?.mode || "exact");
  const toggle = (p) => setSelected((prev) => { const n = new Map(prev); n.has(p) ? n.delete(p) : n.set(p, { min: null, max: null }); return n; });
  const setRange = (p, field, val) => setSelected((prev) => { const n = new Map(prev); n.set(p, { ...n.get(p), [field]: val === "" ? null : Number(val) }); return n; });
  return (
    <div onClick={(e) => e.stopPropagation()} style={{
      position: "absolute", top: "120%", right: 0, zIndex: 30, background: T.surfaceAlt,
      border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, minWidth: 240,
      boxShadow: "0 4px 16px rgba(0,0,0,0.5)", textTransform: "none", letterSpacing: "normal", fontWeight: 400,
    }}>
      <div style={{ fontSize: 11, color: T.textDim, marginBottom: 8 }}>{title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {periods.map((p) => (
          <label key={p} style={{
            display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "4px 8px", borderRadius: 4, cursor: "pointer",
            border: `1px solid ${selected.has(p) ? T.gold : T.border}`, color: selected.has(p) ? T.gold : T.textDim,
            background: selected.has(p) ? "rgba(201,162,39,0.12)" : "transparent",
          }}>
            <input type="checkbox" checked={selected.has(p)} onChange={() => toggle(p)} style={{ display: "none" }} />
            {prefix}{p}
          </label>
        ))}
      </div>
      {selected.size > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10, paddingTop: 6, borderTop: `1px solid ${T.border}` }}>
          {Array.from(selected.entries()).map(([p, r]) => (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
              <span style={{ width: 34, color: T.gold, fontWeight: 600 }}>{prefix}{p}</span>
              <span style={{ color: T.textDim }}>days:</span>
              <input type="number" placeholder="Min" value={r.min ?? ""} onChange={(e) => setRange(p, "min", e.target.value)}
                style={{ width: 50, padding: "3px 5px", borderRadius: 4, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 11 }} />
              <span style={{ color: T.textDim }}>–</span>
              <input type="number" placeholder="Max" value={r.max ?? ""} onChange={(e) => setRange(p, "max", e.target.value)}
                style={{ width: 50, padding: "3px 5px", borderRadius: 4, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 11 }} />
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10, fontSize: 11 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", color: mode === "exact" ? T.text : T.textDim }}>
          <input type="radio" name={`mode-${prefix}`} checked={mode === "exact"} onChange={() => setMode("exact")} /> Only these signals (exact)
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", color: mode === "and" ? T.text : T.textDim }}>
          <input type="radio" name={`mode-${prefix}`} checked={mode === "and"} onChange={() => setMode("and")} /> Includes these (others allowed)
        </label>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => {
          const arr = Array.from(selected.entries()).map(([period, r]) => ({ period, min: r.min ?? null, max: r.max ?? null }));
          onApply(arr.length ? { selected: arr, mode } : null); onClose();
        }} style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.gold}`, background: "rgba(201,162,39,0.12)", color: T.gold, fontSize: 11, fontWeight: 600 }}>Apply</button>
        <button onClick={() => { onClear(); onClose(); }}
          style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11 }}>Clear</button>
      </div>
    </div>
  );
}

// ---------- Alerts (recurring master-management tasks, persist until marked done) ----------
function quarterEndsForYear(y) {
  return [2, 5, 8, 11].map((m) => new Date(y, m + 1, 0)); // last day of Mar/Jun/Sep/Dec
}
function nextQuarterEndOnOrAfter(fromDate) {
  const y = fromDate.getFullYear();
  for (let yy = y; yy <= y + 1; yy++) {
    for (const d of quarterEndsForYear(yy)) {
      if (d >= new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate())) return d;
    }
  }
  return quarterEndsForYear(y + 1)[0];
}
function advanceDueDate(dueDateStr, recurrence) {
  const d = new Date(dueDateStr + "T00:00:00");
  if (recurrence === "quarterly") {
    const next = new Date(d); next.setDate(next.getDate() + 1);
    return nextQuarterEndOnOrAfter(next).toISOString().slice(0, 10);
  }
  if (recurrence === "monthly") { const n = new Date(d.getFullYear(), d.getMonth() + 2, 0); return n.toISOString().slice(0, 10); }
  if (recurrence === "yearly") { const n = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate()); return n.toISOString().slice(0, 10); }
  return null; // "none" — one-off, no next occurrence
}
function todayStr() { return new Date().toISOString().slice(0, 10); }

const DEFAULT_ALERTS = [
  {
    id: "quarterly-universe-update",
    title: "Update stock universe (quarter close)",
    notes: "Recompute Meridian's tracked universe: include all stocks with Market Cap > ₹500 Cr as of today's close (plain >500 cutoff, no buffer). Update Company Master — add new qualifiers, flag/exclude dropouts (keep their historical data, don't delete).",
    dueDate: nextQuarterEndOnOrAfter(new Date()).toISOString().slice(0, 10),
    recurrence: "quarterly",
    status: "pending",
  },
];

function AlertsPanel({ alerts, onMarkDone, onAddAlert, onClose }) {
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({ title: "", notes: "", dueDate: "", recurrence: "none" });
  const today = todayStr();
  const sorted = [...alerts].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return (
    <div onClick={(e) => e.stopPropagation()} style={{
      position: "absolute", top: "120%", right: 0, zIndex: 40, background: T.surfaceAlt, border: `1px solid ${T.border}`,
      borderRadius: 8, padding: 12, width: 320, maxHeight: 420, overflowY: "auto", boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: T.gold, marginBottom: 8 }}>Master management alerts</div>
      {sorted.length === 0 && <div style={{ fontSize: 12, color: T.textDim }}>No alerts.</div>}
      {sorted.map((a) => {
        const isDue = a.dueDate <= today;
        return (
          <div key={a.id} style={{ padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: isDue ? T.loss : T.text }}>{isDue ? "● DUE — " : ""}{a.title}</span>
            </div>
            <div style={{ fontSize: 10.5, color: T.textDim, marginTop: 2 }}>Due {a.dueDate}{a.recurrence !== "none" ? ` · repeats ${a.recurrence}` : ""}</div>
            {a.notes && <div style={{ fontSize: 11, color: T.textDim, marginTop: 4, lineHeight: 1.4 }}>{a.notes}</div>}
            <button onClick={() => onMarkDone(a.id)} style={{
              marginTop: 6, padding: "4px 10px", borderRadius: 5, border: `1px solid ${T.gold}`,
              background: "rgba(201,162,39,0.12)", color: T.gold, fontSize: 11, fontWeight: 600,
            }}>Mark done{a.recurrence !== "none" ? " (schedules next)" : ""}</button>
          </div>
        );
      })}
      {showAdd ? (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Title"
            style={{ padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }} />
          <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Notes"
            style={{ padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }} />
          <div style={{ display: "flex", gap: 6 }}>
            <input type="date" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
              style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }} />
            <select value={draft.recurrence} onChange={(e) => setDraft({ ...draft, recurrence: e.target.value })}
              style={{ padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }}>
              <option value="none">One-off</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <button onClick={() => { if (draft.title && draft.dueDate) { onAddAlert(draft); setDraft({ title: "", notes: "", dueDate: "", recurrence: "none" }); setShowAdd(false); } }}
            style={{ padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.gold}`, background: "rgba(201,162,39,0.12)", color: T.gold, fontSize: 11, fontWeight: 600 }}>Add alert</button>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} style={{ marginTop: 10, padding: "5px 10px", borderRadius: 5, border: `1px dashed ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11 }}>+ Add alert</button>
      )}
    </div>
  );
}

// ---------- Breakout Ideas Screen ----------
// ---------- Golden Breakout Screen ----------
const GB_FILTERABLE = {
  changePct: { label: "1D %", accessor: (s) => s.tech?.changePct },
  fundScore: { label: "Fund Score", accessor: (s) => s.fund?.score?.score },
  separationPct: { label: "Separation %", accessor: (s) => s.tech?.separationPct },
  freshnessDays: { label: "Freshness (d)", accessor: (s) => s.tech?.goldenCrossStreak?.streak },
  ma200SlopePct: { label: "200DMA Slope %", accessor: (s) => s.tech?.ma200SlopePct },
  volBreakout: { label: "Vol Breakout %", accessor: (s) => s.tech?.volBreakoutPct },
};

function GoldenBreakoutScreen({ candidates, accent = T.gold, hasFundamentals = true, itemLabel = "Stock" }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("separationPct");
  const [sortDir, setSortDir] = useState(-1);
  const [expanded, setExpanded] = useState(null);
  const [colFilters, setColFilters] = useState({});
  const [openFilterKey, setOpenFilterKey] = useState(null);

  const applyFilter = (key, cfg) => setColFilters((prev) => ({ ...prev, [key]: cfg }));
  const clearFilter = (key) => setColFilters((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const clearAllFilters = () => setColFilters({});

  const toggleSort = (key) => { if (sortKey === key) setSortDir((d) => -d); else { setSortKey(key); setSortDir(-1); } };
  const sortArrow = (key) => {
    if (sortKey !== key) return null;
    const up = sortDir === 1;
    return (
      <span style={{
        display: "inline-block", marginLeft: 5, width: 0, height: 0, verticalAlign: "middle",
        borderLeft: "4px solid transparent", borderRight: "4px solid transparent",
        borderBottom: up ? `6px solid ${accent}` : "none", borderTop: up ? "none" : `6px solid ${accent}`,
      }} />
    );
  };
  const FilterableTh = ({ colKey, label }) => (
    <th style={{ position: "relative" }}>
      <span onClick={() => toggleSort(colKey)} style={{ cursor: "pointer" }}>{label}{sortArrow(colKey)}</span>
      <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === colKey ? null : colKey); }}
        style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
        <Filter size={10} color={colFilters[colKey] ? accent : T.textDim} />
      </button>
      {openFilterKey === colKey && (
        <NumFilterPopover colKey={colKey} label={label} current={colFilters[colKey]}
          onApply={applyFilter} onClear={clearFilter} onClose={() => setOpenFilterKey(null)} />
      )}
    </th>
  );

  const filtered = useMemo(() => {
    let list = candidates.filter((s) =>
      (search === "" || (s.Name || "").toLowerCase().includes(search.toLowerCase()) || (s.Symbol || "").toLowerCase().includes(search.toLowerCase())) &&
      Object.entries(colFilters).every(([key, cfg]) => {
        const def = GB_FILTERABLE[key];
        if (!def) return true;
        const val = def.accessor(s);
        if (cfg.min != null && (val == null || val < cfg.min)) return false;
        if (cfg.max != null && (val == null || val > cfg.max)) return false;
        return true;
      })
    );
    list = [...list].sort((a, b) => {
      const get = (row) => {
        if (sortKey === "Name") return row.Name || "";
        if (sortKey === "CMP") return row.tech?.cmp ?? -Infinity;
        if (sortKey === "changePct") return row.tech?.changePct ?? -Infinity;
        if (sortKey === "fundScore") return row.fund?.score?.score ?? -Infinity;
        if (sortKey === "separationPct") return row.tech?.separationPct ?? -Infinity;
        if (sortKey === "freshnessDays") return row.tech?.goldenCrossStreak?.streak ?? Infinity;
        if (sortKey === "ma200SlopePct") return row.tech?.ma200SlopePct ?? -Infinity;
        if (sortKey === "volBreakout") return row.tech?.volBreakoutPct ?? -Infinity;
        return "";
      };
      const av = get(a), bv = get(b);
      if (typeof av === "string") return sortDir * av.localeCompare(bv);
      return sortDir * ((av ?? -Infinity) - (bv ?? -Infinity));
    });
    return list;
  }, [candidates, search, sortKey, sortDir, colFilters]);

  return (
    <div style={{ padding: "16px 24px 40px" }} onClick={() => setOpenFilterKey(null)}>
      <div style={{ fontSize: 12, color: T.textDim, marginBottom: 16, lineHeight: 1.6 }}>
        <b style={{ color: T.text }}>{candidates.length} candidate{candidates.length === 1 ? "" : "s"}</b> — Golden Cross model, five backtested gates: price above 50DMA above 200DMA, 200DMA rising, separation ≥3%, cross freshness ≤10 days, price above 8DMA.
        {hasFundamentals ? " No RS, no fundamentals, no volatility filter, no bucketing — each was tested against 5 years of real equity price history and either didn't earn its place or actively hurt results." : " Same five gates as the equities model — thresholds were validated on equities specifically and haven't yet been separately backtested for this asset class."} Sorted by separation width, then freshness.{hasFundamentals ? " Fund Score and Volume Breakout are shown for your own reference — neither gates nor ranks the list." : " Volume Breakout is shown for your own reference — it doesn't gate or rank the list."}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ position: "relative" }}>
          <Search size={13} color={T.textDim} style={{ position: "absolute", left: 8, top: 8 }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${itemLabel.toLowerCase()}...`}
            style={{ padding: "6px 10px 6px 26px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 180 }} />
        </div>
        {Object.keys(colFilters).length > 0 && (
          <button onClick={clearAllFilters} style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11.5, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Filter size={11} color={accent} /> {Object.keys(colFilters).length} filter{Object.keys(colFilters).length > 1 ? "s" : ""} active <X size={11} />
          </button>
        )}
      </div>

      {candidates.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center", color: T.textDim }}>
          No {itemLabel.toLowerCase()}s currently clear all five gates.
        </div>
      ) : (
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
          <table>
            <thead style={{ position: "sticky", top: 0, zIndex: 15, background: T.bg }}>
              <tr style={{ borderBottom: `1px solid ${T.border}`, fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <th></th>
                <th onClick={() => toggleSort("Name")} style={{ cursor: "pointer" }}>{itemLabel}{sortArrow("Name")}</th>
                <th onClick={() => toggleSort("CMP")} style={{ cursor: "pointer" }}>CMP{sortArrow("CMP")}</th>
                <FilterableTh colKey="changePct" label="1D %" />
                {hasFundamentals && <FilterableTh colKey="fundScore" label="Fund Score" />}
                <FilterableTh colKey="separationPct" label="Separation %" />
                <FilterableTh colKey="freshnessDays" label="Freshness (d)" />
                <FilterableTh colKey="ma200SlopePct" label="200DMA Slope %" />
                <FilterableTh colKey="volBreakout" label="Vol Brk %" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const isOpen = expanded === s.ISIN;
                const t = s.tech, f = s.fund;
                return (
                  <React.Fragment key={s.ISIN}>
                    <tr onClick={() => setExpanded(isOpen ? null : s.ISIN)}
                      style={{ borderBottom: `1px solid ${T.border}`, fontSize: 12.5, cursor: "pointer", background: isOpen ? T.surfaceAlt : "transparent" }}>
                      <td>{isOpen ? <ChevronDown size={14} color={T.textDim} /> : <ChevronRight size={14} color={T.textDim} />}</td>
                      <td style={{ fontWeight: 600 }}>{s.Name}<div style={{ fontSize: 10, color: T.textDim, fontFamily: "'IBM Plex Mono', monospace" }}>{s.Symbol}</div></td>
                      <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t ? `₹${fmtNum(t.cmp, 2)}` : "—"}</td>
                      <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.changePct > 0 ? T.gain : t?.changePct < 0 ? T.loss : T.textDim }}>{t ? fmtPct(t.changePct) : "—"}</td>
                      {hasFundamentals && <td><FundTierBadge fundScore={f?.score} /></td>}
                      <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.gain }}>{t ? fmtPct(t.separationPct, 1) : "—"}</td>
                      <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t?.goldenCrossStreak?.streak ?? "—"}</td>
                      <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.gain }}>{t ? fmtPct(t.ma200SlopePct, 1) : "—"}</td>
                      <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.volBreakoutPct > 150 ? accent : T.textDim, fontWeight: t?.volBreakoutPct > 150 ? 700 : 400 }}>{t && t.volBreakoutPct != null ? `${fmtNum(t.volBreakoutPct, 0)}%` : "—"}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={hasFundamentals ? 9 : 8} style={{ background: T.surface, padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
                          <div style={{ display: "grid", gridTemplateColumns: hasFundamentals ? "1fr 1fr" : "1fr", gap: 24 }}>
                            <div>
                              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: accent, marginBottom: 8 }}>Golden Breakout gates</div>
                              <div style={{ fontSize: 12, lineHeight: 2 }}>
                                <div>Golden Cross (50DMA &gt; 200DMA): <b style={{ color: T.gain }}>Yes</b>, price above 50DMA: <b style={{ color: T.gain }}>Yes</b></div>
                                <div>200DMA rising: <b style={{ color: T.gain }}>Yes</b> ({fmtPct(t?.ma200SlopePct, 2)})</div>
                                <div>Separation: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtPct(t?.separationPct, 2)}</b> (min 3%)</div>
                                <div>Freshness: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t?.goldenCrossStreak?.streak}d</b> (max 10d)</div>
                                <div>Price above 8DMA: <b style={{ color: T.gain }}>Yes</b> (MA8: ₹{fmtNum(t?.mas?.[8], 2)})</div>
                              </div>
                            </div>
                            {hasFundamentals && (
                            <div>
                              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: accent, marginBottom: 8 }}>Fundamentals (reference only — {f?.latestFY || "—"})</div>
                              {f ? (
                                <>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                                    <span style={{ fontSize: 11, color: T.textDim }}>Composite score:</span>
                                    <FundTierBadge fundScore={f.score} />
                                  </div>
                                  <FundRow label="ROE" block={f.roe} />
                                  <FundRow label="ROCE" block={f.roce} />
                                  <FundRow label="EPS growth" block={f.epsGrowth} />
                                  <FundRow label="Sales growth" block={f.salesGrowth} />
                                  <FundRow label="Debt/Equity" block={f.debtEquity} isPercent={false} />
                                </>
                              ) : <div style={{ color: T.textDim, fontSize: 12 }}>No fundamentals data for this stock.</div>}
                            </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Market Breadth Screen ----------
// ---------- Sectoral Screen (base data view for the derived industry-pool series) ----------
function SectoralScreen({ computed, accent }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("Name");
  const [sortDir, setSortDir] = useState(1);
  const [expanded, setExpanded] = useState(null);

  const filtered = useMemo(() => {
    let list = computed.filter((s) => search === "" || (s.Name || "").toLowerCase().includes(search.toLowerCase()));
    list = [...list].sort((a, b) => {
      const get = (row) => {
        if (sortKey === "Name") return row.Name || "";
        if (sortKey === "CMP") return row.tech?.cmp ?? -Infinity;
        if (sortKey === "changePct") return row.tech?.changePct ?? -Infinity;
        if (sortKey === "rsRating") return row.tech?.rsRating?.rating ?? -Infinity;
        return "";
      };
      const av = get(a), bv = get(b);
      if (typeof av === "string") return sortDir * av.localeCompare(bv);
      return sortDir * ((av ?? -Infinity) - (bv ?? -Infinity));
    });
    return list;
  }, [computed, search, sortKey, sortDir]);

  const toggleSort = (k) => { if (sortKey === k) setSortDir((d) => -d); else { setSortKey(k); setSortDir(1); } };

  if (computed.length === 0) {
    return <div style={{ padding: 60, textAlign: "center", color: T.textDim }}>No Industry Group data yet — load stock data with price history on the Equities tab first (needs at least 3 stocks per industry group to build a meaningful synthetic index).</div>;
  }

  return (
    <div style={{ padding: "16px 24px 40px" }}>
      <div style={{ fontSize: 12, color: T.textDim, marginBottom: 16, lineHeight: 1.6 }}>
        {computed.length} industry groups — each a synthetic, equal-weighted price index built entirely from your loaded Equities data, run through the same technical engine as any real instrument. Read-only; nothing to upload here.
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ position: "relative", display: "inline-block" }}>
          <Search size={13} color={T.textDim} style={{ position: "absolute", left: 8, top: 8 }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search industry..."
            style={{ padding: "6px 10px 6px 26px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 200 }} />
        </div>
      </div>
      <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
        <table>
          <thead style={{ position: "sticky", top: 0, zIndex: 15, background: T.bg }}>
            <tr style={{ borderBottom: `1px solid ${T.border}`, fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              <th></th>
              <th onClick={() => toggleSort("Name")} style={{ cursor: "pointer" }}>Industry Group</th>
              <th onClick={() => toggleSort("CMP")} style={{ cursor: "pointer" }}>Index Level</th>
              <th onClick={() => toggleSort("changePct")} style={{ cursor: "pointer" }}>1D %</th>
              <th onClick={() => toggleSort("rsRating")} style={{ cursor: "pointer" }}>RS Rating</th>
              <th>Price vs MA</th>
              <th>MA vs MA</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => {
              const isOpen = expanded === s.ISIN;
              const t = s.tech;
              return (
                <React.Fragment key={s.ISIN}>
                  <tr onClick={() => setExpanded(isOpen ? null : s.ISIN)}
                    style={{ borderBottom: `1px solid ${T.border}`, fontSize: 12.5, cursor: "pointer", background: isOpen ? T.surfaceAlt : "transparent" }}>
                    <td>{isOpen ? <ChevronDown size={14} color={T.textDim} /> : <ChevronRight size={14} color={T.textDim} />}</td>
                    <td style={{ fontWeight: 600 }}>{s.Name}</td>
                    <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t ? fmtNum(t.cmp, 2) : "—"}</td>
                    <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.changePct > 0 ? T.gain : t?.changePct < 0 ? T.loss : T.textDim }}>{t ? fmtPct(t.changePct) : "—"}</td>
                    <td><RSRatingBadge rsRating={t?.rsRating} /></td>
                    <td>{t && [3, 8, 30, 50, 100, 200].map((n) => <SignalPill key={n} active={t.sSignals[n]} label={`S${n}`} streak={t.sStreaks?.[n]?.streak} capped={t.sStreaks?.[n]?.capped} />).reduce((a, b) => [a, " ", b])}</td>
                    <td>{t && [3, 8, 30, 100].map((n) => <SignalPill key={n} active={t.mSignals[n]} label={`M${n}`} streak={t.mStreaks?.[n]?.streak} capped={t.mStreaks?.[n]?.capped} />).reduce((a, b) => [a, " ", b])}</td>
                  </tr>
                  {isOpen && t && (
                    <tr>
                      <td colSpan={7} style={{ background: T.surface, padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
                        <div style={{ fontSize: 12, lineHeight: 2 }}>
                          <div>52w range: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.low52, 2)} – {fmtNum(t.high52, 2)}</b></div>
                          <div>Moving averages: {[3, 8, 30, 50, 100, 200].map((n) => <span key={n} style={{ fontFamily: "'IBM Plex Mono', monospace", marginRight: 10 }}>MA{n}: {fmtNum(t.mas[n], 2)}</span>)}</div>
                          <div>RSI (14): <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.rsi)}</b></div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Market Breadth Screen (Equities only — single flat reading, no bucketing) ----------
function MarketBreadthScreen({ series }) {
  const chartData = series.map((p, i) => ({
    i,
    pctAbove200: p.pctAbove200 != null ? Number(p.pctAbove200.toFixed(1)) : null,
    ma30: p.pctAbove200MA30 != null ? Number(p.pctAbove200MA30.toFixed(1)) : null,
    ma100: p.pctAbove200MA100 != null ? Number(p.pctAbove200MA100.toFixed(1)) : null,
    ma200: p.pctAbove200MA200 != null ? Number(p.pctAbove200MA200.toFixed(1)) : null,
    hlRatio: p.hlRatio != null ? Number(Math.min(p.hlRatio, 10).toFixed(2)) : 10,
  }));

  if (series.length === 0) {
    return (
      <div style={{ padding: 60, textAlign: "center", color: T.textDim }}>
        No breadth data yet. Load stock data with price history on the Equities tab first.
      </div>
    );
  }

  return (
    <div style={{ padding: "16px 24px 40px" }}>
      <div style={{ fontSize: 11, color: T.textDim, marginBottom: 16, lineHeight: 1.5 }}>
        Whole-market breadth — % of your entire loaded stock universe trading above its own 200-day moving average, plus new-highs vs. new-lows. No market-cap segmentation.
      </div>

      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: T.gold, marginBottom: 10 }}>% of stocks above their 200-day moving average — with 30/100/200-day smoothing</div>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={chartData}>
            <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
            <XAxis dataKey="i" tick={{ fill: T.textDim, fontSize: 10 }} tickLine={false} />
            <YAxis domain={[0, 100]} tick={{ fill: T.textDim, fontSize: 10 }} tickLine={false} />
            <Tooltip contentStyle={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, fontSize: 11 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="pctAbove200" name="Real (daily)" stroke={T.gold} dot={false} strokeWidth={1.75} />
            <Line type="monotone" dataKey="ma30" name="30d avg" stroke={T.loss} dot={false} strokeWidth={1} strokeDasharray="4 2" />
            <Line type="monotone" dataKey="ma100" name="100d avg" stroke={T.amber} dot={false} strokeWidth={1} strokeDasharray="4 2" />
            <Line type="monotone" dataKey="ma200" name="200d avg" stroke={T.gain} dot={false} strokeWidth={1} strokeDasharray="4 2" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: T.gold, marginBottom: 10 }}>New highs ÷ new lows ratio (capped at 10 for readability)</div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData}>
            <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
            <XAxis dataKey="i" tick={{ fill: T.textDim, fontSize: 10 }} tickLine={false} />
            <YAxis tick={{ fill: T.textDim, fontSize: 10 }} tickLine={false} />
            <Tooltip contentStyle={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, fontSize: 11 }} />
            <Line type="monotone" dataKey="hlRatio" stroke={T.gain} dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------- Main App ----------
export default function App() {
  const [activeAssetClass, setActiveAssetClass] = useState("equities");
  const [equitiesSubTab, setEquitiesSubTab] = useState("stocks");
  const [commoditiesSubTab, setCommoditiesSubTab] = useState("base");
  const [indicesSubTab, setIndicesSubTab] = useState("base");
  const [cryptoSubTab, setCryptoSubTab] = useState("base");
  const [alerts, setAlerts] = useState(DEFAULT_ALERTS);
  const [showAlerts, setShowAlerts] = useState(false);
  const [master, setMaster] = useState([]);
  const [fundamentals, setFundamentals] = useState([]);
  const [prices, setPrices] = useState([]);
  const [usingSample, setUsingSample] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sectorFilter, setSectorFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("Name");
  const [sortDir, setSortDir] = useState(1);
  const [expanded, setExpanded] = useState(null);
  const [status, setStatus] = useState("");

  // ---- Watchlists ----
  const [watchlists, setWatchlists] = useState({});   // { name: [ISIN, ...] }
  const [activeView, setActiveView] = useState("All"); // "All" or a watchlist name
  const [selected, setSelected] = useState(new Set());
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [newListDraft, setNewListDraft] = useState("");
  const [creatingList, setCreatingList] = useState(false);

  // ---- Universe management (add/remove tracked stocks) ----
  const [showManage, setShowManage] = useState(false);
  const [manageSearch, setManageSearch] = useState("");
  const [newStock, setNewStock] = useState({ ISIN: "", Symbol: "", Name: "", Sector: "", MarketCap: "", PE: "" });

  // ---- Column filters (numeric range, per column) ----
  const [colFilters, setColFilters] = useState({});
  const [openFilterKey, setOpenFilterKey] = useState(null);
  const applyFilter = (key, cfg) => setColFilters((prev) => ({ ...prev, [key]: cfg }));
  const clearFilter = (key) => setColFilters((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const clearAllFilters = () => { setColFilters({}); setMaFilters({ S: null, M: null }); };
  const [maFilters, setMaFilters] = useState({ S: null, M: null });

  useEffect(() => {
    (async () => {
      let loadedMasterCount = 0, loadedPriceCount = 0, hadMetaKey = false;
      try {
        const metaRes = await window.storage.get("screener-meta", false);
        if (metaRes && metaRes.value) {
          hadMetaKey = true;
          const parsed = JSON.parse(metaRes.value);
          setMaster(parsed.master || []);
          setFundamentals(parsed.fundamentals || []);
          setUsingSample(parsed.usingSample || false);
          loadedMasterCount = (parsed.master || []).length;
        }
        const loadedPrices = await loadChunkedArray("screener-prices");
        setPrices(loadedPrices);
        loadedPriceCount = loadedPrices.length;
      } catch (e) { console.error("Load from storage failed", e); }
      try {
        const wl = await window.storage.get("screener-watchlists", false);
        if (wl && wl.value) setWatchlists(JSON.parse(wl.value));
      } catch (e) { /* no watchlists yet */ }
      try {
        const al = await window.storage.get("meridian-alerts", false);
        if (al && al.value) setAlerts(JSON.parse(al.value));
        else await window.storage.set("meridian-alerts", JSON.stringify(DEFAULT_ALERTS), false);
      } catch (e) { /* no alerts yet */ }
      if (hadMetaKey && loadedMasterCount > 0) {
        setStatus(`Restored from last session: ${loadedMasterCount} stocks, ${loadedPriceCount.toLocaleString("en-IN")} price rows.`);
      } else if (hadMetaKey && loadedMasterCount === 0) {
        setStatus("⚠ Found saved settings but no stocks — a previous save may not have completed.");
      }
      setLoaded(true);
    })();
  }, []);

  const persistAlerts = useCallback(async (next) => {
    try { await window.storage.set("meridian-alerts", JSON.stringify(next), false); } catch (e) { console.error(e); }
  }, []);

  const markAlertDone = (id) => {
    setAlerts((prev) => {
      const next = prev
        .map((a) => {
          if (a.id !== id) return a;
          const nextDue = advanceDueDate(a.dueDate, a.recurrence);
          return nextDue ? { ...a, dueDate: nextDue } : null; // one-off alerts are removed once done
        })
        .filter(Boolean);
      persistAlerts(next);
      return next;
    });
  };

  const addAlert = (draft) => {
    setAlerts((prev) => {
      const next = [...prev, { id: `alert-${Date.now()}`, status: "pending", ...draft }];
      persistAlerts(next);
      return next;
    });
  };

  const dueAlertCount = alerts.filter((a) => a.dueDate <= todayStr()).length;

  const persistWatchlists = useCallback(async (next) => {
    try { await window.storage.set("screener-watchlists", JSON.stringify(next), false); } catch (e) { console.error(e); }
  }, []);

  const createWatchlist = (name) => {
    const trimmed = name.trim();
    if (!trimmed || watchlists[trimmed]) return;
    const next = { ...watchlists, [trimmed]: [] };
    setWatchlists(next);
    persistWatchlists(next);
    return trimmed;
  };

  const addSelectedToWatchlist = (name) => {
    const next = { ...watchlists, [name]: Array.from(new Set([...(watchlists[name] || []), ...selected])) };
    setWatchlists(next);
    persistWatchlists(next);
    setSelected(new Set());
    setShowAddMenu(false);
    setStatus(`Added ${selected.size} stock(s) to "${name}".`);
  };

  const addSelectedToNewWatchlist = () => {
    const name = createWatchlist(newListDraft);
    if (!name) return;
    const next = { ...watchlists, [name]: Array.from(selected) };
    setWatchlists(next);
    persistWatchlists(next);
    setSelected(new Set());
    setShowAddMenu(false);
    setCreatingList(false);
    setNewListDraft("");
    setActiveView(name);
    setStatus(`Created "${name}" with ${selected.size} stock(s).`);
  };

  const removeFromWatchlist = (name, isin) => {
    const next = { ...watchlists, [name]: (watchlists[name] || []).filter((x) => x !== isin) };
    setWatchlists(next);
    persistWatchlists(next);
  };

  const deleteWatchlist = (name) => {
    const next = { ...watchlists };
    delete next[name];
    setWatchlists(next);
    persistWatchlists(next);
    if (activeView === name) setActiveView("All");
  };

  const toggleSelect = (isin) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(isin)) next.delete(isin); else next.add(isin);
      return next;
    });
  };

  const persist = useCallback(async (next) => {
    try {
      await window.storage.set("screener-meta", JSON.stringify({
        master: next.master, fundamentals: next.fundamentals, usingSample: next.usingSample,
      }), false);
      await saveChunkedArray("screener-prices", next.prices || []);
      // Lightweight verification — checks the recorded row count, does NOT reload and
      // re-parse the full dataset (that reload was itself doubling peak memory usage on
      // large uploads and is the likely cause of the upload crash).
      const pricesOk = await verifyChunkedArraySaved("screener-prices", (next.prices || []).length);
      const checkMeta = await window.storage.get("screener-meta", false);
      const metaOk = checkMeta && checkMeta.value && JSON.parse(checkMeta.value).master?.length === (next.master || []).length;
      if (!metaOk || !pricesOk) {
        console.error("Persist verification failed", { metaOk, pricesOk });
        return false;
      }
      return true;
    } catch (e) { console.error(e); return false; }
  }, []);

  const loadSample = async () => {
    setMaster(SAMPLE_MASTER); setFundamentals(SAMPLE_FUND); setPrices(SAMPLE_PRICES);
    setUsingSample(true);
    const ok = await persist({ master: SAMPLE_MASTER, fundamentals: SAMPLE_FUND, prices: SAMPLE_PRICES, usingSample: true });
    setStatus(ok ? "Loaded demo data (synthetic — not real financials)." : "⚠ Demo data loaded but failed to save — it won't survive a reload.");
  };

  const clearAll = async () => {
    setMaster([]); setFundamentals([]); setPrices([]); setUsingSample(false);
    try { await window.storage.delete("screener-meta", false); } catch (e) {}
    await deleteChunkedArray("screener-prices");
    setStatus("Cleared.");
  };

  const addStockToUniverse = async () => {
    const isin = newStock.ISIN.trim();
    if (!isin || !newStock.Symbol.trim()) { setStatus("ISIN and Symbol are required to add a stock."); return; }
    if (master.some((m) => m.ISIN === isin)) { setStatus(`${isin} is already in the universe.`); return; }
    const row = {
      ISIN: isin, Symbol: newStock.Symbol.trim(), Name: newStock.Name.trim() || newStock.Symbol.trim(),
      Sector: newStock.Sector.trim() || "Unclassified",
      MarketCap: newStock.MarketCap === "" ? null : Number(newStock.MarketCap),
      PE: newStock.PE === "" ? null : Number(newStock.PE),
    };
    const nextMaster = [...master, row];
    setMaster(nextMaster);
    setUsingSample(false);
    const ok = await persist({ master: nextMaster, fundamentals, prices, usingSample: false });
    setNewStock({ ISIN: "", Symbol: "", Name: "", Sector: "", MarketCap: "", PE: "" });
    setStatus(ok
      ? `Added ${row.Symbol} to the universe. Upload/add its fundamentals and price history to see computed fields.`
      : `⚠ Added ${row.Symbol} but the save failed — it won't survive a reload.`);
  };

  const removeStockFromUniverse = async (isin, name) => {
    if (!window.confirm(`Remove ${name} (${isin}) from the tracked universe? This also clears its fundamentals, price history, and watchlist entries.`)) return;
    const nextMaster = master.filter((m) => m.ISIN !== isin);
    const nextFund = fundamentals.filter((f) => f.ISIN !== isin);
    const nextPrices = prices.filter((p) => p.ISIN !== isin);
    setMaster(nextMaster); setFundamentals(nextFund); setPrices(nextPrices);
    const ok = await persist({ master: nextMaster, fundamentals: nextFund, prices: nextPrices, usingSample });

    const nextWatchlists = Object.fromEntries(
      Object.entries(watchlists).map(([n, list]) => [n, list.filter((x) => x !== isin)])
    );
    setWatchlists(nextWatchlists);
    persistWatchlists(nextWatchlists);
    setSelected((prev) => { const next = new Set(prev); next.delete(isin); return next; });
    setStatus(ok ? `Removed ${name} from the universe.` : `⚠ Removed ${name} locally, but the save failed — it may reappear on reload.`);
  };

  const upsertByISIN = (existing, incoming) => {
    if (existing.length === 0) return incoming; // fast path for an initial full load — skip the filter/spread copy entirely
    const incomingISINs = new Set(incoming.map((r) => r.ISIN));
    return [...existing.filter((r) => !incomingISINs.has(r.ISIN)), ...incoming];
  };

  // Numeric fields per upload kind — used to convert only what actually needs to be a
  // number, instead of PapaParse's dynamicTyping, which runs expensive generic type-sniffing
  // on every single cell (including ISIN/Date strings) and was almost certainly the real
  // cause of the price-upload crash: 807,339 rows × 6 columns is ~4.8M cells of that
  // sniffing, entirely synchronous on the main thread.
  const NUMERIC_FIELDS = {
    master: new Set(["MarketCap", "PE", "PB"]),
    fundamentals: new Set(["ROE_Pct", "ROCE_Pct", "DebtEquity", "EPS", "Sales", "FixedAssets", "CWIP"]),
    prices: new Set(["High", "Low", "Close", "Volume"]),
  };

  const handleUpload = (file, kind) => {
    const numericFields = NUMERIC_FIELDS[kind] || new Set();
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      transform: (value, field) => (numericFields.has(field) ? (value === "" ? null : Number(value)) : value),
      complete: async (res) => {
        const rows = res.data;
        let nextMaster = master, nextFund = fundamentals, nextPrices = prices;
        // master/fundamentals/prices MERGE by ISIN — an upload only touches the stocks it contains,
        // so you can add or refresh one stock without wiping the rest of the universe.
        if (kind === "master") { nextMaster = upsertByISIN(master, rows); setMaster(nextMaster); }
        if (kind === "fundamentals") { nextFund = upsertByISIN(fundamentals, rows); setFundamentals(nextFund); }
        if (kind === "prices") { nextPrices = upsertByISIN(prices, rows); setPrices(nextPrices); }
        setUsingSample(false);
        setStatus(`Saving ${rows.length} rows to browser storage — don't close or navigate away yet...`);
        const ok = await persist({ master: nextMaster, fundamentals: nextFund, prices: nextPrices, usingSample: false });
        setStatus(ok
          ? `Saved. ${rows.length} rows loaded into ${kind} (merged by stock) and persisted for next time.`
          : `⚠ Save failed for ${kind} — data is showing now but will NOT survive a reload. Try again, or check the browser console.`);
      },
      error: (err) => setStatus(`Error parsing file: ${err.message}`),
    });
  };

  const closesById = useMemo(() => closesByKeyFromPrices(prices, "ISIN"), [prices]);
  const rsUniverse = useMemo(() => computeRSUniverse(closesById), [closesById]);
  const computed = useMemo(() => {
    const base = computeAll(master, fundamentals, prices);
    const fundScores = computeFundamentalScores(base);
    return base.map((s) => {
      const tech = s.tech ? { ...s.tech, rsRating: rsUniverse[s.ISIN] || null } : s.tech;
      const fund = s.fund ? { ...s.fund, score: fundScores[s.ISIN] || null } : s.fund;
      // Computed P/E = CMP / latest EPS from the fundamentals file, replacing whatever
      // (usually blank) PE value came in via the Company Master upload — but falling back
      // to the uploaded/manual value when EPS data isn't available yet, rather than blanking it.
      const peComputed = tech && fund && fund.epsLatest ? tech.cmp / fund.epsLatest : null;
      return { ...s, tech, fund, PE: peComputed != null ? peComputed : s.PE };
    });
  }, [master, fundamentals, prices, rsUniverse]);

  // Market Breadth: single flat computation, no bucketing (removed — it was being computed
  // and then entirely discarded, since only the flat reading is ever displayed; this was
  // real wasted work, not just unused code — breadth alone is the single most expensive
  // computation in the app, walking up to 500 days across every stock).
  const needsBreadthCompute = activeAssetClass === "equities" && equitiesSubTab === "breadth";
  const breadthSeries = useMemo(
    () => (needsBreadthCompute ? computeBreadthSeries(master, closesById) : []),
    [master, closesById, needsBreadthCompute]
  );

  // Golden Breakout: a single flat filter+sort over the already-computed stock list — no
  // bucketing, no cross-population ranking, so this is cheap (O(n)) and doesn't need the
  // same eager-computation caution as breadth. Still gated to the tab being open, for
  // consistency and to avoid any unnecessary work while sitting on the base data screen.
  const goldenBreakoutCandidates = useMemo(
    () => (activeAssetClass === "equities" && equitiesSubTab === "breakout" ? runGoldenBreakoutScreener(computed) : []),
    [computed, activeAssetClass, equitiesSubTab]
  );

  // Sectoral: derived from Equities data, only computed when its sub-tabs are actually open.
  const needsSectoralCompute = activeAssetClass === "equities" && (equitiesSubTab === "sectoral" || equitiesSubTab === "sectoralBreakout");
  const sectoralComputed = useMemo(() => {
    if (!needsSectoralCompute) return [];
    const seriesBySector = computeSectoralSeries(master, prices);
    const sectorNames = Object.keys(seriesBySector);
    const closesBySector = {};
    sectorNames.forEach((name) => { closesBySector[name] = seriesBySector[name].map((r) => r.Close); });
    const rsUniverseSector = computeRSUniverse(closesBySector);
    return sectorNames.map((name) => {
      const tech = computeTechnicalBlock(seriesBySector[name]);
      return { ISIN: name, Name: name, Symbol: name, IndustryGroup: name, tech: tech ? { ...tech, rsRating: rsUniverseSector[name] || null } : tech, fund: null };
    });
  }, [master, prices, needsSectoralCompute]);
  const sectoralBreakoutCandidates = useMemo(
    () => (equitiesSubTab === "sectoralBreakout" ? runGoldenBreakoutScreener(sectoralComputed) : []),
    [sectoralComputed, equitiesSubTab]
  );

  const sectors = useMemo(() => ["All", ...Array.from(new Set(master.map((m) => m.Sector).filter(Boolean)))], [master]);

  const filtered = useMemo(() => {
    let list = computed.filter((s) =>
      (sectorFilter === "All" || s.Sector === sectorFilter) &&
      (search === "" || (s.Name || "").toLowerCase().includes(search.toLowerCase()) || (s.Symbol || "").toLowerCase().includes(search.toLowerCase())) &&
      (activeView === "All" || (watchlists[activeView] || []).includes(s.ISIN)) &&
      Object.entries(colFilters).every(([key, cfg]) => {
        const def = FILTERABLE_COLUMNS[key];
        if (!def) return true;
        const val = def.accessor(s);
        if (cfg.min != null && (val == null || val < cfg.min)) return false;
        if (cfg.max != null && (val == null || val > cfg.max)) return false;
        return true;
      }) &&
      matchesMASignals(s.tech?.sSignals, s.tech?.sStreaks, maFilters.S, [3, 8, 30, 50, 100, 200]) &&
      matchesMASignals(s.tech?.mSignals, s.tech?.mStreaks, maFilters.M, [3, 8, 30, 100])
    );
    list.sort((a, b) => {
      const get = (row) => {
        if (sortKey === "Name") return row.Name || "";
        if (sortKey === "Sector") return row.Sector || "";
        if (sortKey === "CMP") return row.tech?.cmp ?? -Infinity;
        if (sortKey === "changePct") return row.tech?.changePct ?? -Infinity;
        if (sortKey === "MarketCap") return row.MarketCap ?? -Infinity;
        if (sortKey === "PE") return row.PE ?? -Infinity;
        if (sortKey === "ROE") return row.fund?.roe?.lastYr ?? -Infinity;
        if (sortKey === "fundTier") return row.fund?.score?.score ?? -Infinity;
        if (sortKey === "RSI") return row.tech?.rsi ?? -Infinity;
        if (sortKey === "relStrength") return row.tech?.rsRating?.rating ?? -Infinity;
        if (sortKey === "pctFromHigh52") return row.tech?.pctFromHigh52 ?? -Infinity;
        if (sortKey === "pctFromLow52") return row.tech?.pctFromLow52 ?? -Infinity;
        if (sortKey === "volBreakout") return row.tech?.volBreakoutPct ?? -Infinity;
        return "";
      };
      const av = get(a), bv = get(b);
      if (typeof av === "string") return sortDir * av.localeCompare(bv);
      return sortDir * ((av ?? -Infinity) - (bv ?? -Infinity));
    });
    return list;
  }, [computed, sectorFilter, search, sortKey, sortDir, activeView, watchlists, colFilters, maFilters]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => -d); else { setSortKey(key); setSortDir(1); }
  };
  const sortArrow = (key) => {
    if (sortKey !== key) return null;
    const up = sortDir === 1;
    // CSS-drawn triangle instead of a unicode glyph — the ▲/▼ characters were
    // rendering invisibly on some iPad screens depending on font fallback, this is
    // guaranteed to render on every platform since it's a shape, not a character.
    return (
      <span style={{
        display: "inline-block", marginLeft: 5, width: 0, height: 0, verticalAlign: "middle",
        borderLeft: "4px solid transparent", borderRight: "4px solid transparent",
        borderBottom: up ? `6px solid ${T.gold}` : "none",
        borderTop: up ? "none" : `6px solid ${T.gold}`,
      }} />
    );
  };

  const FilterableTh = ({ colKey, label }) => (
    <th style={{ position: "relative" }}>
      <span onClick={() => toggleSort(colKey)} style={{ cursor: "pointer" }}>{label}{sortArrow(colKey)}</span>
      <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === colKey ? null : colKey); }}
        style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
        <Filter size={10} color={colFilters[colKey] ? T.gold : T.textDim} />
      </button>
      {openFilterKey === colKey && (
        <NumFilterPopover colKey={colKey} label={label} current={colFilters[colKey]}
          onApply={applyFilter} onClear={clearFilter} onClose={() => setOpenFilterKey(null)} />
      )}
    </th>
  );

  const hasData = master.length > 0;

  return (
    <div onClick={() => { setOpenFilterKey(null); setShowAlerts(false); }} style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <style>{FONTS}{`
        * { box-sizing: border-box; }
        table { border-collapse: collapse; width: 100%; }
        th, td { text-align: left; padding: 8px 10px; }
        ::-webkit-scrollbar { height: 8px; width: 8px; }
        ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 4px; }
        input, select { font-family: inherit; }
        button { font-family: inherit; cursor: pointer; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${T.border}`, padding: "18px 24px", display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontFamily: "'IBM Plex Serif', serif", fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em", color: T.gold }}>Meridian</div>
          <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>Fundamental + technical signal ledger — NIFTY 50 pilot</div>
        </div>
        <div style={{ fontSize: 11, color: T.textDim, fontFamily: "'IBM Plex Mono', monospace", display: "flex", alignItems: "center", gap: 14 }}>
          {hasData ? `${computed.length} stocks loaded${usingSample ? " · DEMO DATA" : ""}` : "No data loaded"}
          <span style={{ position: "relative" }}>
            <button onClick={() => setShowAlerts((v) => !v)} style={{
              padding: 6, borderRadius: 6, border: `1px solid ${T.border}`, background: showAlerts ? T.surfaceAlt : "transparent",
              display: "inline-flex", alignItems: "center", position: "relative",
            }}>
              <Bell size={14} color={dueAlertCount > 0 ? T.gold : T.textDim} />
              {dueAlertCount > 0 && (
                <span style={{
                  position: "absolute", top: -4, right: -4, background: T.loss, color: "#fff", borderRadius: "50%",
                  width: 14, height: 14, fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700,
                }}>{dueAlertCount}</span>
              )}
            </button>
            {showAlerts && (
              <AlertsPanel alerts={alerts} onMarkDone={markAlertDone} onAddAlert={addAlert} onClose={() => setShowAlerts(false)} />
            )}
          </span>
        </div>
      </div>

      {/* Top-level asset class tabs */}
      <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
        {[
          { key: "equities", label: "Equities", accent: T.gold },
          { key: "commodities", label: "Commodities", accent: ASSET_CLASSES.commodities.accent },
          { key: "indices", label: "Global Indices", accent: ASSET_CLASSES.indices.accent },
          { key: "crypto", label: "Crypto", accent: ASSET_CLASSES.crypto.accent },
        ].map((tab) => (
          <button key={tab.key} onClick={() => setActiveAssetClass(tab.key)} style={{
            padding: "10px 18px", border: "none", borderBottom: `2px solid ${activeAssetClass === tab.key ? tab.accent : "transparent"}`,
            background: "transparent", color: activeAssetClass === tab.key ? tab.accent : T.textDim, fontSize: 13, fontWeight: 600,
          }}>{tab.label}</button>
        ))}
      </div>

      {/* Sub-tabs, per asset class */}
      {activeAssetClass === "equities" && (
        <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>
          {[
            { key: "stocks", label: "Stocks" }, { key: "breakout", label: "Golden Breakout" },
            { key: "sectoral", label: "Sectoral" }, { key: "sectoralBreakout", label: "Sectoral Breakout" },
            { key: "breadth", label: "Market Breadth" },
          ].map((tab) => (
            <button key={tab.key} onClick={() => setEquitiesSubTab(tab.key)} style={{
              padding: "8px 14px", border: "none", borderBottom: `2px solid ${equitiesSubTab === tab.key ? T.gold : "transparent"}`,
              background: "transparent", color: equitiesSubTab === tab.key ? T.gold : T.textDim, fontSize: 11.5, fontWeight: 600,
            }}>{tab.label}</button>
          ))}
        </div>
      )}
      {activeAssetClass === "commodities" && (
        <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>
          {[{ key: "base", label: "Commodities" }, { key: "breakout", label: "Golden Breakout" }].map((tab) => (
            <button key={tab.key} onClick={() => setCommoditiesSubTab(tab.key)} style={{
              padding: "8px 14px", border: "none", borderBottom: `2px solid ${commoditiesSubTab === tab.key ? ASSET_CLASSES.commodities.accent : "transparent"}`,
              background: "transparent", color: commoditiesSubTab === tab.key ? ASSET_CLASSES.commodities.accent : T.textDim, fontSize: 11.5, fontWeight: 600,
            }}>{tab.label}</button>
          ))}
        </div>
      )}
      {activeAssetClass === "indices" && (
        <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>
          {[{ key: "base", label: "Global Indices" }, { key: "breakout", label: "Golden Breakout" }].map((tab) => (
            <button key={tab.key} onClick={() => setIndicesSubTab(tab.key)} style={{
              padding: "8px 14px", border: "none", borderBottom: `2px solid ${indicesSubTab === tab.key ? ASSET_CLASSES.indices.accent : "transparent"}`,
              background: "transparent", color: indicesSubTab === tab.key ? ASSET_CLASSES.indices.accent : T.textDim, fontSize: 11.5, fontWeight: 600,
            }}>{tab.label}</button>
          ))}
        </div>
      )}
      {activeAssetClass === "crypto" && (
        <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>
          {[{ key: "base", label: "Crypto" }, { key: "breakout", label: "Golden Breakout" }].map((tab) => (
            <button key={tab.key} onClick={() => setCryptoSubTab(tab.key)} style={{
              padding: "8px 14px", border: "none", borderBottom: `2px solid ${cryptoSubTab === tab.key ? ASSET_CLASSES.crypto.accent : "transparent"}`,
              background: "transparent", color: cryptoSubTab === tab.key ? ASSET_CLASSES.crypto.accent : T.textDim, fontSize: 11.5, fontWeight: 600,
            }}>{tab.label}</button>
          ))}
        </div>
      )}

      {activeAssetClass === "equities" && equitiesSubTab === "stocks" && (
      <>
      {/* Data controls */}
      <div style={{ padding: "16px 24px", background: T.surface, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {[
            { kind: "master", label: "Company master" },
            { kind: "fundamentals", label: "Fundamentals (annual)" },
            { kind: "prices", label: "Prices (daily EOD)" },
          ].map(({ kind, label }) => (
            <label key={kind} style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 6,
              border: `1px solid ${T.border}`, fontSize: 12, color: T.text, background: T.surfaceAlt,
            }}>
              <Upload size={13} color={T.gold} /> {label}
              <input type="file" accept=".csv" style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleUpload(e.target.files[0], kind)} />
            </label>
          ))}
          <button onClick={loadSample} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.gold}`, background: "transparent", color: T.gold, fontSize: 12, fontWeight: 600 }}>
            Load demo data
          </button>
          <button onClick={() => setShowManage((v) => !v)} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.border}`, background: showManage ? T.surfaceAlt : "transparent", color: T.text, fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ListPlus size={13} color={T.gold} /> Manage universe ({master.length})
          </button>
          <button onClick={clearAll} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <RotateCcw size={12} /> Clear
          </button>
          {status && <span style={{ fontSize: 11, color: T.textDim, marginLeft: 4 }}>{status}</span>}
        </div>
        <div style={{ fontSize: 11, color: T.textDim, marginTop: 10, lineHeight: 1.5 }}>
          <b style={{ color: T.text }}>CSV columns expected —</b> Company master: ISIN, Symbol, Name, Sector, IndustryGroup (broader sector for Sector RS), MarketCap, PE (auto-computed from CMP/latest EPS) · Fundamentals (one row per stock per FY, last 4 years): ISIN, FY, ROE_Pct, ROCE_Pct, DebtEquity, EPS, Sales, FixedAssets, CWIP · Prices (one row per stock per trading day, ~1yr+): ISIN, Date, Close, Volume, plus optional High, Low for more accurate volatility-contraction readings. Uploads merge in by stock — they only touch the ISINs they contain.
        </div>

        {showManage && (
          <div style={{ marginTop: 14, background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: T.gold, marginBottom: 10 }}>Add a stock to the universe</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              {["ISIN", "Symbol", "Name", "Sector"].map((f) => (
                <input key={f} value={newStock[f]} onChange={(e) => setNewStock({ ...newStock, [f]: e.target.value })} placeholder={f}
                  style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: f === "Name" ? 160 : 120 }} />
              ))}
              {["MarketCap", "PE"].map((f) => (
                <input key={f} value={newStock[f]} onChange={(e) => setNewStock({ ...newStock, [f]: e.target.value })} placeholder={f === "MarketCap" ? "MarketCap ₹Cr" : f}
                  type="number" style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 90 }} />
              ))}
              <button onClick={addStockToUniverse} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${T.gold}`, background: "rgba(201,162,39,0.12)", color: T.gold, fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Plus size={12} /> Add stock
              </button>
            </div>
            <div style={{ fontSize: 10.5, color: T.textDim, marginBottom: 10 }}>
              A stock added here has no fundamentals or price history yet — upload its data (merges in without touching anyone else) or wait for the next automated technicals refresh.
            </div>

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: T.gold, marginBottom: 8, marginTop: 14 }}>Current universe ({master.length})</div>
            <input value={manageSearch} onChange={(e) => setManageSearch(e.target.value)} placeholder="Filter..."
              style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 160, marginBottom: 8 }} />
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {master.filter((m) => !manageSearch || (m.Name || "").toLowerCase().includes(manageSearch.toLowerCase()) || (m.Symbol || "").toLowerCase().includes(manageSearch.toLowerCase()))
                .map((m) => (
                  <div key={m.ISIN} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 4px", borderBottom: `1px solid ${T.border}`, fontSize: 12 }}>
                    <span>{m.Name} <span style={{ color: T.textDim, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5 }}>{m.Symbol} · {m.ISIN}</span></span>
                    <button onClick={() => removeStockFromUniverse(m.ISIN, m.Name)} title="Remove from universe"
                      style={{ padding: 4, borderRadius: 4, border: `1px solid ${T.border}`, background: "transparent", color: T.loss, display: "inline-flex" }}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              {master.length === 0 && <div style={{ color: T.textDim, fontSize: 12 }}>No stocks yet.</div>}
            </div>
          </div>
        )}
      </div>

      {!hasData ? (
        <div style={{ padding: 60, textAlign: "center", color: T.textDim }}>
          Upload your CSVs or load demo data to see the screen.
        </div>
      ) : (
        <>
          {/* Watchlist tabs */}
          <div style={{ padding: "12px 24px 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={() => setActiveView("All")} style={{
              padding: "6px 14px", borderRadius: 16, fontSize: 12, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${activeView === "All" ? T.gold : T.border}`,
              background: activeView === "All" ? "rgba(201,162,39,0.12)" : "transparent",
              color: activeView === "All" ? T.gold : T.textDim,
            }}>All Stocks ({computed.length})</button>
            {Object.keys(watchlists).map((name) => (
              <span key={name} style={{ display: "inline-flex", alignItems: "center" }}>
                <button onClick={() => setActiveView(name)} style={{
                  padding: "6px 10px 6px 14px", borderRadius: "16px 0 0 16px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${activeView === name ? T.gold : T.border}`, borderRight: "none",
                  background: activeView === name ? "rgba(201,162,39,0.12)" : "transparent",
                  color: activeView === name ? T.gold : T.textDim, display: "inline-flex", alignItems: "center", gap: 5,
                }}><Star size={11} /> {name} ({(watchlists[name] || []).length})</button>
                <button onClick={() => deleteWatchlist(name)} title="Delete watchlist" style={{
                  padding: "6px 8px", borderRadius: "0 16px 16px 0", fontSize: 12, cursor: "pointer",
                  border: `1px solid ${activeView === name ? T.gold : T.border}`,
                  background: activeView === name ? "rgba(201,162,39,0.12)" : "transparent", color: T.textDim,
                }}><X size={11} /></button>
              </span>
            ))}
            {creatingList ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <input autoFocus value={newListDraft} onChange={(e) => setNewListDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && newListDraft.trim()) { setActiveView(createWatchlist(newListDraft)); setNewListDraft(""); setCreatingList(false); } if (e.key === "Escape") { setCreatingList(false); setNewListDraft(""); } }}
                  placeholder="Watchlist name..." style={{ padding: "5px 10px", borderRadius: 14, border: `1px solid ${T.gold}`, background: T.surface, color: T.text, fontSize: 12, width: 130 }} />
              </span>
            ) : (
              <button onClick={() => setCreatingList(true)} style={{
                padding: "6px 10px", borderRadius: 16, fontSize: 12, cursor: "pointer", border: `1px dashed ${T.border}`,
                background: "transparent", color: T.textDim, display: "inline-flex", alignItems: "center", gap: 4,
              }}><Plus size={11} /> New watchlist</button>
            )}
          </div>

          {/* Filters */}
          <div style={{ padding: "12px 24px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ position: "relative" }}>
              <Search size={13} color={T.textDim} style={{ position: "absolute", left: 8, top: 8 }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search stock..."
                style={{ padding: "6px 10px 6px 26px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 160 }} />
            </div>
            <select value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }}>
              {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {(Object.keys(colFilters).length > 0 || maFilters.S || maFilters.M) && (
              <button onClick={clearAllFilters} style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11.5, display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Filter size={11} color={T.gold} /> {Object.keys(colFilters).length + (maFilters.S?1:0) + (maFilters.M?1:0)} filter{(Object.keys(colFilters).length + (maFilters.S?1:0) + (maFilters.M?1:0)) > 1 ? "s" : ""} active <X size={11} />
              </button>
            )}
            {selected.size > 0 && (
              <div style={{ position: "relative", marginLeft: "auto" }}>
                <button onClick={() => setShowAddMenu((v) => !v)} style={{
                  padding: "6px 12px", borderRadius: 6, border: `1px solid ${T.gold}`, background: "rgba(201,162,39,0.12)",
                  color: T.gold, fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6,
                }}><ListPlus size={13} /> Add {selected.size} to watchlist</button>
                {showAddMenu && (
                  <div style={{ position: "absolute", right: 0, top: "110%", background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 8, padding: 8, minWidth: 180, zIndex: 10, boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
                    {Object.keys(watchlists).length > 0 && Object.keys(watchlists).map((name) => (
                      <div key={name} onClick={() => addSelectedToWatchlist(name)} style={{ padding: "7px 8px", fontSize: 12, cursor: "pointer", borderRadius: 5, color: T.text }}
                        onMouseEnter={(e) => e.currentTarget.style.background = T.surface} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                        {name} ({(watchlists[name] || []).length})
                      </div>
                    ))}
                    <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 6, display: "flex", gap: 4 }}>
                      <input value={newListDraft} onChange={(e) => setNewListDraft(e.target.value)} placeholder="New watchlist..."
                        onKeyDown={(e) => e.key === "Enter" && addSelectedToNewWatchlist()}
                        style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }} />
                      <button onClick={addSelectedToNewWatchlist} style={{ padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.gold}`, background: "transparent", color: T.gold, fontSize: 12 }}>Add</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Table */}
          <div style={{ padding: "0 24px 40px", overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
            {filtered.length === 0 && activeView !== "All" ? (
              <div style={{ padding: 40, textAlign: "center", color: T.textDim, fontSize: 13 }}>
                "{activeView}" is empty. Select stocks in "All Stocks" and add them here.
              </div>
            ) : (
            <table>
              <thead style={{ position: "sticky", top: 0, zIndex: 15, background: T.bg }}>
                <tr style={{ borderBottom: `1px solid ${T.border}`, fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  <th></th>
                  <th></th>
                  <th onClick={() => toggleSort("Name")} style={{ cursor: "pointer" }}>Stock{sortArrow("Name")}</th>
                  <th onClick={() => toggleSort("Sector")} style={{ cursor: "pointer" }}>Sector{sortArrow("Sector")}</th>
                  <th onClick={() => toggleSort("CMP")} style={{ cursor: "pointer" }}>CMP{sortArrow("CMP")}</th>
                  <FilterableTh colKey="changePct" label="1D %" />
                  <FilterableTh colKey="MarketCap" label="Mkt Cap" />
                  <FilterableTh colKey="PE" label="P/E" />
                  <FilterableTh colKey="ROE" label="ROE (LY)" />
                  <FilterableTh colKey="fundTier" label="Fund Score" />
                  <FilterableTh colKey="RSI" label="RSI" />
                  <FilterableTh colKey="relStrength" label="RS Rating" />
                  <FilterableTh colKey="pctFromHigh52" label="% fr 52wH" />
                  <FilterableTh colKey="pctFromLow52" label="% fr 52wL" />
                  <FilterableTh colKey="volBreakout" label="Vol Brk %" />
                  <th style={{ position: "relative" }} title="Sort not yet available for moving-average columns">
                    Price vs MA
                    <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === "maS" ? null : "maS"); }}
                      style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
                      <Filter size={10} color={maFilters.S ? T.gold : T.textDim} />
                    </button>
                    {openFilterKey === "maS" && (
                      <MASignalFilterPopover title="Filter: Price vs Moving Average" periods={[3, 8, 30, 50, 100, 200]} prefix="S"
                        current={maFilters.S} onApply={(cfg) => setMaFilters((f) => ({ ...f, S: cfg }))}
                        onClear={() => setMaFilters((f) => ({ ...f, S: null }))} onClose={() => setOpenFilterKey(null)} />
                    )}
                  </th>
                  <th style={{ position: "relative" }} title="Sort not yet available for moving-average columns">
                    MA vs MA
                    <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === "maM" ? null : "maM"); }}
                      style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
                      <Filter size={10} color={maFilters.M ? T.gold : T.textDim} />
                    </button>
                    {openFilterKey === "maM" && (
                      <MASignalFilterPopover title="Filter: MA vs MA" periods={[3, 8, 30, 100]} prefix="M"
                        current={maFilters.M} onApply={(cfg) => setMaFilters((f) => ({ ...f, M: cfg }))}
                        onClear={() => setMaFilters((f) => ({ ...f, M: null }))} onClose={() => setOpenFilterKey(null)} />
                    )}
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const isOpen = expanded === s.ISIN;
                  const t = s.tech, f = s.fund;
                  return (
                    <React.Fragment key={s.ISIN}>
                      <tr onClick={() => setExpanded(isOpen ? null : s.ISIN)}
                        style={{ borderBottom: `1px solid ${T.border}`, fontSize: 12.5, cursor: "pointer", background: isOpen ? T.surfaceAlt : "transparent" }}>
                        <td onClick={(e) => { e.stopPropagation(); toggleSelect(s.ISIN); }}>
                          <input type="checkbox" checked={selected.has(s.ISIN)} onChange={() => {}} style={{ cursor: "pointer" }} />
                        </td>
                        <td>{isOpen ? <ChevronDown size={14} color={T.textDim} /> : <ChevronRight size={14} color={T.textDim} />}</td>
                        <td style={{ fontWeight: 600 }}>{s.Name}<div style={{ fontSize: 10, color: T.textDim, fontFamily: "'IBM Plex Mono', monospace" }}>{s.Symbol}</div></td>
                        <td style={{ color: T.textDim }}>{s.Sector}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t ? `₹${fmtNum(t.cmp, 2)}` : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.changePct > 0 ? T.gain : t?.changePct < 0 ? T.loss : T.textDim }}>{t ? fmtPct(t.changePct) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{s.MarketCap != null ? fmtCr(s.MarketCap) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(s.PE)}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{f ? fmtPct(f.roe.lastYr) : "—"}</td>
                        <td><FundTierBadge fundScore={f?.score} /></td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.rsi > 70 ? T.loss : t?.rsi < 30 ? T.gain : T.text }}>{t ? fmtNum(t.rsi) : "—"}</td>
                        <td><RSRatingBadge rsRating={t?.rsRating} /></td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.textDim }}>{t ? fmtPct(t.pctFromHigh52, 0) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.gain }}>{t ? fmtPct(t.pctFromLow52, 0) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.volBreakoutPct > 150 ? T.gold : T.textDim, fontWeight: t?.volBreakoutPct > 150 ? 700 : 400 }}>{t && t.volBreakoutPct != null ? `${fmtNum(t.volBreakoutPct, 0)}%` : "—"}</td>
                        <td>
                          {t && [3, 8, 30, 50, 100, 200].map((n) => <SignalPill key={n} active={t.sSignals[n]} label={`S${n}`} streak={t.sStreaks?.[n]?.streak} capped={t.sStreaks?.[n]?.capped} />).reduce((a, b) => [a, " ", b])}
                        </td>
                        <td>
                          {t && [3, 8, 30, 100].map((n) => <SignalPill key={n} active={t.mSignals[n]} label={`M${n}`} streak={t.mStreaks?.[n]?.streak} capped={t.mStreaks?.[n]?.capped} />).reduce((a, b) => [a, " ", b])}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {activeView !== "All" && (
                            <button onClick={() => removeFromWatchlist(activeView, s.ISIN)} title={`Remove from ${activeView}`}
                              style={{ padding: 4, borderRadius: 4, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, display: "inline-flex" }}>
                              <X size={11} />
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={18} style={{ background: T.surface, padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
                              <div>
                                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: T.gold, marginBottom: 8 }}>Fundamentals — {f?.latestFY || "—"}</div>
                                {f ? (
                                  <>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0 10px", borderBottom: `1px solid ${T.border}`, marginBottom: 8 }}>
                                      <span style={{ fontSize: 11, color: T.textDim }}>Composite score:</span>
                                      <FundTierBadge fundScore={f.score} />
                                      {f.score?.exempt && <span style={{ fontSize: 10, color: T.textDim }}>* financial-sector weighting</span>}
                                    </div>
                                    <div style={{ display: "grid", gridTemplateColumns: "110px 70px 70px 70px 1fr", gap: 8, fontSize: 10, color: T.textDim, marginBottom: 4 }}>
                                      <span>Metric</span><span>3yr avg</span><span>Last yr</span><span>Var %</span><span>Signal</span>
                                    </div>
                                    <FundRow label="ROE" block={f.roe} />
                                    <FundRow label="ROCE" block={f.roce} />
                                    <FundRow label="EPS growth" block={f.epsGrowth} />
                                    <FundRow label="Sales growth" block={f.salesGrowth} />
                                    <FundRow label="Debt/Equity" block={f.debtEquity} isPercent={false} />
                                    <FundRow label="Asset turns" block={f.assetTurns} isPercent={false} />
                                    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 12 }}>
                                      <span style={{ color: T.textDim }}>CWIP % of Fixed Assets</span>
                                      <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(f.cwipPct)}%</span>
                                    </div>
                                  </>
                                ) : <div style={{ color: T.textDim, fontSize: 12 }}>No fundamentals data for this stock.</div>}
                              </div>
                              <div>
                                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: T.gold, marginBottom: 8 }}>Technicals</div>
                                {t ? (
                                  <div style={{ fontSize: 12, lineHeight: 2 }}>
                                    <div>52w range: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>₹{fmtNum(t.low52, 2)} – ₹{fmtNum(t.high52, 2)}</b></div>
                                    <div>% from 52w high / low: <b style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.loss }}>{fmtPct(t.pctFromHigh52, 0)}</b> <span style={{ color: T.textDim }}>/</span> <b style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.gain }}>{fmtPct(t.pctFromLow52, 0)}</b></div>
                                    <div>CMP / 52w low: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.cmpOverLow52, 2)}x</b></div>
                                    <div>Volume today / 30d avg: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t.volToday?.toLocaleString("en-IN")} / {Math.round(t.vol30 || 0).toLocaleString("en-IN")}</b></div>
                                    <div>Moving averages: {[3, 8, 30, 50, 100, 200].map((n) => <span key={n} style={{ fontFamily: "'IBM Plex Mono', monospace", marginRight: 10 }}>MA{n}: {fmtNum(t.mas[n], 2)}</span>)}</div>
                                    <div>RSI (14): <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.rsi)}</b></div>
                                    <div>RS Rating (vs universe): <RSRatingBadge rsRating={t.rsRating} /></div>
                                  </div>
                                ) : <div style={{ color: T.textDim, fontSize: 12 }}>No price data for this stock.</div>}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            )}
          </div>
        </>
      )}
      </>
      )}

      {activeAssetClass === "equities" && equitiesSubTab === "breakout" && (
        <GoldenBreakoutScreen candidates={goldenBreakoutCandidates} accent={T.gold} hasFundamentals={true} itemLabel="Stock" />
      )}
      {activeAssetClass === "equities" && equitiesSubTab === "sectoral" && (
        <SectoralScreen computed={sectoralComputed} accent={T.gold} />
      )}
      {activeAssetClass === "equities" && equitiesSubTab === "sectoralBreakout" && (
        <GoldenBreakoutScreen candidates={sectoralBreakoutCandidates} accent={T.gold} hasFundamentals={false} itemLabel="Industry" />
      )}
      {activeAssetClass === "equities" && equitiesSubTab === "breadth" && (
        <MarketBreadthScreen series={breadthSeries} />
      )}

      {activeAssetClass === "commodities" && commoditiesSubTab === "base" && <GenericAssetScreen config={ASSET_CLASSES.commodities} />}
      {activeAssetClass === "commodities" && commoditiesSubTab === "breakout" && <GenericGoldenBreakoutScreen config={ASSET_CLASSES.commodities} />}

      {activeAssetClass === "indices" && indicesSubTab === "base" && <GenericAssetScreen config={ASSET_CLASSES.indices} />}
      {activeAssetClass === "indices" && indicesSubTab === "breakout" && <GenericGoldenBreakoutScreen config={ASSET_CLASSES.indices} />}

      {activeAssetClass === "crypto" && cryptoSubTab === "base" && <GenericAssetScreen config={ASSET_CLASSES.crypto} />}
      {activeAssetClass === "crypto" && cryptoSubTab === "breakout" && <GenericGoldenBreakoutScreen config={ASSET_CLASSES.crypto} />}
    </div>
  );
}
```
