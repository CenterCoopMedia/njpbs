import type { PreviewStorageCredential } from "./cms-preview-storage-credential";
import { retainCloudPreviewPublicContext } from "./cms-preview-cloud-storage";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { createCmsPublicationCloudStorage, type CloudPublicationIdentity } from "./cms-publication-cloud-storage";
import { openCmsPublicationCloudTokenJournal } from "./cms-publication-cloud-token-journal";
import { uploadPublicWorkerCandidate } from "./upload-public-worker-candidate";
import { PublicWorkerActivationOperatorError, runPublicWorkerActivationOperator } from "./activate-public-worker-candidate";
import { assertCmsPublicationSourceCheckout } from "./cms-publication-runtime-guard";
import { assertPreparedPublicWorkerArtifact, verifyPreparedPublicWorkerArtifact } from "../src/lib/public-worker-artifact";

const require = createRequire(import.meta.url);
const { assertPublicationOwner } = require("../../functions/lib/publication-runtime-owner");
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
export const CLOUD_RELEASE_ATTEMPT_LIMIT = 4;
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
const activationExhaustionReason = "activation: Automatic retry attempts exhausted while activation remains nonterminal. Retain the original journal and lease for reconciliation.";
const interruptedExhaustionReason = "release: Automatic retry attempts exhausted without a terminal result. Inspect the original request, batch and journal before recovery.";
const terminalExhaustionReason = "release: Automatic retry attempts exhausted; the release has a failed terminal batch. Inspect that receipt before recovery.";

/** Only operator-owned text and a bounded HTTP status leave this boundary.
 * Provider bodies, arbitrary messages, headers and URLs are never copied. */
export function cloudReleaseFailureReason(stage: CloudReleaseFailureStage, error?: unknown, exhausted = false): string {
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
  const message = Object.hasOwn(failureMessages, stage) ? `${stage}: ${failureMessages[stage]}` : "release: The attempt did not complete";
  return `${message}${status === undefined ? "" : ` (HTTP ${status})`}.${exhausted
    ? " Automatic retry attempts exhausted; original release ownership is retained." : ""}`.slice(0, 300);
}

