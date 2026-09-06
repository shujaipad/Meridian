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

n200 = prices.groupby("ISIN").size().ge(200).sum()
print(f"\n  {n_inst} instruments priced, {n200} clearing the §3.1 200-bar rule")

if failures:
    print(f"\n{len(failures)} CHECK(S) FAILED: {', '.join(failures)}")
    sys.exit(1)
print("\nall integrity checks passed")
