#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: repoRoot,
  entryPoints: ["site/src/lib/published-resource-check.ts"],
  outfile: "functions/lib/published-resource-check.js",
  bundle: true,
  external: ["parse5"],
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "none",
  banner: {
    js: [
      "// Generated from site/src/lib/published-resource-check.ts.",
      "// Regenerate with: node scripts/generate-published-resource-check.mjs",
    ].join("\n"),
  },
});
