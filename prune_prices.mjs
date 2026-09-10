/**
 * Delete price history older than the retention window.
 *
 * The database went read-only on 2026-09-10 because nothing ever deleted anything.
 * prices_daily held five years because that is what the backfill produced; production
 * reads an 800-day trailing window and has never read a bar older than that. Half the
 * table had never been touched by anything, and it was most of a 500MB budget.
 *
 * A capacity gauge would only have told you the date you were going to hit the wall.
 * This is what stops there being a wall: run nightly, it removes the single day that
 * just aged out -- a couple of thousand rows -- and the table stays flat forever
 * instead of growing ~87MB a year.
 *
 * RETENTION_DAYS is deliberately well above compute's 800-day window. The gap is the
 * margin: 800 CALENDAR days is only ~550 trading days, and the breadth series alone is
 * 500 trading days long. Trimming to the window the code reads would leave nothing
 * spare for a long weekend, a holiday cluster, or a job that misses a few nights.
 *
 * Nothing here is destructive in the way it looks: every bar ever fetched is in the
 * committed CSVs, and `load_supabase.mjs --since` can put any window back.
 *
 * Usage:  node prune_prices.mjs [--days N] [--dry-run]
 */

// Arguments are validated BEFORE anything needs credentials or a network. A bad
// --days should say so, not fail three layers down in a module import.
const DRY = process.argv.includes("--dry-run");
const dIdx = process.argv.indexOf("--days");
const RETENTION_DAYS = dIdx >= 0 ? Number(process.argv[dIdx + 1]) : 1100;   // ~3 years

// A floor, not a suggestion. compute_and_publish reads DB_WINDOW_DAYS = 800; pruning
// below that would silently starve the model -- MA200, the 252-day RS lookback and the
// 500-day breadth series would all quietly shorten, and nothing downstream would
// complain. It would just compute different numbers.
const FLOOR_DAYS = 900;
if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS < FLOOR_DAYS) {
  console.error(`--days must be at least ${FLOOR_DAYS}: compute reads an 800-day window,`);
  console.error("and pruning into it changes the model's answers without any error.");
  process.exit(1);
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}
const { createClient } = await import("@supabase/supabase-js");
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString().slice(0, 10);
console.log(`retention: ${RETENTION_DAYS} days — deleting bars before ${cutoff}${DRY ? " (DRY RUN)" : ""}`);

const { count: before, error: cErr } = await db
  .from("prices_daily").select("*", { count: "exact", head: true });
if (cErr) { console.error(`counting prices_daily: ${cErr.message}`); process.exit(1); }

const { count: stale, error: sErr } = await db
  .from("prices_daily").select("*", { count: "exact", head: true }).lt("trade_date", cutoff);
if (sErr) { console.error(`counting stale rows: ${sErr.message}`); process.exit(1); }

console.log(`  ${before?.toLocaleString() ?? "?"} rows held, ${stale?.toLocaleString() ?? "?"} older than the cutoff`);

if (!stale) { console.log("  nothing to prune"); process.exit(0); }

// Refuse to delete most of the table by accident. A nightly prune removes one day;
// anything resembling a bulk deletion means --days was wrong or the table was loaded
// with a different window, and it should be a decision, not a side effect.
if (before && stale > before * 0.5) {
  console.error(`\\nThat would delete ${((stale / before) * 100).toFixed(0)}% of the table.`);
  console.error("A nightly prune removes about a day. Check --days before re-running.");
  process.exit(1);
}

if (DRY) { console.log("  dry run — nothing deleted"); process.exit(0); }

// Deleted in date slices rather than one statement. One big DELETE writes one big
// transaction, and on a database that is already tight the WAL for it is exactly the
// space you do not have -- the failure mode that made VACUUM FULL impossible on the
// 10th. Slices keep each transaction small enough to commit and recycle.
let removed = 0;
for (;;) {
  const { data: oldest, error: oErr } = await db
    .from("prices_daily").select("trade_date").lt("trade_date", cutoff)
    .order("trade_date").limit(1);
  if (oErr) { console.error(`finding oldest: ${oErr.message}`); process.exit(1); }
  if (!oldest?.length) break;

  const slice = oldest[0].trade_date;
  const { error: dErr2 } = await db.from("prices_daily").delete().eq("trade_date", slice);
  if (dErr2) { console.error(`deleting ${slice}: ${dErr2.message}`); process.exit(1); }
  removed++;
  if (removed % 25 === 0) console.log(`    pruned through ${slice}`);
}

const { count: after } = await db.from("prices_daily").select("*", { count: "exact", head: true });
console.log(`  pruned ${removed} trading day(s); ${after?.toLocaleString() ?? "?"} rows remain`);

// Space freed by DELETE is reusable, not returned -- so the file does not shrink and
// the size reported by Supabase will not fall. That is fine and expected: the point
// is that tomorrow's rows land in today's freed pages instead of extending the file.
// Autovacuum handles the reclaim; a nightly prune of one day never outruns it.
console.log("  (space is reused in place; the file size stays flat rather than shrinking)");
