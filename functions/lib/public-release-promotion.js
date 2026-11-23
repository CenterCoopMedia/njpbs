"use strict";

const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const { assertPublicWorkerCandidateDatabase, projectPublicWorkerCandidate } = require("./public-worker-candidate");
const { projectPublicBuildReservation, assertMediaLifecycleDeploymentFence } = require("./public-deployment");
const { parseCmsPublicationRuntimeControl } = require("./cms-publication-runtime-control");
const { preparedPublicWorkerCandidateRef, readFreshPublicReleasePreparationInTransaction,
  readPublicReleasePreparationStateInTransaction, projectPublicReleasePreparationReservation,
  projectPreparedPublicReleaseCheckpoint } = require("./public-release-preparation");
const { assertNoBuildCandidateInTransaction } = require("./no-build-post-publication");
const { assertNoBuildPageCandidateInTransaction } = require("./no-build-page-candidate");
const { assertPublicMediaManifest } = require("./public-media-manifest");
const { digest } = require("./no-build-page-ownership");
const { PreparedPublicReleaseError } = require("./public-release-error");
const { assertPreparedPublicBuildSettings } = require("./public-build-settings");
const { publicationTarget } = require("./publication-target");

const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function refuse(message) { throw new PreparedPublicReleaseError(message); }
function refs(firestore, preparationId) {
  const candidate = preparedPublicWorkerCandidateRef(firestore, preparationId);
  const preparation = candidate.parent.parent;
  return { preparation, candidate, checkpoint: preparation.collection("checkpoints").doc("artifact"),
    proof: preparation.collection("proofs").doc("complete"),
    promotion: preparation.collection("promotions").doc("reservation"), handover: preparation.collection("proofs").doc("handover") };
}
// An absent target is production; the operators pass one only for development.
const serializerId = target => publicationTarget(target?.environment).serializerId;
function candidateInput(value, target) {
  return Object.fromEntries(Object.entries(projectPublicWorkerCandidate(value, null, { target })).filter(([field]) => field !== "recordedAt"));
}
function preparedArtifactFromCandidate(candidate) {
  const fields = ["buildBatchId", "generation", "commitSha", "artifactDigest", "artifactReceiptDigest",
    "mediaManifestDigest", "publicationReceiptDigest", "artifactFileCount", "artifactBytes"];
  return { schemaVersion: 1, digestAlgorithm: "sha256", ...Object.fromEntries(fields.map(field => [field, candidate[field]])) };
}

async function readPreparedReleaseProof(transaction, firestore, preparationId, commitSha, target) {
  const ref = refs(firestore, preparationId);
  const [proof, candidateSnapshot, context, checkpointSnapshot] = await transaction.getAll(ref.proof, ref.candidate,
    firestore.doc(`cmsPreviewPublicContexts/cms-${preparationId}`), ref.checkpoint);
  if (!proof.exists || !candidateSnapshot.exists || !context.exists) refuse("The prepared release has no matching complete proof");
  const candidate = candidateInput(candidateSnapshot.data(), target);
  const sealed = proof.data();
  const checkpoint = projectPreparedPublicReleaseCheckpoint(checkpointSnapshot.data(), preparationId, candidate);
  const publicBuildSettings = assertPreparedPublicBuildSettings(sealed?.publicBuildSettings, commitSha);
  if (sealed?.schemaVersion !== 1 || sealed.preparationId !== preparationId || sealed.commitSha !== commitSha ||
      !validDigest(sealed.inputSha256) || !validDigest(sealed.artifactCheckpointDigest) ||
      candidate.commitSha !== commitSha || candidate.buildBatchId !== `cms-${preparationId}` ||
      candidate.runtime?.owner !== "cloudflare" || candidate.runtime.release !== commitSha ||
      sealed.candidateDigest !== digest(candidate) || !context.exists || sealed.contextManifestDigest !== digest(context.data())) {
    refuse("The prepared release has no matching complete proof");
  }
  if (checkpoint.inputSha256 !== sealed.inputSha256 || checkpoint.artifactCheckpointDigest !== sealed.artifactCheckpointDigest ||
      !isDeepStrictEqual(checkpoint.preparedArtifact, preparedArtifactFromCandidate(candidate)) ||
      !isDeepStrictEqual(checkpoint.publicBuildSettings, publicBuildSettings)) refuse("The sealed build settings differ from the checkpoint");
  assertPublicMediaManifest(sealed.mediaManifest);
  if (sealed.mediaManifest.mediaManifestDigest !== candidate.mediaManifestDigest ||
      sealed.mediaManifest.buildBatchId !== candidate.buildBatchId || sealed.mediaManifest.commitSha !== commitSha ||
      sealed.mediaManifest.generation !== candidate.generation) refuse("The prepared media manifest differs");
  return { proof: sealed, candidate, preparedArtifact: preparedArtifactFromCandidate(candidate) };
}

