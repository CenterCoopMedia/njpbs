"use strict";

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const {
  MAX_MEDIA_OCCURRENCES,
  MAX_MEDIA_USAGE_ASSETS,
} = require("./media-usage");
const { isMediaAssetId } = require("./media-library");
const {
  PublicDeploymentStateError,
  isCommitSha,
  isPublicDeploymentIdentifier,
  projectPublicBuildReservation,
} = require("./public-deployment");

const PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION = 1;
const PUBLIC_MEDIA_MANIFEST_DIGEST_ALGORITHM = "sha256";
const MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK = 200;
const MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_PUBLIC_MEDIA_MANIFEST_OWNERS = 10_000;
const MAX_PUBLIC_MEDIA_MANIFEST_CHUNKS = 100;
const MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES = 2 * 1024 * 1024;
const MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_READS =
  MAX_PUBLIC_MEDIA_MANIFEST_CHUNKS + 3;
const MAX_PUBLIC_MEDIA_OWNER_ID_BYTES = 1_500;
// Ordered, and the order is part of the stored coverage proof and the digest.
// New families are APPENDED so an existing receipt keeps validating against the
// same index positions.
const PUBLIC_MEDIA_MANIFEST_COLLECTIONS = Object.freeze([
  "cmsPages",
  "cmsPosts",
  "cmsSettings",
  // The public author snapshots. They own media -- one profile photograph each
  // -- and they emit a public route, so leaving them out would mean an author
  // page shipped with a photograph that no manifest recorded as deployed.
  "cmsAuthorProfilesPublic",
]);
const PUBLIC_MEDIA_MANIFEST_COLLECTION_SET = new Set(
  PUBLIC_MEDIA_MANIFEST_COLLECTIONS,
);
const MANIFEST_FIELDS = new Set([
  "schemaVersion",
  "digestAlgorithm",
  "buildBatchId",
  "generation",
  "commitSha",
  "cutoffAt",
  "coverage",
  "ownerCount",
  "owners",
  "mediaManifestDigest",
]);
const OWNER_FIELDS = new Set([
  "collection",
  "documentId",
  "sourceVersion",
  "assetIds",
  "occurrenceCount",
]);
const ARTIFACT_INVENTORY_FIELDS = new Set([
  "collection",
  "complete",
  "documentIds",
]);
const COVERAGE_FIELDS = new Set([
  "collection",
  "complete",
  "ownerCount",
  "ownerIdsDigest",
]);
const DEPLOYED_USAGE_FIELDS = new Set([
  "schemaVersion",
  "state",
  "generation",
  "buildBatchId",
  "commitSha",
  "mediaManifestDigest",
  "sourceVersion",
  "assetIds",
  "occurrenceCount",
]);
const DIGEST = /^[a-f0-9]{64}$/;

