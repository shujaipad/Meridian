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
// PostgREST returns bigint and integer columns as JSON numbers, and `numeric` as a
// JSON string once it exceeds double precision. The fixture reproduces BOTH, because
// getting this wrong in either direction hides a real bug: emitting universe_id as a
// string made every Set lookup miss and silently dropped all 2,089 equity technicals.
const INTEGER = /^(universe_id|rank|constituents|new_highs|new_lows|rs_streak_days|golden_cross_streak|id)$/;

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
      else if (INTEGER.test(c)) row[c] = Number(v);
      // Everything else stays a string, reproducing how PostgREST returns `numeric`.
      // That is deliberate: it exercises the app's coercion at the boundary.
      else row[c] = v;
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
    return { id: i + 1, asset_class: "equity", identifier: ISIN, symbol: Symbol, name: Name,
             sector: Sector, industry_group: IndustryGroup, market_cap: MarketCap || null };
  });

// The four non-equity classes, appended in the same id order load_supabase.mjs assigns
// so the fixture's universe_ids line up with the screen rows above.
let nextId = universe.length;
for (const [dir, assetClass, sectorField] of [
  ["commodities", "commodity", "Category"], ["currencies", "currency", null],
  ["indices", "index", "Region"], ["crypto", "crypto", null],
]) {
  const path = join(ROOT, `meridian-${dir}-master.csv`);
  if (!existsSync(path)) continue;
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const head = lines.shift().replace(/\r$/, "").split(",");
  for (const line of lines) {
    const c = line.replace(/\r$/, "").split(",");
    const m = Object.fromEntries(head.map((h, i) => [h, c[i]]));
    universe.push({ id: ++nextId, asset_class: assetClass, identifier: m.YahooTicker,
                    symbol: m.Symbol, name: m.Name,
                    sector: sectorField ? (m[sectorField] || null) : null,
                    industry_group: null, market_cap: null });
  }
}

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
