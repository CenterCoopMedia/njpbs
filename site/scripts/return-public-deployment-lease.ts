// Operator recovery for a deployment lease whose Cloudflare write never landed:
// the publisher container ended between the lease and the write, a read or the
// subdomain request before the write failed, or the write was lost. The
// reconciler keeps such a lease, because a lost write can still land, and one
// lease writes once. This operator proves that nothing landed and that the
// attempt that could write has ended, then gives the lease back: the
// pointer is idle on the predecessor, the batch is ready as before the lease,
// and the release request is due. The publisher then takes a new lease.
// Dry run by default. It sends Cloudflare reads only.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import { activeDeployment, assertProductionFirestoreRouting, requestCloudflareJson, workerApiPath } from "./activate-public-worker-candidate";
import { parseCmsPublicationFirebaseServiceAccount } from "./cms-publication-inputs";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";
import { cloudReleaseCollection } from "./no-build-cloud-release";
import { readPublicDeploymentReconciliationState } from "./reconcile-public-worker-deployment";
import type { PublicationTarget } from "../../functions/lib/publication-target";

const require = createRequire(import.meta.url);
const { publicationTarget } = require("../../functions/lib/publication-target.js") as
  typeof import("../../functions/lib/publication-target");
const { assertPublicDeploymentLeaseBatch, assertPublicDeploymentPointer, planPublicDeploymentLeaseAcquisition, timestampMillis } = require("../../functions/lib/public-deployment.js");
const { publicBuildBatchRef, publicDeploymentRef } = require("../../functions/lib/public-deployment-coordinator.js");
const { RUNTIME_DOCUMENT_PATH, cloudCmsPublicationRuntimeControl } = require("../../functions/lib/cms-publication-runtime-control.js");
const { assertPublicationOwner } = require("../../functions/lib/publication-runtime-owner.js");
const { assertNoReleaseWriterInTransaction } = require("../../functions/lib/public-release-writer-fence.js");
const { projectApiDeploymentStatus } = require("../../functions/lib/public-worker-activation.js") as {
  projectApiDeploymentStatus(value: unknown): { deploymentId: string; versionId: string; createdOn: string } };
const { parseCloudflareToken } = require("../../scripts/bootstrap-public-deployment.cjs") as { parseCloudflareToken(value: string): string };

// A write that Cloudflare accepted can land after its sender ended. Measured
// November 25, 2026: the longest time from a release claim to its lease, with
// more requests than the write, was 71 seconds.
const MINIMUM_ENDED_MS = 10 * 60_000;
const PAUSE_BETWEEN_READS_MS = 30_000;

type RequestJson = typeof requestCloudflareJson;
type WriterState = { state: "ended" | "current" | "unknown"; detail: string; endedAt?: number };
export interface DeploymentRead { readAt: string; activeDeploymentId: string; activeVersionId: string; activeCreatedOn: string; deploymentsRead: number }

export class ReturnPublicDeploymentLeaseError extends Error {}
function refuse(message: string): never { throw new ReturnPublicDeploymentLeaseError(message); }
function rows(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) && value.every(row => row && typeof row === "object") ? value : null;
}
const LEASE_FIELDS = ["leaseToken", "leaseAcquiredAt", "predecessorGeneration", "predecessorDeploymentId", "predecessorCommitSha",
  "reconcilingAt", "cloudflareEvidenceDigest"];
const without = (record: Record<string, unknown>, fields: string[]) =>
  Object.fromEntries(Object.entries(record).filter(([field]) => !fields.includes(field)));
const seconds = (millis: number) => Math.floor(millis / 1000);
const iso = (millis: number) => new Date(millis).toISOString();

