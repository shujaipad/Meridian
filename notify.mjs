/**
 * The alert that tells you Meridian stopped working (§6.5, §8).
 *
 * Until now nothing did. The nightly job failed on four consecutive nights and the
 * way that was discovered was a person opening the Actions tab and looking. §6.5 has
 * said since the beginning that fetch_job_log backs "failure alerts for the daily and
 * quarterly jobs"; the table was written after every run and read by nothing.
 *
 *   node notify.mjs --failure     a step just failed; say so immediately
 *   node notify.mjs --watchdog    is the data fresh? mail only if it is not
 *   node notify.mjs --dry-run     print the mail instead of sending it
 *
 * TWO MODES, because they catch different things and neither subsumes the other.
 *
 *   --failure runs from the nightly job's own `if: failure()` hook. It is fast and it
 *   names the step, but it can only fire when the job RUNS and fails. A workflow
 *   that is disabled, a cron GitHub skipped, a repository dormant for sixty days --
 *   all of those are silent, and all of them have precedent here: daily.yml sat
 *   disabled for a day because the button to re-enable it does not render on mobile.
 *
 *   --watchdog runs on its own schedule and asks the only question that cannot be
 *   dodged: how old is the data on the screen? That catches a failed run, a run that
 *   never happened, and a run that succeeded while publishing nothing.
 *
 * AN UNCONFIGURED ALERTER MUST NOT LOOK HEALTHY. With no API key this still performs
 * every check and still exits non-zero when something is wrong -- it simply cannot
 * mail you about it, and says so. The failure mode of alerting is silence, so silence
 * is never the response to a real finding.
 */
import { collectHealth, egressPerMonthMb, evaluateHealth, usedMbOf,
         worstLevel } from "./meridian-health.js";
import { connect } from "./meridian-io.js";

const DRY = process.argv.includes("--dry-run");
const MODE = process.argv.includes("--watchdog") ? "watchdog"
           : process.argv.includes("--failure") ? "failure" : null;
if (!MODE) {
  console.error("Usage: node notify.mjs (--failure | --watchdog) [--dry-run]");
  process.exit(2);
}

const {
  RESEND_API_KEY, ALERT_EMAIL,
  // The default sender is Resend's own shared address, which needs no DNS. Resend
  // restricts it, so a verified domain is still the answer for mail to anyone but the
  // account owner -- and the account owner is exactly who this writes to.
  ALERT_FROM = "Meridian <onboarding@resend.dev>",
  GITHUB_SERVER_URL = "https://github.com", GITHUB_REPOSITORY = "",
  GITHUB_RUN_ID = "", GITHUB_WORKFLOW = "", GITHUB_JOB = "",
} = process.env;

const runUrl = GITHUB_REPOSITORY && GITHUB_RUN_ID
  ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null;

async function send({ subject, text }) {
  if (DRY) {
    console.log(`--- would send ------------------------------------------------`);
    console.log(`to:      ${ALERT_EMAIL ?? "(ALERT_EMAIL unset)"}`);
    console.log(`from:    ${ALERT_FROM}`);
    console.log(`subject: ${subject}\n`);
    console.log(text);
    console.log(`---------------------------------------------------------------`);
    return true;
  }
  if (!RESEND_API_KEY || !ALERT_EMAIL) {
    console.error("::warning::Alerting is not configured, so this alert cannot be delivered.");
    console.error("Set RESEND_API_KEY and ALERT_EMAIL as repository secrets.");
    console.error(`\nThe alert that would have been sent:\n\n${subject}\n\n${text}`);
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: ALERT_FROM, to: [ALERT_EMAIL], subject, text }),
  });
  if (!res.ok) {
    // Printed in full: a bounced alert is the one failure nobody else will notice,
    // and Resend's message names the cause (unverified domain, bad key, bad address).
    console.error(`::error::Resend refused the alert: HTTP ${res.status}`);
    console.error(await res.text().catch(() => "(no body)"));
    console.error(`\nThe alert that would have been sent:\n\n${subject}\n\n${text}`);
    return false;
  }
  console.log(`alert sent to ${ALERT_EMAIL}`);
  return true;
}

// ---------------------------------------------------------------- failure mode
if (MODE === "failure") {
  const where = [GITHUB_WORKFLOW, GITHUB_JOB].filter(Boolean).join(" / ") || "the nightly pipeline";
  const text = [
    `${where} failed.`,
    "",
    runUrl ? `Run log: ${runUrl}` : "(no run URL available)",
    "",
    "Nothing downstream of the failing step ran, and no watermark advanced, so the",
    "next scheduled run retries from where this one stopped. If the screens are",
    "current the app is unaffected; if they are stale, they will say so.",
    "",
    "The maintenance workflow can be run by hand from Actions -> maintenance.",
  ].join("\n");
  const ok = await send({ subject: `Meridian: ${where} failed`, text });
  // Exits non-zero when it could not deliver. The job has already failed, so this
  // changes no conclusion -- it makes a broken alerter visible in the same place.
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- watchdog mode
const db = await connect();

const facts = await collectHealth(db, { tables: ["prices_daily", "technicals_daily"] });
const findings = evaluateHealth(facts, {
  limitMb: Number(process.env.DB_LIMIT_MB ?? 500),
  warnPct: Number(process.env.DB_WARN_PCT ?? 80),
  staleDays: Number(process.env.ALERT_STALE_DAYS ?? 4),
});
const level = worstLevel(findings);

const usedMb = usedMbOf(facts.sizes);
const state = [
  ...Object.entries(facts.freshness).sort()
    .map(([c, d]) => `  ${c.padEnd(12)} as of ${d}`),
  usedMb != null ? `  database     ${usedMb} MB` : null,
  (() => {
    const m = facts.jobs.filter((j) => j.egress?.bytes > 0).map((j) => j.egress.bytes);
    if (!m.length) return null;
    const perMonth = egressPerMonthMb(Math.max(...m));
    return `  egress       ~${(perMonth / 1024).toFixed(2)} GB/month projected`;
  })(),
  facts.rowCounts.prices_daily?.count != null
    ? `  price rows   ${facts.rowCounts.prices_daily.count.toLocaleString()}` : null,
].filter(Boolean).join("\n");

console.log(`watchdog: ${level}`);
console.log(state);
for (const f of findings) console.log(`  [${f.level}] ${f.code}: ${f.message}`);

if (level !== "error") {
  // Warnings are printed, never mailed. An inbox that receives something every day is
  // one nobody opens, which is the state this is meant to replace rather than repeat.
  for (const f of findings) console.log(`::warning::${f.message}`);
  process.exit(0);
}

const text = [
  "Meridian's published data is not current.",
  "",
  ...findings.filter((f) => f.level === "error").map((f) => `* ${f.message}`),
  "",
  ...(findings.some((f) => f.level === "warning")
    ? ["Also worth knowing:",
       ...findings.filter((f) => f.level === "warning").map((f) => `  - ${f.message}`), ""]
    : []),
  "Current state:",
  state,
  "",
  runUrl ? `This check: ${runUrl}` : "",
  `Recent jobs: ${(facts.jobs ?? []).slice(0, 3)
    .map((j) => `${(j.finished_at ?? "").slice(0, 16)} ${j.job_type} ${j.status}`).join(" | ") || "none recorded"}`,
].join("\n");

const ok = await send({ subject: `Meridian: screens are stale`, text });
// Non-zero either way: the finding is real whether or not the mail got out, and a red
// run in the Actions tab is the fallback channel when the mail channel is the thing
// that is broken.
process.exit(1);
