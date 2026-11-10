"use strict";

const { createHash } = require("node:crypto");
const p = require("./public-release-pair");
const { MAX_BYTES, parsePairCodeRequest } = require("./current-public-code-v2");

/** Shared wire serializer for the endpoint and independent retained-source
 * evidence. The caller must verify the original SDK authority around byte I/O;
 * serialization itself grants no authority and writes no proof or receipt. */
function serializePairCurrentCodeResponse({ request: raw, authority, bytes }) {
  const request = parsePairCodeRequest(raw);
  if (!["current-code-v2", "current-code-reference-v2"].includes(request.mode)) throw new Error("Invalid pair CODE mode");
  const descriptor = authority.publication.historicalCode;
  if (request.mode === "current-code-v2" && (!Buffer.isBuffer(bytes) ||
      bytes.length !== descriptor.qualifiedCodeBytes || bytes.length > MAX_BYTES ||
      createHash("sha256").update(bytes).digest("hex") !== descriptor.qualifiedCodeDigest)) {
    throw new Error("Original pair CODE bytes are unavailable");
  }
  const reference = { schemaVersion: 2, kind: "pair-current-code", rendererSha: request.rendererSha,
    selection: request.selection, source: authority.publication.reference, pairDigest: p.publicReleaseDigest(authority.pair),
    readerDigests: Object.fromEntries(Object.entries(authority.readers).map(([component, reader]) => [component,
      require("./cms-reader-session").readerSessionDigest(reader)])),
    qualifiedCodeDigest: descriptor.qualifiedCodeDigest, qualifiedCodeBytes: descriptor.qualifiedCodeBytes };
  return request.mode === "current-code-reference-v2" ? { schemaVersion: 2, kind: "pair-current-code-reference", reference }
    : { schemaVersion: 2, kind: "pair-current-code", reference, qualifiedCodeBase64: bytes.toString("base64") };
}

module.exports = { serializePairCurrentCodeResponse };
