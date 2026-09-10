/**
 * What is actually in the database, and how close it is to the ceiling.
 *
 * Written after 2026-09-10, when the project hit Supabase's 500MB limit and went
 * read-only. Reconstructing it afterwards showed prices_daily was 368MB on the day of
 * the FIRST load -- 74% of the budget before a single nightly append -- and nothing
 * anywhere had ever compared a number against a limit. §6.5 of the requirements
 * recorded "500MB storage" in prose and it stayed prose.
 *
 * So this exists to be run on every maintenance job and every daily run: it prints
 * the numbers, and it EXITS NON-ZERO past a threshold. A report nobody reads is what
 * fetch_job_log already was.
 *
 * Row counts come from PostgREST's exact count, which needs no SQL access. Byte sizes
 * need a real query, so they appear only if the optional helper function is installed
 * (supabase-migration-005-capacity.sql). Without it you still get the thing that
 * actually predicts trouble: how many rows there are and how fast they arrive.
 */
import { readAll } from "./meridian-io.js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}
const { createClient } = await import("@supabase/supabase-js");
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Supabase's Free plan quota. The number that was written down and never checked.
const LIMIT_MB = Number(process.env.DB_LIMIT_MB ?? 500);
const WARN_AT = Number(process.env.DB_WARN_PCT ?? 80);

const TABLES = ["universe", "prices_daily", "fundamentals_annual", "technicals_daily",
                "sectoral_technicals_daily", "fundamentals_scored",
                "golden_breakout_candidates", "market_breadth_daily", "fetch_job_log"];

async function rowCount(table) {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) return { error: error.message };
  return { count };
}

console.log("\n--- meridian database report ---------------------------------");
console.log(new Date().toISOString());

let prices = null;
console.log("\n  rows");
for (const t of TABLES) {
  const r = await rowCount(t);
  if (r.error) { console.log(`    ${t.padEnd(28)} unreadable: ${r.error}`); continue; }
  // PostgREST can answer a head-count with a null count. Reading that as a number
  // throws, and a report that crashes on the way to warning you about a limit is
  // worse than one that says "unknown".
  if (r.count == null) { console.log(`    ${t.padEnd(28)}     unknown`); continue; }
  if (t === "prices_daily") prices = r.count;
  console.log(`    ${t.padEnd(28)} ${r.count.toLocaleString().padStart(11)}`);
}

// Per-class as-of dates: the fastest way to see a screen has gone stale, and the
// check that would have shown five crypto instruments frozen years in the past.
console.log("\n  freshness");
try {
  const universe = await readAll(db, "universe", "id,asset_class,symbol");
  const tech = await readAll(db, "technicals_daily", "universe_id,as_of_date");
  const classOf = Object.fromEntries(universe.map((u) => [String(u.id), u.asset_class]));
  const byClass = {};
  for (const t of tech) {
    const c = classOf[String(t.universe_id)] ?? "unknown";
    (byClass[c] ||= []).push(t.as_of_date);
  }
  for (const [c, dates] of Object.entries(byClass).sort()) {
    const max = dates.reduce((m, d) => (d > m ? d : m), "");
    const age = Math.round((Date.now() - Date.parse(max)) / 86400_000);
    console.log(`    ${c.padEnd(12)} as of ${max}  (${age} day${age === 1 ? "" : "s"} old)`);
  }
} catch (e) {
  console.log(`    unavailable: ${e.message}`);
}

// The job log, at last read by something. §6.5 says fetch_job_log backs "failure
// alerts for the daily/quarterly jobs"; it has been written after every run since the
// daily job was built and queried by nothing at all -- the evidence recorded, nobody
// told. Half a silent-failure gap is still a silent-failure gap.
console.log("\n  recent jobs");
try {
  const { data: jobs, error } = await db.from("fetch_job_log")
    .select("job_type,status,message,finished_at")
    .order("finished_at", { ascending: false }).limit(5);
  if (error) throw new Error(error.message);
  if (!jobs?.length) {
    console.log("    no runs recorded yet");
  } else {
    for (const j of jobs) {
      const when = (j.finished_at ?? "").slice(0, 16).replace("T", " ");
      const mark = j.status === "success" ? "ok  " : "FAIL";
      console.log(`    ${mark} ${when}  ${j.job_type}  ${(j.message ?? "").slice(0, 70)}`);
    }
    // A log that shows a failure and returns zero is the thing this replaces.
    const lastFailed = jobs[0].status !== "success";
    if (lastFailed) console.log("    ^ the most recent run did not succeed");
  }
} catch (e) {
  console.log(`    unavailable: ${e.message}`);
}

// Byte sizes, if the helper function is installed. Optional on purpose: the report
// must still work on a database where nobody has run the migration yet.
let usedMb = null;
console.log("\n  size");
const { data: sizes, error: sizeErr } = await db.rpc("meridian_capacity");
if (sizeErr) {
  console.log(`    byte sizes unavailable (${sizeErr.message.slice(0, 60)})`);
  console.log("    install supabase-migration-005-capacity.sql to enable them");
} else if (Array.isArray(sizes)) {
  for (const row of sizes) {
    console.log(`    ${String(row.object).padEnd(44)} ${String(row.size_mb).padStart(8)} MB`);
    if (row.object === "DATABASE TOTAL") usedMb = Number(row.size_mb);
  }
}

