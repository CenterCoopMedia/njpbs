import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["public-post-runtime.test.ts", "dev-public-entry.test.ts"], fileParallelism: false },
});
