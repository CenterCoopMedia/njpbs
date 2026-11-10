// @vitest-environment node
import { expect, it, vi } from "vitest";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
vi.mock("astro:content", () => import("astro/content/config"));
import { collections } from "../src/content.config";
import { cmsImageThumbnails, cmsImageSources } from "../../packages/content-core/src/cms-image-variants";
import { publishedPageRead, pageDocument, now } from "./fixtures/published-pages/fixtures";
import { projectCmsPost } from "../src/lib/cms-posts-projection";
import { projectCmsPage } from "../src/lib/cms-page-projection";
import { homeHeroCatalog } from "../src/lib/home-hero-items";
import { readHomeHeroCatalog } from "../../packages/content-core/src/home-hero";
import { renderHomeEditorialHero } from "../../packages/content-core/src/home-editorial-render";
import safety from "../../functions/lib/published-media-safety.js";
import projection from "../../functions/lib/public-content-projection.js";

const hash = "a".repeat(64), directory = "https://media.njpbs.org/cms-media/general/asset-one/";
const original = { url: `${directory}${hash}.webp`, mimeType: "image/webp", width: 6000, height: 4000, altText: "Library suggestion" };
const thumbnails = [{ url: `${directory}thumbs/${hash}-w480.webp`, width: 480, height: 320 },
  { url: `${directory}thumbs/${hash}-w960.webp`, width: 960, height: 640 },
  { url: `${directory}thumbs/${hash}-w1600.webp`, width: 1600, height: 1067 }];
const snapshot = (value: unknown) => ({ exists: true, data: () => value });

it("carries recorded variants through public media admission, Post projection and Home HTML", () => {
  const asset = safety.assertPublishedAssetProjection({ assetId: "asset-one", owner: "Home fixture", uploadedMediaReady: true,
    privateSnapshot: snapshot({ ...original, source: "upload", lifecycle: "active", animated: false, thumbnails,
      description: "Private library detail", storageKey: "private/key" }), publicSnapshot: snapshot(original) });
  expect(asset).toEqual({ ...original, thumbnails });
  const safe = projection.selectedAssets({ assetIds: ["asset-one"] }, new Map([["asset-one", asset]]));
  const input = publishedPageRead("home", "a".repeat(40)).posts[0] as any;
  input.document.published.metadata.leadMedia = { kind: "image", data: { assetId: "asset-one", alt: "Contextual Capitol description" } };
  const postSchema = collections.cmsPosts.schema as { parse(data: unknown): NonNullable<ReturnType<typeof projectCmsPost>> };
  const post = postSchema.parse(projectCmsPost(input.document, { now, assets: new Map(Object.entries(JSON.parse(JSON.stringify(safe)))) })!);
  expect(post.heroImage?.thumbnails).toEqual(thumbnails);
  expect(post.assets["asset-one"].thumbnails).toEqual(thumbnails);
  const pageInput = pageDocument("home") as any;
  pageInput.published.metadata.heroBackgroundImage = "asset-one";
  const pageSchema = collections.cmsPages.schema as { parse(data: unknown): NonNullable<ReturnType<typeof projectCmsPage>> };
  const page = pageSchema.parse(projectCmsPage(pageInput, { mode: "published", now, assets: new Map([["asset-one", { id: "asset-one", ...asset }]]) })!);
  expect(page.assets["asset-one"]).toMatchObject({ url: original.url, thumbnails });
  const catalog = readHomeHeroCatalog(JSON.parse(JSON.stringify(homeHeroCatalog(undefined, [post]))));
  const nodes: DefaultTreeAdapterTypes.Node[] = [parseFragment(renderHomeEditorialHero(catalog))];
  let image: DefaultTreeAdapterTypes.Element | undefined;
  while (nodes.length && !image) {
    const node = nodes.shift()!;
    if ("tagName" in node && node.tagName === "img") image = node;
    if ("childNodes" in node) nodes.push(...node.childNodes);
  }
  const attributes = Object.fromEntries(image!.attrs.map(attr => [attr.name, attr.value]));
  expect(attributes.src).toBe(original.url);
  expect(attributes.srcset).toBe(`${thumbnails.map(item => `${item.url} ${item.width}w`).join(", ")}, ${original.url} 6000w`);
  expect(attributes.alt).toBe("Contextual Capitol description");
  expect(attributes.fetchpriority).toBe("high");
  expect(attributes.width).toBe("6000");
});

it.each([
  { width: 1200, height: 800, recorded: thumbnails.slice(0, 2) },
  { width: 2000, height: 1333, recorded: [thumbnails[2]] },
])("offers the $width px original after its smaller recorded thumbnails", ({ width, height, recorded }) => {
  expect(cmsImageSources({ ...original, width, height, thumbnails: recorded }, "100vw")).toEqual({
    srcset: `${recorded.map(item => `${item.url} ${item.width}w`).join(", ")}, ${original.url} ${width}w`,
    sizes: "100vw",
  });
});

it("keeps a 400 px original unchanged without adding a duplicate-width candidate", () => {
  const image = { ...original, width: 400, height: 300 };
  expect(cmsImageSources({ ...image, thumbnails: [] }, "100vw")).toEqual({});
  expect(cmsImageSources({ ...image, thumbnails: [
    { url: `${directory}thumbs/${hash}-w400.webp`, width: 400, height: 300 },
  ] }, "100vw")).toEqual({
    srcset: `${directory}thumbs/${hash}-w400.webp 400w`,
    sizes: "100vw",
  });
});

it("advertises only recorded derivatives of the same admitted original and leaves other assets alone", () => {
  expect(cmsImageSources({ ...original, thumbnails }, "100vw").srcset).toContain("1600w");
  for (const animated of [true, undefined]) {
    expect(safety.assertPublishedAssetProjection({ assetId: "asset-one", owner: "Home fixture", uploadedMediaReady: true,
      privateSnapshot: snapshot({ ...original, source: "upload", lifecycle: "active", animated, thumbnails }),
      publicSnapshot: snapshot(original) })).toEqual(original);
  }
  for (const image of [original, { ...original, thumbnails: [] },
    { ...original, thumbnails: [{ ...thumbnails[0], url: "https://private.example/image.webp" }] },
    { ...original, thumbnails: [{ ...thumbnails[0], url: thumbnails[0].url.replace(hash, "b".repeat(64)) }] },
    { ...original, thumbnails: [{ ...thumbnails[0], height: 100 }] },
    { ...original, mimeType: "image/gif", thumbnails }, { ...original, animated: true, thumbnails },
    { ...original, url: "https://image.pbs.org/image.jpg", thumbnails }]) {
    expect(cmsImageThumbnails(image)).toEqual([]);
    expect(cmsImageSources(image, "100vw")).toEqual({});
  }
  expect(() => safety.assertPublishedAssetProjection({ assetId: "asset-one", owner: "Home fixture", uploadedMediaReady: true,
    privateSnapshot: snapshot({ ...original, source: "upload", lifecycle: "active", thumbnails }),
    publicSnapshot: snapshot({ ...original, url: "https://private.example/image.webp" }) })).toThrow(/projection/);
});
