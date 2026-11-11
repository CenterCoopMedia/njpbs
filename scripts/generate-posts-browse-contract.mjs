#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: repoRoot,
  stdin: {
    contents: 'export { validatePostsBrowse } from "./packages/content-core/src/posts-browse.ts";',
    resolveDir: repoRoot,
  },
  outfile: "functions/lib/posts-browse-contract.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "none",
  banner: {
    js: [
      "// Generated from packages/content-core/src/posts-browse.ts.",
      "// Regenerate with: node scripts/generate-posts-browse-contract.mjs",
    ].join("\n"),
  },
});
