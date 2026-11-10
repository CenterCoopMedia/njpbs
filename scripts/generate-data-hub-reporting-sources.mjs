import { build } from "esbuild";
await build({ entryPoints: ["packages/content-core/src/data-hub-reporting-sources.ts"], outfile: "functions/lib/data-hub-reporting-sources.js",
  bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none", banner: { js:
    "// Generated from packages/content-core/src/data-hub-reporting-sources.ts.\n// Regenerate with: node scripts/generate-data-hub-reporting-sources.mjs" } });
