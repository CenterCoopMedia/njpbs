import type { PreviewStorageCredential } from "./cms-preview-storage-credential";
import { retainCloudPreviewPublicContext } from "./cms-preview-cloud-storage";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DocumentData, Firestore, Transaction } from "firebase-admin/firestore";
import { CloudPublicationBytesRefused, createCmsPublicationCloudStorage, type CloudPublicationIdentity } from "./cms-publication-cloud-storage";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";
import { openCmsPublicationCloudTokenJournal } from "./cms-publication-cloud-token-journal";
import { uploadPublicWorkerCandidate } from "./upload-public-worker-candidate";
import { PublicWorkerActivationOperatorError, runPublicWorkerActivationOperator } from "./activate-public-worker-candidate";
import { assertCmsPublicationSourceCheckout } from "./cms-publication-runtime-guard";
import { assertPreparedPublicWorkerArtifact, verifyPreparedPublicWorkerArtifact } from "../src/lib/public-worker-artifact";
import type { PublicationTarget } from "../../functions/lib/publication-target";
import type { PublicationAccess } from "./activate-public-worker-candidate";

const require = createRequire(import.meta.url);
const { assertPublicationOwner } = require("../../functions/lib/publication-runtime-owner");
const { noAnswer } = require("../../functions/lib/release-wait");
const { assertPublicDeploymentReservedBatch } = require("../../functions/lib/public-deployment");
const { readPreparedReleaseProof } = require("../../functions/lib/public-release-promotion");
const { projectPublicWorkerCandidate } = require("../../functions/lib/public-worker-candidate");
const { digest: metadataDigest } = require("../../functions/lib/no-build-page-ownership");
const { stagePublicMediaManifest, markPublicMediaManifestReady } = require("../../functions/lib/public-media-manifest-store");
const { recordPublicWorkerCandidate } = require("../../functions/lib/public-worker-candidate-store");
const site = fileURLToPath(new URL("..", import.meta.url));
type Storage = ReturnType<typeof createCmsPublicationCloudStorage>;
export const cloudReleaseCollection = (serializerId: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(serializerId)) throw new Error("Invalid cloud journal identity");
  return `cmsPublicationSerializerJournals/${serializerId}/releases`;
};
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** Longest pause between two attempts. It never limits the number of attempts. */
const CLOUD_RELEASE_MAX_RETRY_PAUSE_MS = 30 * 60_000;
const cloudReleaseRetryPause = (attempts: number) => Math.min(60_000 * 2 ** attempts, CLOUD_RELEASE_MAX_RETRY_PAUSE_MS);
export type CloudReleaseFailureStage = "source check" | "input read" | "artifact restore" | "release verification" |
  "candidate upload" | "context retention" | "activation";
const failureMessages: Record<CloudReleaseFailureStage, string> = {
  "source check": "The exact release checkout could not be verified",
  "input read": "The frozen release input could not be read or verified",
  "artifact restore": "The frozen release artifact could not be restored",
  "release verification": "The restored release or renderer could not be verified",
  "candidate upload": "The public Worker candidate could not be uploaded or verified",
  "context retention": "The frozen public preview context could not be retained",
  "activation": "The public Worker activation did not complete",
};

/** Read only bounded status metadata from a provider error. */
export function cloudReleaseHttpStatus(error: unknown): number | undefined {
  let status: number | undefined;
  try {
    if (error && typeof error === "object") {
      for (const field of ["status", "statusCode"]) {
        const value = Object.getOwnPropertyDescriptor(error, field)?.value;
        if (Number.isSafeInteger(value) && value >= 100 && value <= 599) { status = value; break; }
      }
      const metadata = Object.getOwnPropertyDescriptor(error, "$metadata")?.value;
      const metadataStatus = metadata && typeof metadata === "object" ? Object.getOwnPropertyDescriptor(metadata, "httpStatusCode")?.value : undefined;
      if (status === undefined && Number.isSafeInteger(metadataStatus) && metadataStatus >= 100 && metadataStatus <= 599) status = metadataStatus;
      // This existing operator exposes its status in this exact controlled
      // sentence, without retaining the provider response body.
      if (status === undefined && error instanceof PublicWorkerActivationOperatorError) {
        const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
        const match = typeof message === "string" ? /^The Cloudflare API returned HTTP ([1-5]\d{2})$/.exec(message) : null;
        if (match) status = Number(match[1]);
      }
    }
  } catch { /* A malformed error must not compromise failure recording. */ }
  return status;
}

