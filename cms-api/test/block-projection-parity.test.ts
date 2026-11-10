import { describe, expect, it } from "vitest";
import { BLOCK_TYPES, parseBlocks, type BlockType, type PageBlock, type RichTextDoc } from "../../packages/content-core/src/content-model";
import { SECTION_BLOCK_CATALOG } from "../../packages/content-core/src/editor-admin";
import { HOME_NEWSCAST_DEFAULTS } from "../../packages/content-core/src/home-newscast-data";
import { publicPage, type PublicPageId } from "../../packages/content-core/src/public-pages";
import { electionRace } from "../../tests/fixtures/election-results";
import capturedElectionBlock from "../../site/tests/fixtures/election-results-hub.json";
import { fetchPublicPageProjection, selectedBlock, type CmsApiEnv } from "../src/index";
import { LIVE } from "./fixtures/published-page";

const doc: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Published copy" }] }] };
const image = { assetId: "photo", alt: "Published photo", caption: "Photo credit" };
const videoHash = "a".repeat(64);
// Payloads follow the canonical content-model and published-content fixture shapes.
const data = {
  bio_card: { profileId: "person-one", kind: "person", name: "Example person", role: "State senator",
    summary: "Serves the district.", sourceUrl: "https://example.org/biography", sourceLabel: "Official biography",
    asOf: "2026-10-03", party: "Independent", area: "District 1", image },
  town_lookup: { heading: "Past results", introduction: "Compare elections.", sourceLine: "NJ Spotlight News" },
  data_table: { title: "Population", csv: "County,Population\nEssex,854917", source: "Census", sourceHref: "https://www.census.gov/" },
  data_figure: { datasetId: "jobs-rate", version: { mode: "pinned", releaseId: "september-2026" }, display: "expanded" },
  election_results: { races: [electionRace({ status: "called", sourceKind: "ap", calledCandidateId: "ellis",
    apCallUrl: "https://apnews.com/example", expectedVoteShare: 0.75,
    candidates: [{ id: "ellis", name: "Jordan Ellis", party: "Independent", votes: 620, share: 62, photo: image },
      { id: "rivera", name: "Morgan Rivera", votes: 380, share: 38 }] })] },
  county_comparison: { datasetVersion: "nj-federal-counties-2020-2024-v1", heading: "Counties", intro: "Compare results.", source: "NJ Spotlight News" },
  data_hub_section: { sectionId: "unemployment", heading: "Jobs", introduction: "Employment figures." },
  row: { columns: [6, 6] },
  headline: { text: "Published heading", level: 2 },
  prose: { content: doc },
  image,
  video: { sourceId: "video-library", assetId: "video-one", title: "Published video", caption: "Video caption",
    public: { url: `https://media.njpbs.org/cms-media/video/video-one/${videoHash}.mp4`,
      posterUrl: `https://media.njpbs.org/cms-media/video/video-one/${videoHash}.jpg`, width: 1920, height: 1080, mimeType: "video/mp4" } },
  image_gallery: { images: [image], presentation: "carousel" },
  cta_row: { ctas: [{ label: "Watch", href: "/watch/", variant: "primary" }] },
  support_appeal: { heading: "Support NJ PBS", copy: "Help local stories.", buttonLabel: "Donate", href: "/support/", style: "blue", backgroundImageAssetId: "photo" },
  card_grid: { cards: [{ title: "Program", imageAssetId: "photo", href: "/watch/", body: doc }] },
  link_card: { title: "Coverage", url: "https://example.org/story", source: "Example news", date: "2026-10-03", summary: "Story summary" },
  document_list: { documents: [{ itemId: "notice", assetId: "pdf", title: "Board notice", publisher: "njpba", addedAt: "2026-10-07T12:00:00.000Z" }] },
  faq_item: { question: "How can I watch?", answer: doc },
  coverage_list: { entries: [{ title: "Coverage", outlet: "Example news", date: "2026-10-03", url: "https://example.org/story" }] },
  embed: { url: "https://player.pbs.org/example", width: 640, height: 360 },
  html: { html: "<p>Published widget</p>", title: "Widget" },
  content_shelf: { title: "Featured", source: "pbs_featured", itemLimit: 8, moreLabel: "Browse all", moreHref: "/watch/" },
  promotion_playlist: { title: "Watch next", placement: "before_more", cards: [{ itemId: "program", title: "Program",
    summary: "Program summary", imageAssetId: "photo", alt: "Program photo", href: "/watch/" }] },
  newsletter_signup: { newsletterIds: ["newsletter-one"], heading: "Get updates", intro: "News in your inbox." },
  home_newscast: HOME_NEWSCAST_DEFAULTS,
  topic_shelf: { title: "More coverage", topic: "budget", source: "njpbs_related_index", itemLimit: 4, sort: "newest" },
  video_playlist: { title: "Watch", topic: "budget", library: "njpbs_watch", itemLimit: 4, sort: "newest" },
  record_card: { recordKind: "program", recordId: "program-one", variant: "compact" },
  sponsor_strip: { heading: "Our sponsors", sponsorIds: ["sponsor-one"], layout: "grid" },
  divider: {},
} satisfies { [T in BlockType]: Extract<PageBlock, { type: T }>["data"] };

