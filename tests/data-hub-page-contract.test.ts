import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { defaultDataHubBlocks } from "../packages/content-core/src/data-hub-composition";
import { projectCmsPage } from "../site/src/lib/cms-page-projection";
import { pageDocument } from "../site/tests/fixtures/published-pages/fixtures";
import type { PageMetadata, PublishedSnapshot } from "../packages/content-core/src/content-model";
const require = createRequire(import.meta.url);
const snapshots = require("../functions/lib/publish-snapshot");
const previews = require("../functions/lib/preview-snapshot");
const pageContract = require("../functions/lib/no-build-page-contract");
const now = new Date("2026-10-23T16:00:00.000Z");
const document = () => ({ id: "data-hub", template: "genericPage", status: "draft", version: 1, title: "New Jersey by the Numbers",
  description: "Official figures", slug: "data-hub", dataHubCompositionVersion: 1, blocks: defaultDataHubBlocks() });
const freeze = (doc: Record<string, unknown> = document()) => snapshots.createPublishedSnapshot({ collection: "cmsPages", document: doc,
  publishedAt: now.toISOString(), publishedBy: "fixture-editor" });

describe("Data Hub frozen Page contract", () => {
  it("preserves ordinary blocks from an unversioned legacy snapshot without activating composition", () => {
    // The old server admitted generic Page blocks although its Data Hub UI hid them.
    const doc = pageDocument("data-hub");
    const published = doc.published as PublishedSnapshot<PageMetadata>;
    expect(published.blocks).toHaveLength(3);
    expect(published.metadata.dataHubCompositionVersion).toBeUndefined();
    const preview = previews.createPreviewSnapshot("data-hub", { ...doc, blocks: published.blocks });
    expect(preview.blocks).toEqual(published.blocks);
    expect(preview.dataHubCompositionVersion).toBeUndefined();
    const projected = projectCmsPage(doc, { mode: "published", now });
    expect(projected?.blocks).toEqual(published.blocks);
    expect(projected?.dataHubCompositionVersion).toBeUndefined();
    expect(pageContract.validateNoBuildPageSnapshot({ pageId: "data-hub", snapshot: doc.published }).path).toBe("/data-hub/");
  });

  it("retains the explicit composition marker and blocks across publish, preview and public projection", () => {
    const doc = document();
    const published = freeze(doc);
    expect(published.metadata.dataHubCompositionVersion).toBe(1);
    expect(published.blocks).toEqual(doc.blocks);
    expect(pageContract.validateNoBuildPageSnapshot({ pageId: "data-hub", snapshot: published }).path).toBe("/data-hub/");
    const preview = previews.createPreviewSnapshot("data-hub", doc);
    expect(preview.dataHubCompositionVersion).toBe(1);
    expect(preview.blocks).toEqual(doc.blocks);
    const projected = projectCmsPage({ ...doc, status: "published", publiclyVisible: true,
      publishAt: now.toISOString(), published }, { mode: "published", now });
    expect(projected?.dataHubCompositionVersion).toBe(1);
    expect(projected?.blocks).toEqual(doc.blocks);
  });
  it("distinguishes legacy empty content from staff removing every section", () => {
    const doc = { ...document(), blocks: [] };
    expect(freeze(doc).metadata.dataHubCompositionVersion).toBe(1);
    expect(previews.createPreviewSnapshot("data-hub", doc).dataHubCompositionVersion).toBe(1);
    const legacy: Partial<ReturnType<typeof document>> = { ...doc };
    delete legacy.dataHubCompositionVersion;
    expect(freeze(legacy as ReturnType<typeof document>).metadata.dataHubCompositionVersion).toBeUndefined();
  });
  it("refuses a composition on another Page and unsupported versions at every projection boundary", () => {
    const misplaced = { ...document(), id: "contact", slug: "contact", blocks: [] };
    expect(() => freeze(misplaced)).toThrow(/only on the Data Hub/);
    expect(() => previews.createPreviewSnapshot("contact", misplaced)).toThrow(/only on the Data Hub/);
    const invalid = { ...document(), dataHubCompositionVersion: 2 };
    expect(() => freeze(invalid)).toThrow(/version is invalid/);
    expect(() => previews.createPreviewSnapshot("data-hub", invalid)).toThrow(/version is invalid/);
    expect(() => projectCmsPage(invalid, { mode: "draft", pageId: "data-hub", now })).toThrow(/version is invalid/);
  });
  it("refuses unversioned compiled references, source overrides and aliases before serving", () => {
    const legacy = { ...document(), dataHubCompositionVersion: undefined };
    expect(() => freeze(legacy)).toThrow(/explicit composition version/);
    const published = freeze();
    published.blocks[0].data.value = 123;
    expect(() => pageContract.validateNoBuildPageSnapshot({ pageId: "data-hub", snapshot: published })).toThrow(/invalid/);
    const alias = freeze();
    alias.metadata.previousSlugs = ["data-old"];
    expect(() => pageContract.validateNoBuildPageSnapshot({ pageId: "data-hub", snapshot: alias })).toThrow(/address stays fixed/);
  });
});


it("restores the Page composition marker and reporting through the standard editor-field contract", () => {
  const { restoreEditorFields } = require("../functions/restore-revision");
  const { CONTENT_DOCUMENT_CONTRACTS } = require("../functions/lib/content-document-contract");
  const composed = document();
  const legacy = { title: composed.title, blocks: [], dataHubReporting: { schemaVersion: 1, figures: {}, featured: { inheritFigure: true } } };
  const restoredLegacy = restoreEditorFields(composed, legacy, CONTENT_DOCUMENT_CONTRACTS.page);
  expect(restoredLegacy.dataHubCompositionVersion).toBeUndefined();
  expect(restoredLegacy.blocks).toEqual([]);
  expect(restoredLegacy.dataHubReporting).toEqual(legacy.dataHubReporting);
  const restoredComposition = restoreEditorFields(legacy, composed, CONTENT_DOCUMENT_CONTRACTS.page);
  expect(restoredComposition.dataHubCompositionVersion).toBe(1);
  expect(restoredComposition.blocks).toEqual(composed.blocks);
});
