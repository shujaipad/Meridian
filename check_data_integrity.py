"""
Fast integrity guards over the committed data files.

Every assertion here corresponds to a bug that actually happened, not a
hypothetical. Each one is seconds to check and was expensive to find:

  * float-contaminated BSE codes  — a pandas read/write round-trip rewrote
    "544467" as "544467.0", producing tickers like 544467.0.BO and failing 353
    instruments in the first backfill run.
  * phantom trading days          — Yahoo emits bars for a few BSE-only tickers
    on days the market is closed. pandas `rolling(200)` counts rows, so one
    near-empty holiday row NaNs out MA200 for every stock that correctly did
    not trade; the backtest collapsed from 459 episodes to 21.
  * non-positive adjusted prices  — Yahoo's dividend adjustment can exceed a
    very low historical price (Elcid Investments), yielding negative closes
    that are meaningless for a moving average.

Run: python3 check_data_integrity.py
Exits non-zero on any failure, so CI can gate on it.
"""

import glob
import os
import sys

import pandas as pd

BASE = os.path.dirname(os.path.abspath(__file__))
MASTER = os.path.join(BASE, "meridian-company-master-2138.csv")
PRICES = os.path.join(BASE, "meridian-price-history-2090-part*of3.csv")
FUNDAMENTALS = os.path.join(BASE, "meridian-fundamentals-742.csv")
MIN_COVERAGE = 0.05

failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


print("universe master")
master = pd.read_csv(MASTER, dtype=str).fillna("")
check("no float-formatted BSE codes",
      not master.BSECode.str.endswith(".0").any(),
      f"{master.BSECode.str.endswith('.0').sum()} offending rows")
check("no float-formatted NSE codes", not master.NSECode.str.endswith(".0").any())
check("ISINs unique", master.ISIN.is_unique,
      f"{len(master)} rows, {master.ISIN.nunique()} unique")
check("ISINs well-formed",
      bool(master.ISIN.str.match(r"^IN[EFN0-9][0-9A-Z]{9}$").all()))
check("every row listed on an exchange",
      not ((master.NSECode == "") & (master.BSECode == "")).any())
check("no REITs/InvITs in the universe",
      not master.Sector.eq("REITs-InvITs").any())

print("\nprice history")
paths = sorted(glob.glob(PRICES))
check("price parts present", len(paths) == 3, f"found {len(paths)}")
prices = pd.concat([pd.read_csv(p) for p in paths], ignore_index=True)
n_inst = prices.ISIN.nunique()
check("no duplicate (ISIN, Date)", not prices.duplicated(["ISIN", "Date"]).any())
check("no null closes", not prices.Close.isna().any())
check("no non-positive closes", not (prices.Close <= 0).any(),
      f"{(prices.Close <= 0).sum()} rows")

per_date = prices.groupby("Date").ISIN.nunique()
phantom = per_date[per_date < MIN_COVERAGE * n_inst]
check("no phantom trading days", phantom.empty,
      f"{len(phantom)} dates below {MIN_COVERAGE:.0%} coverage")

print("\ncross-file consistency")
orphans = set(prices.ISIN) - set(master.ISIN)
check("every priced instrument is in the master", not orphans,
      f"{len(orphans)} orphans")

# An ISIN is revised, not retired, when a corporate action changes the series --
# INE419M01027 became INE419M01035 for TD Power Systems, and INE811A01020 became
# INE811A01038 for Kirloskar Pneumatic, between the 742-stock pilot universe and
# the 2,138-stock master. ISIN is the join key for the whole system, so a stale one
# does not error anywhere: the row simply stops matching, and the company silently
# loses its fundamental score in the app, the workbook and the pipeline alike. Three
# companies were in exactly that state until 2026-09-07.
#
# The tell is an ISIN absent from the master whose 9-character issuer prefix matches
# exactly one master ISIN. Two candidates means the issuer has several listed
# securities (DVR or partly-paid lines), which is not a revision and must not be
# rewritten -- so only unambiguous matches are flagged.
if os.path.exists(FUNDAMENTALS):
    fund = pd.read_csv(FUNDAMENTALS, dtype={"ISIN": str})
    by_prefix = {}
    for isin in master.ISIN:
        by_prefix.setdefault(isin[:9], []).append(isin)
    revised = {
        o: by_prefix[o[:9]][0]
        for o in set(fund.ISIN) - set(master.ISIN)
        if len(by_prefix.get(o[:9], [])) == 1
    }
    check("no stale (revised) ISINs in fundamentals", not revised,
          "; ".join(f"{a} -> {b}" for a, b in sorted(revised.items())))

