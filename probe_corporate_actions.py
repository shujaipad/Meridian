#!/usr/bin/env python3
"""
Size the daily deep-re-pull load, and measure the cost of getting it wrong (§3.5).

§3.5's detect-and-isolate design rests on two empirical claims. Neither was
assumed; both were measured against the live Yahoo API, and this script is how.
Re-run it if the universe changes materially, or if the daily job's observed load
stops matching what §3.5 predicts.

  1. HOW OFTEN corporate actions fire — this sets the deep-re-pull volume, and
     therefore whether isolating them is worth the machinery at all.
  2. HOW BADLY history is restated when one is missed — this is the argument for
     the overlap detector, since the explicit-events feed alone cannot be trusted
     to be complete.

Sample-based by design: probing all 2,138 instruments to size a job is a heavier
pull than the job itself. A seeded random sample of ~70 is enough to separate
"~7 per day" from "~700 per day", which is the decision this informs.

Usage: python3 probe_corporate_actions.py [--sample 70] [--seed 7]
"""

import argparse, collections, csv, datetime as dt, json, random, statistics as st
import time, urllib.request

CHART = "https://query1.finance.yahoo.com/v8/finance/chart/"
UA = {"User-Agent": "Mozilla/5.0"}
TRADING_DAYS = 250


def fetch(ticker, rng="1y"):
    url = f"{CHART}{ticker}?range={rng}&interval=1d&events=div%2Csplits"
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)["chart"]["result"][0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", default="meridian-company-master-2138.csv")
    ap.add_argument("--sample", type=int, default=70)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()

    rows = list(csv.DictReader(open(a.master)))
    random.seed(a.seed)
    sample = random.sample(rows, min(a.sample, len(rows)))
    universe = len(rows)

    events = 0
    dividends = splits = 0
    by_month = collections.Counter()
    zero_event_stocks = 0
    drifts = []          # restatement applied to the oldest bar in the window
    ok = 0

    for r in sample:
        try:
            d = fetch(f"{r['Symbol']}.NS")
        except Exception:
            time.sleep(0.4)
            continue
        ok += 1

        n = 0
        for kind, recs in d.get("events", {}).items():
            for e in recs.values():
                by_month[dt.datetime.utcfromtimestamp(e["date"]).strftime("%b")] += 1
                n += 1
                if kind == "dividends":
                    dividends += 1
                else:
                    splits += 1
        events += n
        if n == 0:
            zero_event_stocks += 1

        # adjclose/close on the OLDEST bar is the cumulative restatement Yahoo has
        # applied over the window — i.e. exactly the error a year of un-reconciled
        # appending would have baked into stored history.
        q = d["indicators"]["quote"][0]["close"]
        ac = d["indicators"]["adjclose"][0]["adjclose"]
        pairs = [(x, y) for x, y in zip(q, ac) if x and y]
        if len(pairs) > 200:
            drifts.append((1 - pairs[0][1] / pairs[0][0]) * 100)

        time.sleep(0.25)   # be a good citizen; the real job paces the same way

    if not ok:
        print("no instruments fetched — check connectivity")
        return 1

    print(f"sampled {ok} of {universe} instruments, 1-year window\n")

    print("FREQUENCY — sets the deep-re-pull volume")
    print(f"  dividends {dividends} | splits/bonuses {splits} | total {events}")
    print(f"  events per stock per year: {events / ok:.2f}")
    print(f"  stocks with no event at all: {zero_event_stocks}/{ok} "
          f"({zero_event_stocks / ok * 100:.0f}%)")
    scaled = events / ok * universe
    print(f"  extrapolated to {universe}: {scaled:.0f} events/year")
    print(f"  -> average deep re-pulls per trading day: {scaled / TRADING_DAYS:.1f}")

    total_m = sum(by_month.values())
    if total_m:
        peak_month, peak_n = by_month.most_common(1)[0]
        print(f"  -> peak month is {peak_month} at {peak_n / total_m * 100:.0f}% of the "
              f"year; peak-day re-pulls roughly {scaled * (peak_n / total_m) / 21:.0f}")
        order = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        print("  seasonality: " + "  ".join(f"{m}:{by_month[m]}" for m in order if by_month[m]))

    if drifts:
        drifts.sort()
        p = lambda q: drifts[min(len(drifts) - 1, int(len(drifts) * q))]
        print(f"\nRESTATEMENT — the cost of missing one ({len(drifts)} instruments)")
        print(f"  applied to a 1-year-old bar: median {st.median(drifts):.2f}%  "
              f"p90 {p(.90):.2f}%  max {max(drifts):.2f}%")
        print(f"  above 1%: {sum(1 for x in drifts if x > 1)}/{len(drifts)}")
        print("  This is a step discontinuity at the join, not noise, and it compounds")
        print("  with every event missed. It is also directional: MA200 averages old,")
        print("  unrestated bars while price is current, so the instrument reads weaker")
        print("  than it is and quietly stops clearing gate 1.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
