import { build } from "esbuild";
await build({
  entryPoints: ["packages/content-core/src/home-newscast-data.ts"],
  outfile: "functions/lib/home-newscast-data.js", bundle: true,
  platform: "node", format: "cjs", target: "node22", legalComments: "none",
  banner: { js: "// Generated from packages/content-core/src/home-newscast-data.ts.\n// Regenerate with: node scripts/generate-home-newscast-data.mjs\n\"use strict\";" },
});
