"use strict";

const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const {
  PublicDeploymentStateError,
  assertPublicDeploymentLeaseBatch,
  assertPublicDeploymentPointer,
  assertPublicDeploymentReservedBatch,
  planPublicDeploymentLeaseAcquisition,
  projectPublicBuildReservation,
  projectPublicBuildReadiness,
  timestampMillis,
} = require("./public-deployment");
const {
  publicBuildBatchRef,
  publicDeploymentRef,
} = require("./public-deployment-coordinator");
const {
  MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES,
  MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK,
  MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES,
  MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_READS,
  PUBLIC_MEDIA_MANIFEST_DIGEST_ALGORITHM,
  PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION,
  assertPublicMediaManifest,
  publicMediaDeployedUsageDocuments,
  publicMediaManifestChunkReceipt,
  publicMediaManifestChunks,
  timestampParts,
} = require("./public-media-manifest");

const HEADER_FIELDS = new Set([
  "schemaVersion",
  "digestAlgorithm",
  "buildBatchId",
  "generation",
  "commitSha",
  "cutoffAt",
  "coverage",
  "ownerCount",
  "maxOwnerWritesPerChunk",
  "maxChunkBytes",
  "maxVerificationBytes",
  "chunkCount",
  "mediaManifestDigest",
]);
const CHUNK_FIELDS = new Set([
  "schemaVersion",
  "buildBatchId",
  "generation",
  "mediaManifestDigest",
  "index",
  "ownerCount",
  "ownerKeys",
  "chunkDigest",
]);
const VERIFICATION_FIELDS = new Set([
  "schemaVersion",
  "buildBatchId",
  "generation",
  "mediaManifestDigest",
  "ownerCount",
  "chunkCount",
  "verifiedAt",
]);

function stateError(message) {
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

function assertFirestore(firestore) {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    typeof firestore.runTransaction !== "function"
  ) {
    stateError("firestore is required");
  }
}

function publicMediaManifestRef(firestore, buildBatchId) {
  return publicBuildBatchRef(firestore, buildBatchId)
    .collection("manifests")
    .doc("publicMedia");
}

function chunkDocumentId(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 999_999) {
    stateError("The public media manifest chunk index is invalid");
  }
  return String(index).padStart(6, "0");
}

function publicMediaManifestChunkRef(firestore, buildBatchId, index) {
  return publicMediaManifestRef(firestore, buildBatchId)
    .collection("chunks")
    .doc(chunkDocumentId(index));
}

function publicMediaManifestVerificationRef(firestore, buildBatchId) {
  return publicMediaManifestRef(firestore, buildBatchId)
    .collection("verifications")
    .doc("complete");
}

function publicMediaUsageRef(firestore, owner, generation) {
  return firestore
    .collection(owner.collection)
    .doc(owner.documentId)
    .collection("mediaUsage")
    .doc(`deployed-${generation}`);
}

function headerFromManifest(manifest, cutoffAt, chunks) {
  return {
    schemaVersion: PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION,
    digestAlgorithm: PUBLIC_MEDIA_MANIFEST_DIGEST_ALGORITHM,
    buildBatchId: manifest.buildBatchId,
    generation: manifest.generation,
    commitSha: manifest.commitSha,
    cutoffAt,
    coverage: manifest.coverage.map((entry) => ({ ...entry })),
    ownerCount: manifest.ownerCount,
    maxOwnerWritesPerChunk:
      MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK,
    maxChunkBytes: MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES,
    maxVerificationBytes: MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES,
    chunkCount: chunks.length,
    mediaManifestDigest: manifest.mediaManifestDigest,
  };
}

function headerDocument(manifest, reservation, chunks) {
  assertPublicMediaManifest(manifest, reservation);
  return headerFromManifest(manifest, reservation.cutoffAt, chunks);
}

function normalizedHeader(value) {
  return {
    ...value,
    cutoffAt: timestampParts(value.cutoffAt),
  };
}

function assertHeader(value, expected) {
  if (
    !hasExactFields(value, HEADER_FIELDS) ||
    !isDeepStrictEqual(normalizedHeader(value), normalizedHeader(expected))
  ) {
    stateError("The public media manifest header conflicts with its reservation");
  }
  return value;
}