/** The method, path and Cloudflare error codes of the operator's own refused call. */
function cloudReleaseCall(error: unknown): string {
  const call = error instanceof PublicWorkerActivationOperatorError ? error.call : undefined;
  if (!call || !/^(?:GET|POST)$/.test(call.method) || !/^\/[A-Za-z0-9/_:.-]{0,120}$/.test(call.path)) return "";
  return `; ${call.method} ${call.path}${call.codes.length ? `; Cloudflare code ${call.codes.join(", ")}` : ""}`;
}

/** Only operator-owned text, a bounded HTTP status and the operator's own call
 * leave this boundary. Provider bodies, arbitrary messages, headers, ids and
 * queries are never copied. */
export function cloudReleaseFailureReason(stage: CloudReleaseFailureStage, error?: unknown): string {
  const status = cloudReleaseHttpStatus(error);
  const message = Object.hasOwn(failureMessages, stage) ? `${stage}: ${failureMessages[stage]}` : "release: The attempt did not complete";
  const detail = `${status === undefined ? "" : `HTTP ${status}`}${cloudReleaseCall(error)}`.replace(/^; /, "");
  return `${message}${detail && ` (${detail})`}.`.slice(0, 300);
}

/** Local read faults keep their error; every other refusal of these exact bytes is final. */
async function verifyRelease(directory: string, identity: CloudPublicationIdentity) {
  try { return await verifyReleaseBytes(directory, identity); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== undefined) throw error;
    throw new CloudPublicationBytesRefused((error as Error).message, { cause: error });
  }
}

async function verifyReleaseBytes(directory: string, identity: CloudPublicationIdentity) {
  const prepared = assertPreparedPublicWorkerArtifact(JSON.parse(await readFile(path.join(directory, "prepared-worker.json"), "utf8")));
  if (prepared.commitSha !== identity.commitSha || prepared.buildBatchId !== identity.buildBatchId) throw new Error("Cloud release source differs");
  await verifyPreparedPublicWorkerArtifact({ preparedArtifact: prepared, distDirectory: path.join(directory, "dist") });
  const seal = JSON.parse(await readFile(path.join(directory, "renderer/renderer-release.json"), "utf8"));
  const publicSeal = JSON.parse(await readFile(path.join(directory, "dist/posts/_no-build-assets/renderer-release.json"), "utf8"));
  if (seal.schemaVersion !== 1 || publicSeal.schemaVersion !== 1 ||
      seal.rendererSha !== identity.commitSha || publicSeal.rendererSha !== identity.commitSha) throw new Error("Cloud release renderer differs");
  return prepared;
}

/** Checkpoint exact bytes without creating executable work or making a public
 * candidate eligible. Preparation and staging share this storage boundary. */
export async function checkpointNoBuildCloudRelease({ storage, identity, directory, onRestore }: {
  storage: Storage; identity: CloudPublicationIdentity; directory: string; onRestore?: () => void;
}) {
  if (!storage.includesRenderer) throw new Error("Cloud release storage must retain the complete renderer");
  const input = await storage.readInput(identity.queueId);
  if (!input || hash(input) !== identity.inputSha256) throw new Error("Cloud release input differs");
  const prepared = await verifyRelease(directory, identity);
  const artifactCheckpointDigest = await storage.checkpointArtifact(identity, directory, onRestore);
  onRestore?.();
  if (!await storage.restoreArtifact(identity, directory, artifactCheckpointDigest)) throw new Error("Cloud release checkpoint is missing");
  const restored = await verifyRelease(directory, identity);
  if (restored.artifactDigest !== prepared.artifactDigest) throw new Error("Cloud release checkpoint conflicts");
  return { prepared: restored, artifactCheckpointDigest };
}

