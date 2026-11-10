import type { BLOCK_LABELS } from "../../../packages/content-core/src/editor-admin";

type BlockType = keyof typeof BLOCK_LABELS;

/**
 * One plain sentence per block type, shown beside its name in the add-block palette. The
 * palette grew to thirteen labels, four of them shelves, and a label alone no longer says
 * which one a person wants; the description is what lets them choose without inserting each
 * and undoing.
 */
export const BLOCK_DESCRIPTIONS: Readonly<Record<BlockType, string>> = Object.freeze({
  bio_card: "A short, expandable biography of a person or organization in this article.",
  headline: "A section title that breaks the page into parts.",
  prose: "Paragraphs, lists, and links written in place.",
  image: "One picture from the media library with its alt text.",
  video: "One uploaded video from the media library, played on the page.",
  image_gallery: "Several pictures shown together in a grid.",
  cta_row: "A row of buttons that send people somewhere.",
  card_grid: "Cards you write yourself, each with a title, summary, and link.",
  link_card: "One linked card with a title and optional source, date, and summary.",
  document_list: "PDF meeting notices, automatically ordered by the date first added.",
  faq_item: "A question with its answer, for help and policy pages.",
  coverage_list: "A legacy group of outside articles. Existing lists remain editable.",
  data_hub_section: "A reviewed Data Hub section with an editable heading and introduction.",
  data_figure: "An approved shared measure with a chart, source values and description.",
  county_comparison: "County maps, results and turnout comparing the 2020 and 2024 federal elections.",
  town_lookup: "Past election results and turnout for all 564 New Jersey municipalities, with a town map.",
  election_results: "Race results with candidates, sources and editorial approval.",
  data_table: "A table readers can search and sort, using CSV data you paste.",
  embed: "An AP election results map, or video from YouTube, Vimeo, TikTok, Instagram, Facebook, PBS, or X/Twitter.",
  html: "Your own HTML, CSS, and scripts, shown in a sealed frame.",
  content_shelf: "Programs pulled automatically from PBS Media Manager.",
  promotion_playlist: "Programs or pages you pick by hand and order yourself.",
  newsletter_signup: "Links to signup pages for newsletters you choose.",
  home_newscast: "The latest approved full newscast, updated automatically from PBS.",
  topic_shelf: "The latest posts on a topic, kept current automatically.",
  video_playlist: "Videos pulled automatically from a PBS playlist.",
  record_card: "A card linked to a saved program, event, sponsor or newsletter.",
  sponsor_strip: "Sponsor logos you select and order from the sponsor library.",
  row: "A section with columns for text, images and other content.",
  divider: "A thin rule between two parts of the page.",
});
