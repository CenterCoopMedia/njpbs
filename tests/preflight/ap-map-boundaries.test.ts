import { describe, expect, it } from "vitest";
import { renderBlock } from "../../packages/content-core/src/content-render";
import preview from "../../functions/lib/preview-snapshot.js";
import publication from "../../functions/lib/publish-snapshot.js";
import projection from "../../functions/lib/public-content-projection.js";
import templates from "../../functions/lib/post-templates.js";

const at = "2026-11-02T23:00:00.000Z";
const map = () => ({ id: "archive-map", type: "embed" as const, order: 0, visible: true, data: {
  url: "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html",
  heading: "Archived Senate primary results", caption: "June 2, 2026. Archive example.",
  mapSize: "large" as const, mobileHeight: 700, mapWidth: "wide" as const,
} });

describe("AP map publication boundaries", () => {
  it("keeps frozen map settings through Page preview, publication and public rendering", () => {
    const document = { id: "contact", template: "genericPage", title: "Archive", description: "Archive example",
      version: 7, blocks: [map()] };
    const saved = preview.createPreviewSnapshot("contact", document);
    const published = publication.createPublishedSnapshot({ collection: "cmsPages", document,
      publishedAt: at, publishedBy: "fixture-editor" });
    document.blocks[0].data.heading = "Private later heading";
    document.blocks[0].data.mobileHeight = 800;
    const result = projection.projectPublicPageDocument({ pageId: "contact", document: {
      ...document, status: "draft", publiclyVisible: true, publishAt: at, published,
    }, assets: new Map(), now: new Date("2026-11-02T23:01:00Z") });
    expect(saved.blocks[0].data).toEqual(map().data);
    expect(result.page.blocks[0].data).toEqual(map().data);
    const html = renderBlock(result.page.blocks[0]);
    expect(html).toContain("Archived Senate primary results");
    expect(html).toContain('height="1200"');
    expect(html).toContain("--ap-map-mobile-height:700px");
    expect(html).toContain("election-map--wide");
    expect(html).not.toContain("Private later heading");
  });

  it("keeps AP settings in content templates and layout sizes in empty templates", () => {
    const source = { type: "post", title: "Archive", tags: [], blocks: [map()] };
    expect(templates.capturePost(source, "content").blocks[0].data).toEqual(map().data);
    expect(templates.capturePost(source, "layout").blocks[0].data).toEqual({
      url: "", caption: "", mapSize: "large", mobileHeight: 700, mapWidth: "wide",
    });
  });
});
