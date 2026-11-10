// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const production = "https://media.njpbs.org";
const development = "https://dev-media.example.org";
const imagePath = "/cms-media/fixture.webp";
const now = new Date("2026-10-01T12:00:00Z");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function readers(environment: string | undefined) {
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", environment);
  vi.resetModules();
  const [page, post, author, video] = await Promise.all([
    import("../src/lib/cms-loader.ts"),
    import("../src/lib/cms-posts-projection.ts"),
    import("../src/lib/cms-authors-loader.ts"),
    import("../../packages/content-core/src/video-block.ts"),
  ]);
  return { ...page, ...post, ...author, ...video };
}

function pageWith(block: { type: string; data: Record<string, unknown> }) {
  return {
    id: "public-meetings", status: "published", publishAt: "2026-10-01T11:00:00Z",
    published: {
      blocks: [{ id: "block", order: 0, visible: true, ...block }],
      metadata: { title: "Media fixture", description: "Media origin contract" },
      publishedAt: "2026-10-01T11:00:00Z", publishedBy: "fixture", sourceVersion: 1,
    },
  };
}

describe.each([undefined, "production", "development"])("CMS media in %s builds", (environment) => {
  it.each([production, development, "https://example.com", "https://dev-media.example.org.example.com"])(
    "applies the same boundary to images, portraits and videos from %s", async (origin) => {
      const api = await readers(environment);
      const allowed = origin === production || environment === "development" && origin === development;
      const url = origin + imagePath;
      const asset = { id: "image", url, mimeType: "image/webp", width: 800, height: 800 };
      const assets = new Map([[asset.id, asset]]);
      const page = () => api.projectCmsPage(pageWith({ type: "image", data: { assetId: "image", alt: "Fixture" } }),
        { mode: "published", now, assets });
      const pdfUrl = origin + "/cms-media/notice.pdf";
      const pdf = () => api.projectCmsPage(pageWith({ type: "document_list", data: {
        documents: [{ itemId: "notice", assetId: "pdf", title: "Notice", publisher: "njpbs", addedAt: now.toISOString() }],
      } }), { mode: "published", now, assets: new Map([["pdf", { id: "pdf", url: pdfUrl, mimeType: "application/pdf" }]]) });
      const image = () => api.resolveImage("image", assets);
      const photo = api.projectAuthorPhoto({ ...asset, thumbnails: [{ url: origin + "/cms-media/portrait.webp", width: 700, height: 700 }] });
      const video = {
        sourceId: "video-library" as const, assetId: "fixture", title: "Video fixture",
        public: {
          url: `${origin}/cms-media/video/fixture/${"a".repeat(64)}.mp4`,
          posterUrl: `${origin}/cms-media/video/fixture/${"b".repeat(64)}.jpg`,
          mimeType: "video/mp4" as const, width: 1920, height: 1080,
        },
      };
      const videoPage = () => api.projectCmsPage(pageWith({ type: "video", data: video }), { mode: "published", now });
      expect(api.isPublicVideoData(video.public)).toBe(allowed);
      expect(api.isVideoBlockData(video)).toBe(allowed);
      if (allowed) {
        expect(page()?.assets.image.url).toBe(url);
        expect(pdf()?.assets.pdf.url).toBe(pdfUrl);
        expect(image().url).toBe(url);
        expect(photo?.url).toBe(url);
        expect(photo?.displayUrl).toBe(origin + "/cms-media/portrait.webp");
        expect(videoPage()?.blocks).toHaveLength(1);
        expect(api.renderVideoBlock(video)).toContain(video.public.url);
      } else {
        expect(page).toThrow(/approved origin/);
        expect(pdf).toThrow(/approved origin/);
        expect(image).toThrow(/approved origin/);
        expect(photo).toBeNull();
        expect(videoPage).toThrow(/blocks/);
      }
    },
  );
});

it.each(["production", "development"])("keeps the existing brand-image exception in %s", async (environment) => {
  const api = await readers(environment);
  const url = "https://njpbs.org/brand/fixture.png";
  const asset = { id: "brand", url, mimeType: "image/png", width: 800, height: 800 };
  const assets = new Map([[asset.id, asset]]);
  expect(api.resolveImage("brand", assets).url).toBe(url);
  expect(api.projectCmsPage(pageWith({ type: "image", data: { assetId: "brand", alt: "Brand" } }),
    { mode: "published", now, assets })?.assets.brand.url).toBe(url);
  expect(api.projectAuthorPhoto(asset)).toBeNull();
});

it.each(["production", "development"])("rejects malformed media addresses in %s", async (environment) => {
  const api = await readers(environment);
  const origin = environment === "development" ? development : production;
  for (const url of [
    origin.replace("https:", "http:") + imagePath,
    origin.replace("https://", "https://user:pass@") + imagePath,
    origin + ":444" + imagePath,
    origin + imagePath + "?download=1",
    origin + imagePath + "#fragment",
    origin + "/other/fixture.webp",
    origin + "/cms-media/",
  ]) {
    const asset = { id: "image", url, mimeType: "image/webp", width: 800, height: 800 };
    const assets = new Map([[asset.id, asset]]);
    expect(() => api.resolveImage("image", assets)).toThrow(/approved origin/);
    expect(api.projectAuthorPhoto(asset)).toBeNull();
    expect(() => api.projectCmsPage(pageWith({ type: "image", data: { assetId: "image", alt: "Fixture" } }),
      { mode: "published", now, assets })).toThrow(/approved origin/);
  }
});