function assertChunkReceipt(value, expected) {
  if (
    !hasExactFields(value, CHUNK_FIELDS) ||
    !isDeepStrictEqual(value, expected)
  ) {
    stateError("The public media manifest chunk conflicts with the manifest");
  }
  return value;
}

function verificationProjection(manifest, chunks) {
  return {
    schemaVersion: PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION,
    buildBatchId: manifest.buildBatchId,
    generation: manifest.generation,
    mediaManifestDigest: manifest.mediaManifestDigest,
    ownerCount: manifest.ownerCount,
    chunkCount: chunks.length,
  };
}

function assertVerification(value, expected) {
  if (
    !hasExactFields(value, VERIFICATION_FIELDS) ||
    timestampMillis(value.verifiedAt) === null ||
    !isDeepStrictEqual(
      Object.fromEntries(
        Object.entries(value).filter(([field]) => field !== "verifiedAt"),
      ),
      expected,
    )
  ) {
    stateError("The public media manifest verification conflicts with the manifest");
  }
  return value;
}

async function transactionGetAll(transaction, refs) {
  if (refs.length === 0) return [];
  return transaction.getAll(...refs);
}

async function firestoreGetAll(firestore, refs) {
  if (refs.length === 0) return [];
  if (typeof firestore.getAll === "function") return firestore.getAll(...refs);
  return Promise.all(refs.map((ref) => ref.get()));
}

async function stageHeader({ firestore, manifest, chunks }) {
  const batchRef = publicBuildBatchRef(firestore, manifest.buildBatchId);
  const manifestRef = publicMediaManifestRef(firestore, manifest.buildBatchId);
  return firestore.runTransaction(async (transaction) => {
    const [batchSnapshot, manifestSnapshot] = await Promise.all([
      transaction.get(batchRef),
      transaction.get(manifestRef),
    ]);
    if (!batchSnapshot.exists) {
      stateError("The public deployment reservation does not exist");
    }
    const reservation = projectPublicBuildReservation(
      batchSnapshot.data(),
      manifest.buildBatchId,
    );
    const expected = headerDocument(manifest, reservation, chunks);
    if (manifestSnapshot.exists) {
      assertHeader(manifestSnapshot.data(), expected);
      return reservation;
    }
    transaction.create(manifestRef, expected);
    return reservation;
  });
}

function assertDeployedUsage(value, expected) {
  if (!isDeepStrictEqual(value, expected)) {
    stateError("The deployed media usage conflicts with the manifest");
  }
  return value;
}

async function stageChunk({
  firestore,
  manifest,
  chunks,
  chunk,
  ownerDocuments,
}) {
  const headerRef = publicMediaManifestRef(firestore, manifest.buildBatchId);
  const receiptRef = publicMediaManifestChunkRef(
    firestore,
    manifest.buildBatchId,
    chunk.index,
  );
  const ownerRefs = chunk.owners.map((owner) =>
    publicMediaUsageRef(firestore, owner, manifest.generation));
  const expectedReceipt = publicMediaManifestChunkReceipt(manifest, chunk);
  const expectedHeader = headerFromManifest(
    manifest,
    manifest.cutoffAt,
    chunks,
  );

  await firestore.runTransaction(async (transaction) => {
    const headerSnapshot = await transaction.get(headerRef);
    const receiptSnapshot = await transaction.get(receiptRef);
    const ownerSnapshots = await transactionGetAll(transaction, ownerRefs);
    if (!headerSnapshot.exists) {
      stateError("The public media manifest header does not exist");
    }
    assertHeader(headerSnapshot.data(), expectedHeader);

    for (const [index, snapshot] of ownerSnapshots.entries()) {
      if (snapshot.exists) {
        assertDeployedUsage(snapshot.data(), ownerDocuments[index]);
      } else if (receiptSnapshot.exists) {
        stateError("The deployed media usage conflicts with the manifest");
      }
    }

    if (receiptSnapshot.exists) {
      assertChunkReceipt(receiptSnapshot.data(), expectedReceipt);
      return;
    }
    for (const [index, snapshot] of ownerSnapshots.entries()) {
      if (!snapshot.exists) transaction.create(ownerRefs[index], ownerDocuments[index]);
    }
    transaction.create(receiptRef, expectedReceipt);
  });
}

