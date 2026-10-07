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
  const facts = { rowCounts: {}, freshness: {}, jobs: [], sizes: null, dupes: [],
                  placeholders: null, errors: [] };

  for (const t of tables) {
    const { count, error } = await db.from(t).select("*", { count: "exact", head: true });
    // A head-count can come back null. Reading that as a number throws, and a health
    // check that crashes on the way to reporting a problem is worse than none.
    facts.rowCounts[t] = error ? { error: error.message } : { count: count ?? null };
  }

  let universe = [];
  try {
    const { readAll } = await import("./meridian-io.js");
    universe = await readAll(db, "universe", "id,asset_class", { orderBy: ["id"] });
    const tech = await readAll(db, "technicals_daily", "universe_id,as_of_date",
                               { orderBy: ["universe_id"] });
    const classOf = Object.fromEntries(universe.map((u) => [String(u.id), u.asset_class]));
    for (const t of tech) {
      const c = classOf[String(t.universe_id)] ?? "unknown";
      if (!facts.freshness[c] || t.as_of_date > facts.freshness[c]) facts.freshness[c] = t.as_of_date;
    }
  } catch (e) { facts.errors.push(`freshness: ${e.message}`); }

  try {
    // TWELVE, not five. Each night writes two rows -- the sweep and the pipeline total
    // -- so five rows is barely two nights, and the recurring-shortfall rule below has
    // to see three consecutive SWEEPS to say anything. db_report still prints five.
    const { data, error } = await db.from("fetch_job_log")
      .select("job_type,status,message,finished_at")
      .order("finished_at", { ascending: false }).limit(12);
    if (error) throw new Error(error.message);
    const { parseEgress, parseFailed, parseTolerated } = await import("./meridian-io.js");
    facts.jobs = (data ?? []).map((j) => ({
      ...j, egress: parseEgress(j.message), tolerated: parseTolerated(j.message),
      failed: parseFailed(j.message) }));
  } catch (e) { facts.errors.push(`fetch_job_log: ${e.message}`); }

  // Byte sizes need the optional helper (supabase-migration-005-capacity.sql). Their
  // absence is not a failure: without them you still get row counts, which are what
  // actually predict trouble.
  const { data: sizes, error: sizeErr } = await db.rpc("meridian_capacity");
  if (sizeErr) facts.errors.push(`capacity rpc: ${sizeErr.message.slice(0, 60)}`);
  else if (Array.isArray(sizes)) facts.sizes = sizes;

  const { data: dupes, error: dupErr } = await db.rpc("meridian_redundant_indexes");
  if (!dupErr && Array.isArray(dupes)) facts.dupes = dupes;

  // HOW MANY HOLIDAY PLACEHOLDER BARS ARE STORED (§11m). Yahoo's placeholder for a
  // closed exchange has no volume and no range; the ingestion fix drops them, but the
  // sweep upserts and never deletes, so the ones already written stay until retention
  // ages them out. Nobody knew the number, and the choice between a one-off delete and
  // waiting cannot be made without it.
  //
  // A VOLUME-ONLY COUNT IS EXACT HERE, and that is measured rather than assumed: of the
  // 171,684 equity bars in the git mirror, every single one lacking volume is also flat
  // -- 5,784 of them -- and not one no-volume bar has a range. (2,765 bars are flat WITH
  // volume: real single-trade days on illiquid stocks, which are not placeholders and
  // which a range-only test would have deleted.) So for equities "no volume" and
  // "placeholder" are the same set, and PostgREST cannot compare two columns anyway.
  //
  // Equities only. Yahoo reports no volume for currency pairs at all, and indices and
  // commodities are mixed, so the same count across every class would be meaningless.
  // EXCLUDE the non-equity classes rather than selecting the equity one, which is what
  // makes this a plain filter instead of a join. The first attempt embedded
  // `universe!inner(asset_class)` and filtered on it, and it failed in production with
  // an EMPTY error message -- because `head: true` issues a HEAD request, a HEAD
  // response carries no body, and PostgREST puts the reason in the body. The query
  // blinded its own diagnostic. There are only ~100 non-equity instruments against
  // ~2,138 equities, so `universe_id=not.in.(...)` is a short URL, needs no embed, and
  // an error comes back with something written on it.
  //
  // One request, not two: `count: "exact"` with the newest row ordered first answers
  // both halves at once.
  const nonEquity = nonEquityIds(universe);
  if (!universe.length) {
    facts.errors.push("placeholder bars: the universe did not load, so equities "
                    + "could not be told apart from currencies");
  } else {
    try {
      let q = db.from("prices_daily").select("trade_date", { count: "exact" })
                .is("volume", null);
      // `not.in.()` with an empty list is not valid; with no non-equity rows there is
      // also nothing to exclude.
      if (nonEquity.length) q = q.not("universe_id", "in", `(${nonEquity.join(",")})`);
      const { data, count, error } = await q
        .order("trade_date", { ascending: false }).limit(1);
      if (error) throw new Error(error.message || JSON.stringify(error).slice(0, 120));
      facts.placeholders = { count: count ?? 0, newest: data?.[0]?.trade_date ?? null };
    } catch (e) {
      // Reported as unreadable, which is a warning. A measurement must not be able to
      // fail a night on its own.
      facts.errors.push(`placeholder bars: ${(e.message || String(e)).slice(0, 120)}`);
    }
  }

  return facts;
}

