// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseBlocks, type NewsletterSignupBlock, type PageBlock } from "../../packages/content-core/src/content-model";

import { homeCompositionError } from "../../packages/content-core/src/home-composition-contract";
import { createHomeNewsletterBlock, renderHomeNewsletter } from "../../packages/content-core/src/home-newsletter-section";
import { createHomeNewsletterSnapshot, refreshHomeNewsletterSnapshot } from "../../packages/content-core/src/home-service-sources";
import { readHomeEditorialCatalog, resolveHomeNewsletter } from "../../packages/content-core/src/home-source-catalog";
import v1 from "./fixtures/home-composition-v1.json";
import fixture from "./fixtures/home-v2-selections.json";
import copy from "./fixtures/home-sources/newsletter-public-copy.json";
const require = createRequire(import.meta.url);
const cjsBlocks = require("../../functions/lib/content-blocks.js");
const cjsHome = require("../../functions/lib/home-composition-contract.js");
const { blockContentError } = require("../../functions/lib/block-content-validation.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { createPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");
const cutoffAt = fixture.editorial.catalog.cutoffAt;
const record = (id = "newsletter-one", title = copy.title, version = 1) => ({ id, kind: "newsletter", href: null, sourceVersion: version,
  newsletter: { card: { title, signupUrl: copy.signupUrl, summary: copy.summary }, image: { url: copy.image.url } } });
const catalog = () => readHomeEditorialCatalog({ ...fixture.editorial.catalog, services: { newsletters: createHomeNewsletterSnapshot([record(), record("newsletter-two", "Second published Newsletter")], cutoffAt, cutoffAt) } });
const bar = (): NewsletterSignupBlock => ({ ...createHomeNewsletterBlock("saved-newsletter"), data: { newsletterIds: ["newsletter-one"], actionLabel: copy.actionLabel, selectionReceipt: fixture.editorial.receipt } });
const blocks = (value = bar()) => [...structuredClone(v1.blocks), value].map((block, order) => ({ ...block, order })) as PageBlock[];