async function checkSealedPublicRelease({ firestore, preparationId, commitSha, phase = "ready", target }) {
  assertPublicWorkerCandidateDatabase(firestore, target);
  return firestore.runTransaction(async transaction => {
    await readFreshPublicReleasePreparationInTransaction({ firestore, transaction, preparationId, commitSha, phase, target });
    return readPreparedReleaseProof(transaction, firestore, preparationId, commitSha, target);
  }, { readOnly: true });
}

/** The last content census happens after draining OLD, before C3 can replace
 * it. Later draft saves cannot strand a release under the NEW publisher pins. */
async function handoverPreparedPublicRelease({ firestore, preparationId, commitSha, target }) {
  assertPublicWorkerCandidateDatabase(firestore, target);
  return firestore.runTransaction(async transaction => {
    const { preparation, runtimeUpdateTime } = await readFreshPublicReleasePreparationInTransaction({ firestore, transaction,
      preparationId, commitSha, phase: "paused", target });
    const { proof } = await readPreparedReleaseProof(transaction, firestore, preparationId, commitSha, target);
    transaction.set(refs(firestore, preparationId).handover, { schemaVersion: 1, proofDigest: digest(proof),
      predecessor: preparation.predecessor, runtimeUpdateTime });
    return { preparationId, commitSha, status: "handed-over" };
  });
}

// The operator keeps its paused-owner, drain and provider checks in the same
// transaction. This read establishes that only preparation content is stale.
async function readStalePublicReleaseBeforeHandover({ firestore, transaction, preparationId, commitSha, target }) {
  assertPublicWorkerCandidateDatabase(firestore, target);
  const state = await readPublicReleasePreparationStateInTransaction({ firestore, transaction, preparationId, commitSha, phase: "paused", target });
  if (!state.preparation.freshnessDigest || !state.predecessorCurrent || state.contentCurrent ||
      !Number.isSafeInteger(state.contextRevision) || state.contextRevision < state.preparation.predecessor.contextRevision) {
    refuse("OLD recovery requires stale preparation content and the original paused predecessor");
  }
  const ref = refs(firestore, preparationId), batchId = state.reservation.buildBatchId;
  const work = await transaction.getAll(ref.handover, ref.promotion, firestore.doc(`system/publicDeployment/buildBatches/${batchId}`),
    firestore.doc(`cmsPublicationSerializerJournals/${serializerId(target)}/releases/${preparationId}`));
  if (work.some(row => row.exists)) refuse("OLD recovery requires no handover or promotion work");
  const { proof, candidate } = await readPreparedReleaseProof(transaction, firestore, preparationId, commitSha, target);
  if (candidate.generation !== state.reservation.generation) refuse("The prepared release candidate differs from its reservation");
  return { proofDigest: digest(proof), runtimeUpdateTime: state.runtimeUpdateTime };
}

/** Only the trusted operator calls this after checkpoint/restore, provider
 * verification and private-context retention. This evidence creates no work. */
