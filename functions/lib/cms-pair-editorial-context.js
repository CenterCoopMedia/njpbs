"use strict";

const { createHash } = require("node:crypto");
const p = require("./public-release-pair");
const views = require("./public-release-pair-view");
const { validateCurrentCodeReference } = require("./current-public-code-source");
const ROOT = "cmsPreviewEditorialPairContexts";
const MAX_BYTES = 20 * 1024 * 1024;
const CHUNK_BYTES = 400 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
function refuse() { throw new Error("Immutable paired editorial context is unavailable"); }
function base(pair) { return `${ROOT}/${p.publicReleaseDigest(p.parsePublicReleasePair(pair))}`; }
function parseSource(value, pair) {
  p.exact(value, ["schemaVersion", "kind", "pair", "pairDigest", "identity", "claimDigest", "viewManifestDigest", "cursor", "renderedAt",
    "sourcePair", "originalCode", "documents", "homeSources"]);
  const identity = views.parseViewIdentity(value.identity, pair);
  const cursor = views.parsePublicReleasePairViewCursor(value.cursor, identity);
  const sourcePair = p.parsePublicReleasePairReference(value.sourcePair);
  const keys = ["reference", "qualifiedCodeDigest", ...(Object.hasOwn(value.originalCode ?? {}, "programImageDescriptors") ? ["programImageDescriptors"] : [])];
  p.exact(value.originalCode, keys);
  const reference = validateCurrentCodeReference(value.originalCode.reference);
  if (value.schemaVersion !== 2 || value.kind !== "pair-editorial-context-source" || value.pairDigest !== p.publicReleaseDigest(pair) ||
      !same(p.parsePublicReleasePairReference(value.pair), p.publicReleasePairReference(pair)) || !p.digest(value.claimDigest) ||
      !p.digest(value.viewManifestDigest) || !p.digest(value.originalCode.qualifiedCodeDigest) ||
      typeof value.renderedAt !== "string" || !Number.isFinite(Date.parse(value.renderedAt)) || new Date(value.renderedAt).toISOString() !== value.renderedAt ||
      reference.publication.commitSha !== sourcePair.commitSha || !value.homeSources || typeof value.homeSources !== "object" ||
      value.homeSources.publication?.commitSha !== sourcePair.commitSha ||
      !Array.isArray(value.documents) || value.documents.length > 20_000) refuse();
  let previous = "";
  for (const row of value.documents) {
    p.exact(row, ["path", "data"]);
    if (typeof row.path !== "string" || row.path <= previous ||
        !/^(?:cmsPages|cmsPosts|cmsAuthorProfilesPublic|cmsSettings|media_assets_public|cmsVersionHistory)\/[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]+)*$/.test(row.path) ||
        !row.data || typeof row.data !== "object" || Array.isArray(row.data)) refuse();
    previous = row.path;
  }
  return { ...value, identity, cursor, sourcePair };
}
function parseManifest(value, pair) {
  p.exact(value, ["schemaVersion", "kind", "pairDigest", "identity", "claimDigest", "viewManifestDigest", "cursor", "bodyDigest", "bodyBytes", "chunks"]);
  const identity = views.parseViewIdentity(value.identity, pair), cursor = views.parsePublicReleasePairViewCursor(value.cursor, identity);
  if (value.schemaVersion !== 2 || value.kind !== "pair-editorial-context-manifest" || value.pairDigest !== p.publicReleaseDigest(pair) ||
      !p.digest(value.claimDigest) || !p.digest(value.viewManifestDigest) || !p.digest(value.bodyDigest) ||
      !Number.isSafeInteger(value.bodyBytes) || value.bodyBytes < 1 || value.bodyBytes > MAX_BYTES ||
      !Array.isArray(value.chunks) || value.chunks.length !== Math.ceil(value.bodyBytes / CHUNK_BYTES) || value.chunks.some(d => !p.digest(d))) refuse();
  return { ...value, identity, cursor };
}
async function immutable(firestore, path, value) {
  const ref = firestore.doc(path);
  await firestore.runTransaction(async transaction => {
    const row = await transaction.get(ref);
    if (row.exists) { if (!same(row.data(), value)) refuse(); }
    else transaction.create(ref, value);
  });
}
/** Private side output only. Chunk and manifest names hold their actual content
 * digests. Completion never writes a work receipt, selector or public head. */