# ---- non-equity asset classes (§3.2) -------------------------------------
# Each class has its OWN trading calendar, so these are checked per class and never
# pooled: crypto trades every day, indices span markets whose holidays differ, and
# pooling them would make every genuine gap look like a phantom date.
print("\nnon-equity asset classes")
for cls in ("commodities", "currencies", "indices", "crypto"):
    mpath = os.path.join(BASE, f"meridian-{cls}-master.csv")
    ppath = os.path.join(BASE, f"meridian-{cls}-prices.csv")
    if not (os.path.exists(mpath) and os.path.exists(ppath)):
        continue
    m = pd.read_csv(mpath, dtype=str)
    p = pd.read_csv(ppath)
    n = p.Symbol.nunique()

    check(f"{cls}: every master symbol has prices",
          not (set(m.Symbol) - set(p.Symbol)),
          f"missing {sorted(set(m.Symbol) - set(p.Symbol))}")
    check(f"{cls}: no duplicate (Symbol, Date)", not p.duplicated(["Symbol", "Date"]).any())
    check(f"{cls}: no non-positive closes", not (p.Close <= 0).any())
    check(f"{cls}: every instrument clears the §3.1 200-bar rule",
          p.groupby("Symbol").size().ge(200).all(),
          f"{(p.groupby('Symbol').size() < 200).sum()} below")

    # A bar's date is its exchange's LOCAL date. Reading Yahoo's timestamps as UTC put
    # 125 ASX200 bars on Sundays and shifted every Asian index by a day, which showed
    # up as a swarm of dates only one instrument reported on. A handful of such dates
    # is legitimate — Tokyo and Shanghai do trade when New York is shut — but dozens
    # means the timezone handling has regressed.
    per_date = p.groupby("Date").Symbol.nunique()
    thin = per_date[per_date < 0.25 * n]
    check(f"{cls}: no swarm of single-instrument dates (timezone regression)",
          len(thin) <= 20, f"{len(thin)} dates below 25% coverage")

    # DEAD INSTRUMENTS. An instrument whose last bar is years behind the rest of its
    # class is not "a bit sparse" — its ticker has been renamed, delisted, or was never
    # the asset the master claims. Every other check above passes happily on a series
    # that simply stopped: the bars it does have are unique, positive, well-covered and
    # over 200 in number.
    #
    # This found five of twenty-six crypto instruments on 2026-09-09. Two were the
    # WRONG ASSET ENTIRELY — `UNI-USD` is UNICORN Token (a dead sub-cent token), not
    # Uniswap, which is `UNI7083-USD`; `CC-USD` is CloudCoin, not Canton. Three were
    # renamed or delisted: MATIC became POL28321-USD, USDE moved to USDE29470-USD, and
    # TONCOIN-USD stopped in 2022. The screens showed all five as current prices.
    #
    # 30 days, not zero: classes have their own calendars and a genuine holiday gap is
    # normal. A year and a half is not.
    latest = p.Date.max()
    last_bar = p.groupby("Symbol").Date.max()
    stale = last_bar[last_bar < (pd.Timestamp(latest) - pd.Timedelta(days=30)).strftime("%Y-%m-%d")]
    check(f"{cls}: no instrument stalled more than 30 days behind its class",
          len(stale) == 0,
          "all current" if len(stale) == 0
          else "; ".join(f"{sym} last traded {d}" for sym, d in stale.items()))

    # FX genuinely has no volume; everything else should mostly have it. Empty is
    # written rather than zero, because zero is a real reading meaning "did not trade".
    has_vol = p.Volume.notna().mean()
    if cls == "currencies":
        check(f"{cls}: volume absent, as expected for FX", has_vol == 0)
    else:
        check(f"{cls}: volume present on most bars", has_vol > 0.5, f"{has_vol:.0%} of rows")

n200 = prices.groupby("ISIN").size().ge(200).sum()
print(f"\n  {n_inst} instruments priced, {n200} clearing the §3.1 200-bar rule")

if failures:
    print(f"\n{len(failures)} CHECK(S) FAILED: {', '.join(failures)}")
    sys.exit(1)
print("\nall integrity checks passed")
