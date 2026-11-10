import { build } from "esbuild";
await build({ entryPoints: ["packages/content-core/src/town-lookup.ts"],
  outfile: "functions/lib/town-lookup.js", bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none",
  banner: { js: "// Generated from packages/content-core/src/town-lookup.ts.\n// Regenerate with: node scripts/generate-town-lookup.mjs" } });