/**
 * The instruments to EXCLUDE from the placeholder count, which is every class but
 * equity. Exported because it is the one part of that query with a decision in it: a
 * currency pair legitimately reports no volume on every bar it has ever had, so
 * counting one as a placeholder would bury the equity number under ~30,000 of them.
 */
export const nonEquityIds = (universe) =>
  (universe ?? []).filter((u) => u.asset_class !== "equity").map((u) => u.id);

export function usedMbOf(sizes) {
  if (!Array.isArray(sizes)) return null;
  const row = sizes.find((r) => r.object === "DATABASE TOTAL");
  return row ? Number(row.size_mb) : null;
}

export const ROWS_PER_NIGHT = 2240;

/**
 * Supabase's free tier allows 5GB of egress a month. §6.5 wrote that down in prose and
 * nothing ever compared anything to it -- the same shape as the 500MB storage limit,
 * which stayed prose until the day the database went read-only (§11b).
 *
 * TRADING DAYS, not calendar days: the pipeline runs weekdays only, and 22 is the
 * month's working average. Projecting from 30 would overstate the bill by a third and
 * make a real problem look like a worse one, which is its own kind of wrong number.
 */
export const EGRESS_LIMIT_MB = 5120;
export const RUNS_PER_MONTH = 22;

/** Monthly egress implied by one run's measured bytes. */
export function egressPerMonthMb(bytesPerRun) {
  if (!bytesPerRun) return null;
  return (bytesPerRun * RUNS_PER_MONTH) / 1048576;
}

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
    // A run that missed some instruments but stayed under the tolerance and published
    // anyway is not a reason to wake anyone: its watermarks did not move, so the next
    // sweep retries exactly those instruments. It is still reported, every night, as a
    // warning. Only a run that REFUSED to publish is an error.
    //
    // UNLESS IT KEEPS HAPPENING, which is the hole the warning level opened (§11n). A
    // shortfall that retries nightly and never heals is not transient, and the whole
    // argument for tolerating it -- "tomorrow's sweep picks them up" -- is false by the
    // third night. That is a ticker to re-resolve or an instrument to deactivate, and
    // it has a remedy, which is what makes a red run here fair rather than camouflage:
    // it clears the moment a sweep comes back clean.
    const streak = toleratedStreak(facts.jobs);
    const stuck = streak >= RECURRING_SHORTFALL_NIGHTS;
    const tolerated = Boolean(last.tolerated);
    if (tolerated && stuck) {
      const { symbols, recorded, nights } = recurringSymbols(facts.jobs, streak);
      const blind = nights - recorded;
      let verdict;
      if (symbols.length) {
        verdict = `Failing on all ${recorded} night(s) that recorded symbols: ${symbols.join(", ")}. `
                + "Re-resolve the ticker (resolve_tickers.mjs) or deactivate the instrument.";
      } else if (!recorded) {
        verdict = "No night recorded which instruments missed, so the symbols are only in each "
                + "run's fetch-step log.";
      } else if (!blind) {
        verdict = "A different set each night, so look for a shared cause rather than a ticker.";
      } else {
        verdict = `No instrument failed on all ${recorded} night(s) that recorded symbols, but `
                + `${blind} recorded none, so a single stuck instrument is not ruled out.`;
      }
      add("error", "job-failed",
          `${streak} sweeps in a row have published with instruments missing, so they are `
          + `not healing: ${last.message ?? "no message"}. ${verdict}`);
    } else {
      add(tolerated ? "warning" : "error", "job-failed",
          `The most recent ${last.job_type} run ${tolerated ? "published with instruments missing" : "did not succeed"}: `
          + `${last.message ?? "no message"}`
          + (tolerated && streak > 1 ? ` (${streak} nights running)` : ""));
    }
  }

  // Holiday placeholder bars already stored (§11m). The count is a standing to-do and
  // not a nightly alarm -- db_report prints it either way. What IS an alarm is a
  // placeholder dated after the ingestion fix shipped, because that means the fix is
  // not holding. Deep re-pulls rewrite old history, and those bars get dropped on the
  // way in now, so nothing at any date should arrive as a placeholder again.
  const ph = facts.placeholders;
  if (ph?.newest && ph.newest > PLACEHOLDER_FIX_DATE) {
    add("error", "placeholders",
        `${ph.count.toLocaleString()} stored equity bars have no volume and no range, and the `
        + `newest is ${ph.newest} — after the ${PLACEHOLDER_FIX_DATE} fix that should have `
        + "stopped them being written. The drop in barsOf is not holding.");
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

  // Egress, measured from what the last runs actually transferred rather than
  // estimated from row counts. The pipeline is the dominant consumer by a wide margin;
  // browser traffic from at most 100 invited users reading ~6,700 published rows a
  // session is small beside a nightly job that reads an 800-day window twice.
  const runs = (facts.jobs ?? []).map((j) => j.egress).filter((e) => e && e.bytes > 0);
  if (runs.length) {
    const worst = Math.max(...runs.map((r) => r.bytes));
    const perMonth = egressPerMonthMb(worst);
    const pct = (perMonth / EGRESS_LIMIT_MB) * 100;
    const shape = `${(worst / 1048576).toFixed(0)} MB per run x ${RUNS_PER_MONTH} runs `
                + `= ~${(perMonth / 1024).toFixed(2)} GB/month of ${(EGRESS_LIMIT_MB / 1024).toFixed(0)} GB`;
    if (pct >= 100) {
      add("error", "egress-over",
          `Egress is over the free-tier allowance: ${shape} (${pct.toFixed(0)}%). `
        + "Past it Supabase throttles or bills; the nightly job reads the 800-day "
        + "window twice, which is where almost all of it goes.");
    } else if (pct >= warnPct) {
      add("warning", "egress",
          `Egress is at ${pct.toFixed(0)}% of the free-tier allowance: ${shape}.`);
    }
  }

  for (const e of facts.errors ?? []) {
    // Something the collector could not read is itself a finding: a check that cannot
    // run is not a check that passed.
    add("warning", "unreadable", `Could not read: ${e}`);
  }

  return findings;
}

