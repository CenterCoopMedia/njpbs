"use strict";

const { visibleLayoutBlocks } = require("./content-layout");
const { instantBlockAllowed, unsupportedPostBlockReason } = require("./joined-records");
const { readSerializerPublicationControlInTransaction } = require("./serializer-publication-control");

// The full build is gone for good (October 13, 2026). A publication that the
// build-free owners did not accept has no other path, so the refusal must name
// the cause in words staff can act on instead of "not available yet".
const RETIRED = "The full-site build was retired on October 13, 2026.";
const ASK = "Ask an administrator.";
const PAGE_WITHDRAWAL_MESSAGE = "This Page was last published by the retired full-site build, so the new publisher does not own its address yet. Publish it once, then unpublish it.";

// The draft blocks are what a publish or schedule would copy into the snapshot;
// an older snapshot can differ from the draft, so read the draft first. This
// runs before block validation, so a malformed entry is skipped here and left
// for the validator to report; the refusal itself must never throw.
function unsupportedBlockTypes(document) {
  const source = Array.isArray(document?.blocks) ? document.blocks : document?.published?.blocks;
  const blocks = (Array.isArray(source) ? source : [])
    .filter(block => block !== null && typeof block === "object" && typeof block.type === "string");
  const types = visibleLayoutBlocks(blocks).map(block => block.type).filter(type => !instantBlockAllowed(type));
  return [...new Set(types)];
}

/** The reason a publication has no build-free path, in words staff can act on. */
function buildFreeRefusalMessage({ collection, document, fallbackReason, withdrawal = false }) {
  if (fallbackReason) return fallbackReason;
  if (collection === "cmsPages") {
    return withdrawal ? PAGE_WITHDRAWAL_MESSAGE : `This Page has no build-free publication path. ${RETIRED} ${ASK}`;
  }
  if (withdrawal) return `This Post's public removal has no build-free path. ${RETIRED} ${ASK}`;
  const types = unsupportedBlockTypes(document);
  if (types.length) {
    return unsupportedPostBlockReason(types[0]);
  }
  return `This Post has no build-free publication path. ${RETIRED} ${ASK}`;
}

/** Null while the legacy full build is still admitted; otherwise the refusal text. */
async function buildFreeRefusalInTransaction({ firestore, transaction, ...input }) {
  const control = await readSerializerPublicationControlInTransaction({ firestore, transaction });
  return control.enabled ? null : buildFreeRefusalMessage(input);
}

module.exports = { PAGE_WITHDRAWAL_MESSAGE, buildFreeRefusalMessage, buildFreeRefusalInTransaction, unsupportedBlockTypes };