// Indexes that duplicate each other. prices_daily carried two btrees over the same
// two columns for the life of the project -- 75.9MB of a 500MB tier, found twice by a
// person reading a size listing, which is the wrong way to find it.
const { data: dupes, error: dupErr } = await db.rpc("meridian_redundant_indexes");
if (!dupErr && Array.isArray(dupes) && dupes.length) {
  console.log("\n  redundant indexes");
  for (const d of dupes) {
    console.log(`    ${d.table_name}: ${(d.indexes || []).join(" + ")}`);
    console.log(`      ${d.total_mb} MB total, ${d.reclaimable_mb} MB reclaimable by dropping all but one`);
  }
  console.log("    (which to keep is yours to pick -- one usually backs a constraint)");
}

// ---- the part that makes this a check rather than a printout -----------------
//
// A percentage alone would not have caught this. On day one prices_daily was 368MB of
// 500MB -- 73.6% -- which passes any sane threshold and says nothing about the fact
// that a job was about to append to it every night for years. What was needed was not
// a gauge but a DATE: at ~2,240 bars a night and ~106 bytes a row, 368MB reaches the
// ceiling in about fourteen months. That is a sentence someone can act on in January
// rather than discover in September.
const ROWS_PER_NIGHT = 2240;

// Bytes per row is MEASURED, not assumed, because assuming it gets the one case that
// matters wrong. A trimmed table with one index costs ~106 bytes a row; the table as
// it stood on day one, carrying a redundant index and a primary key on a column
// nothing read, cost ~161. Using the tidy figure would have projected nineteen months
// of headroom where the truth was thirteen -- reassurance instead of a warning, which
// is worse than no number at all.
function mbPerYear(usedMb, rows) {
  if (!rows) return null;
  const bytesPerRow = (usedMb * 1048576) / rows;
  return (ROWS_PER_NIGHT * 365 * bytesPerRow) / 1048576;
}

function projection(currentMb, perYear, rows) {
  const headroom = LIMIT_MB - currentMb;
  if (headroom <= 0) return "  already over the limit";
  if (!perYear) return "  growth rate unknown (no row count)";
  const years = headroom / perYear;
  const when = new Date(Date.now() + years * 365 * 86400_000).toISOString().slice(0, 10);
  const months = years * 12;
  const bytesPerRow = (currentMb * 1048576) / rows;
  return `  ${bytesPerRow.toFixed(0)} bytes/row, growing ~${perYear.toFixed(0)} MB/year`
       + ` — reaches ${LIMIT_MB} MB around ${when}`
       + ` (${months < 24 ? `${months.toFixed(0)} months` : `${years.toFixed(1)} years`})`;
}

console.log("");
if (usedMb != null) {
  const pct = (usedMb / LIMIT_MB) * 100;
  console.log(`  ${usedMb} MB of ${LIMIT_MB} MB — ${pct.toFixed(1)}%`);
  const perYear = mbPerYear(usedMb, prices);
  console.log(projection(usedMb, perYear, prices));
  // Two levels on purpose. Failing the build at 80% is right, but a project that
  // reaches the ceiling in under two years needs saying out loud long before that.
  const years = perYear ? (LIMIT_MB - usedMb) / perYear : Infinity;
  if (pct < WARN_AT && years < 2) {
    console.log(`\n::warning::On the current trajectory this database runs out inside`
      + ` ${(years * 12).toFixed(0)} months. Trim the retention window before it does --`
      + ` once the project goes read-only, DELETE and VACUUM FULL both stop working.`);
  }
  if (pct >= WARN_AT) {
    console.error(`\n::error::Database at ${pct.toFixed(1)}% of the ${LIMIT_MB}MB limit.`);
    console.error("Past this the project goes read-only, and once it does, DELETE and");
    console.error("VACUUM FULL both fail for want of the very space you are trying to");
    console.error("reclaim. Trim now, while trimming is still possible:");
    console.error("  Actions -> maintenance -> reload-prices with a later --since date.");
    process.exit(1);
  }
} else if (prices != null) {
  // No byte sizes? Then judge by the thing that drives them. ~106 bytes a row,
  // measured on the real table with one index.
  const estMb = Math.round((prices * 106) / 1024 / 1024);
  const pct = (estMb / LIMIT_MB) * 100;
  console.log(`  prices_daily ~${estMb} MB estimated — roughly ${pct.toFixed(0)}% of the ${LIMIT_MB} MB limit`);
  if (pct >= WARN_AT) {
    console.error(`\n::error::prices_daily alone is near the ${LIMIT_MB}MB limit. Trim it.`);
    process.exit(1);
  }
}
console.log("--------------------------------------------------------------\n");
