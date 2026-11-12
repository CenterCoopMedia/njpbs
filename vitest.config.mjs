import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    setupFiles: ["./tests/setup/cms-edge-fetch.js"],
    // Native CJS callers and imported projectors must share the error class.
    server: { deps: { external: [/\/functions\/lib\/public-release-pair-execution\.js$/] } },
  },
});
