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
import { collectHealth, EGRESS_LIMIT_MB, egressPerMonthMb, evaluateHealth, mbPerYear,
         RUNS_PER_MONTH, usedMbOf } from "./meridian-health.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, egressSuffix, meterLine, meterTotalBytes, readEgress } from "./meridian-io.js";

const db = await connect();

// Supabase's Free plan quota. The number that was written down and never checked.
const BASE = dirname(fileURLToPath(import.meta.url));
const LIMIT_MB = Number(process.env.DB_LIMIT_MB ?? 500);
const WARN_AT = Number(process.env.DB_WARN_PCT ?? 80);

const TABLES = ["universe", "prices_daily", "fundamentals_annual", "technicals_daily",
                "sectoral_technicals_daily", "fundamentals_scored",
                "golden_breakout_candidates", "market_breadth_daily", "fetch_job_log"];

console.log("\n--- meridian database report ---------------------------------");
console.log(new Date().toISOString());

// One pass, shared with the watchdog. The report and the alert asked the same four
// questions of the same database in two implementations until 2026-09-16; §11a is
// about what happens next when they are allowed to stay that way.
const facts = await collectHealth(db, { tables: TABLES });

let prices = null;
console.log("\n  rows");
for (const t of TABLES) {
  const r = facts.rowCounts[t] ?? {};
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
const classes = Object.entries(facts.freshness).sort();
if (!classes.length) console.log("    unavailable");
for (const [c, max] of classes) {
  const age = Math.round((Date.now() - Date.parse(max)) / 86400_000);
  console.log(`    ${c.padEnd(12)} as of ${max}  (${age} day${age === 1 ? "" : "s"} old)`);
}

// The job log, at last read by something. §6.5 says fetch_job_log backs "failure
// alerts for the daily/quarterly jobs"; it has been written after every run since the
// daily job was built and queried by nothing at all -- the evidence recorded, nobody
// told. Half a silent-failure gap is still a silent-failure gap.
console.log("\n  recent jobs");
if (!facts.jobs.length) {
  console.log("    no runs recorded yet");
} else {
  for (const j of facts.jobs) {
    const when = (j.finished_at ?? "").slice(0, 16).replace("T", " ");
    const mark = j.status === "success" ? "ok  " : "FAIL";
    console.log(`    ${mark} ${when}  ${j.job_type}  ${(j.message ?? "").slice(0, 70)}`);
  }
  // A log that shows a failure and returns zero is the thing this replaces.
  if (facts.jobs[0].status !== "success") console.log("    ^ the most recent run did not succeed");
}

// Byte sizes, if the helper function is installed. Optional on purpose: the report
// must still work on a database where nobody has run the migration yet.
console.log("\n  size");
const usedMb = usedMbOf(facts.sizes);
if (!facts.sizes) {
  console.log("    byte sizes unavailable");
  console.log("    install supabase-migration-005-capacity.sql to enable them");
} else {
  for (const row of facts.sizes) {
    console.log(`    ${String(row.object).padEnd(44)} ${String(row.size_mb).padStart(8)} MB`);
  }
}

// Indexes that duplicate each other. prices_daily carried two btrees over the same
// two columns for the life of the project -- 75.9MB of a 500MB tier, found twice by a
// person reading a size listing, which is the wrong way to find it.
if (facts.dupes.length) {
  console.log("\n  redundant indexes");
  for (const d of facts.dupes) {
    console.log(`    ${d.table_name}: ${(d.indexes || []).join(" + ")}`);
    console.log(`      ${d.total_mb} MB total, ${d.reclaimable_mb} MB reclaimable by dropping all but one`);
  }
  console.log("    (which to keep is yours to pick -- one usually backs a constraint)");
}

// Egress: the last quota that had a number in prose and no gauge (§6.5). Measured
// from what the runs actually transferred, not estimated from row counts.
//
// THIS STEP RUNS LAST, which is why the pipeline total is written here. Every step
// appends its meter to a workspace file as it finishes; this one sums them, adds its
// own, and persists the figure so the watchdog and tomorrow's report can see it. The
// first metered run tagged only the fetch and therefore reported 2% of the allowance
// against a real 118% -- a gauge reading the wrong instrument.
const steps = readEgress(BASE);
if (steps.length) {
  console.log("\n  this run");
  for (const st of steps) {
    console.log(`    ${st.step.padEnd(10)} ${(st.bytes / 1048576).toFixed(1).padStart(7)} MB down`
              + ` in ${st.requests.toLocaleString()} requests`);
  }
  const total = steps.reduce((a, st) => a + st.bytes, 0) + meterTotalBytes(db.meter);
  console.log(`    ${"TOTAL".padEnd(10)} ${(total / 1048576).toFixed(1).padStart(7)} MB`);
  const perMonth = egressPerMonthMb(total);
  console.log(`    ~${(perMonth / 1024).toFixed(2)} GB/month of ${(EGRESS_LIMIT_MB / 1024).toFixed(0)} GB`
            + ` — ${((perMonth / EGRESS_LIMIT_MB) * 100).toFixed(0)}%`);
  // Persisted as its own job-log row. daily_fetch's row describes one step and is
  // deliberately untagged; this one describes the night.
  const { error: logErr } = await db.from("fetch_job_log").insert({
    job_type: "daily", status: "success",
    message: `pipeline ${steps.map((st) => st.step).join("+")} `
           + `${egressSuffix({ ...db.meter, wireBytes: total, decodedBytes: 0,
                               requests: steps.reduce((a, st) => a + st.requests, 0) + db.meter.requests })}`,
    finished_at: new Date().toISOString(),
  });
  if (logErr) console.log(`    (could not record the total: ${logErr.message})`);
}

console.log("\n  egress, recent runs");
const metered = facts.jobs.filter((j) => j.egress?.bytes > 0);
if (!metered.length) {
  console.log("    not measured yet — runs before 2026-09-17 carry no egress tag");
} else {
  for (const j of metered) {
    console.log(`    ${(j.finished_at ?? "").slice(0, 16).replace("T", " ")}`
              + ` ${(j.egress.bytes / 1048576).toFixed(0).padStart(5)} MB`
              + ` in ${j.egress.requests.toLocaleString()} requests`);
  }
  const worst = Math.max(...metered.map((j) => j.egress.bytes));
  const perMonth = egressPerMonthMb(worst);
  console.log(`    worst run ${(worst / 1048576).toFixed(0)} MB`
            + ` x ${RUNS_PER_MONTH} runs = ~${(perMonth / 1024).toFixed(2)} GB/month`
            + ` of ${(EGRESS_LIMIT_MB / 1024).toFixed(0)} GB`
            + ` — ${((perMonth / EGRESS_LIMIT_MB) * 100).toFixed(0)}%`);
}

// The same verdict the watchdog reaches, from the same facts and the same function.
// Printed here rather than re-derived: if these two ever disagree about whether
// Meridian is healthy, one of them is lying, and sharing evaluateHealth is what makes
// that impossible rather than merely unlikely.
const findings = evaluateHealth(facts, { limitMb: LIMIT_MB, warnPct: WARN_AT,
                                         staleDays: Number(process.env.ALERT_STALE_DAYS ?? 4) });
console.log("\n  health");
if (!findings.length) console.log("    nothing to report");
for (const f of findings) console.log(`    [${f.level}] ${f.code}: ${f.message.split("\n")[0]}`);

// THIS STEP RUNS LAST, WHICH IS WHY THE RUN FAILS HERE RATHER THAN EARLIER.
//
// daily_fetch now tolerates a partial fetch failure so that a transient outage on a
// tenth of the universe does not cost the other nine tenths their day (see
// FAILURE_TOLERANCE there). But tolerating it must not mean hiding it: it writes
// status "failure" to fetch_job_log, evaluateHealth turns that into an error finding,
// and this turns the finding into a red run -- after the screens, the workbook and
// the git mirror have all been published.
//
// Publish first, then fail visibly. A green run with 252 instruments silently stuck
// on Friday is the exact shape of defect this project keeps finding.
const errors = findings.filter((f) => f.level === "error");
if (errors.length) {
  console.error("");
  for (const f of errors) console.error(`::error::${f.message.split("\n")[0]}`);
}

// ---- the part that makes this a check rather than a printout -----------------
//
// A percentage alone would not have caught this. On day one prices_daily was 368MB of
// 500MB -- 73.6% -- which passes any sane threshold and says nothing about the fact
// that a job was about to append to it every night for years. What was needed was not
// a gauge but a DATE: at ~2,240 bars a night and ~106 bytes a row, 368MB reaches the
// ceiling in about fourteen months. That is a sentence someone can act on in January
// rather than discover in September.
// Bytes per row is MEASURED, not assumed (see mbPerYear in meridian-health.js),
// because assuming it gets the one case that matters wrong. A trimmed table with one
// index costs ~106 bytes a row; the table as it stood on day one, carrying a redundant
// index and a primary key on a column nothing read, cost ~161. Using the tidy figure
// would have projected nineteen months of headroom where the truth was thirteen --
// reassurance instead of a warning, which is worse than no number at all.

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
console.log(`  this report: ${meterLine(db.meter)}`);
// LAST LINE OF THE LAST STEP, and the position is the point twice over. Everything
// downstream of the fetch has already published by now, so a non-zero exit reports
// the night without costing it -- and it comes after the egress line rather than
// before, because anything placed after a process.exit() simply never runs. That
// error has been made once already in this codebase, in check-production.mjs, where
// two checks sat below an exit and read like coverage while being unable to execute.
if (errors.length) process.exit(1);
