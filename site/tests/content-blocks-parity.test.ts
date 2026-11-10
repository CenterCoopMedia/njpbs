import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { parseBlocks as parseBlocksTs } from "../../packages/content-core/src/content-model";

// The Cloud Functions runtime is CommonJS and cannot import the TypeScript content
// model, so functions/lib/content-blocks.js hand-mirrors parseBlocks. This test is
// the pin: it feeds one shared case table through the canonical TS parseBlocks and
// the CJS mirror and asserts identical { ok, error } results, so the server's
// block validation cannot silently fork the semantics the editor and renderer
// share. createRequire loads the CJS module through Node directly, bypassing
// Vite's module graph.
const require = createRequire(import.meta.url);
const { parseBlocks: parseBlocksCjs } = require("../../functions/lib/content-blocks.js");

// A well-formed TipTap document, the shape prose/faq/card bodies must carry.
const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const videoHash = "0123456789abcdef".repeat(4);
const videoPublic = {
  url: `https://media.njpbs.org/cms-media/video/abc123/${videoHash}.mp4`,
  posterUrl: `https://media.njpbs.org/cms-media/video/abc123/${videoHash}.jpg`,
  width: 1920,
  height: 1080,
  mimeType: "video/mp4",
};
const videoCase = (name: string, data: unknown) => ({
  name,
  input: [{ id: "v", type: "video", order: 0, visible: true, data }],
});

// A valid block of every catalog type, so the accept path is exercised per type.
const validBlocks = [
  { id: "h", type: "headline", order: 0, visible: true, data: { text: "Tonight", level: 2 } },
  { id: "h2", type: "headline", order: 1, visible: true, data: { text: "No level" } },
  { id: "p", type: "prose", order: 2, visible: true, data: { content: doc("Body") } },
  { id: "img", type: "image", order: 3, visible: false, section: "hero", data: { assetId: "a1", alt: "Alt", caption: "Cap" } },
  { id: "gal", type: "image_gallery", order: 4, visible: true, data: { images: [{ itemId: "image-1", assetId: "a2", alt: "A" }] } },
  { id: "cta", type: "cta_row", order: 5, visible: true, data: { ctas: [{ label: "Give", href: "https://x", variant: "primary" }] } },
  { id: "cards", type: "card_grid", order: 6, visible: true, data: { cards: [{ itemId: "card-1", label: "Watch", title: "T", body: doc("b"), href: "/x" }] } },
  { id: "link", type: "link_card", order: 17, visible: true, data: { title: "Story", url: "https://example.com/story", source: "Outlet", date: "2026-09-17", summary: "Summary" } },
  { id: "faq", type: "faq_item", order: 7, visible: true, data: { question: "Q?", answer: doc("A") } },
  { id: "coverage", type: "coverage_list", order: 16, visible: true, data: { entries: [{ title: "Story", outlet: "Outlet", date: "2026-09-17", url: "https://example.com/story" }] } },
  { id: "emb", type: "embed", order: 8, visible: true, data: { url: "https://y", host: "youtube", caption: "c", width: 640, height: 360 } },
  { id: "ap-map", type: "embed", order: 28, visible: true, data: { url: "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html", heading: "June archive", caption: "June 2 primary", mapSize: "large", mobileHeight: 1100, mapWidth: "wide" } },
  { id: "shelf", type: "content_shelf", order: 9, visible: true, data: { title: "Featured", source: "pbs_featured", itemLimit: 8, moreLabel: "Browse all", moreHref: "/watch/" } },
  { id: "topic", type: "topic_shelf", order: 10, visible: true, data: { title: "More on Delaney Hall", topic: "delaney-hall", source: "njpbs_related_index", itemLimit: 4, sort: "newest", pinned: [{ id: "a-story" }] } },
  { id: "topic2", type: "topic_shelf", order: 11, visible: true, data: { title: "Related", topic: "budget", source: "njpbs_related_index", itemLimit: 12, sort: "curated" } },
  { id: "play", type: "video_playlist", order: 12, visible: true, data: { title: "Watch", topic: "immigration", library: "njpbs_watch", itemLimit: 6, sort: "oldest" } },
  { id: "sponsors", type: "sponsor_strip", order: 18, visible: true, data: { heading: "Sponsors", sponsorIds: ["sponsor-1"], layout: "row" } },
  { id: "promo", type: "promotion_playlist", order: 13, visible: true, data: { title: "Remembering Dolly Parton", placement: "before_featured", cards: [
    { itemId: "promo-1", title: "Program one", summary: "Summary one", imageAssetId: "promo-a", alt: "Program one", href: "/watch/one/" },
    { itemId: "promo-2", title: "Program two", summary: "Summary two", imageAssetId: "promo-b", alt: "Program two", href: "https://www.pbs.org/video/two/" },
    { itemId: "promo-3", title: "Program three", summary: "Summary three", imageAssetId: "promo-c", alt: "", altDecorative: true, href: "/watch/three/" },
  ] } },
  { id: "newsletter", type: "newsletter_signup", order: 18, visible: true, data: { newsletterIds: ["newsletter-one"], heading: "Get updates" } },
  { id: "table", type: "data_table", order: 14, visible: true, data: { title: "County population", csv: "County,Population\nEssex,854917", source: "U.S. Census Bureau", sourceHref: "https://www.census.gov/" } },
  { id: "div", type: "divider", order: 15, visible: true, data: {} },
  { id: "vid", type: "video", order: 19, visible: true, data: { sourceId: "video-library", assetId: "abc123", title: "Clip" } },
  { id: "vid2", type: "video", order: 20, visible: true, data: { sourceId: "video-library", assetId: "abc123", title: "Clip", caption: "A caption", public: videoPublic } },
  { id: "record", type: "record_card", order: 18, visible: true, data: { recordKind: "program", recordId: "program_1", variant: "compact" } },
];

