import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseChange } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import type { PairViewStore } from "./public-release-pair-view-storage";
import protocol from "../../functions/lib/public-release-pair.js";
import owner from "../../functions/lib/public-release-switch-code-owner.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { captureHistoricalPublicReleasePairInput } from "./public-release-pair-source-owner";
import { corruptEvidence } from "./public-release-original-work-recovery";
import { existingReplayView, PublicationActivationError } from "./public-release-pair-content-activation";
import { replayPublicReleasePairToHead } from "./public-release-pair-log-replay";
import { advancePublicReleaseSwitchCodeHead, SwitchCodeHeadPendingError } from "./public-release-switch-code-head";
import activation from "../../functions/lib/public-release-content-activation.js";

type Completed = { identity: PairTaskIdentity; claimDigest: string; manifestDigest: string; signal?: AbortSignal };
type Capture = Pick<Parameters<typeof captureHistoricalPublicReleasePairInput>[0], "providerStore" | "codeStore" | "resourceRequest" | "codePackArtifacts">;
type Options = { enabled?: boolean; firestore: Firestore; pair: PublicReleasePair; store: PairViewStore; capture?: Capture; clock?: () => number;
  captureStore?(operationId: string, lease: string): PairViewStore; replayStore?(operationId: string): PairViewStore };
const hash = protocol.publicReleaseDigest, same = (a: unknown, b: unknown) => hash(a) === hash(b);
function refuse(): never { throw new protocol.PublicReleaseProtocolError(); }

/** Default off. The exact selected switch event is its durable discovery hint;
 * no publish admission, original queue, claim or terminal fact is fabricated. */
