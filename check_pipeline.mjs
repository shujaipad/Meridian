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
import { deepRepullCap, medianNewestStored, restatementOf, tradingArrearsSince,
         unabsorbedEventDate } from "./meridian-detect.js";
import { PAGE, r4, readAll, readAllChunked } from "./meridian-io.js";

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
          if (q._order.length) {
            view = [...view].sort((a, b) => {
              for (const c of q._order) { if (a[c] !== b[c]) return a[c] < b[c] ? -1 : 1; }
              return 0;
            });
          } else if (!stable) {
            const shift = (queries * 7) % Math.max(view.length, 1);   // a different start each time
            view = [...view.slice(shift), ...view.slice(0, shift)];
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
await check("four-decimal rounding of a legacy value is not a restatement", () => {
  const cases = [[0.330915, 0.3309], [9.463849, 9.4638], [0.991973, 0.992],
                 [0.998978, 0.999], [8.952429, 8.9524], [0.06955, 0.0696]];
  const bad = cases.filter(([was, now]) =>
    restatementOf(bars({ "2026-09-09": now }), { "2026-09-09": was }, r4));
  return eq(bad.length, 0, `false restatements among ${cases.length} rounding-only pairs`);
});

await check("a numeric column arriving as a string still compares", () =>
  eq(restatementOf(bars({ "2026-09-09": 0.3309 }), { "2026-09-09": "0.3309000000" }, r4),
     null, "verdict"));

await check("a real restatement is caught", () => {
  const r = restatementOf(bars({ "2026-09-09": 96.05 }), { "2026-09-09": 94.029999 }, r4);
  return r ? eq(r.date, "2026-09-09", "date") : "missed a 2.1% restatement";
});

await check("a restatement just above the floor is caught", () => {
  // 0.02% on a ₹1,840 stock: well below the 0.29% median, well above the noise.
  const r = restatementOf(bars({ "2026-09-09": 1840.4 }), { "2026-09-09": 1840.0 }, r4);
  return r ? null : "missed a 0.02% restatement";
});

await check("a dates-we-do-not-hold bar is not an overlap", () =>
  eq(restatementOf(bars({ "2026-09-15": 999 }), { "2026-09-04": 1840 }, r4), null, "verdict"));

await check("the first disagreeing date is the one reported", () => {
  const r = restatementOf(bars({ "2026-09-03": 10, "2026-09-04": 20 }),
                          { "2026-09-03": 11, "2026-09-04": 21 }, r4);
  return r ? eq(r.date, "2026-09-03", "date") : "found nothing";
});

// ---------------------------------------------------------------- the cap
console.log("\ndeep re-pull cap");

await check("a normal night keeps the original headroom", () =>
  eq(deepRepullCap(1), 150, "cap one trading day behind"));

await check("arrears buy proportional headroom", () =>
  eq(deepRepullCap(8), 320, "cap eight trading days behind"));

// The night that produced this work: stored history ended 2026-09-04, the job ran at
// 14:40 UTC on the 15th, and 1,009 instruments were flagged. The cap must be generous
// enough to let a real catch-up through and still refuse that.
await check("the 2026-09-15 arrears buy catch-up headroom", () =>
  eq(deepRepullCap(tradingArrearsSince("2026-09-04", Date.parse("2026-09-15T14:40:00Z"))),
     360, "cap on the night this was found"));

await check("the ceiling still refuses 2026-09-15's 1,009", () => {
  const cap = deepRepullCap(tradingArrearsSince("2026-09-04", Date.parse("2026-09-15T14:40:00Z")));
  return cap < 1009 ? null : `cap ${cap} would have accepted a systemic signal`;
});

await check("a month of arrears cannot raise the cap past the ceiling", () =>
  eq(deepRepullCap(tradingArrearsSince("2026-08-04", Date.parse("2026-09-15T14:40:00Z"))),
     400, "cap six weeks behind"));

// 5/7 rounds up rather than counting a calendar: the real answer between those two
// dates is 7 trading days, and erring high buys catch-up room rather than denying it.
await check("calendar days convert to trading days conservatively", () =>
  eq(tradingArrearsSince("2026-09-04", Date.parse("2026-09-15T14:40:00Z")), 9, "trading arrears"));

await check("no stored history at all does not inflate the cap", () =>
  eq(deepRepullCap(tradingArrearsSince(null)), 150, "cap"));

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