// Each case is an input the two implementations must judge identically. The reject
// cases walk every envelope guard and a representative per-type data failure.
const cases: Array<{ name: string; input: unknown }> = [
  { name: "record card missing id", input: [{ id: "record", type: "record_card", order: 0, visible: true, data: { recordKind: "event", recordId: "" } }] },
  { name: "record card invalid id shape", input: [{ id: "record", type: "record_card", order: 0, visible: true, data: { recordKind: "event", recordId: "bad/id" } }] },
  { name: "record card unknown kind", input: [{ id: "record", type: "record_card", order: 0, visible: true, data: { recordKind: "post", recordId: "post_1" } }] },
  { name: "record card invalid variant", input: [{ id: "record", type: "record_card", order: 0, visible: true, data: { recordKind: "sponsor", recordId: "sponsor_1", variant: "wide" } }] },
  { name: "sponsor strip duplicate", input: [{ id: "s", type: "sponsor_strip", order: 0, visible: true, data: { sponsorIds: ["a", "a"], layout: "row" } }] },
  { name: "sponsor strip over limit", input: [{ id: "s", type: "sponsor_strip", order: 0, visible: true, data: { sponsorIds: Array.from({ length: 13 }, (_, index) => `s${index}`), layout: "grid" } }] },
  videoCase("video source is not the video library", { sourceId: "media-library", assetId: "abc123", title: "Clip" }),
  videoCase("video smuggles an extra key", { sourceId: "video-library", assetId: "abc123", title: "Clip", url: "https://media.njpbs.org/x.mp4" }),
  videoCase("video public url has a query string", { sourceId: "video-library", assetId: "abc123", title: "Clip", public: { ...videoPublic, url: `${videoPublic.url}?x=1` } }),
  videoCase("video public url is on another host", { sourceId: "video-library", assetId: "abc123", title: "Clip", public: { ...videoPublic, url: videoPublic.url.replace("media.njpbs.org", "example.com") } }),
  videoCase("video public carries an extra key", { sourceId: "video-library", assetId: "abc123", title: "Clip", public: { ...videoPublic, extra: 1 } }),
  { name: "empty array", input: [] },
  // The mirror is a hand copy, so a field added on one side is the drift this table exists
  // to catch. Both the accept and the two reject shapes are pinned.
  {
    name: "decorative image",
    input: [{ id: "a", type: "image", order: 0, visible: true, data: { assetId: "a1", alt: "", altDecorative: true } }],
  },
  {
    name: "promotion card with empty alt text",
    input: [{ id: "a", type: "promotion_playlist", order: 0, visible: true, data: { title: "Remembering Dolly Parton", placement: "before_featured", cards: [
      { itemId: "promo-1", title: "Program one", summary: "Summary one", imageAssetId: "promo-a", alt: "", href: "/watch/one/" },
    ] } }],
  },
  {
    name: "decorative gallery item",
    input: [{ id: "a", type: "image_gallery", order: 0, visible: true, data: { images: [{ assetId: "a1", alt: "", altDecorative: true }] } }],
  },
  // The gallery presentation mode (#1034). The server accepting a mode the site parser refuses
  // would let a save through that the next public build cannot read, so both sides judge it alike.
  {
    name: "gallery with no stored presentation",
    input: [{ id: "a", type: "image_gallery", order: 0, visible: true, data: { images: [{ assetId: "a1", alt: "A" }] } }],
  },
  {
    name: "gallery in grid presentation",
    input: [{ id: "a", type: "image_gallery", order: 0, visible: true, data: { images: [], presentation: "grid" } }],
  },
  {
    name: "gallery in carousel presentation",
    input: [{ id: "a", type: "image_gallery", order: 0, visible: true, data: { images: [], presentation: "carousel" } }],
  },
  {
    name: "gallery in an unknown presentation",
    input: [{ id: "a", type: "image_gallery", order: 0, visible: true, data: { images: [], presentation: "masonry" } }],
  },
  {
    name: "gallery with a non-string presentation",
    input: [{ id: "a", type: "image_gallery", order: 0, visible: true, data: { images: [], presentation: 2 } }],
  },
  {
    name: "image both decorative and described",
    input: [{ id: "a", type: "image", order: 0, visible: true, data: { assetId: "a1", alt: "A reporter", altDecorative: true } }],
  },
  {
    name: "linked image",
    input: [{ id: "a", type: "image", order: 0, visible: true, data: { assetId: "a1", alt: "Watch", href: "https://youtu.be/abc", newTab: true } }],
  },
  {
    name: "decorative image with a link",
    input: [{ id: "a", type: "image", order: 0, visible: true, data: { assetId: "a1", alt: "", altDecorative: true, href: "/live/" } }],
  },
  {
    name: "image with a non-boolean new-tab flag",
    input: [{ id: "a", type: "image", order: 0, visible: true, data: { assetId: "a1", alt: "Watch", href: "/live/", newTab: "yes" } }],
  },
  {
    name: "non-boolean decorative flag",
    input: [{ id: "a", type: "image", order: 0, visible: true, data: { assetId: "a1", alt: "", altDecorative: "yes" } }],
  },
  { name: "all valid block types", input: validBlocks },
  { name: "not an array", input: { blocks: [] } },
  { name: "null entry", input: [null] },
  { name: "string entry", input: ["nope"] },
  { name: "unknown type", input: [{ id: "a", type: "spacer", order: 0, visible: true, data: {} }] },
  { name: "missing id", input: [{ type: "divider", order: 0, visible: true, data: {} }] },
  { name: "empty id", input: [{ id: "", type: "divider", order: 0, visible: true, data: {} }] },
  {
    name: "duplicate id",
    input: [
      { id: "dup", type: "divider", order: 0, visible: true, data: {} },
      { id: "dup", type: "divider", order: 1, visible: true, data: {} },
    ],
  },
  { name: "non-number order", input: [{ id: "a", type: "divider", order: "0", visible: true, data: {} }] },
  { name: "NaN order", input: [{ id: "a", type: "divider", order: NaN, visible: true, data: {} }] },
  { name: "non-boolean visible", input: [{ id: "a", type: "divider", order: 0, visible: "yes", data: {} }] },
  { name: "non-string section", input: [{ id: "a", type: "divider", order: 0, visible: true, section: 3, data: {} }] },
  { name: "missing data object", input: [{ id: "a", type: "divider", order: 0, visible: true, data: null }] },
  { name: "array data", input: [{ id: "a", type: "divider", order: 0, visible: true, data: [] }] },
  { name: "headline level is a string", input: [{ id: "a", type: "headline", order: 0, visible: true, data: { text: "x", level: "two" } }] },
  { name: "headline text missing", input: [{ id: "a", type: "headline", order: 0, visible: true, data: { level: 2 } }] },
  { name: "prose content is a string", input: [{ id: "a", type: "prose", order: 0, visible: true, data: { content: "<p>x</p>" } }] },
  { name: "prose content is a broken tree", input: [{ id: "a", type: "prose", order: 0, visible: true, data: { content: { type: "doc", content: [null] } } }] },
  { name: "image alt missing", input: [{ id: "a", type: "image", order: 0, visible: true, data: { assetId: "x" } }] },
  { name: "gallery image invalid", input: [{ id: "a", type: "image_gallery", order: 0, visible: true, data: { images: [{ assetId: "x" }] } }] },
  { name: "gallery item id is empty", input: [{ id: "a", type: "image_gallery", order: 0, visible: true, data: { images: [{ itemId: "", assetId: "x", alt: "A" }] } }] },
  { name: "gallery repeats an item id", input: [{ id: "a", type: "image_gallery", order: 0, visible: true, data: { images: [{ itemId: "same", assetId: "x", alt: "A" }, { itemId: "same", assetId: "y", alt: "B" }] } }] },
  { name: "cta bad variant", input: [{ id: "a", type: "cta_row", order: 0, visible: true, data: { ctas: [{ label: "x", href: "y", variant: "tertiary" }] } }] },
  { name: "card body wrong shape", input: [{ id: "a", type: "card_grid", order: 0, visible: true, data: { cards: [{ title: "t", body: "x" }] } }] },
  { name: "card label wrong shape", input: [{ id: "a", type: "card_grid", order: 0, visible: true, data: { cards: [{ label: 42, title: "t" }] } }] },
  { name: "card item id is not a string", input: [{ id: "a", type: "card_grid", order: 0, visible: true, data: { cards: [{ itemId: 42, title: "t" }] } }] },
  { name: "card grid repeats an item id", input: [{ id: "a", type: "card_grid", order: 0, visible: true, data: { cards: [{ itemId: "same", title: "First" }, { itemId: "same", title: "Second" }] } }] },
  { name: "link card date is not a calendar day", input: [{ id: "a", type: "link_card", order: 0, visible: true, data: { title: "Story", url: "https://example.com/story", date: "September 17, 2026" } }] },
  { name: "visible link card title is empty", input: [{ id: "a", type: "link_card", order: 0, visible: true, data: { title: "", url: "https://example.com/story" } }] },
  { name: "visible link card destination is unsafe", input: [{ id: "a", type: "link_card", order: 0, visible: true, data: { title: "Story", url: "javascript:alert(1)" } }] },
  { name: "link card smuggles an extra key", input: [{ id: "a", type: "link_card", order: 0, visible: true, data: { title: "Story", url: "https://example.com/story", outlet: "Outlet" } }] },
  { name: "faq answer missing", input: [{ id: "a", type: "faq_item", order: 0, visible: true, data: { question: "q" } }] },
  { name: "coverage list date is not a calendar day", input: [{ id: "a", type: "coverage_list", order: 0, visible: true, data: { entries: [{ title: "Story", outlet: "Outlet", date: "September 17, 2026", url: "https://example.com/story" }] } }] },
  { name: "coverage list keeps an incomplete draft", input: [{ id: "a", type: "coverage_list", order: 0, visible: true, data: { entries: [] } }] },
  { name: "coverage list smuggles an extra entry key", input: [{ id: "a", type: "coverage_list", order: 0, visible: true, data: { entries: [{ title: "Story", outlet: "", date: "", url: "", note: "no" }] } }] },
  { name: "embed url missing", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { host: "x" } }] },
  { name: "AP map heading is not text", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { url: "https://example.test/", heading: 42 } }] },
  { name: "AP map size is unknown", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { url: "https://example.test/", mapSize: "huge" } }] },
  { name: "AP map size is an array", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { url: "https://example.test/", mapSize: ["small"] } }] },
  { name: "AP map width is unknown", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { url: "https://example.test/", mapWidth: "full" } }] },
  { name: "AP map mobile height is too short", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { url: "https://example.test/", mobileHeight: 319 } }] },
  { name: "AP map mobile height is too tall", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { url: "https://example.test/", mobileHeight: 4097 } }] },
  { name: "AP map mobile height is fractional", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { url: "https://example.test/", mobileHeight: 700.5 } }] },
  { name: "embed width is zero", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { url: "https://youtu.be/od8NMua_mEw", width: 0 } }] },
  { name: "embed width is too small", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { url: "https://youtu.be/od8NMua_mEw", width: 159 } }] },
  { name: "embed height is fractional", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { url: "https://youtu.be/od8NMua_mEw", height: 315.5 } }] },
  { name: "embed width exceeds the limit", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { url: "https://youtu.be/od8NMua_mEw", width: 4097 } }] },
  { name: "embed ratio is too tall", input: [{ id: "a", type: "embed", order: 0, visible: true, data: { url: "https://youtu.be/od8NMua_mEw", width: 160, height: 4096 } }] },
  { name: "content shelf source is open-ended", input: [{ id: "a", type: "content_shelf", order: 0, visible: true, data: { title: "Featured", source: "custom_query", itemLimit: 8, moreLabel: "Browse all", moreHref: "/watch/" } }] },
  { name: "content shelf limit is outside the finite contract", input: [{ id: "a", type: "content_shelf", order: 0, visible: true, data: { title: "Featured", source: "pbs_featured", itemLimit: 100, moreLabel: "Browse all", moreHref: "/watch/" } }] },
  // The dynamic shelves (#1046). The server accepting a topic, source, library, cap,
  // sort, or pin list the site parser refuses would store a query the next public build
  // cannot resolve, so every bound is judged identically on both sides.
  { name: "topic shelf topic is off the approved list", input: [{ id: "a", type: "topic_shelf", order: 0, visible: true, data: { title: "T", topic: "anything-i-type", source: "njpbs_related_index", itemLimit: 4, sort: "newest" } }] },
  { name: "topic shelf source is open-ended", input: [{ id: "a", type: "topic_shelf", order: 0, visible: true, data: { title: "T", topic: "budget", source: "wordpress_query", itemLimit: 4, sort: "newest" } }] },
  { name: "topic shelf cap is outside the finite contract", input: [{ id: "a", type: "topic_shelf", order: 0, visible: true, data: { title: "T", topic: "budget", source: "njpbs_related_index", itemLimit: 500, sort: "newest" } }] },
  { name: "topic shelf sort is one nothing implements", input: [{ id: "a", type: "topic_shelf", order: 0, visible: true, data: { title: "T", topic: "budget", source: "njpbs_related_index", itemLimit: 4, sort: "most_active" } }] },
  { name: "topic shelf smuggles a free-text query", input: [{ id: "a", type: "topic_shelf", order: 0, visible: true, data: { title: "T", topic: "budget", source: "njpbs_related_index", itemLimit: 4, sort: "newest", query: "tag:anything" } }] },
  { name: "topic shelf pins past the cap", input: [{ id: "a", type: "topic_shelf", order: 0, visible: true, data: { title: "T", topic: "budget", source: "njpbs_related_index", itemLimit: 4, sort: "newest", pinned: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }, { id: "6" }, { id: "7" }] } }] },
  { name: "topic shelf repeats a pin", input: [{ id: "a", type: "topic_shelf", order: 0, visible: true, data: { title: "T", topic: "budget", source: "njpbs_related_index", itemLimit: 4, sort: "newest", pinned: [{ id: "1" }, { id: "1" }] } }] },
  { name: "topic shelf pin carries an extra key", input: [{ id: "a", type: "topic_shelf", order: 0, visible: true, data: { title: "T", topic: "budget", source: "njpbs_related_index", itemLimit: 4, sort: "newest", pinned: [{ id: "1", href: "https://x" }] } }] },
  { name: "video playlist library is not an approved one", input: [{ id: "a", type: "video_playlist", order: 0, visible: true, data: { title: "T", topic: "budget", library: "youtube", itemLimit: 4, sort: "newest" } }] },
  { name: "video playlist bakes copied items into the block", input: [{ id: "a", type: "video_playlist", order: 0, visible: true, data: { title: "T", topic: "budget", library: "njpbs_watch", itemLimit: 4, sort: "newest", items: [{ title: "stale copy" }] } }] },
  { name: "video playlist wears the story shelf's source key", input: [{ id: "a", type: "video_playlist", order: 0, visible: true, data: { title: "T", topic: "budget", source: "njpbs_related_index", library: "njpbs_watch", itemLimit: 4, sort: "newest" } }] },
  { name: "promotion playlist has fewer than three cards", input: [{ id: "a", type: "promotion_playlist", order: 0, visible: true, data: { title: "Timely programs", placement: "before_featured", cards: [] } }] },
  { name: "hidden promotion playlist can keep an incomplete draft", input: [{ id: "a", type: "promotion_playlist", order: 0, visible: false, data: { title: "", placement: "before_featured", cards: [
    { itemId: "draft-card", title: "", summary: "", imageAssetId: "", alt: "", href: "" },
  ] } }] },
  { name: "promotion playlist uses an unsafe card link", input: [{ id: "a", type: "promotion_playlist", order: 0, visible: true, data: { title: "Timely programs", placement: "before_featured", cards: [
    { itemId: "1", title: "One", summary: "One", imageAssetId: "a", alt: "One", href: "/one/" },
    { itemId: "2", title: "Two", summary: "Two", imageAssetId: "b", alt: "Two", href: "javascript:alert(1)" },
    { itemId: "3", title: "Three", summary: "Three", imageAssetId: "c", alt: "Three", href: "/three/" },
  ] } }] },
  { name: "divider carries data", input: [{ id: "a", type: "divider", order: 0, visible: true, data: { extra: 1 } }] },
];

