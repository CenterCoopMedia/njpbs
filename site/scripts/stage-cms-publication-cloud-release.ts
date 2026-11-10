import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { App } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import { parsePreviewStorageCredential } from "./cms-preview-storage-credential";
import { createCmsPublicationCloudStorage, type CloudPublicationIdentity } from "./cms-publication-cloud-storage";
import { assertCmsPublicationSourceCheckout, CmsPublicationRuntimeGuardError } from "./cms-publication-runtime-guard";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";
import { CLOUD_RELEASE_ATTEMPT_LIMIT, cloudReleaseCollection, checkpointNoBuildCloudRelease, stageNoBuildCloudRelease } from "./no-build-cloud-release";
import { buildFrozenPublication, freezeBackgroundPublicationInputs } from "./process-cms-publication";
import { installInterruptGuard } from "./release-interrupt-guard";
import {
  assertProductionFirestoreRouting,
  parseCmsPublicationFirebaseServiceAccount,
  parseCmsPublicationMediaManagerCredential,
  parseCmsPublicationPublicBuildEnvironment,
} from "./run-cms-publication-serializer";
import { projectPublicArtifactContent, readPublicArtifactContentFromDatabase } from "../src/lib/cms-loader";
import { writePublicArtifactBundle } from "../src/lib/public-artifact-bundle";
import { MAX_PUBLIC_ARTIFACT_CUTOFF_AGE_MILLIS } from "../src/lib/public-artifact-inventory";
import { assertPreparedPublicWorkerArtifact, preparePublicWorkerArtifact } from "../src/lib/public-worker-artifact";

const requireModule = createRequire(import.meta.url);
const { reservePublicBuildBatch } = requireModule("../../functions/lib/public-deployment-coordinator.js");
const { assertPublicDeploymentReservedBatch, assertPublicDeploymentRetiredCloudReleaseBatch } =
  requireModule("../../functions/lib/public-deployment.js");
const { cloudCmsPublicationRuntimeControl } = requireModule("../../functions/lib/cms-publication-runtime-control.js");
const { preparePublicRelease, recordPreparedPublicReleaseCheckpoint } = requireModule("../../functions/lib/public-release-preparation.js");

const site = fileURLToPath(new URL("..", import.meta.url));
const FIREBASE_PROJECT_ID = "njpbs-site";
const CLOUD_SERIALIZER_ID = "cloudflare-publisher";
const FIREBASE_CREDENTIAL_FD = 3;
const STORAGE_CREDENTIAL_FD = 4;
const MEDIA_MANAGER_CREDENTIAL_FD = 5;
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;

export class CmsPublicationCloudReleaseOperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsPublicationCloudReleaseOperatorError";
  }
}

function operatorError(message: string): never {
  throw new CmsPublicationCloudReleaseOperatorError(message);
}

type ReleaseArguments = { action: "apply" | "retire"; queueId: string; commitSha: string } |
  { action: "supersede-upload-exhausted"; queueId: string; commitSha: string; apply: boolean } |
  { action: "prepare"; queueId: string; commitSha: string; oldCommitSha: string } |
  { action: "retry"; queueId: string; commitSha: string; oldCommitSha: string; apply: boolean };