async function assertStoredManifest({ firestore, manifest, chunks }) {
  const batchRef = publicBuildBatchRef(firestore, manifest.buildBatchId);
  const headerRef = publicMediaManifestRef(firestore, manifest.buildBatchId);
  const [batchSnapshot, headerSnapshot] = await Promise.all([
    batchRef.get(),
    headerRef.get(),
  ]);
  if (!batchSnapshot.exists || !headerSnapshot.exists) {
    stateError("The staged public media manifest is incomplete");
  }
  const reservation = projectPublicBuildReservation(
    batchSnapshot.data(),
    manifest.buildBatchId,
  );
  assertPublicMediaManifest(manifest, reservation);
  assertHeader(
    headerSnapshot.data(),
    headerDocument(manifest, reservation, chunks),
  );

  const deployedDocuments = publicMediaDeployedUsageDocuments(manifest);
  let ownerOffset = 0;
  for (const chunk of chunks) {
    const receiptRef = publicMediaManifestChunkRef(
      firestore,
      manifest.buildBatchId,
      chunk.index,
    );
    const ownerRefs = chunk.owners.map((owner) =>
      publicMediaUsageRef(firestore, owner, manifest.generation));
    const [receiptSnapshot, ownerSnapshots] = await Promise.all([
      receiptRef.get(),
      firestoreGetAll(firestore, ownerRefs),
    ]);
    if (!receiptSnapshot.exists) {
      stateError("The staged public media manifest is incomplete");
    }
    assertChunkReceipt(
      receiptSnapshot.data(),
      publicMediaManifestChunkReceipt(manifest, chunk),
    );
    for (const [index, ownerSnapshot] of ownerSnapshots.entries()) {
      if (!ownerSnapshot.exists) {
        stateError("The deployed media usage conflicts with the manifest");
      }
      assertDeployedUsage(
        ownerSnapshot.data(),
        deployedDocuments[ownerOffset + index],
      );
    }
    ownerOffset += chunk.ownerCount;
  }
  return { reservation, chunks };
}

async function verifyStagedPublicMediaManifest({ firestore, manifest }) {
  assertFirestore(firestore);
  assertPublicMediaManifest(manifest);
  const chunks = publicMediaManifestChunks(manifest);
  const verificationReadCount = chunks.length + 3;
  if (verificationReadCount > MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_READS) {
    stateError("The public media manifest verification read limit is exceeded");
  }
  await assertStoredManifest({ firestore, manifest, chunks });
  const batchRef = publicBuildBatchRef(firestore, manifest.buildBatchId);
  const headerRef = publicMediaManifestRef(firestore, manifest.buildBatchId);
  const chunkRefs = chunks.map((chunk) => publicMediaManifestChunkRef(
    firestore,
    manifest.buildBatchId,
    chunk.index,
  ));
  const completeRef = publicMediaManifestVerificationRef(
    firestore,
    manifest.buildBatchId,
  );
  const expectedVerification = verificationProjection(manifest, chunks);

  const idempotent = await firestore.runTransaction(async (transaction) => {
    const snapshots = await transactionGetAll(
      transaction,
      [batchRef, headerRef, ...chunkRefs, completeRef],
    );
    const [batchSnapshot, headerSnapshot, ...rest] = snapshots;
    const completeSnapshot = rest.pop();
    const chunkSnapshots = rest;
    if (!batchSnapshot.exists || !headerSnapshot.exists) {
      stateError("The staged public media manifest is incomplete");
    }
    const reservation = projectPublicBuildReservation(
      batchSnapshot.data(),
      manifest.buildBatchId,
    );
    assertPublicMediaManifest(manifest, reservation);
    assertHeader(
      headerSnapshot.data(),
      headerDocument(manifest, reservation, chunks),
    );
    for (const [index, snapshot] of chunkSnapshots.entries()) {
      if (!snapshot.exists) {
        stateError("The staged public media manifest is incomplete");
      }
      assertChunkReceipt(
        snapshot.data(),
        publicMediaManifestChunkReceipt(manifest, chunks[index]),
      );
    }
    if (completeSnapshot.exists) {
      assertVerification(completeSnapshot.data(), expectedVerification);
      return true;
    }
    transaction.create(completeRef, {
      ...expectedVerification,
      verifiedAt: FieldValue.serverTimestamp(),
    });
    return false;
  });

  const verificationSnapshot = await completeRef.get();
  if (!verificationSnapshot.exists) {
    stateError("The public media manifest verification was not persisted");
  }
  const verification = assertVerification(
    verificationSnapshot.data(),
    expectedVerification,
  );
  return { idempotent, verification };
}

