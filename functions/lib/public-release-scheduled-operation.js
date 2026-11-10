"use strict";

/** Original scheduler identity, shared before acceptance with private callers.
 * Keep this independent of the current selector and the time of a retry. */
function scheduledPairPublicationOperation({ collection, id, version, publishAt }) {
  return require("./public-release-pair").publicReleaseDigest({
    schemaVersion: 2, kind: "scheduled-publish", collection, id, version, publishAt: publishAt ?? null,
  }).slice(0, 20);
}

module.exports = { scheduledPairPublicationOperation };
