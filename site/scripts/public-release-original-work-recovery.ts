import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import admission from "../../functions/lib/public-release-admission.js";
import work from "../../functions/lib/public-release-pair-work.js";
import terminal from "../../functions/lib/public-release-terminal.js";
import type { PairAdmission } from "../../functions/lib/public-release-admission";
import type { CompletedPairPublicationExecution } from "../../functions/lib/public-release-terminal";
import { captureHistoricalPublicReleasePairInput, HistoricalInputError } from "./public-release-pair-source-owner";
import { PairCodePackError } from "./public-release-pair-code-pack";
import { PairSourceInputsError } from "./public-release-pair-source-inputs";
import { PairSearchInputsError } from "./public-release-pair-search-inputs";
import { PairSourceCensusError } from "./public-release-pair-source-census";
import sourceLimits from "../../functions/lib/public-release-source-limits.js";
import { openPublicReleasePairInput, publicReleasePairSourceInputPath } from "./public-release-pair-input-storage";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { exact } from "./public-release-pair-reader-contract";

const LEASE_MS = 180_000, OPERATION_MS = 120_000, POLL_MS = 30_000, FAILURE_LIMIT = 3;
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const validTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const validDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const refuse = (): never => { throw new protocol.PublicReleaseProtocolError(); };
const evidenceShape = (value: unknown, fields: string[]) => { try { exact(value, fields); } catch { refuse(); } };
// Charge only recognized immutable-evidence failures. RPC storage outages,
// SDK contention, fetch TypeErrors and provider timeouts retain retryability.
export const corruptEvidence = (error: any) => error instanceof protocol.PublicReleaseProtocolError ||
  error?.name === "PublicReleaseProtocolError" && error?.status === 409 ||
  error instanceof work.PairExecutionError && ["input-unavailable", "byte-mismatch"].includes(error.code) ||
  error instanceof HistoricalInputError || error instanceof PairCodePackError || error instanceof PairSourceInputsError ||
  error instanceof PairSearchInputsError || error instanceof PairSourceCensusError ||
  sourceLimits.isHistoricalSourceLimitError(error) && ["changes", "rootFiles", "censusBytes"].includes(error.details.metric);
type Pending = { schemaVersion: 2; operationId: string; admissionDigest: string; nextAttemptAt?: number | null;
  recoveryLease?: { token: string; until: number } | null; recoveryFailures?: number; recoveryFailure?: string | null };
type CaptureOptions = Pick<Parameters<typeof captureHistoricalPublicReleasePairInput>[0],
  "providerStore" | "codeStore" | "resourceRequest" | "codePackArtifacts">;
export type OriginalWorkRecoveryOptions = { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; operationId: string;
  capture?: CaptureOptions; now?: () => number; signal?: AbortSignal;
  storeForRecovery?(owner: Readonly<{ operationId: string; token: string }>): PairViewStore };
type Options = OriginalWorkRecoveryOptions;
type Reservation = { admission: PairAdmission; pair: PublicReleasePair; token: string;
  retryStamp: number | null; failures: number };
export type OriginalPublicationRecoveryResult = Readonly<{ operationId: string;
  status: "missing" | "not-due" | "busy" | "paused" | "quarantined" | "retry" | "queued" | "running" | "rendered";
  taskId?: string; execution?: CompletedPairPublicationExecution }>;

function pending(value: any, operationId: string): Pending {
  if (value?.schemaVersion !== 2 || value.operationId !== operationId || !validDigest(value.admissionDigest) ||
      value.nextAttemptAt !== undefined && value.nextAttemptAt !== null && !validTime(value.nextAttemptAt) ||
      value.recoveryFailures !== undefined && (!validTime(value.recoveryFailures) || value.recoveryFailures > FAILURE_LIMIT) ||
      value.recoveryLease !== undefined && value.recoveryLease !== null &&
      (typeof value.recoveryLease.token !== "string" || !/^[a-f0-9-]{36}$/.test(value.recoveryLease.token) || !validTime(value.recoveryLease.until))) refuse();
  return value;
}
const scopeOf = (accepted: PairAdmission) => ({ kind: "accepted" as const, sourceOperationId: accepted.operationId,
  sourceVersion: accepted.source.sourceVersion, snapshotDigest: accepted.source.snapshotDigest, contextSequence: accepted.changeSequence });
