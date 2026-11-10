import { build } from "esbuild";

await build({
  entryPoints: ["packages/content-core/src/live-production.ts"],
  outfile: "functions/lib/live-production-contract.js",
  bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none",
  banner: { js: "// Generated from packages/content-core/src/live-production.ts.\n// Regenerate with: node scripts/generate-live-production.mjs\n/* eslint-disable */" },
});
