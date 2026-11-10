// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { projectCmsPost } from "../src/lib/cms-posts-loader";

const require = createRequire(import.meta.url);
const { CONTENT_DOCUMENT_CONTRACTS, validateContentFieldValues } = require("../../functions/lib/content-document-contract.js");
const { validateKnownMetadata } = require("../../functions/lib/content-metadata.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { createPostPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const { capturePost } = require("../../functions/lib/post-templates.js");
const publishedAt = "2026-10-06T14:00:00.000Z";
const post = (spotlightNews?: unknown) => ({
  id: "spotlight-post", type: "post", title: "A New Jersey story", status: "draft",
  slug: "a-new-jersey-story", previousSlugs: [], locale: "en", version: 3,
  tags: [], categories: [], blocks: [], firstPublishedAt: publishedAt,
  ...(spotlightNews === undefined ? {} : { spotlightNews }),
});
const freeze = (document: ReturnType<typeof post>) => createPublishedSnapshot({
  collection: "cmsPosts", document, publishedAt, publishedBy: "editor",
});
const publicPost = (document: ReturnType<typeof post>, draftValue?: unknown) => projectCmsPost({
  id: document.id, status: "published", publishAt: publishedAt, published: freeze(document), spotlightNews: draftValue,
}, { now: new Date("2026-10-06T15:00:00.000Z") });

describe("Spotlight publication metadata", () => {
  it("accepts only optional booleans at the write and metadata boundaries", () => {
    expect(CONTENT_DOCUMENT_CONTRACTS.post.fields.spotlightNews).toBe("boolean");
    for (const value of [undefined, false, true]) {
      expect(validateContentFieldValues("cmsPosts", "post", post(value))).toBeNull();
      expect(validateKnownMetadata(post(value))).toBeNull();
    }
    for (const value of ["true", "false", 1, null, {}]) {
      expect(validateContentFieldValues("cmsPosts", "post", post(value))).toMatch(/spotlightNews/);
      expect(validateKnownMetadata(post(value))).toMatch(/spotlightNews/);
      expect(() => freeze(post(value))).toThrow(/spotlightNews/);
    }
  });

  it("keeps old posts off and reads branding only from the immutable public revision", () => {
    expect(publicPost(post())?.spotlightNews).toBe(false);
    expect(publicPost(post(false), true)?.spotlightNews).toBe(false);
    expect(publicPost(post(true), false)?.spotlightNews).toBe(true);
    const document = post(true);
    const snapshot = freeze(document);
    document.spotlightNews = false;
    expect(snapshot.metadata.spotlightNews).toBe(true);
  });

  it("rejects malformed published metadata instead of silently removing the label", () => {
    const published = freeze(post());
    published.metadata.spotlightNews = "true";
    expect(() => projectCmsPost({ id: "bad-post", status: "published", publishAt: publishedAt, published },
      { now: new Date("2026-10-06T15:00:00.000Z") })).toThrow(/spotlightNews/);
  });

  it("freezes the flag into a saved private preview", () => {
    expect(createPostPreviewSnapshot("draft", post(true)).published.metadata.spotlightNews).toBe(true);
    expect(createPostPreviewSnapshot("draft", post(false)).published.metadata.spotlightNews).toBe(false);
  });

  it("does not carry publication attribution into reusable templates", () => {
    for (const mode of ["layout", "content"]) {
      expect(capturePost(post(true), mode).spotlightNews).toBeUndefined();
    }
  });
});