const RELEASE_USAGE = "Usage: stage-cms-publication-cloud-release.sh --apply|--retire <operation-id> <commit-sha> OR --prepare <operation-id> <new-commit-sha> <old-commit-sha> OR --retry <operation-id> <new-commit-sha> <old-commit-sha> [--apply] OR --supersede-upload-exhausted <operation-id> <commit-sha> [--apply]";
export function parseReleaseArguments(args: string[]): ReleaseArguments {
  if (args[0] === "--supersede-upload-exhausted") {
    if (![3, 4].includes(args.length) || !QUEUE_ID.test(args[1] ?? "") || !COMMIT_SHA.test(args[2] ?? "") ||
        args.length === 4 && args[3] !== "--apply") operatorError(RELEASE_USAGE);
    return { action: "supersede-upload-exhausted", queueId: args[1], commitSha: args[2], apply: args.length === 4 };
  }
  if (args[0] === "--prepare") {
    if (args.length !== 4 || !QUEUE_ID.test(args[1] ?? "") || !COMMIT_SHA.test(args[2] ?? "") ||
        !COMMIT_SHA.test(args[3] ?? "") || args[2] === args[3]) operatorError(RELEASE_USAGE);
    return { action: "prepare", queueId: args[1], commitSha: args[2], oldCommitSha: args[3] };
  }
  if (args[0] === "--retry") {
    if (![4, 5].includes(args.length) || !QUEUE_ID.test(args[1] ?? "") || !COMMIT_SHA.test(args[2] ?? "") ||
        !COMMIT_SHA.test(args[3] ?? "") || args[2] === args[3] || args.length === 5 && args[4] !== "--apply") operatorError(RELEASE_USAGE);
    return { action: "retry", queueId: args[1], commitSha: args[2], oldCommitSha: args[3], apply: args.length === 5 };
  }
  if (args.length !== 3 || !["--apply", "--retire"].includes(args[0] ?? "") ||
      !QUEUE_ID.test(args[1] ?? "") || !COMMIT_SHA.test(args[2] ?? "")) {
    operatorError(RELEASE_USAGE);
  }
  return { action: args[0] === "--apply" ? "apply" : "retire", queueId: args[1], commitSha: args[2] };
}

/** Retire only an exhausted upload that has no candidate or activation owner.
 * All fences and both terminal writes share one transaction. A retained journal
 * is cleared only when its job belongs to this exact request. */
export async function supersedeUploadExhaustedCloudRelease({ firestore, queueId, commitSha, apply = false,
  serverTimestamp = () => firebaseAdminRuntime.FieldValue.serverTimestamp() }: {
  firestore: Firestore; queueId: string; commitSha: string; apply?: boolean; serverTimestamp?: () => unknown;
}) {
  if (!QUEUE_ID.test(queueId ?? "") || !COMMIT_SHA.test(commitSha ?? "") || typeof apply !== "boolean") {
    operatorError("The cloud release supersede input is invalid");
  }
  const buildBatchId = `cms-${queueId}`;
  const batchRef = firestore.doc(`system/publicDeployment/buildBatches/${buildBatchId}`);
  const requestRef = firestore.doc(`${cloudReleaseCollection(CLOUD_SERIALIZER_ID)}/${queueId}`);
  const journalRef = firestore.doc(`cmsPublicationSerializerJournals/${CLOUD_SERIALIZER_ID}`);
  return firestore.runTransaction(async transaction => {
    const [requestRow, batchRow, pointerRow, runtimeRow, candidate, queue, journalRow] = await transaction.getAll(
      requestRef, batchRef, firestore.doc("system/publicDeployment"), firestore.doc("system/cmsPublicationRuntime"),
      batchRef.collection("candidates").doc("worker"), firestore.doc(`cmsPublishQueue/${queueId}`), journalRef);
    const request = requestRow.data(), batch = batchRow.data(), pointer = pointerRow.data(), runtime = runtimeRow.data();
    if (!request || !batch || !pointer || !runtime) operatorError("A required cloud release document is missing");
    if (request.schemaVersion !== 1 || request.queueId !== queueId || request.buildBatchId !== buildBatchId ||
        request.runtime?.owner !== "cloudflare" || request.runtime?.release !== commitSha || request.commitSha !== commitSha ||
        !/^[a-f0-9]{64}$/.test(request.inputSha256 ?? "") || !/^[a-f0-9]{64}$/.test(request.artifactCheckpointDigest ?? "")) {
      operatorError("The request does not belong to this cloud release");
    }
    if (request.status !== "failed" || request.attempts !== CLOUD_RELEASE_ATTEMPT_LIMIT || request.nextAttemptAt !== null ||
        typeof request.failureReason !== "string" || !request.failureReason.startsWith("candidate upload:")) {
      operatorError("The request is not an exhausted candidate upload failure");
    }
    assertPublicDeploymentReservedBatch(batch, buildBatchId);
    if (batch.runtime?.owner !== "cloudflare" || batch.runtime?.release !== commitSha || batch.commitSha !== commitSha ||
        batch.noBuildStaticInput !== undefined) operatorError("The reservation does not belong to this cloud release");
    if (candidate.exists || queue.exists) operatorError("The release already has a candidate or queue row");
    if (pointer.state !== "idle" || pointer.lease != null || pointer.leaseToken != null ||
        pointer.activeGeneration !== batch.reservedAgainstGeneration || pointer.activeCommitSha !== batch.reservedAgainstCommitSha ||
        pointer.activeDeploymentId !== batch.reservedAgainstDeploymentId) operatorError("The public pointer moved from the reservation");
    if (runtime.phase !== "paused" || runtime.cloud?.phase !== "paused" || runtime.commitSha !== commitSha ||
        runtime.cloud?.commitSha !== commitSha || runtime.cloud?.serializerId !== CLOUD_SERIALIZER_ID) {
      operatorError("Both publication phases must be paused at this release");
    }
    const journal = journalRow.data();
    const job = journal?.job;
    if (journal && (journal.schemaVersion !== 1 || journal.serializerId !== CLOUD_SERIALIZER_ID ||
        journal.runtime?.owner !== "cloudflare" || (job !== null && (journal.runtime?.release !== commitSha ||
          job?.queueId !== queueId || job?.buildBatchId !== buildBatchId || job?.commitSha !== commitSha)))) {
      operatorError("The retained journal does not belong to this request");
    }
    // Keep the batch receipt compatible with the active Functions validator:
    // no public Worker candidate was staged. The request records why it ended.
    const retirementReceipt = { schemaVersion: 1, reason: "cloud_release_not_staged", originalOwner: "cloudflare",
      activeGeneration: pointer.activeGeneration, activeCommitSha: pointer.activeCommitSha, activeDeploymentId: pointer.activeDeploymentId };
    if (apply) {
      const retiredAt = serverTimestamp();
      transaction.update(requestRef, { status: "superseded", supersededAt: retiredAt,
        supersessionReceipt: { ...retirementReceipt, reason: "cloud_release_upload_exhausted" } });
      transaction.update(batchRef, { status: "retired", retiredAt, retirementReceipt });
      if (job) transaction.update(journalRef, { job: null });
    }
    return { queueId, buildBatchId, commitSha, generation: batch.generation, activeGeneration: pointer.activeGeneration,
      requestStatus: "superseded", batchStatus: "retired", journalCleared: Boolean(job), written: apply, dryRun: !apply };
  }, apply ? {} : { readOnly: true });
}

