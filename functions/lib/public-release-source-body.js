"use strict";
const { createHash } = require("node:crypto");
const protocol = require("./public-release-pair");
const BODY_COLLECTION = "system/publicReleaseChanges/bodies";
const BODY_CHUNKS = "system/publicReleaseChanges/bodyChunks";
const BODY_BYTES_LIMIT = 2_000_000;
const CHUNK_BYTES = 400_000;
const hash = value => createHash("sha256").update(value).digest("hex");
function refuse() { throw new protocol.PublicReleaseProtocolError(); }
function publicReleaseSnapshotJson(value, maxBytes = 800_000) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const json = JSON.stringify(canonical(value));
  if (typeof json !== "string" || Buffer.byteLength(json) > maxBytes) refuse();
  return json;
}
const AUTHORITY_FIELDS = ["schemaVersion", "state", "mediaLifecycleReady", "activeGeneration", "activeDeploymentId", "activeCommitSha",
  "lastReservedGeneration", "newestEligibleGeneration", "newestEligibleBuildBatchId", "rendererSha", "generation", "servingEnabled",
  "families", "terminalOwner", "dataFigureVersion", "dataHubReportingVersion", "dataHubCompositionVersion", "liveBlogVersion",
  "electionResultsVersion", "revision", "enabled", "postId", "backgroundBucket", "operationId", "sourceVersion", "snapshotDigest",
  "visible", "ownedPaths", "canonicalPath", "path", "slug", "ownedSlugs", "family", "documentId", "pageId", "runtime", "mode",
  "admissionRevision", "contextRevision", "contextDigest", "durableWithdrawal", "owner", "ownerPath", "retainedSource", "externalInputs",
  "datasetFiguresDigest", "homeRefresh", "output", "changedAt", "staticProof"];
function publicReleaseAuthorityProjection(value) {
  const result = Object.fromEntries(AUTHORITY_FIELDS.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  if (result.staticProof !== undefined) result.staticProof = require("./no-build-post-static-proof").projectStaticProof(result.staticProof);
  if (result.changedAt?.toDate) result.changedAt = result.changedAt.toDate().toISOString();
  if (result.homeRefresh) result.homeRefresh = Object.fromEntries(["schemaVersion", "revision", "sourceOperationId", "postId", "sourceVersion", "postChanges", "sourceTransport"]
    .filter(key => result.homeRefresh[key] !== undefined).map(key => [key, result.homeRefresh[key]]));
  return result;
}
const ROOT_AUTHORITY = "system/publicDeployment";
const MEDIA_AUTHORITY = `${ROOT_AUTHORITY}/pairMedia/current`;
function rootAuthority(value) {
  // Operational timestamps are not renderer input, including a pending SDK
  // server timestamp supplied by the original source transaction.
  return protocol.parseVersionedPublicDeployment(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "updatedAt")));
}
function codeAuthority(pointer) {
  return { schemaVersion: 1, state: "idle", mediaLifecycleReady: pointer.mediaLifecycleReady,
    activeGeneration: pointer.activeGeneration, activeDeploymentId: pointer.activeDeploymentId, activeCommitSha: pointer.activeCommitSha,
    lastReservedGeneration: pointer.activeGeneration, newestEligibleGeneration: pointer.activeGeneration,
    newestEligibleBuildBatchId: pointer.activeDeploymentId };
}
function mediaAuthority(value) {
  protocol.exact(value, ["schemaVersion", "epoch", "activeGeneration", "lastReservedGeneration", "newestEligibleGeneration", "references"]);
  if (value.schemaVersion !== 2 || !protocol.positive(value.epoch) || !protocol.positive(value.activeGeneration) ||
      value.lastReservedGeneration !== value.activeGeneration || value.newestEligibleGeneration !== value.activeGeneration ||
      !Array.isArray(value.references) || value.references.length < 2 || value.references.length > 8) refuse();
  const ids = new Set();
  for (const reference of value.references) {
    protocol.exact(reference, ["pairId", "manifestDigest"]);
    if (!require("./public-deployment-pointer").isPublicDeploymentIdentifier(reference.pairId) ||
        !protocol.digest(reference.manifestDigest) || ids.has(reference.pairId)) refuse();
    ids.add(reference.pairId);
  }
  return { ...value, references: value.references.map(reference => ({ ...reference })) };
}
/** Raw renderer authority stays in H. In particular, a schema-two root must
 * never become a schema-one media-readiness claim. Old schema-one bodies keep
 * their original CODE projection and need no invented pair-media record. */
