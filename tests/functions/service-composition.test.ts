import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { serviceCompositionError } from "../../packages/content-core/src/service-composition";
const require = createRequire(import.meta.url);
const cjs = require("../../functions/lib/service-composition.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { createPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");
const now = new Date("2026-10-06T12:00:00Z");
const blocks = [{ id: "faq", type: "faq_item", order: 0, visible: true,
  data: { question: "Membership help?", answer: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Contact NJ PBS." }] }] } } },
  { id: "cards", type: "card_grid", order: 1, visible: true, data: { cards: [{ title: "Contact", href: "/contact/" }] } }];
const document = { id: "support", template: "programLanding", status: "published", publishAt: now.toISOString(), publiclyVisible: true,
  title: "Support NJ PBS", version: 7, serviceCompositionVersion: 1, blocks };

describe("service composition Firebase boundaries", () => {
  it.each(["support", "give", "about", "contact", "home", "unknown"])("mirrors the content model for %s", pageId => {
    for (const version of [undefined, 1, 2, false, "1"]) expect(cjs.serviceCompositionError(pageId, version)).toBe(serviceCompositionError(pageId, version));
  });
  it("freezes ownership and order in publication and saved preview", () => {
    const published = createPublishedSnapshot({ collection: "cmsPages", document, publishedAt: now.toISOString(), publishedBy: "editor" });
    expect(published.metadata.serviceCompositionVersion).toBe(1);
    expect(published.blocks.map((block: { id: string }) => block.id)).toEqual(["faq", "cards"]);
    expect(createPreviewSnapshot("support", document).serviceCompositionVersion).toBe(1);
    const projected = projectPublicPageDocument({ pageId: "support", document: { ...document, published }, now, assets: new Map() });
    expect(projected.page.serviceCompositionVersion).toBe(1);
    expect(projected.page.blocks.map((block: { id: string }) => block.id)).toEqual(["faq", "cards"]);
  });
  it("rejects malformed and wrong-family versions before freezing or projecting", () => {
    for (const override of [{ serviceCompositionVersion: 2 }, { id: "contact", template: "genericPage" }]) {
      expect(() => createPublishedSnapshot({ collection: "cmsPages", document: { ...document, ...override }, publishedAt: now.toISOString(), publishedBy: "editor" })).toThrow();
      expect(() => createPreviewSnapshot(override.id ?? "support", { ...document, ...override })).toThrow();
    }
  });
});
