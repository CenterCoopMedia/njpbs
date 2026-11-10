"use strict";
const { createHash } = require("node:crypto");
const protocol = require("./public-release-pair");
const work = require("./public-release-pair-work");
const view = require("./public-release-pair-view");
const baselineView = require("./public-release-pair-code-pack-view");
const authors = require("./public-release-pair-author");
const staticTarget = require("./public-release-pair-static-target");
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function refuse() { throw new work.PairExecutionError("byte-mismatch"); }
function publicReleasePairCompositeAuxiliaryKind(path) {
  if (authors.isPublicReleasePairAuthorPath(path)) return "author";
  return ({ "/api/v1/content.json": "feed-index", "/feeds/news.xml": "rss", "/search/meaning-index.json": "semantic",
    "/_publication.json": "publication", "/_content-status.json": "content-status", "/_schedule-sources.json": "schedule-json",
    "/schedule/downloads/nj-pbs-schedule.pdf": "schedule-pdf" })[path] ?? (/^\/sitemap(?:-[A-Za-z0-9_-]+)?\.xml$/.test(path) ? "sitemap" : null);
}
function publicReleasePairCompositeAuxiliaryMime(kind) {
  return kind === "author" ? "text/html; charset=utf-8" : kind === "rss" ? "application/rss+xml; charset=utf-8" : kind === "sitemap" ? "application/xml; charset=utf-8" :
    kind === "schedule-pdf" ? "application/pdf" : ["feed-index", "semantic", "publication", "content-status", "schedule-json"].includes(kind) ? "application/json; charset=utf-8" : null;
}
function parseAuthority(value, pair) {
  const optional = value && Object.hasOwn(value, "staticTargetDigest") ? ["staticTargetDigest"] : [];
  protocol.exact(value, ["baselineInputManifestDigest", "baselineCodePackManifestDigest", "baselineViewManifestDigest", "codeAssetManifestDigest",
    "sourceDependencyDigest", "sourceCensusDigest", "searchInputDigest", ...optional]);
  if (!Object.values(value).every(protocol.digest) || value.codeAssetManifestDigest !== pair.codeAssetManifestDigest) refuse();
  return { baselineInputManifestDigest: value.baselineInputManifestDigest, baselineCodePackManifestDigest: value.baselineCodePackManifestDigest,
    baselineViewManifestDigest: value.baselineViewManifestDigest, codeAssetManifestDigest: value.codeAssetManifestDigest,
    sourceDependencyDigest: value.sourceDependencyDigest, sourceCensusDigest: value.sourceCensusDigest, searchInputDigest: value.searchInputDigest,
    ...(optional.length ? { staticTargetDigest: value.staticTargetDigest } : {}) };
}
function parsePublicReleasePairCompositeManifest(value, rawPair, rawIdentity, expectedCursor) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair);
  protocol.exact(value, ["schemaVersion", "kind", "pairDigest", "inputManifestDigest", "cursor", "authority", "members"]);
  parseAuthority(value.authority, pair);
  const cursor = view.parsePublicReleasePairViewCursor(value.cursor, identity);
  if (value.schemaVersion !== 1 || value.kind !== "pair-composite-manifest" || value.pairDigest !== protocol.publicReleaseDigest(pair) ||
      value.inputManifestDigest !== identity.inputManifestDigest || expectedCursor && !same(cursor, expectedCursor) ||
      !Object.values(value.authority).every(protocol.digest) || value.authority.codeAssetManifestDigest !== pair.codeAssetManifestDigest ||
      !Array.isArray(value.members) || !value.members.length || value.members.length > view.VIEW_OUTPUT_LIMIT) refuse();
  let previous = "", total = 0;
  const members = value.members.map(row => {
    const author = row.role === "auxiliary" && row.kind === "author";
    protocol.exact(row, ["path", "role", "kind", "status", "mime", "size", "sha256", "sourceDependencyDigest", ...(author ? ["owner"] : [])]);
    const owner = author ? authors.parsePublicReleasePairAuthorOwner(row.owner) : null;
    if (!(view.isPrivatePairArtifactPath(row.path) || author && authors.isPublicReleasePairAuthorPath(row.path) || row.role === "route" && typeof row.path === "string" && row.path.length <= 1024 &&
        /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(row.path) && row.path.split("/").every(part => ![".", ".."].includes(part))) ||
        view.comparePrivatePairArtifactPaths(row.path, previous) <= 0 ||
        ![200, 302, 308, 410].includes(row.status) || typeof row.mime !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:; charset=utf-8)?$/.test(row.mime) ||
        !Number.isSafeInteger(row.size) || row.size < 0 || row.size > view.BODY_BYTES_LIMIT || !protocol.digest(row.sha256) ||
        row.sourceDependencyDigest !== value.authority.sourceDependencyDigest) refuse();
    const valid = row.role === "route" ? ["post", "page", "context", "record", "json", "withdrawal", "redirect"].includes(row.kind) &&
      /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(row.path) && !row.path.startsWith("/authors/") :
      row.role === "search" ? row.kind === "pagefind" && row.status === 200 && row.path.startsWith("/pagefind/") :
      row.role === "content-feed" ? row.kind === "content-feed-page" && row.status === 200 && /^\/api\/v1\/content\/[1-9][0-9]*\.json$/.test(row.path) :
      row.role === "catalog" ? row.kind === "catalog-image" && row.status === 200 && /^\/_astro\/[A-Za-z0-9._-]+\.(avif|webp|jpeg|jpg|png)$/.test(row.path) :
      row.role === "auxiliary" ? row.kind === publicReleasePairCompositeAuxiliaryKind(row.path) && row.mime === publicReleasePairCompositeAuxiliaryMime(row.kind) && (author
        ? owner.sourceCensusDigest === value.authority.sourceCensusDigest &&
          (row.status === 200 ? row.path === owner.canonicalPath && row.size > 0 :
            row.size === 0 && row.sha256 === createHash("sha256").update("").digest("hex") && (row.status !== 308 || row.path !== owner.canonicalPath))
        : row.status === 200) : false;
    if (!valid) refuse();
    previous = row.path; total += row.size;
    return { path: row.path, role: row.role, kind: row.kind, status: row.status, mime: row.mime, size: row.size, sha256: row.sha256,
      sourceDependencyDigest: row.sourceDependencyDigest, ...(owner ? { owner } : {}) };
  });
  if (total > view.VIEW_TOTAL_BYTES_LIMIT) refuse();
  const a = value.authority;
  return protocol.freeze({ schemaVersion: 1, kind: "pair-composite-manifest", pairDigest: value.pairDigest, inputManifestDigest: identity.inputManifestDigest,
    cursor: { baselineDigest: cursor.baselineDigest, sequence: cursor.sequence, lastDigest: cursor.lastDigest },
    authority: parseAuthority(a, pair), members });
}
const publicReleasePairCompositeManifestDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function publicReleasePairCompositeProofPath(pair, digest) {
  pair = protocol.parsePublicReleasePair(pair); if (!protocol.digest(digest)) refuse();
  return `${work.publicReleasePairPath(pair.pairId)}/compositeViews/${digest}`;
}
function parsePublicReleasePairCompositeProof(value, rawPair, rawIdentity, claimDigest, viewManifestDigest) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair);
  protocol.exact(value, ["schemaVersion", "kind", "status", "pairDigest", "taskId", "identity", "claimDigest", "viewManifestDigest", "viewReadbackDigest",
    "inputManifestDigest", "snapshotDigest", "cursor", "descriptor", "outputCount", "outputBytes", "routeCount", "authority"]);
  protocol.exact(value.descriptor, ["digest", "key", "bytes"]);
  parseAuthority(value.authority, pair);
  if (!Object.values(value.authority).every(protocol.digest) || value.authority.codeAssetManifestDigest !== pair.codeAssetManifestDigest) refuse();
  const cursor = view.parsePublicReleasePairViewCursor(value.cursor, identity);
  if (value.schemaVersion !== 1 || value.kind !== "pair-composite-proof" || value.status !== "staged" || value.pairDigest !== protocol.publicReleaseDigest(pair) ||
      value.taskId !== protocol.publicReleaseDigest(identity) || !same(value.identity, identity) || value.claimDigest !== claimDigest || value.viewManifestDigest !== viewManifestDigest ||
      value.inputManifestDigest !== identity.inputManifestDigest || value.snapshotDigest !== identity.snapshotDigest || !protocol.digest(value.viewReadbackDigest) ||
      !protocol.digest(value.descriptor.digest) || value.descriptor.key !== view.publicReleasePairViewObjectKey(pair, identity, claimDigest, value.descriptor.digest) ||
      !protocol.positive(value.descriptor.bytes) || value.descriptor.bytes > view.BODY_BYTES_LIMIT || !protocol.positive(value.outputCount) || value.outputCount > view.VIEW_OUTPUT_LIMIT ||
      !Number.isSafeInteger(value.outputBytes) || value.outputBytes < 0 || value.outputBytes > view.VIEW_TOTAL_BYTES_LIMIT ||
      !protocol.positive(value.routeCount) || value.routeCount > value.outputCount) refuse();
  return protocol.freeze({ ...value, identity, cursor });
}
/** Metadata-only final transaction guard. Actual storage reads happen before
 * this transaction; its immutable proof binds their exact completed owner. */
