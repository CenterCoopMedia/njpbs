import { build } from "esbuild";
await build({ entryPoints: ["packages/content-core/src/cms-image-variants.ts"],
  outfile: "functions/lib/cms-image-variants.js", bundle: true, platform: "node", format: "cjs",
  target: "node22", legalComments: "none", banner: { js:
    "// Generated from packages/content-core/src/cms-image-variants.ts.\n// Regenerate with: node scripts/generate-cms-image-variants.mjs" } });
