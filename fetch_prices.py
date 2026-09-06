"""
Meridian — bulk historical price fetch (Yahoo Finance)
============================================================================
Pulls daily OHLCV for every instrument in the equity universe and writes the
schema meridian_backtest.py and the dashboard already expect:

    ISIN,Date,High,Low,Close,Volume

This is the "one-time initial backfill / quarterly full re-pull" job of §3.4.
It is deliberately NOT the daily incremental job (§7.3) — that one needs a
per-instrument watermark and a hard distinction between "no new data" and
"fetch failed", and is separate engineering.

Design points that matter, per §7.1/§7.3's review of the older Colab scripts:

  * Ticker routing is data-driven. NSE-listed rows fetch as `SYMBOL.NS`;
    the 309 BSE-only rows fall back to `<bsecode>.BO`. A fetcher that only
    tried NSE would silently lose 14% of the universe.
  * Failures are logged per instrument, never swallowed. The old scripts'
    `except: pass` is exactly what made them unusable unattended.
  * Rate limited, with backoff on 429. ~2,100 sequential calls will get
    throttled otherwise.
  * Resumable. Rows are appended per instrument and completed ISINs are
    tracked, so an interrupted run continues instead of restarting.
"""

import csv
import json
import os
import random
import sys
import time
from datetime import datetime, timezone

import requests

BASE = os.path.dirname(os.path.abspath(__file__))
UNIVERSE = os.path.join(BASE, "meridian-company-master-2138.csv")
OUT_CSV = os.path.join(BASE, "meridian-price-history-full.csv")
LOG_JSON = os.path.join(BASE, "fetch_prices_log.json")

RANGE = "5y"
INTERVAL = "1d"
DELAY = 0.35           # polite gap between calls
MAX_RETRIES = 4
TIMEOUT = 30
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; Meridian/1.0)"}


def tickers_for(row):
    """
    Candidate tickers in priority order. Four of them, not two, because Yahoo's
    Indian coverage is inconsistent in two separate ways, both found empirically:

      1. BSE symbols are sometimes numeric (500325.BO = Reliance) and sometimes
         alphabetic (NSDL.BO) — the numeric code 404s for the latter.
      2. The Trendlyne extract leaves NSE Code blank for stocks that are in fact
         NSE-listed (Kennametal, Kirloskar Ferrous), so `Stock Code` has to be
         tried as an NSE symbol even when the row looks BSE-only.

    Trying all four recovered ~90% of what a two-candidate chain failed on.
    """
    out = []
    if row.get("NSECode"):
        out.append(f"{row['NSECode']}.NS")
    if row.get("BSECode"):
        out.append(f"{row['BSECode']}.BO")
    sym = row.get("Symbol")
    if sym:
        for cand in (f"{sym}.NS", f"{sym}.BO"):
            if cand not in out:
                out.append(cand)
    return out


