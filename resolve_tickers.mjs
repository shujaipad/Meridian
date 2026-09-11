/**
 * Resolve every equity ISIN to the Yahoo ticker that actually returns data, once,
 * and write the answer to meridian-yahoo-tickers.csv.
 *
 * The daily fetch was calling Yahoo with ISINs -- `chart(u.identifier, ...)`, where
 * `identifier` is a Yahoo ticker only for the 100 non-equity instruments and an ISIN
 * for the 2,138 equities. Yahoo has never heard of an ISIN, so every equity returned
 * 404, was retried three times with backoff, and the job spent ~7.7 seconds per
 * instrument achieving nothing: about 4.6 hours for the universe, against a 60- then
 * 80-minute budget. It could never have finished, and had not, since the day it was
 * written.
 *
 * Resolving nightly is the wrong fix -- Yahoo's Indian coverage needs up to four
 * candidates per instrument (fetch_prices.py's `tickers_for`), and paying that every
 * night to rediscover a constant is waste. So it is resolved once, here, and the map
 * is committed. The nightly job then makes exactly one request per instrument.
 *
 * Usage:  node resolve_tickers.mjs [--limit N]
 */
import { writeFileSync } from "node:fs";
import { readCSV, sleep } from "./meridian-io.js";

const CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";
const UA = { "User-Agent": "Mozilla/5.0" };
const PAUSE_MS = 250;
const REQUEST_TIMEOUT_MS = 20_000;

const li = process.argv.indexOf("--limit");
const LIMIT = li >= 0 ? Number(process.argv[li + 1]) : Infinity;

// Four candidates, not two, and the reasons are empirical rather than obvious --
// carried over verbatim from fetch_prices.py, which established them:
//   * BSE symbols are sometimes numeric (500325.BO = Reliance) and sometimes
//     alphabetic (NSDL.BO); the numeric code 404s for the latter.
//   * The source extract leaves NSE Code blank for stocks that ARE NSE-listed, so
//     Symbol has to be tried as an NSE ticker even when the row looks BSE-only.
function candidates(row) {
  const out = [];
  const push = (t) => { if (t && !out.includes(t)) out.push(t); };
  if (row.NSECode?.trim()) push(`${row.NSECode.trim()}.NS`);
  if (row.BSECode?.trim()) push(`${row.BSECode.trim()}.BO`);
  if (row.Symbol?.trim()) { push(`${row.Symbol.trim()}.NS`); push(`${row.Symbol.trim()}.BO`); }
  return out;
}

async function bars(ticker) {
  try {
    const r = await fetch(`${CHART}${encodeURIComponent(ticker)}?range=5d&interval=1d`,
                          { headers: UA, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const closes = (res?.indicators?.quote?.[0]?.close || []).filter((c) => c != null);
    return closes.length ? { ok: true, n: closes.length } : { ok: false, status: "no bars" };
  } catch (e) {
    return { ok: false, status: e?.name === "TimeoutError" ? "timeout" : String(e.message).slice(0, 30) };
  }
}

const master = readCSV("./meridian-company-master-2138.csv").slice(0, LIMIT);
console.log(`resolving ${master.length.toLocaleString()} equities`);

const resolved = [], failed = [];
const t0 = Date.now();
for (const [i, row] of master.entries()) {
  let hit = null;
  for (const t of candidates(row)) {
    const r = await bars(t);
    await sleep(PAUSE_MS);
    if (r.ok) { hit = t; break; }
  }
  if (hit) resolved.push({ ISIN: row.ISIN, Symbol: row.Symbol, YahooTicker: hit });
  else failed.push({ ISIN: row.ISIN, Symbol: row.Symbol, tried: candidates(row).join(" ") });

  if ((i + 1) % 100 === 0 || i + 1 === master.length) {
    const mins = (Date.now() - t0) / 60000;
    const eta = mins / (i + 1) * (master.length - i - 1);
    console.log(`  ${i + 1}/${master.length} — ${resolved.length} resolved, ${failed.length} unresolved`
              + ` — ${mins.toFixed(1)} min, ~${eta.toFixed(0)} min left`);
  }
}

const out = ["ISIN,Symbol,YahooTicker",
             ...resolved.map((r) => `${r.ISIN},${r.Symbol},${r.YahooTicker}`)].join("\n") + "\n";
writeFileSync("./meridian-yahoo-tickers.csv", out);
console.log(`\nwrote meridian-yahoo-tickers.csv: ${resolved.length.toLocaleString()} resolved`);
if (failed.length) {
  console.log(`${failed.length} unresolved (no Yahoo listing found):`);
  failed.slice(0, 20).forEach((f) => console.log(`  ${f.Symbol} (${f.ISIN}) tried ${f.tried}`));
}
