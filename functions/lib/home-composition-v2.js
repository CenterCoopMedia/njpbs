"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planHomeCompositionV2 = planHomeCompositionV2;
const home_composition_contract_ts_1 = require("./home-composition-contract");
const placements = {
    "home-start": "before_start",
    "home-featured": "before_featured",
    "home-passport-copy": "before_passport",
    "home-more": "before_more",
    "home-spotlight": "before_spotlight",
};
/** Explicit v1-to-v2 draft proposal, after parseBlocks. No read-time migration.
 * Fold the existing visual placement of manual shelves into the block array,
 * preserving all IDs, hidden recovery content, data and frozen references.
 */
function planHomeCompositionV2(blocks) {
    const error = (0, home_composition_contract_ts_1.homeCompositionError)("home", 1, blocks, { complete: false });
    if (error)
        throw new Error(error);
    const shelves = blocks.filter(block => block.type === "promotion_playlist");
    const result = [];
    let pending = [];
    for (const block of blocks) {
        if (block.type === "promotion_playlist")
            continue;
        if (block.section === undefined) {
            pending.push(block);
            continue;
        }
        if (placements[block.section]) {
            result.push(...pending);
            pending = [];
            result.push(...shelves.filter(shelf => shelf.type === "promotion_playlist" && shelf.data.placement === placements[block.section]));
        }
        result.push(block);
    }
    result.push(...pending);
    const planned = result.map((block, order) => ({ ...block, order }));
    const nextError = (0, home_composition_contract_ts_1.homeCompositionError)("home", 2, planned, { complete: false });
    if (nextError)
        throw new Error(nextError);
    return planned;
}