async function verifyRelease(directory: string, identity: CloudPublicationIdentity) {
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
export async function checkpointNoBuildCloudRelease({ storage, identity, directory }: {
  storage: Storage; identity: CloudPublicationIdentity; directory: string;
}) {
  if (!storage.includesRenderer) throw new Error("Cloud release storage must retain the complete renderer");
  const input = await storage.readInput(identity.queueId);
  if (!input || hash(input) !== identity.inputSha256) throw new Error("Cloud release input differs");
  const prepared = await verifyRelease(directory, identity);
  const artifactCheckpointDigest = await storage.checkpointArtifact(identity, directory);
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

async function readPreparedReleaseRequest(firestore: Firestore, transaction: Transaction,
  preparationId: string, commitSha: string) {
  const retained = await readPreparedReleaseProof(transaction, firestore, preparationId, commitSha);
  const [batch, candidate, promotion] = await transaction.getAll(
    firestore.doc(`system/publicDeployment/buildBatches/cms-${preparationId}`),
    firestore.doc(`system/publicDeployment/buildBatches/cms-${preparationId}/candidates/worker`),
    firestore.doc(`system/publicReleasePreparations/entries/${preparationId}/promotions/reservation`));
  if (!batch.exists || !["ready", "deploying", "reconciling"].includes(batch.data()?.status) || !promotion.exists ||
      promotion.data()?.proofDigest !== metadataDigest(retained.proof)) throw new Error("Prepared release promotion differs");
  assertPublicationOwner(batch.data(), { owner: "cloudflare", release: commitSha });
  const { recordedAt: _at, ...liveCandidate } = projectPublicWorkerCandidate(candidate.data());
  if (!isDeepStrictEqual(liveCandidate, retained.candidate)) throw new Error("Prepared release candidate differs");
  return retained;
}

/** Materialize only sealed metadata. The atomic promotion already created the
 * original owner's request, so interruption here resumes the same durable job. */
async function materializePreparedRelease(firestore: Firestore, preparationId: string, commitSha: string) {
  const retained = await firestore.runTransaction(async transaction => readPreparedReleaseProof(transaction, firestore, preparationId, commitSha),
    { readOnly: true });
  await stagePublicMediaManifest({ firestore, manifest: retained.proof.mediaManifest });
  await markPublicMediaManifestReady({ firestore, manifest: retained.proof.mediaManifest });
  await recordPublicWorkerCandidate({ firestore, candidate: retained.candidate, runtime: { owner: "cloudflare", release: commitSha } });
}

/** One request per pass. The cloud journal retains its original job until a
 * terminal batch; an ambiguous activation remains with the shared lease owner. */
export async function runNoBuildCloudRelease({ firestore, storage, serializerId, commitSha, stateDirectory, cloudflareApiToken,
  previewStorageCredential, sourceGit, activationIO }: {
  firestore: Firestore; storage: Storage; serializerId: string; commitSha: string; stateDirectory: string; cloudflareApiToken: string;
  previewStorageCredential: PreviewStorageCredential;
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
    const exhausted = typeof request.failureReason === "string" && request.failureReason.includes("Automatic retry attempts exhausted");
    await row.ref.update({ status: batch.status, nextAttemptAt: null, failureReason: batch.status === "failed"
      ? exhausted ? terminalExhaustionReason : request.failureReason ?? null : null });
    if (retained) await journal.clear({ queueId: retained.queueId, claimToken: retained.claimToken });
    return;
  }
  if (!["pending", "failed"].includes(request.status) || !Number.isFinite(request.nextAttemptAt) || request.nextAttemptAt > Date.now()) return;
  if (!Number.isSafeInteger(request.attempts) || request.attempts < 0) return;
  const recordRetryExhaustion = async (attempts: number) => {
    const reason = await firestore.runTransaction(async tx => {
      const [currentRow, currentBatch] = await tx.getAll(row.ref, batchRef);
      const current = currentRow.data(), liveBatch = currentBatch.data();
      if (!current || !liveBatch) throw new Error("Cloud release exhaustion evidence is missing");
      assertPublicationOwner(current, runtime);
      assertPublicationOwner(liveBatch, runtime);
      if (["deployed", "failed", "superseded", "cancelled"].includes(liveBatch.status) ||
          !["pending", "failed"].includes(current.status) || current.attempts !== attempts ||
          !Number.isFinite(current.nextAttemptAt) || current.inputSha256 !== request.inputSha256 ||
          current.artifactCheckpointDigest !== request.artifactCheckpointDigest) return null;
      const failureReason = ["deploying", "reconciling"].includes(liveBatch.status)
        ? activationExhaustionReason : interruptedExhaustionReason;
      tx.update(row.ref, { status: "failed", nextAttemptAt: null, failureReason });
      return failureReason;
    });
    if (reason) console.error(reason);
  };
  if (request.attempts >= CLOUD_RELEASE_ATTEMPT_LIMIT) {
    // A crash can leave a due retry after the final attempt.
    // Only an activation-state batch proves that this release reached a lease.
    await recordRetryExhaustion(request.attempts);
    return;
  }
  const { job } = await journal.reserve({ queueId: row.id, buildBatchId: identity.buildBatchId, commitSha });
  const claimed = await firestore.runTransaction(async tx => {
    const current = (await tx.get(row.ref)).data();
    if (!current) throw new Error("Cloud release request disappeared");
    assertPublicationOwner(current, runtime);
    if (current.artifactCheckpointDigest !== request.artifactCheckpointDigest || current.inputSha256 !== request.inputSha256) {
      throw new Error("Cloud release request changed");
    }
    if (!["pending", "failed"].includes(current.status) || current.attempts !== request.attempts ||
        !Number.isFinite(current.nextAttemptAt) || current.nextAttemptAt > Date.now()) return false;
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
      if (batch.status === "reserved" || batch.status === "ready") await materializePreparedRelease(firestore, row.id, commitSha);
      const sealed = await firestore.runTransaction(transaction => readPreparedReleaseRequest(firestore, transaction,
        row.id, commitSha), { readOnly: true });
      prepared = assertPreparedPublicWorkerArtifact(request.preparedArtifact);
      if (!isDeepStrictEqual(prepared, sealed.preparedArtifact) || identity.inputSha256 !== sealed.proof.inputSha256 ||
          request.artifactCheckpointDigest !== sealed.proof.artifactCheckpointDigest) throw new Error("Prepared release proof differs");
    } else {
      const directory = path.join(stateDirectory, "releases", row.id);
      stage = "artifact restore";
      await mkdir(directory, { recursive: true, mode: 0o700 });
      stage = "input read";
      const input = await storage.readInput(row.id);
      if (!input || hash(input) !== identity.inputSha256 || !/^[a-f0-9]{64}$/.test(request.artifactCheckpointDigest)) throw new Error("Cloud release input differs");
      stage = "artifact restore";
      if (!await storage.restoreArtifact(identity, directory, request.artifactCheckpointDigest)) throw new Error("Cloud release artifact is missing");
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
        preparedArtifactPath: path.join(directory, "prepared-worker.json"), distDirectory: path.join(directory, "dist") });
      const { publicationReceiptDigest, artifactFileCount, artifactBytes, ...publication } = prepared;
      stage = "context retention";
      await retainCloudPreviewPublicContext({ firestore: firestore as never, file: path.join(directory, "public-context.json"),
        publication, ...previewStorageCredential, allowCloudRecovery: true });
    }
    stage = "activation";
    const result = await runPublicWorkerActivationOperator({ firestore: firestore as never, runtime, cloudflareApiToken,
      preparedArtifact: prepared, requestJson: activationIO?.requestJson, requestPublication: activationIO?.requestPublication });
    if (["deployed", "failed", "superseded"].includes(result.outcome)) {
      const failureReason = result.outcome === "failed" ? cloudReleaseFailureReason(stage) : null;
      if (failureReason) console.error(failureReason);
      await row.ref.update({ status: result.outcome, nextAttemptAt: null, failureReason });
      await journal.clear({ queueId: job.queueId, claimToken: job.claimToken });
    } else if (request.attempts + 1 >= CLOUD_RELEASE_ATTEMPT_LIMIT) {
      await recordRetryExhaustion(request.attempts + 1);
    } else await row.ref.update({ nextAttemptAt: Date.now() + 60_000 });
  } catch (error) {
    // Keep original ownership and journal after uncertainty. Reconciliation is
    // never bypassed by the finite upload/preparation attempt budget.
    const failureReason = cloudReleaseFailureReason(stage, error, request.attempts + 1 >= CLOUD_RELEASE_ATTEMPT_LIMIT);
    console.error(failureReason);
    await row.ref.update({ status: "failed", failureReason,
      nextAttemptAt: request.attempts + 1 >= CLOUD_RELEASE_ATTEMPT_LIMIT ? null : Date.now() + 60_000 * 2 ** request.attempts });
  }
}