const pendingPath = (options: Options) => admission.publicationPendingPath(options.pair.pairId, options.operationId);
const retryStamp = (queue: any): number | null => queue.settingsRetryAt?.toMillis?.() ?? null;

async function reserve(options: Options, token: string): Promise<Reservation | OriginalPublicationRecoveryResult> {
  const { firestore, operationId } = options, now = (options.now ?? Date.now)();
  return firestore.runTransaction(async transaction => {
    const [pendingRow, markerRow, acceptedRow, queueRow, billing] = await transaction.getAll(firestore.doc(pendingPath(options)),
      firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`),
      firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`), firestore.doc(`cmsPublishQueue/${operationId}`), firestore.doc("system/billing"));
    if (!pendingRow.exists) return { operationId, status: "missing" as const };
    const original = pending(pendingRow.data(), operationId), accepted = admission.parseAdmission(acceptedRow.data()), queue = queueRow.data()!;
    admission.assertQueue(queue, accepted);
    if (accepted.operationId !== operationId || original.admissionDigest !== protocol.publicReleaseDigest(accepted) ||
        !same(protocol.publicReleasePairReference(options.pair), accepted.pair) ||
        protocol.publicReleaseDigest(options.pair) !== accepted.pairDigest) refuse();
    if (!markerRow.exists) {
      await terminal.assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction, operationId, admissionDigest: original.admissionDigest });
      transaction.delete(pendingRow.ref);
      return { operationId, status: "missing" as const };
    }
    evidenceShape(markerRow.data(), ["schemaVersion", "operationId", "admissionDigest"]);
    if (markerRow.data()?.schemaVersion !== 2 || markerRow.data()?.operationId !== operationId || markerRow.data()?.admissionDigest !== original.admissionDigest) refuse();
    if (original.nextAttemptAt === null || queue.status === "failed") return { operationId, status: "quarantined" as const };
    if ((original.nextAttemptAt ?? 0) > now) return { operationId, status: "not-due" as const };
    if (original.recoveryLease && original.recoveryLease.until > now) return { operationId, status: "busy" as const };
    if (billing.data()?.disabled === true) return { operationId, status: "paused" as const };
    const pair = protocol.parsePublicReleasePair((await transaction.get(firestore.doc(work.publicReleasePairPath(accepted.pair.pairId)))).data());
    work.assertPublicReleasePairDatabase(firestore, pair);
    if (protocol.publicReleaseDigest(pair) !== accepted.pairDigest || !same(protocol.publicReleasePairReference(pair), accepted.pair)) refuse();
    await admission.assertRetainedPairAdmissionInTransaction({ firestore, transaction, pair, scope: scopeOf(accepted) });
    transaction.update(pendingRow.ref, { recoveryLease: { token, until: now + LEASE_MS } });
    return { admission: accepted, pair, token, retryStamp: retryStamp(queue), failures: original.recoveryFailures ?? 0 };
  });
}

async function originalInput(options: Options, reservation: Reservation, signal: AbortSignal) {
  const { firestore, store } = options, { pair } = reservation, accepted = reservation.admission, scope = scopeOf(accepted);
  const row = await firestore.doc(publicReleasePairSourceInputPath(pair, scope)).get();
  if (row.exists) {
    const binding = row.data()!;
    evidenceShape(binding, ["schemaVersion", "pairDigest", "scope", "source", "cursor", "inputManifestDigest"]);
    if (binding.schemaVersion !== 2 || binding.pairDigest !== accepted.pairDigest || !same(binding.scope, scope)) refuse();
    // Reuse the exact original H. An already-captured ordinary input must not
    // be replaced with a new historical pack or a current-source projection.
    return openPublicReleasePairInput({ firestore, store, pair,
      identity: { schemaVersion: 2, pair: accepted.pair, ...scope, inputManifestDigest: binding.inputManifestDigest },
      expectedSource: binding.source, expectedCursor: binding.cursor, signal });
  }
  // The accepted historical owner checks the original admission and rebuilds
  // that original cursor, even after another source or pair becomes current.
  return captureHistoricalPublicReleasePairInput({ ...options.capture, firestore, store, pair,
    sourceOperationId: accepted.operationId, kind: "accepted", signal });
}