/** Whether the publisher container that took the lease has ended. */
async function readPublisherContainer(get: (suffix: string) => Promise<unknown>, target: PublicationTarget, leaseAt: number): Promise<WriterState> {
  try {
    const result = async (suffix: string) => (await get(suffix) as { result?: unknown }).result;
    const matches = rows(await result("/containers/applications"))?.filter(row => row.name === target.publisherWorker) ?? [];
    if (matches.length !== 1 || typeof matches[0].id !== "string") return { state: "unknown", detail: "the publisher application was not found" };
    const id = matches[0].id;
    const slots = rows((await result(`/containers/applications/${id}/instances?per_page=100`) as { instances?: unknown } | undefined)?.instances)
      ?.map(row => row.status as { state?: unknown; updated_at?: unknown } | undefined);
    if (slots?.length && slots.length < 100 && slots.every(slot => slot?.state === "inactive")) {
      const endedAt = Math.max(...slots.map(slot => Date.parse(String(slot?.updated_at))));
      return Number.isFinite(endedAt) ? { state: "ended", endedAt, detail: `the publisher container stopped at ${iso(endedAt)}` }
        : { state: "unknown", detail: "the stopped publisher container has no time" };
    }
    const instances = rows((await result(`/containers/dash/applications/${id}/instances?per_page=100`) as { instances?: unknown } | undefined)?.instances);
    // A stopped or failed placement has no process. Every other state can have one.
    const started = instances?.filter(row => {
      const status = (row.current_placement as { status?: { container_status?: unknown; health?: unknown } } | undefined)?.status;
      return !["stopped", "failed"].includes(String(status?.container_status ?? status?.health));
    }).map(row => Date.parse(String(row.created_at)));
    if (!started?.length || started.length >= 100 || started.some(time => !Number.isFinite(time))) {
      return { state: "unknown", detail: "the publisher instance list names no running container with a start time" };
    }
    const oldest = Math.min(...started);
    // The publisher has one instance, so the earlier one ended before this start.
    return oldest > leaseAt ? { state: "ended", endedAt: oldest, detail: `the publisher container was replaced at ${iso(oldest)}` }
      : { state: "current", detail: `a publisher container runs since ${iso(oldest)}, before the lease` };
  } catch (error) {
    return { state: "unknown", detail: error instanceof Error ? error.message : "the container read failed" };
  }
}

/** The publisher that takes the returned release must be the installed one. */
async function assertInstalledPublisher(get: (suffix: string) => Promise<unknown>, target: PublicationTarget, commitSha: string) {
  const settings = await get(`/workers/scripts/${target.publisherWorker}/settings`) as { result?: { bindings?: unknown } };
  const installed = rows(settings.result?.bindings)?.find(binding => binding.name === "PUBLICATION_COMMIT_SHA")?.text;
  if (installed !== commitSha) refuse(`The installed publisher is of ${installed ?? "no commit"}; the lease is of ${commitSha}. Install that publisher first`);
}

async function readDeployments(get: (suffix: string) => Promise<unknown>, workerName: string, predecessorDeploymentId: string | null,
  leaseAt: number, now: () => number): Promise<DeploymentRead> {
  const response = await get(`/workers/scripts/${workerName}/deployments`);
  const deployments = rows((response as { result?: { deployments?: unknown } } | null)?.result?.deployments);
  if (!deployments?.length) refuse("The Cloudflare deployment list is invalid");
  const active = projectApiDeploymentStatus(activeDeployment(response));
  if (active.deploymentId !== predecessorDeploymentId) {
    refuse(`The active deployment is ${active.deploymentId}; the lease predecessor is ${predecessorDeploymentId}. Run the normal reconciliation`);
  }
  for (const row of deployments) {
    const created = Date.parse(String(row.created_on));
    if (!Number.isFinite(created)) refuse("A Cloudflare deployment has no creation time");
    if (created >= leaseAt) refuse(`A deployment was made at ${iso(created)}, after the lease at ${iso(leaseAt)}. Run the normal reconciliation`);
  }
  return { readAt: iso(now()), activeDeploymentId: active.deploymentId, activeVersionId: active.versionId,
    activeCreatedOn: active.createdOn, deploymentsRead: deployments.length };
}

function releaseId(buildBatchId: string) {
  return /^cms-([A-Za-z0-9]{20})$/.exec(buildBatchId)?.[1] ?? refuse("The leased batch is not a release");
}
const releaseRequestRef = (firestore: Firestore, target: PublicationTarget, buildBatchId: string) =>
  firestore.collection(cloudReleaseCollection(target.serializerId)).doc(releaseId(buildBatchId));

