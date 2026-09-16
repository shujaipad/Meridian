/**
 * Pipeline self-checks. No network, no database, no secrets — run it anywhere:
 *
 *   node check_pipeline.mjs
 *
 * These cover the two defects that cost the nightly job its first four days, both of
 * which were invisible to every check that existed at the time because both produce
 * output that looks entirely reasonable:
 *
 *   - a paged read with the right row COUNT and the wrong row SET
 *   - a restatement detector that fires on 45% of the universe every night
 *
 * The rule each one taught: a check that only counts rows cannot see either.
 */
import { readFileSync } from "node:fs";

import { egressPerMonthMb, EGRESS_LIMIT_MB, evaluateHealth, mbPerYear, RUNS_PER_MONTH,
         usedMbOf, worstLevel } from "./meridian-health.js";
import { mergeRows, newestByClass, nextAppendName } from "./meridian-history.js";
import { SNAPSHOT_TABLES } from "./meridian-schema.js";
import { arrearsInstrumentDays, deepRepullCap, medianNewestStored, restatementOf,
         SETTLEMENT_DAYS, tradingArrearsSince, unabsorbedEventDate,
         unsettledFrom } from "./meridian-detect.js";
import { DEFAULT_DB_WINDOW_DAYS, DEFAULT_RETENTION_DAYS, egressSuffix, meterLine,
         meteredFetch, newMeter, PAGE, parseEgress, r4, readAll, readAllChunked,
         readEquityPrices, rPrice } from "./meridian-io.js";

