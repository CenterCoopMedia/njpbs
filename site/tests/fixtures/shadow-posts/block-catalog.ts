// One published Post read per editor Post block type outside the original
// self-contained set, plus a row layout and a mixed Post. The parity test renders
// each through the full static build and the compiled build-free renderer. The
// contract test checks that this list covers the editor's Post catalog (#3409).
import prose from "./post.json";
import { electionRace } from "../../../../tests/fixtures/election-results";
import type { DatasetFigures } from "../../../../packages/content-core/src/dataset-figures";
import { uploadedImageUrl } from "./fixtures";

const base = prose.document.published;
const paragraph = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const portraitUrl = "https://media.njpbs.org/cms-media/news/portrait/hash.webp";
const assets = [
  { id: "upload", url: uploadedImageUrl, mimeType: "image/webp", width: 1600, height: 900 },
  { id: "portrait", url: portraitUrl, mimeType: "image/webp", width: 800, height: 800 },
];

export const figureProjection: DatasetFigures["releases"][number] = {
  datasetId: "jobs-rate", releaseId: "september-2026", revision: 1,
  digest: "a".repeat(64), approvedAt: "2026-10-06T14:00:00.000Z",
  release: {
    label: "New Jersey employment rate", unit: "percent", value: 4.2,
    period: { start: "2026-09-01", end: "2026-09-30", label: "September 2026" },
    geography: { level: "state", code: "NJ", label: "New Jersey" },
    adjustment: "seasonally_adjusted",
    points: [{ period: "2026-09-30", value: 4.2 }],
    chartText: "The employment rate was 4.2 percent in September 2026.",
    methodNote: "Monthly estimate.", comparators: [],
    source: { publisher: "Example agency", title: "Monthly release", url: "https://example.test/data" },
    releasedOn: "2026-10-05", verifiedOn: "2026-10-06",
    changeKind: "new_release", changeNote: "",
    reuse: { display: "allowed", exports: "allowed", note: "Example agency" },
  },
};

function read(slug: string, blocks: object[], datasetFigures?: DatasetFigures) {
  const ordered = blocks.map((block, order) => ({ ...block, order }));
  return { ...prose, document: { ...prose.document, id: slug, published: { ...base,
    metadata: { ...base.metadata, slug }, blocks: ordered, ...(datasetFigures ? { datasetFigures } : {}) } }, assets };
}

