import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import { rehypePublicContentLinks } from "./src/lib/public-content-links.ts";
import compiledRendererAdapter from "./scripts/compiled-renderer-adapter.mjs";

// Compile only the existing Post route. No content loaders or job input.
export default defineConfig({
  site: "https://njpbs.org",
  srcDir: "./src/compiled-renderer",
  outDir: "./.shadow-renderer",
  output: "server",
  // Imported public articles need the same .md route rewrite as the static site.
  markdown: { processor: unified({ rehypePlugins: [rehypePublicContentLinks] }) },
  adapter: compiledRendererAdapter({ publicPostsOnly: true }),
  image: { service: { entrypoint: "astro/assets/services/noop" }, remotePatterns: [] },
  build: { format: "directory", assetsPrefix: "https://dev-public.example.org/posts/_shadow-assets" },
  vite: { build: { chunkSizeWarningLimit: 4000 } },
});