/** Trusted approved-release producer only. Persist the wakeable request last,
 * after the complete artifact (including the sealed server graph) is durable. */
export async function stageNoBuildCloudRelease({ firestore, storage, serializerId, identity, directory }: {
  firestore: Firestore; storage: Storage; serializerId: string; identity: CloudPublicationIdentity; directory: string;
}) {
  const runtime = { owner: "cloudflare" as const, release: identity.commitSha };
  const { prepared, artifactCheckpointDigest } = await checkpointNoBuildCloudRelease({ storage, identity, directory });
  const ref = firestore.collection(cloudReleaseCollection(serializerId)).doc(identity.queueId);
  await firestore.runTransaction(async tx => {
    const [batch, before] = await Promise.all([
      tx.get(firestore.doc(`system/publicDeployment/buildBatches/${identity.buildBatchId}`)), tx.get(ref),
    ]);
    if (!batch.exists) throw new Error("Cloud release reservation is missing");
    assertPublicationOwner(batch.data(), runtime);
    if (batch.data()?.commitSha !== identity.commitSha || batch.data()?.generation !== prepared.generation) throw new Error("Cloud release reservation differs");
    if (before.exists) {
      const current = before.data()!;
      assertPublicationOwner(current, runtime);
      if (current.artifactCheckpointDigest !== artifactCheckpointDigest || current.inputSha256 !== identity.inputSha256) throw new Error("Cloud release request conflicts");
      return;
    }
    if (batch.data()?.status !== "reserved") throw new Error("Cloud release reservation is not pending");
    tx.create(ref, { schemaVersion: 1, runtime, ...identity, artifactCheckpointDigest,
      status: "pending", attempts: 0, nextAttemptAt: Date.now() });
  });
}

/** The sealed proof is durable metadata. A refusal of what was read is final;
 * a failed read, which carries a Firestore code, is not. */
async function refusedProof<T>(read: () => Promise<T> | T) {
  try { return await read(); }
  catch (error) {
    if (typeof (error as { code?: unknown })?.code === "number" || noAnswer(error)) throw error;
    throw new CloudPublicationBytesRefused((error as Error)?.message ?? "Prepared release proof was refused", { cause: error });
  }
}

async function readPreparedReleaseRequest(firestore: Firestore, transaction: Transaction,
  preparationId: string, commitSha: string, target?: PublicationTarget) {
  const retained = await readPreparedReleaseProof(transaction, firestore, preparationId, commitSha, target);
  const [batch, candidate, promotion] = await transaction.getAll(
    firestore.doc(`system/publicDeployment/buildBatches/cms-${preparationId}`),
    firestore.doc(`system/publicDeployment/buildBatches/cms-${preparationId}/candidates/worker`),
    firestore.doc(`system/publicReleasePreparations/entries/${preparationId}/promotions/reservation`));
  if (!batch.exists || !["ready", "deploying", "reconciling"].includes(batch.data()?.status) || !promotion.exists ||
      promotion.data()?.proofDigest !== metadataDigest(retained.proof)) throw new Error("Prepared release promotion differs");
  assertPublicationOwner(batch.data(), { owner: "cloudflare", release: commitSha });
  const { recordedAt: _at, ...liveCandidate } = projectPublicWorkerCandidate(candidate.data(), null, { target });
  if (!isDeepStrictEqual(liveCandidate, retained.candidate)) throw new Error("Prepared release candidate differs");
  return retained;
}

/** Materialize only sealed metadata. The atomic promotion already created the
 * original owner's request, so interruption here resumes the same durable job. */
async function materializePreparedRelease(firestore: Firestore, preparationId: string, commitSha: string, target?: PublicationTarget) {
  const retained = await refusedProof(() => firestore.runTransaction(async transaction =>
    readPreparedReleaseProof(transaction, firestore, preparationId, commitSha, target), { readOnly: true }));
  await stagePublicMediaManifest({ firestore, manifest: retained.proof.mediaManifest });
  await markPublicMediaManifestReady({ firestore, manifest: retained.proof.mediaManifest });
  await recordPublicWorkerCandidate({ firestore, candidate: retained.candidate, runtime: { owner: "cloudflare", release: commitSha }, target });
}

