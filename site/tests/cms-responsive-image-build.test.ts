// @vitest-environment node

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, relative } from "node:path";
import { build } from "astro";
import { describe, expect, it, vi } from "vitest";
import { freezeRetainedPublicImages, installRetainedPublicImages } from "../scripts/retained-public-images";

function moduleSpecifier(from: string, to: string): string {
  const path = relative(from, to).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

function allFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}

describe("CMS responsive Astro build", () => {
  it.each(["development", "production"])("leaves %s offline media URLs unchanged without fetching or advertising variants", async target => {
    const siteRoot = process.cwd();
    const fixtureRoot = mkdtempSync(join(siteRoot, ".tmp-cms-image-"));
    const pages = join(fixtureRoot, "src", "pages");
    const urls = [
      "https://media.njpbs.org/cms-media/general/fixture/original.webp",
      "https://dev-media.example.org/cms-media/general/fixture/original.webp",
      "https://njpbs.org/brand/spotlight/watch.jpg",
    ];
    const fetch = vi.fn(() => { throw new Error("Offline build attempted a fetch"); });
    try {
      vi.stubEnv("ASTRO_TELEMETRY_DISABLED", "1");
      vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", target);
      vi.stubEnv("CMS_DEV_FROZEN_BUILD", target === "development" ? "1" : "");
      vi.stubEnv("CMS_OFFLINE_BUILD", "1");
      vi.stubGlobal("fetch", fetch);
      mkdirSync(pages, { recursive: true });
      writeFileSync(join(fixtureRoot, "astro.config.mjs"),
        `import config from "../astro.config.mjs";\nexport default { image: config.image };\n`);
      const adapter = moduleSpecifier(pages, join(siteRoot, "src/lib/cms-responsive-image.ts"));
      const renderer = moduleSpecifier(pages, join(dirname(siteRoot), "packages/content-core/src/content-render.ts"));
      const localImage = moduleSpecifier(pages, join(siteRoot, "public/brand/spotlight/watch.jpg"));
      writeFileSync(join(pages, "index.astro"), `---
import { getImage } from "astro:assets";
import { resolveCmsResponsiveImage } from ${JSON.stringify(adapter)};
import { renderResolvedImage } from ${JSON.stringify(renderer)};
import localImage from ${JSON.stringify(localImage)};
const images = await Promise.all(${JSON.stringify(urls)}.map(async (url) => {
  const image = await resolveCmsResponsiveImage({ url, mimeType: url.endsWith(".jpg") ? "image/jpeg" : "image/webp", width: 640, height: 360 }, "grid", getImage);
  return renderResolvedImage("fixture", "Offline image", image);
}));
const local = await getImage({ src: localImage, width: 320, format: "webp" });
---
<html lang="en"><body><div set:html={images.join("")} /><img src={local.src} alt="Local image" /></body></html>
`);
      await build({ root: fixtureRoot, logLevel: "silent" });
      const html = readFileSync(join(fixtureRoot, "dist/index.html"), "utf8");
      expect(fetch).not.toHaveBeenCalled();
      for (const url of urls) expect(html).toContain(`src="${url}"`);
      expect(html).not.toContain("<picture>");
      expect(html).not.toContain("srcset=");
      expect(html).toContain('width="640"');
      expect(html).toContain('height="360"');
      expect(allFiles(join(fixtureRoot, "dist/_astro")).some(file => file.endsWith(".webp"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("optimizes a Post's checkpointed CMS image and brand JPG with network disabled", async () => {
    const siteRoot = process.cwd();
    const fixtureRoot = mkdtempSync(join(siteRoot, ".tmp-retained-post-images-"));
    const pages = join(fixtureRoot, "src/pages/posts");
    const urls = ["https://media.njpbs.org/cms-media/fixture/original.jpg", "https://njpbs.org/brand/spotlight/watch.jpg"];
    const post = { title: "Offline Post", blocks: [{ type: "newsletter_signup", visible: true, data: { newsletterIds: ["cms", "brand"] } }] };
    const records = urls.map((url, index) => ({ kind: "newsletter", id: index ? "brand" : "cms", newsletter: {
      card: { signupUrl: "https://example.test/join", imageAssetId: index ? "brand" : "cms" },
      image: { url, mimeType: "image/jpeg", width: 640, height: 360 },
    } }));
    const identity = { buildBatchId: `post-background-${"1".repeat(20)}-${"a".repeat(64)}`, commitSha: "b".repeat(40) };
      const image = readFileSync(join(siteRoot, "public/brand/spotlight/watch.jpg"));
    let restore: (() => void) | undefined;
    try {
      writeFileSync(join(fixtureRoot, "input.json"), JSON.stringify({ posts: [post], recordCards: records }));
      for (const file of ["launch-media-manager.json", "spotlight-news.json", "schedule.json"]) writeFileSync(join(fixtureRoot, file), "{}");
      await freezeRetainedPublicImages(fixtureRoot, identity, async () => new Response(image, { headers: { "content-type": "image/jpeg" } }));
      vi.stubEnv("ASTRO_TELEMETRY_DISABLED", "1");
      vi.stubEnv("CMS_OFFLINE_BUILD", "1");
      const network = vi.fn(async () => { throw new Error("Retained Post build attempted network"); });
      vi.stubGlobal("fetch", network);
      restore = await installRetainedPublicImages(join(fixtureRoot, "remote-images.json"), identity);
      vi.stubEnv("CMS_RETAINED_IMAGES_READY", "1");
      mkdirSync(pages, { recursive: true });
      writeFileSync(join(fixtureRoot, "astro.config.mjs"), `import config from "../astro.config.mjs";\nexport default { image: config.image };\n`);
      const adapter = moduleSpecifier(pages, join(siteRoot, "src/lib/newsletter-signup.ts"));
      const renderer = moduleSpecifier(pages, join(dirname(siteRoot), "packages/content-core/src/content-render.ts"));
      writeFileSync(join(pages, "offline-post.astro"), `---
import { getImage } from "astro:assets";
import { newsletterSignupResolution } from ${JSON.stringify(adapter)};
import { renderResolvedImage } from ${JSON.stringify(renderer)};
const post = ${JSON.stringify(post)};
const newsletters = await newsletterSignupResolution(post.blocks, getImage, ${JSON.stringify(records)});
const images = [...newsletters.images.values()].map(image => renderResolvedImage("fixture", "Retained Post image", image));
---
<html lang="en"><body><article><h1>{post.title}</h1><div set:html={images.join("")} /></article></body></html>`);
      const manifestPath = join(fixtureRoot, "remote-images.json");
      const sealed = readFileSync(manifestPath, "utf8");
      restore();
      const incomplete = JSON.parse(sealed);
      incomplete.images.pop();
      writeFileSync(manifestPath, JSON.stringify(incomplete));
      restore = await installRetainedPublicImages(manifestPath, identity);
      await expect(build({ root: fixtureRoot, cacheDir: join(fixtureRoot, "missing-image-cache"), logLevel: "silent" })).rejects.toThrow("missing from retained input");
      expect(network).not.toHaveBeenCalled();
      restore();
      writeFileSync(manifestPath, sealed);
      restore = await installRetainedPublicImages(manifestPath, identity);
      await build({ root: fixtureRoot, cacheDir: join(fixtureRoot, "complete-image-cache"), logLevel: "silent" });
      const html = readFileSync(join(fixtureRoot, "dist/posts/offline-post/index.html"), "utf8");
      expect(network).not.toHaveBeenCalled();
      expect(html).toContain("<picture>");
      expect(html).toContain('type="image/avif"');
      expect(html).toContain('type="image/webp"');
      expect(html).toContain("srcset=");
      expect(html).toContain('width="640"');
      expect(html).toContain('height="360"');
      for (const url of urls) expect(html).not.toContain(`src="${url}"`);
      expect(allFiles(join(fixtureRoot, "dist/_astro")).some(file => file.endsWith(".avif"))).toBe(true);
    } finally {
      restore?.(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("fetches an allowed local original and emits bounded static picture variants", async () => {
    const siteRoot = process.cwd();
    const sourceImage = readFileSync(
      join(siteRoot, "public", "brand", "spotlight", "watch.jpg"),
    );
    const priorTelemetry = process.env.ASTRO_TELEMETRY_DISABLED;
    const fixtureRoot = mkdtempSync(join(siteRoot, ".tmp-cms-image-"));
    const pages = join(fixtureRoot, "src", "pages");
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (request.url !== "/cms-media/watch.jpg") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "image/jpeg",
        "content-length": String(sourceImage.byteLength),
        "access-control-allow-origin": "*",
      });
      response.end(sourceImage);
    });

    try {
      process.env.ASTRO_TELEMETRY_DISABLED = "1";
      mkdirSync(pages, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Local image fixture did not bind to a TCP port");
      }

      const adapter = moduleSpecifier(
        pages,
        join(siteRoot, "src", "lib", "cms-responsive-image.ts"),
      );
      const renderer = moduleSpecifier(
        pages,
        join(
          dirname(siteRoot),
          "packages",
          "content-core",
          "src",
          "content-render.ts",
        ),
      );
      writeFileSync(
        join(fixtureRoot, "astro.config.mjs"),
        `import { defineConfig } from "astro/config";\n` +
          `export default defineConfig({\n` +
          `  image: { remotePatterns: [{ protocol: "http", hostname: "127.0.0.1", port: "${address.port}", pathname: "/cms-media/**" }] },\n` +
          `});\n`,
        "utf8",
      );
      writeFileSync(
        join(pages, "index.astro"),
        `---\n` +
          `import { getImage } from "astro:assets";\n` +
          `import { resolveCmsResponsiveImage } from ${JSON.stringify(adapter)};\n` +
          `import { renderResolvedImage } from ${JSON.stringify(renderer)};\n` +
          `const image = await resolveCmsResponsiveImage({ url: "http://127.0.0.1:${address.port}/cms-media/watch.jpg", mimeType: "image/jpeg", width: 640, height: 360 }, "grid", getImage);\n` +
          `const markup = renderResolvedImage("watch", "Watch NJ PBS", image);\n` +
          `---\n` +
          `<html lang="en"><body set:html={markup} /></html>\n`,
        "utf8",
      );

      await build({ root: fixtureRoot, logLevel: "silent" });

      const html = readFileSync(join(fixtureRoot, "dist", "index.html"), "utf8");
      const outputs = allFiles(join(fixtureRoot, "dist", "_astro"));
      expect(requests.length).toBeGreaterThan(0);
      expect(new Set(requests)).toEqual(new Set(["/cms-media/watch.jpg"]));
      expect(html).toContain("<picture>");
      expect(html).toContain('type="image/avif"');
      expect(html).toContain('type="image/webp"');
      expect(html).toContain("srcset=");
      expect(html).not.toContain(`http://127.0.0.1:${address.port}`);
      expect(outputs.some((path) => path.endsWith(".avif"))).toBe(true);
      expect(outputs.some((path) => path.endsWith(".webp"))).toBe(true);
      expect(outputs.some((path) => path.endsWith(".jpeg"))).toBe(true);
      expect(outputs.length).toBeLessThanOrEqual(12);
    } finally {
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
        if (priorTelemetry === undefined) {
          delete process.env.ASTRO_TELEMETRY_DISABLED;
        } else {
          process.env.ASTRO_TELEMETRY_DISABLED = priorTelemetry;
        }
      }
    }
  }, 30_000);
});
