"use strict";

const { createHash } = require("node:crypto");
const { contentVersion } = require("./content-version");
const { isPostRouteSlug, isSpanishPostSlug, postRoutePath } = require("./post-slug-contract");
const { parsePublishInstant } = require("./publish-instant");
const { publiclyVisible } = require("./public-video-references");
const { contentLink } = require("./content-link");

const SPANISH_EDITION_REVIEW_REQUIRED =
  "Approve the translation of this saved Spanish edition before publishing.";

function isSpanishEdition(document) {
  return document != null && Object.hasOwn(document, "editionOf");
}

// One Spanish edition per original. The address stays stable through edits
// to either record and lets concurrent creates converge in one transaction.
function spanishPostEditionId(originalId) {
  const digest = createHash("sha256").update(originalId).digest("hex").slice(0, 32);
  return `edition-es-${digest}`;
}

function hasSpanishTranslationApproval(document, id, status = "approved") {
  const approval = document?.translationApproval;
  return document?.type === "post" && document.locale === "es" && document.status === status &&
    require("../get-content").isBoundedDocumentId(document.editionOf) &&
    id === spanishPostEditionId(document.editionOf) &&
    Number.isSafeInteger(approval?.reviewedVersion) && approval.reviewedVersion > 0 &&
    typeof approval.approvedBy === "string" && approval.approvedBy.length > 0 && parsePublishInstant(approval.approvedAt) !== null &&
    document.version === approval.reviewedVersion + (status === "scheduled" ? 2 : 1) &&
    approval.contentVersion === contentVersion(document);
}

function isLinkedSpanishPost(id, metadata) {
  return metadata?.type === "post" && metadata.locale === "es" && isSpanishPostSlug(metadata.slug) &&
    require("../get-content").isBoundedDocumentId(metadata.editionOf) &&
    id === spanishPostEditionId(metadata.editionOf);
}

function alternatePostId(id, metadata) {
  return isLinkedSpanishPost(id, metadata) ? metadata.editionOf : spanishPostEditionId(id);
}

function visibleEditionPath(document, id, now) {
  if (!document?.published || !publiclyVisible(document)) return undefined;
  const { sourceVersion, publishedAt, metadata } = document.published;
  const instant = parsePublishInstant(publishedAt);
  if (metadata?.type !== "post" || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1 ||
      instant === null || instant > now.getTime()) return undefined;
  if (!isPostRouteSlug(metadata.slug) || (isSpanishPostSlug(metadata.slug) && !isLinkedSpanishPost(id, metadata))) return undefined;
  const path = postRoutePath(metadata.slug);
  return contentLink(metadata, path).external ? undefined : path;
}

module.exports = { SPANISH_EDITION_REVIEW_REQUIRED, isSpanishEdition, spanishPostEditionId,
  hasSpanishTranslationApproval, isLinkedSpanishPost, alternatePostId, visibleEditionPath };
