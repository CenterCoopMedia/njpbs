import { build } from "esbuild";
await build({ entryPoints: ["packages/content-core/src/county-comparison.ts"],
  outfile: "functions/lib/county-comparison.js", bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none",
  banner: { js: "// Generated from packages/content-core/src/county-comparison.ts.\n// Regenerate with: node scripts/generate-county-comparison.mjs" } });
