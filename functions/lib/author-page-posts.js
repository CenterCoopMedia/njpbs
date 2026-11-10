"use strict";

// The narrow Firestore read behind author-page pin/hide curation (#1097).
//
// The generic content library is intentionally the wrong source for this list:
// it filters by editorial ownership and desk grants, while an author page joins
// published Posts by their stable registered authorId. This reader makes that
// same join and projects only what the picker needs. Blocks, summaries, credits,
// workflow ownership, sections, and account identifiers never cross the boundary.

const { FieldPath } = require("firebase-admin/firestore");
const { isAuthorId, isPostReference } = require("./author-profile-contract");
const { resolveDisplayDate } = require("./editorial-dates");

const LIST_LIMIT_DEFAULT = 25;
const LIST_LIMIT_MAX = 100;

class AuthorPagePostsError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = "AuthorPagePostsError";
    this.status = status;
    if (code) this.code = code;
  }
}

function boundedLimit(value) {
  return Number.isSafeInteger(value)
    ? Math.min(Math.max(value, 1), LIST_LIMIT_MAX)
    : LIST_LIMIT_DEFAULT;
}

function authorPagePostSummary(document) {
  const stored = document.data();
  const metadata = stored.published?.metadata;
  const headline =
    typeof metadata?.title === "string" && metadata.title.trim().length > 0
      ? metadata.title.trim()
      : null;
  const publishDate = resolveDisplayDate(metadata);
  if (headline === null || publishDate === null) {
    throw new AuthorPagePostsError(
      500,
      "A published author Post has an invalid picker summary",
    );
  }
  return { id: document.id, headline, publishDate,
    ...(metadata?.seo?.noindex === true ? { noindex: true } : {}) };
}

async function listAuthorPagePosts({
  firestore,
  authorId,
  limit,
  startAfter = null,
}) {
  if (!isAuthorId(authorId)) {
    throw new AuthorPagePostsError(
      400,
      "A valid authorId is required",
      "invalid_author_id",
    );
  }
  if (startAfter !== null && !isPostReference(startAfter)) {
    throw new AuthorPagePostsError(
      400,
      "The author Post cursor is invalid",
      "invalid_cursor",
    );
  }

  const bounded = boundedLimit(limit);
  let query = firestore
    .collection("cmsPosts")
    .where("published.authorIds", "array-contains", authorId)
    .where("publiclyVisible", "==", true)
    .where("published.metadata.type", "==", "post")
    .orderBy(FieldPath.documentId())
    .limit(bounded + 1);
  if (startAfter !== null) query = query.startAfter(startAfter);

  // Projection is the privacy boundary. Even a future field added to cmsPosts
  // cannot appear in this response unless this list is deliberately expanded.
  const snapshot = await query
    .select(
      "published.metadata.title",
      "published.metadata.date",
      "published.metadata.editorialDateSource",
      "published.metadata.firstPublishedAt",
      "published.metadata.seo.noindex",
    )
    .get();
  const hasNextPage = snapshot.docs.length > bounded;
  const page = snapshot.docs.slice(0, bounded);
  return {
    posts: page.map(authorPagePostSummary),
    nextCursor: hasNextPage ? page[page.length - 1].id : null,
  };
}

module.exports = {
  AuthorPagePostsError,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  authorPagePostSummary,
  listAuthorPagePosts,
};
