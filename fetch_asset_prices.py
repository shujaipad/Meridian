#!/usr/bin/env python3
"""
Bulk historical price fetch for the four NON-EQUITY asset classes (§3.2).

Commodities, Currencies, Global Indices and Crypto — 103 instruments whose Yahoo
tickers are already defined in the `-master.csv` files. Writes one file per class:

    Symbol,Date,High,Low,Close,Volume

Sibling of fetch_prices.py, which does the same job for the 2,138-stock equity
universe. Kept separate rather than generalised because the two differ in the ways
that matter: equities route through a four-way NSE/BSE ticker fallback and share one
exchange calendar, while these carry explicit Yahoo tickers and four different
calendars.

A pilot against three instruments per class found four things that shape this script,
none of which are guessable from the master files:

  * CURRENCIES HAVE NO VOLUME. Yahoo returns nulls for FX. Volume is written empty
    rather than zero, because zero is a real reading that means "did not trade" and
    would make volBreakoutPct compute a nonsense figure instead of declining to.
  * CALENDARS DIFFER PER CLASS. Crypto trades every day (1,827 bars over 5 years);
    indices trade ~1,254. Each class is written to its own file for that reason —
    clean_price_calendar.py's phantom-day rule (drop dates under 5% coverage) is only
    meaningful WITHIN one calendar, and applied across classes it would delete every
    crypto weekend.
  * NULL BARS ARE COMMON. DX-Y.NYB returns 1,521 timestamps for 1,257 real closes.
    Those rows are dropped, not forward-filled: a fabricated bar is worse than a gap,
    because every moving average would silently treat it as a real observation.
  * LAST DATES DIFFER. Indices closed 2026-09-08 while crypto has 2026-09-09. Each
    class therefore has its own as-of date, and comparing them is meaningless.
  * A BAR'S DATE IS ITS EXCHANGE'S LOCAL DATE, NOT UTC. Yahoo timestamps each bar at
    the market's opening instant. Reading that as UTC put 125 ASX200 bars on Sundays
    and shifted every Asian index by a day — Sydney at UTC+11 opens 10:00 local, which
    is 23:00 UTC the day before. A fixed `gmtoffset` is not enough either: Yahoo
    reports only the CURRENT offset, while the Sunday bars clustered in October-April,
    which is precisely Australian daylight saving. So each timestamp is converted
    through the exchange's named timezone, which knows when DST applied.

Adjusted prices, per §3.5: `close` from Yahoo is unadjusted, and using it corrupts
every MA-based signal. This reads `adjclose` and scales High/Low by the same per-bar
ratio — the same correction fetch_prices.py needed after its first run came out 2%
wrong.

Usage: python3 fetch_asset_prices.py [--classes commodities,currencies,indices,crypto]
"""

import argparse
import csv
import datetime as dt
import json
import os
import random
import sys
import time
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

BASE = os.path.dirname(os.path.abspath(__file__))
CHART = "https://query1.finance.yahoo.com/v8/finance/chart/"
UA = {"User-Agent": "Mozilla/5.0"}
CLASSES = ["commodities", "currencies", "indices", "crypto"]
RANGE = "5y"
MAX_RETRIES = 4
PAUSE = 0.35