describe("one saved published Home Newsletter bar", () => {
  it("persists one ID, approved source receipt, editable copy, array order and withdrawal through real snapshot/projection owners", () => {
    const value = bar(); value.data.heading = "Home override"; value.data.intro = "One paragraph";
    const doc = { ...v1, homeCompositionVersion: 2, blocks: blocks(value) };
    expect(homeCompositionError("home", 2, doc.blocks)).toBeNull();
    const preview = createPreviewSnapshot("home", doc);
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc, publishedAt: cutoffAt, publishedBy: "fixture-editor" });
    const publicPage = projectPublicPageDocument({ pageId: "home", document: { ...doc, publiclyVisible: true, published }, assets: new Map(), now: new Date(cutoffAt) }).page;
    for (const saved of [preview, published, publicPage]) expect(saved.blocks.at(-1)).toEqual({ ...value, order: 7 });
    value.visible = false;
    expect(homeCompositionError("home", 2, blocks(value))).toBeNull();
    expect(renderHomeNewsletter(value, catalog())).toBe("");
    expect(value.data.newsletterIds).toEqual(["newsletter-one"]);
  });

  it("renders the accepted horizontal bar from approved copy/art/signup and escapes Home overrides", () => {
    const html = renderHomeNewsletter(bar(), catalog());
    expect(html).toContain(`<h2 id="saved-newsletter-heading">${copy.title}</h2>`);
    expect(html).toContain(copy.summary);
    expect(html).toContain('class="newsletter-band__inner"');
    expect(html).toContain('Sign up by email</a>');
    expect(html).toContain(copy.signupUrl.replaceAll("&", "&amp;"));
    const value = bar(); value.data.heading = '<script>alert("x")</script>'; value.data.intro = "<b>Summary</b>";
    expect(renderHomeNewsletter(value, catalog())).toContain("&lt;script&gt;");
    expect(renderHomeNewsletter(value, catalog())).not.toContain("<script>");
    const absent = catalog(); absent.services!.newsletters = createHomeNewsletterSnapshot([{ ...record(), newsletter: { card: record().newsletter.card } }], cutoffAt, cutoffAt);
    // #3514: a selected Newsletter without artwork keeps the standard decorative band.
    expect(renderHomeNewsletter(bar(), absent)).toContain('src="/brand/newsletter/abstract-blue-folds.webp" alt=""');
  });

  it("corrects or withdraws only current selected approved records while retaining another published picker choice", () => {
    const initial = catalog().services!.newsletters;
    const corrected = refreshHomeNewsletterSnapshot(initial, ["newsletter-one"], [record("newsletter-one", "Approved correction", 2)], cutoffAt);
    const current = { ...catalog(), services: { newsletters: corrected } };
    expect(renderHomeNewsletter(bar(), current)).toContain("Approved correction");
    expect(JSON.stringify(corrected)).toContain("Second published Newsletter");
    const withdrawn = { ...current, services: { newsletters: refreshHomeNewsletterSnapshot(corrected, ["newsletter-one"], [], cutoffAt) } };
    expect(renderHomeNewsletter(bar(), withdrawn)).toBe("");
    expect(resolveHomeNewsletter(bar(), withdrawn).missingIds).toEqual(["newsletter-one"]);
    const switched = bar(); switched.data.newsletterIds = ["newsletter-two"];
    expect(renderHomeNewsletter(switched, withdrawn)).toContain("Second published Newsletter");
    expect(renderHomeNewsletter(bar(), readHomeEditorialCatalog(fixture.editorial.catalog))).toBe("");
  });

  it("refuses unsafe hidden/draft grammar, duplicate or misplaced identity with TS and deployment mirrors", () => {
    const variants = [
      { ...bar(), data: { ...bar().data, newsletterIds: ["newsletter-one", "newsletter-two"] } },
      { ...bar(), data: { ...bar().data, actionLabel: "x".repeat(121) } },
      { ...bar(), data: { ...bar().data, intro: "two\nparagraphs" } },
      { ...bar(), data: { ...bar().data, signupUrl: "https://private.example.test/" } },
      { ...bar(), data: { ...bar().data, imageAssetId: "working-art" } },
      { ...bar(), layout: { rowId: "row", column: 0 } },
    ];
    for (const invalid of variants) {
      const candidate = blocks({ ...invalid, visible: false } as NewsletterSignupBlock);
      const ts = parseBlocks(candidate, { complete: false }), cjs = cjsBlocks.parseBlocks(candidate, { complete: false });
      expect(cjs.ok).toBe(ts.ok);
      if (ts.ok && cjs.ok) {
        expect(homeCompositionError("home", 2, ts.blocks, { complete: false })).toBeTruthy();
        expect(cjsHome.homeCompositionError("home", 2, cjs.blocks, { complete: false })).toBeTruthy();
      } else expect(ts.ok).toBe(false);
    }
    expect(homeCompositionError("home", 2, [...blocks(), { ...bar(), id: "duplicate", order: 8 }])).toBeTruthy();
    expect(homeCompositionError("about", undefined, blocks())).toBeTruthy();
    expect(homeCompositionError("home", 1, blocks())).toBeTruthy();
    const generic = { ...bar(), section: undefined, data: { newsletterIds: ["newsletter-one"] } };
    for (const version of [undefined, 1, 2]) {
      expect(homeCompositionError("home", version, [generic])).toBeTruthy();
      expect(cjsHome.homeCompositionError("home", version, [generic])).toBeTruthy();
    }
    expect(homeCompositionError("about", undefined, [generic])).toBeNull();
    expect(parseBlocks([{ ...bar(), section: undefined }], { complete: false }).ok).toBe(false);
    const incomplete = createHomeNewsletterBlock("incomplete");
    expect(homeCompositionError("home", 2, blocks(incomplete), { complete: false })).toBeNull();
    expect(renderHomeNewsletter(incomplete, catalog(), { complete: false })).toContain("Get the NJ PBS email newsletter");
    expect(renderHomeNewsletter(incomplete, catalog())).toContain("Get the NJ PBS email newsletter");
    incomplete.visible = false;
    expect(homeCompositionError("home", 2, blocks(incomplete))).toBeNull();
    expect(cjsHome.homeCompositionError("home", 2, blocks(incomplete))).toBeNull();
    expect(renderHomeNewsletter(incomplete, catalog())).toBe("");
    const hiddenDoc = { ...v1, homeCompositionVersion: 2, blocks: blocks(incomplete) };
    expect(createPublishedSnapshot({ collection: "cmsPages", document: hiddenDoc, publishedAt: cutoffAt, publishedBy: "fixture-editor" }).blocks.at(-1).visible).toBe(false);
  });
});
