// @ts-check
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import sitemap from "@astrojs/sitemap";
import { meaningSearchIndex } from "./src/search/build-corpus.ts";
import { publicFonts } from "./scripts/prepare-public-fonts.mjs";
import { rehypeAdminGuideVideos } from "./src/lib/rehype-admin-guide-videos.mjs";
import { rehypePublicContentLinks } from "./src/lib/public-content-links.ts";
import { rehypeStripComments } from "./src/lib/rehype-strip-comments.ts";
import { rehypeWikiLinks } from "./src/lib/rehype-wiki-links.ts";
import {
  cmsRoutedContentEnabled,
  internalSurfaceRoutesEnabled,
  publicRootRoutesEnabled,
  sharePageEnabled,
} from "./src/lib/build-target.ts";
import { readPublicWikiIds } from "./src/lib/wiki-public-ids.ts";
import { resolveShareUploadOrigin } from "../packages/content-core/src/share-upload-origin.ts";
import { pageDeclaresNoindex } from "./src/lib/sitemap-noindex.ts";
import { assertWorkersAssetLimits, pruneUnusedRuntimeAssets } from "./src/lib/workers-asset-limits.ts";
import { resolveCmsPreviewInput } from "./src/lib/cms-preview-input.ts";
import { nameAtlasRoutesEnabled } from "./src/lib/name-atlas-preview.ts";
import { politicsGuidePreviewRoutes } from "./src/lib/politics-guide-preview.ts";
import {
  ADMIN_DOC_PAGES,
  ADMIN_DOCS_BASE,
} from "./src/lib/admin-docs.ts";

// The share page is opt-in. Reject missing/template upload configuration before
// emitting an enabled form; ordinary builds keep the disabled feature inert.
const shareUploadOrigin = resolveShareUploadOrigin(
  process.env.PUBLIC_SHARE_UPLOAD_ORIGIN, sharePageEnabled(process.env),
);

// The public OKF wiki (/wiki/) renders a curated subset of the repo-root wiki/
// bundle. Scan it once at config time for the ids of public concepts, so the link
// rewriter can point links to internal concepts at GitHub instead of 404-ing.
const publicWikiIds = readPublicWikiIds(
  fileURLToPath(new URL("../wiki", import.meta.url)),
);

/** @type {import('astro').AstroIntegration} */
const internalSurfaceRoutes = {
  name: "njpbs-internal-surface-routes",
  hooks: {
    "astro:config:setup": ({ injectRoute }) => {
      if (!internalSurfaceRoutesEnabled(process.env)) return;

      injectRoute({
        pattern: "/design-system/",
        entrypoint: "./src/pages/_design-system.astro",
      });
      injectRoute({
        pattern: "/design-system/tokens.css",
        entrypoint: "./src/pages/_design-system-tokens.css.ts",
      });
      injectRoute({
        pattern: "/design-system/tokens.json",
        entrypoint: "./src/pages/_design-system-tokens.json.ts",
      });
      injectRoute({
        pattern: "/design-system/specimens/public/",
        entrypoint: "./src/pages/_design-system-public-specimens.astro",
      });
      injectRoute({
        pattern: "/design-system/specimens/election/[variant]/",
        entrypoint: "./src/pages/_design-system-nj-decides.astro",
      });
      // Saved CMS previews carry one frozen draft. Do not copy unrelated staff
      // instructions or screenshots into that retained artifact even if a
      // caller also supplies the internal-surface flag.
      if (previewInput) return;
      if (nameAtlasRoutesEnabled(process.env, Boolean(previewInput))) {
        injectRoute({
          pattern: "/atlas/",
          entrypoint: "./src/pages/_name-atlas.astro",
        });
        injectRoute({
          // Static endpoints need an explicit HTML filename for correct
          // directory serving and MIME type on Cloudflare Pages.
          pattern: "/atlas/reader/index.html",
          entrypoint: "./src/pages/_name-atlas-reader.ts",
        });
      }
      for (const route of politicsGuidePreviewRoutes(process.env, Boolean(previewInput))) {
        injectRoute(route);
      }
      injectRoute({
        pattern: ADMIN_DOCS_BASE,
        entrypoint: "./src/pages/_admin-docs/index.astro",
      });
      for (const page of ADMIN_DOC_PAGES) {
        injectRoute({
          pattern: page.href,
          entrypoint: "./src/pages/_admin-docs/DocPage.astro",
        });
      }
      injectRoute({
        pattern: "/images/admin-guide/[image].webp",
        entrypoint: "./src/pages/_admin-docs/Image.ts",
      });
    },
  },
};

/** @type {import('astro').AstroIntegration} */
const publicAuxiliaryRoutes = {
  name: "njpbs-public-auxiliary-routes",
  hooks: {
    "astro:build:done": async ({ dir }) => {
      const development = process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development";
      if (!development && !process.env.PUBLIC_SHARE_UPLOAD_ORIGIN) return;
      const headersPath = new URL("_headers", dir);
      let headers = await readFile(headersPath, "utf8");
      headers = headers.replaceAll("https://uploads.example.org", () => shareUploadOrigin);
      if (development) headers = headers.replace(
        /^(\/_(?:home-sources|publication)\.json\n  Access-Control-Allow-Origin:) https:\/\/admin\.njpbs\.org$/gm,
        "$1 https://dev-admin.example.org\n  Access-Control-Allow-Credentials: true",
      );
      await writeFile(headersPath, headers);
    },
    "astro:config:setup": ({ injectRoute }) => {
      if (!publicRootRoutesEnabled(process.env)) return;

      injectRoute({
        pattern: "/_home-sources.json",
        entrypoint: "./src/pages/_home-sources.json.ts",
      });
      if (previewInput) return;
      injectRoute({
        pattern: "/_schedule-sources.json",
        entrypoint: "./src/pages/_schedule-sources.json.ts",
      });
    },
  },
};

