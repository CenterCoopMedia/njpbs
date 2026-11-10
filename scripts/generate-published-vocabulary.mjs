import { build } from "esbuild";

await build({
  entryPoints: ["packages/content-core/src/published-vocabulary.ts"],
  outfile: "functions/lib/published-vocabulary.js", bundle: true, platform: "node", format: "cjs",
  target: "node22", legalComments: "none", banner: { js:
    "// Generated from packages/content-core/src/published-vocabulary.ts.\n// Regenerate with: node scripts/generate-published-vocabulary.mjs" },
});
