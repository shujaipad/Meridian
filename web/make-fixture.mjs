/**
 * Builds a fixture of the exact rows Supabase holds, so the production app can be
 * driven end to end without credentials.
 *
 * Source is compute_and_publish.mjs --dry-run, whose TSVs are what that script
 * sends. So the fixture is not a hand-written approximation of the database: it is
 * the same payload, and anything the app gets wrong against it, it would get wrong
 * against Mumbai.
 *
 * Usage: node --max-old-space-size=4096 make-fixture.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = dirname(fileURLToPath(import.meta.url));
const ROOT = join(WEB, "..");
const SRC = join(ROOT, "dryrun-screens");
const OUT = join(WEB, "fixture");

if (!existsSync(SRC)) {
  console.error(`missing ${SRC} — run: node compute_and_publish.mjs --dry-run`);
  process.exit(1);
}

// Reverse of the COPY escaping compute_and_publish.mjs applies.
const unesc = (s) => s.replace(/\\(.)/g, (_, c) =>
  c === "t" ? "\t" : c === "n" ? "\n" : c === "r" ? "\r" : c);
const NUMERIC = /_(pct|rating|ratio)$|^(cmp|rsi|ma\d+|high52|low52|composite_score|rank|constituents|new_highs|new_lows|universe_id)$/;

function readTSV(table) {
  const cols = readFileSync(join(SRC, `${table}.cols`), "utf8").split(",");
  const body = readFileSync(join(SRC, `${table}.tsv`), "utf8").split("\n").filter((l) => l !== "");
  return body.map((line) => {
    const cells = line.split("\t");
    const row = {};
    cols.forEach((c, i) => {
      const raw = cells[i];
      if (raw === "\\N") { row[c] = null; return; }
      const v = unesc(raw);
      if (c === "s_signals" || c === "m_signals" || c === "s_streaks" || c === "m_streaks" || c === "per_metric") row[c] = JSON.parse(v);
      else if (v === "true" || v === "false") row[c] = v === "true";
      // PostgREST returns `numeric` as a JSON string once it exceeds double
      // precision. Emitting strings here is deliberate: it makes the fixture
      // reproduce that, so the app's coercion at the boundary is actually exercised.
      else row[c] = NUMERIC.test(c) ? v : v;
    });
    return row;
  });
}

const universe = readFileSync(join(ROOT, "meridian-company-master-2138.csv"), "utf8")
  .split("\n").filter((l) => l.trim() !== "").slice(1)
  .map((line, i) => {
    // The master's quoted commas ("Food, Beverages & Tobacco") need a real parse.
    const out = []; let f = "", q = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (q) { if (c === '"') { if (line[j + 1] === '"') { f += '"'; j++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ",") { out.push(f); f = ""; }
      else if (c !== "\r") f += c;
    }
    out.push(f);
    const [ISIN, Symbol, Name, Sector, IndustryGroup, MarketCap] = out;
    return { id: i + 1, identifier: ISIN, symbol: Symbol, name: Name,
             sector: Sector, industry_group: IndustryGroup, market_cap: MarketCap || null };
  });

const fixture = {
  universe,
  technicals_daily: readTSV("technicals_daily"),
  fundamentals_scored: readTSV("fundamentals_scored"),
  golden_breakout_candidates: readTSV("golden_breakout_candidates"),
  sectoral_technicals_daily: readTSV("sectoral_technicals_daily"),
  market_breadth_daily: readTSV("market_breadth_daily"),
};

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "screens.json"), JSON.stringify(fixture));
console.log(Object.entries(fixture).map(([k, v]) => `${k}: ${v.length}`).join("\n"));
