"use strict";

const protocol = require("./public-release-pair");
const { parsePublicReleaseChangeHead } = require("./public-release-change-log");
const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");

function parsePublicReleaseChangeBaseline(value) {
  protocol.exact(value, ["schemaVersion", "logEpoch", "baselineCursor", "liveReleaseSha", "sourceMemberCensusDigest",
    "codeAssetManifestDigest", "createdAt", ...(value?.codeAssetManifestDigest === null ? ["codeAssetManifestReason"] : [])]);
  if (value.schemaVersion !== 2 || !isPublicDeploymentIdentifier(value.logEpoch) ||
      !/^[a-f0-9]{40}$/.test(value.liveReleaseSha ?? "") || !/^[a-f0-9]{64}$/.test(value.sourceMemberCensusDigest ?? "") ||
      !(value.codeAssetManifestDigest === null && value.codeAssetManifestReason === "legacy-release-predates-code-packs" ||
        /^[a-f0-9]{64}$/.test(value.codeAssetManifestDigest ?? "")) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new protocol.PublicReleaseProtocolError();
  }
  const cursor = value.baselineCursor;
  protocol.exact(cursor, ["baselineDigest", "sequence", "lastDigest"]);
  parsePublicReleaseChangeHead({ schemaVersion: 2, ...cursor });
  return protocol.freeze({ ...value, baselineCursor: { baselineDigest: cursor.baselineDigest, sequence: cursor.sequence, lastDigest: cursor.lastDigest } });
}

module.exports = { parsePublicReleaseChangeBaseline };
