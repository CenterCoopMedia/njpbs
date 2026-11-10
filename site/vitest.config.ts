import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CLOUDFLARE_PUBLIC_WORKER_TAG: "d".repeat(32), CLOUDFLARE_PUBLIC_ZONE_ID: "b".repeat(32) },
    testTimeout: 20_000,
    environment: "happy-dom",
    include: ["tests/**/*.test.ts", "../packages/browser-search/*.test.ts"],
  },
});
