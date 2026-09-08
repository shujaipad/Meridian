import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

// meridian.jsx and meridian-engine.js live at the repository root and are imported
// unmodified. That is the whole point of the `dataset` seam: production runs the
// SAME interface file the prototype does, so there is no second UI to keep in sync
// (§7.2). The cost is that their bare imports resolve relative to the repo root,
// which has no node_modules — so each package is aliased to this directory's copy.
//
// Aliased by package DIRECTORY, not entry file, so subpaths resolve too: the React
// plugin injects "react/jsx-runtime", which an entry-file alias would miss. And
// longest name first, because Vite matches string aliases by prefix and would
// otherwise rewrite "react-dom/client" using the "react" entry. Both of those were
// learned building the preview harness; this config is deliberately its sibling.
const packageDir = (pkg) => dirname(require.resolve(`${pkg}/package.json`));
// `npm run check` swaps the Supabase client for one that serves the fixture, so the
// whole production path -- auth gate, paged reads, row shaping, every screen -- can
// be driven in a real browser without credentials. Only the network call itself is
// left unexercised.
const fixtureMode = process.env.VITE_FIXTURE === "1";

const alias = [
  ...(fixtureMode
    ? [{ find: /^\.\/supabase\.js$/, replacement: fileURLToPath(new URL("./src/supabase.fixture.js", import.meta.url)) }]
    : []),
  { find: "@meridian", replacement: repoRoot },
  ...["react-dom", "react", "papaparse", "lucide-react", "recharts"].map((pkg) => ({
    find: pkg,
    replacement: packageDir(pkg),
  })),
];

export default defineConfig({
  plugins: [react({ include: [/\.jsx$/] })],
  resolve: { alias },
  server: { port: 5179, host: "127.0.0.1", fs: { allow: [repoRoot] } },
  build: { outDir: "dist", sourcemap: true },
});