async function sealPreparedPublicRelease({ firestore, preparationId, commitSha, inputSha256, artifactCheckpointDigest,
  preparedArtifact, mediaManifest, publicBuildSettings, target }) {
  assertPublicWorkerCandidateDatabase(firestore, target);
  if (!validDigest(inputSha256) || !validDigest(artifactCheckpointDigest)) refuse("The prepared release digests are invalid");
  const settings = assertPreparedPublicBuildSettings(publicBuildSettings, commitSha);
  const ref = refs(firestore, preparationId);
  return firestore.runTransaction(async transaction => {
    const { reservation } = await readFreshPublicReleasePreparationInTransaction({ firestore, transaction,
      preparationId, commitSha, phase: "ready", target });
    const [candidateSnapshot, context, before, checkpointSnapshot] = await transaction.getAll(ref.candidate,
      firestore.doc(`cmsPreviewPublicContexts/${reservation.buildBatchId}`), ref.proof, ref.checkpoint);
    const candidate = candidateInput(candidateSnapshot.data(), target);
    const checkpoint = projectPreparedPublicReleaseCheckpoint(checkpointSnapshot.data(), preparationId, reservation);
    assertPublicMediaManifest(mediaManifest, reservation);
    const prepared = preparedArtifactFromCandidate(candidate);
    const manifest = context.data();
    if (candidate.commitSha !== commitSha || candidate.runtime?.owner !== "cloudflare" || candidate.runtime.release !== commitSha ||
        candidate.generation !== reservation.generation ||
        candidate.buildBatchId !== reservation.buildBatchId || !isDeepStrictEqual(preparedArtifact, prepared) ||
        manifest?.schemaVersion !== 1 || manifest.buildBatchId !== reservation.buildBatchId ||
        manifest.artifactReceiptDigest !== candidate.artifactReceiptDigest || !validDigest(manifest.sha256) ||
        mediaManifest.mediaManifestDigest !== candidate.mediaManifestDigest || checkpoint.inputSha256 !== inputSha256 ||
        checkpoint.artifactCheckpointDigest !== artifactCheckpointDigest || !isDeepStrictEqual(checkpoint.preparedArtifact, prepared) ||
        !isDeepStrictEqual(checkpoint.publicBuildSettings, settings)) {
      refuse("The prepared release proof differs from its retained artifacts");
    }
    await assertNoBuildCandidateInTransaction({ firestore, transaction, candidate });
    await assertNoBuildPageCandidateInTransaction({ firestore, transaction, candidate });
    const proof = { schemaVersion: 1, preparationId, commitSha, inputSha256, artifactCheckpointDigest,
      candidateDigest: digest(candidate), contextManifestDigest: digest(manifest), mediaManifest, publicBuildSettings: settings };
    if (Buffer.byteLength(JSON.stringify(proof)) > 750_000) refuse("The prepared release proof exceeds its document limit");
    if (before.exists) {
      if (!isDeepStrictEqual(before.data(), proof)) refuse("The prepared release proof cannot change");
    } else transaction.create(ref.proof, proof);
    return proof;
  });
}

/** C4 and the reservation share one CAS on the exact OLD pause. A resumed or
 * re-paused runtime cannot reuse an earlier handover. Drafts do not touch it. */
