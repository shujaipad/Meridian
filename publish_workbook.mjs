/**
 * Publish the daily workbook to Supabase Storage (§2.2, §6.3).
 *
 * Runs as the last step of the nightly pipeline, after build_workbook.mjs and
 * build_workbook.py. Uploads under a dated key and overwrites `latest.xlsx`, so
 * the frontend's download button can point at a stable path while the history
 * stays addressable. Then prunes past the retention window — without that the
 * bucket grows ~775 KB a day forever and eventually eats the storage budget the
 * price history is sized against.
 *
 * The bucket is private (supabase-schema.sql); the app hands users a short-lived
 * signed URL rather than a raw object link.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Writes need service_role — the
 * bucket has no insert policy for authenticated users, by design.
 *
 * Usage: node publish_workbook.mjs [--file meridian.xlsx] [--retain-days 90]
 */

import { readFileSync, statSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "workbooks";
const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const file = arg("file", "meridian.xlsx");
const retainDays = Number(arg("retain-days", 90));
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set");
  process.exit(1);
}

// Date the file by the data's as-of date, not by when the job happened to run.
// A job that is retried the next morning must not publish yesterday's screen
// under today's name.
const asOf = JSON.parse(readFileSync(arg("data", "workbook-data.json"), "utf8")).meta.as_of;
const datedKey = `daily/meridian-${asOf}.xlsx`;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const body = readFileSync(file);
console.error(`publishing ${file} (${(statSync(file).size / 1024).toFixed(0)} KB) as of ${asOf}`);

for (const key of [datedKey, "daily/latest.xlsx"]) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(key, body, { contentType: MIME, upsert: true });
  if (error) {
    console.error(`upload failed for ${key}: ${error.message}`);
    process.exit(1);
  }
  console.error(`  uploaded ${key}`);
}

// Prune. Compare on the date embedded in the object name rather than on the
// object's created_at: a re-published or backfilled file would otherwise look
// young and survive past its window.
const cutoff = new Date(Date.now() - retainDays * 86400_000).toISOString().slice(0, 10);
const { data: listed, error: listErr } = await supabase.storage
  .from(BUCKET)
  .list("daily", { limit: 1000 });
if (listErr) {
  console.error(`prune skipped — could not list bucket: ${listErr.message}`);
  process.exit(0); // the upload succeeded; a failed prune is not a failed publish
}

const stale = listed
  .map((o) => o.name)
  .filter((n) => {
    const m = /^meridian-(\d{4}-\d{2}-\d{2})\.xlsx$/.exec(n);
    return m && m[1] < cutoff;
  })
  .map((n) => `daily/${n}`);

if (stale.length) {
  const { error } = await supabase.storage.from(BUCKET).remove(stale);
  if (error) console.error(`prune failed: ${error.message}`);
  else console.error(`  pruned ${stale.length} file(s) older than ${cutoff}`);
} else {
  console.error(`  nothing older than ${cutoff} to prune`);
}