/** Settle a request whose sealed bytes are refused before any activation. The
 * request, its reservation and its own journal job end in one transaction, so
 * a later release can start. An uploaded candidate also loses its eligibility,
 * which returns to the active release. The reservation counter only moves
 * forward, and the publisher pins stay. A batch with a lease or an uncertain
 * activation keeps its owner. */
async function settleRefusedCloudRelease({ firestore, serializerId, commitSha, identity, request, claimToken, failureReason }: {
  firestore: Firestore; serializerId: string; commitSha: string; identity: CloudPublicationIdentity;
  request: DocumentData; claimToken: string; failureReason: string;
}) {
  const requestRef = firestore.doc(`${cloudReleaseCollection(serializerId)}/${identity.queueId}`);
  const batchRef = firestore.doc(`system/publicDeployment/buildBatches/${identity.buildBatchId}`);
  const journalRef = firestore.doc(`cmsPublicationSerializerJournals/${serializerId}`);
  const pointerRef = firestore.doc("system/publicDeployment");
  return firestore.runTransaction(async tx => {
    const [requestRow, batchRow, pointerRow, candidate, queue, journalRow] = await tx.getAll(requestRef, batchRef,
      pointerRef, batchRef.collection("candidates").doc("worker"),
      firestore.doc(`cmsPublishQueue/${identity.queueId}`), journalRef);
    const current = requestRow.data(), batch = batchRow.data(), pointer = pointerRow.data(), job = journalRow.data()?.job;
    if (!current || !batch || !pointer) return false;
    const runtime = { owner: "cloudflare" as const, release: commitSha };
    assertPublicationOwner(current, runtime);
    assertPublicationOwner(batch, runtime);
    if (current.status === "deployed" || current.attempts !== request.attempts + 1 || current.inputSha256 !== request.inputSha256 ||
        current.artifactCheckpointDigest !== request.artifactCheckpointDigest ||
        job?.queueId !== identity.queueId || job?.claimToken !== claimToken || job?.commitSha !== commitSha ||
        !["reserved", "ready"].includes(batch.status) || batch.leaseToken !== undefined ||
        pointer.state !== "idle" || pointer.leaseToken != null || pointer.activeGeneration >= batch.generation ||
        pointer.candidateBuildBatchId === identity.buildBatchId) return false;
    const eligible = pointer.newestEligibleBuildBatchId === identity.buildBatchId && pointer.newestEligibleGeneration === batch.generation;
    const active = eligible ? (await tx.get(firestore.collection("system/publicDeployment/buildBatches")
      .where("generation", "==", pointer.activeGeneration).where("status", "==", "deployed").limit(2))).docs : [];
    if (eligible && (active.length !== 1 || active[0].data().commitSha !== pointer.activeCommitSha ||
        active[0].data().deploymentId !== pointer.activeDeploymentId)) return false;
    const settledAt = firebaseAdminRuntime.FieldValue.serverTimestamp();
    tx.update(requestRef, { status: "failed", nextAttemptAt: null, failureReason,
      refusalReceipt: { schemaVersion: 1, reason: "cloud_release_input_refused", settledAt } });
    if (batch.status === "reserved" && !candidate.exists && !queue.exists) {
      assertPublicDeploymentReservedBatch(batch, identity.buildBatchId);
      tx.update(batchRef, { status: "retired", retiredAt: settledAt,
        retirementReceipt: { schemaVersion: 1, reason: "cloud_release_not_staged", originalOwner: "cloudflare",
          activeGeneration: pointer.activeGeneration, activeCommitSha: pointer.activeCommitSha,
          activeDeploymentId: pointer.activeDeploymentId } });
    }
    if (eligible) tx.update(pointerRef, { newestEligibleGeneration: pointer.activeGeneration,
      newestEligibleBuildBatchId: active[0].id, updatedAt: settledAt });
    tx.update(journalRef, { job: null });
    return true;
  });
}

/** One request per pass. The cloud journal retains its original job until a
 * terminal batch; an ambiguous activation remains with the shared lease owner. */
