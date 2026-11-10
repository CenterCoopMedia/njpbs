import { build } from "esbuild";

await build({ entryPoints: ["packages/content-core/src/home-hero.ts"],
  outfile: "functions/lib/home-hero.js", bundle: true, platform: "node", format: "cjs",
  target: "node22", legalComments: "none", banner: { js:
    "// Generated from packages/content-core/src/home-hero.ts.\n// Regenerate with: node scripts/generate-home-hero.mjs" } });
