"use strict";

// This contract describes parsing, including hidden planks. Visibility cannot
// make a saved document readable by an older parser. Validation stays with the
// existing content/placement owners.
const PAGE_READER_VERSION = 3;
const { editorTemplateForPage } = require("./public-page-contract");
const PAGE_BLOCK_TYPES = Object.freeze(["bio_card", "town_lookup", "data_table", "data_figure", "election_results",
  "county_comparison", "data_hub_section", "row", "headline", "prose", "image", "video", "image_gallery", "cta_row", "support_appeal",
  "card_grid", "link_card", "document_list", "faq_item", "coverage_list", "embed", "embed_anchor", "html", "content_shelf",
  "promotion_playlist", "newsletter_signup", "home_newscast", "topic_shelf", "video_playlist", "record_card", "sponsor_strip", "divider"]);
function requiredPageReaderVersion(blocks, pageId, scheduleCopy) {
  if (!Array.isArray(blocks)) blocks = [];
  if (blocks.some(block => !PAGE_BLOCK_TYPES.includes(block?.type))) return Infinity;
  if (pageId === "schedule" && scheduleCopy !== undefined) return 3;
  if (blocks.some(block => block.type === "embed_anchor")) return 2;
  return blocks.some(block => {
    if (["county_comparison", "town_lookup"].includes(block?.type)) return true;
    // OLD excluded Embed placement on every generic Page, including Data Hub.
    // Home/programLanding keep their existing provider/placement validation.
    return block?.type === "embed" && editorTemplateForPage(pageId) === "genericPage";
  }) ? 1 : 0;
}
function isPageReaderVersion(version) {
  return Number.isInteger(version) && version >= 1 && version <= PAGE_READER_VERSION;
}
function pageReaderSupports(blocks, pageId, version, scheduleCopy) {
  return (version === 0 || isPageReaderVersion(version)) && requiredPageReaderVersion(blocks, pageId, scheduleCopy) <= version;
}
module.exports = { PAGE_READER_VERSION, PAGE_BLOCK_TYPES, isPageReaderVersion, requiredPageReaderVersion, pageReaderSupports };
