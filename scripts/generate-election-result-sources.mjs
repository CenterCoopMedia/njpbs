import { build } from "esbuild";
await build({ entryPoints: ["packages/content-core/src/election-result-sources.ts"],
  outfile: "functions/lib/election-result-sources.js", bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none",
  banner: { js: "// Generated from packages/content-core/src/election-result-sources.ts.\n// Regenerate with: node scripts/generate-election-result-sources.mjs" } });