async function writePairEditorialContext({ firestore, pair: rawPair, source: rawSource }) {
  const pair = p.parsePublicReleasePair(rawPair), source = parseSource(rawSource, pair), prefix = base(pair);
  const bytes = Buffer.from(JSON.stringify(source));
  if (bytes.length < 1 || bytes.length > MAX_BYTES) refuse();
  const bodyDigest = hash(bytes), chunks = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES), digest = hash(chunk); chunks.push(digest);
    await immutable(firestore, `${prefix}/chunks/${digest}`, { schemaVersion: 1, digest, bytes: chunk.length, base64: chunk.toString("base64") });
  }
  const manifest = parseManifest({ schemaVersion: 2, kind: "pair-editorial-context-manifest", pairDigest: p.publicReleaseDigest(pair),
    identity: source.identity, claimDigest: source.claimDigest, viewManifestDigest: source.viewManifestDigest, cursor: source.cursor,
    bodyDigest, bodyBytes: bytes.length, chunks }, pair);
  await immutable(firestore, `${prefix}/contexts/${bodyDigest}`, manifest);
  // Index is create-only. A retry cannot retime or relabel a view's context.
  const index = { schemaVersion: 2, pairDigest: manifest.pairDigest, viewManifestDigest: manifest.viewManifestDigest,
    bodyDigest, manifestDigest: p.publicReleaseDigest(manifest) };
  await immutable(firestore, `${prefix}/views/${source.viewManifestDigest}`, index);
  return { index, manifest };
}
async function readPairEditorialContextManifest({ firestore, transaction, pair: rawPair, viewManifestDigest }) {
  const pair = p.parsePublicReleasePair(rawPair), prefix = base(pair);
  if (!p.digest(viewManifestDigest)) refuse();
  const index = (await transaction.get(firestore.doc(`${prefix}/views/${viewManifestDigest}`))).data();
  // A head may advance before its optional side output completes. Once the
  // create-only index exists, missing or malformed referenced data is an
  // integrity failure rather than a pending write.
  if (index === undefined) throw Object.assign(new Error("Paired editorial output is pending"), { code: "pair_editorial_context_refreshing" });
  p.exact(index, ["schemaVersion", "pairDigest", "viewManifestDigest", "bodyDigest", "manifestDigest"]);
  if (index.schemaVersion !== 2 || index.pairDigest !== p.publicReleaseDigest(pair) || index.viewManifestDigest !== viewManifestDigest ||
      !p.digest(index.bodyDigest) || !p.digest(index.manifestDigest)) refuse();
  const manifest = parseManifest((await transaction.get(firestore.doc(`${prefix}/contexts/${index.bodyDigest}`))).data(), pair);
  if (manifest.bodyDigest !== index.bodyDigest || manifest.viewManifestDigest !== viewManifestDigest || p.publicReleaseDigest(manifest) !== index.manifestDigest) refuse();
  return manifest;
}
async function readPairEditorialContextBytes({ firestore, pair: rawPair, manifest: rawManifest }) {
  const pair = p.parsePublicReleasePair(rawPair), manifest = parseManifest(rawManifest, pair), prefix = base(pair), chunks = [];
  for (let index = 0; index < manifest.chunks.length; index++) {
    const digest = manifest.chunks[index], row = (await firestore.doc(`${prefix}/chunks/${digest}`).get()).data();
    p.exact(row, ["schemaVersion", "digest", "bytes", "base64"]);
    if (row.schemaVersion !== 1 || row.digest !== digest || row.bytes !== Math.min(CHUNK_BYTES, manifest.bodyBytes - index * CHUNK_BYTES) || typeof row.base64 !== "string") refuse();
    const bytes = Buffer.from(row.base64, "base64");
    if (bytes.length !== row.bytes || bytes.toString("base64") !== row.base64 || hash(bytes) !== digest) refuse(); chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== manifest.bodyBytes || hash(bytes) !== manifest.bodyDigest) refuse();
  const source = parseSource(JSON.parse(bytes.toString("utf8")), pair);
  if (!same(source.identity, manifest.identity) || source.claimDigest !== manifest.claimDigest ||
      source.viewManifestDigest !== manifest.viewManifestDigest || !same(source.cursor, manifest.cursor)) refuse();
  return { bytes, source };
}
module.exports = { ROOT, MAX_BYTES, CHUNK_BYTES, parsePairEditorialContextSource: parseSource,
  parsePairEditorialContextManifest: parseManifest, writePairEditorialContext, readPairEditorialContextManifest, readPairEditorialContextBytes };
