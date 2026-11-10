// CommonJS deployment mirror of packages/content-core/src/home-composition-contract.ts.
// Keep behavior aligned through the Home composition parity fixtures.
"use strict";
const { isHomeNewscastData } = require("./home-newscast-data");
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOME_DESTINATIONS = exports.HOME_COMPOSITION_REGIONS = exports.HOME_COMPOSITION_VERSION = void 0;
exports.homeDetailText = homeDetailText;
exports.homePassportHeading = homePassportHeading;
exports.homeCompositionError = homeCompositionError;
exports.HOME_OPTIONAL_REGIONS = [["home-posts", "content_shelf"], ["home-donor", "card_grid"], ["home-newsletter", "newsletter_signup"], ["home-newscast", "home_newscast"]];
// Text-only required-body check, matching content-model.ts richTextIsEmpty.
function richTextIsEmpty(doc) {
    const hasText = node => (typeof node.text === "string" && node.text.trim().length > 0) ||
        (node.content?.some(hasText) ?? false);
    return !doc.content.some(hasText);
}

// Finite Home regions, in public order. The optional manual shelf retains its
// separate placement field. No stored CSS or renderer name controls this frame.
exports.HOME_COMPOSITION_VERSION = 1;
exports.HOME_COMPOSITION_REGIONS = [
    ["home-start", "card_grid"],
    ["home-start-action", "cta_row"],
    ["home-featured", "content_shelf"],
    ["home-passport-copy", "prose"],
    ["home-passport-action", "cta_row"],
    ["home-more", "content_shelf"],
    ["home-spotlight", "content_shelf"],
];
exports.HOME_DESTINATIONS = {
    live: "/live/",
    ondemand: "https://watch.njpbs.org/",
    schedule: "/schedule/",
    kids: "/kids/",
    passport: "https://watch.njpbs.org/passport/learn-more/",
    spotlight: "https://www.njspotlightnews.org/",
};
// Start cards have one text detail, not a hidden rich-text surface. Refuse
// formatting that the pathway presentation would discard.
function homeDetailText(doc) {
    if (doc === undefined || doc.content.length === 0)
        return "";
    if (doc.content.length !== 1 || doc.content[0].type !== "paragraph")
        return null;
    const nodes = doc.content[0].content ?? [];
    if (nodes.some(node => node.type !== "text" || (node.marks?.length ?? 0) > 0))
        return null;
    return nodes.map(node => node.text ?? "").join("");
}
function homePassportHeading(doc) {
    const heading = doc.content[0];
    if (heading?.type !== "heading" || heading.attrs?.level !== 2)
        return null;
    const nodes = heading.content ?? [];
    if (nodes.some(node => node.type !== "text" || (node.marks?.length ?? 0) > 0))
        return null;
    const text = nodes.map(node => node.text ?? "").join("");
    return text.trim() ? text : null;
}
function nonBlank(value) {
    return value.trim().length > 0;
}
function regionContentError(block, complete) {
  if (block.section === "home-newscast" && block.type === "home_newscast") {
    return isHomeNewscastData(block.data, complete && block.visible) ? null : "Newscast requires its approved program, layout, plain-text copy and action labels.";
  }
  if (block.section === "home-newsletter" && block.type === "newsletter_signup") {
    const data = block.data;
    if (data.newsletterIds.length > 1 || data.newsletterIds.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
        typeof data.actionLabel !== "string" || data.actionLabel.length > 120 ||
        (data.heading ?? "").length > 120 || (data.intro ?? "").length > 2000 ||
        // eslint-disable-next-line no-control-regex -- Plain-text Home copy rejects ASCII controls.
        /[\u0000-\u001f\u007f]/.test((data.heading ?? "") + (data.intro ?? "") + data.actionLabel) ||
        (data.newsletterIds.length > 0) !== (data.selectionReceipt !== undefined) ||
        complete && block.visible && data.newsletterIds.length > 0 && !nonBlank(data.actionLabel)) {
      return "Home Newsletter requires an empty slot or one published selection with plain-text copy and button text.";
    }
    return null;
  }
    if (block.section === "home-donor" && block.type === "card_grid") {
        const card = block.data.cards[0];
        const summary = card ? homeDetailText(card.body) : null;
        if (Object.keys(block.data).some(key => !["cards", "backgroundImageAssetId"].includes(key)) || block.data.cards.length !== 1 || !card ||
            Object.keys(card).some(key => !["itemId", "title", "body", "label", "href"].includes(key)) || card.href !== "/support/" ||
            typeof card.label !== "string" || card.title.length > 120 || card.label.length > 120 || summary === null || summary.length > 2000 ||
            // eslint-disable-next-line no-control-regex -- Reject ASCII controls in editable Home copy.
            /[\u0000-\u001f\u007f]/.test(card.title + card.label + summary) ||
            complete && (!nonBlank(card.title) || !nonBlank(card.label))) {
            return "Home giving requires a heading, plain-text summary and one action to /support/.";
        }
        return null;
    }
    if (block.type === "card_grid") {
        const destinations = [exports.HOME_DESTINATIONS.live, exports.HOME_DESTINATIONS.ondemand, exports.HOME_DESTINATIONS.schedule, exports.HOME_DESTINATIONS.kids];
        if (block.data.cards.length !== 4)
            return "Start here requires four destination cards.";
        for (const [index, card] of block.data.cards.entries()) {
            if ((complete && !nonBlank(card.title)) || card.href !== destinations[index])
                return "Keep the four Start here destinations in their original order, with a title for each.";
            if (card.label !== undefined || homeDetailText(card.body) === null)
                return "Start here cards use a title and plain-text detail.";
            if (index === 3 && card.imageAssetId !== undefined)
                return "The Kids pathway keeps its fixed animated artwork.";
        }
    }
    if (block.type === "cta_row") {
        const action = block.data.ctas[0];
        const passport = block.section === "home-passport-action";
        const href = passport ? exports.HOME_DESTINATIONS.passport : exports.HOME_DESTINATIONS.schedule;
        if (block.data.ctas.length !== 1 || (complete && !nonBlank(action.label)) || action.href !== href)
            return "Each Home section action requires one label and its approved destination.";
        if (action.variant !== undefined && action.variant !== (passport ? "primary" : "secondary"))
            return "Keep the Home section action's fixed presentation.";
    }
    if (complete && block.type === "prose" && (homePassportHeading(block.data.content) === null ||
        richTextIsEmpty({ type: "doc", content: block.data.content.content.slice(1) }))) {
        return "Passport requires a plain-text level-two heading followed by its body.";
    }
    if (block.type === "content_shelf") {
        const expected = block.section === "home-featured" ? "pbs_featured" : block.section === "home-more" ? "pbs_more" : block.section === "home-posts" ? "station_posts" : "spotlight_news";
        const href = expected === "station_posts" ? "/posts/" : expected === "spotlight_news" ? exports.HOME_DESTINATIONS.spotlight : exports.HOME_DESTINATIONS.ondemand;
        const maximum = expected === "station_posts" ? 24 : expected === "pbs_more" ? 16 : 8;
        if (block.data.source !== expected || block.data.moreHref !== href)
            return "Keep the Home shelf's assigned source and approved destination.";
        if (complete && (!nonBlank(block.data.title) || !nonBlank(block.data.moreLabel)))
            return "Home shelves require a heading and a more-link label.";
        if (block.data.itemLimit > maximum)
            return `This Home shelf supports at most ${maximum} items.`;
    }
    return null;
}
// Call only after the shared block parser. Absence means the legacy frame;
// malformed or misplaced markers must never silently fall back to that frame.
function homeCompositionError(pageId, version, blocks, { complete = true } = {}) {
    if (blocks.some(block => block.type === "home_newscast" &&
      (block.section !== "home-newscast" || pageId !== "home" || version !== 2))) return "Newscast requires its named Home version 2 section.";
  if (blocks.some(block => block.type === "newsletter_signup" &&
      (block.section === "home-newsletter" ? pageId !== "home" || version !== 2 :
        block.data.actionLabel !== undefined || block.data.selectionReceipt !== undefined || pageId === "home"))) {
    return "The single Newsletter bar requires its named Home version 2 section.";
  }
    if (blocks.some(block => block.section === "home-donor" && block.type !== "promotion_playlist") &&
        (pageId !== "home" || version !== 2)) return "The giving plank requires Home version 2.";
    if (version === undefined)
        return null;
    if (pageId !== "home" || (version !== 1 && version !== 2))
        return "The Home composition version is invalid.";
    if (version === 2)
        return homeCompositionV2Error(blocks, complete);
    const content = blocks.filter(block => block.type !== "promotion_playlist");
    const required = content.filter(block => block.section !== undefined);
    const added = content.filter(block => block.section === undefined);
    const promotions = blocks.filter(block => block.type === "promotion_playlist");
    if (required.length !== exports.HOME_COMPOSITION_REGIONS.length || promotions.length > 8)
        return "Home requires its seven named regions and at most eight manual shelves.";
    if (added.some(block => block.type === "content_shelf"))
        return "Automatic Home shelves keep their named page sections.";
    if (added.length && blocks.some((block, index) => index > 0 && block.order <= blocks[index - 1].order))
        return "Home content must follow its saved reading order.";
    for (const [order, [section, type]] of exports.HOME_COMPOSITION_REGIONS.entries()) {
        const matches = required.filter(block => block.section === section);
        const block = matches[0];
        if (matches.length !== 1 || block !== required[order] || block.type !== type || (order > 0 && block.order <= required[order - 1].order) || !block.visible)
            return `Keep the ${section} region visible and in its assigned position.`;
        const error = regionContentError(block, complete);
        if (error)
            return error;
        if (block.type === "content_shelf" && block.data.selectedIds !== undefined) return "Curated card selections require Home version 2.";
    }
    // A section's button is part of that section, not an insertion boundary.
    for (const [body, action] of [["home-start", "home-start-action"], ["home-passport-copy", "home-passport-action"]]) {
        if (content.findIndex(block => block.section === action) !== content.findIndex(block => block.section === body) + 1)
            return "Add content between Home sections, not inside a section's fixed controls.";
    }
    if (promotions.some(block => block.layout !== undefined))
        return "The manual Home shelf keeps its own page placement outside rows.";
    if (promotions.some(block => exports.HOME_COMPOSITION_REGIONS.some(([section]) => section === block.section)))
        return "The manual shelf cannot replace a required Home region.";
    return null;
}
// Version 2 retains named identities even when withdrawn. `visible: false` is
// the explicit withdrawal state; it never frees a protected source identity.
// Numeric order is a compatibility field and must agree with the sole array.
function homeCompositionV2Error(blocks, complete) {
    if (blocks.some(block => block.type === "promotion_playlist" && block.layout !== undefined)) {
        return "The manual Home shelf stays outside rows.";
    }
    if (blocks.some((block, index) => index > 0 && block.order <= blocks[index - 1].order)) {
        return "Home content must follow its saved reading order.";
    }
    const required = blocks.filter(block => block.section !== undefined && block.type !== "promotion_playlist");
    if (blocks.some(block => block.type === "promotion_playlist" &&
        [...exports.HOME_COMPOSITION_REGIONS, ...exports.HOME_OPTIONAL_REGIONS].some(([section]) => section === block.section))) {
        return "The manual shelf cannot replace a required Home region.";
    }
    if (required.some(block => ![...exports.HOME_COMPOSITION_REGIONS, ...exports.HOME_OPTIONAL_REGIONS].some(([section]) => section === block.section)) ||
        blocks.filter(block => block.type === "promotion_playlist").length > 8) {
        return "Home requires its seven named regions and at most eight manual shelves.";
    }
    for (const [section, type] of exports.HOME_COMPOSITION_REGIONS) {
        const matches = required.filter(block => block.section === section);
        const block = matches[0];
        if (matches.length !== 1 || block.type !== type || block.layout !== undefined) {
            return `Keep the ${section} region and its assigned type outside rows.`;
        }
        const error = regionContentError(block, complete);
        if (error)
            return error;
    }
    for (const [section, type] of exports.HOME_OPTIONAL_REGIONS) {
        const matches = required.filter(block => block.section === section);
        if (matches.length > 1 || matches.some(block => block.type !== type || block.layout !== undefined)) return `Keep one ${section} region with its assigned type outside rows.`;
        if (matches[0]) {
            const error = regionContentError(matches[0], complete);
            if (error) return error;
        }
    }
    if (blocks.some(block => block.section === undefined && block.type === "content_shelf")) {
        return "Automatic Home shelves keep their named page sections.";
    }
    for (const [body, action] of [["home-start", "home-start-action"], ["home-passport-copy", "home-passport-action"]]) {
        const bodyIndex = blocks.findIndex(block => block.section === body);
        const actionIndex = blocks.findIndex(block => block.section === action);
        if (actionIndex !== bodyIndex + 1 || blocks[bodyIndex].visible !== blocks[actionIndex].visible) {
            return "Home section copy and action must stay adjacent with the same visibility.";
        }
    }
    return null;
}