export const catalogReads: Readonly<Record<string, ReturnType<typeof read>>> = {
  bio_card: read("catalog-bio-card", [
    { id: "intro", type: "prose", visible: true, data: { content: paragraph("Who is in this story.") } },
    { id: "bio-with-image", type: "bio_card", visible: true, data: {
      profileId: "profile-governor", kind: "person", name: "Ada Example", role: "Governor of New Jersey", party: "Independent",
      area: "Statewide", summary: "Elected in 2025. Oversees the state budget.", sourceUrl: "https://www.nj.gov/governor/",
      sourceLabel: "Office of the Governor", asOf: "2026-09-01", image: { assetId: "portrait", alt: "Ada Example at a podium" } } },
    { id: "bio-plain", type: "bio_card", visible: true, data: {
      profileId: "profile-agency", kind: "organization", name: "NJ Transit", role: "State transit agency",
      summary: "Runs bus, rail and light rail service.", sourceUrl: "https://www.njtransit.com/",
      sourceLabel: "NJ Transit", asOf: "2026-08-15" } },
  ]),
  election_results: read("catalog-election-results", [
    { id: "results", type: "election_results", visible: true, data: { races: [
      electionRace({ candidates: [
        { id: "ellis", name: "Jordan Ellis", votes: 620, share: 62, photo: { assetId: "portrait", alt: "Synthetic candidate portrait", caption: "Fixture credit" } },
        { id: "rivera", name: "Morgan Rivera", votes: 380, share: 38 },
      ] }),
      electionRace({ id: "district-2", district: "District 2", status: "called", sourceKind: "ap",
        sourceLabel: "The Associated Press (fixture)", sourceUrl: "https://apnews.com/example", calledCandidateId: "ellis", apCallUrl: "https://apnews.com/example",
        candidates: [
          { id: "ellis", name: "Jordan Ellis", party: "Democratic", votes: 520, share: 52 },
          { id: "rivera", name: "Morgan Rivera", party: "Republican", votes: 380, share: 38 },
          { id: "chen", name: "Casey Chen", party: "Independent", votes: 100, share: 10 },
        ] }),
    ] } },
  ]),
  data_table: read("catalog-data-table", [
    { id: "table", type: "data_table", visible: true, data: {
      title: "State aid by year", csv: "Year,Aid\n2025,\"1,200\"\n2026,\"1,350\"",
      source: "NJ Department of Education", sourceHref: "https://www.nj.gov/education/" } },
  ]),
  data_figure: read("catalog-data-figure", [
    { id: "figure-jobs", type: "data_figure", visible: true, data: {
      datasetId: "jobs-rate", version: { mode: "pinned", releaseId: "september-2026" }, display: "expanded" } },
  ], { figures: [{ blockId: "figure-jobs", datasetId: "jobs-rate", releaseId: "september-2026",
    revision: figureProjection.revision, digest: figureProjection.digest }], releases: [figureProjection] }),
  row: read("catalog-row", [
    { id: "lead", type: "prose", visible: true, data: { content: paragraph("Before the row.") } },
    { id: "row-one", type: "row", visible: true, data: { columns: [8, 4] } },
    { id: "row-one-text", type: "prose", visible: true, layout: { rowId: "row-one", column: 0 }, data: { content: paragraph("Left column text.") } },
    { id: "row-one-image", type: "image", visible: true, layout: { rowId: "row-one", column: 1 },
      data: { assetId: "upload", alt: "Right column image", caption: "A caption in the row" } },
    { id: "row-hidden", type: "row", visible: false, data: { columns: [6, 6] } },
    { id: "row-hidden-text", type: "prose", visible: true, layout: { rowId: "row-hidden", column: 0 }, data: { content: paragraph("Hidden row text.") } },
    { id: "row-two", type: "row", visible: true, data: { columns: [4, 4, 4] } },
    { id: "row-two-a", type: "prose", visible: true, layout: { rowId: "row-two", column: 0 }, data: { content: paragraph("First of three.") } },
    { id: "row-two-b", type: "prose", visible: false, layout: { rowId: "row-two", column: 1 }, data: { content: paragraph("Hidden middle block.") } },
    { id: "row-two-c", type: "divider", visible: true, layout: { rowId: "row-two", column: 2 }, data: {} },
    { id: "tail", type: "prose", visible: true, data: { content: paragraph("After the rows.") } },
  ]),
  image_gallery: read("catalog-image-gallery", [
    { id: "grid", type: "image_gallery", visible: true, data: { presentation: "grid", images: [
      { itemId: "grid-one", assetId: "upload", alt: "Commuters on the platform", caption: "Morning rush" },
      { itemId: "grid-two", assetId: "portrait", alt: "", altDecorative: true },
    ] } },
    { id: "carousel", type: "image_gallery", visible: true, data: { presentation: "carousel", images: [
      { itemId: "slide-one", assetId: "portrait", alt: "Portrait one" },
      { itemId: "slide-two", assetId: "upload", alt: "Platform two", caption: "Evening" },
    ] } },
  ]),
  embed: read("catalog-embed", [
    { id: "intro", type: "prose", visible: true, data: { content: paragraph("Watch the newscast.") } },
    { id: "youtube", type: "embed", visible: true, data: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", caption: "NJ Spotlight News, full episode", width: 640, height: 360 } },
    { id: "pbs", type: "embed", visible: true, data: { url: "https://player.pbs.org/viralplayer/3094538106/", caption: "LIVE" } },
    { id: "link", type: "embed", visible: true, data: { url: "https://example.org/map", host: "example.org", caption: "Explore the statewide map" } },
  ]),
  html: read("catalog-html", [
    { id: "widget", type: "html", visible: true, data: { title: "Election results widget",
      html: "<p>Results update <strong>live</strong>.</p><script>document.body.dataset.ready = \"1\";</script><img src=x onerror=\"alert(1)\">" } },
    { id: "untitled", type: "html", visible: true, data: { html: "<table><tr><td>Plain</td></tr></table>" } },
  ]),
  cta_row: read("catalog-cta-row", [
    { id: "ctas", type: "cta_row", visible: true, data: { ctas: [
      { label: "Donate", href: "https://www.pbs.org/donation/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&campaign=passport", variant: "primary" },
      { label: "Watch live", href: "/live/", variant: "secondary" },
      { label: "Unsafe", href: "javascript:alert(1)" },
    ] } },
  ]),
  link_card: read("catalog-link-card", [
    { id: "card-one", type: "link_card", visible: true, data: { title: "Budget hearing schedule", url: "https://www.njleg.state.nj.us/",
      source: "New Jersey Legislature", date: "2026-09-30", summary: "Dates for every committee hearing." } },
    { id: "card-two", type: "link_card", visible: true, data: { title: "Transit fare report", url: "https://www.njtransit.com/" } },
  ]),
  topic_shelf: read("catalog-topic-shelf", [
    { id: "shelf", type: "topic_shelf", visible: true, data: { title: "More on the budget", topic: "budget",
      source: "njpbs_related_index", itemLimit: 4, sort: "newest" } },
  ]),
  promotion_playlist: read("catalog-promotion-playlist", [
    { id: "playlist", type: "promotion_playlist", visible: true, data: { title: "Watch next", placement: "before_more",
      presentation: "grid", columns: 3, cards: [
        { itemId: "card-one", title: "Chat Box", summary: "Weekly politics talk.", imageAssetId: "upload", alt: "Chat Box set", href: "https://watch.njpbs.org/show/chat-box/" },
        { itemId: "card-two", title: "Treasures of New Jersey", summary: "Places worth a visit.", imageAssetId: "portrait", alt: "", altDecorative: true, href: "/programs/treasures/" },
      ] } },
  ]),
  divider: read("catalog-divider", [
    { id: "first", type: "prose", visible: true, data: { content: paragraph("First section.") } },
    { id: "rule", type: "divider", visible: true, data: {} },
    { id: "second", type: "prose", visible: true, data: { content: paragraph("Second section.") } },
  ]),
  mixed: read("catalog-mixed", [
    { id: "lead", type: "prose", visible: true, data: { content: paragraph("Tonight on NJ Spotlight News.") } },
    { id: "player", type: "embed", visible: true, data: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", caption: "Full episode" } },
    { id: "row", type: "row", visible: true, data: { columns: [6, 6] } },
    { id: "row-left", type: "cta_row", visible: true, layout: { rowId: "row", column: 0 }, data: { ctas: [{ label: "Support", href: "https://www.pbs.org/donation/", variant: "primary" }] } },
    { id: "row-right", type: "link_card", visible: true, layout: { rowId: "row", column: 1 }, data: { title: "Read the transcript", url: "https://www.njspotlightnews.org/" } },
    { id: "rule", type: "divider", visible: true, data: {} },
    { id: "credits", type: "prose", visible: true, data: { content: paragraph("Produced by NJ PBS.") } },
  ]),
};
export const catalogFixtures = Object.values(catalogReads);
