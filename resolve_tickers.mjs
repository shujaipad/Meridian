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

// What the remote actually said, tallied. Without it a refusal to overwrite the map
// cannot tell you WHY the run resolved fewer instruments -- throttling, timeouts and a
// genuine wave of delistings all arrive as "unresolved".
const httpTally = {};
const tally = (k) => { httpTally[k] = (httpTally[k] || 0) + 1; };
const tallyLine = () => Object.entries(httpTally).sort().map(([k, v]) => `${k}:${v}`).join(" ") || "none";

async function bars(ticker) {
  try {
    const r = await fetch(`${CHART}${encodeURIComponent(ticker)}?range=5d&interval=1d`,
                          { headers: UA, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    tally(r.status);
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const closes = (res?.indicators?.quote?.[0]?.close || []).filter((c) => c != null);
    return closes.length ? { ok: true, n: closes.length } : { ok: false, status: "no bars" };
  } catch (e) {
    const why = e?.name === "TimeoutError" ? "timeout" : String(e.message).slice(0, 24);
    tally(why);
    return { ok: false, status: why };
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

// NEVER WRITE A WORSE MAP THAN THE ONE ALREADY COMMITTED.
//
// This overwrites the file that decides what the nightly job can fetch at all, and it
// gets its answers from a remote that can refuse them. A run throttled halfway
// resolves the rest as "no Yahoo listing", writes a map missing hundreds of
// instruments, and the nightly job then skips them by name and reports success --
// the failure mode being silent, permanent, and indistinguishable from those
// instruments having been delisted.
//
// So the new map has to be at least as complete as the old one, less a small margin
// for genuine delistings between runs. Anything worse is treated as evidence about
// the RUN rather than about the universe, and the existing file is left alone.
const MAX_SHRINKAGE = 0.02;
let previous = 0;
try { previous = readCSV("./meridian-yahoo-tickers.csv").length; } catch { previous = 0; }
if (previous && resolved.length < previous * (1 - MAX_SHRINKAGE)) {
  console.error(`\nRefusing to write: resolved ${resolved.length}, but the committed map has ${previous}.`);
  console.error(`That is a ${(((previous - resolved.length) / previous) * 100).toFixed(1)}% drop, past the `
              + `${(MAX_SHRINKAGE * 100).toFixed(0)}% allowed for genuine delistings.`);
  console.error("A throttled run looks exactly like this. The existing map is unchanged;");
  console.error("re-run when the remote is healthy, and compare before trusting the result.");
  console.error(`\nhttp status counts: ${tallyLine()}`);
  process.exit(1);
}

const out = ["ISIN,Symbol,YahooTicker",
             ...resolved.map((r) => `${r.ISIN},${r.Symbol},${r.YahooTicker}`)].join("\n") + "\n";
writeFileSync("./meridian-yahoo-tickers.csv", out);
console.log(`\nwrote meridian-yahoo-tickers.csv: ${resolved.length.toLocaleString()} resolved`
          + `${previous ? ` (was ${previous.toLocaleString()})` : ""}`);
console.log(`http status counts: ${tallyLine()}`);
if (failed.length) {
  console.log(`${failed.length} unresolved (no Yahoo listing found):`);
  failed.slice(0, 20).forEach((f) => console.log(`  ${f.Symbol} (${f.ISIN}) tried ${f.tried}`));
}