describe("the CJS block validator mirrors the canonical parseBlocks (#514/#515 write path)", () => {
  it.each(cases)("agrees on $name", ({ input }) => {
    const ts = parseBlocksTs(input);
    const cjs = parseBlocksCjs(input);
    // ok must match, and when either rejects, the error string must match too --
    // so a divergence in a rejection reason fails the pin, not just a verdict flip.
    expect(cjs.ok).toBe(ts.ok);
    if (!ts.ok || !cjs.ok) {
      expect((cjs as { error?: string }).error).toBe((ts as { error?: string }).error);
    }
  });

  it("both accept the full valid set", () => {
    expect(parseBlocksTs(validBlocks).ok).toBe(true);
    expect(parseBlocksCjs(validBlocks).ok).toBe(true);
  });

  it("both reject source-owned fields copied into a content shelf", () => {
    const copiedShelf = [{
      id: "shelf",
      type: "content_shelf",
      order: 0,
      visible: true,
      data: {
        title: "Featured",
        source: "pbs_featured",
        itemLimit: 8,
        moreLabel: "Browse all",
        moreHref: "/watch/",
        items: [{ title: "A stale copied card" }],
        cards: [{ title: "Another stale copied card" }],
      },
    }];
    const rejection = {
      ok: false,
      error: "blocks[0] has invalid data for content_shelf",
    };

    expect(parseBlocksTs(copiedShelf)).toEqual(rejection);
    expect(parseBlocksCjs(copiedShelf)).toEqual(rejection);
  });
});


