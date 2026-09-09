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
 *      Tells us WHY history moved.
 *   2. OVERLAP COMPARISON — stored adjusted close vs freshly fetched, on the ~21
 *      dates we already hold. Tells us WHETHER it moved, whatever the cause: a late
 *      or incomplete event record, an event during an outage, or Yahoo silently
 *      correcting a bad bar. Measured cost of missing one: the restatement applied
 *      to a one-year-old bar runs median 0.29%, p90 2.06%, max 3.68% — a step
 *      discontinuity that compounds, and directional, since MA200 averages old
 *      unrestated bars while price is current.
 *
 * A FAILURE MUST NEVER ADVANCE THE WATERMARK. "No new data" (holiday, halted scrip)
 * and "fetch failed" are different outcomes and do not share a code path. Conflating
 * them freezes an instrument's history while every dashboard stays green — which is
 * what made the older Colab scripts unusable unattended (§7.1).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
// Relative, not absolute: a fixed epsilon means something quite different for a ₹12
// scrip than a ₹90,000 one, and the universe spans ₹0.11 to ₹162,005.
const RESTATEMENT_EPSILON = 1e-6;

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

const r4 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 1e4) / 1e4);

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
  const tz = result?.meta?.exchangeTimezoneName || "UTC";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
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
      high: q.high?.[i] != null ? r4(q.high[i] * ratio) : null,
      low: q.low?.[i] != null ? r4(q.low[i] * ratio) : null,
      close: r4(a),
      volume: q.volume?.[i] ? Math.round(q.volume[i]) : null,
    });
  }
  return out;
}

function eventsInWindow(result) {
  const ev = result?.events || {};
  const n = Object.values(ev.dividends || {}).length + Object.values(ev.splits || {}).length;
  return n;
}

// ---------------------------------------------------------------- db
async function readAll(table, columns, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transport failures are retried; deterministic ones are not. A home connection
// dropping mid-upload aborted the first real load, and every write here is an upsert
// on a natural key, so retrying one either lands or is a no-op.
const TRANSIENT = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|502|503|504|timeout/i;

async function withRetry(fn, label) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    let error;
    try { ({ error } = await fn()); }
    catch (e) { error = { message: String(e?.message || e) }; }
    if (!error) return;
    lastError = error;
    if (!TRANSIENT.test(error.message || "") || attempt === 4) break;
    const wait = 2 ** attempt * 1000 + Math.random() * 500;
    console.error(`\n  ${label}: ${error.message} — retrying in ${(wait / 1000).toFixed(1)}s`);
    await sleep(wait);
  }
  throw new Error(`${label}: ${lastError.message}`);
}

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

const universe = await readAll("universe", "id,asset_class,identifier,symbol",
                               (q) => q.eq("status", "active"));
const targets = LIMIT ? universe.slice(0, LIMIT) : universe;
console.log(`universe: ${targets.length} active instruments`);

// The overlap detector needs what we already hold. One query per instrument would be
// 2,240 round trips; instead read the recent window for everything at once.
const since = new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10);
const stored = await readAll("prices_daily", "universe_id,trade_date,close",
                             (q) => q.gte("trade_date", since));
const storedBy = {};
for (const r of stored) (storedBy[r.universe_id] ||= {})[r.trade_date] = Number(r.close);
console.log(`stored overlap window: ${stored.length.toLocaleString()} rows since ${since}`);

const flagged = [];
const failures = [];
let appended = 0, unchanged = 0;
const sweepStart = Date.now();

for (const [i, u] of targets.entries()) {
  let result;
  try {
    result = await chart(u.identifier, SWEEP_RANGE, true);
  } catch (e) {
    // Loud, and the watermark does not move: the next run retries this instrument.
    failures.push({ symbol: u.symbol, identifier: u.identifier, error: String(e).slice(0, 120) });
    await sleep(PAUSE_MS);
    continue;
  }

  const bars = barsOf(result);
  const have = storedBy[u.id] || {};
  let reason = null;

  if (eventsInWindow(result) > 0) reason = "corporate action reported";
  if (!reason) {
    for (const b of bars) {
      const prev = have[b.date];
      if (prev == null) continue;                       // new bar, not an overlap
      const rel = Math.abs(b.close - prev) / Math.max(Math.abs(prev), 1e-9);
      if (rel > RESTATEMENT_EPSILON) {
        reason = `restated ${b.date}: ${prev} -> ${b.close}`;
        break;
      }
    }
  }
  // An outage longer than the sweep window leaves a hole the sweep cannot bridge, so
  // that instrument escalates rather than being appended across a gap.
  if (!reason && Object.keys(have).length === 0 && bars.length) reason = "no recent stored history";

  if (reason) {
    flagged.push({ ...u, reason });
  } else {
    const rows = bars
      .filter((b) => have[b.date] === undefined)
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
for (const u of flagged) {
  try {
    const bars = barsOf(await chart(u.identifier, DEEP_RANGE, false));
    if (!bars.length) { failures.push({ symbol: u.symbol, error: "deep re-pull returned no bars" }); continue; }
    if (!DRY) {
      const { error } = await db.from("prices_daily").delete().eq("universe_id", u.id);
      if (error) throw new Error(error.message);
    }
    await upsertPrices(bars.map((b) => ({ universe_id: u.id, trade_date: b.date,
      high: b.high, low: b.low, close: b.close, volume: b.volume })), u.symbol);
    console.log(`  re-pulled ${u.symbol}: ${bars.length} bars`);
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
