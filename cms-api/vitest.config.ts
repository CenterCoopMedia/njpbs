import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { CMS_EDGE_ORIGIN_SECRET: "synthetic-edge" },
        workers: [{
          name: "njpbs-cms-preview-renderer",
          modules: true,
          compatibilityDate: "2026-08-13",
          script: `import { WorkerEntrypoint } from "cloudflare:workers";
            export default class extends WorkerEntrypoint {
              fetch() { return new Response(null, { status: 404 }); }
              async wake(sha) { if (sha !== "a".repeat(40)) throw new Error("Wrong release"); }
            }`,
        }],
      },
    }),
  ],
  test: {
    // Each file owns a workerd runtime; bound that overhead on every host.
    maxWorkers: 1,
    include: ["test/**/*.test.ts"],
  },
});
