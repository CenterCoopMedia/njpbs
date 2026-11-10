import { build } from "esbuild";
await build({ entryPoints: ["packages/content-core/src/home-source-catalog.ts"],
  outfile: "functions/lib/home-source-catalog.js", bundle: true, platform: "node", format: "cjs",
  target: "node22", legalComments: "none", banner: { js:
    "// Generated from packages/content-core/src/home-source-catalog.ts.\n// Regenerate with: node scripts/generate-home-source-catalog.mjs" } });
