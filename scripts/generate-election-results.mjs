import { build } from "esbuild";
await build({ entryPoints: ["packages/content-core/src/election-results.ts"],
  outfile: "functions/lib/election-results.js", bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none",
  banner: { js: "// Generated from packages/content-core/src/election-results.ts.\n// Regenerate with: node scripts/generate-election-results.mjs" } });