/** Durable discovery for original accepted computation. This queues/reopens
 * work on its original pair; it never moves a claim, selects a head, confirms
 * public bytes, clears a pending marker or decrements the admission census.
 * Install its bounded pass with the private recovery owner at adoption. */
export async function recoverOriginalPublicReleaseWork(options: Options): Promise<OriginalPublicationRecoveryResult> {
  const { firestore, operationId } = options, now = options.now ?? Date.now;
  protocol.parsePublicReleasePair(options.pair);
  work.assertPrivatePairResources(options.pair);
  if (typeof operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId) || !validTime(now())) refuse();
  options.signal?.throwIfAborted();
  const reserved = await reserve(options, randomUUID());
  if ("status" in reserved) return reserved;
  const signal = AbortSignal.any([AbortSignal.timeout(OPERATION_MS), ...(options.signal ? [options.signal] : [])]);
  try {
    const store = options.storeForRecovery?.({ operationId, token: reserved.token }) ?? options.store;
    const captured = await originalInput({ ...options, store }, reserved, signal);
    signal.throwIfAborted();
    const accepted = reserved.admission, pair = reserved.pair;
    if (!same(captured.receipt.scope, scopeOf(accepted))) refuse();
    return await firestore.runTransaction(async transaction => {
      const [row, queueRow] = await transaction.getAll(firestore.doc(pendingPath(options)), firestore.doc(`cmsPublishQueue/${operationId}`));
      if (!row.exists) return { operationId, status: "missing" as const };
      const current = pending(row.data(), operationId), queue = queueRow.data()!;
      if (current.recoveryLease?.token !== reserved.token || current.recoveryLease.until <= now()) return { operationId, status: "busy" as const };
      admission.assertQueue(queue, accepted);
      await admission.assertRetainedPairAdmissionInTransaction({ firestore, transaction, pair, scope: scopeOf(accepted) });
      const queued = await work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair,
        input: { ...scopeOf(accepted), inputManifestDigest: captured.receipt.inputManifestDigest } });
      if (!queued.task || typeof queued.task !== "object") refuse();
      const task = queued.task as Record<string, unknown>;
      const identity = { schemaVersion: 2, pair: accepted.pair, ...scopeOf(accepted), inputManifestDigest: captured.receipt.inputManifestDigest };
      if (!same(task.identity, identity) || queued.taskId !== protocol.publicReleaseDigest(identity) ||
          typeof task.status !== "string" || !["pending", "running", "failed", "complete"].includes(task.status) ||
          task.nextAttemptAt !== null && !validTime(task.nextAttemptAt)) refuse();
      // A new enqueue writes inside its SDK owner. Only an existing completed
      // task needs these further reads; that branch has made no writes yet.
      let execution: CompletedPairPublicationExecution | undefined;
      if (task.status === "complete") {
        const receiptRow = await transaction.get(firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/receipts/${queued.taskId}`));
        const receipt = receiptRow.data();
        const verified = await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair,
          taskId: queued.taskId, claimDigest: receipt?.claimDigest, manifestDigest: receipt?.manifestDigest });
        execution = terminal.parseCompletedPairPublicationExecution({ schemaVersion: 2, pair: accepted.pair, pairDigest: accepted.pairDigest,
          identity: verified.identity, taskId: queued.taskId, inputManifestDigest: captured.receipt.inputManifestDigest,
          claimDigest: verified.claimDigest, manifestDigest: verified.manifestDigest });
      }
      if (queue.execution !== null && (!execution || !same(queue.execution, execution))) refuse();
      signal.throwIfAborted();
      const exhausted = task.status === "failed" && task.nextAttemptAt === null;
      const status = exhausted ? "quarantined" as const : execution ? "rendered" as const : task.status === "running" ? "running" as const : "queued" as const;
      transaction.update(row.ref, { recoveryLease: null, recoveryFailures: 0,
        recoveryFailure: exhausted ? "original-work-quarantined" : null,
        nextAttemptAt: exhausted ? null : retryStamp(queue) !== reserved.retryStamp ? 0 : now() + POLL_MS });
      if (execution && queue.execution === null) transaction.update(queueRow.ref, { execution });
      if (exhausted) transaction.update(queueRow.ref, { status: "failed", pendingRecoveryFailure: "original-work-quarantined" });
      return { operationId, status, taskId: queued.taskId, ...(execution ? { execution } : {}) };
    });
  } catch (error: any) {
    const transportFailure = options.signal?.aborted || signal.aborted || !corruptEvidence(error);
    return firestore.runTransaction(async transaction => {
      const [row, marker, queue, billing] = await transaction.getAll(firestore.doc(pendingPath(options)),
        firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`), firestore.doc(`cmsPublishQueue/${operationId}`), firestore.doc("system/billing"));
      if (!row.exists) return { operationId, status: "missing" as const };
      if (!marker.exists) {
        await terminal.assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction, operationId,
          admissionDigest: protocol.publicReleaseDigest(reserved.admission) });
        transaction.delete(row.ref);
        return { operationId, status: "missing" as const };
      }
      const current = pending(row.data(), operationId);
      if (current.recoveryLease?.token !== reserved.token || current.recoveryLease.until <= now()) return { operationId, status: "busy" as const };
      // Work/capture owners re-read billing after the reservation. A pause in
      // that interval is operational, not evidence that original H is corrupt.
      const paused = billing.data()?.disabled === true, deferred = transportFailure || paused;
      const failures = (current.recoveryFailures ?? 0) + (deferred ? 0 : 1), exhausted = failures >= FAILURE_LIMIT;
      transaction.update(row.ref, { recoveryLease: null, recoveryFailures: failures, recoveryFailure: deferred ? "temporarily-unavailable" : "original-input-unavailable",
        nextAttemptAt: exhausted ? null : now() + POLL_MS });
      if (exhausted && ["pending", "publishing", "failed"].includes(queue.data()?.status))
        transaction.update(queue.ref, { status: "failed", pendingRecoveryFailure: "original-input-unavailable" });
      return { operationId, status: exhausted ? "quarantined" as const : paused ? "paused" as const : "retry" as const };
    });
  }
}