let failed = 0;
// Awaited, always. An earlier draft called fn() and tested its return value, which
// for an async check is a Promise -- truthy, so every one of them "failed", and had
// they been written the other way round every one would have passed regardless of
// what it asserted. A check that cannot fail is worse than no check.
async function check(name, fn) {
  try {
    const why = await fn();
    if (why) { console.log(`  FAIL  ${name}\n        ${why}`); failed++; }
    else console.log(`  ok    ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}\n        threw: ${e.message}`);
    failed++;
  }
}
const eq = (got, want, what) =>
  (JSON.stringify(got) === JSON.stringify(want) ? null : `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---------------------------------------------------------------- a hostile fake db
/**
 * Models the part of Postgres that broke us. Every query is served from a DIFFERENT
 * rotation of the table unless an order is applied — which is what synchronize_seqscans
 * does in practice: a scan joins one already in flight and starts wherever it has
 * reached, so two identical unordered queries legitimately return different rows.
 *
 * The rotation is deterministic here so the test is too. Note what it preserves: the
 * total row count is always exact. That is the whole difficulty.
 */
function fakeDb(rows, { stable = false } = {}) {
  let queries = 0;
  return {
    queries: () => queries,
    from() {
      const q = {
        _order: [],
        _pred: (r) => true,
        select() { return q; },
        order(col) { q._order.push(col); return q; },
        eq(col, v) { const p = q._pred; q._pred = (r) => p(r) && r[col] === v; return q; },
        gte(col, v) { const p = q._pred; q._pred = (r) => p(r) && r[col] >= v; return q; },
        in(col, vs) { const s = new Set(vs); const p = q._pred; q._pred = (r) => p(r) && s.has(r[col]); return q; },
        range(from, to) {
          queries++;
          let view = rows.filter(q._pred);
          // The rotation happens FIRST, and it happens whether or not an order was
          // applied. Ordering by a non-unique column is not a total order: rows that
          // tie are still free to come back in any sequence, so `.order("universe_id")`
          // over many bars per instrument has exactly the bug `.order()` was meant to
          // fix. Rotating before a stable sort is what makes that visible here --
          // sorting the array as given would quietly preserve its natural order and
          // the check would pass on code that fails in production.
          if (!stable) {
            // A LARGE shift, not a token one. A rotation of 7 moves rows around
            // inside whichever group they already sat in, and a group that fits
            // entirely within one page then comes back correct no matter what -- so a
            // small shift models the hazard for unordered reads and silently fails to
            // model it for reads ordered by a non-unique column. 811 is prime and
            // comfortably larger than any single instrument's run of bars here, so
            // ties genuinely cross page boundaries.
            const shift = (queries * 811) % Math.max(view.length, 1);
            view = [...view.slice(shift), ...view.slice(0, shift)];
          }
          if (q._order.length) {
            view = [...view].sort((a, b) => {
              for (const c of q._order) { if (a[c] !== b[c]) return a[c] < b[c] ? -1 : 1; }
              return 0;                                  // a tie stays where it landed
            });
          }
          return Promise.resolve({ data: view.slice(from, to + 1), error: null });
        },
      };
      return q;
    },
  };
}

// 2.5 pages of two-column rows, every one distinct.
const rows = Array.from({ length: PAGE * 2 + 500 }, (_, i) => ({ id: i, universe_id: i % 400, trade_date: `d${i}` }));

console.log("paged reads");

await check("readAll refuses a read with no ordering", () => {
  return readAll(fakeDb(rows), "t", "id").then(
    () => "it returned instead of throwing",
    (e) => (/orderBy is required/.test(e.message) ? null : `wrong error: ${e.message}`));
});

await check("readAllChunked refuses a read with no ordering", () => {
  return readAllChunked(fakeDb(rows), "t", "id", { idColumn: "universe_id", ids: [1, 2] }).then(
    () => "it returned instead of throwing",
    (e) => (/orderBy is required/.test(e.message) ? null : `wrong error: ${e.message}`));
});

// The test has teeth only if the fake db really does break an unordered read. Prove
// it, by paging it by hand the way readAll used to.
await check("the fake db reproduces the production failure (count right, set wrong)", async () => {
  const db = fakeDb(rows);
  const got = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await db.from("t").select("id").range(from, from + PAGE - 1);
    got.push(...data);
    if (data.length < PAGE) break;
  }
  const distinct = new Set(got.map((r) => r.id)).size;
  if (got.length !== rows.length) return `count should still be exact: ${got.length} vs ${rows.length}`;
  if (distinct === rows.length) return "unordered paging returned a complete set — the fake db is too kind to catch anything";
  return null;
});

await check("readAll returns every row exactly once, ordered", async () => {
  const got = await readAll(fakeDb(rows), "t", "id", { orderBy: ["id"] });
  if (got.length !== rows.length) return `got ${got.length} rows, want ${rows.length}`;
  const distinct = new Set(got.map((r) => r.id)).size;
  if (distinct !== rows.length) return `${rows.length - distinct} rows duplicated or missing`;
  return null;
});

await check("readAll applies the caller's filter as well as the order", async () => {
  const got = await readAll(fakeDb(rows), "t", "id", {
    orderBy: ["id"], filter: (q) => q.gte("id", 2000),
  });
  return eq(got.length, 500, "filtered row count");
});

await check("readAllChunked returns every row for every id exactly once", async () => {
  const ids = Array.from({ length: 400 }, (_, i) => i);
  const got = await readAllChunked(fakeDb(rows), "t", "universe_id,trade_date",
    { idColumn: "universe_id", ids, orderBy: ["universe_id", "trade_date"] });
  const distinct = new Set(got.map((r) => r.trade_date)).size;
  if (got.length !== rows.length) return `got ${got.length} rows, want ${rows.length}`;
  if (distinct !== rows.length) return `${rows.length - distinct} rows duplicated or missing`;
  return null;
});

// ---------------------------------------------------------------- shared price read
console.log("\nequity price read");

// universe: 3 equities and 1 non-equity, spanning two pages of bars.
const priceFixture = [];
const universeRows = [
  { id: 1, identifier: "INE397D01024", asset_class: "equity" },
  { id: 2, identifier: "INE467B01029", asset_class: "equity" },
  { id: 3, identifier: "INE009A01021", asset_class: "equity" },
  { id: 9, identifier: "GC=F", asset_class: "commodity" },
];
for (const u of universeRows) {
  for (let d = 0; d < 700; d++) {
    const date = new Date(Date.UTC(2026, 0, 1) + d * 86400_000).toISOString().slice(0, 10);
    priceFixture.push({ universe_id: u.id, trade_date: date,
                        high: 2, low: 1, close: 1.5, volume: 10 });
  }
}
// One fakeDb per TABLE, created once and reused, so its query counter advances across
// the pages of a single read. Built fresh per table on every call at first, which
// reset the counter and handed every page the same rotation -- a hostile fake that
// behaved perfectly, and three checks that passed on code known to be broken.
function priceDb() {
  const dbs = { universe: fakeDb(universeRows), prices_daily: fakeDb(priceFixture) };
  return { from: (table) => dbs[table].from() };
}

await check("reads every bar for every equity, exactly once", async () => {
  const { prices, instrumentCount } = await readEquityPrices(priceDb(),
    { windowDays: 100_000 });
  if (instrumentCount !== 3) return `${instrumentCount} equities, want 3`;
  const seen = new Set(prices.map((r) => `${r.ISIN} ${r.Date}`));
  if (prices.length !== 2100) return `${prices.length} rows, want 2100`;
  if (seen.size !== 2100) return `${2100 - seen.size} rows duplicated or missing`;
  return null;
});

await check("keys rows by ISIN, not by universe_id", async () => {
  const { prices } = await readEquityPrices(priceDb(), { windowDays: 100_000 });
  const isins = new Set(prices.map((r) => r.ISIN));
  return eq([...isins].sort(), ["INE009A01021", "INE397D01024", "INE467B01029"], "ISINs");
});

await check("leaves the non-equity classes alone", async () => {
  const { prices } = await readEquityPrices(priceDb(), { windowDays: 100_000 });
  return prices.some((r) => r.ISIN === "GC=F") ? "a commodity came back with the equities" : null;
});

// A million rows is the whole point of this reader, and a million rows is where
// `push(...rows)` throws RangeError -- which is exactly how the 2026-09-16 compute step
// died, twenty-two minutes in, after successfully reading everything it needed. The
// spread limit sits between 125k and 150k arguments on this runtime, so the fixture is
// 200k: comfortably past it, and cheap because this fake just slices a sorted array
// rather than modelling scan order (the checks above already cover that).
await check("a million-row read does not overflow the stack", async () => {
  const BIG = 200_000;
  const bars = Array.from({ length: BIG }, (_, i) => ({
    universe_id: 1, trade_date: String(i).padStart(7, "0"),
    high: 2, low: 1, close: 1.5, volume: 10,
  }));
  const tables = { universe: [{ id: 1, identifier: "INE397D01024", asset_class: "equity" }],
                   prices_daily: bars };
  const bigDb = { from: (t) => { const q = {
    select: () => q, order: () => q, eq: () => q, gte: () => q, in: () => q,
    range: (from, to) => Promise.resolve({ data: tables[t].slice(from, to + 1), error: null }),
  }; return q; } };
  const into = [];
  await readEquityPrices(bigDb, { windowDays: 100_000, into });
  return eq(into.length, BIG, "rows appended");
});

await check("into is appended to, not replaced", async () => {
  const into = [{ ISIN: "SENTINEL", Date: "1900-01-01" }];
  const { prices } = await readEquityPrices(priceDb(), { windowDays: 100_000, into });
  if (prices !== into) return "returned a different array than the one passed in";
  return into[0].ISIN === "SENTINEL" ? null : "clobbered what the caller already had";
});

await check("the retention window clears the model's read window", () => {
  // Not a style point: 800 CALENDAR days is ~550 trading days and the breadth series
  // alone is 500 of them. Pruning into the read window shortens MA200, the 252-day RS
  // lookback and breadth with no error anywhere.
  const margin = DEFAULT_RETENTION_DAYS - DEFAULT_DB_WINDOW_DAYS;
  return margin >= 250 ? null
    : `retention ${DEFAULT_RETENTION_DAYS} leaves only ${margin} days over the ${DEFAULT_DB_WINDOW_DAYS}-day read window`;
});

// ---------------------------------------------------------------- detector 1
console.log("\ncorporate-action detector");

const day = (s) => Math.floor(Date.parse(`${s}T12:00:00Z`) / 1000);
const withEvents = (dates) => ({
  meta: { exchangeTimezoneName: "UTC" },
  events: { dividends: Object.fromEntries(dates.map((d, i) => [i, { date: day(d), amount: 1 }])) },
});

await check("a dividend older than our newest stored bar is already absorbed", () =>
  eq(unabsorbedEventDate(withEvents(["2026-08-20"]), "2026-09-04"), null, "verdict"));

await check("a dividend on the newest stored bar's own date is absorbed", () =>
  eq(unabsorbedEventDate(withEvents(["2026-09-04"]), "2026-09-04"), null, "verdict"));

await check("a dividend after our newest stored bar is not", () =>
  eq(unabsorbedEventDate(withEvents(["2026-09-11"]), "2026-09-04"), "2026-09-11", "verdict"));

await check("the newest of several events decides", () =>
  eq(unabsorbedEventDate(withEvents(["2026-08-01", "2026-09-11", "2026-08-20"]), "2026-09-04"),
     "2026-09-11", "verdict"));

await check("a split is an event too", () => {
  const r = { meta: { exchangeTimezoneName: "UTC" },
              events: { splits: { 0: { date: day("2026-09-11") } } } };
  return eq(unabsorbedEventDate(r, "2026-09-04"), "2026-09-11", "verdict");
});

await check("no stored bars is not a corporate action", () =>
  eq(unabsorbedEventDate(withEvents(["2026-09-11"]), null), null, "verdict"));

await check("no events, no flag", () =>
  eq(unabsorbedEventDate({ meta: {}, events: {} }, "2026-09-04"), null, "verdict"));

// The number that matters. A month-wide window over this universe holds hundreds of
// ordinary ex-dividend dates; the old detector flagged every one.
await check("an ordinary month of dividends does not flag the universe", () => {
  const stored = "2026-09-04";
  const flagged = Array.from({ length: 335 }, (_, i) => {
    const d = `2026-08-${String((i % 28) + 1).padStart(2, "0")}`;
    return unabsorbedEventDate(withEvents([d]), stored);
  }).filter(Boolean).length;
  return eq(flagged, 0, "instruments flagged by a month of ordinary dividends");
});

// ---------------------------------------------------------------- detector 2
console.log("\nrestatement detector");

const bars = (o) => Object.entries(o).map(([date, close]) => ({ date, close }));

// The five instruments this actually fired on in production, every night, for good.
// Stored at full precision by the original load, refetched through r4, identical.
// `settledBefore` is the date at which bars STOP being settled, so a far-future value
// treats every test date as settled and exercises the comparison itself rather than
// the exclusion. Written the other way round first, and every check below passed
// while comparing nothing at all -- the settlement section is what caught it.
const SETTLED = "2099-01-01";
const at = (date, now, was) => restatementOf(bars({ [date]: now }), { [date]: was }, rPrice,
                                             { settledBefore: SETTLED });

await check("rounding a legacy value is not a restatement", () => {
  // Every pair the production runs actually fired on. The last two are the one-step
  // half-way cases that r4 got wrong and rPrice preserves.
  const cases = [[0.330915, 0.3309], [9.463849, 9.4638], [0.991973, 0.992],
                 [0.998978, 0.999], [8.952429, 8.9524], [0.06955, 0.0696],
                 [0.70815, 0.7082], [0.585754, 0.58575]];
  const bad = cases.filter(([was, now]) => at("2026-09-09", now, was));
  return eq(bad.length, 0, `false restatements among ${cases.length} rounding-only pairs`);
});

await check("a sub-cent price survives rounding at all", () => {
  if (rPrice(0.000005) !== 0.000005) return `rPrice(0.000005) = ${rPrice(0.000005)}, want 0.000005`;
  if (r4(0.000005) !== 0) return "r4 no longer rounds SHIB to zero -- rewrite this check";
  // ...and is not then reported as a restatement against itself.
  return at("2026-09-09", 0.000005, 0.000005) ? "flagged itself" : null;
});

await check("rPrice is r4 exactly at or above 1", () => {
  const vals = [1, 94.029999, 1840.0, 162005.25, 23540.050781, 4417.799805];
  const bad = vals.filter((v) => rPrice(v) !== r4(v));
  return eq(bad.length, 0, "values where rPrice and r4 disagree");
});

await check("a numeric column arriving as a string still compares", () =>
  eq(at("2026-09-09", 0.3309, "0.3309000000"), null, "verdict"));

await check("a real restatement is caught", () => {
  const r = at("2026-09-09", 96.05, 94.029999);
  return r ? eq(r.date, "2026-09-09", "date") : "missed a 2.1% restatement";
});

await check("a restatement just above the floor is caught", () => {
  // 0.02% on a ₹1,840 stock: well below the 0.29% median, well above the noise.
  return at("2026-09-09", 1840.4, 1840.0) ? null : "missed a 0.02% restatement";
});

await check("a dates-we-do-not-hold bar is not an overlap", () =>
  eq(restatementOf(bars({ "2026-09-15": 999 }), { "2026-09-04": 1840 }, rPrice,
                   { settledBefore: SETTLED }), null, "verdict"));

await check("the first settled disagreeing date is the one reported", () => {
  const r = restatementOf(bars({ "2026-09-03": 10, "2026-09-04": 20 }),
                          { "2026-09-03": 11, "2026-09-04": 21 }, rPrice,
                          { settledBefore: SETTLED });
  return r ? eq(r.date, "2026-09-03", "date") : "found nothing";
});

// ---------------------------------------------------------------- settlement
console.log("\nsettlement window");

await check("an unsettled bar that moved is not a restatement", () => {
  const cutoff = unsettledFrom(Date.parse("2026-09-16T14:30:00Z"));
  const r = restatementOf(bars({ "2026-09-15": 101.21 }), { "2026-09-15": 99.089996 },
                          rPrice, { settledBefore: cutoff });
  return r ? `flagged ${r.date}, which was still settling` : null;
});

await check("the same move on a settled date is", () => {
  const cutoff = unsettledFrom(Date.parse("2026-09-16T14:30:00Z"));
  const r = restatementOf(bars({ "2026-09-09": 101.21 }), { "2026-09-09": 99.089996 },
                          rPrice, { settledBefore: cutoff });
  return r ? null : "missed a 2.1% restatement on a settled bar";
});

await check("a Friday bar is still unsettled when compared on Monday", () => {
  // 2026-09-11 is a Friday, 2026-09-14 the Monday after.
  const cutoff = unsettledFrom(Date.parse("2026-09-14T14:30:00Z"));
  return "2026-09-11" >= cutoff ? null
    : `cutoff ${cutoff} treats Friday as settled; SETTLEMENT_DAYS is ${SETTLEMENT_DAYS}`;
});

// The shape of the 2026-09-16 failure: every non-equity's newest bar, written
// mid-session, reported as a restatement the following night.
await check("a universe of mid-session bars produces no restatements", () => {
  const cutoff = unsettledFrom(Date.parse("2026-09-16T14:30:00Z"));
  const flagged = Array.from({ length: 98 }, (_, i) => {
    const provisional = 100 + i, settled = provisional * 1.011;   // the measured ~1.1%
    return restatementOf(bars({ "2026-09-15": settled }), { "2026-09-15": provisional },
                         rPrice, { settledBefore: cutoff });
  }).filter(Boolean).length;
  return eq(flagged, 0, "non-equities flagged for having been fetched before the close");
});

// ---------------------------------------------------------------- the cap
console.log("\ndeep re-pull cap");

const UNIVERSE = 2238;

await check("a caught-up universe lands on the floor", () => {
  const cap = deepRepullCap(UNIVERSE * 1, UNIVERSE);
  // The rate is set so a universe one day behind lands on the floor, give or take the
  // rounding: that is the regime a flat 150 described correctly all along.
  return cap >= 150 && cap <= 160 ? null : `cap ${cap}, want ~150`;
});

await check("arrears buy headroom", () =>
  eq(deepRepullCap(UNIVERSE * 2, UNIVERSE), 313, "cap two trading days behind"));

await check("the share ceiling binds before the arrears do", () =>
  eq(deepRepullCap(UNIVERSE * 30, UNIVERSE), 448, "cap thirty trading days behind"));

await check("the ceiling still refuses 2026-09-15's 1,009", () => {
  const cap = deepRepullCap(UNIVERSE * 30, UNIVERSE);
  return cap < 1009 ? null : `cap ${cap} would have accepted 45% of the universe`;
});

// The night this was found: ~1,057 instruments nine trading days behind and ~1,133
// one day behind, against 248 flags once the detectors were corrected.
await check("the 2026-09-16 arrears admit its 248 real flags", () => {
  const cap = deepRepullCap(1057 * 9 + 1133 * 1, UNIVERSE);
  return cap >= 248 ? null : `cap ${cap} would have refused a legitimate catch-up`;
});

await check("an emptied prices_daily falls to the floor, not the ceiling", () =>
  eq(deepRepullCap(0, UNIVERSE), 150, "cap with no stored history anywhere"));

await check("arrears are summed across instruments, not averaged", () => {
  const storedBy = {
    1: { "2026-09-04": 1 },          // 9 trading days behind
    2: { "2026-09-04": 1 },
    3: { "2026-09-15": 1 },          // 1 day behind
  };
  // 2026-09-04 is 10 trading days back from 2026-09-16 14:30 and 2026-09-15 is 2.
  const days = arrearsInstrumentDays(storedBy, Date.parse("2026-09-16T14:30:00Z"));
  return eq(days, 10 + 10 + 2, "instrument-days");
});

await check("an instrument with no bars contributes nothing", () =>
  eq(arrearsInstrumentDays({ 1: {} }, Date.parse("2026-09-16T14:30:00Z")), 0, "instrument-days"));

await check("calendar days convert to trading days conservatively", () =>
  eq(tradingArrearsSince("2026-09-04", Date.parse("2026-09-15T14:40:00Z")), 9, "trading arrears"));

await check("the median newest stored bar ignores a few dead scrips", () => {
  const storedBy = {
    1: { "2026-09-04": 1, "2026-09-03": 1 },
    2: { "2026-09-04": 1 },
    3: { "2026-09-04": 1 },
    4: { "2021-01-04": 1 },          // delisted years ago, still in the table
    5: { "2020-06-01": 1 },
  };
  return eq(medianNewestStored(storedBy), "2026-09-04", "median newest");
});

// ---------------------------------------------------------------- snapshot tables
console.log("\nsnapshot tables");

// Parsed from the schema rather than restated here: a second copy of the column list
// would drift from the first, which is how the defect below got in.
const schemaSql = readFileSync(new URL("./supabase-schema.sql", import.meta.url), "utf8");
function columnsOf(table) {
  const m = schemaSql.match(new RegExp(`create table ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i"));
  if (!m) return null;
  return m[1].split("\n")
    .map((l) => l.trim().split(/\s+/)[0].replace(/[(),]/g, ""))
    .filter((c) => c && !/^(unique|primary|foreign|check|constraint|--)$/i.test(c));
}

