"use strict";
const protocol = require("./public-release-pair");
const work = require("./public-release-pair-work");
const { isAuthorId, isValidAuthorSlug } = require("./author-profile-contract");
function refuse() { throw new work.PairExecutionError("author-owner-mismatch"); }
function isPublicReleasePairAuthorPath(path) {
  const slug = typeof path === "string" && path.match(/^\/authors\/([^/]+)\/$/)?.[1];
  return Boolean(slug && isValidAuthorSlug(slug));
}
/** This is exact member metadata, never authority over an author namespace. */
function parsePublicReleasePairAuthorOwner(value) {
  protocol.exact(value, ["authorId", "sourceVersion", "snapshotDigest", "canonicalPath", "sourceCensusDigest", "readerProvenanceDigest"]);
  if (!isAuthorId(value.authorId) || !protocol.positive(value.sourceVersion) || !isPublicReleasePairAuthorPath(value.canonicalPath) ||
      ![value.snapshotDigest, value.sourceCensusDigest, value.readerProvenanceDigest].every(protocol.digest)) refuse();
  return protocol.freeze({ authorId: value.authorId, sourceVersion: value.sourceVersion, snapshotDigest: value.snapshotDigest,
    canonicalPath: value.canonicalPath, sourceCensusDigest: value.sourceCensusDigest, readerProvenanceDigest: value.readerProvenanceDigest });
}
module.exports = { isPublicReleasePairAuthorPath, parsePublicReleasePairAuthorOwner };