function block(type: BlockType): PageBlock {
  const parsed = parseBlocks([{ id: type, type, order: 0, visible: true, data: data[type],
    ...(type === "home_newscast" ? { section: "home-newscast" } : {}) }]);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.blocks[0];
}

const env: CmsApiEnv = {
  ALLOW_LOCAL_ORIGINS: "false", CMS_EDGE_ORIGIN_SECRET: "synthetic-parity-edge",
  FIREBASE_PROJECT_ID: "njpbs-site", FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net",
  RATE_LIMITERS: {} as CmsApiEnv["RATE_LIMITERS"],
};
function read(pageId: PublicPageId, blocks: unknown[]) {
  const definition = publicPage(pageId)!;
  return fetchPublicPageProjection(env, pageId, { fetchOrigin: async () => Response.json({ ...LIVE,
    page: { ...LIVE.page, pageId, path: definition.path, family: definition.family, template: definition.editorTemplate,
      blocks, assets: { photo: { url: "https://media.njpbs.org/cms-media/photo.jpg", mimeType: "image/jpeg", width: 640, height: 480 },
        ...(blocks.some(entry => (entry as PageBlock).type === "document_list")
          ? { pdf: { url: "https://media.njpbs.org/cms-media/notice.pdf", mimeType: "application/pdf" } } : {}) } },
  }) });
}

describe("public block registry parity", () => {
  it("requires a payload fixture for every shared registry type", () => {
    expect(Object.keys(data).sort()).toEqual([...BLOCK_TYPES].sort());
  });

  it.each(BLOCK_TYPES)("preserves all public data for the validated %s catalog type", type => {
    const candidate = block(type);
    const selected = selectedBlock(candidate);
    expect(selected).toEqual(candidate);
    expect(selected.data).not.toBe(candidate.data);
    expect(parseBlocks([selected]).ok).toBe(true);
  });

  it.each(BLOCK_TYPES.filter(type => type !== "bio_card" && type !== "support_appeal"))("preserves %s through a published Page RPC", async type => {
    const pageId = type === "data_hub_section" ? "data-hub"
      : SECTION_BLOCK_CATALOG.genericPage.includes(type) ? "contact" : "home";
    const candidate = block(type);
    const result = await read(pageId, [candidate]);
    expect(result.state).toBe("live");
    if (result.state !== "live") throw new Error("Expected published Page");
    expect(result.page.blocks).toEqual([candidate]);
  });

  it("refuses the Post-only support appeal on a published Page", async () => {
    await expect(read("contact", [block("support_appeal")])).rejects.toThrow("Invalid projection");
  });

  it("keeps the captured election hub results block through the published Page RPC", async () => {
    const result = await read("contact", [capturedElectionBlock]);
    expect(result.state === "live" && result.page.blocks).toEqual([capturedElectionBlock]);
  });

  it("omits hidden blocks and private envelope fields from the published Page", async () => {
    const candidate = block("divider");
    const result = await read("contact", [{ ...candidate, privateField: "staff-only" },
      { ...candidate, id: "hidden", order: 1, visible: false }]);
    expect(result.state === "live" && result.page.blocks).toEqual([candidate]);
  });

  it.each(["home", "watch", "contact"] as const)("keeps Post-only bio cards out of %s", async pageId => {
    await expect(read(pageId, [block("bio_card")])).rejects.toThrow("Invalid projection");
  });

  it.each(["bio_card", "data_figure", "data_hub_section", "election_results", "home_newscast",
    "newsletter_signup", "record_card", "sponsor_strip", "video"] as const)("refuses undeclared %s data before selection", type => {
    const candidate = block(type);
    expect(parseBlocks([{ ...candidate, data: { ...candidate.data, privateField: "staff-only" } }]).ok).toBe(false);
  });
});
