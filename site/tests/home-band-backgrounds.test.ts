// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseBlocks, type PageBlock, type NewsletterSignupBlock } from "../../packages/content-core/src/content-model";
import { homeCompositionView } from "../../packages/content-core/src/home-composition";
import { createHomeNewsletterBlock, renderHomeNewsletter } from "../../packages/content-core/src/home-newsletter-section";
import { createHomeDonorBlock, renderHomeDonor } from "../../packages/content-core/src/home-donor-section";
import { renderHomePassport } from "../../packages/content-core/src/home-section-render";
import { homeBandBackground } from "../../packages/content-core/src/home-band-background";
import { readHomeEditorialCatalog } from "../../packages/content-core/src/home-source-catalog";
import { createHomeNewsletterSnapshot } from "../../packages/content-core/src/home-service-sources";
import { projectCmsPage } from "../src/lib/cms-page-projection";
import v1 from "./fixtures/home-composition-v1.json";
import fixture from "./fixtures/home-v2-selections.json";
import copy from "./fixtures/home-sources/newsletter-public-copy.json";
const require = createRequire(import.meta.url);
const { parseBlocks: serverParse } = require("../../functions/lib/content-blocks.js");
const { createPreviewSnapshot, referencedPreviewAssetIds } = require("../../functions/lib/preview-snapshot.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");
const url = "https://media.njpbs.org/cms-media/band-art/original.webp";
const asset = { id: "band-art", url, mimeType: "image/webp", width: 1600, height: 600 };
const sections = ["home-newsletter", "home-passport-copy", "home-donor"];
function blocks(): PageBlock[] {
  return [...structuredClone(v1.blocks), createHomeNewsletterBlock("newsletter"), createHomeDonorBlock("donor")]
    .map((block, order) => ({ ...block, order })) as PageBlock[];
}

describe("Home band background media contract (#3514)", () => {
  it("refuses URLs, traversal, non-string values and fields on other sections, including incomplete/hidden drafts", () => {
    for (const section of sections) for (const bad of [null, undefined, 1, {}, "https://evil.test/a.png", "../image", "x\n", "x".repeat(129)]) {
      const value = blocks().find(block => block.section === section)!;
      const changed = { ...value, visible: false, data: { ...value.data, backgroundImageAssetId: bad } };
      for (const parse of [parseBlocks, serverParse]) expect(parse([changed], { complete: false, pageId: "home" }).ok).toBe(false);
    }
    for (const parse of [parseBlocks, serverParse]) {
      const value = { ...createHomeNewsletterBlock("newsletter"), data: { newsletterIds: [], actionLabel: "Sign up", backgroundImageAssetId: "band-art" } };
      expect(parse([value], { pageId: "about" }).ok).toBe(false);
      expect(parse([{ ...value, section: "other" }]).ok).toBe(false);
    }
    expect(() => homeBandBackground("band-art", { "band-art": { url: "javascript:alert(1)" } })).toThrow();
  });

  it("keeps the override through save, frozen preview, publication, media references and public projection", () => {
    const saved = blocks().map(block => sections.includes(block.section ?? "")
      ? { ...block, data: { ...block.data, backgroundImageAssetId: "band-art" } } : block) as PageBlock[];
    const doc = { ...v1, homeCompositionVersion: 2, blocks: saved };
    const preview = createPreviewSnapshot("home", doc);
    expect(referencedPreviewAssetIds(preview)).toContain("band-art");
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc, publishedAt: fixture.editorial.catalog.cutoffAt, publishedBy: "fixture-editor" });
    const live = { ...doc, publiclyVisible: true, published };
    const result = projectPublicPageDocument({ pageId: "home", document: live, assets: new Map([[asset.id, asset]]), now: new Date(fixture.editorial.catalog.cutoffAt) });
    expect(result.state).toBe("live");
    for (const value of [preview, published, result.page]) for (const section of sections) {
      expect(value.blocks.find((block: PageBlock) => block.section === section).data.backgroundImageAssetId).toBe("band-art");
    }
    expect(result.page.assets["band-art"].url).toBe(url);
    const content = projectCmsPage(live, { mode: "published", now: new Date(fixture.editorial.catalog.cutoffAt), assets: new Map([[asset.id, asset]]) });
    expect(content?.assets["band-art"].url).toBe(url);
    const assets = { "band-art": { url } };
    const newsletter = saved.find(block => block.section === "home-newsletter") as NewsletterSignupBlock;
    const donor = saved.find(block => block.type === "card_grid" && block.section === "home-donor")!;
    expect(renderHomeNewsletter(newsletter, undefined, { assets })).toContain(`src="${url}" alt=""`);
    if (donor.type !== "card_grid") throw new Error("Missing donor fixture");
    expect(renderHomeDonor(donor, { assets })).toContain(`src="${url}" alt=""`);
    expect(renderHomePassport(homeCompositionView(saved, assets).passport, "https://watch.njpbs.org/passport/learn-more/")).toContain(`src="${url}" alt=""`);
    const missing = new Map([[asset.id, { ...asset, mimeType: "application/pdf" }]]);
    expect(() => projectPublicPageDocument({ pageId: "home", document: live, assets: missing, now: new Date(fixture.editorial.catalog.cutoffAt) })).toThrow();
  });

  it("restores existing defaults when cleared, including a selected Newsletter with no artwork", () => {
    const empty = createHomeNewsletterBlock("newsletter");
    const cutoff = fixture.editorial.catalog.cutoffAt;
    const catalog = readHomeEditorialCatalog({ ...fixture.editorial.catalog, services: { newsletters: createHomeNewsletterSnapshot([
      { id: "newsletter-one", kind: "newsletter", href: null, sourceVersion: 1, newsletter: { card: { title: copy.title, signupUrl: copy.signupUrl, summary: copy.summary } } },
    ], cutoff, cutoff) } });
    const selected = { ...empty, data: { ...empty.data, newsletterIds: ["newsletter-one"], selectionReceipt: fixture.editorial.receipt } };
    for (const value of [empty, selected]) for (const id of [undefined, ""]) {
      const block = { ...value, data: { ...value.data, ...(id === undefined ? {} : { backgroundImageAssetId: id }) } };
      const html = renderHomeNewsletter(block, catalog);
      expect(html).toContain('src="/brand/newsletter/abstract-blue-folds.webp" alt=""');
    }
    const donor = createHomeDonorBlock("donor");
    donor.data.backgroundImageAssetId = "";
    expect(renderHomeDonor(donor)).not.toContain("<img");
    const withdrawn = blocks().map(block => block.section?.startsWith("home-passport-")
      ? { ...block, visible: false, data: { ...block.data, ...(block.type === "prose" ? { backgroundImageAssetId: "withdrawn-art" } : {}) } } : block) as PageBlock[];
    expect(homeCompositionView(withdrawn).passport.backgroundImage).toBeUndefined();
    const content = homeCompositionView(blocks());
    expect(renderHomePassport(content.passport, "https://watch.njpbs.org/passport/learn-more/")).toContain('src="/brand/pbs-passport-compass.png"');
  });
});
