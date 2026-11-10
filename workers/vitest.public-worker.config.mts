import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  plugins: [
    cloudflareTest({
      main: "./workers/src/public-worker.ts",
      miniflare: { compatibilityDate: "2026-07-09" },
    }),
  ],
  test: { include: ["tests/public-worker.test.ts"] },
});