/** Recheck the complete paused release fence in one transaction. The default
 * is read-only; applying changes only the exhausted request, never its journal,
 * artifact, batch, deployment pointer or publication controls. */
export async function retryCmsPublicationCloudRelease({ firestore, queueId, commitSha, oldCommitSha, apply = false, now = Date.now }: {
  firestore: Firestore; queueId: string; commitSha: string; oldCommitSha: string; apply?: boolean; now?: () => number;
}) {
  if (!QUEUE_ID.test(queueId ?? "") || !COMMIT_SHA.test(commitSha ?? "") || !COMMIT_SHA.test(oldCommitSha ?? "") ||
      commitSha === oldCommitSha || typeof apply !== "boolean") operatorError("The cloud release retry input is invalid");
  const buildBatchId = `cms-${queueId}`;
  const requestRef = firestore.doc(`${cloudReleaseCollection(CLOUD_SERIALIZER_ID)}/${queueId}`);
  return firestore.runTransaction(async transaction => {
    const [request, batch, pointer, runtime] = (await transaction.getAll(requestRef,
      firestore.doc(`system/publicDeployment/buildBatches/${buildBatchId}`),
      firestore.doc("system/publicDeployment"), firestore.doc("system/cmsPublicationRuntime"))).map(row => row.data());
    if (!request || !batch || !pointer || !runtime) operatorError("A required cloud release document is missing");
    if (request.schemaVersion !== 1 || request.queueId !== queueId || request.buildBatchId !== buildBatchId ||
        request.runtime?.owner !== "cloudflare" || request.runtime?.release !== commitSha || request.commitSha !== commitSha) {
      operatorError("The request does not belong to this cloud release");
    }
    if (request.status !== "failed" || request.attempts !== CLOUD_RELEASE_ATTEMPT_LIMIT || request.nextAttemptAt !== null) {
      operatorError("The request is not in the exhausted failed state");
    }
    if (typeof request.artifactCheckpointDigest !== "string" || !/^[a-f0-9]{64}$/.test(request.artifactCheckpointDigest) ||
        typeof request.inputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(request.inputSha256)) operatorError("The request digests are invalid");
    if (batch.status !== "ready" || batch.commitSha !== commitSha || batch.runtime?.owner !== "cloudflare" ||
        batch.runtime?.release !== commitSha || !Number.isSafeInteger(batch.generation) || batch.generation < 1) {
      operatorError("The batch is not ready for this cloud release");
    }
    if (pointer.state !== "idle" || pointer.activeCommitSha !== oldCommitSha || pointer.newestEligibleBuildBatchId !== buildBatchId ||
        pointer.newestEligibleGeneration !== batch.generation || !Number.isSafeInteger(pointer.activeGeneration) || pointer.activeGeneration < 0 ||
        pointer.activeGeneration !== batch.reservedAgainstGeneration || batch.generation <= pointer.activeGeneration) {
      operatorError("The pointer is not idle at the old release with this batch eligible");
    }
    if (runtime.cloud?.serializerId !== CLOUD_SERIALIZER_ID) operatorError("The runtime does not name this cloud publisher");
    if (runtime.phase !== "paused" || runtime.cloud?.phase !== "paused" || runtime.commitSha !== commitSha || runtime.cloud?.commitSha !== commitSha) {
      operatorError("Both publication phases must be paused at the new release");
    }
    const retryAt = now();
    if (!Number.isSafeInteger(retryAt) || retryAt < 1) operatorError("The retry time is invalid");
    const after = { status: "pending", attempts: 0, nextAttemptAt: retryAt, failureReason: null };
    if (apply) transaction.update(requestRef, after);
    return { queueId, buildBatchId, commitSha, oldCommitSha, generation: batch.generation, activeGeneration: pointer.activeGeneration,
      before: { status: "failed", attempts: CLOUD_RELEASE_ATTEMPT_LIMIT, nextAttemptAt: null }, after,
      written: apply, dryRun: !apply };
  }, apply ? {} : { readOnly: true });
}

