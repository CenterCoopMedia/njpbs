"use strict";

// Deployment-safe CommonJS mirror of the page-template block placement contract
// in packages/content-core/src/editor-admin.ts. Firebase uploads `functions/` as
// its own CommonJS source bundle, so the save and scheduled-publish boundaries
// cannot import that TypeScript module directly. The parity test in
// site/tests/editor-section-contract-parity.test.ts pins every catalog/cap and
// representative validation result to the canonical editor implementation.

const { containsBio } = require("./bio-profiles");

const SECTION_BLOCK_CATALOG = Object.freeze({
  home: Object.freeze([
    "row",
    "headline",
    "prose",
    "image",
    "image_gallery",
    "cta_row",
    "card_grid",
    "embed",
    "html",
    "content_shelf",
    "promotion_playlist",
    "topic_shelf",
    "video_playlist",
    "newsletter_signup",
    "home_newscast",
    "record_card",
    "sponsor_strip",
    "divider",
  ]),
  programLanding: Object.freeze([
    "row",
    "headline",
    "prose",
    "image",
    "card_grid",
    "link_card",
    "faq_item",
    "cta_row",
    "embed",
    "county_comparison",
    "town_lookup",
    "html",
    "video_playlist",
    "promotion_playlist",
    "record_card",
    "divider",
    "sponsor_strip",
  ]),
  genericPage: Object.freeze([
    "embed",
    "data_hub_section",
    "document_list",
    "data_table",
    "data_figure",
    "election_results",
    "county_comparison",
    "town_lookup",
    "row",
    "headline",
    "prose",
    "image",
    "video",
    "cta_row",
    "faq_item",
    "link_card",
    "coverage_list",
    "html",
    "topic_shelf",
    "video_playlist",
    "promotion_playlist",
    "record_card",
    "newsletter_signup",
    "divider",
    "sponsor_strip",
  ]),
  post: Object.freeze([
    "bio_card",
    "data_table",
    "data_figure",
    "election_results",
    "row",
    "prose",
    "image",
    "video",
    "image_gallery",
    "embed",
    "html",
    "cta_row",
    "support_appeal",
    "link_card",
    "topic_shelf",
    "promotion_playlist",
    "record_card",
    "newsletter_signup",
    "divider",
    "sponsor_strip",
  ]),
});

const SECTION_BLOCK_MAX = Object.freeze({
  home: Object.freeze({
    headline: 1,
    image_gallery: 2,
    card_grid: 2,
    cta_row: 3,
    content_shelf: 4,
    promotion_playlist: 8,
    topic_shelf: 2,
    video_playlist: 2,
    home_newscast: 1,
  }),
  programLanding: Object.freeze({
    headline: 1,
    cta_row: 2,
    promotion_playlist: 8,
    video_playlist: 1,
  }),
  genericPage: Object.freeze({
    headline: 1,
    cta_row: 2,
    coverage_list: 1,
    promotion_playlist: 8,
    topic_shelf: 2,
    video_playlist: 1,
    video: 4,
  }),
  post: Object.freeze({
    support_appeal: 1,
    image_gallery: 2,
    cta_row: 2,
    promotion_playlist: 8,
    topic_shelf: 1,
    video: 4,
  }),
});

const SECTION_BLOCK_TOTAL_MAX = Object.freeze({
  home: 40,
  programLanding: 40,
  genericPage: 40,
  post: 200,
});

function allowedBlocksForSection(section) {
  return (SECTION_BLOCK_CATALOG[section] ?? []).slice();
}

function canPlaceBlock(section, type) {
  return allowedBlocksForSection(section).includes(type);
}

function maxOf(section, type) {
  return SECTION_BLOCK_MAX[section]?.[type] ?? Number.POSITIVE_INFINITY;
}

function totalMaxOf(section) {
  return SECTION_BLOCK_TOTAL_MAX[section] ?? Number.POSITIVE_INFINITY;
}

function validateSection(section, blocks) {
  if (blocks.length > totalMaxOf(section)) {
    return {
      reason:
        "this page could not be saved because it has too many blocks. Remove some, and let the team know if it keeps happening.",
      detail: `page has ${blocks.length} blocks, over the ${totalMaxOf(section)} cap in ${section}`,
    };
  }
  if (section !== "post" && containsBio(blocks)) return {
    reason: "Bio cards are available only inside Posts.",
    detail: `Bios are not allowed in ${section}`,
  };
  const seen = new Set();
  const counts = new Map();
  for (const [index, block] of blocks.entries()) {
    if (block.id.length === 0) {
      return {
        reason:
          "this page could not be saved because a block is missing its identifier. Reload the page, and let the team know if it keeps happening.",
        detail: `block at index ${index} has an empty id`,
      };
    }
    if (seen.has(block.id)) {
      return {
        reason:
          "this page could not be saved because a block is repeated. Reload the page, and let the team know if it keeps happening.",
        detail: `duplicate block id "${block.id}"`,
      };
    }
    seen.add(block.id);
    if (!canPlaceBlock(section, block.type)) {
      return {
        reason:
          "this page could not be saved because it has a block that does not belong here. Reload the page, and let the team know if it keeps happening.",
        detail: `block type "${block.type}" is not in the ${section} catalog`,
      };
    }
    // The unique retained Home giving plank has its own slot; total limits apply.
    const giving = section === "home" && block.type === "card_grid" && block.section === "home-donor";
    const count = (counts.get(block.type) ?? 0) + (giving ? 0 : 1);
    counts.set(block.type, count);
    if (count > maxOf(section, block.type)) {
      return {
        reason:
          "this page could not be saved because it has too many of one kind of block. Remove one, and let the team know if it keeps happening.",
        detail: `block type "${block.type}" exceeds the cap of ${maxOf(section, block.type)} in ${section}`,
      };
    }
  }
  return null;
}

module.exports = {
  SECTION_BLOCK_CATALOG,
  SECTION_BLOCK_MAX,
  SECTION_BLOCK_TOTAL_MAX,
  allowedBlocksForSection,
  canPlaceBlock,
  validateSection,
};
