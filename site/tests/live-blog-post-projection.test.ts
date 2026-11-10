import { describe, expect, it } from "vitest";
import { projectCmsPost } from "../src/lib/cms-posts-projection";
import { LIVE_BLOG_SPECIMEN } from "./fixtures/live-blog";

const asOf = LIVE_BLOG_SPECIMEN.updatedAt;
function document() {
  return { id: "post-live-blog", version: 4, status: "draft", publiclyVisible: true,
    title: "PRIVATE working title", liveBlog: { updates: [{ headline: "PRIVATE working update" }] },
    published: { sourceVersion: 3, publishedAt: asOf, blocks: [], metadata: {
      type: "post", title: "Public coverage", slug: "coverage", previousSlugs: [], locale: "en",
      date: "2026-11-03", editorialDateSource: "editorial", categories: [], tags: [],
      credits: [{ kind: "custom", name: "Example newsroom" }], liveBlog: structuredClone(LIVE_BLOG_SPECIMEN),
    } } };
}

describe("live blog in the normal public Post projection", () => {
  it("selects the frozen feed and strips private rich-text attributes", () => {
    const value = document();
    value.published.metadata.liveBlog.updates[0].body.attrs = { staffNote: "PRIVATE annotation" };
    const selected = projectCmsPost(value, { now: new Date(asOf) });
    expect(selected?.title).toBe("Public coverage");
    expect(selected?.liveBlog?.updates[0].headline).toBe(LIVE_BLOG_SPECIMEN.updates[0].headline);
    expect(JSON.stringify(selected)).not.toContain("PRIVATE");
  });

  it("projects incomplete entries only in explicit private-preview mode", () => {
    const value = document(); Object.assign(value.published.metadata.liveBlog.updates[0], { headline: "", credits: [], body: { type: "doc", content: [] } });
    expect(projectCmsPost(value, { now: new Date(asOf), complete: false })?.liveBlog?.updates[0].headline).toBe("");
    expect(() => projectCmsPost(value, { now: new Date(asOf) })).toThrow();
  });

  it("resolves frozen entry images strictly and never substitutes working media", () => {
    const value = document();
    value.published.metadata.liveBlog.updates[0].media = { kind: "image", data: { assetId: "entry-photo", alt: "Polling place" } };
    expect(() => projectCmsPost(value, { now: new Date(asOf) })).toThrow(/missing media asset/);
    const asset = { url: "https://media.njpbs.org/cms-media/entry-photo/image.jpg", mimeType: "image/jpeg", width: 800, height: 600 };
    const projected = projectCmsPost(value, { now: new Date(asOf), assets: new Map([["entry-photo", asset]]) });
    expect(projected?.assets["entry-photo"]).toMatchObject(asset);
  });

  it("refuses a feed newer than its enclosing snapshot", () => {
    const value = document(); value.published.publishedAt = "2026-11-01T00:00:00.000Z";
    expect(() => projectCmsPost(value, { now: new Date(asOf) })).toThrow(/newer/);
  });

  it("keeps ordinary Posts valid without a feed", () => {
    const value = document(); Reflect.deleteProperty(value.published.metadata, "liveBlog");
    expect(projectCmsPost(value, { now: new Date(asOf) })).not.toHaveProperty("liveBlog");
  });
});
