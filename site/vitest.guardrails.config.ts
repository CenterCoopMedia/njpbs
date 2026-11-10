import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts so the post-build dist scans never run in the
// build-free `npm test`. They read dist/, so they only make sense after a build.
// The glob covers every scripts/*.test.ts guardrail, post-build dist scans and source
// scans alike. Each file states its own issue and scope in its header.
export default defineConfig({
  test: {
    include: ["scripts/*.test.ts"],
  },
});
