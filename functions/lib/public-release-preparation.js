"use strict";

const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const { assertMediaLifecycleDeploymentFence, assertPublicDeploymentReservedBatch,
  isCommitSha, timestampMillis } = require("./public-deployment");
const { assertPublicWorkerCandidateDatabase, projectPublicWorkerCandidateInput,
  projectPublicWorkerCandidate } = require("./public-worker-candidate");
const { parseCmsPublicationRuntimeControl } = require("./cms-publication-runtime-control");
const { PUBLIC_CONTEXT_PATH } = require("./public-context-revision");
const { publicReleaseFreshnessDigest } = require("./public-release-freshness");
const { PreparedPublicReleaseError } = require("./public-release-error");

const COLLECTION = "system/publicReleasePreparations/entries";
const validId = value => typeof value === "string" && /^[A-Za-z0-9]{20}$/.test(value);
function refuse(message = "The public release preparation is invalid") { throw new PreparedPublicReleaseError(message); }
function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function preparationRef(firestore, preparationId) {
  if (!validId(preparationId)) refuse();
  return firestore.doc(`${COLLECTION}/${preparationId}`);
}
function preparedPublicWorkerCandidateRef(firestore, preparationId) {
  return preparationRef(firestore, preparationId).collection("candidates").doc("worker");
}
function checkpointRef(firestore, preparationId) {
  return preparationRef(firestore, preparationId).collection("checkpoints").doc("artifact");
}
const preparedFields = ["schemaVersion", "digestAlgorithm", "buildBatchId", "generation", "commitSha", "artifactDigest",
  "artifactReceiptDigest", "mediaManifestDigest", "publicationReceiptDigest", "artifactFileCount", "artifactBytes"];
function projectCheckpoint(value, preparationId, reservation) {
  const prepared = value?.preparedArtifact;
  const digestFields = ["artifactDigest", "artifactReceiptDigest", "mediaManifestDigest", "publicationReceiptDigest"];
  if (!exact(value, ["schemaVersion", "preparationId", "inputSha256", "artifactCheckpointDigest", "preparedArtifact"]) ||
      value.schemaVersion !== 1 || value.preparationId !== preparationId ||
      ![value.inputSha256, value.artifactCheckpointDigest].every(item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)) ||
      !exact(prepared, preparedFields) || prepared.schemaVersion !== 1 || prepared.digestAlgorithm !== "sha256" ||
      prepared.buildBatchId !== reservation.buildBatchId || prepared.generation !== reservation.generation ||
      prepared.commitSha !== reservation.commitSha ||
      !digestFields.every(field => typeof prepared[field] === "string" && /^[a-f0-9]{64}$/.test(prepared[field])) ||
      !Number.isSafeInteger(prepared.artifactFileCount) || prepared.artifactFileCount < 1 || prepared.artifactFileCount > 100_000 ||
      !Number.isSafeInteger(prepared.artifactBytes) || prepared.artifactBytes < 1 || prepared.artifactBytes > 100 * 1024 ** 3) {
    refuse("The detached release has no matching durable checkpoint");
  }
  return value;
}

/** Written only after checkpoint and restore have verified the same bytes. */
async function recordPreparedPublicReleaseCheckpoint({ firestore, preparationId, commitSha, inputSha256,
  artifactCheckpointDigest, preparedArtifact, target }) {
  assertPublicWorkerCandidateDatabase(firestore, target);
  const ref = checkpointRef(firestore, preparationId);
  return firestore.runTransaction(async transaction => {
    const [preparation, before] = await transaction.getAll(preparationRef(firestore, preparationId), ref);
    const reservation = projectPublicReleasePreparationReservation(preparation.data(), { preparationId, commitSha });
    const value = projectCheckpoint({ schemaVersion: 1, preparationId, inputSha256, artifactCheckpointDigest, preparedArtifact },
      preparationId, reservation);
    if (before.exists) {
      if (!isDeepStrictEqual(projectCheckpoint(before.data(), preparationId, reservation), value)) {
        refuse("The detached release checkpoint cannot change");
      }
    } else transaction.create(ref, value);
    return value;
  });
}

async function assertPreparedPublicReleaseCheckpoint({ firestore, preparationId, preparedArtifact, target }) {
  assertPublicWorkerCandidateDatabase(firestore, target);
  return firestore.runTransaction(async transaction => {
    const [preparation, checkpoint] = await transaction.getAll(preparationRef(firestore, preparationId), checkpointRef(firestore, preparationId));
    const reservation = projectPublicReleasePreparationReservation(preparation.data(), { preparationId, commitSha: preparedArtifact.commitSha });
    const value = projectCheckpoint(checkpoint.data(), preparationId, reservation);
    if (!isDeepStrictEqual(value.preparedArtifact, preparedArtifact)) refuse("The detached artifact differs from its durable checkpoint");
    return value;
  }, { readOnly: true });
}