async function promotePreparedPublicRelease({ firestore, preparationId, commitSha, apply = false, target }) {
  assertPublicWorkerCandidateDatabase(firestore, target);
  if (typeof apply !== "boolean") refuse("The prepared release apply flag is invalid");
  const ref = refs(firestore, preparationId);
  const batchRef = firestore.doc(`system/publicDeployment/buildBatches/cms-${preparationId}`);
  const requestRef = firestore.doc(`cmsPublicationSerializerJournals/${serializerId(target)}/releases/${preparationId}`);
  const result = await firestore.runTransaction(async transaction => {
    const [batch, promotion, request, runtime] = await transaction.getAll(batchRef, ref.promotion, requestRef,
      firestore.doc("system/cmsPublicationRuntime"));
    const { candidate, proof: sealed } = await readPreparedReleaseProof(transaction, firestore, preparationId, commitSha, target);
    const receipt = { schemaVersion: 1, preparationId, commitSha, buildBatchId: candidate.buildBatchId,
      generation: candidate.generation, workerVersionId: candidate.workerVersionId, proofDigest: digest(sealed) };
    const work = { schemaVersion: 1, runtime: { owner: "cloudflare", release: commitSha }, queueId: preparationId,
      buildBatchId: candidate.buildBatchId, commitSha, preparationId, preparedArtifact: preparedArtifactFromCandidate(candidate),
      inputSha256: sealed.inputSha256, artifactCheckpointDigest: sealed.artifactCheckpointDigest };
    if (batch.exists || promotion.exists || request.exists) {
      if (!batch.exists || !promotion.exists || !request.exists || promotion.data().proofDigest !== digest(sealed) ||
          !isDeepStrictEqual(promotion.data().receipt, receipt) ||
          Object.entries(work).some(([key, value]) => !isDeepStrictEqual(request.data()[key], value))) {
        refuse("The prepared release reservation conflicts with its proof");
      }
      const reservation = projectPublicBuildReservation(batch.data(), `cms-${preparationId}`);
      if (reservation.commitSha !== commitSha || reservation.generation !== candidate.generation ||
          reservation.runtime?.owner !== "cloudflare" || reservation.runtime.release !== commitSha) {
        refuse("The prepared release reservation differs from its candidate");
      }
      return { receipt, alreadyApplied: true, dryRun: !apply };
    }
    const [preparation, handover, deployment] = await transaction.getAll(ref.preparation, ref.handover,
      firestore.doc("system/publicDeployment"));
    const value = preparation.data();
    const reservation = projectPublicReleasePreparationReservation(value, { preparationId, commitSha });
    const pointer = deployment.data();
    const predecessor = assertMediaLifecycleDeploymentFence(pointer);
    const control = parseCmsPublicationRuntimeControl(runtime.data());
    if (control.phase !== "paused" || control.cloud?.phase !== "paused" ||
        control.commitSha !== value.predecessor.commitSha || control.cloud?.commitSha !== value.predecessor.commitSha ||
        control.cloud?.serializerId !== serializerId(target)) {
      refuse("Prepared release promotion requires both OLD publisher pins paused");
    }
    if (handover.data()?.schemaVersion !== 1 || handover.data().proofDigest !== digest(sealed) ||
        !isDeepStrictEqual(handover.data().runtimeUpdateTime, runtime.updateTime) ||
        !isDeepStrictEqual(handover.data().predecessor, value.predecessor) ||
        !isDeepStrictEqual(predecessor, { generation: value.predecessor.generation,
          deploymentId: value.predecessor.deploymentId, commitSha: value.predecessor.commitSha }) ||
        pointer.newestEligibleBuildBatchId !== value.predecessor.buildBatchId) refuse("The prepared release handover or generation is stale");
    if (candidate.generation !== reservation.generation || candidate.buildBatchId !== reservation.buildBatchId ||
        candidate.commitSha !== commitSha || candidate.runtime?.owner !== "cloudflare" || candidate.runtime.release !== commitSha) {
      refuse("The prepared release candidate differs from its reservation");
    }
    await assertNoBuildCandidateInTransaction({ firestore, transaction, candidate });
    await assertNoBuildPageCandidateInTransaction({ firestore, transaction, candidate });
    if (!apply) return { receipt, alreadyApplied: false, dryRun: true };
    const timestamp = FieldValue.serverTimestamp();
    transaction.create(batchRef, { ...reservation, reservedAt: timestamp });
    transaction.create(ref.promotion, { schemaVersion: 1, proofDigest: digest(sealed), receipt });
    transaction.create(requestRef, { ...work, status: "pending", attempts: 0, nextAttemptAt: Date.now() });
    transaction.set(firestore.doc("system/publicDeployment"), { ...pointer,
      lastReservedGeneration: reservation.generation, updatedAt: timestamp });
    transaction.set(firestore.doc("system/cmsPublicationRuntime"), { ...control, commitSha,
      cloud: { ...control.cloud, commitSha } });
    return { receipt, alreadyApplied: false, dryRun: false };
  }, apply ? {} : { readOnly: true });
  if (apply || result.alreadyApplied) {
    const stored = await ref.promotion.get();
    if (!isDeepStrictEqual(stored.data()?.receipt, result.receipt)) refuse("The prepared promotion receipt was not read back");
  }
  return result;
}

module.exports = { sealPreparedPublicRelease, checkSealedPublicRelease, promotePreparedPublicRelease,
  preparedArtifactFromCandidate, readPreparedReleaseProof, handoverPreparedPublicRelease, readStalePublicReleaseBeforeHandover };
