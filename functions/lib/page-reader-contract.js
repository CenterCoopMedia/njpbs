"use strict";

// This contract describes parsing, including hidden planks. Visibility cannot
// make a saved document readable by an older parser. Validation stays with the
// existing content/placement owners.
const PAGE_READER_VERSION = 1;
const { editorTemplateForPage } = require("./public-page-contract");
const PAGE_BLOCK_TYPES = Object.freeze(["bio_card", "town_lookup", "data_table", "data_figure", "election_results",
  "county_comparison", "data_hub_section", "row", "headline", "prose", "image", "video", "image_gallery", "cta_row", "support_appeal",
  "card_grid", "link_card", "document_list", "faq_item", "coverage_list", "embed", "html", "content_shelf",
  "promotion_playlist", "newsletter_signup", "home_newscast", "topic_shelf", "video_playlist", "record_card", "sponsor_strip", "divider"]);
function requiredPageReaderVersion(blocks, pageId) {
  if (!Array.isArray(blocks)) return 0;
  if (blocks.some(block => !PAGE_BLOCK_TYPES.includes(block?.type))) return Infinity;
  return blocks.some(block => {
    if (["county_comparison", "town_lookup"].includes(block?.type)) return true;
    // OLD excluded Embed placement on every generic Page, including Data Hub.
    // Home/programLanding keep their existing provider/placement validation.
    return block?.type === "embed" && editorTemplateForPage(pageId) === "genericPage";
  }) ? 1 : 0;
}
function pageReaderSupports(blocks, pageId, version) {
  return [0, PAGE_READER_VERSION].includes(version) && requiredPageReaderVersion(blocks, pageId) <= version;
}
module.exports = { PAGE_READER_VERSION, PAGE_BLOCK_TYPES, requiredPageReaderVersion, pageReaderSupports };