/** A proposed build identity, not a reservation on the live generation counter.
 * Promotion must still compare the predecessor and current content before it
 * can reserve this generation or make any candidate eligible. */
function projectPublicReleasePreparationReservation(value, { preparationId, commitSha }) {
  if (!validId(preparationId) || !isCommitSha(commitSha) ||
      !exact(value, ["schemaVersion", "preparationId", "commitSha", "proposedGeneration", "cutoffAt", "predecessor",
        ...(value?.freshnessDigest === undefined ? [] : ["freshnessDigest"])]) ||
      value.freshnessDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.freshnessDigest) ||
      value.schemaVersion !== 1 || value.preparationId !== preparationId || value.commitSha !== commitSha ||
      !exact(value.predecessor, ["generation", "deploymentId", "commitSha", "buildBatchId", "contextRevision"]) ||
      !Number.isSafeInteger(value.predecessor.contextRevision) || value.predecessor.contextRevision < 1 ||
      !Number.isSafeInteger(value.proposedGeneration) || value.proposedGeneration !== value.predecessor.generation + 1 ||
      value.predecessor.generation < 1 || value.predecessor.commitSha === commitSha ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.predecessor.buildBatchId ?? "") ||
      timestampMillis(value.cutoffAt) === null) refuse();
  return assertPublicDeploymentReservedBatch({ schemaVersion: 1, status: "reserved",
    runtime: { owner: "cloudflare", release: commitSha }, buildBatchId: `cms-${preparationId}`,
    commitSha, generation: value.proposedGeneration, cutoffAt: value.cutoffAt, reservedAt: value.cutoffAt,
    reservedAgainstGeneration: value.predecessor.generation,
    reservedAgainstDeploymentId: value.predecessor.deploymentId,
    reservedAgainstCommitSha: value.predecessor.commitSha,
  }, `cms-${preparationId}`);
}

async function readPublicReleasePreparation({ firestore, preparationId, commitSha, target }) {
  assertPublicWorkerCandidateDatabase(firestore, target);
  const snapshot = await preparationRef(firestore, preparationId).get();
  if (!snapshot.exists) refuse("The public release preparation does not exist");
  return projectPublicReleasePreparationReservation(snapshot.data(), { preparationId, commitSha });
}

/** An upload receipt under a detached preparation has no live eligibility. */
async function recordPreparedPublicWorkerCandidate({ firestore, preparationId, candidate, target }) {
  assertPublicWorkerCandidateDatabase(firestore, target);
  const projected = projectPublicWorkerCandidateInput(candidate, { target });
  if (projected.runtime?.owner !== "cloudflare" || projected.runtime.release !== projected.commitSha) refuse();
  const ref = preparedPublicWorkerCandidateRef(firestore, preparationId);
  await firestore.runTransaction(async transaction => {
    const [preparation, before, checkpoint] = await transaction.getAll(preparationRef(firestore, preparationId), ref,
      checkpointRef(firestore, preparationId));
    const reservation = projectPublicReleasePreparationReservation(preparation.data(), {
      preparationId, commitSha: projected.commitSha });
    if (projected.buildBatchId !== reservation.buildBatchId || projected.generation !== reservation.generation) refuse();
    const retained = projectCheckpoint(checkpoint.data(), preparationId, reservation).preparedArtifact;
    if (preparedFields.filter(field => !["schemaVersion", "digestAlgorithm"].includes(field))
      .some(field => retained[field] !== projected[field])) refuse("The detached candidate differs from its durable checkpoint");
    if (before.exists) {
      const stored = Object.fromEntries(Object.entries(projectPublicWorkerCandidate(before.data(), projected.buildBatchId, { target }))
        .filter(([field]) => field !== "recordedAt"));
      if (!isDeepStrictEqual(stored, projected)) refuse("The prepared Worker candidate conflicts with its retained upload");
      return;
    }
    transaction.create(ref, { ...projected, recordedAt: FieldValue.serverTimestamp() });
  });
  return projectPublicWorkerCandidate((await ref.get()).data(), projected.buildBatchId, { target });
}

/** This operator writes only its detached preparation. In particular, it never
 * advances lastReservedGeneration, changes pins or creates runnable release work. */
