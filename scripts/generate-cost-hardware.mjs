import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await build({
  absWorkingDir: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  entryPoints: ["packages/content-core/src/cost-hardware.ts"],
  outfile: "functions/lib/cost-hardware.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "none",
  banner: {
    js: "// Generated from packages/content-core/src/cost-hardware.ts.\n// Regenerate with: node scripts/generate-cost-hardware.mjs",
  },
});
