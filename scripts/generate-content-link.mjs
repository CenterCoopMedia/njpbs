import { build } from "esbuild";

await build({ entryPoints: ["packages/content-core/src/content-link.ts"],
  outfile: "functions/lib/content-link.js", bundle: true, platform: "node", format: "cjs",
  target: "node22", legalComments: "none", banner: { js:
    "// Generated from packages/content-core/src/content-link.ts.\n// Regenerate with: node scripts/generate-content-link.mjs" } });
