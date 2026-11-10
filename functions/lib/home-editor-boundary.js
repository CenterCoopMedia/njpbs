"use strict";

const { isDeepStrictEqual } = require("node:util");
const { homeCompositionError } = require("./home-composition-contract");

const HOME_EDITABLE_BLOCK_TYPE = "promotion_playlist";
const HOME_EDITOR_BOUNDARY_ERROR =
  "Only the manual content shelf can be changed on the Home page. Reload and try again.";

function ignoredHomeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((block) => block?.type !== HOME_EDITABLE_BLOCK_TYPE);
}

// cmsPages/home can carry blocks created before the public Home ownership boundary was finite.
// They remain recovery data, but an ordinary browser save must not add, remove, reorder, or edit
// them. Compare the complete ignored projection after parsing and id assignment, so a forged
// client cannot bypass the Admin projection and mutate content the public renderer ignores.
function homeEditorBoundaryError({ collection, documentId, storedBlocks, nextBlocks, storedVersion, nextVersion, complete = true }) {
  if (collection !== "cmsPages" || documentId !== "home") return null;
  if (nextVersion !== storedVersion) return "Use the version-checked Home conversion before changing its composition.";
  if (storedVersion === 2) {
    const error = homeCompositionError(documentId, storedVersion, nextBlocks, { complete });
    if (error) return error;
    for (const previous of storedBlocks || []) {
      if (previous.type === "promotion_playlist" || previous.section === undefined) continue;
      const next = nextBlocks.find(block => block.section === previous.section);
      if (!next || next.id !== previous.id) return "Home section identities must be preserved. Reload and try again.";
      // Start is retained recovery content. Newsletter owns its public/editor boundary.
      if (["home-start", "home-start-action"].includes(previous.section)) {
        const oldContent = { ...previous };
        const nextContent = { ...next };
        delete oldContent.order;
        delete nextContent.order;
        if (!isDeepStrictEqual(oldContent, nextContent)) return "Home Start recovery content must be preserved. Reload and try again.";
      }
    }
    return null;
  }
  if (storedVersion !== undefined) return homeCompositionError(documentId, storedVersion, nextBlocks, { complete });
  return isDeepStrictEqual(
    ignoredHomeBlocks(storedBlocks),
    ignoredHomeBlocks(nextBlocks),
  )
    ? null
    : HOME_EDITOR_BOUNDARY_ERROR;
}

module.exports = {
  HOME_EDITABLE_BLOCK_TYPE,
  HOME_EDITOR_BOUNDARY_ERROR,
  homeEditorBoundaryError,
  ignoredHomeBlocks,
};