/** The build child inherits the process environment. A development target
 * would compile a renderer that the production upload refuses after the
 * release request exists, when the reservation can no longer be retired. */
export function assertProductionReleaseTarget(environment: NodeJS.ProcessEnv): void {
  const target = environment.CMS_DEPLOYMENT_ENVIRONMENT;
  if (target !== undefined && target !== "production") operatorError("The cloud release target must be production");
}

export async function assertProductionRendererSeals(directory: string, commitSha: string): Promise<void> {
  const read = async (file: string) => JSON.parse(await readFile(path.join(directory, file), "utf8"));
  const seal = await read("renderer/renderer-release.json");
  const publicSeal = await read("dist/posts/_no-build-assets/renderer-release.json");
  // The production upload accepts exactly this public seal.
  if (seal?.schemaVersion !== 1 || seal.rendererSha !== commitSha || Object.hasOwn(seal, "environment") ||
      publicSeal?.dataHubCompositionVersion !== undefined && publicSeal?.dataHubReportingVersion !== 1 ||
      publicSeal?.electionResultsVersion !== undefined && ![1, 2].includes(publicSeal?.electionResultsVersion) ||
      publicSeal?.liveBlogVersion !== undefined && publicSeal?.liveBlogVersion !== 1 ||
      publicSeal?.pageReaderVersion !== undefined && publicSeal?.pageReaderVersion !== 1 ||
      !isDeepStrictEqual(publicSeal, { schemaVersion: 1, rendererSha: commitSha,
        ...(publicSeal?.dataHubReportingVersion === 1 ? {dataHubReportingVersion:1} : {}),
        ...(publicSeal?.dataHubCompositionVersion === 1 ? {dataHubCompositionVersion:1} : {}),
        ...(publicSeal?.liveBlogVersion === 1 ? {liveBlogVersion:1} : {}),
        ...(publicSeal?.pageReaderVersion === 1 ? {pageReaderVersion:1} : {}),
        ...([1, 2].includes(publicSeal?.electionResultsVersion) ? {electionResultsVersion:publicSeal.electionResultsVersion} : {}) })) {
    operatorError("The built renderer is not a production release of this commit");
  }
}

