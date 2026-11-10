/** The existing Astro routes compile once into a private callable application. */
export default function compiledRendererAdapter({ publicPostsOnly = false, publicPages = false, publicRecords = false, pairReplay = false } = {}) {
  return {
    name: "njpbs-compiled-renderer",
    hooks: {
      "astro:config:setup": ({ updateConfig, injectRoute }) => {
        const rendererSha = process.env.CMS_COMPILED_RENDERER_SHA;
        if (!/^[a-f0-9]{40}$/.test(rendererSha ?? "")) throw new Error("Compiled renderer needs its exact source identity");
        const truthy = value => ["1","true","yes","on"].includes((value ?? "").trim().toLowerCase());
        updateConfig({ vite: { define: { __CMS_RENDERER_SHA__: JSON.stringify(rendererSha),
          __CMS_DATA_HUB_PUBLIC__: JSON.stringify(truthy(process.env.DATA_HUB_PUBLIC) && !truthy(process.env.PUBLIC_ONLY)) } } });
        // Use the production route files themselves, preserving their component
        // depth and style order instead of introducing a parallel wrapper tree.
        const routes = [
          ["/", "./src/pages/index.astro"],
          ["/data-hub/", "./src/pages/data-hub/[...hub].astro"],
          ["/[...slug]", "./src/pages/[...slug].astro"],
          ["/posts/[...slug]", "./src/pages/posts/[...slug].astro"],
          ["/programs/[...slug]", "./src/pages/programs/[...slug].astro"],
          ["/events/[...slug]", "./src/pages/events/[...slug].astro"],
          ["/schedule/", "./src/pages/schedule/[...schedule].astro"],
          ["/staff/", "./src/pages/staff/[...index].astro"],
        ];
        if (pairReplay) injectRoute({ pattern: "/authors/[...slug]", entrypoint: "./src/pages/authors/[...slug].astro", prerender: false });
        if (publicRecords) {
          for (const [pattern, entrypoint] of [
            ["/programs/", "./src/pages/programs/[...index].astro"],
            ["/programs/[...slug]", "./src/pages/programs/[...slug].astro"],
            ["/events/", "./src/pages/events/[...index].astro"],
            ["/events/[...slug]", "./src/pages/events/[...slug].astro"],
            ["/shows/", "./src/pages/shows/[...index].astro"],
            ["/shows/[...slug]", "./src/pages/shows/[...slug].astro"],
          ]) injectRoute({ pattern, entrypoint, prerender: false });
        }
        for (const [pattern, entrypoint] of routes) {
          if ((publicRecords || publicPages) && ["/events/[...slug]", "/programs/[...slug]"].includes(pattern)) continue;
          if (!publicPostsOnly || publicPages || pattern === "/posts/[...slug]") injectRoute({ pattern, entrypoint, prerender: false });
        }
      },
      "astro:config:done": ({ setAdapter }) => setAdapter({
        name: "njpbs-compiled-renderer",
        entrypointResolution: "auto",
        serverEntrypoint: new URL(pairReplay ? "./compiled-public-release-pair-entry.ts" : publicPages || publicRecords ? "./compiled-public-page-entry.ts" : publicPostsOnly ? "./compiled-post-shadow-entry.ts" : "./compiled-renderer-entry.ts", import.meta.url),
        supportedAstroFeatures: { serverOutput: "stable", sharpImageService: "stable" },
      }),
    },
  };
}
