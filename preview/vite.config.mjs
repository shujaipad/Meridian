import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

// meridian.jsx lives at the repo root and is imported directly rather than
// copied in here — a second copy would reintroduce exactly the drift the
// requirements doc removed in §11. The cost of that choice: its bare imports
// resolve relative to the repo root, which has no node_modules, so each package
// is aliased to this directory's copy.
//
// Aliased by package *directory*, not entry file, so subpaths resolve too — the
// React plugin injects "react/jsx-dev-runtime", which an entry-file alias would
// miss. Longest name first: Vite matches string aliases by prefix and would
// otherwise rewrite "react-dom/client" using the "react" entry.
const packageDir = (pkg) => dirname(require.resolve(`${pkg}/package.json`));
const alias = ["react-dom", "react", "papaparse", "lucide-react", "recharts"].map((pkg) => ({
  find: pkg,
  replacement: packageDir(pkg),
}));

export default defineConfig({
  plugins: [react({ include: [/\.jsx$/] })],
  resolve: { alias },
  server: {
    port: 5178,
    host: "127.0.0.1",
    fs: { allow: [repoRoot] },
  },
});