/** One bounded recovery tick. A due row survives process loss and no private
 * wake is needed to rediscover its original operation. All actions above are
 * idempotent and retain the original queue, pair and input identity. */
export async function recoverDueOriginalPublicReleaseWork(options: Omit<Options, "operationId"> & { limit?: number }) {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) refuse();
  const rows = await options.firestore.collection(`${work.publicReleasePairPath(options.pair.pairId)}/publicationPending`)
    .where("nextAttemptAt", "<=", (options.now ?? Date.now)()).limit(limit).get();
  const results: OriginalPublicationRecoveryResult[] = [];
  for (const row of rows.docs) {
    options.signal?.throwIfAborted();
    try { results.push(await recoverOriginalPublicReleaseWork({ ...options, operationId: row.id })); }
    catch (error: any) {
      options.signal?.throwIfAborted();
      if (!corruptEvidence(error)) {
        results.push({ operationId: row.id, status: "retry" }); continue;
      }
      // A broken admission cannot starve the bounded due query. Quarantine
      // only its recovery metadata; retain its marker, queue and census debt.
      const parked = await options.firestore.runTransaction(async transaction => {
        const current = (await transaction.get(row.ref)).data();
        if (!current) return "missing" as const;
        if (current.recoveryLease?.until > (options.now ?? Date.now)()) return "busy" as const;
        transaction.update(row.ref, { nextAttemptAt: null, recoveryLease: null, recoveryFailure: "original-admission-unavailable" });
        return "quarantined" as const;
      });
      results.push({ operationId: row.id, status: parked });
    }
  }
  return results;
}
