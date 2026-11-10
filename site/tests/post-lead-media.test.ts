// @vitest-environment node
import { selectSocialImage } from "../src/lib/nj-decides-social-images";
import { postCardImage } from "../../packages/content-core/src/post-card-image";
import { describe, expect, it } from "vitest";
import { isPostLeadMedia, readPostLeadMedia, withoutPublicLeadVideo } from "../../packages/content-core/src/post-lead-media";
import { projectCmsPost, postAssetIds } from "../src/lib/cms-posts-projection";
import { projectCmsPage } from "../src/lib/cms-loader";
import { homeHeroCatalog, resolveHomeHeroItems } from "../src/lib/home-hero-items";
import { createExternalContentManifest } from "../src/lib/external-content-feed";
import { hasVideoPlayer } from "../../packages/content-core/src/video-page";
import { postMediaInventory } from "../../packages/content-core/src/post-media";
import contract from "../../functions/lib/content-document-contract.js";
import publishing from "../../functions/lib/publish-snapshot.js";
import preview from "../../functions/lib/preview-snapshot.js";
import templates from "../../functions/lib/post-templates.js";
import references from "../../functions/lib/public-video-references.js";

const at = "2026-10-15T12:00:00.000Z";
const now = new Date(at);
const photo = { assetId: "photo", url: "https://media.njpbs.org/cms-media/newsroom/photo/hash.jpg",
  mimeType: "image/jpeg", width: 1600, height: 900 };
const assets = new Map([["photo", photo]]);
const media = { url: `https://media.njpbs.org/cms-media/video/clip/${"a".repeat(64)}.mp4`,
  posterUrl: `https://media.njpbs.org/cms-media/video/clip/${"b".repeat(64)}.jpg`, width: 1280, height: 720, mimeType: "video/mp4" };
const library = { kind: "library-video", data: { sourceId: "video-library", assetId: "clip", title: "County meeting", public: media } };
const image = { kind: "image", data: { assetId: "photo", alt: "People at a meeting", caption: "NJ PBS" } };
const youtube = { kind: "embed", data: { url: "https://youtu.be/dQw4w9WgXcQ", title: "County meeting" } };
const post = { type: "post", title: "County meeting", status: "draft", version: 1,
  slug: "county-meeting", previousSlugs: [], locale: "en", tags: [], blocks: [],
  firstPublishedAt: at, heroImage: "photo", heroImageAlt: "People at a meeting" };
type LeadSnapshot = ReturnType<typeof publishing.createPublishedSnapshot> & { metadata: Record<string, unknown> };
function snapshot(lead?: unknown): LeadSnapshot {
  return publishing.createPublishedSnapshot({ collection: "cmsPosts", document: { ...post,
    ...(lead !== undefined ? { leadMedia: lead } : {}) }, publishedAt: at, publishedBy: "editor" }) as LeadSnapshot;
}
function project(lead?: unknown) {
  const published = snapshot();
  if (lead !== undefined) published.metadata.leadMedia = lead;
  return projectCmsPost({ id: "meeting", status: "published", publishAt: at, published }, { now, assets })!;
}

