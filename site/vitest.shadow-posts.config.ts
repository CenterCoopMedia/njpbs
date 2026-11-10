import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["render-tests/shadow-post-parity.test.ts", "render-tests/post-lead-media.test.ts", "render-tests/live-blog-post.test.ts"],
    fileParallelism: false,
  },
});
