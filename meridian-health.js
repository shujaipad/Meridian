/**
 * Is the pipeline actually working? Gathered as facts, judged as findings, so the
 * same answer can be printed by db_report.mjs and emailed by notify.mjs without two
 * implementations drifting apart -- which is §11a's whole subject.
 *
 * The distinction that matters here: COLLECT touches the database and does not judge;
 * EVALUATE judges and touches nothing. Only the second half needs testing, and it can
 * be tested exhaustively without a network, a database or a secret.
 *
 * Every check below exists because its absence already cost something. §6.5 named
 * fetch_job_log as the backing for "failure alerts" and nothing ever read it. §6.5
 * recorded "500MB storage" in prose and the database filled up. And on 2026-09-16 the
 * nightly job had failed four nights running, which was discovered by a person going
 * and looking.
 */

/** Everything the checks below need, in one pass. Returns facts, never verdicts. */
export async function collectHealth(db, { tables = [] } = {}) {
  const facts = { rowCounts: {}, freshness: {}, jobs: [], sizes: null, dupes: [], errors: [] };

  for (const t of tables) {
    const { count, error } = await db.from(t).select("*", { count: "exact", head: true });
    // A head-count can come back null. Reading that as a number throws, and a health
    // check that crashes on the way to reporting a problem is worse than none.
    facts.rowCounts[t] = error ? { error: error.message } : { count: count ?? null };
  }

  try {
    const { readAll } = await import("./meridian-io.js");
    const universe = await readAll(db, "universe", "id,asset_class", { orderBy: ["id"] });
    const tech = await readAll(db, "technicals_daily", "universe_id,as_of_date",
                               { orderBy: ["universe_id"] });
    const classOf = Object.fromEntries(universe.map((u) => [String(u.id), u.asset_class]));
    for (const t of tech) {
      const c = classOf[String(t.universe_id)] ?? "unknown";
      if (!facts.freshness[c] || t.as_of_date > facts.freshness[c]) facts.freshness[c] = t.as_of_date;
    }
  } catch (e) { facts.errors.push(`freshness: ${e.message}`); }

  try {
    const { data, error } = await db.from("fetch_job_log")
      .select("job_type,status,message,finished_at")
      .order("finished_at", { ascending: false }).limit(5);
    if (error) throw new Error(error.message);
    facts.jobs = data ?? [];
  } catch (e) { facts.errors.push(`fetch_job_log: ${e.message}`); }

  // Byte sizes need the optional helper (supabase-migration-005-capacity.sql). Their
  // absence is not a failure: without them you still get row counts, which are what
  // actually predict trouble.
  const { data: sizes, error: sizeErr } = await db.rpc("meridian_capacity");
  if (sizeErr) facts.errors.push(`capacity rpc: ${sizeErr.message.slice(0, 60)}`);
  else if (Array.isArray(sizes)) facts.sizes = sizes;

  const { data: dupes, error: dupErr } = await db.rpc("meridian_redundant_indexes");
  if (!dupErr && Array.isArray(dupes)) facts.dupes = dupes;

  return facts;
}

export function usedMbOf(sizes) {
  if (!Array.isArray(sizes)) return null;
  const row = sizes.find((r) => r.object === "DATABASE TOTAL");
  return row ? Number(row.size_mb) : null;
}

export const ROWS_PER_NIGHT = 2240;

/** Bytes per row is MEASURED, never assumed — see db_report.mjs for why that matters. */
export function mbPerYear(usedMb, rows) {
  if (!rows || usedMb == null) return null;
  return (ROWS_PER_NIGHT * 365 * ((usedMb * 1048576) / rows)) / 1048576;
}

/**
 * Facts in, findings out. `level` is "error" or "warning", and only errors are worth
 * waking someone for.
 *
 * STALENESS IS THE PRIMARY CHECK, and deliberately so. A failure hook wired into the
 * nightly job can only fire when the job runs and fails; it says nothing when the job
 * does not run at all -- a disabled workflow, a cron GitHub skipped, a repository gone
 * quiet for sixty days. Asking "how old is the data on the screen" catches every one
 * of those, and catches "it ran, succeeded, and published nothing" as well.
 *
 * The threshold is 4 days by default, which tolerates a weekend plus a holiday. An
 * Indian holiday cluster can occasionally exceed that and produce one false alert.
 * That is the right way round: a spurious mail is a minute wasted, and a silent
 * pipeline was four days unnoticed.
 */
export function evaluateHealth(facts, {
  limitMb = 500, warnPct = 80, staleDays = 4, now = Date.now(), skewDays = 2,
} = {}) {
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });

  const ageOf = (date) => Math.floor((now - Date.parse(`${date}T00:00:00Z`)) / 86400_000);

  const classes = Object.entries(facts.freshness ?? {});
  if (!classes.length) {
    add("error", "no-screens",
        "technicals_daily is empty or unreadable — nothing is published at all.");
  } else {
    const newest = classes.reduce((m, [, d]) => (d > m ? d : m), "");
    const age = ageOf(newest);
    if (age > staleDays) {
      add("error", "stale",
          `Published screens are ${age} days old (newest ${newest}). `
        + "The nightly pipeline has not landed — it may be failing, or not running at all.");
    }
    // One class lagging the rest is invisible in a single as-of date, and is exactly
    // how five crypto instruments sat frozen years in the past without anyone noticing.
    for (const [c, d] of classes.sort()) {
      const skew = Math.floor((Date.parse(newest) - Date.parse(d)) / 86400_000);
      if (skew > skewDays) {
        add("warning", "class-skew",
            `${c} is ${skew} days behind the rest of the universe (as of ${d} vs ${newest}).`);
      }
    }
  }

  const last = (facts.jobs ?? [])[0];
  if (last && last.status !== "success") {
    add("error", "job-failed",
        `The most recent ${last.job_type} run did not succeed: ${last.message ?? "no message"}`);
  }

  const usedMb = usedMbOf(facts.sizes);
  const rows = facts.rowCounts?.prices_daily?.count ?? null;
  if (usedMb != null) {
    const pct = (usedMb / limitMb) * 100;
    if (pct >= warnPct) {
      add("error", "capacity",
          `Database at ${pct.toFixed(1)}% of the ${limitMb}MB limit (${usedMb}MB). `
        + "Past the limit the project goes read-only, and DELETE and VACUUM FULL both "
        + "stop working — trim now, while trimming is still possible.");
    } else {
      const perYear = mbPerYear(usedMb, rows);
      const years = perYear ? (limitMb - usedMb) / perYear : Infinity;
      if (years < 2) {
        add("warning", "trajectory",
            `On the current trajectory the database is full in ${(years * 12).toFixed(0)} months.`);
      }
    }
  }

  for (const e of facts.errors ?? []) {
    // Something the collector could not read is itself a finding: a check that cannot
    // run is not a check that passed.
    add("warning", "unreadable", `Could not read: ${e}`);
  }

  return findings;
}

export const worstLevel = (findings) =>
  (findings.some((f) => f.level === "error") ? "error"
    : findings.length ? "warning" : "ok");