/**
 * Sweeps only, newest first. A sweep row NEVER carries an egress tag and the
 * pipeline-total row written by the capacity check ALWAYS does, which is the invariant
 * daily_fetch documents at its job-log insert and the only thing that separates the two
 * kinds of row. Counting without it would read the clean pipeline row between two bad
 * sweeps as a good night.
 */
const dailySweeps = (jobs) =>
  (jobs ?? []).filter((j) => j.job_type === "daily" && j.egress == null);

export const RECURRING_SHORTFALL_NIGHTS = 3;

/** How many of the most recent sweeps, in a row, published with instruments missing. */
export function toleratedStreak(jobs) {
  let n = 0;
  for (const j of dailySweeps(jobs)) {
    if (j.status !== "success" && j.tolerated) n++;
    else break;
  }
  return n;
}

/**
 * The instruments that failed in EVERY night of the streak — the ones not healing.
 *
 * Intersected over the rows that actually RECORDED symbols, and `recorded` says how
 * many that was, because "no symbols in common" and "no symbols written down" are
 * different facts and the first version returned the same empty array for both. On
 * 2026-10-07 the streak's oldest row predated the `failed=` tag, so the intersection
 * collapsed to nothing and the finding announced "a different set each night" while
 * ASHIKA sat in the other two rows and in the message it was printing (§11p). A
 * finding may say it cannot tell; it may not guess and sound certain.
 */
export function recurringSymbols(jobs, streak) {
  const rows = dailySweeps(jobs).slice(0, streak);
  const withSymbols = rows.filter((r) => (r.failed ?? []).length > 0);
  if (!withSymbols.length) return { symbols: [], recorded: 0, nights: rows.length };
  let common = new Set(withSymbols[0].failed);
  for (const r of withSymbols.slice(1)) {
    const here = new Set(r.failed);
    common = new Set([...common].filter((x) => here.has(x)));
  }
  return { symbols: [...common].sort(), recorded: withSymbols.length, nights: rows.length };
}

/** The day the placeholder-bar drop shipped (§11m). Nothing newer should be one. */
export const PLACEHOLDER_FIX_DATE = "2026-10-06";

export const worstLevel = (findings) =>
  (findings.some((f) => f.level === "error") ? "error"
    : findings.length ? "warning" : "ok");
