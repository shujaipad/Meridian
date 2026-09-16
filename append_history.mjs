/**
 * Keep the git price history at the same date as Supabase (§9, "append-only nightly
 * price history").
 *
 * The committed CSVs are the only copy of this data that is not inside a free-tier
 * database — they are what made 2026-09-10 survivable, when prices_daily had to be
 * truncated to escape a full disk and the five-year history was still on disk to
 * reload from. They are also the input to the research sandbox. Frozen at the
 * backfill, both of those get less true every day.
 *
 *   node append_history.mjs [--dry-run]
 *
 * ONE IMMUTABLE FILE PER RUN, and the shape is the whole design. Three ways to keep
 * these files current were measured against a real 42MB base file and 21 nights of
 * real bars, taking the pack git would actually push:
 *
 *   append to the 42MB base file      14,442,858 bytes per night
 *   append to one growing file             931,080 bytes per night, and rising
 *   one immutable file per night            45,587 bytes per night, flat forever
 *
 * Git deltifies all three equally well once it garbage-collects, so the gc'd repository
 * ends the same size either way — which is why "append-only" alone was the wrong rule
 * to have been carrying. What differs is every night in between: a commit touching the
 * base file writes and pushes a fresh ~14MB blob until a gc it does not control
 * deltifies it. A file written once and never reopened costs its own bytes and nothing
 * else, forever.
 *
 * MERGE RULE, for anything reading this: take the base CSVs, then every file in
 * history/appends in filename order, and let the LAST value for a (Key, Date) win.
 * That is correct for both things these files carry — new bars, which collide with
 * nothing, and corrections from a deep re-pull, which are meant to overwrite.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { newestByClass, nextAppendName } from "./meridian-history.js";
import { connect, meterLine, readAll, readAllChunked, readCSV } from "./meridian-io.js";

const BASE = dirname(fileURLToPath(import.meta.url));
const APPEND_DIR = join(BASE, "history", "appends");
const REPULLED_FILE = join(BASE, ".meridian-repulled.json");
const DRY = process.argv.includes("--dry-run");

// Key is the ISIN for equities and the Yahoo ticker for everything else — the same
// identifier each class's base file already uses, so a consumer needs no lookup table.
const HEADER = "AssetClass,Key,Date,High,Low,Close,Volume";

const EQUITY_BASE = /^meridian-price-history-2090-part\d+of3\.csv$/;
const CLASS_BASE = {
  commodity: "meridian-commodities-prices.csv",
  currency: "meridian-currencies-prices.csv",
  index: "meridian-indices-prices.csv",
  crypto: "meridian-crypto-prices.csv",
};

// ---------------------------------------------------------------- watermarks
/**
 * The newest date the git copy already holds, per asset class.
 *
 * Per class rather than one global maximum, because the classes do not share a
 * watermark: the committed equity history ends 2026-09-04 and the non-equity files end
 * 2026-09-09. One global watermark of the later date would have silently skipped five
 * days of equity bars — and skipped them in a way nothing downstream would report,
 * since a gap in a CSV looks exactly like a holiday.
 */
function watermarks() {
  const wm = {};
  const note = (cls, date) => { if (date && (!wm[cls] || date > wm[cls])) wm[cls] = date; };

  // Scanned as lines, not parsed into rows. readCSV would build an object per bar, and
  // the base files hold 2.1 million of them -- several hundred megabytes of garbage to
  // answer a question that is one string comparison per line. Both base layouts put the
  // date in field 1 (ISIN,Date,... and Symbol,Date,...); the append files put it in
  // field 2, after AssetClass and Key.
  const maxDate = (path, field) => {
    let max = "";
    const text = readFileSync(path, "utf8");
    let from = text.indexOf("\n") + 1;                       // skip the header
    while (from > 0 && from < text.length) {
      const end = text.indexOf("\n", from);
      const line = text.slice(from, end === -1 ? text.length : end);
      if (line) {
        let i = 0, start = 0, cut = -1;
        for (let k = 0; k < line.length && i <= field; k++) {
          if (line[k] === ",") { if (i === field) { cut = k; break; } i++; start = k + 1; }
        }
        const d = line.slice(start, cut === -1 ? line.length : cut);
        if (d > max) max = d;
      }
      if (end === -1) break;
      from = end + 1;
    }
    return max;
  };

  for (const f of readdirSync(BASE).filter((f) => EQUITY_BASE.test(f))) {
    note("equity", maxDate(join(BASE, f), 1));
  }
  for (const [cls, file] of Object.entries(CLASS_BASE)) {
    if (existsSync(join(BASE, file))) note(cls, maxDate(join(BASE, file), 1));
  }
  // Append files are small, so these are read properly -- the per-class watermark
  // inside one of them genuinely needs the class column, not just a maximum.
  if (existsSync(APPEND_DIR)) {
    for (const f of readdirSync(APPEND_DIR).filter((f) => f.endsWith(".csv")).sort()) {
      for (const [cls, d] of Object.entries(newestByClass(readCSV(join(APPEND_DIR, f))))) note(cls, d);
    }
  }
  return wm;
}

