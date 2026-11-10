import { build } from "esbuild";
await build({ entryPoints: ["packages/content-core/src/data-figure.ts", "packages/content-core/src/dataset-figures.ts"],
  outdir: "functions/lib", bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none",
  banner: { js: "// Generated from packages/content-core/src/data-figure.ts and dataset-figures.ts.\n// Regenerate with: node scripts/generate-data-figure.mjs" } });
