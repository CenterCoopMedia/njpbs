import { getViteConfig } from "astro/config";

// Test-only Astro compilation. The production preview runtime is unchanged.
export default getViteConfig({
  test: {
    environment: "node",
    include: ["render-tests/cms-preview-content.test.ts", "render-tests/image-loading.test.ts", "render-tests/reader-text-size.test.ts"],
  },
});
