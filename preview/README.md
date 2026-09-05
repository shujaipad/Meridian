# Meridian — local preview harness

Runs `meridian.jsx` in a real browser against the real data files, so a change
can be eyeballed rather than reasoned about. **Development tooling only** — not
part of the production build (§6.8), and nothing here ships to users.

`meridian.jsx` is imported directly from the repo root, never copied in. A
second copy would reintroduce exactly the drift the requirements doc removed in
§11.

## Setup

```sh
cd preview
npm install
npm run trim     # builds prices-trim.csv from the full 67MB price history
```

## Look at it

```sh
npm run dev      # http://127.0.0.1:5178
```

Then upload the three CSVs from the repo root via the buttons on the Stocks
screen: `meridian-company-master-742.csv`, `meridian-fundamentals-742.csv`, and
`preview/prices-trim.csv`.

## Screenshot every screen

With the dev server running, in another terminal:

```sh
npm run capture           # writes shots/*.png
node capture.mjs --full   # same, but the untrimmed 67MB history (minutes, not seconds)
```

## Notes

- **`window.storage` is shimmed** in `src/main.jsx`. `meridian.jsx` was written
  for the Claude artifact environment, which provides that API; the shim is
  in-memory, so nothing persists across a reload. That's deliberate — the real
  price history exceeds any browser storage quota.
- **Why the price file is trimmed:** the browser parses the full 67MB too slowly
  to be useful. 320 trading days covers every live signal (RS Rating's longest
  window is 252 days; the 200DMA slope needs 200+20), so the screens render as
  they would on full history. The one visible difference is Market Breadth,
  which walks all available history and so starts partway across its chart
  rather than spanning 5 years.
- **Chromium** is pre-installed in the Claude Code sandbox at a fixed path and
  `playwright install` is blocked there; `capture.mjs` uses that path when it
  exists and falls back to Playwright's own resolution elsewhere.
