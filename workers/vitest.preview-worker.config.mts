import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  plugins: [
    cloudflareTest({
      main: "./workers/src/preview-worker.ts",
      miniflare: {
        // The installed workerd build currently supports dates through Aug. 18.
        // The deploy config remains current at Aug. 28 and Wrangler validates it.
        compatibilityDate: "2026-08-18",
        compatibilityFlags: ["nodejs_compat"],
        r2Buckets: ["PREVIEWS"],
      },
    }),
  ],
  test: { include: ["tests/preview-worker.test.ts"] },
});