def fetch(ticker):
    """Returns (rows, note). rows is None on failure; note explains why."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
    params = {"range": RANGE, "interval": INTERVAL}
    for attempt in range(MAX_RETRIES):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=TIMEOUT)
        except Exception as e:
            time.sleep(2 ** attempt + random.random())
            if attempt == MAX_RETRIES - 1:
                return None, f"network: {type(e).__name__}"
            continue

        if r.status_code == 429:
            time.sleep(5 * (attempt + 1))
            continue
        if r.status_code == 404:
            return None, "404 no such symbol"
        if r.status_code != 200:
            if attempt == MAX_RETRIES - 1:
                return None, f"http {r.status_code}"
            time.sleep(2 ** attempt)
            continue

        try:
            body = r.json()
        except Exception:
            return None, "unparseable json"

        chart = body.get("chart") or {}
        if chart.get("error"):
            return None, f"api: {chart['error'].get('code')}"
        results = chart.get("result") or []
        if not results:
            return None, "empty result"

        res = results[0]
        stamps = res.get("timestamp") or []
        quote = ((res.get("indicators") or {}).get("quote") or [{}])[0]
        if not stamps:
            return None, "no timestamps"

        highs, lows, closes, vols = (quote.get(k) or [] for k in ("high", "low", "close", "volume"))
        # Corporate-action adjustment is not optional here (§3.5): a split or bonus
        # retroactively re-bases the whole series, and every signal in the model is
        # MA-based, so an unadjusted discontinuity corrupts the lot. Yahoo's `close` is
        # raw; `adjclose` carries the adjustment. High/Low are scaled by the same
        # per-bar ratio so OHLC stays internally consistent — equivalent to yfinance's
        # auto_adjust=True, which is what the existing history was built with.
        adjcloses = ((res.get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose") or []
        if not adjcloses:
            return None, "no adjclose (unadjusted data refused)"

        rows = []
        for i, ts in enumerate(stamps):
            close = closes[i] if i < len(closes) else None
            adj = adjcloses[i] if i < len(adjcloses) else None
            if close is None or adj is None:   # non-trading placeholder row
                continue
            ratio = (adj / close) if close else 1.0
            hi = highs[i] if i < len(highs) and highs[i] is not None else None
            lo = lows[i] if i < len(lows) and lows[i] is not None else None
            d = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
            rows.append([
                d,
                round(hi * ratio, 6) if hi is not None else "",
                round(lo * ratio, 6) if lo is not None else "",
                round(adj, 6),
                vols[i] if i < len(vols) and vols[i] is not None else "",
            ])
        if not rows:
            return None, "no usable bars"
        return rows, res.get("meta", {}).get("instrumentType", "")

    return None, "throttled out"


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None

    with open(UNIVERSE, newline="") as f:
        universe = list(csv.DictReader(f))
    if limit:
        universe = universe[:limit]

    # Resume: skip ISINs already written on a previous run.
    done = set()
    if os.path.exists(OUT_CSV):
        with open(OUT_CSV, newline="") as f:
            for rec in csv.reader(f):
                if rec and rec[0] != "ISIN":
                    done.add(rec[0])
        print(f"resuming — {len(done)} instruments already fetched", flush=True)

    log = {"ok": [], "failed": [], "started": datetime.now().isoformat(timespec="seconds")}
    new_file = not os.path.exists(OUT_CSV)
    t0 = time.time()

    with open(OUT_CSV, "a", newline="") as out:
        w = csv.writer(out)
        if new_file:
            w.writerow(["ISIN", "Date", "High", "Low", "Close", "Volume"])

        todo = [r for r in universe if r["ISIN"] not in done]
        for n, row in enumerate(todo, 1):
            isin = row["ISIN"]
            attempts = []
            rows = None
            for tk in tickers_for(row):
                rows, note = fetch(tk)
                attempts.append(f"{tk}:{note if rows is None else 'ok'}")
                if rows:
                    used = tk
                    break
                time.sleep(DELAY)

            if rows:
                for d, h, l, c, v in rows:
                    w.writerow([isin, d, h, l, c, v])
                log["ok"].append({"isin": isin, "ticker": used, "bars": len(rows)})
            else:
                log["failed"].append({"isin": isin, "name": row["Name"], "attempts": attempts})

            if n % 25 == 0 or n == len(todo):
                out.flush()
                rate = n / max(time.time() - t0, 1)
                eta = (len(todo) - n) / max(rate, 0.001) / 60
                print(f"  {n}/{len(todo)}  ok={len(log['ok'])} failed={len(log['failed'])} "
                      f"{rate:.2f}/s  eta {eta:.0f}m", flush=True)
                with open(LOG_JSON, "w") as lf:
                    json.dump(log, lf, indent=1)
            time.sleep(DELAY)

    log["finished"] = datetime.now().isoformat(timespec="seconds")
    with open(LOG_JSON, "w") as lf:
        json.dump(log, lf, indent=1)
    print(f"\nDONE  ok={len(log['ok'])}  failed={len(log['failed'])}  "
          f"elapsed {(time.time()-t0)/60:.1f}m", flush=True)


if __name__ == "__main__":
    main()