export function createPublicReleaseSwitchCodeContinuation(options: Options): {
  beforePoll?(input: { signal?: AbortSignal }): Promise<void>; completed?(input: Completed): Promise<void>;
  retryCompleted?(taskId: string, signal?: AbortSignal): Promise<void>;
} {
  if (options.enabled !== true) return {};
  const { firestore, store } = options, pair = protocol.parsePublicReleasePair(options.pair), clock = options.clock ?? Date.now;
  work.assertPublicReleasePairDatabase(firestore, pair);
  const base = work.publicReleasePairPath(pair.pairId);
  const selected = (transaction: any, operationId?: string) => owner.readSelectedSwitchCodeSourceInTransaction({ firestore, transaction, pair, operationId });
  const defer = async (operationId: string, error: unknown, leaseToken?: string) => {
    const refused = corruptEvidence(error);
    const predecessorFailed = error instanceof PublicationActivationError && error.code === "content-activation-predecessor-failed";
    await firestore.runTransaction(async transaction => {
      const [fence, billing, pins] = await transaction.getAll(firestore.doc("system/publicDeployment/releaseWriter/fence"),
        firestore.doc("system/billing"), firestore.doc("system/cmsPublicationRuntime"));
      const runtime = pins.data();
      if (fence.exists || billing.data()?.disabled === true || runtime?.phase !== "ready" || runtime.commitSha !== pair.commitSha ||
          runtime.cloud?.phase !== "ready" || runtime.cloud.commitSha !== pair.commitSha) return;
      const current = await selected(transaction, operationId); if (!current) return;
      const ref = firestore.doc(owner.codePendingPath(pair, operationId)), row = await transaction.get(ref); if (!row.exists) return;
      const pending = owner.parseSwitchCodePending(row.data(), pair, current);
      if (pending.nextAttemptAt === null) return;
      if (leaseToken ? pending.lease?.token !== leaseToken : pending.lease && pending.lease.until > clock()) return;
      const failures = Math.min(3, pending.failures + (refused ? 1 : 0));
      transaction.set(ref, { ...pending, lease: null, failures, nextAttemptAt: failures === 3 || predecessorFailed ? null : clock() + 30_000,
        lastFailure: predecessorFailed ? "replay-predecessor-failed" : refused ? "source-refused" : error instanceof SwitchCodeHeadPendingError || error instanceof activation.ContentActivationConflictError
          ? "replay-pending" : "temporarily-unavailable" });
    });
  };
  const resolveView = (entry: PublicReleaseChange) => existingReplayView(firestore, pair, entry.operationId, entry.sequence);
  const completed = async (input: Completed) => {
    if (input.identity.kind !== "recovery") return;
    const operationId = input.identity.sourceOperationId;
    const current = await firestore.runTransaction(transaction => selected(transaction, operationId), { readOnly: true });
    if (!current) return;
    if (!same(current.scope, { kind: input.identity.kind, sourceOperationId: operationId, sourceVersion: input.identity.sourceVersion,
      snapshotDigest: input.identity.snapshotDigest, contextSequence: input.identity.contextSequence })) refuse();
    try {
      const acceptedDue = await firestore.collection(`${base}/work`).where("acceptedDueAt", "<=", clock()).limit(1).get();
      if (!acceptedDue.empty) return; // durable pending row is retried after staff work
      const ownStore = options.replayStore?.(operationId) ?? store;
      await firestore.runTransaction(transaction => work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair,
        taskId: hash(input.identity), claimDigest: input.claimDigest, manifestDigest: input.manifestDigest }), { readOnly: true });
      const replayed = await replayPublicReleasePairToHead({ firestore, store: ownStore, pair, resolveView, signal: input.signal });
      if (replayed.status === "pending") throw new SwitchCodeHeadPendingError();
      const result = await advancePublicReleaseSwitchCodeHead({ firestore, store: ownStore, pair, ...input });
      if (result.status !== "activated") return;
      await firestore.runTransaction(async transaction => {
        const actual = await selected(transaction, operationId); if (!actual) return;
        const ref = firestore.doc(owner.codePendingPath(pair, operationId));
        const row = await transaction.get(ref);
        if (row.exists) { owner.parseSwitchCodePending(row.data(), pair, actual); transaction.delete(ref); }
      });
    } catch (error) { input.signal?.throwIfAborted(); await defer(operationId, error); }
  };
  const beforePoll = async ({ signal }: { signal?: AbortSignal }) => {
    signal?.throwIfAborted();
    const reserved = await firestore.runTransaction(async transaction => {
      // Qualification/CODE maintenance yields to admitted staff tasks. A
      // release must not capture an entire H ahead of the normal pair drain.
      const acceptedDue = await transaction.get(firestore.collection(`${base}/work`).where("acceptedDueAt", "<=", clock()).limit(1));
      if (!acceptedDue.empty) return null;
      const current = await selected(transaction); if (!current) return null;
      const operationId = current.scope.sourceOperationId, ref = firestore.doc(owner.codePendingPath(pair, operationId));
      const [row, activated] = await transaction.getAll(ref, firestore.doc(`${base}/switchCodeActivations/${operationId}`));
      if (activated.exists) {
        await owner.assertSwitchCodeActivationInTransaction({ firestore, transaction, pair, owner: current, value: activated.data() });
        if (row.exists) {
          owner.parseSwitchCodePending(row.data(), pair, current); transaction.delete(ref);
        }
        return null;
      }
      const initial = { schemaVersion: 2, kind: "switch-code-pending", operationId, pairDigest: hash(pair), scope: current.scope,
        sourceDigest: hash(current.source), lease: null, nextAttemptAt: 0, failures: 0, lastFailure: null };
      const pending = row.exists ? owner.parseSwitchCodePending(row.data(), pair, current) : initial;
      if (pending.nextAttemptAt === null || pending.nextAttemptAt! > clock() || pending.lease && pending.lease.until > clock()) return null;
      const lease = { token: randomUUID(), until: clock() + 180_000 };
      transaction.set(ref, { ...pending, lease });
      return { current, lease, operationId, alreadyActivated: false };
    });
    if (!reserved) return;
    // Match original-work recovery's operation deadline below its lease.
    // A timeout remains retryable and must not quarantine immutable source.
    const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
    try {
      const { current, operationId, lease } = reserved;
      const captureStore = options.captureStore?.(operationId, lease.token) ?? store;
      // The historical owner also repairs bookkeeping after H committed but
      // its outbox/search/media transaction did not. A binding alone is not
      // completion of that owner, including on an ambiguous capture response.
      const captured = await captureHistoricalPublicReleasePairInput({ ...options.capture, firestore, store: captureStore, pair,
        kind: "recovery", sourceOperationId: operationId, signal: operationSignal });
      operationSignal.throwIfAborted();
      const queued = await firestore.runTransaction(async transaction => {
        const actual = await selected(transaction, operationId); if (!actual || !same(actual.scope, current.scope)) return null;
        const at = clock(), pendingRow = await transaction.get(firestore.doc(owner.codePendingPath(pair, operationId)));
        if (!pendingRow.exists) return null;
        const pending = owner.parseSwitchCodePending(pendingRow.data(), pair, actual);
        // Slow trailing capture bookkeeping or another lease holder is busy,
        // not corrupt source. Preserve its identity and refusal counter.
        if (pending.nextAttemptAt === null || pending.lease?.token !== lease.token || pending.lease.until <= at) return null;
        operationSignal.throwIfAborted();
        if (!reserved.alreadyActivated) await owner.assertSelectedSwitchCodeCaptureLeaseInTransaction({ firestore, transaction, pair,
          operationId, token: lease.token, now: at });
        const task = await work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair,
          input: { ...current.scope, inputManifestDigest: captured.receipt.inputManifestDigest } as any });
        // A new enqueue wrote only the new work row. Completed tasks do not write.
        const taskState = task.task as { status: string; nextAttemptAt: number | null };
        if (taskState.status === "failed" && taskState.nextAttemptAt === null) {
          transaction.update(firestore.doc(owner.codePendingPath(pair, operationId)), {
            lease: null, nextAttemptAt: null, failures: 3, lastFailure: "work-failed" });
          return null;
        }
        if (taskState.status !== "complete") {
          transaction.update(firestore.doc(owner.codePendingPath(pair, operationId)), { lease: null, nextAttemptAt: clock() + 30_000 });
          return null;
        }
        const receipt = (await transaction.get(firestore.doc(`${base}/receipts/${task.taskId}`))).data()!;
        if (!reserved.alreadyActivated) transaction.update(firestore.doc(owner.codePendingPath(pair, operationId)), { lease: null });
        return { identity: receipt.identity as PairTaskIdentity, claimDigest: receipt.claimDigest as string, manifestDigest: receipt.manifestDigest as string, signal };
      });
      if (queued) await completed(queued);
    } catch (error) { signal?.throwIfAborted(); await defer(reserved.operationId, error, reserved.lease.token); }
  };
  const retryCompleted = async (taskId: string, signal?: AbortSignal) => {
    if (!/^[a-f0-9]{64}$/.test(taskId)) refuse();
    signal?.throwIfAborted();
    // Called only after the original executor's explicit G repair succeeds.
    // Independently prove its completed identity before reopening CODE debt;
    // an arbitrary task id or a caller's success flag cannot clear a stop.
    const reopened = await firestore.runTransaction(async transaction => {
      const current = await selected(transaction); if (!current) return false;
      const repaired = (await transaction.get(firestore.doc(`${base}/receipts/${taskId}`))).data();
      if (!repaired) refuse();
      const verified = await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair,
        taskId, claimDigest: repaired.claimDigest, manifestDigest: repaired.manifestDigest });
      const ref = firestore.doc(owner.codePendingPath(pair, current.scope.sourceOperationId)), row = await transaction.get(ref);
      if (!row.exists) return false;
      const pending = owner.parseSwitchCodePending(row.data(), pair, current);
      if (pending.lease && pending.lease.until > clock()) return false;
      if (pending.nextAttemptAt === null && pending.lastFailure !== "replay-predecessor-failed" &&
          verified.identity.sourceOperationId !== current.scope.sourceOperationId) return false;
      signal?.throwIfAborted();
      if (pending.nextAttemptAt === null) transaction.set(ref, { ...pending, failures: 0, lastFailure: null, lease: null, nextAttemptAt: 0 });
      return true;
    });
    if (reopened) await beforePoll({ signal });
  };
  return { beforePoll, completed, retryCompleted };
}
