// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { validateContentFieldValues } = require("../../functions/lib/content-document-contract.js");
const { validateKnownMetadata } = require("../../functions/lib/content-metadata.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { createPostPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const { capturePost } = require("../../functions/lib/post-templates.js");
import server from "../../functions/lib/cms-settings-contract.js";
import { COVERAGE_LABELS_SETTINGS_ID, DEFAULT_NJ_DECIDES_SETTINGS, currentCmsSettingsSchemaFor, createCmsSettingsPublishedSnapshot,
  validateCmsSettingsValues, validateCoverageLabels, type CoverageLabel } from "../../packages/content-core/src/cms-settings";
import { postCoverageLabelId, projectCoverageLabels, resolveCoverageLabel } from "../../packages/content-core/src/coverage-labels";
import { renderPostBranding } from "../../packages/content-core/src/post-branding";
import { renderHomeEditorialHero } from "../../packages/content-core/src/home-editorial-render";
import { adaptHomeStationPosts } from "../../packages/content-core/src/home-station-posts-source";
import { homeHeroCatalog } from "../src/lib/home-hero-items";
import { readHomeHeroCatalog, resolveHomeHero } from "../../packages/content-core/src/home-hero";
import { projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { registeredAuthor } from "./fixtures/shadow-posts/fixtures";
import { projectPublishedPageRead } from "../src/lib/published-page-render";
import { publishedPageRead, retainedHomeSources } from "./fixtures/published-pages/fixtures";
import { authorPageContent } from "../src/lib/author-pages";

const label: CoverageLabel = { id: "nj-decides-2026", name: "NJ Decides 2026", textColor: "#011375", backgroundColor: "#e9eaee", retired: false, href: "/nj-decides-2026/" };
const when = "2026-10-29T12:00:00.000Z";
const document = (labels: readonly CoverageLabel[] = [label]) => ({ version: 3, schemaVersion: 1, values: { labels: [{ ...label, name: "PRIVATE draft" }] },
  published: { sourceVersion: 2, schemaVersion: 1, values: { labels }, publishedAt: when } });
const registry = (labels: readonly CoverageLabel[] = [label]) => projectCoverageLabels(document(labels))!.data;

describe("bounded coverage labels", () => {
  it.each([validateCoverageLabels, server.validateCoverageLabels])("accepts the election palette, retired history and an empty list", validate => {
    expect(validate([label])).toBeNull();
    expect(validate([{ ...label, retired: true }])).toBeNull();
    expect(validate([])).toBeNull();
    expect(validate(Array.from({ length: 100 }, (_, i) => ({ ...label, id: `label-${i}` })))).toBeNull();
  });
  it.each([
    null, {}, [null], [{ ...label, id: "UPPER" }], [{ ...label, id: "a".repeat(65) }], [label, label],
    [{ ...label, name: "" }], [{ ...label, name: " whitespace " }], [{ ...label, name: "é".repeat(41) }],
    [{ ...label, retired: "false" }], [{ ...label, textColor: "#777777", backgroundColor: "#ffffff" }],
    [{ ...label, textColor: "red" }], [{ ...label, extra: true }],
    ...["javascript:alert(1)", "data:text/html,x", "//example.test", "relative/path", "https://user:pass@example.test", "/a\\b", "/bad\nlink", "mailto:staff@example.test"].map(href => [{ ...label, href }]),
    Array.from({ length: 101 }, (_, i) => ({ ...label, id: `label-${i}` })),
  ].map(values => ({ values })))("refuses malformed rows consistently ($values)", ({ values }) => {
    expect(validateCoverageLabels(values)).toBeTypeOf("string");
    expect(server.validateCoverageLabels(values)).toBe(validateCoverageLabels(values));
  });
  it("uses the AA contrast boundary and exact shared/server settings snapshot contracts", () => {
    expect(validateCoverageLabels([{ ...label, textColor: "#767676", backgroundColor: "#ffffff" }])).toBeNull();
    const values = { labels: [{ ...label }] };
    const schema = currentCmsSettingsSchemaFor(COVERAGE_LABELS_SETTINGS_ID)!;
    expect(schema).toEqual(server.currentCmsSettingsSchemaFor("coverage-labels"));
    expect(validateCmsSettingsValues(schema, { ...values, unknown: true })).toBeTruthy();
    const args = { schema, values, sourceVersion: 1, publishedAt: when };
    const published = createCmsSettingsPublishedSnapshot(args);
    expect(server.createCmsSettingsPublishedSnapshot(args)).toEqual(published);
    values.labels[0].name = "PRIVATE later change";
    expect(published.values.labels).toEqual([label]);
  });
});

describe("published-only branding", () => {
  it("keeps retirement history, omits unknown/unpublished labels and never reads a working settings draft", () => {
    expect(resolveCoverageLabel(label.id, registry())?.name).toBe("NJ Decides 2026");
    expect(resolveCoverageLabel(label.id, registry([{ ...label, retired: true }]))?.name).toBe(label.name);
    expect(resolveCoverageLabel("missing", registry())).toBeUndefined();
    expect(resolveCoverageLabel(label.id, undefined)).toBeUndefined();
    expect(projectCoverageLabels({ ...document(), published: undefined })).toBeNull();
    expect(projectCoverageLabels({ ...document(), published: { ...document().published, schemaVersion: 2 } })).toBeNull();
  });
  it("renders escaped coverage first, preserves Spotlight and prevents nested links on cards", () => {
    const html = renderPostBranding(true, "headline", { ...label, name: '<NJ & "Decides">' });
    expect(html).toContain('&lt;NJ &amp; &quot;Decides&quot;&gt;');
    expect(html.indexOf("post-coverage")).toBeLessThan(html.indexOf('class="post-publication'));
    expect(html).toContain('href="/nj-decides-2026/"');
    expect(renderPostBranding(true, "card", label)).not.toContain("<a");
    expect(renderPostBranding(false)).toBe("");
    expect(renderPostBranding(false, "card", { ...label, textColor: "invalid" })).toBe("");
  });
  it("renders the election eyebrow from shared brand colors and custom eyebrows from their bar color", () => {
    const election = renderPostBranding(true, "card", label);
    expect(election).toContain(`style="--coverage-red:${DEFAULT_NJ_DECIDES_SETTINGS.ruleColor};--coverage-blue:${DEFAULT_NJ_DECIDES_SETTINGS.textColor}"`);
    expect(election).not.toContain("--coverage-text");
    const custom = renderPostBranding(false, "headline", { ...label, id: "statehouse", backgroundColor: "#ffffff", textColor: "#000000" });
    expect(custom).toContain('style="--coverage-bar:#ffffff"');
    expect(custom).not.toContain("--coverage-red");
  });
  it("derives legacy live-blog coverage and lets an explicit Post selection win", () => {
    expect(postCoverageLabelId({ liveBlog: { branding: "nj-decides-2026" } })).toBe(label.id);
    expect(postCoverageLabelId({ liveBlog: { branding: "nj-decides-2026" }, coverageLabelId: "special-series" })).toBe("special-series");
    expect(postCoverageLabelId({})).toBeUndefined();
  });
  it("updates published Post and Home output from settings alone without changing the Post revision", () => {
    const input = structuredClone(registeredAuthor) as any;
    input.document.published.metadata.coverageLabelId = label.id;
    input.document.coverageLabelId = "PRIVATE-working-id";
    const now = new Date("2026-10-29T13:00:00.000Z");
    const slug = input.document.published.metadata.slug;
    const first = projectPublishedPostRead({ ...input, coverageLabels: document() }, slug, "a".repeat(40), now)!;
    const second = projectPublishedPostRead({ ...input, coverageLabels: document([{ ...label, name: "Updated series", retired: true }]) }, slug, "a".repeat(40), now)!;
    expect(second.posts[0].sourceVersion).toBe(first.posts[0].sourceVersion);
    expect(second.posts[0].coverageLabelId).toBe(label.id);
    const before = resolveCoverageLabel(label.id, first.settings.find(s => s.settingId === "coverage-labels"));
    const after = resolveCoverageLabel(label.id, second.settings.find(s => s.settingId === "coverage-labels"));
    expect(renderPostBranding(false, "headline", before)).toContain("NJ Decides 2026");
    expect(renderPostBranding(false, "headline", after)).toContain("Updated series");
    const catalog = homeHeroCatalog(undefined, second.posts);
    const manual = resolveHomeHero({ mode: "manual", items: [{ itemId: "one", title: "", summary: "", href: "", source: "cms_posts", sourceId: second.posts[0].postId }] }, catalog);
    expect(readHomeHeroCatalog(catalog)[0].coverageLabelId).toBe(label.id);
    expect(manual[0].coverageLabelId).toBe(label.id);
    const home = renderHomeEditorialHero([...manual, ...manual.map(card => ({ ...card, id: "two", href: "/posts/second/" }))], { coverageLabels: registry([{ ...label, name: "Updated series" }]) });
    expect(home.match(/data-coverage-label=/g)).toHaveLength(2);
    expect(home).not.toContain('href="/nj-decides-2026/"');
    expect(home).toContain("Updated series");
    expect(JSON.stringify(second)).not.toContain("PRIVATE");
    const station = adaptHomeStationPosts({ status: "ready", checkedAt: now.toISOString(), posts: second.posts }, { cutoffAt: now.toISOString() });
    expect(station.cards[0].coverageLabelId).toBe(label.id);
    expect(station.cards[0].sourceLabel).toBe("NJ PBS");
    const author = authorPageContent({ authorId: second.posts[0].authorIds[0], hiddenPostIds: [], pinnedPostId: second.posts[0].postId }, second.posts);
    expect(author.listings[0].coverageLabelId).toBe(label.id);
  });
});


describe("Post coverage metadata write contracts", () => {
  const post = (coverageLabelId?: unknown) => ({ id: "coverage-post", type: "post", title: "Election reporting", status: "draft",
    slug: "election-reporting", previousSlugs: [], locale: "en", version: 3, tags: [], categories: [], blocks: [], firstPublishedAt: when,
    ...(coverageLabelId === undefined ? {} : { coverageLabelId }) });
  const freeze = (document: ReturnType<typeof post>) => createPublishedSnapshot({ collection: "cmsPosts", document, publishedAt: when, publishedBy: "editor" });
  it("accepts absent, known and unavailable stable references while refusing malformed IDs at every write boundary", () => {
    for (const id of [undefined, "nj-decides-2026", "unavailable-series"]) {
      expect(validateContentFieldValues("cmsPosts", "post", post(id))).toBeNull();
      expect(validateKnownMetadata(post(id))).toBeNull();
      expect(freeze(post(id)).metadata.coverageLabelId).toBe(id);
    }
    expect(validateContentFieldValues("cmsPosts", "post", post(null))).toBeNull();
    expect(validateKnownMetadata(post(null))).toBeNull();
    expect(() => freeze(post(null))).toThrow(/coverageLabelId/);
    for (const id of [1, {}, "", "UPPER", "a".repeat(65), "with/slash"]) {
      expect(validateContentFieldValues("cmsPosts", "post", post(id))).toMatch(/coverageLabelId/);
      expect(validateKnownMetadata(post(id))).toMatch(/coverageLabelId/);
      expect(() => freeze(post(id))).toThrow(/coverageLabelId/);
    }
  });
  it("freezes the assignment, includes saved preview and omits unrelated reusable templates", () => {
    const source = post(label.id);
    const published = freeze(source);
    source.coverageLabelId = "private-later-series";
    expect(published.metadata.coverageLabelId).toBe(label.id);
    const preview = createPostPreviewSnapshot("coverage-post", post(label.id), Date.parse(when));
    expect(preview.published.metadata.coverageLabelId).toBe(label.id);
    expect(capturePost(post(label.id), "layout").coverageLabelId).toBeUndefined();
    expect(capturePost(post(label.id), "content").coverageLabelId).toBeUndefined();
  });
});


it("refreshes the Home catalog from the current registry without rewriting a published Post", async () => {
  const input: any = publishedPageRead("home");
  input.coverageLabels = document([{ ...label, name: "Updated election coverage", retired: true }]);
  input.posts[0].document.published.metadata.coverageLabelId = label.id;
  const version = input.posts[0].document.published.sourceVersion;
  const content = await projectPublishedPageRead(input, "home", "a".repeat(40), new Date("2026-10-29T13:00:00.000Z"), retainedHomeSources());
  expect(content.posts[0].sourceVersion).toBe(version);
  expect(content.homeSources!.editorial!.catalog.sources["home-posts"]).toMatchObject({ cards: [{ coverageLabelId: label.id }] });
  expect(resolveCoverageLabel(content.posts[0].coverageLabelId, content.settings.find(s => s.settingId === "coverage-labels"))?.name).toBe("Updated election coverage");
});
