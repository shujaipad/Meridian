/**
 * The daily incremental price fetch (§3.5, §7.3). All five asset classes.
 *
 *   export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
 *   node --max-old-space-size=4096 daily_fetch.mjs [--dry-run] [--limit N]
 *
 * Implements the locked detect-and-isolate design: a narrow sweep over every
 * instrument, and a deep re-pull only for the few whose history actually moved.
 *
 *   PASS 1  range=1mo for all ~2,240 instruments  (~2,240 requests)
 *   PASS 2  range=5y for the flagged ones only    (~7/day, 20-40 at peak)
 *
 * Why a month rather than the single new bar: Yahoo throttles on REQUEST COUNT, not
 * payload, so the wider window is free in the only currency that matters — and it
 * buys self-healing after a failed night, safety across holidays, and the ~21 bars
 * of overlap the second detector needs.
 *
 * TWO DETECTORS, because the events feed alone is not safe. A missed restatement is
 * silent and permanent: the corrupted history is perfectly well-formed and nothing
 * downstream complains.
 *
 *   1. EXPLICIT EVENTS — ?events=div,splits returns dated dividend and split records.
 *      Tells us WHY history moved. Only events dated after our newest stored bar
 *      count: the range is a month, an ordinary month holds ~335 ex-dividend dates
 *      across this universe, and an adjustment made before our newest bar was
 *      already in the fetch that produced it. Counting all of them made this a
 *      calendar rather than a detector.
 *   2. OVERLAP COMPARISON — stored adjusted close vs freshly fetched, on the ~21
 *      dates we already hold. Tells us WHETHER it moved, whatever the cause: a late
 *      or incomplete event record, an event during an outage, or Yahoo silently
 *      correcting a bad bar. Measured cost of missing one: the restatement applied
 *      to a one-year-old bar runs median 0.29%, p90 2.06%, max 3.68% — a step
 *      discontinuity that compounds, and directional, since MA200 averages old
 *      unrestated bars while price is current.
 *
 * Both live in meridian-detect.js, where they can be tested without a network. What
 * they cost when they are wrong is not theoretical: see §11c.
 *
 * A FAILURE MUST NEVER ADVANCE THE WATERMARK. "No new data" (holiday, halted scrip)
 * and "fetch failed" are different outcomes and do not share a code path. Conflating
 * them freezes an instrument's history while every dashboard stays green — which is
 * what made the older Colab scripts unusable unattended (§7.1).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { arrearsInstrumentDays, deepRepullCap, exchangeDateFormatter, restatementOf,
         SETTLEMENT_DAYS, unabsorbedEventDate, unsettledFrom } from "./meridian-detect.js";
import { DEFAULT_RETENTION_DAYS, readAll, readCSV, rPrice, sleep, withRetry } from "./meridian-io.js";

const BASE = dirname(fileURLToPath(import.meta.url));
const CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";
const UA = { "User-Agent": "Mozilla/5.0" };
const BATCH = 500;
// 250ms between requests, plus ~110ms median response: 2,240 instruments measured
// at 13.9 minutes end to end, 160/160 returning 200. The older "≈ 9 minutes" here
// counted only the sleeping and not the requests.
const PAUSE_MS = 250;
const REQUEST_TIMEOUT_MS = 20_000;
// Wall-clock budget for the sweep. Reaching it is a failure, but a reported one:
// the job stops, says how far it got and what the remote was returning, and exits
// non-zero with every watermark unmoved so tomorrow's run retries the remainder.
// Being killed by the runner's own timeout instead leaves no summary at all.
const SWEEP_BUDGET_MS = 75 * 60_000;
const SWEEP_RANGE = "1mo";
const DEEP_RANGE = "5y";
// Shared with prune_prices.mjs. A deep re-pull that wrote beyond it would only be
// writing rows the same night's prune then deletes.
const RETENTION_DAYS = DEFAULT_RETENTION_DAYS;

const DRY = process.argv.includes("--dry-run");
const LIMIT = process.argv.includes("--limit")
  ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : null;

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const { createClient } = await import("@supabase/supabase-js");
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });


// ---------------------------------------------------------------- fetch
// Tally of what the remote actually returned, printed with every heartbeat. Without
// it a run that is being throttled and a run that is merely slow produce the same
// output -- which is to say, none.
const httpTally = {};
const tally = (k) => { httpTally[k] = (httpTally[k] || 0) + 1; };
const tallyLine = () => Object.entries(httpTally).sort().map(([k, v]) => `${k}:${v}`).join(" ") || "none yet";

async function chart(ticker, range, withEvents) {
  const url = `${CHART}${encodeURIComponent(ticker)}?range=${range}&interval=1d`
            + (withEvents ? "&events=div%2Csplits" : "");
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // Node's fetch has NO default timeout. A connection the far end accepts and
      // then never answers blocks this await forever, and because the loop below is
      // sequential, one such socket stalls the entire run -- silently, since there
      // is nothing to log while waiting. The first scheduled run stopped producing
      // output after 83 seconds and was killed by the job timeout 59 minutes later
      // with no error of its own, which is exactly that shape. 20s is generous
      // against a median response of ~100ms.
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      tally(res.status);
      if (res.status === 429) throw new Error("429 rate limited");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error("no result in payload");
      return result;
    } catch (e) {
      lastErr = e;
      if (e?.name === "TimeoutError" || e?.name === "AbortError") tally("timeout");
      else if (!/^(429|HTTP )/.test(String(e?.message))) tally(String(e?.message).slice(0, 24));
      if (attempt < 3) {
        const wait = 2 ** attempt * 1000 + Math.random() * 500;
        // Logged, not swallowed. Silent retries are why an hour of backoff looked
        // identical to an hour of nothing happening.
        console.log(`    retry ${ticker} (${String(e?.message).slice(0, 60)}) in ${(wait / 1000).toFixed(1)}s`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

// A bar's date is its exchange's LOCAL date, not UTC. Reading Yahoo's timestamps as
// UTC put 125 ASX200 bars on Sundays and shifted every Asian index by a day (§3.2a).
function barsOf(result) {
  const fmt = exchangeDateFormatter(result);
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (close == null || close <= 0) continue;          // a gap, never a fabricated bar
    const a = adj?.[i] ?? close;
    const ratio = close ? a / close : 1;
    out.push({
      date: fmt.format(new Date(ts[i] * 1000)),
      high: q.high?.[i] != null ? rPrice(q.high[i] * ratio) : null,
      low: q.low?.[i] != null ? rPrice(q.low[i] * ratio) : null,
      close: rPrice(a),
      volume: q.volume?.[i] ? Math.round(q.volume[i]) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- db


async function upsertPrices(rows, label) {
  if (DRY || !rows.length) return;
  for (let i = 0; i < rows.length; i += BATCH) {
    await withRetry(() => db.from("prices_daily")
      .upsert(rows.slice(i, i + BATCH), { onConflict: "universe_id,trade_date" }),
      `upsert ${label}`);
  }
}

// ---------------------------------------------------------------- main
const t0 = Date.now();
console.log(`daily fetch ${DRY ? "(DRY RUN — nothing is written)" : ""}`);

const universe = await readAll(db, "universe", "id,asset_class,identifier,symbol",
                               { orderBy: ["id"], filter: (q) => q.eq("status", "active") });

// WHAT TO ASK YAHOO FOR. `identifier` is a Yahoo ticker only for the 100 non-equity
// instruments; for the 2,138 equities it is an ISIN, and Yahoo has never heard of an
// ISIN. Calling chart(u.identifier) therefore 404'd on every single equity, retried
// three times with backoff, and burned ~7.7 seconds per instrument achieving nothing
// -- about 4.6 hours for the universe, against a 60- then 80-minute budget. The job
// could not have finished, and had not, since the day it was written.
//
// The fix is a lookup, not a guess. meridian-yahoo-tickers.csv maps each ISIN to the
// ticker that actually returns data, resolved once by resolve_tickers.mjs against
// Yahoo itself. Resolving nightly would mean paying up to four requests per
// instrument to rediscover a constant.
const TICKER_MAP = join(BASE, "meridian-yahoo-tickers.csv");
if (!existsSync(TICKER_MAP)) {
  // Checked rather than left to throw: a bare ENOENT from deep inside readCSV is a
  // worse start to a debugging session than a sentence saying which file and how to
  // make it.
  console.error(`missing ${TICKER_MAP}`);
  console.error("Equities are keyed by ISIN, which Yahoo does not accept. Build the map:");
  console.error("  node resolve_tickers.mjs");
  process.exit(1);
}
const tickerByIsin = Object.fromEntries(
  readCSV(TICKER_MAP).map((r) => [r.ISIN, r.YahooTicker]));

function yahooTickerFor(u) {
  if (u.asset_class !== "equity") return u.identifier;   // already a Yahoo ticker
  return tickerByIsin[u.identifier] ?? null;
}

// An equity with no mapping has no Yahoo listing that returns data -- resolve_tickers
// tried four candidates. Skipping is right; pretending otherwise means 404s.
const unmapped = universe.filter((u) => u.asset_class === "equity" && !yahooTickerFor(u));
if (unmapped.length) {
  console.log(`${unmapped.length} equities have no Yahoo ticker and are skipped`
            + ` (first: ${unmapped.slice(0, 5).map((u) => u.symbol).join(", ")})`);
}
// Refusing here rather than limping: if the map is missing or stale enough that most
// of the universe is unroutable, the run would look like a catastrophic Yahoo outage
// when it is really a missing file.
const equities = universe.filter((u) => u.asset_class === "equity").length;
if (equities > 0 && unmapped.length > equities * 0.2) {
  console.error(`\n${unmapped.length} of ${equities} equities have no Yahoo ticker.`);
  console.error("meridian-yahoo-tickers.csv is missing or stale. Rebuild it:");
  console.error("  node resolve_tickers.mjs");
  process.exit(1);
}
const targets = LIMIT ? universe.slice(0, LIMIT) : universe;
console.log(`universe: ${targets.length} active instruments`);

// The overlap detector needs what we already hold. One query per instrument would be
// 2,240 round trips; instead read the recent window for everything at once.
const since = new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10);
const stored = await readAll(db, "prices_daily", "universe_id,trade_date,close",
                             { orderBy: ["universe_id", "trade_date"],
                               filter: (q) => q.gte("trade_date", since) });
const storedBy = {};
for (const r of stored) (storedBy[r.universe_id] ||= {})[r.trade_date] = Number(r.close);
console.log(`stored overlap window: ${stored.length.toLocaleString()} rows since ${since}`);

// Everything on or after this date is still settling and is rewritten rather than
// judged; everything before it is evidence. See restatementOf.
const UNSETTLED_FROM = unsettledFrom();
// The re-pull cap scales with this, not with any one instrument's lag. Computed here,
// before the sweep appends anything, so it describes the arrears the sweep is about
// to work through rather than what is left afterwards.
const INSTRUMENT_DAYS = arrearsInstrumentDays(storedBy);
console.log(`settlement window: bars from ${UNSETTLED_FROM} are rewritten, not judged`
          + ` (${SETTLEMENT_DAYS} days)`);

// An instrument with no stored history escalates to a five-year deep re-pull, which is
// exactly right for one instrument and catastrophic for all of them. On 2026-09-10
// prices_daily was truncated to escape a full disk; had this job run that night it
// would have found no history anywhere, concluded that every one of 2,240 instruments
// needed its full history refetched, and spent the night putting ~300MB back into the
// database that had just been emptied to save it.
//
// The distinction the code could not previously draw: "this instrument is new to us"
// versus "this table is empty". Both look identical one row at a time. They are only
// distinguishable in aggregate, which is why the check belongs here rather than in
// the loop.
const withHistory = targets.filter((u) => storedBy[u.id]).length;
if (targets.length > 0 && withHistory < targets.length * 0.5) {
  console.error(`\nOnly ${withHistory} of ${targets.length} instruments have any stored history.`);
  console.error("That is not a day's worth of corporate actions -- prices_daily is empty or");
  console.error("half-loaded, and continuing would trigger a full re-pull of everything.");
  console.error("Load it first:  Actions -> maintenance -> reload-and-republish");
  process.exit(1);
}

const flagged = [];
const failures = [];
let appended = 0, unchanged = 0;
const sweepStart = Date.now();

for (const [i, u] of targets.entries()) {
  if (!yahooTickerFor(u)) { unchanged++; continue; }   // no listing; reported above
  let result;
  try {
    result = await chart(yahooTickerFor(u), SWEEP_RANGE, true);
  } catch (e) {
    // Loud, and the watermark does not move: the next run retries this instrument.
    failures.push({ symbol: u.symbol, identifier: u.identifier, error: String(e).slice(0, 120) });
    await sleep(PAUSE_MS);
    continue;
  }

  const bars = barsOf(result);
  const have = storedBy[u.id] || {};
  const storedDates = Object.keys(have);
  const newestStored = storedDates.length ? storedDates.reduce((a, b) => (b > a ? b : a)) : null;
  let reason = null;

  if (!newestStored && bars.length) {
    // An outage longer than the sweep window leaves a hole the sweep cannot bridge,
    // so that instrument escalates rather than being appended across a gap. Checked
    // FIRST: with nothing stored there is no overlap to compare and no baseline to
    // date an event against, so neither detector below can say anything true.
    reason = "no recent stored history";
  } else {
    const evDate = unabsorbedEventDate(result, newestStored);
    if (evDate) reason = `corporate action ${evDate}, after newest stored ${newestStored}`;
    if (!reason) {
      const r = restatementOf(bars, have, rPrice, { settledBefore: UNSETTLED_FROM });
      if (r) reason = `restated ${r.date}: ${r.was} -> ${r.now}`;
    }
  }

  if (reason) {
    flagged.push({ ...u, reason });
  } else {
    // New bars, AND any bar still inside the settlement window -- the counterpart to
    // the exclusion in restatementOf. A bar written at 14:30 UTC is an intraday
    // snapshot of a session still open; rewriting it once it settles is one upserted
    // row, and the alternative is leaving a provisional value in place until it ages
    // out of the overlap window and then reporting it as a restatement. That is what
    // flagged every commodity, currency, index and crypto instrument on 2026-09-16.
    const rows = bars
      .filter((b) => have[b.date] === undefined || b.date >= UNSETTLED_FROM)
      .map((b) => ({ universe_id: u.id, trade_date: b.date,
                     high: b.high, low: b.low, close: b.close, volume: b.volume }));
    if (rows.length) { await upsertPrices(rows, u.symbol); appended += rows.length; }
    else unchanged++;
  }

  // A newline-terminated heartbeat, not a \r progress bar. Actions captures stdout
  // through a pipe rather than a TTY, so carriage-return updates do not redraw --
  // they accumulate unflushed, and a run killed before the next real newline leaves
  // no trace of how far it got. This prints roughly every 30 seconds of work and
  // carries the four numbers needed to tell "slow" from "stuck" from "throttled".
  if ((i + 1) % 100 === 0 || i + 1 === targets.length) {
    const mins = (Date.now() - sweepStart) / 60_000;
    const eta = mins / (i + 1) * (targets.length - i - 1);
    console.log(`  swept ${i + 1}/${targets.length} — ${appended} new bars, ${flagged.length} flagged, `
              + `${failures.length} failed — ${mins.toFixed(1)} min elapsed, ~${eta.toFixed(0)} min left `
              + `— http ${tallyLine()}`);
  }
  if (Date.now() - sweepStart > SWEEP_BUDGET_MS) {
    console.error(`\nsweep budget of ${SWEEP_BUDGET_MS / 60_000} min exhausted at ${i + 1}/${targets.length}.`);
    console.error(`http status counts: ${tallyLine()}`);
    console.error("Nothing downstream runs and no watermark moved, so tomorrow's sweep retries the rest.");
    process.exit(1);
  }
  await sleep(PAUSE_MS);
}
console.log(`\nsweep done in ${((Date.now() - sweepStart) / 60_000).toFixed(1)} min: `
          + `${appended.toLocaleString()} new bars, ${unchanged} unchanged, `
          + `${flagged.length} flagged, ${failures.length} failed — http ${tallyLine()}`);

for (const f of flagged) console.log(`  flagged ${f.symbol}: ${f.reason}`);

// ---- PASS 2: deep re-pull, flagged only. Overwrite, never merge — the point of a
// re-pull is that the stored series is known-wrong, and merging would preserve the
// very rows being corrected.
//
// Capped, for the same reason as the guard above -- but as a RATE, not a count. The
// flat 150 quietly assumed the job ran last night; see deepRepullCap.
const MAX_DEEP_REPULLS = deepRepullCap(INSTRUMENT_DAYS, targets.length);
console.log(`${INSTRUMENT_DAYS.toLocaleString()} instrument-days of arrears`
          + ` across ${targets.length} instruments — re-pull cap ${MAX_DEEP_REPULLS}`);

if (flagged.length > MAX_DEEP_REPULLS) {
  console.error(`\n${flagged.length} instruments flagged for a deep re-pull, over the cap of ${MAX_DEEP_REPULLS}.`);
  console.error(`That cap already allows for ${INSTRUMENT_DAYS.toLocaleString()} instrument-days of arrears.`);
  console.error("This many means something systemic -- a feed change, a wholesale");
  console.error("re-adjustment, or a partial load -- and re-pulling each of them");
  console.error("would take hours and churn the database.");
  console.error("\nBy reason:");
  const byReason = {};
  for (const f of flagged) {
    const k = f.reason.replace(/(restated|corporate action) .*/, "$1");
    byReason[k] = (byReason[k] || 0) + 1;
  }
  Object.entries(byReason).sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.error(`  ${String(n).padStart(5)}  ${k}`));
  console.error("\nFirst few:");
  flagged.slice(0, 10).forEach((f) => console.error(`  ${f.symbol}: ${f.reason}`));
  console.error("\nNo watermark moved; nothing is lost. Investigate before re-running.");
  process.exit(1);
}

