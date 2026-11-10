// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
// Astro normally supplies this virtual module; use its real exported config API.
vi.mock("astro:content", () => import("astro/content/config"));
import { collections } from "../src/content.config";
import { cmsPostsLoader, projectCmsPost } from "../src/lib/cms-posts-loader";
import { createCmsPreviewContentSource } from "../src/lib/cms-preview-content";
import { fixture, input, now } from "./fixtures/cms-preview-content";

const schema = collections.cmsPosts.schema as { parse(data: unknown): unknown };
describe("live-blog preview through the actual Astro Post schema", () => {
  it("loads unfinished private reporting through the real projection and collection schema", async () => {
    const value = input("cmsPosts");
    const published = value.snapshot.published!;
    Object.assign(published.metadata, { liveBlog: { schemaVersion: 1, coverageState: "ongoing", updatedAt: now.toISOString(),
      updates: [{ id: "saved-entry", headline: "", body: { type: "doc", content: [] }, credits: [], keyUpdate: false,
        publishedAt: now.toISOString(), updatedAt: now.toISOString() }] } });
    const f = fixture(value);
    const source = createCmsPreviewContentSource(f.request, { read: async () => f.bytes, now: () => now })!;
    const stored: unknown[] = [];
    await cmsPostsLoader(source).load({ store: { clear() {}, set(entry: unknown) { stored.push(entry); return true; } },
      logger: { info() {} }, parseData: async ({ data }: { data: unknown }) => schema.parse(data) } as never);
    expect(stored).toMatchObject([{ id: "post-one", data: { liveBlog: { updates: [{ headline: "", credits: [] }] } } }]);
    // Public admission still uses the complete frozen contract before its schema.
    expect(() => projectCmsPost({ id: "post-one", status: "published", published,
      publishAt: published.publishedAt }, { now })).toThrow();
  });
});