async function giveLeaseBack({ firestore, target, buildBatchId, leaseToken, now, write }: {
  firestore: Firestore; target: PublicationTarget; buildBatchId: string; leaseToken: string; now: () => number; write: boolean;
}) {
  const queueId = releaseId(buildBatchId);
  const pointerRef = publicDeploymentRef(firestore), batchRef = publicBuildBatchRef(firestore, buildBatchId);
  const requestRef = releaseRequestRef(firestore, target, buildBatchId);
  const journalRef = firestore.doc(`cmsPublicationSerializerJournals/${target.serializerId}`);
  await firestore.runTransaction(async transaction => {
    const [pointerRow, batchRow, requestRow, journalRow, controlRow] = await transaction.getAll(pointerRef, batchRef, requestRef, journalRef,
      firestore.doc(RUNTIME_DOCUMENT_PATH));
    await assertNoReleaseWriterInTransaction({ firestore, transaction });
    const pointer = assertPublicDeploymentPointer(pointerRow.data());
    const batch = assertPublicDeploymentLeaseBatch(batchRow.data(), buildBatchId);
    if (pointer.leaseToken !== leaseToken || batch.leaseToken !== leaseToken || pointer.state !== batch.status) refuse("The lease changed");
    if (pointer.activeDeploymentId !== batch.predecessorDeploymentId || pointer.activeGeneration !== batch.predecessorGeneration ||
        pointer.activeCommitSha !== batch.predecessorCommitSha) refuse("The active deployment record is not the lease predecessor");
    const request = requestRow.data();
    if (!request || request.buildBatchId !== buildBatchId || request.commitSha !== batch.commitSha ||
        !["pending", "failed"].includes(request.status)) refuse("The release request does not match the lease");
    assertPublicationOwner(request, batch.runtime);
    const journal = journalRow.data();
    // A write of this lease that lands late serves the version that its next lease serves. So this release must be the next one.
    if (!journal?.job || journal.job.queueId !== queueId || journal.job.commitSha !== batch.commitSha ||
        !isDeepStrictEqual(journal.runtime, batch.runtime)) refuse("The publisher journal does not hold this release");
    const control = cloudCmsPublicationRuntimeControl(controlRow.data());
    if (control.commitSha !== batch.commitSha || control.serializerId !== target.serializerId) refuse("The publication control names another publisher");
    const nextPointer = assertPublicDeploymentPointer({ ...without(pointer, [...LEASE_FIELDS, "runtime", "candidateGeneration",
      "candidateBuildBatchId", "candidateCommitSha"]), state: "idle" });
    const nextBatch = assertPublicDeploymentLeaseBatch({ ...without(batch, LEASE_FIELDS), status: "ready" }, buildBatchId);
    if (planPublicDeploymentLeaseAcquisition(nextPointer, nextBatch).action !== "acquire") refuse("A newer release is eligible");
    if (!write) return;
    const timestamp = firebaseAdminRuntime.FieldValue.serverTimestamp();
    transaction.set(pointerRef, { ...nextPointer, updatedAt: timestamp });
    transaction.set(batchRef, nextBatch);
    transaction.update(requestRef, { status: "pending", attempts: 0, nextAttemptAt: now(), failureReason: null });
    const audit = { activeGeneration: pointer.activeGeneration, activeDeploymentId: pointer.activeDeploymentId };
    transaction.set(firestore.collection("admin_logs").doc(), { actorUid: "system:public-deployment", actorEmail: null,
      action: "public-deployment.return-lease", target: `system/publicDeployment/buildBatches/${buildBatchId}`,
      before: { state: pointer.state, ...audit, candidateGeneration: batch.generation, candidateBuildBatchId: buildBatchId },
      after: { state: "idle", ...audit, candidateGeneration: null, candidateBuildBatchId: null },
      source: "return-public-deployment-lease", timestamp, at: iso(now()) });
  }, write ? undefined : { readOnly: true });
}

