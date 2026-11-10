import { describe, expect, it, vi } from "vitest";
import { projectCmsPost } from "../src/lib/cms-posts-projection";
import { homeHeroCatalog } from "../src/lib/home-hero-items";
import { readHomeHeroCatalog, resolveHomeHero } from "../../packages/content-core/src/home-hero";
import { renderHomeEditorialHero } from "../../packages/content-core/src/home-editorial-render";
import { createRequire } from "node:module";
const { mediaProjection } = createRequire(import.meta.url)("../../functions/lib/media-contract.js");
import { mountHomeStoryImages } from "../../packages/content-core/src/home-story-image-dom";
import * as serverHero from "../../functions/lib/home-hero.js";

const original = "https://media.njpbs.org/cms-media/news/photo/original.jpg";
// Stored media derivative sizes, from functions/lib/media-thumbnails.js.
const thumbnails = [480, 960].map(width => ({ url: `https://media.njpbs.org/cms-media/news/photo/${width}.webp`, width, height: width * 9 / 16 }));
const publishedAt = "2026-10-08T12:00:00Z";

function publishedStory() {
  return projectCmsPost({ id: "photo-story", status: "published", publishAt: publishedAt, published: {
    sourceVersion: 1, publishedAt, publishedBy: "fixture-editor", blocks: [], metadata: {
      type: "post", title: "A story with its own photograph", slug: "photo-story", previousSlugs: [], locale: "en",
      categories: ["News"], tags: ["news"], summary: "Published story summary", credits: [], heroImage: "photo",
      date: "2026-10-08", editorialDateSource: "editorial",
    },
  } }, { now: new Date("2026-10-09T12:00:00Z"), assets: new Map([["photo", {
    ...mediaProjection({ url: original, altText: "Story photo", mimeType: "image/jpeg", width: 3000, height: 1688, thumbnails }),
  }]]) })!;
}

describe("Home supporting story artwork", () => {
  it("uses the real public media projection through Post projection, catalog transport and both resolvers", () => {
    const post = publishedStory();
    expect(post.heroImage?.url).toBe(original);
    const transported = JSON.parse(JSON.stringify(homeHeroCatalog(undefined, [post])));
    for (const runtime of [{ readHomeHeroCatalog, resolveHomeHero }, serverHero]) {
      const catalog = runtime.readHomeHeroCatalog(transported);
      for (const config of [
        { mode: "manual", items: [{ itemId: "selected", source: "cms_posts", sourceId: post.postId, title: "", summary: "", href: "" }] },
        { mode: "category", source: "cms_posts", value: "News" },
        { mode: "tag", source: "cms_posts", value: "news" },
      ]) expect(runtime.resolveHomeHero(config, catalog)[0].image?.url).toBe(original);
    }
  });

  it("uses existing public photos only in Latest stories, with no placeholder", () => {
    const [card] = homeHeroCatalog(undefined, [publishedStory()]);
    const missing = { ...card, id: "missing", title: "No photograph", href: "/posts/missing/", image: undefined };
    const root = document.createElement("div");
    root.innerHTML = renderHomeEditorialHero([card, { ...card, id: "side", href: "/posts/side/" }, missing, card], { supportingCount: 2 });
    const support = root.querySelector(".home-editorial__support")!;
    const image = support.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(original);
    expect(image.getAttribute("fetchpriority")).toBe("low");
    expect(image.alt).toBe("");
    expect(image.decoding).toBe("async");
    expect(image.getAttribute("srcset")).toBeNull();
    expect(support.querySelectorAll("img")).toHaveLength(1);
    expect(root.querySelector(".home-editorial__overflow img")).toBeNull();
    for (const url of ["/brand/spotlight/education.jpg", "javascript:alert(1)"]) {
      root.innerHTML = renderHomeEditorialHero([card, { ...card, image: { url } }]);
      expect(root.querySelector(".home-editorial__support img")).toBeNull();
    }
  });

  it("eager-loads images in the actual viewport and leaves below-fold images lazy", () => {
    const root = document.createElement("div");
    root.innerHTML = '<img data-home-story-image src="/photo.webp" alt=""><img data-home-story-image src="/below.webp" alt="">';
    const images = root.querySelectorAll("img");
    vi.spyOn(images[0], "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 300 } as DOMRect);
    vi.spyOn(images[1], "getBoundingClientRect").mockReturnValue({ top: window.innerHeight + 1, bottom: window.innerHeight + 201 } as DOMRect);
    mountHomeStoryImages(root);
    expect(images[0].loading).toBe("eager");
    expect(images[1].loading).toBe("lazy");
    images[0].dispatchEvent(new Event("error"));
    expect(images[0].style.visibility).toBe("hidden");
    expect(images[0].getAttribute("src")).toBe("/photo.webp");
  });
});