/** @type {import('astro').AstroIntegration} */
const workersAssetLimits = {
  name: "njpbs-workers-asset-limits",
  hooks: {
    "astro:build:done": async ({ dir }) => {
      const distDirectory = fileURLToPath(dir);
      await pruneUnusedRuntimeAssets(distDirectory);
      await assertWorkersAssetLimits(distDirectory);
    },
  },
};

/** @type {import('astro').AstroIntegration} */
const externalContentRoutes = {
  name: "njpbs-external-content-routes",
  hooks: {
    "astro:config:setup": ({ injectRoute }) => {
      if (!cmsRoutedContentEnabled(process.env)) return;

      injectRoute({
        pattern: "/api/v1/content.json",
        entrypoint: "./src/pages/_external-content/content.json.ts",
      });
      injectRoute({
        pattern: "/api/v1/content/[page].json",
        entrypoint: "./src/pages/_external-content/content-page.json.ts",
      });
      injectRoute({
        pattern: "/feeds/news.xml",
        entrypoint: "./src/pages/_external-content/news.xml.ts",
      });
    },
  },
};

const distDirectory = fileURLToPath(new URL("./dist", import.meta.url));
const previewInput = resolveCmsPreviewInput();
const offlineBuild = process.env.CMS_OFFLINE_BUILD === "1";
const retainedImagesReady = process.env.CMS_RETAINED_IMAGES_READY === "1";

// Custom domain at the apex (njpbs.org), so the site serves from root —
// no base path. The Pages workflow publishes the cinematic public site. The
// retired route tombstone and public wiki stay out of the
// sitemap.
// So does any page that declares itself noindex, which the CMS's retired-slug
// redirect stubs under /posts/ and /authors/ do: their routes are content-derived
// and cannot be named by a static path rule, and listing one would tell a crawler
// both to index and not to index the same URL.
export default defineConfig({
  site: "https://njpbs.org",
  base: previewInput ? `/${previewInput.persistent ? "s" : "p"}/${previewInput.queueId}/` : "/",
  image: {
    // Offline builds optimize only digest-verified retained bytes. Other offline
    // renderers keep public originals; full builds retain the remote allowlist.
    remotePatterns: offlineBuild && !retainedImagesReady ? [] : [
      {
        protocol: "https",
        hostname: "media.njpbs.org",
        pathname: "/cms-media/**",
      },
      {
        protocol: "https",
        hostname: "njpbs.org",
        pathname: "/brand/**",
      },
    ],
  },
  integrations: [
    publicFonts,
    meaningSearchIndex(),
    internalSurfaceRoutes,
    publicAuxiliaryRoutes,
    externalContentRoutes,
    workersAssetLimits,
    // Page heads own hreflang because only their pageLocales know which
    // translations exist. Do not add sitemap i18n or an alternate serializer.
    sitemap({
      filter: (page) =>
        !page.includes("/wiki/") &&
        !page.includes("/prototype/") &&
        !page.includes("/design-system/") &&
        !page.includes("/atlas/") &&
        !page.includes("/resources/nj-politics/") &&
        !page.includes(ADMIN_DOCS_BASE) &&
        !pageDeclaresNoindex(page, distDirectory),
    }),
  ],
  build: { format: "directory" },
  markdown: {
    // Astro 7 defaults to Satteri. Keep the existing custom rehype pipeline on
    // unified so public/wiki link rewriting and comment stripping stay intact.
    processor: unified({
      rehypePlugins: [
        // Strip HTML comments from rendered markdown so the per-page guardrail
        // reminder comments stay in source and never ship in public HTML.
        rehypeStripComments,
        rehypeAdminGuideVideos,
        // Rewrite public wiki links to /wiki/ routes and redact internal or
        // out-of-bundle targets to plain text. No-op outside wiki/ sources.
        [rehypeWikiLinks, { publicIds: publicWikiIds }],
        // Keep source Markdown links checkable by lychee while rendering the public
        // content pages to their emitted root routes.
        rehypePublicContentLinks,
      ],
    }),
  },
  vite: {
    // CI installs site dependencies without the workspace root. Resolve the
    // shared browser worker's model/runtime imports from this application.
    resolve: { dedupe: ["@huggingface/transformers", "onnxruntime-web"] },
    plugins: [{
      name: "njpbs-preview-asset-manifest",
      configEnvironment(name) {
        if (previewInput && name === "client") {
          // Astro consumes/removes its own .vite manifests. Keep only the
          // browser dependency graph for the private artifact packer.
          return { build: { manifest: "_preview-assets.json" } };
        }
      },
    }],
    // Keep the 3D island's heavy dependency out of the shared bundle.
    build: {
      chunkSizeWarningLimit: 4000,
      // Keep runtime imports in the bundle until Vite resolves its preload
      // markers. Astro can otherwise inline an unfinished search script.
      assetsInlineLimit(_file, content) {
        if (content.includes("__VITE_PRELOAD__")) return false;
      },
    },
    // The content core lives outside this root, at packages/content-core, so the
    // dev server has to read above site/. It already may, but only by accident:
    // Vite walks up for a workspace marker and finds the root package.json's
    // `workspaces` field, which site is not even a member of. Drop that field and
    // the allowed root silently narrows to site/, breaking `astro dev` on every
    // core import while the build and tests stay green. Declare the boundary.
    server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
  },
});