/** Refuses in every state except a lease of the named batch with no deployment write. */
export async function returnPublicDeploymentLease({ firestore, cloudflareApiToken, target, buildBatchId, apply = false,
  requestJson = requestCloudflareJson, pause = () => new Promise(resolve => setTimeout(resolve, PAUSE_BETWEEN_READS_MS)),
  now = Date.now, report = () => {} }: {
  firestore: Firestore; cloudflareApiToken: string; target: PublicationTarget; buildBatchId: string; apply?: boolean;
  requestJson?: RequestJson; pause?: () => Promise<unknown>; now?: () => number; report?: (line: Record<string, unknown>) => void;
}) {
  const pointer = assertPublicDeploymentPointer((await publicDeploymentRef(firestore).get()).data());
  if (pointer.state === "idle") refuse("No deployment lease is held");
  if (pointer.candidateBuildBatchId !== buildBatchId) refuse(`The lease belongs to ${pointer.candidateBuildBatchId}, not to ${buildBatchId}`);
  const runtime = { owner: "cloudflare" as const, release: pointer.candidateCommitSha as string };
  const readLease = () => readPublicDeploymentReconciliationState(firestore, runtime, target);
  const state = await readLease();
  if (!state) refuse("The lease does not belong to the cloud publisher");
  const leaseAt = timestampMillis(state.lease.leaseAcquiredAt) as number;
  const get = (suffix: string) => requestJson({ url: workerApiPath(suffix), method: "GET", token: cloudflareApiToken });

  await assertInstalledPublisher(get, target, state.lease.commitSha);
  // An attempt writes its request when it claims it, before the lease, and when it ends.
  const requestWrittenAt = (await releaseRequestRef(firestore, target, buildBatchId).get()).updateTime?.toMillis() ?? 0;
  const writer: WriterState = requestWrittenAt > leaseAt
    ? { state: "ended", endedAt: requestWrittenAt, detail: `the attempt that took the lease ended at ${iso(requestWrittenAt)}` }
    : await readPublisherContainer(get, target, leaseAt);
  report({ check: "writer", state: writer.state, detail: writer.detail });
  if (writer.state === "current") refuse(`The container that took the lease can still hold the write: ${writer.detail}. Wait for its attempt to end`);
  if (apply && writer.state === "unknown") {
    refuse(`It cannot tell whether the container that took the lease can still hold the write: ${writer.detail}. Supply a token with Containers read`);
  }
  const ended = Math.max(leaseAt, writer.endedAt ?? 0);
  if (now() - ended < MINIMUM_ENDED_MS) {
    refuse(`The lease is ${seconds(now() - leaseAt)} seconds old and its last possible write was ${seconds(now() - ended)} seconds ago. This may run at ${iso(ended + MINIMUM_ENDED_MS)}`);
  }
  const read = () => readDeployments(get, target.workerName, state.lease.predecessorDeploymentId, leaseAt, now);
  const first = await read();
  report({ check: "first deployment read", ...first });
  await pause();
  const second = await read();
  report({ check: "second deployment read", ...second });
  if (!isDeepStrictEqual({ ...first, readAt: null }, { ...second, readAt: null })) refuse("The deployment list changed between the two reads");
  // A container that started and took this work again would hold another lease.
  if ((await readLease())?.lease.leaseToken !== state.lease.leaseToken) refuse("The lease changed");
  await giveLeaseBack({ firestore, target, buildBatchId, leaseToken: state.lease.leaseToken, now, write: apply });
  return { outcome: apply ? "returned" : "dry-run", buildBatchId, generation: state.lease.generation, commitSha: state.lease.commitSha,
    leaseAcquiredAt: iso(leaseAt), predecessorDeploymentId: state.lease.predecessorDeploymentId, writer: writer.state };
}

export function parseReturnLeaseArguments(args: string[]) {
  const [flag, environment, buildBatchId, apply] = args;
  if (![3, 4].includes(args.length) || flag !== "--environment" || !["production", "development"].includes(environment) ||
      !/^cms-[A-Za-z0-9]{20}$/.test(buildBatchId) || args.length === 4 && apply !== "--apply") {
    refuse("Usage: return-public-deployment-lease.ts --environment <production|development> <leased-build-batch-id> [--apply]");
  }
  return { target: publicationTarget(environment as "production" | "development"), buildBatchId, apply: args.length === 4 };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let app: App | undefined;
  try {
    const input = parseReturnLeaseArguments(args);
    assertProductionFirestoreRouting(process.env);
    const cloudflareApiToken = parseCloudflareToken(readFileSync(3, "utf8"));
    const credential = parseCmsPublicationFirebaseServiceAccount(readFileSync(4, "utf8"), input.target.projectId);
    app = firebaseAdminRuntime.initializeApp({ credential: firebaseAdminRuntime.cert(credential), projectId: input.target.projectId },
      "return-public-deployment-lease");
    const firestore = firebaseAdminRuntime.getFirestore(app);
    const print = (line: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify(line)}\n`); };
    print(await returnPublicDeploymentLease({ firestore, cloudflareApiToken, ...input, report: print }));
  } catch (error) {
    process.stderr.write(`Lease return refused: ${error instanceof Error && error.name !== "FirebaseAppError" && !("code" in error)
      ? error.message : "The operation failed; nothing was confirmed. Read the pointer before another attempt"}\n`);
    process.exitCode = 1;
  } finally {
    if (app) await firebaseAdminRuntime.deleteApp(app);
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) void main();