def fetch(ticker):
    """Return (rows, note). Raises on a hard failure so the caller can log it."""
    url = f"{CHART}{urllib.parse.quote(ticker)}?range={RANGE}&interval=1d"
    last = None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                payload = json.load(r)
            break
        except Exception as e:  # 429s and transient DNS/TLS both land here
            last = e
            if attempt == MAX_RETRIES - 1:
                raise
            time.sleep((2 ** attempt) + random.random())
    else:
        raise last

    result = payload["chart"]["result"][0]
    meta = result.get("meta") or {}
    # See the header: the bar's date is the exchange's local date. Falling back to UTC
    # is correct only for exchanges whose session never crosses the UTC date line.
    try:
        tz = ZoneInfo(meta.get("exchangeTimezoneName") or "UTC")
    except Exception:
        tz = ZoneInfo("UTC")
    ts = result.get("timestamp") or []
    q = result["indicators"]["quote"][0]
    adj = (result["indicators"].get("adjclose") or [{}])[0].get("adjclose")

    rows, dropped = [], 0
    for i, t in enumerate(ts):
        close = q["close"][i] if q.get("close") else None
        if close is None or close <= 0:
            dropped += 1
            continue
        a = adj[i] if adj and adj[i] is not None else close
        # High and Low are unadjusted alongside close; scale them by the same
        # per-bar ratio so the whole bar stays internally consistent.
        ratio = (a / close) if close else 1.0
        high = q["high"][i] if q.get("high") else None
        low = q["low"][i] if q.get("low") else None
        vol = q["volume"][i] if q.get("volume") else None
        rows.append({
            "Date": dt.datetime.fromtimestamp(t, tz).strftime("%Y-%m-%d"),
            "High": round(high * ratio, 6) if high is not None else "",
            "Low": round(low * ratio, 6) if low is not None else "",
            "Close": round(a, 6),
            # Empty, not 0 — see the header. FX genuinely has no volume.
            "Volume": int(vol) if vol else "",
        })
    return rows, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--classes", default=",".join(CLASSES))
    a = ap.parse_args()

    log, failures = {}, 0
    for cls in [c.strip() for c in a.classes.split(",") if c.strip()]:
        master_path = os.path.join(BASE, f"meridian-{cls}-master.csv")
        if not os.path.exists(master_path):
            print(f"{cls}: no master file, skipping")
            continue
        with open(master_path) as fh:
            master = list(csv.DictReader(fh))

        print(f"\n{cls}: {len(master)} instruments")
        out_rows, seen_dates = [], set()
        for m in master:
            sym, ticker = m["Symbol"], m["YahooTicker"]
            try:
                rows, dropped = fetch(ticker)
            except Exception as e:
                print(f"  FAIL {sym:12} {ticker:14} {str(e)[:60]}")
                log[f"{cls}:{sym}"] = {"ticker": ticker, "error": str(e)[:200]}
                failures += 1
                time.sleep(PAUSE)
                continue
            for r in rows:
                r["Symbol"] = sym
                seen_dates.add(r["Date"])
            out_rows.extend(rows)
            novol = sum(1 for r in rows if r["Volume"] == "")
            print(f"  ok   {sym:12} {ticker:14} {len(rows):5} bars"
                  f"{f'  ({dropped} null dropped)' if dropped else ''}"
                  f"{'  [no volume]' if novol == len(rows) and rows else ''}")
            log[f"{cls}:{sym}"] = {"ticker": ticker, "bars": len(rows), "dropped": dropped}
            time.sleep(PAUSE)

        out_path = os.path.join(BASE, f"meridian-{cls}-prices.csv")
        # lineterminator="\n": Python's csv module writes CRLF by default, and every
        # other data file in this repository is LF. The mismatch is not cosmetic — a
        # naive split("\n") leaves "\r" on the last field, so the header's final key
        # becomes "Volume\r" and every volume reads as undefined. That silently zeroed
        # volBreakoutPct for all four asset classes until it was traced back to here.
        with open(out_path, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=["Symbol", "Date", "High", "Low", "Close", "Volume"],
                               lineterminator="\n")
            w.writeheader()
            w.writerows(out_rows)
        dates = sorted(seen_dates)
        print(f"  -> {out_path}: {len(out_rows):,} rows, "
              f"{len(set(r['Symbol'] for r in out_rows))} instruments, "
              f"{dates[0] if dates else '?'}..{dates[-1] if dates else '?'} "
              f"({len(dates)} distinct dates)")

    with open(os.path.join(BASE, "fetch_asset_prices_log.json"), "w") as fh:
        json.dump(log, fh, indent=2)
    print(f"\n{failures} failure(s); per-instrument log in fetch_asset_prices_log.json")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