type Storage = ReturnType<typeof createCmsPublicationCloudStorage>;
type PreparedArtifact = Awaited<ReturnType<typeof preparePublicWorkerArtifact>>;
interface StageDependencies {
  assertSourceCheckout: typeof assertCmsPublicationSourceCheckout;
  reserveBatch: (input: { firestore: Firestore; buildBatchId: string; commitSha: string;
    runtime: { owner: "cloudflare"; release: string } }) => Promise<{ batch: { generation: number; cutoffAt: { toMillis(): number } } }>;
  prepareDetached: (input: { firestore: Firestore; preparationId: string; commitSha: string; oldCommitSha: string }) =>
    Promise<{ generation: number; cutoffAt: { toMillis(): number } }>;
  readContent: (firestore: Firestore, identity: { buildBatchId: string; commitSha: string; preparationId?: string }, scratch: string) => Promise<Buffer>;
  freezeExternalInputs: typeof freezeBackgroundPublicationInputs;
  build: typeof buildFrozenPublication;
  prepareArtifact: typeof preparePublicWorkerArtifact;
  readPreparedArtifact: (directory: string) => Promise<PreparedArtifact>;
  stage: typeof stageNoBuildCloudRelease;
  checkpoint: typeof checkpointNoBuildCloudRelease;
  recordCheckpoint: typeof recordPreparedPublicReleaseCheckpoint;
}