function invalid(message = "The public media manifest is invalid") {
  throw new PublicDeploymentStateError(message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactFields(value, fields) {
  return plainObject(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every((field) => fields.has(field));
}

function timestampParts(value) {
  if (
    !plainObject(value) ||
    !Number.isSafeInteger(value.seconds) ||
    value.seconds < 0 ||
    !Number.isSafeInteger(value.nanoseconds) ||
    value.nanoseconds < 0 ||
    value.nanoseconds > 999_999_999
  ) {
    invalid();
  }
  return {
    seconds: value.seconds,
    nanoseconds: value.nanoseconds,
  };
}

function isPublicMediaOwnerId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_PUBLIC_MEDIA_OWNER_ID_BYTES &&
    value === value.trim() &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".." &&
    !/^__.*__$/.test(value)
  );
}

function canonicalOwner(value) {
  if (
    !hasExactFields(value, OWNER_FIELDS) ||
    !PUBLIC_MEDIA_MANIFEST_COLLECTION_SET.has(value.collection) ||
    !isPublicMediaOwnerId(value.documentId) ||
    !Number.isSafeInteger(value.sourceVersion) ||
    value.sourceVersion < 1 ||
    !Array.isArray(value.assetIds) ||
    value.assetIds.length > MAX_MEDIA_USAGE_ASSETS ||
    value.assetIds.some((assetId) => !isMediaAssetId(assetId)) ||
    new Set(value.assetIds).size !== value.assetIds.length ||
    !Number.isSafeInteger(value.occurrenceCount) ||
    Object.is(value.occurrenceCount, -0) ||
    value.occurrenceCount < value.assetIds.length ||
    value.occurrenceCount > MAX_MEDIA_OCCURRENCES ||
    (value.assetIds.length === 0 && value.occurrenceCount !== 0)
  ) {
    invalid("The public media manifest owner is invalid");
  }
  return {
    collection: value.collection,
    documentId: value.documentId,
    sourceVersion: value.sourceVersion,
    assetIds: [...value.assetIds].sort(),
    occurrenceCount: value.occurrenceCount,
  };
}

function compareOwners(left, right) {
  const collectionOrder =
    PUBLIC_MEDIA_MANIFEST_COLLECTIONS.indexOf(left.collection) -
    PUBLIC_MEDIA_MANIFEST_COLLECTIONS.indexOf(right.collection);
  if (collectionOrder !== 0) return collectionOrder;
  return Buffer.compare(
    Buffer.from(left.documentId, "utf8"),
    Buffer.from(right.documentId, "utf8"),
  );
}

function canonicalOwners(values) {
  if (!Array.isArray(values)) invalid();
  if (values.length > MAX_PUBLIC_MEDIA_MANIFEST_OWNERS) {
    invalid("The public media manifest owner limit is exceeded");
  }
  const owners = values.map(canonicalOwner).sort(compareOwners);
  const ownerKeys = owners.map(
    ({ collection, documentId }) => `${collection}\u0000${documentId}`,
  );
  if (new Set(ownerKeys).size !== ownerKeys.length) {
    invalid("The public media manifest owner is invalid");
  }
  return owners;
}

function digest(value) {
  return createHash(PUBLIC_MEDIA_MANIFEST_DIGEST_ALGORITHM)
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function compareDocumentIds(left, right) {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  );
}

function ownerIdsDigest(collection, documentIds) {
  return digest({
    schemaVersion: PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION,
    collection,
    documentIds,
  });
}

function coverageEntry(collection, documentIds) {
  return {
    collection,
    complete: true,
    ownerCount: documentIds.length,
    ownerIdsDigest: ownerIdsDigest(collection, documentIds),
  };
}

function ownerIdsByCollection(owners, collection) {
  return owners
    .filter((owner) => owner.collection === collection)
    .map((owner) => owner.documentId);
}

function coverageForOwners(owners) {
  return PUBLIC_MEDIA_MANIFEST_COLLECTIONS.map((collection) =>
    coverageEntry(collection, ownerIdsByCollection(owners, collection)));
}

function coverageFromArtifactInventory(value, owners) {
  if (!Array.isArray(value) ||
      value.length !== PUBLIC_MEDIA_MANIFEST_COLLECTIONS.length) {
    invalid("The public media manifest artifact inventory is invalid");
  }
  const byCollection = new Map();
  for (const entry of value) {
    if (
      !hasExactFields(entry, ARTIFACT_INVENTORY_FIELDS) ||
      !PUBLIC_MEDIA_MANIFEST_COLLECTION_SET.has(entry.collection) ||
      entry.complete !== true ||
      !Array.isArray(entry.documentIds) ||
      entry.documentIds.some((documentId) =>
        !isPublicMediaOwnerId(documentId)) ||
      new Set(entry.documentIds).size !== entry.documentIds.length ||
      byCollection.has(entry.collection)
    ) {
      invalid("The public media manifest artifact inventory is invalid");
    }
    byCollection.set(
      entry.collection,
      [...entry.documentIds].sort(compareDocumentIds),
    );
  }

  return PUBLIC_MEDIA_MANIFEST_COLLECTIONS.map((collection) => {
    const documentIds = byCollection.get(collection);
    const expected = ownerIdsByCollection(owners, collection);
    if (!documentIds || !isDeepStrictEqual(documentIds, expected)) {
      invalid("The public media manifest artifact inventory is invalid");
    }
    return coverageEntry(collection, documentIds);
  });
}

function manifestDigestProjection(value) {
  return {
    schemaVersion: PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION,
    digestAlgorithm: PUBLIC_MEDIA_MANIFEST_DIGEST_ALGORITHM,
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    cutoffAt: value.cutoffAt,
    coverage: value.coverage,
    ownerCount: value.ownerCount,
    owners: value.owners,
  };
}

function createPublicMediaManifest({ reservation, artifactInventory, owners }) {
  const receipt = projectPublicBuildReservation(
    reservation,
    reservation?.buildBatchId ?? null,
  );
  const canonical = canonicalOwners(owners);
  const manifest = manifestDigestProjection({
    buildBatchId: receipt.buildBatchId,
    generation: receipt.generation,
    commitSha: receipt.commitSha,
    cutoffAt: timestampParts(receipt.cutoffAt),
    coverage: coverageFromArtifactInventory(artifactInventory, canonical),
    ownerCount: canonical.length,
    owners: canonical,
  });
  return {
    ...manifest,
    mediaManifestDigest: digest(manifest),
  };
}

function assertCoverage(value, owners) {
  const expected = coverageForOwners(owners);
  if (
    !Array.isArray(value) ||
    value.length !== PUBLIC_MEDIA_MANIFEST_COLLECTIONS.length ||
    value.some((entry) =>
      !hasExactFields(entry, COVERAGE_FIELDS) ||
      !PUBLIC_MEDIA_MANIFEST_COLLECTION_SET.has(entry.collection) ||
      !Number.isSafeInteger(entry.ownerCount) ||
      entry.ownerCount < 0) ||
    !isDeepStrictEqual(value, expected)
  ) {
    invalid();
  }
  return expected;
}

function assertPublicMediaManifest(value, expectedReservation = null) {
  if (
    !hasExactFields(value, MANIFEST_FIELDS) ||
    value.schemaVersion !== PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION ||
    value.digestAlgorithm !== PUBLIC_MEDIA_MANIFEST_DIGEST_ALGORITHM ||
    !DIGEST.test(value.mediaManifestDigest)
  ) {
    invalid();
  }
  const owners = canonicalOwners(value.owners);
  if (!isDeepStrictEqual(value.owners, owners)) invalid();
  const cutoffAt = timestampParts(value.cutoffAt);
  const coverage = assertCoverage(value.coverage, owners);
  if (
    !Number.isSafeInteger(value.ownerCount) ||
    value.ownerCount !== owners.length
  ) {
    invalid();
  }

  if (expectedReservation !== null) {
    const receipt = projectPublicBuildReservation(
      expectedReservation,
      value.buildBatchId,
    );
    if (
      value.generation !== receipt.generation ||
      value.commitSha !== receipt.commitSha ||
      !isDeepStrictEqual(cutoffAt, timestampParts(receipt.cutoffAt))
    ) {
      invalid();
    }
  } else {
    // Staging later binds these fields to the stored reservation. The standalone
    // artifact validator still rejects an unsafe path or malformed identity.
    if (
      !isPublicDeploymentIdentifier(value.buildBatchId) ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 1 ||
      !isCommitSha(value.commitSha)
    ) {
      invalid();
    }
  }

  const projection = manifestDigestProjection({
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    cutoffAt,
    coverage,
    ownerCount: owners.length,
    owners,
  });
  if (digest(projection) !== value.mediaManifestDigest) invalid();
  return value;
}

function publicMediaManifestChunkReceipt(manifest, chunk) {
  return {
    schemaVersion: PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION,
    buildBatchId: manifest.buildBatchId,
    generation: manifest.generation,
    mediaManifestDigest: manifest.mediaManifestDigest,
    index: chunk.index,
    ownerCount: chunk.ownerCount,
    ownerKeys: chunk.ownerKeys.map((ownerKey) => ({ ...ownerKey })),
    chunkDigest: chunk.chunkDigest,
  };
}

function canonicalJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function createManifestChunk(manifest, owners, index) {
  const chunkProjection = {
    schemaVersion: PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION,
    index,
    ownerCount: owners.length,
    owners,
  };
  const chunk = {
    index,
    ownerCount: owners.length,
    ownerKeys: owners.map(({ collection, documentId }) => ({
      collection,
      documentId,
    })),
    chunkDigest: digest(chunkProjection),
    owners,
  };
  const deployedDocumentBytes = owners.reduce(
    (total, owner) => total + canonicalJsonBytes(
      deployedUsageDocument(manifest, owner),
    ),
    0,
  );
  return {
    ...chunk,
    canonicalBytes: deployedDocumentBytes + canonicalJsonBytes(
      publicMediaManifestChunkReceipt(manifest, chunk),
    ),
  };
}

function publicMediaManifestChunks(
  manifest,
  maxOwnerWrites = MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK,
) {
  assertPublicMediaManifest(manifest);
  if (
    !Number.isSafeInteger(maxOwnerWrites) ||
    maxOwnerWrites < 1 ||
    maxOwnerWrites > MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK
  ) {
    invalid("The public media manifest chunk size is invalid");
  }
  const chunks = [];
  let currentOwners = [];
  for (const owner of manifest.owners) {
    const candidate = createManifestChunk(
      manifest,
      [...currentOwners, owner],
      chunks.length,
    );
    if (
      candidate.ownerCount <= maxOwnerWrites &&
      candidate.canonicalBytes <= MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES
    ) {
      currentOwners = candidate.owners;
      continue;
    }
    if (currentOwners.length === 0) {
      invalid("The public media manifest owner exceeds the chunk byte limit");
    }
    chunks.push(createManifestChunk(manifest, currentOwners, chunks.length));
    currentOwners = [owner];
    const singleOwnerChunk = createManifestChunk(
      manifest,
      currentOwners,
      chunks.length,
    );
    if (singleOwnerChunk.canonicalBytes > MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES) {
      invalid("The public media manifest owner exceeds the chunk byte limit");
    }
    if (chunks.length >= MAX_PUBLIC_MEDIA_MANIFEST_CHUNKS) {
      invalid("The public media manifest chunk limit is exceeded");
    }
  }
  if (currentOwners.length > 0) {
    chunks.push(createManifestChunk(manifest, currentOwners, chunks.length));
  }
  if (chunks.length > MAX_PUBLIC_MEDIA_MANIFEST_CHUNKS) {
    invalid("The public media manifest chunk limit is exceeded");
  }
  const verificationBytes = chunks.reduce(
    (total, chunk) => total + canonicalJsonBytes(
      publicMediaManifestChunkReceipt(manifest, chunk),
    ),
    0,
  );
  if (verificationBytes > MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES) {
    invalid("The public media manifest verification byte limit is exceeded");
  }
  return chunks;
}

function deployedUsageDocument(manifest, owner) {
  return {
    schemaVersion: PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION,
    state: "deployed",
    generation: manifest.generation,
    buildBatchId: manifest.buildBatchId,
    commitSha: manifest.commitSha,
    mediaManifestDigest: manifest.mediaManifestDigest,
    sourceVersion: owner.sourceVersion,
    assetIds: [...owner.assetIds],
    occurrenceCount: owner.occurrenceCount,
  };
}

function publicMediaDeployedUsageDocuments(manifest) {
  assertPublicMediaManifest(manifest);
  return manifest.owners.map((owner) => deployedUsageDocument(manifest, owner));
}

function publicMediaDeployedUsageDocument({ manifest, owner }) {
  const documents = publicMediaDeployedUsageDocuments(manifest);
  const canonical = canonicalOwner(owner);
  const index = manifest.owners.findIndex(
    (candidate) => candidate.collection === canonical.collection &&
      candidate.documentId === canonical.documentId,
  );
  if (index === -1 || !isDeepStrictEqual(canonical, manifest.owners[index])) {
    invalid("The deployed media usage owner is not in the manifest");
  }
  return documents[index];
}

function assertPublicMediaDeployedUsage({ manifest, owner, value }) {
  if (!hasExactFields(value, DEPLOYED_USAGE_FIELDS)) {
    invalid("The deployed media usage conflicts with the manifest");
  }
  const expected = publicMediaDeployedUsageDocument({ manifest, owner });
  if (!isDeepStrictEqual(value, expected)) {
    invalid("The deployed media usage conflicts with the manifest");
  }
  return value;
}

module.exports = {
  MAX_PUBLIC_MEDIA_MANIFEST_CHUNKS,
  MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES,
  MAX_PUBLIC_MEDIA_MANIFEST_OWNERS,
  MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK,
  MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES,
  MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_READS,
  MAX_PUBLIC_MEDIA_OWNER_ID_BYTES,
  PUBLIC_MEDIA_MANIFEST_COLLECTIONS,
  PUBLIC_MEDIA_MANIFEST_DIGEST_ALGORITHM,
  PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION,
  assertPublicMediaDeployedUsage,
  assertPublicMediaManifest,
  createPublicMediaManifest,
  isPublicMediaOwnerId,
  publicMediaDeployedUsageDocument,
  publicMediaDeployedUsageDocuments,
  publicMediaManifestChunkReceipt,
  publicMediaManifestChunks,
  timestampParts,
};
