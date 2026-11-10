import { build } from "esbuild";
await build({ entryPoints: ["packages/content-core/src/datasets.ts"], outfile: "functions/lib/datasets.js",
  bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none",
  banner: { js: "// Generated from packages/content-core/src/datasets.ts.\n// Regenerate with: node scripts/generate-datasets.mjs" } });
