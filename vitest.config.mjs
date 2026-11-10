import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    setupFiles: ["./tests/setup/cms-edge-fetch.js"],
  },
});