export async function runNoBuildCloudRelease({ firestore, storage, serializerId, commitSha, stateDirectory, cloudflareApiToken,
  previewStorageCredential, sourceGit, activationIO, target, publicationAccess }: {
  firestore: Firestore; storage: Storage; serializerId: string; commitSha: string; stateDirectory: string; cloudflareApiToken: string;
  previewStorageCredential: PreviewStorageCredential; target?: PublicationTarget; publicationAccess?: PublicationAccess;
  sourceGit?: Parameters<typeof assertCmsPublicationSourceCheckout>[1];
  activationIO?: Pick<Parameters<typeof runPublicWorkerActivationOperator>[0], "requestJson" | "requestPublication">;
}) {
  const runtime = { owner: "cloudflare" as const, release: commitSha };
  const collection = firestore.collection(cloudReleaseCollection(serializerId));
  const journal = await openCmsPublicationCloudTokenJournal({ firestore, serializerId, runtime });
  const retained = await journal.read();
  if (retained && retained.commitSha !== commitSha) throw new Error("Cloud release journal requires its original source");
  const rows = retained ? [await collection.doc(retained.queueId).get()] : (await collection
    .where("runtime.owner", "==", "cloudflare").where("runtime.release", "==", commitSha)
    .where("nextAttemptAt", "<=", Date.now()).orderBy("nextAttemptAt").limit(1).get()).docs;
  if (!rows.length) return;
  const row = rows[0];
  const request = row.data();
  if (!request) throw new Error("Cloud release journal request is missing");
  assertPublicationOwner(request, runtime);
  const identity: CloudPublicationIdentity = { queueId: row.id, buildBatchId: `cms-${row.id}`, commitSha, inputSha256: request.inputSha256 };
  const batchRef = firestore.doc(`system/publicDeployment/buildBatches/${identity.buildBatchId}`);
  const batch = (await batchRef.get()).data();
  if (!batch) throw new Error("Cloud release batch is missing");
  assertPublicationOwner(batch, runtime);
  if (["deployed", "failed", "superseded", "cancelled"].includes(batch.status)) {
    await row.ref.update({ status: batch.status, nextAttemptAt: null,
      failureReason: batch.status === "failed" ? request.failureReason ?? null : null });
    if (retained) await journal.clear({ queueId: retained.queueId, claimToken: retained.claimToken });
    return;
  }
  // A request that the removed attempt limit parked still holds the journal. It
  // is due now: this attempt settles it, or its activation owner reconciles it.
  const due = (value: DocumentData) => ["pending", "failed"].includes(value.status) &&
    (retained !== null && value.status === "failed" && value.nextAttemptAt === null ||
      Number.isFinite(value.nextAttemptAt) && value.nextAttemptAt <= Date.now());
  if (!due(request)) return;
  if (!Number.isSafeInteger(request.attempts) || request.attempts < 0) return;
  const { job } = await journal.reserve({ queueId: row.id, buildBatchId: identity.buildBatchId, commitSha });
  const claimed = await firestore.runTransaction(async tx => {
    const current = (await tx.get(row.ref)).data();
    if (!current) throw new Error("Cloud release request disappeared");
    assertPublicationOwner(current, runtime);
    if (current.artifactCheckpointDigest !== request.artifactCheckpointDigest || current.inputSha256 !== request.inputSha256) {
      throw new Error("Cloud release request changed");
    }
    if (!due(current) || current.attempts !== request.attempts) return false;
    tx.update(row.ref, { attempts: current.attempts + 1, nextAttemptAt: Date.now() + 10 * 60_000, failureReason: null });
    return true;
  });
  if (!claimed) return;
  let stage: CloudReleaseFailureStage = "source check";
  try {
    await assertCmsPublicationSourceCheckout(commitSha, sourceGit);
    let prepared: Awaited<ReturnType<typeof verifyRelease>>;
    if (request.preparationId !== undefined) {
      stage = "release verification";
      if (request.preparationId !== row.id) throw new Error("Prepared release operation differs");
      // A leased candidate keeps its original reconciliation path. Its metadata
      // is already durable and must not be registered again after traffic moves.
      if (batch.status === "reserved" || batch.status === "ready") await materializePreparedRelease(firestore, row.id, commitSha, target);
      const sealed = await refusedProof(() => firestore.runTransaction(transaction => readPreparedReleaseRequest(firestore, transaction,
        row.id, commitSha, target), { readOnly: true }));
      prepared = await refusedProof(() => assertPreparedPublicWorkerArtifact(request.preparedArtifact));
      if (!isDeepStrictEqual(prepared, sealed.preparedArtifact) || identity.inputSha256 !== sealed.proof.inputSha256 ||
          request.artifactCheckpointDigest !== sealed.proof.artifactCheckpointDigest) throw new CloudPublicationBytesRefused("Prepared release proof differs");
    } else {
      const directory = path.join(stateDirectory, "releases", row.id);
      stage = "artifact restore";
      await mkdir(directory, { recursive: true, mode: 0o700 });
      stage = "input read";
      const input = await storage.readInput(row.id);
      if (!input || hash(input) !== identity.inputSha256 || !/^[a-f0-9]{64}$/.test(request.artifactCheckpointDigest)) throw new CloudPublicationBytesRefused("Cloud release input differs");
      stage = "artifact restore";
      if (!await storage.restoreArtifact(identity, directory, request.artifactCheckpointDigest)) throw new CloudPublicationBytesRefused("Cloud release artifact is missing");
      stage = "release verification";
      prepared = await verifyRelease(directory, identity);
      // Wrangler imports this exact sealed graph from the exact image checkout.
      const renderer = path.join(site, ".public-post-renderer");
      stage = "artifact restore";
      await rm(renderer, { recursive: true, force: true });
      await cp(path.join(directory, "renderer"), renderer, { recursive: true, errorOnExist: true });
      stage = "candidate upload";
      await uploadPublicWorkerCandidate({ firestore: firestore as never, runtime, cloudflareApiToken,
        artifactReceiptPath: path.join(directory, "artifact-inventory.json"),
        preparedArtifactPath: path.join(directory, "prepared-worker.json"), distDirectory: path.join(directory, "dist"),
        ...(target ? { target } : {}) });
      const { publicationReceiptDigest, artifactFileCount, artifactBytes, ...publication } = prepared;
      stage = "context retention";
      await retainCloudPreviewPublicContext({ firestore: firestore as never, file: path.join(directory, "public-context.json"),
        publication, ...previewStorageCredential, allowCloudRecovery: true,
        ...(target ? { bucket: target.previewBucket, deploymentEnvironment: target.environment } : {}) });
    }
    stage = "activation";
    const result = await runPublicWorkerActivationOperator({ firestore: firestore as never, runtime, cloudflareApiToken,
      preparedArtifact: prepared, requestJson: activationIO?.requestJson, requestPublication: activationIO?.requestPublication,
      ...(target ? { target } : {}), ...(publicationAccess ? { publicationAccess } : {}) });
    if (["deployed", "failed", "superseded"].includes(result.outcome)) {
      const failureReason = result.outcome === "failed" ? cloudReleaseFailureReason(stage) : null;
      if (failureReason) console.error(failureReason);
      await row.ref.update({ status: result.outcome, nextAttemptAt: null, failureReason });
      await journal.clear({ queueId: job.queueId, claimToken: job.claimToken });
    } else await row.ref.update({ nextAttemptAt: Date.now() + 60_000 });
  } catch (error) {
    // Keep original ownership and journal after uncertainty. A failed attempt
    // is retried after a backoff with no attempt limit; its reason stays visible.
    // Refused bytes are final, so they end here and free the journal.
    const failureReason = cloudReleaseFailureReason(stage, error);
    console.error(failureReason);
    if (error instanceof CloudPublicationBytesRefused &&
        await settleRefusedCloudRelease({ firestore, serializerId, commitSha, identity, request, claimToken: job.claimToken, failureReason }).catch(() => false)) return;
    await row.ref.update({ status: "failed", failureReason, nextAttemptAt: Date.now() + cloudReleaseRetryPause(request.attempts) });
  }
}
