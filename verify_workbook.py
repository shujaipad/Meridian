#!/usr/bin/env python3
"""
Verify meridian.xlsx: every formula evaluates without error, AND the ones that
matter return the value they are supposed to.

The xlsx skill's recalc.py cannot run in this container — LibreOffice starts but
cannot load a document of any type (a two-line CSV fails the same way a workbook
does), so the macro dispatch it relies on hangs indefinitely. This script covers
the same ground by a different route: `formulas` evaluates the workbook in pure
Python, and the expectations below are computed independently from
workbook-data.json rather than read back out of the sheet.

That second half is the point. A clean evaluation only proves the formulas parse
and run; an off-by-one range evaluates perfectly and returns the wrong number.
Every assertion here is derived from the JSON, so a mis-pointed range fails.

Usage: python3 verify_workbook.py [--book meridian.xlsx] [--data workbook-data.json]
"""

import argparse, json, sys

ERRORS = ("#VALUE!", "#DIV/0!", "#REF!", "#NAME?", "#NULL!", "#NUM!", "#N/A")


def scalar(v):
    """formulas returns Ranges wrapping numpy arrays; peel down to one Python value."""
    if hasattr(v, "value"):
        v = v.value
    for _ in range(6):
        if hasattr(v, "ravel"):          # numpy array
            flat = v.ravel()
            if flat.size == 0:
                return None
            v = flat[0]
        elif isinstance(v, (list, tuple)):
            if not len(v):
                return None
            v = v[0]
        else:
            break
    if hasattr(v, "item"):
        try:
            v = v.item()
        except (ValueError, AttributeError):
            pass
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", default="meridian.xlsx")
    ap.add_argument("--data", default="workbook-data.json")
    a = ap.parse_args()

    import formulas

    d = json.load(open(a.data))
    stocks, breakout = d["stocks"], d["breakout"]
    sectoral, breadth, universe = d["sectoral"], d["breadth"], d["universe"]
    gates = d["meta"]["gates"]

    print(f"evaluating {a.book} ...")
    xl = formulas.ExcelModel().loads(a.book).finish()
    sol = xl.calculate()

    # Normalise "'[meridian.xlsx]SHEET NAME'!C7" -> ("SHEET NAME", "C7")
    cells = {}
    for key, val in sol.items():
        if "]" not in key or "!" not in key:
            continue
        sheet, _, ref = key.partition("]")[2].partition("!")
        cells[(sheet.rstrip("'").upper(), ref)] = scalar(val)

    def get(sheet, ref):
        return cells.get((sheet.upper(), ref))

    # ---- 1. no formula evaluated to an Excel error ----
    bad = [(k, v) for k, v in cells.items() if isinstance(v, str) and v.strip() in ERRORS]
    print(f"  cells evaluated: {len(cells)}")
    if bad:
        print(f"FAIL: {len(bad)} error cells, first 10:")
        for (sh, ref), v in bad[:10]:
            print(f"   {sh}!{ref} = {v}")
        return 1
    print("  formula errors: none")

    # ---- 2. expectations computed from the JSON, not from the sheet ----
    NS = len(stocks)
    fails = []

    def check(label, sheet, ref, expected, tol=1e-6):
        got = get(sheet, ref)
        if isinstance(expected, str):
            ok = str(got).strip() == expected
        elif expected is None:
            ok = got in (None, "")
        else:
            ok = got is not None and not isinstance(got, str) and abs(float(got) - expected) <= tol
        print(f"  {'ok  ' if ok else 'FAIL'} {label}: {got!r}" + ("" if ok else f"  expected {expected!r}"))
        if not ok:
            fails.append(label)

    # Dashboard coverage block (rows 6-9)
    check("universe count", "Dashboard", "C6", sum(1 for s in stocks if s["Symbol"]))
    check("with price history", "Dashboard", "C7", sum(1 for s in stocks if s["CMP"] is not None))
    check("with 200 DMA", "Dashboard", "C8", sum(1 for s in stocks if s["MA200"] is not None))
    check("with fund score", "Dashboard", "C9", sum(1 for s in stocks if s["FundScore"] is not None))

    # Gate funnel (rows 12-16) — recompute each stage from the JSON
    g1 = [s for s in stocks if s["GoldenCrossState"] and s["PriceAbove50DMA"]]
    g2 = [s for s in g1 if s["MA200Rising"]]
    g3 = [s for s in g2 if s["SeparationPct"] is not None
          and s["SeparationPct"] >= gates["minSeparationPct"]]
    g4 = [s for s in g3 if s["GoldenCrossStreak"] is not None
          and s["GoldenCrossStreak"] <= gates["freshnessMaxDays"]]
    g5 = [s for s in g4 if s["PriceAbove8DMA"]]
    check("gate 1", "Dashboard", "C12", len(g1))
    check("gate 2", "Dashboard", "C13", len(g2))
    check("gate 3", "Dashboard", "C14", len(g3))
    check("gate 4", "Dashboard", "C15", len(g4))
    check("gate 5", "Dashboard", "C16", len(g5))
    check("screener row count", "Dashboard", "C17", len(breakout))
    check("self-check", "Dashboard", "C18", "OK")
    if len(g5) != len(breakout):
        fails.append("funnel != screener")
        print(f"  FAIL funnel {len(g5)} != screener {len(breakout)} — the emitted gate columns "
              f"do not reproduce runGoldenBreakoutScreener")

    # Tier distribution (rows 21-26) and exemption
    for i, tier in enumerate(["High", "Good", "Average", "Weak", "Poor"]):
        check(f"tier {tier}", "Dashboard", f"C{21 + i}", sum(1 for s in stocks if s["FundTier"] == tier))
    check("unscored", "Dashboard", "C26", sum(1 for s in stocks if s["FundTier"] is None))
    check("fin exempt", "Dashboard", "C27", sum(1 for s in stocks if s["FinExempt"]))

    # RS bands (rows 30-32) + median (33)
    for i, band in enumerate(["green", "amber", "red"]):
        check(f"RS {band}", "Dashboard", f"C{30 + i}", sum(1 for s in stocks if s["RSBand"] == band))
    rat = sorted(s["RSRating"] for s in stocks if s["RSRating"] is not None)
    med = (rat[len(rat) // 2] if len(rat) % 2 else (rat[len(rat) // 2 - 1] + rat[len(rat) // 2]) / 2)
    check("median RS", "Dashboard", "C33", med)

    # Breadth latest (rows 36-40) — INDEX into the last populated row
    last = breadth[-1]
    check("breadth date", "Dashboard", "C36", last["Date"])
    check("breadth pct", "Dashboard", "C37", last["PctAbove200DMA"] / 100, tol=1e-9)
    check("breadth 200d MA", "Dashboard", "C38", last["MA200"] / 100, tol=1e-9)
    check("breadth new highs", "Dashboard", "C39", last["NewHighs"])
    check("breadth new lows", "Dashboard", "C40", last["NewLows"])

    # Industry block (rows 43-45)
    check("industries indexed", "Dashboard", "C43", len(sectoral))
    check("industries golden", "Dashboard", "C44", sum(1 for s in sectoral if s["GoldenCrossState"]))
    check("sectoral breakout rows", "Dashboard", "C45", len(d["sectoralBreakout"]))

    # Stocks!R — % from 52w high, spot-checked at the top, middle and bottom of the sheet
    for row in (2, NS // 2 + 1, NS + 1):
        s = stocks[row - 2]
        exp = None if (s["CMP"] is None or s["High52"] is None) else s["CMP"] / s["High52"] - 1
        check(f"Stocks!R{row} % from 52w high ({s['Symbol']})", "Stocks", f"R{row}", exp, tol=1e-9)

    # Sectoral!C — share of priced universe
    tot = sum(x["Constituents"] for x in sectoral)
    check("Sectoral!C2 share", "Sectoral", "C2", sectoral[0]["Constituents"] / tot, tol=1e-9)

    # Universe!I — the cross-sheet INDEX/MATCH lookup. Check one priced and one unpriced.
    cmp_by_isin = {s["ISIN"]: s["CMP"] for s in stocks}
    priced_row = next(i for i, u in enumerate(universe) if cmp_by_isin.get(u["ISIN"]) is not None)
    check(f"Universe!I{priced_row + 2} priced lookup", "Universe", f"I{priced_row + 2}", "Yes")
    unpriced = [i for i, u in enumerate(universe) if cmp_by_isin.get(u["ISIN"]) is None]
    if unpriced:
        check(f"Universe!I{unpriced[0] + 2} unpriced lookup", "Universe", f"I{unpriced[0] + 2}", "No")
        check(f"Universe!I{unpriced[-1] + 2} unpriced lookup", "Universe", f"I{unpriced[-1] + 2}", "No")

    # Golden Breakout / Sectoral Breakout rank columns
    check("Golden Breakout rank 1", "Golden Breakout", "A2", 1)
    check(f"Golden Breakout rank {len(breakout)}", "Golden Breakout", f"A{len(breakout) + 1}", len(breakout))

    # Market Breadth net-highs
    check("Market Breadth net highs (last)", "Market Breadth", f"I{len(breadth) + 1}",
          last["NewHighs"] - last["NewLows"])

    print()
    if fails:
        print(f"FAILED: {len(fails)} check(s): {', '.join(fails)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
