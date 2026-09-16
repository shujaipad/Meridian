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
import { arrearsInstrumentDays, deepRepullCap, medianNewestStored, restatementOf,
         SETTLEMENT_DAYS, tradingArrearsSince, unabsorbedEventDate,
         unsettledFrom } from "./meridian-detect.js";
import { DEFAULT_DB_WINDOW_DAYS, DEFAULT_RETENTION_DAYS, PAGE, r4, readAll,
         readAllChunked, readEquityPrices, rPrice } from "./meridian-io.js";

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

// ----------------------------------------------------------------
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