async function preparePublicRelease({ firestore, preparationId, commitSha, oldCommitSha, target }) {
  assertPublicWorkerCandidateDatabase(firestore, target);
  if (!isCommitSha(commitSha) || !isCommitSha(oldCommitSha) || commitSha === oldCommitSha) refuse();
  const ref = preparationRef(firestore, preparationId);
  return firestore.runTransaction(async transaction => {
    const [before, deployment, runtime, context, liveBatch] = await transaction.getAll(ref,
      firestore.doc("system/publicDeployment"), firestore.doc("system/cmsPublicationRuntime"), firestore.doc(PUBLIC_CONTEXT_PATH),
      firestore.doc(`system/publicDeployment/buildBatches/cms-${preparationId}`));
    if (liveBatch.exists) refuse("This operation id already belongs to a live release reservation");
    const pointer = deployment.data();
    const predecessor = assertMediaLifecycleDeploymentFence(pointer);
    const control = parseCmsPublicationRuntimeControl(runtime.data());
    const cloud = control.cloud;
    if (predecessor.commitSha !== oldCommitSha || control.phase !== "ready" || control.commitSha !== oldCommitSha ||
        !cloud || cloud.phase !== "ready" || cloud.commitSha !== oldCommitSha || cloud.serializerId !== "cloudflare-publisher") {
      refuse("Release preparation requires the current publisher and public source ready at OLD");
    }
    const publicContext = context.data();
    if (publicContext?.schemaVersion !== 1 || !Number.isSafeInteger(publicContext.revision) || publicContext.revision < 1) {
      refuse("The public release preparation context is unavailable");
    }
    // The build uses this exact historical timestamp. A separate read-only
    // snapshot binds its complete source identity to that same cutoff.
    const freshnessDigest = await firestore.runTransaction(historical => publicReleaseFreshnessDigest(historical, firestore),
      { readOnly: true, readTime: deployment.readTime });
    if (before.exists) {
      const value = before.data();
      const reservation = projectPublicReleasePreparationReservation(value, { preparationId, commitSha });
      if (value.freshnessDigest !== freshnessDigest || !isDeepStrictEqual(value.predecessor, { ...predecessor,
        buildBatchId: pointer.newestEligibleBuildBatchId, contextRevision: publicContext.revision })) {
        refuse("The public release preparation is stale; use a new operation id");
      }
      return reservation;
    }
    const value = { schemaVersion: 1, preparationId, commitSha, proposedGeneration: predecessor.generation + 1, freshnessDigest,
      cutoffAt: deployment.readTime, predecessor: { ...predecessor,
        buildBatchId: pointer.newestEligibleBuildBatchId, contextRevision: publicContext.revision } };
    const reservation = projectPublicReleasePreparationReservation(value, { preparationId, commitSha });
    transaction.create(ref, value);
    return reservation;
  });
}

/** Recheck before C2 and after its drain. A stale artifact is rebuilt outside
 * the pause; this read never changes admission or a generation counter. */
async function checkPublicReleasePreparation({ firestore, preparationId, commitSha, phase = "ready", target }) {
  assertPublicWorkerCandidateDatabase(firestore, target);
  if (!["ready", "paused"].includes(phase)) refuse();
  return firestore.runTransaction(async transaction => (await readFreshPublicReleasePreparationInTransaction({
    firestore, transaction, preparationId, commitSha, phase })).reservation, { readOnly: true });
}

async function readFreshPublicReleasePreparationInTransaction({ firestore, transaction, preparationId, commitSha,
  phase }) {
  const [prepared, deployment, runtime, context] = await transaction.getAll(preparationRef(firestore, preparationId),
    firestore.doc("system/publicDeployment"), firestore.doc("system/cmsPublicationRuntime"), firestore.doc(PUBLIC_CONTEXT_PATH));
  const value = prepared.data();
  const reservation = projectPublicReleasePreparationReservation(value, { preparationId, commitSha });
  const pointer = deployment.data();
  const predecessor = assertMediaLifecycleDeploymentFence(pointer);
  const control = parseCmsPublicationRuntimeControl(runtime.data());
  const publisher = value.predecessor.commitSha;
  if (!["ready", "paused"].includes(phase)) refuse();
  if (control.phase !== phase || control.cloud?.phase !== phase ||
      control.commitSha !== publisher || control.cloud?.commitSha !== publisher ||
      control.cloud?.serializerId !== "cloudflare-publisher") refuse("The preparation check requires both exact publisher pins");
  const freshnessDigest = await publicReleaseFreshnessDigest(transaction, firestore);
  if (!value.freshnessDigest || value.freshnessDigest !== freshnessDigest ||
      !isDeepStrictEqual(value.predecessor, { ...predecessor, buildBatchId: pointer.newestEligibleBuildBatchId,
        contextRevision: context.data()?.revision })) {
    refuse("The public release preparation is stale; resume OLD and prepare a new operation outside the pause");
  }
  return { reservation, preparation: value, pointer, runtimeUpdateTime: runtime.updateTime };
}

module.exports = { preparePublicRelease, readPublicReleasePreparation, projectPublicReleasePreparationReservation,
  preparedPublicWorkerCandidateRef, recordPreparedPublicWorkerCandidate, recordPreparedPublicReleaseCheckpoint,
  assertPreparedPublicReleaseCheckpoint, checkPublicReleasePreparation,
  readFreshPublicReleasePreparationInTransaction };