describe("Post lead media publication contract (#3582)", () => {
  it.each([
    { kind: "image", data: { assetId: "photo", alt: "" } },
    { kind: "embed", data: { url: "https://youtu.be/dQw4w9WgXcQ", title: "" } },
    { kind: "library-video", data: { sourceId: "video-library", assetId: "clip", title: "" } },
  ])("retains incomplete $kind selections only in private draft projections", leadMedia => {
    const published = { sourceVersion: 1, publishedAt: at, blocks: [], metadata: { ...post, leadMedia } };
    const doc = { id: "post-one", status: "published", publishAt: at, published };
    expect(projectCmsPost(doc, { now, assets, complete: false })?.leadMedia).toEqual(leadMedia);
    expect(projectCmsPost(doc, { now, assets })?.leadMedia).toBeNull();
  });
  it("reads existing images unchanged, freezes new selections and isolates later drafts", () => {
    const old = project();
    expect(old.heroImage).toEqual(photo);
    expect(old.leadMedia).toEqual({ kind: "image", data: { assetId: "photo", alt: post.heroImageAlt } });
    const published = snapshot(image);
    const value = projectCmsPost({ id: "meeting", status: "published", publishAt: at, leadMedia: youtube, published }, { now, assets });
    expect(value?.leadMedia).toEqual(image);
    expect(preview.createPostPreviewSnapshot("meeting", { ...post, leadMedia: image }, now.getTime()).published.metadata.leadMedia).toEqual(image);
    expect(templates.capturePost({ ...post, leadMedia: image }, "content")).toHaveProperty("leadMedia", image);
    expect(templates.capturePost({ ...post, leadMedia: image }, "layout")).not.toHaveProperty("leadMedia");
  });

  it.each([image, library, youtube,
    { kind: "linked-video", data: { url: "https://watch.njpbs.org/video/county-meeting/", title: "County meeting" } },
    ...["https://vimeo.com/123456789", "https://www.tiktok.com/@njpbs/video/1234567890123456789",
      "https://www.instagram.com/reel/AbCdEf123/", "https://www.facebook.com/njpbs/videos/123456789/",
      "https://x.com/njpbs/status/123456789", "https://player.pbs.org/portalplayer/123456789/"]
      .map(url => ({ kind: "embed", data: { url, title: "County meeting" } })),
  ])("accepts the existing body providers and lead kinds: %j", lead => {
    expect(isPostLeadMedia(lead)).toBe(true);
    expect(contract.validateContentFieldValues("cmsPosts", "post", { leadMedia: lead }, { complete: false })).toBeNull();
    expect(snapshot(lead).metadata.leadMedia).toEqual(lead);
  });

  it.each([null, { kind: "future", data: {} }, { kind: "embed", data: { url: "javascript:alert(1)", title: "Video" } },
    { kind: "library-video", data: { ...library.data, public: { ...media, url: "https://evil.test/x.mp4" } } },
    { ...youtube, data: { ...youtube.data, width: -1 } }, { ...image, data: { ...image.data, alt: 42 } },
    { ...image, data: { ...image.data, assetId: "missing" } },
  ])("omits malformed, unknown, cleared and unavailable leads without losing the header: %j", lead => {
    const result = project(lead);
    expect(result.title).toBe(post.title);
    expect(result.leadMedia).toBeNull();
    expect(result.heroImage).toBeNull();
  });

  it("refuses unsafe writes, allows incomplete drafts, and requires accessible names on publish", () => {
    for (const leadMedia of [{ ...youtube, data: { ...youtube.data, title: "" } }, { ...image, data: { ...image.data, alt: "" } }]) {
      expect(isPostLeadMedia(leadMedia, false)).toBe(true);
      expect(() => snapshot(leadMedia)).toThrow(/Lead media/);
    }
    for (const url of ["javascript:alert(1)", "https://user:pass@example.test/video", "//example.test/video", "https://example.test/\nvideo"]) {
      const leadMedia = { kind: "linked-video", data: { url, title: "County meeting" } };
      expect(contract.validateContentFieldValues("cmsPosts", "post", { leadMedia })).toMatch(/lead media/i);
    }
    expect(readPostLeadMedia({ ...post, leadMedia: null })).toBeNull();
  });

  it("uses selected and managed posters throughout cards and feeds", () => {
    for (const [lead, url] of [[library, media.posterUrl],
      [{ ...youtube, posterAssetId: "photo" }, photo.url]] as const) {
      const result = project(lead);
      expect(result.heroImage?.url).toBe(url);
      expect(homeHeroCatalog(undefined, [result])[0].image?.url).toBe(url);
      const manifest = createExternalContentManifest({ posts: [result], programs: [], authors: [], site: new URL("https://njpbs.org") });
      expect(manifest.items[0].image?.url).toBe(url);
    }
    expect(project(youtube).heroImage).toBeNull(); // No unapproved pre-Play Google image request.
    const linked = project({ kind: "linked-video", data: { url: "https://watch.njpbs.org/video/meeting/", title: "County meeting" } });
    expect(linked.heroImage).toBeNull();
    expect(linked.leadMedia?.kind).toBe("linked-video");
    expect(postAssetIds({ leadMedia: image, heroImage: "old" }, [])).toEqual(["photo"]);
  });

  it("keeps a retained lead image consistent across hero cards, feeds and social previews", () => {
    const projected = project(image);
    const retained = { ...projected, heroImage: null, heroImageAlt: "" };
    expect(postCardImage(retained)).toEqual({ image: photo, alt: image.data.alt, decorative: false });
    expect(homeHeroCatalog(undefined, [retained])[0].image).toEqual({ url: photo.url, width: 1600, height: 900, alt: image.data.alt });
    const now = new Date("2026-11-04T01:00:00.000Z");
    const page = projectCmsPage({ id: "contact", template: "genericPage", title: "Contact", status: "published", publiclyVisible: true,
      publishAt: "2026-11-03T12:00:00.000Z", published: { sourceVersion: 1, publishedAt: "2026-11-03T12:00:00.000Z",
        blocks: [], metadata: { title: "Contact", slug: "contact" } } }, { mode: "published", now, assets: new Map() })!;
    expect(page).not.toBeNull();
    const pinned = resolveHomeHeroItems({ mode: "tag", source: "cms_posts", value: "outside-classification", limit: 4,
      pins: [{ source: "cms_pages", sourceId: "contact" }, { source: "cms_posts", sourceId: retained.postId }] },
      undefined, [retained], {}, [], [page], now.getTime());
    expect(pinned.map(card => card.id)).toEqual(["contact", retained.postId]);
    expect(pinned[1].image).toEqual({ url: photo.url, width: 1600, height: 900, alt: image.data.alt });
    expect(selectSocialImage(retained)).toEqual({ url: photo.url, alt: image.data.alt });
    const manifest = createExternalContentManifest({ posts: [retained], programs: [], authors: [], site: new URL("https://njpbs.org") });
    expect(manifest.items[0].image).toEqual({ url: photo.url, width: 1600, height: 900,
      mimeType: "image/jpeg", alt: image.data.alt, decorative: false });
    const legacy = { ...retained, heroImage: { ...photo, url: photo.url.replace("photo", "legacy") }, heroImageAlt: "Legacy photo" };
    expect(postCardImage(legacy)?.image.url).toBe(legacy.heroImage.url);
    expect(selectSocialImage(legacy)?.alt).toBe("Legacy photo");
    expect(postCardImage({ ...retained, assets: {} })).toBeUndefined();
    expect(postCardImage({ ...retained, leadMedia: youtube })).toBeUndefined();
  });

  it("does not count a video poster as another media item, and suppresses analytics before Play", () => {
    const projected = project(library);
    expect(postMediaInventory(projected)).toMatchObject({ images: 0, videos: 1, totalModules: 1 });
    expect(hasVideoPlayer('<section data-post-lead-player><button>Play video</button></section>')).toBe(true);
  });

  it("retains library lead copies through revisions and scheduling, and strips public data from templates", () => {
    const published = snapshot(library);
    const copies = references.publicCopies({ status: "published", publishAt: at, published });
    expect(copies.map(copy => copy.url)).toEqual([media.url, media.posterUrl]);
    expect(references.scheduledVideoAssetIds({ status: "scheduled", blocks: [], leadMedia: library })).toEqual(["clip"]);
    const replacement = publishing.createPublishedSnapshot({ collection: "cmsPosts", document: { ...post, leadMedia: null, published }, publishedAt: at, publishedBy: "editor" });
    expect(replacement.previousVideoCopies).toEqual(copies);
    expect(withoutPublicLeadVideo(library).data).not.toHaveProperty("public");
    expect(templates.capturePost({ ...post, leadMedia: library }, "content")).not.toHaveProperty("leadMedia.data.public");
  });
});