// Yahoo's smallest range that covers the 1,100-day retention window is 5y, so a deep
// re-pull arrives with ~700 bars nobody keeps. Writing them and letting prune_prices
// delete them an hour later is not free: on a 500MB ceiling the dead tuples are the
// cost, and dead tuples from an upsert reload are what filled this database on the
// 10th. Trim to the window we actually retain.
const retentionCutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString().slice(0, 10);

for (const u of flagged) {
  try {
    const all = barsOf(await chart(yahooTickerFor(u), DEEP_RANGE, false));
    if (!all.length) { failures.push({ symbol: u.symbol, error: "deep re-pull returned no bars" }); continue; }
    const bars = all.filter((b) => b.date >= retentionCutoff);
    // Bars, but none of them recent: a scrip that stopped trading years ago. Not a
    // failure -- the fetch worked and told us the truth -- and emphatically not a
    // delete, which would drop the only copy of its history for the sake of writing
    // nothing back. Leave it and say so; §9 item 3a owns deactivating these.
    if (!bars.length) {
      console.log(`  skipped ${u.symbol}: ${all.length} bars, none inside the ${RETENTION_DAYS}-day window`);
      await sleep(PAUSE_MS);
      continue;
    }
    if (!DRY) {
      const { error } = await db.from("prices_daily").delete().eq("universe_id", u.id);
      if (error) throw new Error(error.message);
    }
    await upsertPrices(bars.map((b) => ({ universe_id: u.id, trade_date: b.date,
      high: b.high, low: b.low, close: b.close, volume: b.volume })), u.symbol);
    console.log(`  re-pulled ${u.symbol}: ${bars.length} bars (of ${all.length} fetched)`);
  } catch (e) {
    failures.push({ symbol: u.symbol, error: `deep re-pull: ${String(e).slice(0, 120)}` });
  }
  await sleep(PAUSE_MS);
}

if (!DRY) {
  await db.from("fetch_job_log").insert({
    job_type: "daily",
    status: failures.length ? "failure" : "success",
    message: `swept ${targets.length}, +${appended} bars, ${flagged.length} re-pulled, ${failures.length} failed`,
    started_at: new Date(t0).toISOString(), finished_at: new Date().toISOString(),
  });
}

console.log(`\n${((Date.now() - t0) / 60000).toFixed(1)} min`);
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):`);
  failures.slice(0, 40).forEach((f) => console.error(`  ${f.symbol}: ${f.error}`));
  // Non-zero so the scheduler surfaces it. The watermark never advanced for these,
  // so tomorrow's sweep retries them without any manual intervention.
  process.exit(1);
}
console.log("no failures");
