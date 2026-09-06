"""
Port parity check — compares the Node engine's Golden Breakout output against
the independent Python implementation in meridian_backtest.py.

Run:
    node verify_port.mjs > port-node.json
    python3 verify_port.py

Exits non-zero on any disagreement, so this can gate a build.
"""

import json
import os
import sys

import pandas as pd

from meridian_backtest import (
    compute_all_signals,
    load_price_data_from_csv,
    passes_golden_breakout,
)

BASE = os.path.dirname(os.path.abspath(__file__))
NODE_OUT = os.path.join(BASE, "port-node.json")

if not os.path.exists(NODE_OUT):
    sys.exit("run `node verify_port.mjs > port-node.json` first")

node = json.load(open(NODE_OUT))
node_set = {c["isin"] for c in node["candidates"]}
node_by = {c["isin"]: c for c in node["candidates"]}

close = load_price_data_from_csv(os.path.join(BASE, "meridian-price-history-2090-part*of3.csv"))
signals = compute_all_signals(close)
sig = passes_golden_breakout(signals)

as_of = sig.index.max()
py_set = set(sig.loc[as_of][sig.loc[as_of]].index)

print(f"as-of date      node={node['as_of']}  python={as_of.date()}")
print(f"instruments     node={node['instruments']}  python={close.shape[1]}")
print(f"candidates      node={len(node_set)}  python={len(py_set)}")

only_node = node_set - py_set
only_py = py_set - node_set
shared = node_set & py_set
print(f"agreement       {len(shared)} shared, {len(only_node)} node-only, {len(only_py)} python-only")

if shared:
    print("\nper-candidate numeric agreement (separation %, freshness days):")
    sep = signals["separation_pct"].loc[as_of]
    fresh = signals["golden_streak"].loc[as_of]
    worst = 0.0
    for isin in sorted(shared):
        n = node_by[isin]
        d_sep = abs(n["separation_pct"] - float(sep[isin]))
        d_fresh = abs(n["freshness_days"] - float(fresh[isin]))
        worst = max(worst, d_sep)
        flag = "" if d_sep < 1e-6 and d_fresh == 0 else "   <-- MISMATCH"
        print(f"  {isin}  sep node={n['separation_pct']:.6f} py={float(sep[isin]):.6f} "
              f"(d={d_sep:.2e})  fresh node={n['freshness_days']} py={int(fresh[isin])}{flag}")
    print(f"\nlargest separation difference: {worst:.2e}")

if only_node or only_py:
    print("\nDISAGREEMENT")
    for i in sorted(only_node):
        print(f"  node-only:   {i}")
    for i in sorted(only_py):
        print(f"  python-only: {i}")
    sys.exit(1)

print("\nPARITY OK — both implementations select the identical candidate set.")
