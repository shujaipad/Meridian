# The committed price history

Five years of daily bars for all 2,238 instruments, kept in git alongside Supabase.

**Why both.** These files are the only copy of this data outside a free-tier database.
They are what made 2026-09-10 survivable — `prices_daily` had to be truncated to escape
a full disk, and the history was still here to reload from (§11b). They are also the
input the research sandbox reads. Frozen at the backfill, both of those get less true
every night, which is why the nightly job now mirrors into them.

## Layout

```
meridian-price-history-2090-part{1,2,3}of3.csv   equities, keyed by ISIN
meridian-{commodities,currencies,indices,crypto}-prices.csv   keyed by Yahoo ticker
history/appends/YYYY-MM-DD.csv                   one immutable file per pipeline run
```

Append files carry every class in one schema:

```
AssetClass,Key,Date,High,Low,Close,Volume
```

`Key` is the ISIN for equities and the Yahoo ticker otherwise — the same identifier the
matching base file already uses in its first column, so no lookup table is needed.

## How to read it

**Base CSVs, then every `history/appends` file in filename order, last value for a
(Key, Date) wins.** `mergeRows` in `meridian-history.js` is that rule as code.

Last-wins is what lets one mechanism carry two meanings. A new bar collides with
nothing, so order does not matter to it. A correction — the full retained history of an
instrument the nightly job deep re-pulled after detecting a split, a dividend or a
restatement — is *meant* to overwrite, and arriving later is how it does.

```js
import { mergeRows } from "./meridian-history.js";
import { readCSV } from "./meridian-io.js";

const bars = mergeRows([
  ...basePaths.map((p) => readCSV(p).map((r) => ({ ...r, Key: r.ISIN ?? r.Symbol }))),
  ...appendPaths.sort().map((p) => readCSV(p)),
]);
```

## Why one file per run, and never an edit

Three ways to keep these current were measured on a real 42 MB base file over 21 nights
of real bars, taking the pack git would actually push:

| | per night |
|---|---|
| append to the 42 MB base file | 14,442,858 bytes |
| append to one growing file | 931,080 bytes, and rising |
| **one immutable file per run** | **45,587 bytes, flat forever** |

Git deltifies all three equally well *once it garbage-collects* — the gc'd repository
ends the same size whichever you pick, which is why "append-only" on its own was the
wrong rule to carry. What differs is every night in between: a commit touching the base
file writes and pushes a fresh ~14 MB blob until a gc it does not control deltifies it.
A file written once and never reopened costs its own bytes and nothing else.

So: **nothing in here is ever edited or deleted.** A second run on the same day writes
`YYYY-MM-DD.2.csv`. If the base files are ever rebuilt, that is a deliberate, reviewed
operation — not something the pipeline does.

## What the mirror guarantees, and what it does not

It holds every bar Supabase gained from 2026-09-17 onward, plus the committed backfill,
plus the corrected history of every instrument the pipeline deep re-pulled.

It would not notice a bar Supabase gains for a date at or *before* a class's watermark
without a deep re-pull. The restatement detector (§11c) exists to make that case
impossible: a changed historical bar is what triggers the re-pull that produces a
correction file.
