"""
Strip phantom trading days from the price history.

Yahoo emits bars for a handful of BSE-only tickers on days the Indian market
is closed — Diwali, Republic Day, Holi and so on. Only ~4 of 2,089 instruments
report on those dates, against a median of ~1,700 on a real trading day.

Why this is not cosmetic: pandas `rolling(200)` counts ROWS, not valid
observations. One near-empty holiday row inside a 200-row window makes that
window's mean NaN for every instrument that (correctly) did not trade that day.
Left in, MA200 is NaN almost everywhere and every MA-based gate silently stops
firing — the backtest collapsed from 459 episodes to 21 before this was found.

The same failure would hit the production pipeline, since §6.2's compute job
runs the identical moving averages over whatever `prices_daily` holds.

Run after any bulk fetch. Idempotent.
"""

import glob
import os
import sys

import pandas as pd

# A real Indian trading day sees a large majority of the universe report.
# Holidays here show ~0.2%. Anything between is safe; 5% is far from both edges.
MIN_COVERAGE = 0.05

BASE = os.path.dirname(os.path.abspath(__file__))
PATTERN = os.path.join(BASE, "meridian-price-history-2090-part*of3.csv")


def main():
    paths = sorted(glob.glob(PATTERN))
    if not paths:
        sys.exit(f"no price-history parts found at {PATTERN}")

    parts = {p: pd.read_csv(p) for p in paths}
    allrows = pd.concat(parts.values(), ignore_index=True)
    total_instruments = allrows.ISIN.nunique()

    per_date = allrows.groupby("Date").ISIN.nunique()
    phantom = set(per_date[per_date < MIN_COVERAGE * total_instruments].index)
    if not phantom:
        print("no phantom dates found — nothing to do")
        return

    print(f"{len(phantom)} phantom dates (<{MIN_COVERAGE:.0%} of {total_instruments} instruments):")
    for d in sorted(phantom)[:10]:
        print(f"    {d}  {per_date[d]} instruments")
    if len(phantom) > 10:
        print(f"    ... and {len(phantom) - 10} more")

    dropped = 0
    for p, df in parts.items():
        keep = df[~df.Date.isin(phantom)]
        dropped += len(df) - len(keep)
        keep.to_csv(p, index=False)
    print(f"\ndropped {dropped} rows across {len(parts)} parts")


if __name__ == "__main__":
    main()
