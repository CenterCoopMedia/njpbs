#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: repoRoot,
  entryPoints: ["packages/content-core/src/block-content-validation.ts"],
  outfile: "functions/lib/block-content-validation.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "none",
  banner: {
    js: [
      "// Generated from packages/content-core/src/block-content-validation.ts.",
      "// Regenerate with: node scripts/generate-block-content-validation.mjs",
    ].join("\n"),
  },
});
