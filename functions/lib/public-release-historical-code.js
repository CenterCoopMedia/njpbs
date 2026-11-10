"use strict";
const { createHash } = require("node:crypto");
const protocol = require("./public-release-pair");
const { validateCurrentCodeReference } = require("./current-public-code-source");
const CHUNKS = "system/publicReleaseChanges/codeChunks", CODE_PATH = "system/publicReleaseHistoricalCode";
const hash = value => createHash("sha256").update(value).digest("hex");
function refuse() { throw Object.assign(new Error("Historical CODE authority is unavailable"), { code: "historical-code-authority-missing" }); }
function verifyPublicReleaseQualifiedCode(value) {
  if (!value || !value.publicContext) refuse();
  const reference = validateCurrentCodeReference(value.reference);
  if (protocol.publicReleaseDigest(reference.publication) !== protocol.publicReleaseDigest(value.publication)) refuse();
  const receipt = value.publicContext.receipt;
  if (["buildBatchId", "generation", "commitSha", "mediaManifestDigest"].some(key => receipt?.[key] !== value.publication[key])) refuse();
  return value;
}
/** Exact DTO serialization preserves the CODE object's original key order,
 * which is part of the existing Schedule code.contextDigest computation. */
function prepareRetainedPublicReleaseCode(qualified) {
  verifyPublicReleaseQualifiedCode(qualified);
  const bytes = Buffer.from(JSON.stringify(qualified));
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) refuse();
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 400_000) {
    const part = bytes.subarray(offset, offset + 400_000);
    chunks.push({ digest: hash(part), value: { schemaVersion: 2, base64: part.toString("base64") } });
  }
  return { descriptor: { reference: qualified.reference, qualifiedCodeDigest: hash(bytes), qualifiedCodeBytes: bytes.length,
    chunks: chunks.map(chunk => chunk.digest) }, chunks };
}
async function readRetainedPublicReleaseCode({ firestore, descriptor, readCodeBytes }) {
  if (!descriptor) refuse();
  if (descriptor.reference?.kind === "pair") {
    protocol.exact(descriptor, ["reference", "pair"]);
    const resolved = await firestore.runTransaction(transaction => require("./public-release-pair-code-reference")
      .assertPairCodeReferenceInTransaction({ firestore, transaction, reference: descriptor.reference }), { readOnly: true });
    if (protocol.publicReleaseDigest(protocol.parsePublicReleasePairReference(descriptor.pair)) !==
        protocol.publicReleaseDigest(protocol.publicReleasePairReference(resolved.pair))) refuse();
    return readRetainedPublicReleaseCode({ firestore, descriptor: resolved.publication.historicalCode });
  }
  const reference = validateCurrentCodeReference(descriptor.reference);
  if (descriptor.chunks !== undefined) {
    if (!Array.isArray(descriptor.chunks) || !descriptor.chunks.length || descriptor.chunks.length > 53 ||
        !/^[a-f0-9]{64}$/.test(descriptor.qualifiedCodeDigest ?? "") || !Number.isSafeInteger(descriptor.qualifiedCodeBytes) ||
        descriptor.qualifiedCodeBytes < 1 || descriptor.qualifiedCodeBytes > 20 * 1024 * 1024) refuse();
    const parts = [];
    for (const digest of descriptor.chunks) {
      if (!/^[a-f0-9]{64}$/.test(digest)) refuse();
      const row = (await firestore.doc(`${CHUNKS}/${digest}`).get()).data();
      if (row?.schemaVersion !== 2 || typeof row.base64 !== "string" || row.base64.length > 533_336) refuse();
      const bytes = Buffer.from(row.base64, "base64");
      if (bytes.toString("base64") !== row.base64 || hash(bytes) !== digest) refuse(); parts.push(bytes);
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== descriptor.qualifiedCodeBytes || hash(bytes) !== descriptor.qualifiedCodeDigest) refuse();
    const qualified = verifyPublicReleaseQualifiedCode(JSON.parse(bytes.toString("utf8")));
    if (protocol.publicReleaseDigest(qualified.reference) !== protocol.publicReleaseDigest(reference)) refuse();
    return qualified;
  }
  // Activation retained its immutable artifact reference in the append txn.
  // Read only that exact object; a live publication probe is never a substitute.
  if (typeof readCodeBytes !== "function") refuse();
  const bytes = Buffer.from(await readCodeBytes(reference.manifest.key));
  if (bytes.length !== reference.manifest.byteLength || hash(bytes) !== reference.manifest.sha256) refuse();
  return verifyPublicReleaseQualifiedCode(require("./home-retained-sources").qualifyHistoricalCodeContext({ reference, bytes }));
}
module.exports = { CHUNKS, CODE_PATH, prepareRetainedPublicReleaseCode, readRetainedPublicReleaseCode, verifyPublicReleaseQualifiedCode };