async function frozenContent(firestore: Firestore, identity: { buildBatchId: string; commitSha: string; preparationId?: string }, scratch: string): Promise<Buffer> {
  // The one historical read of this release. The scratch file stays outside
  // the checkout, which must remain clean.
  const read = await readPublicArtifactContentFromDatabase(firestore as never, identity, new Date());
  const directory = await mkdtemp(path.join(scratch, "input-"));
  try {
    const file = path.join(directory, "input.json");
    await writePublicArtifactBundle(file, { schemaVersion: 3, ...projectPublicArtifactContent(read) });
    return await readFile(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function preparedArtifact(directory: string): Promise<PreparedArtifact> {
  return assertPreparedPublicWorkerArtifact(JSON.parse(await readFile(path.join(directory, "prepared-worker.json"), "utf8")));
}

const defaultDependencies: StageDependencies = {
  assertSourceCheckout: assertCmsPublicationSourceCheckout,
  reserveBatch: reservePublicBuildBatch,
  prepareDetached: preparePublicRelease,
  readContent: frozenContent,
  freezeExternalInputs: freezeBackgroundPublicationInputs,
  build: buildFrozenPublication,
  prepareArtifact: preparePublicWorkerArtifact,
  readPreparedArtifact: preparedArtifact,
  stage: stageNoBuildCloudRelease,
  checkpoint: checkpointNoBuildCloudRelease,
  recordCheckpoint: recordPreparedPublicReleaseCheckpoint,
};

/** Trusted release producer. Detached preparation builds NEW while OLD stays
 * ready; ordinary staging still requires the exact NEW publisher pin.
 * Neither mode uploads a Worker version or changes public traffic. */
export async function stageCmsPublicationCloudRelease({ firestore, storage, queueId, commitSha, stateDirectory,
  distDirectory = path.join(site, "dist"), rendererDirectory = path.join(site, ".public-post-renderer"),
  buildEnvironment, mediaManagerCredential, prepareAgainstCommitSha,
  now = Date.now, interrupted = () => false, dependencies: overrides }: {
  firestore: Firestore; storage: Storage; queueId: string; commitSha: string; stateDirectory: string;
  distDirectory?: string; rendererDirectory?: string;
  buildEnvironment: Record<string, string | undefined>;
  mediaManagerCredential?: { key: string; secret: string };
  now?: () => number;
  interrupted?: () => boolean;
  dependencies?: Partial<StageDependencies>;
  prepareAgainstCommitSha?: string;
}) {
  if (!QUEUE_ID.test(queueId ?? "") || !COMMIT_SHA.test(commitSha ?? "") || !path.isAbsolute(stateDirectory) ||
      !path.relative(path.resolve(site, ".."), path.resolve(stateDirectory)).startsWith("..")) {
    operatorError("The cloud release input is invalid");
  }
  if (prepareAgainstCommitSha !== undefined &&
      (!COMMIT_SHA.test(prepareAgainstCommitSha) || prepareAgainstCommitSha === commitSha)) {
    operatorError("The detached release predecessor is invalid");
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  await dependencies.assertSourceCheckout(commitSha);
  const runtime = { owner: "cloudflare" as const, release: commitSha };
  const buildBatchId = `cms-${queueId}`;

  const [control, pointer] = await Promise.all([
    firestore.doc("system/cmsPublicationRuntime").get(), firestore.doc("system/publicDeployment").get(),
  ]);
  if (!control.exists || !pointer.exists) operatorError("The publication control state is missing");
  const cloud = cloudCmsPublicationRuntimeControl(control.data());
  const expectedPublisher = prepareAgainstCommitSha ?? commitSha;
  if (cloud.serializerId !== CLOUD_SERIALIZER_ID || cloud.commitSha !== expectedPublisher) {
    operatorError("The cloud publisher is not pinned to this release");
  }
  if (pointer.data()?.state !== "idle") operatorError("A public deployment is in progress");
  if (pointer.data()?.activeCommitSha === commitSha) operatorError("This release is already the active public source");
  if (prepareAgainstCommitSha && pointer.data()?.activeCommitSha !== prepareAgainstCommitSha) {
    operatorError("The detached release predecessor is no longer active");
  }
  const otherMode = await firestore.doc(prepareAgainstCommitSha
    ? `system/publicDeployment/buildBatches/${buildBatchId}`
    : `system/publicReleasePreparations/entries/${queueId}`).get();
  if (otherMode.exists) operatorError("This operation id belongs to the other release mode; use a new operation id");
  await storage.assertReady();
  const stopIfInterrupted = () => {
    if (interrupted()) operatorError("The cloud release was interrupted; retry with the same operation id");
  };
  stopIfInterrupted();

  const batch = prepareAgainstCommitSha
    ? await dependencies.prepareDetached({ firestore, preparationId: queueId, commitSha, oldCommitSha: prepareAgainstCommitSha })
    : (await dependencies.reserveBatch({ firestore, buildBatchId, commitSha, runtime })).batch;
  const directory = path.join(stateDirectory, "releases", queueId);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let input = await storage.readInput(queueId);
  if (!input) {
    // Firestore serves the historical read only near the reservation cutoff.
    // After the input is frozen, no attempt reads the database for content again.
    if (now() - batch.cutoffAt.toMillis() > MAX_PUBLIC_ARTIFACT_CUTOFF_AGE_MILLIS) {
      operatorError(prepareAgainstCommitSha
        ? "The preparation expired before its input was frozen; use a new operation id"
        : "The reservation expired before its input was frozen; retire it and use a new operation id");
    }
    input = await storage.freezeInput(queueId, await dependencies.readContent(firestore, { buildBatchId, commitSha,
      ...(prepareAgainstCommitSha ? { preparationId: queueId } : {}) }, stateDirectory));
  }
  const identity: CloudPublicationIdentity = { queueId, buildBatchId, commitSha,
    inputSha256: createHash("sha256").update(input).digest("hex") };

  // The first complete build of this input wins. A retry stages those stored
  // bytes; a second build can differ, because external feeds change.
  let prepared: PreparedArtifact;
  if (await storage.restoreArtifact(identity, directory)) {
    prepared = await dependencies.readPreparedArtifact(directory);
  } else {
    const retained = path.join(stateDirectory, "inputs", queueId);
    await rm(retained, { recursive: true, force: true });
    await mkdir(retained, { recursive: true, mode: 0o700 });
    await writeFile(path.join(retained, "input.json"), input, { mode: 0o600 });
    await dependencies.freezeExternalInputs({ buildBatchId, commitSha, buildEnvironment, mediaManagerCredential,
      artifactReceiptPath: path.join(retained, "artifact-inventory.json"), retainedInputDirectory: retained });
    stopIfInterrupted();
    // A stale compiled graph from another source must never be staged.
    await rm(rendererDirectory, { recursive: true, force: true });
    // The build script names its offline retained-input mode "background". The
    // reservation and the identity stay those of this release.
    const artifactReceipt = await dependencies.build({ buildBatchId, commitSha, retainedInputDirectory: retained,
      artifactReceiptPath: path.join(directory, "artifact-inventory.json"),
      buildEnvironment: { ...buildEnvironment, PUBLIC_ARTIFACT_BATCH_MODE: "background",
        CMS_DEPLOYMENT_ENVIRONMENT: "production" } });
    // The build child has ended here, so the checkout is quiet again.
    stopIfInterrupted();
    prepared = await dependencies.prepareArtifact({ artifactReceipt, distDirectory,
      outputPath: path.join(directory, "prepared-worker.json") });
    if (!(await lstat(path.join(rendererDirectory, "renderer-release.json"))).isFile()) {
      operatorError("The compiled renderer is missing");
    }
    await cp(distDirectory, path.join(directory, "dist"), { recursive: true, errorOnExist: true });
    await cp(rendererDirectory, path.join(directory, "renderer"), { recursive: true, errorOnExist: true });
  }
  if (prepared.commitSha !== commitSha || prepared.buildBatchId !== buildBatchId || prepared.generation !== batch.generation) {
    operatorError("The built artifact differs from its reservation");
  }
  await assertProductionRendererSeals(directory, commitSha);
  stopIfInterrupted();
  if (prepareAgainstCommitSha) {
    const { artifactCheckpointDigest } = await dependencies.checkpoint({ storage, identity, directory });
    await dependencies.recordCheckpoint({ firestore, preparationId: queueId, commitSha,
      inputSha256: identity.inputSha256, artifactCheckpointDigest, preparedArtifact: prepared });
    return { queueId, buildBatchId, commitSha, generation: batch.generation, artifactDigest: prepared.artifactDigest,
      artifactCheckpointDigest, status: "prepared" as const };
  }
  await dependencies.stage({ firestore, storage, serializerId: CLOUD_SERIALIZER_ID, identity, directory });
  return { queueId, buildBatchId, commitSha, generation: batch.generation, artifactDigest: prepared.artifactDigest, status: "staged" as const };
}

/** Retires a reservation of this producer that will never be staged. A staged
 * request, a candidate or a queue row belongs to another owner and refuses. */
export async function retireCmsPublicationCloudReleaseReservation({ firestore, queueId, commitSha,
  serverTimestamp = () => firebaseAdminRuntime.FieldValue.serverTimestamp() }: {
  firestore: Firestore; queueId: string; commitSha: string; serverTimestamp?: () => unknown;
}) {
  if (!QUEUE_ID.test(queueId ?? "") || !COMMIT_SHA.test(commitSha ?? "")) operatorError("The cloud release input is invalid");
  const buildBatchId = `cms-${queueId}`;
  const batchRef = firestore.doc(`system/publicDeployment/buildBatches/${buildBatchId}`);
  return firestore.runTransaction(async (transaction) => {
    const [batch, pointer, request, candidate, queue] = await Promise.all([
      transaction.get(batchRef), transaction.get(firestore.doc("system/publicDeployment")),
      transaction.get(firestore.doc(`${cloudReleaseCollection(CLOUD_SERIALIZER_ID)}/${queueId}`)),
      transaction.get(batchRef.collection("candidates").doc("worker")),
      transaction.get(firestore.doc(`cmsPublishQueue/${queueId}`)),
    ]);
    const stored = batch.data();
    const active = pointer.data();
    if (!stored || !active) operatorError("The cloud release reservation does not exist");
    if (stored.runtime?.owner !== "cloudflare" || stored.commitSha !== commitSha) {
      operatorError("This reservation does not belong to the cloud release");
    }
    const result = { queueId, buildBatchId, commitSha, generation: stored.generation, status: "retired" as const };
    if (stored.status === "retired") {
      assertPublicDeploymentRetiredCloudReleaseBatch(stored, buildBatchId);
      return result;
    }
    assertPublicDeploymentReservedBatch(stored, buildBatchId);
    if (request.exists || candidate.exists || queue.exists) {
      operatorError("This reservation has a release request, a candidate or a queue row; it cannot be retired");
    }
    if (active.state !== "idle") operatorError("A public deployment is in progress");
    transaction.set(batchRef, { ...stored, status: "retired", retiredAt: serverTimestamp(),
      retirementReceipt: { schemaVersion: 1, reason: "cloud_release_not_staged", originalOwner: "cloudflare",
        activeGeneration: active.activeGeneration, activeCommitSha: active.activeCommitSha,
        activeDeploymentId: active.activeDeploymentId } });
    return result;
  });
}

function controlledErrorMessage(error: unknown): string {
  return error instanceof CmsPublicationCloudReleaseOperatorError || error instanceof CmsPublicationRuntimeGuardError
    ? error.message : "The cloud release command did not complete; read the reservation and release request before a retry";
}

export async function main(args = process.argv.slice(2), environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  let app: App | undefined;
  let storage: Storage | undefined;
  try {
    assertProductionFirestoreRouting(environment);
    assertProductionReleaseTarget(environment);
    const parsed = parseReleaseArguments(args);
    const { action, queueId, commitSha } = parsed;
    const serviceAccount = parseCmsPublicationFirebaseServiceAccount(readFileSync(FIREBASE_CREDENTIAL_FD, "utf8"));
    const initialize = () => firebaseAdminRuntime.getFirestore(app = firebaseAdminRuntime.initializeApp(
      { credential: firebaseAdminRuntime.cert(serviceAccount), projectId: FIREBASE_PROJECT_ID },
      "cms-publication-cloud-release-operator",
    ));
    if (parsed.action === "supersede-upload-exhausted") {
      const result = await supersedeUploadExhaustedCloudRelease({ firestore: initialize(), queueId, commitSha, apply: parsed.apply });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (parsed.action === "retry") {
      const result = await retryCmsPublicationCloudRelease({ firestore: initialize(), queueId, commitSha,
        oldCommitSha: parsed.oldCommitSha, apply: parsed.apply });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (action === "retire") {
      const retired = await retireCmsPublicationCloudReleaseReservation({ firestore: initialize(), queueId, commitSha });
      process.stdout.write(`${JSON.stringify(retired)}\n`);
      return;
    }
    const stateDirectory = environment.CMS_PUBLICATION_RELEASE_STATE_DIRECTORY ?? "";
    if (!path.isAbsolute(stateDirectory)) operatorError("The cloud release state directory is required");
    const buildEnvironment = parseCmsPublicationPublicBuildEnvironment(environment);
    const storageCredential = parsePreviewStorageCredential(readFileSync(STORAGE_CREDENTIAL_FD, "utf8"));
    const mediaManagerCredential = parseCmsPublicationMediaManagerCredential(readFileSync(MEDIA_MANAGER_CREDENTIAL_FD, "utf8"));
    storage = createCmsPublicationCloudStorage({ ...storageCredential, includeRenderer: true });
    const result = await stageCmsPublicationCloudRelease({
      firestore: initialize(), storage, queueId, commitSha, stateDirectory, mediaManagerCredential, buildEnvironment,
      ...(parsed.action === "prepare" ? { prepareAgainstCommitSha: parsed.oldCommitSha } : {}),
      interrupted: installInterruptGuard(),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Cloud release refused: ${controlledErrorMessage(error)}\n`);
    process.exitCode = 1;
  } finally {
    storage?.close();
    if (app) await firebaseAdminRuntime.deleteApp(app).catch(() => { process.exitCode = 1; });
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  void main();
}