async function assertReadPublicReleasePairCompositeInTransaction({ firestore, transaction, pair: rawPair, identity: rawIdentity, claimDigest,
  viewManifestDigest, manifest: rawManifest, manifestDigest }) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair), base = work.publicReleasePairPath(pair.pairId);
  const manifest = parsePublicReleasePairCompositeManifest(rawManifest, pair, identity);
  if (publicReleasePairCompositeManifestDigest(manifest) !== manifestDigest) refuse();
  const [proofRow, stagedRow] = await transaction.getAll(firestore.doc(publicReleasePairCompositeProofPath(pair, viewManifestDigest)), firestore.doc(`${base}/views/${viewManifestDigest}`));
  const proof = parsePublicReleasePairCompositeProof(proofRow.data(), pair, identity, claimDigest, viewManifestDigest), staged = stagedRow.data();
  const scope = { kind: identity.kind, sourceOperationId: identity.sourceOperationId, sourceVersion: identity.sourceVersion,
    snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence };
  const captured = await work.assertPublicReleasePairInputOwnerInTransaction({ firestore, transaction, pair, scope, inputManifestDigest: identity.inputManifestDigest });
  const baseline = await baselineView.assertReadPublicReleasePairStagedCodePackInTransaction({ firestore, transaction, pair });
  await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair, taskId: proof.taskId, claimDigest, manifestDigest: viewManifestDigest });
  if (!captured.receipt || !same(captured.receipt.cursor, manifest.cursor) || !same(proof.cursor, manifest.cursor) || !same(proof.authority, manifest.authority) ||
      proof.descriptor.digest !== manifestDigest || proof.outputCount !== manifest.members.length || proof.outputBytes !== manifest.members.reduce((sum, row) => sum + row.size, 0) ||
      proof.routeCount !== manifest.members.filter(row => row.role === "route").length || staged?.status !== "staged" || staged.claimDigest !== claimDigest ||
      staged.manifestDigest !== viewManifestDigest || staged.readbackDigest !== proof.viewReadbackDigest || !same(staged.identity, identity) || !same(staged.cursor, manifest.cursor) ||
      staged.outputCount !== proof.outputCount || staged.outputBytes !== proof.outputBytes ||
      baseline.inputManifestDigest !== proof.authority.baselineInputManifestDigest || baseline.codePackManifestDigest !== proof.authority.baselineCodePackManifestDigest ||
      baseline.viewManifestDigest !== proof.authority.baselineViewManifestDigest || baseline.cursor.baselineDigest !== manifest.cursor.baselineDigest || baseline.cursor.sequence > manifest.cursor.sequence) refuse();
  if (manifest.authority.staticTargetDigest) {
    const row = await transaction.get(firestore.doc(staticTarget.publicReleasePairStaticTargetProofPath(pair, viewManifestDigest)));
    const target = staticTarget.parsePublicReleasePairStaticTargetProof(row.data(), pair, identity, claimDigest, viewManifestDigest,
      manifest.authority.staticTargetDigest, staged.readbackDigest);
    if (manifest.members.find(member => member.path === "/_publication.json")?.sha256 !== target.targetPublicationDigest ||
        manifest.members.find(member => member.path === "/_content-status.json")?.sha256 !== target.targetStatusDigest) refuse();
  }
  return proof;
}
module.exports = { publicReleasePairCompositeAuxiliaryKind, publicReleasePairCompositeAuxiliaryMime, parsePublicReleasePairCompositeManifest, publicReleasePairCompositeManifestDigest,
  publicReleasePairCompositeProofPath, parsePublicReleasePairCompositeProof, assertReadPublicReleasePairCompositeInTransaction };