console.log("reading the committed history ...");
const wm = watermarks();
for (const [cls, d] of Object.entries(wm).sort()) console.log(`  ${cls.padEnd(10)} git holds up to ${d}`);
if (!Object.keys(wm).length) {
  console.error("No committed price history found. This mirrors an existing backfill; it does not create one.");
  process.exit(1);
}

// ---------------------------------------------------------------- what is new
const db = await connect();
const universe = await readAll(db, "universe", "id,asset_class,identifier,symbol",
                               { orderBy: ["id"], filter: (q) => q.eq("status", "active") });
const byId = Object.fromEntries(universe.map((u) => [u.id, u]));
// `universe.identifier` is already the right key for both: the ISIN for equities and
// the Yahoo ticker for everything else, which is exactly what each class's base file
// uses in its first column.
const keyOf = (u) => u.identifier;

const rows = [];
const seen = new Set();
const push = (u, r) => {
  const k = `${keyOf(u)}|${r.trade_date}`;
  if (seen.has(k)) return;              // a correction already covered this bar
  seen.add(k);
  rows.push([u.asset_class, keyOf(u), r.trade_date, r.high, r.low, r.close, r.volume].join(","));
};

// Corrections FIRST, so a re-pulled instrument's authoritative history wins over
// anything the new-bars pass would otherwise add for the same date.
let corrected = 0;
if (existsSync(REPULLED_FILE)) {
  const { universe_ids = [] } = JSON.parse(readFileSync(REPULLED_FILE, "utf8"));
  const ids = universe_ids.filter((id) => byId[id]);
  if (ids.length) {
    console.log(`\n${ids.length} instrument(s) were deep re-pulled; mirroring their corrected history ...`);
    await readAllChunked(db, "prices_daily", "universe_id,trade_date,high,low,close,volume", {
      idColumn: "universe_id", ids, orderBy: ["universe_id", "trade_date"],
      onPage: (data) => { for (const r of data) { push(byId[r.universe_id], r); corrected++; } },
    });
  }
} else {
  console.log("\nno deep re-pull manifest — nothing to correct this run");
}

console.log("\nreading bars newer than the git copy ...");
let appended = 0;
for (const [cls, since] of Object.entries(wm).sort()) {
  const ids = universe.filter((u) => u.asset_class === cls).map((u) => u.id);
  if (!ids.length) continue;
  const before = rows.length;
  await readAllChunked(db, "prices_daily", "universe_id,trade_date,high,low,close,volume", {
    idColumn: "universe_id", ids, orderBy: ["universe_id", "trade_date"],
    filter: (q) => q.gt("trade_date", since),
    onPage: (data) => { for (const r of data) push(byId[r.universe_id], r); },
  });
  appended += rows.length - before;
  console.log(`  ${cls.padEnd(10)} +${(rows.length - before).toLocaleString()} bars after ${since}`);
}

// ---------------------------------------------------------------- write
if (!rows.length) {
  console.log("\nnothing new to mirror.");
  console.log(`supabase: ${meterLine(db.meter)}`);
  process.exit(0);
}

// Never overwrite a file already written: these are immutable by design, and a second
// run on the same day taking a suffix keeps that true rather than quietly breaking it.
const today = new Date().toISOString().slice(0, 10);
const target = join(APPEND_DIR, nextAppendName(today, (f) => existsSync(join(APPEND_DIR, f))));

console.log(`\n${rows.length.toLocaleString()} bars`
          + ` (${appended.toLocaleString()} new, ${corrected.toLocaleString()} corrected)`);
if (DRY) {
  console.log(`would write ${target}`);
} else {
  mkdirSync(APPEND_DIR, { recursive: true });
  writeFileSync(target, `${HEADER}\n${rows.join("\n")}\n`);
  console.log(`wrote ${target}`);
}
console.log(`supabase: ${meterLine(db.meter)}`);
