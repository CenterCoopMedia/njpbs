import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { createPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");
const { validateKnownMetadata } = require("../../functions/lib/content-metadata.js");
const now = new Date("2026-10-26T12:00:00Z");
const page = () => ({ id: "contact", template: "genericPage", title: "Learning",
  childDirected: true, version: 2, status: "published", publiclyVisible: true,
  publishAt: now.toISOString(), blocks: [] });
const publish = (document: object) => createPublishedSnapshot({ collection: "cmsPages",
  document, publishedAt: now.toISOString(), publishedBy: "fixture-editor" });

describe("child-directed publication boundaries (no database or network)", () => {
  it("freezes the flag in publication and saved preview", () => {
    const document = page();
    const published = publish(document);
    const preview = createPreviewSnapshot("contact", document);
    document.childDirected = false;
    expect(published.metadata.childDirected).toBe(true);
    expect(preview.childDirected).toBe(true);
  });
  it("keeps the published flag through the Worker/public API projection", () => {
    const document = page();
    const published = publish(document);
    document.childDirected = false;
    const result = projectPublicPageDocument({ pageId: "contact", document: { ...document, published }, now, assets: new Map() });
    expect(result.state).toBe("live");
    expect(result.page.childDirected).toBe(true);
  });
  it("keeps old adult pages valid without inventing a flag", () => {
    const { childDirected: _flag, ...document } = page();
    expect(publish(document).metadata).not.toHaveProperty("childDirected");
  });
  it.each(["true", "false", 1, null])("rejects malformed child-directed metadata: %s", childDirected => {
    const document = { ...page(), childDirected };
    expect(validateKnownMetadata(document)).toContain("must be a boolean");
    expect(() => publish(document)).toThrow("must be a boolean");
    expect(() => createPreviewSnapshot("contact", document)).toThrow("must be a boolean");
    const published = { ...publish(page()), metadata: { title: "Learning", childDirected } };
    expect(() => projectPublicPageDocument({ pageId: "contact", document: { ...page(), published }, now, assets: new Map() })).toThrow("must be a boolean");
  });
});