it("both parsers keep incomplete visible drafts typed without admitting them for publication", () => {
  const blocks = [{ id: "draft-shelf", type: "promotion_playlist", order: 0, visible: true,
    data: { title: "", placement: "before_featured", cards: [] } }];
  for (const parse of [parseBlocksTs, parseBlocksCjs]) {
    expect(parse(blocks, { complete: false }).ok).toBe(true);
    expect(parse(blocks).ok).toBe(false);
    expect(parse([{ ...blocks[0], data: { ...blocks[0].data, title: 42 } }], { complete: false }).ok).toBe(false);
  }
});

it("both parsers keep an incomplete link card draft and reject it from publication", () => {
  const blocks = [{
    id: "draft-link",
    type: "link_card",
    order: 0,
    visible: true,
    data: { title: "", url: "javascript:alert(1)" },
  }];
  for (const parse of [parseBlocksTs, parseBlocksCjs]) {
    expect(parse(blocks, { complete: false }).ok).toBe(true);
    expect(parse(blocks).ok).toBe(false);
  }
});

it.each([
  "https://user:secret@example.test/",
  "http://user@example.test/",
  "https://:secret@example.test/",
  "HTTPS://us%65r:p%40ss@example.test/",
  "https://",
])("both publication parsers refuse unsafe web links: %s", (href) => {
  const inputs = [
    [{ id: "link", type: "link_card", order: 0, visible: true, data: { title: "Story", url: href } }],
    [{ id: "promo", type: "promotion_playlist", order: 0, visible: true, data: {
      title: "Programs", placement: "before_featured", cards: [
        { itemId: "one", title: "Program", summary: "Summary", imageAssetId: "image", alt: "Program", href },
      ],
    } }],
  ];
  for (const input of inputs) {
    expect(parseBlocksTs(input).ok).toBe(false);
    expect(parseBlocksCjs(input)).toEqual(parseBlocksTs(input));
  }
});


describe("incomplete record card drafts", () => {
  it("accepts an unselected card only in an incomplete save", () => {
    const input = [{ id: "card", type: "record_card", order: 0, visible: true, data: { recordKind: "program", recordId: "" } }];
    for (const parse of [parseBlocksTs, parseBlocksCjs]) {
      expect(parse(input, { complete: false }).ok).toBe(true);
      expect(parse(input, { complete: true }).ok).toBe(false);
    }
  });
});


describe("Kids record card policy", () => {
  it("rejects newsletter cards on Kids for both draft and publish", () => {
    const cards = [{ id: "card", type: "record_card", order: 0, visible: true,
      data: { recordKind: "newsletter", recordId: "newsletter_1" } }];
    for (const parser of [parseBlocksTs, parseBlocksCjs]) {
      expect(parser(cards, { pageId: "kids", complete: false })).toMatchObject({ ok: false });
      expect(parser(cards, { pageId: "kids" })).toMatchObject({ ok: false });
      expect(parser(cards, { pageId: "about", complete: false }).ok).toBe(true);
    }
  });
});
