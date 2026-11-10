import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { emptyDataHubReporting, emptyReportingMapping, parseDataHubReporting, reportingStoryUrl, selectReportingStories,
  type ReportingStory } from "../../packages/content-core/src/data-hub-reporting";
import { pageMetadataFromDocument, pageMetadataSaveDocument } from "../../admin/src/lib/page-metadata";
const require = createRequire(import.meta.url);
const server = require("../../functions/lib/data-hub-reporting.js");
const snapshot = require("../../functions/lib/publish-snapshot.js");
const metadata = require("../../functions/lib/content-metadata.js");
const documentContract = require("../../functions/lib/content-document-contract.js");
const mapping = () => ({ ...emptyReportingMapping(), posts: { tags: ["wages"], categories: [] },
  spotlight: { tags: [{ id: 25890, slug: "minimum-wage", label: "Minimum wage" }], categories: [] } });
const config = () => ({ ...emptyDataHubReporting(), figures: { minimumwage: mapping() } });
const now = Date.parse("2026-10-22T12:00:00Z");
const story = (id: string, extra: Partial<ReportingStory> = {}): ReportingStory => ({ source: "posts", id,
  href: `https://njpbs.org/posts/story-${id}/`, title: `Story ${id}`, publishedAt: "2026-10-20T12:00:00Z", tags: ["wages"], categories: [], ...extra });

describe("staff-owned Data Hub reporting", () => {
  it("round-trips through metadata, document contract and snapshot formatting", () => {
    const document = { title: "Data Hub", blocks: [], dataHubReporting: config() };
    expect(metadata.validateKnownMetadata(document)).toBeNull();
    expect(documentContract.unsupportedContentFields("cmsPages", "page", document)).toEqual([]);
    expect(documentContract.unsupportedContentFields("cmsPages", "page", { ...document, unknownRoot: true })).toEqual(["unknownRoot"]);
    expect(snapshot.PAGE_METADATA_FIELDS).toContain("dataHubReporting");
    const frozen = snapshot.createPublishedSnapshot({ collection: "cmsPages", document: { ...document, id: "data-hub", version: 1 }, publishedAt: "2026-10-22T12:00:00Z", publishedBy: "editor" });
    expect(frozen.metadata.dataHubReporting).toEqual(document.dataHubReporting);
    const edit = pageMetadataFromDocument("contact", document);
    expect(pageMetadataSaveDocument(edit).dataHubReporting).toEqual(document.dataHubReporting);
    expect(server.parseDataHubReporting(document.dataHubReporting)).toEqual(parseDataHubReporting(document.dataHubReporting));
    const detached = parseDataHubReporting(document.dataHubReporting)!;
    detached.figures.minimumwage!.posts.tags.push("draft");
    expect(document.dataHubReporting.figures.minimumwage.posts.tags).toEqual(["wages"]);
  });
  it.each([
    (x: any) => { x.schemaVersion = 2; },
    (x: any) => { x.figures.unknown = mapping(); },
    (x: any) => { x.figures.minimumwage.posts.tags = ["format:interactive"]; },
    (x: any) => { x.figures.minimumwage.posts.tags = Array(6).fill("wages"); },
    (x: any) => { x.figures.minimumwage.posts.tags = ["wages", "wages"]; },
    (x: any) => { x.figures.minimumwage.spotlight.tags[0].id = -1; },
    (x: any) => { x.figures.minimumwage.spotlight.tags[0].script = "bad"; },
    (x: any) => { x.figures.minimumwage.pins = [{ source: "posts", id: "a" }]; x.figures.minimumwage.hidden = [{ source: "posts", id: "a" }]; },
    (x: any) => { x.featured = { inheritFigure: false }; },
  ])("refuses malformed content in both consumers", mutate => {
    const value = config(); mutate(value);
    expect(() => parseDataHubReporting(value)).toThrow();
    expect(() => server.parseDataHubReporting(value)).toThrow();
    expect(metadata.validateKnownMetadata({ dataHubReporting: value })).toBeTypeOf("string");
  });
  it("uses explicit OR terms, descending dates and the shared three-story cap", () => {
    const candidates = [story("a"), story("b", { publishedAt: "2026-10-21T12:00:00Z" }), story("c"), story("d"),
      story("e", { tags: [], title: "wages in the headline do not match" }),
      story("24", { source: "spotlight", href: "https://www.njspotlightnews.org/2026/10/wages/", tags: [25890], publishedAt: "2026-10-22T10:00:00Z" }),
      story("future", { publishedAt: "2027-01-01T00:00:00Z" })];
    expect(selectReportingStories(mapping(), candidates, now).map(item => item.id)).toEqual(["24", "b", "a"]);
    expect(server.selectReportingStories(mapping(), candidates, now)).toEqual(selectReportingStories(mapping(), candidates, now));
  });
  it("pins only available public candidates, hides stories, and never refills from saved reporting", () => {
    const selected = { ...mapping(), pins: [{ source: "posts" as const, id: "d" }, { source: "posts" as const, id: "withdrawn" }],
      hidden: [{ source: "posts" as const, id: "b" }] };
    expect(selectReportingStories(selected, [story("a"), story("b"), story("d", { tags: [] })], now).map(item => item.id)).toEqual(["d", "a"]);
    expect(selectReportingStories(selected, [], now)).toEqual([]);
  });
  it("prefers a Boardwalk copy while preserving a Spotlight pin's place and note", () => {
    const href = "https://www.njspotlightnews.org/2026/10/wages/";
    const selected = { ...mapping(), pins: [{ source: "spotlight" as const, id: "24", note: "Relevant context" }] };
    const results = selectReportingStories(selected, [story("24", { source: "spotlight", href, tags: [25890] }),
      story("copy", { canonicalHref: href, publishedAt: "2026-10-19T00:00:00Z" })], now);
    expect(results).toMatchObject([{ id: "copy", source: "posts", note: "Relevant context" }]);
  });
  it("hides every canonical copy, including copies imported after the editorial hide", () => {
    const href = "https://www.njspotlightnews.org/2026/10/wages/";
    const selected = { ...mapping(), hidden: [{ source: "posts" as const, id: "copy", canonicalHref: href }] };
    const original = story("24", { source: "spotlight", href, tags: [25890] });
    expect(selectReportingStories(selected, [original, story("copy", { canonicalHref: href })], now)).toEqual([]);
    expect(selectReportingStories(selected, [original], now)).toEqual([]);
    const hiddenOriginal = { ...mapping(), hidden: [{ source: "spotlight" as const, id: "24", canonicalHref: href }] };
    expect(selectReportingStories(hiddenOriginal, [story("futurecopy", { canonicalHref: href })], now)).toEqual([]);
  });
  it.each(["https://evil.example/posts/a/", "https://njpbs.org.evil.example/posts/a/", `https://fixture-user@${"njpbs.org"}/posts/a/`,
    "https://njpbs.org:8443/posts/a/", "https://njpbs.org/posts/%2e%2e/a/", "javascript:alert(1)",
    "https://www.njspotlightnews.org/wp-admin/", "https://njpbs.org/posts/a/?next=evil"])("rejects unsafe story destination %s", url => {
    expect(reportingStoryUrl(url)).toBeNull();
  });
  it("normalizes the two news origins", () => {
    expect(reportingStoryUrl("https://www.njpbs.org/posts/a/")).toBe("https://njpbs.org/posts/a/");
    expect(reportingStoryUrl("https://njspotlightnews.org/2026/10/a/")).toBe("https://www.njspotlightnews.org/2026/10/a/");
  });
});