function publicReleaseAuthorityDocument(path, value) {
  if (value === null) return null;
  // #4582: the production codec and original-operation marker lifecycle are
  // unreviewed. Never reduce failed-work evidence to generic authority fields.
  if (path === "system/productionPublicReleasePauseRecovery") refuse();
  if (path === "system/devPublicReleasePauseRecovery") return require("./dev-public-release-pause-recovery-evidence")
    .parseDevPublicReleasePauseRecoveryEvidence(value, protocol, require("./public-deployment-pointer").isPublicDeploymentIdentifier);
  if (path === MEDIA_AUTHORITY) return mediaAuthority(value);
  if (path !== ROOT_AUTHORITY) return publicReleaseAuthorityProjection(value);
  const pointer = rootAuthority(value);
  return pointer.schemaVersion === 2 ? pointer : codeAuthority(pointer);
}
/** Editorial source identity excludes activation's operational content head.
 * The complete root and media record remain sealed in raw H; the census must
 * independently validate their actual pair fence before using this identity. */
function publicReleaseAuthorityIdentityDocument(path, value) {
  if (value === null) return null;
  return path === ROOT_AUTHORITY ? codeAuthority(rootAuthority(value)) : publicReleaseAuthorityDocument(path, value);
}

function assertBody(value) {
  protocol.exact(value, ["schemaVersion", "kind", "id", "action", "sourceVersion", "snapshot", "documents"]);
  if (value.schemaVersion !== 2 || !["post", "page", "record", "settings", "library", "media", "author", "provider", "schedule", "dataHub"].includes(value.kind) ||
      !require("./public-deployment-pointer").isPublicDeploymentIdentifier(value.id) ||
      !["publish", "withdraw", "dependency"].includes(value.action) || !protocol.positive(value.sourceVersion) ||
      !Array.isArray(value.documents) || value.documents.length > 100) refuse();
  const paths = new Set();
  for (const document of value.documents) {
    protocol.exact(document, ["path", "data"]);
    if (typeof document.path !== "string" || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.:-]+)+$/.test(document.path) ||
        document.path.split("/").some(part => part === "." || part === "..") || document.path.split("/").length % 2 !== 0 ||
        !/^(cmsPosts|cmsPages|cmsSettings|cmsAuthorProfilesPublic|media_assets|media_assets_public|cmsVersionHistory|cmsPreviewPublicContexts|system|cmsBackgroundOutputs)\//.test(document.path) ||
        document.data !== null && (!document.data || typeof document.data !== "object" || Array.isArray(document.data)) || paths.has(document.path)) refuse();
    paths.add(document.path);
  }
}
const CONTENT = new Set(["post", "page", "record"]);
function sourceDocuments(change) {
  const { kind, id, snapshot, sourceVersion, action } = change;
  if (change.sourceDocuments) return change.sourceDocuments.map(document => ({ ...document,
    data: /^system\/publicDeployment(?:\/|$)/.test(document.path) || document.path === "system/noBuildPostAdmission"
      ? publicReleaseAuthorityDocument(document.path, document.data) : document.data }));
  if (CONTENT.has(kind)) return [{ path: `${kind === "page" ? "cmsPages" : "cmsPosts"}/${id}`, data: {
    id, type: snapshot.metadata.type ?? "page", version: sourceVersion, status: action === "withdraw" ? "draft" : "published",
    publiclyVisible: action !== "withdraw", deleted: false, publishAt: snapshot.publishedAt, published: snapshot,
  } }];
  if (kind === "settings") return [{ path: `cmsSettings/${id}`, data: { published: snapshot, version: sourceVersion } }];
  if (kind === "author") return [{ path: `cmsAuthorProfilesPublic/${id}`, data: snapshot }];
  if (kind === "media") {
    if (!change.mediaSource && snapshot !== null) refuse();
    const privateData = snapshot === null ? null : { ...snapshot, source: change.mediaSource.source, lifecycle: "active" };
    return [{ path: `media_assets_public/${id}`, data: snapshot }, { path: `media_assets/${id}`, data: privateData }];
  }
  if (kind === "library") {
    const data = snapshot ? { ...snapshot, id, status: "approved", version: sourceVersion, deleted: false } : null;
    // This is a private projection of already-attested approval, never a write
    // to the live history or an approval API. The original event remains proof.
    return [{ path: `cmsPosts/${id}`, data }, { path: `cmsVersionHistory/release-source-${hash(id)}`,
      data: snapshot ? { collection: "cmsPosts", documentId: id, action: "approve", after: data } : null }];
  }
  return []; // Provider paths are combined atomically by the materializer.
}
function makePublicReleaseSourceBody(change) {
  const value = { schemaVersion: 2, kind: change.kind, id: change.id, action: change.action,
    sourceVersion: change.sourceVersion, snapshot: change.snapshot, documents: sourceDocuments(change) };
  assertBody(value);
  // A body also contains the reader's public document projection. Keep the
  // existing 800 KB snapshot admission bound and store larger bodies in
  // immutable chunks rather than halving that bound or exceeding Firestore.
  const json = publicReleaseSnapshotJson(value, BODY_BYTES_LIMIT);
  return { contentDigest: hash(json), json };
}
async function preparePublicReleaseSourceBodies({ firestore, transaction, values }) {
  const unique = new Map(values.map(value => [value.contentDigest, value]));
  const writes = new Map();
  for (const value of unique.values()) {
    const bytes = Buffer.from(value.json);
    if (hash(bytes) !== value.contentDigest || bytes.length > BODY_BYTES_LIMIT) refuse();
    let stored = { schemaVersion: 2, json: value.json };
    if (bytes.length > CHUNK_BYTES) {
      const chunks = [];
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        const part = bytes.subarray(offset, offset + CHUNK_BYTES), digest = hash(part);
        chunks.push(digest); writes.set(`${BODY_CHUNKS}/${digest}`, { schemaVersion: 2, base64: part.toString("base64") });
      }
      stored = { schemaVersion: 2, bytes: bytes.length, chunks };
    }
    writes.set(`${BODY_COLLECTION}/${value.contentDigest}`, stored);
  }
  const refs = [...writes.keys()].map(path => firestore.doc(path));
  const existing = refs.length ? await transaction.getAll(...refs) : [];
  const records = [...writes.values()];
  existing.forEach((row, index) => { if (row.exists && protocol.publicReleaseDigest(row.data()) !== protocol.publicReleaseDigest(records[index])) refuse(); });
  return () => records.forEach((value, index) => { if (!existing[index].exists) transaction.create(refs[index], value); });
}
async function readPublicReleaseSourceBody({ firestore, transaction, contentDigest }) {
  if (!/^[a-f0-9]{64}$/.test(contentDigest ?? "")) refuse();
  const row = await transaction.get(firestore.doc(`${BODY_COLLECTION}/${contentDigest}`)), value = row.data();
  if (!row.exists || value?.schemaVersion !== 2) refuse();
  let json = value.json;
  if (json === undefined) {
    protocol.exact(value, ["schemaVersion", "bytes", "chunks"]);
    if (!Number.isSafeInteger(value.bytes) || value.bytes <= CHUNK_BYTES || value.bytes > BODY_BYTES_LIMIT ||
        !Array.isArray(value.chunks) || value.chunks.length !== Math.ceil(value.bytes / CHUNK_BYTES) ||
        value.chunks.some(digest => !/^[a-f0-9]{64}$/.test(digest))) refuse();
    const rows = await transaction.getAll(...value.chunks.map(digest => firestore.doc(`${BODY_CHUNKS}/${digest}`)));
    const chunks = rows.map((row, index) => {
      const chunk = row.data();
      if (chunk?.schemaVersion !== 2 || typeof chunk.base64 !== "string" || chunk.base64.length > 533_336) refuse();
      const bytes = Buffer.from(chunk.base64, "base64");
      if (bytes.toString("base64") !== chunk.base64 || hash(bytes) !== value.chunks[index] ||
          bytes.length !== Math.min(CHUNK_BYTES, value.bytes - index * CHUNK_BYTES)) refuse();
      return bytes;
    });
    json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  }
  if (typeof json !== "string" || hash(json) !== contentDigest) refuse();
  const body = JSON.parse(json);
  if (publicReleaseSnapshotJson(body, BODY_BYTES_LIMIT) !== json) refuse();
  assertBody(body);
  return body;
}
module.exports = { BODY_COLLECTION, publicReleaseAuthorityProjection, publicReleaseAuthorityDocument, publicReleaseAuthorityIdentityDocument, publicReleaseSnapshotJson, makePublicReleaseSourceBody,
  preparePublicReleaseSourceBodies, readPublicReleaseSourceBody };