await check("every snapshot table is cleared on a column it actually has", () => {
  const bad = [];
  for (const { table, clearOn } of SNAPSHOT_TABLES) {
    const cols = columnsOf(table);
    if (!cols) { bad.push(`${table}: not found in supabase-schema.sql`); continue; }
    if (!cols.includes(clearOn)) bad.push(`${table}.${clearOn} does not exist (has ${cols.join(", ")})`);
  }
  return bad.length ? bad.join("; ") : null;
});

// The defect itself: market_breadth_daily was upserted every night and never cleared,
// because clear() deleted on as_of_date and that table is keyed by trade_date. 500
// rows published, 508 in the table, growing by one a night.
await check("market_breadth_daily is cleared like the other snapshots", () => {
  const entry = SNAPSHOT_TABLES.find((t) => t.table === "market_breadth_daily");
  if (!entry) return "the table that actually grew is not in the clear list";
  return entry.clearOn === "trade_date" ? null
    : `cleared on ${entry.clearOn}, which market_breadth_daily does not have`;
});

await check("the clear list covers every table the publish step writes", () => {
  const src = readFileSync(new URL("./compute_and_publish.mjs", import.meta.url), "utf8");
  const written = [...src.matchAll(/await write\("([a-z_]+)"/g)].map((m) => m[1]);
  const cleared = new Set(SNAPSHOT_TABLES.map((t) => t.table));
  const missing = written.filter((t) => !cleared.has(t));
  return missing.length ? `published but never cleared: ${missing.join(", ")}` : null;
});

// ---------------------------------------------------------------- git price mirror
console.log("\ngit price mirror");

const bar = (Key, Date, Close, AssetClass = "equity") => ({ AssetClass, Key, Date, Close });

await check("a new bar is added, an existing one left alone", () => {
  const merged = mergeRows([[bar("A", "2026-09-16", 10)], [bar("A", "2026-09-17", 11)]]);
  return eq(merged.map((r) => `${r.Date}:${r.Close}`).sort(),
            ["2026-09-16:10", "2026-09-17:11"], "merged");
});

// The whole reason last-wins is the rule: a deep re-pull's history must overwrite.
await check("a later correction overwrites an earlier bar", () => {
  const merged = mergeRows([[bar("A", "2026-09-16", 10)], [bar("A", "2026-09-16", 9.5)]]);
  if (merged.length !== 1) return `${merged.length} rows, want 1`;
  return eq(merged[0].Close, 9.5, "close");
});

await check("order is what decides, so batches must be passed oldest first", () => {
  const merged = mergeRows([[bar("A", "2026-09-16", 9.5)], [bar("A", "2026-09-16", 10)]]);
  return eq(merged[0].Close, 10, "close");
});

await check("the same date for two instruments is two bars, not a collision", () => {
  const merged = mergeRows([[bar("A", "2026-09-16", 10), bar("B", "2026-09-16", 20)]]);
  return eq(merged.length, 2, "rows");
});

// The bug the per-class watermark exists to prevent: the committed equity history ends
// 2026-09-04 and the non-equity files end 2026-09-09. One global watermark would skip
// five days of equity bars, invisibly, because a gap looks like a holiday.
await check("watermarks are per asset class, not one global maximum", () => {
  const rows = [bar("A", "2026-09-04", 1, "equity"), bar("GC=F", "2026-09-09", 2, "commodity")];
  const wm = newestByClass(rows);
  if (wm.equity !== "2026-09-04") return `equity watermark ${wm.equity}, want 2026-09-04`;
  return eq(wm.commodity, "2026-09-09", "commodity watermark");
});

await check("a class with no rows has no watermark rather than a wrong one", () =>
  eq(newestByClass([]), {}, "watermarks"));

await check("append filenames are immutable — a second run takes a suffix", () => {
  const have = new Set(["2026-09-17.csv"]);
  if (nextAppendName("2026-09-17", (f) => have.has(f)) !== "2026-09-17.2.csv") return "did not suffix";
  have.add("2026-09-17.2.csv");
  if (nextAppendName("2026-09-17", (f) => have.has(f)) !== "2026-09-17.3.csv") return "did not keep counting";
  return eq(nextAppendName("2026-09-18", (f) => have.has(f)), "2026-09-18.csv", "a fresh day");
});

// ---------------------------------------------------------------- health
console.log("\nhealth checks");

const NOW = Date.parse("2026-09-16T03:30:00Z");
const healthy = {
  rowCounts: { prices_daily: { count: 1_468_652 } },
  freshness: { equity: "2026-09-16", commodity: "2026-09-16", crypto: "2026-09-16",
               currency: "2026-09-16", index: "2026-09-16" },
  jobs: [{ job_type: "daily", status: "success", message: "ok", finished_at: "2026-09-16T15:20:00Z" }],
  sizes: [{ object: "DATABASE TOTAL", size_mb: 204.2 }],
  dupes: [], errors: [],
};
const evalWith = (over) => evaluateHealth({ ...healthy, ...over }, { now: NOW });

await check("a healthy pipeline reports nothing", () =>
  eq(evalWith({}), [], "findings"));

await check("stale screens are an error", () => {
  const f = evalWith({ freshness: { equity: "2026-09-04" } });
  const stale = f.find((x) => x.code === "stale");
  if (!stale) return "12-day-old screens produced no finding";
  return stale.level === "error" ? null : `level ${stale.level}, want error`;
});

// A weekend plus a public holiday is normal and must not mail anyone.
await check("a long weekend is not stale", () =>
  eq(evalWith({ freshness: { equity: "2026-09-12" } }).filter((x) => x.code === "stale"),
     [], "findings four days out"));

await check("the fifth day is", () => {
  const f = evalWith({ freshness: { equity: "2026-09-11" } });
  return f.some((x) => x.code === "stale") ? null : "five days old passed silently";
});

await check("an empty technicals_daily is an error, not silence", () => {
  const f = evalWith({ freshness: {} });
  const none = f.find((x) => x.code === "no-screens");
  return none && none.level === "error" ? null : "publishing nothing at all went unreported";
});

// The five crypto instruments frozen years in the past: invisible in one as-of date.
await check("one asset class lagging the rest is caught", () => {
  const f = evalWith({ freshness: { equity: "2026-09-16", crypto: "2026-09-01" } });
  return f.some((x) => x.code === "class-skew") ? null : "a 15-day skew went unreported";
});

await check("a failed job log entry is an error", () => {
  const f = evalWith({ jobs: [{ job_type: "daily", status: "failure", message: "3 failed" }] });
  const j = f.find((x) => x.code === "job-failed");
  return j && j.level === "error" ? null : "a failed run was not reported";
});

await check("capacity past the threshold is an error", () => {
  const f = evalWith({ sizes: [{ object: "DATABASE TOTAL", size_mb: 420 }] });
  const c = f.find((x) => x.code === "capacity");
  return c && c.level === "error" ? null : "84% of the limit went unreported";
});

await check("a two-year trajectory warns but does not wake anyone", () => {
  // 204MB over 1.47M rows is ~146 bytes/row; ~112MB/year against 296MB of headroom is
  // about 2.6 years, so this one has to be pushed to trip.
  const f = evaluateHealth({ ...healthy, sizes: [{ object: "DATABASE TOTAL", size_mb: 380 }] },
                           { now: NOW });
  const t = f.find((x) => x.code === "trajectory");
  if (!t) return "a full-in-months trajectory produced no finding";
  return t.level === "warning" ? null : `level ${t.level}, want warning`;
});

// EGRESS -- the last quota that was a number in prose (§6.5) rather than a gauge.
await check("egress inside the allowance says nothing", () => {
  const f = evalWith({ jobs: [{ status: "success", egress: { bytes: 60 * 1048576, requests: 900 } }] });
  return f.some((x) => x.code.startsWith("egress")) ? "60 MB a run raised a finding" : null;
});

await check("egress past the warn threshold warns", () => {
  // 190 MB x 22 runs is ~4.1 GB, 80% of the 5 GB allowance.
  const f = evalWith({ jobs: [{ status: "success", egress: { bytes: 190 * 1048576, requests: 9000 } }] });
  const e = f.find((x) => x.code === "egress");
  return e && e.level === "warning" ? null : "80% of the allowance passed silently";
});

await check("egress over the allowance is an error", () => {
  const f = evalWith({ jobs: [{ status: "success", egress: { bytes: 300 * 1048576, requests: 9000 } }] });
  const e = f.find((x) => x.code === "egress-over");
  return e && e.level === "error" ? null : "exceeding the allowance was not an error";
});

await check("the worst recent run sets the projection, not the average", () => {
  // A quiet Saturday must not average away a weekday that blows the budget.
  const f = evalWith({ jobs: [
    { status: "success", egress: { bytes: 5 * 1048576, requests: 10 } },
    { status: "success", egress: { bytes: 300 * 1048576, requests: 9000 } },
  ] });
  return f.some((x) => x.code === "egress-over") ? null : "the big run was averaged away";
});

await check("egress projects over trading days, not calendar days", () => {
  if (RUNS_PER_MONTH !== 22) return `RUNS_PER_MONTH is ${RUNS_PER_MONTH}; the job runs weekdays`;
  const mb = egressPerMonthMb(100 * 1048576);
  return Math.round(mb) === 2200 ? null : `${mb} MB/month for a 100 MB run, want 2200`;
});

await check("a run with no egress tag is skipped, not counted as zero", () => {
  const f = evalWith({ jobs: [{ status: "success", message: "swept 2238", egress: null }] });
  return f.some((x) => x.code.startsWith("egress")) ? "an untagged run produced a finding" : null;
});

// The suffix has to survive the round trip through fetch_job_log.message.
await check("the egress tag round-trips through the job log message", () => {
  const meter = { requests: 9_123, wireBytes: 250_000_000, decodedBytes: 1_000_000,
                  sentBytes: 5_000, unmeasured: 0 };
  const message = `swept 2238, +4991 bars, 3 re-pulled, 0 failed ${egressSuffix(meter)}`;
  const back = parseEgress(message);
  if (!back) return `did not parse: ${message}`;
  if (back.bytes !== 251_000_000) return `bytes ${back.bytes}, want 251000000`;
  return eq(back.requests, 9123, "requests");
});

await check("a message with no tag parses as absent, not as zero", () =>
  eq(parseEgress("swept 2238, +4991 bars"), null, "parsed"));

// The meter itself: content-length is preferred because that is what a provider bills.
await check("the meter counts wire bytes when content-length is present", async () => {
  const meter = newMeter();
  const fake = async () => ({ headers: { get: (h) => (h === "content-length" ? "1024" : null) } });
  await meteredFetch(meter, fake)("https://example.test", {});
  if (meter.wireBytes !== 1024) return `wireBytes ${meter.wireBytes}, want 1024`;
  return eq(meter.requests, 1, "requests");
});

await check("a chunked response is measured from its body", async () => {
  const meter = newMeter();
  const body = new Uint8Array(2048);
  const fake = async () => ({
    headers: { get: () => null },
    clone: () => ({ arrayBuffer: async () => body.buffer }),
  });
  await meteredFetch(meter, fake)("https://example.test", {});
  return eq(meter.decodedBytes, 2048, "decodedBytes");
});

await check("what we upload is counted separately from what we download", async () => {
  const meter = newMeter();
  const fake = async () => ({ headers: { get: () => "10" } });
  await meteredFetch(meter, fake)("https://example.test", { body: "x".repeat(500) });
  if (meter.sentBytes !== 500) return `sentBytes ${meter.sentBytes}, want 500`;
  return meter.wireBytes === 10 ? null : `upload leaked into wireBytes (${meter.wireBytes})`;
});

await check("a check that could not run is reported, not assumed passed", () => {
  const f = evalWith({ errors: ["capacity rpc: permission denied"] });
  return f.some((x) => x.code === "unreadable") ? null : "an unreadable check passed silently";
});

await check("only errors are worth waking someone for", () => {
  if (worstLevel([]) !== "ok") return "empty findings are not ok";
  if (worstLevel([{ level: "warning" }]) !== "warning") return "a warning read as something else";
  if (worstLevel([{ level: "warning" }, { level: "error" }]) !== "error") return "an error was masked by a warning";
  return null;
});

await check("bytes per row is measured from the live numbers", () => {
  // 204.2MB over 1,468,652 rows is ~146 bytes; 2,240 rows a night is ~112MB a year.
  const perYear = mbPerYear(204.2, 1_468_652);
  return perYear > 105 && perYear < 120 ? null : `${perYear?.toFixed(0)} MB/year, want ~112`;
});

await check("a missing capacity row reads as unknown, not as zero", () => {
  if (usedMbOf(null) !== null) return "null sizes did not read as unknown";
  if (usedMbOf([{ object: "prices_daily", size_mb: 181 }]) !== null) return "a partial listing invented a total";
  return eq(usedMbOf([{ object: "DATABASE TOTAL", size_mb: 204.2 }]), 204.2, "total");
});

// ----------------------------------------------------------------
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
