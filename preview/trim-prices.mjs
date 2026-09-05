// Produces prices-trim.csv: the last N trading days per ISIN from the full
// 67MB price history.
//
// Why trim at all: the browser parses the full file too slowly to be useful for
// a quick look. N=320 is deliberate, not arbitrary — every live signal fits
// inside it (RS Rating's longest window is 252 days, the 200DMA slope needs
// 200+20), so the screens render exactly as they would on full history. The one
// visible difference is Market Breadth, whose chart is a walk through all
// available history and so starts partway across instead of spanning 5 years.

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const DAYS = Number(process.argv[2] ?? 320);
const SRC = fileURLToPath(new URL("../meridian-price-history-742.csv", import.meta.url));
const OUT = fileURLToPath(new URL("./prices-trim.csv", import.meta.url));

// Rows are grouped by ISIN and date-ascending within each group, so buffering a
// rolling window of the last DAYS rows per ISIN keeps the most recent ones
// without holding the whole 67MB file in memory.
const perIsin = new Map();
let header = null;

const rl = createInterface({ input: createReadStream(SRC), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  if (header === null) {
    header = line;
    continue;
  }
  const isin = line.slice(0, line.indexOf(","));
  let rows = perIsin.get(isin);
  if (!rows) perIsin.set(isin, (rows = []));
  rows.push(line);
  if (rows.length > DAYS) rows.shift();
}

const out = await open(OUT, "w");
await out.write(header + "\n");
let total = 0;
for (const rows of perIsin.values()) {
  await out.write(rows.join("\n") + "\n");
  total += rows.length;
}
await out.close();

console.log(`wrote ${OUT}`);
console.log(`${perIsin.size} instruments, ${total} rows (last ${DAYS} trading days each)`);
