// @vitest-environment node
import { describe, expect, it } from "vitest";
import metadata from "../../functions/lib/content-metadata.js";
import contract from "../../functions/lib/content-document-contract.js";
import publishing from "../../functions/lib/publish-snapshot.js";
import preview from "../../functions/lib/preview-snapshot.js";
import mediaContract from "../../functions/lib/media-contract.js";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { resolveImage } from "../src/lib/cms-posts-projection";
import templates from "../../functions/lib/post-templates.js";
import { projectCmsPost } from "../src/lib/cms-posts-loader";

const now = new Date("2026-09-10T12:00:00.000Z");
const caption = "Residents gather at the station. Photo: NJ PBS";
const post = {
  type: "post", title: "At the station", status: "draft", version: 1,
  slug: "at-the-station", previousSlugs: [], locale: "en", tags: [], blocks: [],
  publishAt: now.toISOString(), firstPublishedAt: now.toISOString(), heroImage: "photo", heroImageAlt: "Residents on the platform",
  heroImageCaption: caption,
};
const assets = new Map([["photo", {
  url: "https://media.njpbs.org/cms-media/newsroom/photo/hash.jpg", mimeType: "image/jpeg", width: 1600, height: 900,
}]]);
const publish = (document = post) => publishing.createPublishedSnapshot({
  collection: "cmsPosts", document, publishedAt: now.toISOString(), publishedBy: "editor",
});

describe("Post lead image captions", () => {
  it("accepts optional plain text at the save boundary and rejects malformed captions", () => {
    for (const value of [undefined, "", "  ", caption]) {
      const document: Record<string, unknown> = { ...post, heroImageCaption: value };
      if (value === undefined) delete document.heroImageCaption;
      expect(metadata.validateKnownMetadata(document)).toBeNull();
      expect(contract.validateContentFieldValues("cmsPosts", "post", document, { complete: true })).toBeNull();
    }
    for (const value of [null, 42, {}, [caption]]) {
      const document = { ...post, heroImageCaption: value };
      expect(metadata.validateKnownMetadata(document)).toMatch(/heroImageCaption must be a string/);
      expect(contract.validateContentFieldValues("cmsPosts", "post", document)).toMatch(/heroImageCaption must be a string/);
    }
  });

  it("freezes the caption and keeps later draft edits out of the public projection", () => {
    const published = publish();
    expect(published.metadata).toHaveProperty("heroImageCaption", caption);
    const projected = projectCmsPost({
      id: "post-one", ...post, status: "published", heroImageCaption: "Unpublished replacement credit", published,
    }, { now, assets });
    expect(projected?.heroImageCaption).toBe(caption);
    expect(projected?.heroImageAlt).toBe(post.heroImageAlt);
  });

  it("includes the saved caption in private previews", () => {
    const savedPreview = preview.createPostPreviewSnapshot("post-one", post, now.getTime());
    expect(savedPreview.published.metadata.heroImageCaption).toBe(caption);
  });

  it("keeps older posts readable without a caption and refuses malformed public metadata", () => {
    const published = publish();
    const frozenMetadata = published.metadata as Record<string, unknown>;
    delete frozenMetadata.heroImageCaption;
    expect(projectCmsPost({ id: "post-one", status: "published", publishAt: now.toISOString(), published }, { now, assets })?.heroImageCaption).toBe("");
    frozenMetadata.heroImageCaption = 42;
    expect(() => projectCmsPost({ id: "post-one", status: "published", publishAt: now.toISOString(), published }, { now, assets })).toThrow(/heroImageCaption/);
  });

  it("keeps captions with content templates and clears them from layout-only templates", () => {
    expect(templates.capturePost(post, "content")).toHaveProperty("heroImageCaption", caption);
    expect(templates.capturePost(post, "layout")).not.toHaveProperty("heroImageCaption");
    expect(() => templates.capturePost({ ...post, heroImageCaption: 42 }, "content")).toThrow(/heroImageCaption/);
  });
});


it("uses current library credit without changing an old Post caption or showing credit on Pages", () => {
  const image = { ...assets.get("photo")!, altText: "Suggested library alt", description: "Library description", storageKey: "Private key" };
  const published = publish();
  const document = { id: "old-post", status: "published", publishAt: now.toISOString(), published, heroImageCaption: "Private draft caption" };
  const block: any = { id: "image", type: "image", visible: true, order: 0,
    data: { assetId: "photo", alt: "", altDecorative: true, caption: "" } };
  for (const credit of [undefined, "Current <credit> & photographer", "", null]) {
    const projection = mediaContract.mediaProjection({ ...image, credit });
    expect(projection).not.toHaveProperty("description");
    expect(projection).not.toHaveProperty("storageKey");
    const current = projectCmsPost(document, { now, assets: new Map([["photo", projection]]) })!;
    expect(current.heroImageCaption).toBe(caption);
    expect(current.heroImage?.credit).toBe(credit || undefined);
    const options = { resolveAsset: () => current.heroImage };
    expect(renderBlock(block, options)).not.toContain("cms-image-credit");
    const html = renderBlock(block, { ...options, showImageCredits: true });
    if (credit) {
      expect(html).toContain('class="cms-image-credit">Current &lt;credit&gt; &amp; photographer</span>');
      expect(html).not.toContain('aria-hidden="true"');
    } else expect(html).not.toContain("figcaption");
  }
  for (const credit of [42, {}, "x".repeat(301)]) {
    expect(() => mediaContract.mediaProjection({ ...image, credit })).toThrow();
    expect(() => resolveImage("photo", new Map([["photo", { ...image, credit }]]))).toThrow(/credit/);
  }
});
