import { defineConfig } from "vitest/config";

// Emulator-backed e2e suite, kept out of the default unit-test include so plain
// `npm test` never needs a running Firestore emulator. Run via the repo root's
// `npm run test:loader`, which boots the emulator around it.
//
// The runner passes --no-file-parallelism, and it has to: these files share one
// emulator database and each resets it, so two running at once wipe each
// other's fixtures mid-test and fail as an empty collection rather than as a
// conflict anyone would recognize.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests-e2e/**/*.e2e.test.ts"],
  },
});