async function stagePublicMediaManifest({ firestore, manifest }) {
  assertFirestore(firestore);
  assertPublicMediaManifest(manifest);
  // Compute every bound before the first Firestore write. A large or unsafe
  // manifest must not leave an inert but unusable header behind.
  const chunks = publicMediaManifestChunks(manifest);
  const deployedDocuments = publicMediaDeployedUsageDocuments(manifest);
  await stageHeader({ firestore, manifest, chunks });
  let ownerOffset = 0;
  for (const chunk of chunks) {
    await stageChunk({
      firestore,
      manifest,
      chunks,
      chunk,
      ownerDocuments: deployedDocuments.slice(
        ownerOffset,
        ownerOffset + chunk.ownerCount,
      ),
    });
    ownerOffset += chunk.ownerCount;
  }
  return verifyStagedPublicMediaManifest({ firestore, manifest });
}

async function markPublicMediaManifestReady({ firestore, manifest }) {
  assertFirestore(firestore);
  assertPublicMediaManifest(manifest);
  const chunks = publicMediaManifestChunks(manifest);
  const pointerRef = publicDeploymentRef(firestore);
  const batchRef = publicBuildBatchRef(firestore, manifest.buildBatchId);
  const headerRef = publicMediaManifestRef(firestore, manifest.buildBatchId);
  const completeRef = publicMediaManifestVerificationRef(
    firestore,
    manifest.buildBatchId,
  );
  const expectedVerification = verificationProjection(manifest, chunks);

  const idempotent = await firestore.runTransaction(async (transaction) => {
    const [pointerSnapshot, batchSnapshot, headerSnapshot, completeSnapshot] =
      await transactionGetAll(
        transaction,
        [pointerRef, batchRef, headerRef, completeRef],
      );
    if (
      !pointerSnapshot.exists ||
      !batchSnapshot.exists ||
      !headerSnapshot.exists ||
      !completeSnapshot.exists
    ) {
      stateError("The staged public media manifest is incomplete");
    }

    const pointer = assertPublicDeploymentPointer(pointerSnapshot.data());
    const storedBatch = batchSnapshot.data();
    const reservation = projectPublicBuildReservation(
      storedBatch,
      manifest.buildBatchId,
    );
    assertPublicMediaManifest(manifest, reservation);
    assertHeader(
      headerSnapshot.data(),
      headerDocument(manifest, reservation, chunks),
    );
    assertVerification(completeSnapshot.data(), expectedVerification);

    if (storedBatch.status !== "reserved") {
      const batch = assertPublicDeploymentLeaseBatch(
        storedBatch,
        manifest.buildBatchId,
      );
      if (
        batch.status === "ready" &&
        batch.generation > pointer.newestEligibleGeneration
      ) {
        if (
          batch.generation > pointer.lastReservedGeneration ||
          ((pointer.state === "deploying" ||
            pointer.state === "reconciling") &&
            pointer.candidateGeneration === batch.generation)
        ) {
          stateError("The public deployment readiness state is invalid");
        }
        return true;
      }
      planPublicDeploymentLeaseAcquisition(pointer, batch);
      return true;
    }

    const batch = assertPublicDeploymentReservedBatch(
      storedBatch,
      manifest.buildBatchId,
    );
    if (
      batch.generation > pointer.lastReservedGeneration ||
      batch.generation <= pointer.activeGeneration ||
      ((pointer.state === "deploying" || pointer.state === "reconciling") &&
        pointer.candidateGeneration === batch.generation)
    ) {
      stateError("The public deployment readiness state is invalid");
    }

    const timestamp = FieldValue.serverTimestamp();
    transaction.set(batchRef, {
      ...batch,
      status: "ready",
      readyAt: timestamp,
    });
    return false;
  });

  const batchSnapshot = await batchRef.get();
  if (!batchSnapshot.exists) {
    stateError("The public deployment readiness result was not persisted");
  }
  return {
    idempotent,
    readiness: projectPublicBuildReadiness(
      batchSnapshot.data(),
      manifest.buildBatchId,
    ),
  };
}

module.exports = {
  markPublicMediaManifestReady,
  publicMediaManifestChunkRef,
  publicMediaManifestRef,
  publicMediaManifestVerificationRef,
  stagePublicMediaManifest,
  verifyStagedPublicMediaManifest,
};
