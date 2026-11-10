import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import { rehypePublicContentLinks } from "./src/lib/public-content-links.ts";
import compiledRendererAdapter from "./scripts/compiled-renderer-adapter.mjs";

// Compile the exact existing Page/Post compositions with no content loaders,
// internal routes, credentials or per-job input present at compilation.
export default defineConfig({
  site: "https://njpbs.org",
  srcDir: "./src/compiled-renderer",
  outDir: "./.compiled-renderer",
  output: "server",
  // Imported public articles need the same .md route rewrite as the static site.
  markdown: { processor: unified({ rehypePlugins: [rehypePublicContentLinks] }) },
  adapter: compiledRendererAdapter(),
  image: { remotePatterns: [] },
  build: { format: "directory" },
  vite: {
    // The preview prefix is assigned after rendering. Resolve browser assets
    // against their importing module, including Vite's dynamic preload graph.
    experimental: { renderBuiltUrl: () => ({ relative: true }) },
    build: { chunkSizeWarningLimit: 4000 },
    plugins: [{
      name: "njpbs-compiled-preview-assets",
      configEnvironment(name) {
        if (name === "client") return { build: { manifest: "_preview-assets.json" } };
      },
    }],
  },
});
