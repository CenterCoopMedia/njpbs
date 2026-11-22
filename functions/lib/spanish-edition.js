"use strict";

const { createHash } = require("node:crypto");

const SPANISH_EDITION_PUBLICATION_UNAVAILABLE =
  "Spanish editions can be saved and previewed privately. Publication is not available yet.";

function isSpanishEdition(document) {
  return document != null && Object.hasOwn(document, "editionOf");
}

// One Spanish edition per original. The address stays stable through edits
// to either record and lets concurrent creates converge in one transaction.
function spanishPostEditionId(originalId) {
  const digest = createHash("sha256").update(originalId).digest("hex").slice(0, 32);
  return `edition-es-${digest}`;
}

module.exports = { SPANISH_EDITION_PUBLICATION_UNAVAILABLE, isSpanishEdition, spanishPostEditionId };
