import { build } from "esbuild";
await build({ entryPoints: ["packages/content-core/src/data-hub-composition.ts"], outfile: "functions/lib/data-hub-composition.js",
  bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none", banner: { js:
    "// Generated from packages/content-core/src/data-hub-composition.ts.\n// Regenerate with: node scripts/generate-data-hub-composition.mjs" } });
