import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import type { PairViewStore } from "./public-release-pair-view-storage";
import type { createPublicReleasePairExecutor } from "./public-release-pair-executor";
import { handoffPublicReleasePairActivation, recoverPublicReleasePairActivations,
  retryPublicReleasePairActivation, activationOutboxPath, type PairPublicationActivation } from "./public-release-pair-activation-outbox";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import admission from "../../functions/lib/public-release-admission.js";
import terminal from "../../functions/lib/public-release-terminal.js";
import holds from "../../functions/lib/public-release-rehearsal-hold.js";
import activation from "../../functions/lib/public-release-content-activation.js";
import { recoverOriginalPublicReleaseWork, recoverDueOriginalPublicReleaseWork,
  type OriginalWorkRecoveryOptions } from "./public-release-original-work-recovery";
import { activateStagedPublicReleasePairPublication } from "./public-release-pair-content-activation";
import { publicReleaseOwnerWriteStore } from "./public-release-owner-write-transport";
import { preparePublicReleasePublicationTerminal, preparePublicReleasePublicationSupersession,
  settlePreparedPublicReleasePublication, PublicReleaseTerminalPendingError } from "./public-release-publication-terminal";

type TerminalOptions = Parameters<typeof preparePublicReleasePublicationTerminal>[0];
type Options = { enabled?: boolean; firestore: Firestore; pair: PublicReleasePair; store: PairViewStore;
  ingress: TerminalOptions["ingress"]; fieldValues: TerminalOptions["fieldValues"];
  capture?: OriginalWorkRecoveryOptions["capture"]; clock?: () => number };
type Completed = { identity: PairTaskIdentity; claimDigest: string; manifestDigest: string; signal?: AbortSignal };
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function refuse(): never { throw new protocol.PublicReleaseProtocolError(); }
export function originalPublicReleaseRetryDelay(deferrals: number) {
  if (!Number.isInteger(deferrals) || deferrals < 1 || deferrals > 16) refuse();
  return Math.min(300_000, 1_000 * 2 ** (deferrals - 1));
}

/** Install only in the private, explicitly adopted pair runtime. The original
 * queue, admission and completed claim remain authoritative across every wake.
 * This supplies no timer, replacement claim, public route or cross-pair writer.
 */
export function createOriginalPublicReleaseContinuation(options: Options): {
  publication?: PairPublicationActivation;
  beforePoll?(input: { signal?: AbortSignal }): Promise<void>;
  completed?(input: Completed): Promise<void>;
  retryCompleted?(input: Completed): Promise<void>;
} {
  if (options.enabled !== true) return {};
  const { firestore, ingress, fieldValues, store, capture } = options, clock = options.clock ?? Date.now;
  const pair = protocol.parsePublicReleasePair(options.pair), pairDigest = protocol.publicReleaseDigest(pair);
  work.assertPrivatePairResources(pair);
  const ownStore = (operationId: string, recoveryLease?: string) => publicReleaseOwnerWriteStore({ pair, operationId, recoveryLease });
  const recovery = { firestore, pair, store, capture, now: clock,
    storeForRecovery: ({ operationId, token }: { operationId: string; token: string }) => ownStore(operationId, token) };
  const adopted = async () => {
    const [root, control, billing] = await firestore.getAll(firestore.doc("system/publicDeployment"),
      firestore.doc(`${admission.ADMISSIONS}/controls/adoption`), firestore.doc("system/billing"));
    if (root.data()?.schemaVersion !== 2 || control.data()?.enabled !== true || billing.data()?.disabled === true) return false;
    protocol.parseStoredPublicReleaseSelector(root.data());
    if (control.data()?.schemaVersion !== 2 || Object.keys(control.data()!).sort().join(",") !== "enabled,schemaVersion") refuse();
    await work.readPublicReleasePairWork({ firestore, pair, now: clock() });
    return true;
  };
  const publication: PairPublicationActivation = { async activate(input) {
    if (!same(input.pair, pair)) refuse();
    if (!await adopted()) throw new activation.ContentActivationConflictError();
    return activateStagedPublicReleasePairPublication({ ...input, store: ownStore(input.identity.sourceOperationId) });
  } };
  const defer = async (operationId: string, failure: string, refused = false, nextAttemptAt?: number | null) => {
    const ref = firestore.doc(admission.publicationPendingPath(pair.pairId, operationId));
    await firestore.runTransaction(async transaction => {
      const [row, marker] = await transaction.getAll(ref, firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`));
      if (!row.exists || !marker.exists) return;
      const current = row.data()!;
      if (current.schemaVersion !== 2 || current.operationId !== operationId || current.admissionDigest !== marker.data()?.admissionDigest) refuse();
      if (current.nextAttemptAt === null || current.recoveryLease?.until > clock()) return;
      const previous = current.continuationFailures ?? 0;
      if (!Number.isInteger(previous) || previous < 0 || previous > 3) refuse();
      const failures = Math.min(3, previous + (refused ? 1 : 0));
      const previousDeferrals = current.continuationDeferrals ?? 0;
      if (!Number.isInteger(previousDeferrals) || previousDeferrals < 0 || previousDeferrals > 16) refuse();
      const deferrals = Math.min(16, (current.continuationLastFailure === failure ? previousDeferrals : 0) + 1);
      const retryAt = clock() + originalPublicReleaseRetryDelay(deferrals);
      transaction.update(ref, { nextAttemptAt: failures >= 3 || nextAttemptAt === null ? null : Math.max(retryAt, nextAttemptAt ?? 0),
        continuationFailures: failures, continuationDeferrals: deferrals, continuationLastFailure: failure, recoveryFailure: failure });
    });
  };
  const supersede = async (operationId: string, signal?: AbortSignal) => {
    const accepted = admission.parseAdmission((await firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`).get()).data());
    if (accepted.operationId !== operationId || accepted.pairDigest !== pairDigest || !same(accepted.pair, protocol.publicReleasePairReference(pair))) refuse();
    const current = (await firestore.doc(admission.ownerPath(accepted.source)).get()).data();
    if (!current || current.operationId === operationId) return false;
    // Absence of a successor FACT is normal in-flight work. Do not feed its
    // not-yet-populated execution into a codec or charge an evidence refusal.
    if (!(await firestore.doc(`${terminal.TERMINAL_RECEIPTS}/${current.operationId}`).get()).exists)
      throw new PublicReleaseTerminalPendingError();
    const proof = await preparePublicReleasePublicationSupersession({ firestore, store, ingress, fieldValues, operationId,
      successorOperationId: current.operationId, signal });
    await settlePreparedPublicReleasePublication({ firestore, proof });
    return true;
  };
  const finish = async (operationId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    let phase = "supersession-pending";
    try {
      if (await supersede(operationId, signal)) return;
      // completed() already proved the original G in its SDK transaction.
      // A known operational hold must not reopen H and hand off the same G
      // just to rediscover that activation will defer it. A prior receipt
      // bypasses the writer fence, as activation does, so settlement can finish.
      const [billing, fence, priorActivation] = await firestore.getAll(firestore.doc("system/billing"),
        firestore.doc("system/publicDeployment/releaseWriter/fence"), firestore.doc(activation.activationPath(pair, operationId)));
      if (billing.data()?.disabled === true || fence.exists && !priorActivation.exists) {
        await defer(operationId, "activation-pending", false, clock() + 1_000); return;
      }
      phase = "original-continuation-pending";
      const result = await recoverOriginalPublicReleaseWork({ ...recovery, operationId, signal });
      if (result.status !== "rendered" || !result.execution) return;
      // Preserve normal H/G/queue execution discovery. Only terminal progress
      // waits; no retry timestamp or lease is changed to simulate a hold.
      if (pair.environment === "development") {
        const accepted = admission.parseAdmission((await firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`).get()).data());
        const held = await firestore.runTransaction(transaction => holds.stateInTransaction({ firestore, transaction, pair, accepted }), { readOnly: true });
        if (held?.status === "held") return;
      }
      phase = "activation-pending";
      const owner = { firestore, pair, store, identity: result.execution.identity,
        claimDigest: result.execution.claimDigest, manifestDigest: result.execution.manifestDigest, signal };
      const { taskId } = await handoffPublicReleasePairActivation(owner);
      await recoverPublicReleasePairActivations({ firestore, pair, store, publication, taskId, signal, now: clock });
      // A backoff or quarantine leaves the original continuation owned by its
      // outbox. Only an actual immutable activation receipt permits settlement.
      const activated = (await firestore.doc(activation.activationPath(pair, operationId)).get()).data();
      if (!activated) {
        const pending = (await firestore.doc(activationOutboxPath(pair, taskId)).get()).data();
        if (pending?.nextAttemptAt === null) {
          await defer(operationId, "activation-quarantined", false, null); return;
        }
        if (Number.isSafeInteger(pending?.nextAttemptAt) && pending!.nextAttemptAt >= 0) {
          // The outbox can intentionally leave a due row unchanged while a
          // shared writer fence or billing pause is held. That is not a refusal.
          await defer(operationId, "activation-pending", false, Math.max(pending!.nextAttemptAt, clock() + 1_000)); return;
        }
        refuse();
      }
      const receipt = activation.parseContentActivationRecord(activated, activated?.attempt);
      if (!same(receipt.attempt.pair, pair) || receipt.admission.operationId !== operationId ||
          !same(receipt.attempt.originalView.identity, result.execution.identity) ||
          receipt.attempt.originalView.claimDigest !== result.execution.claimDigest ||
          receipt.attempt.originalView.manifestDigest !== result.execution.manifestDigest) refuse();
      phase = "public-confirmation-pending";
      const proof = await preparePublicReleasePublicationTerminal({ firestore, store, ingress, fieldValues, operationId, signal });
      phase = "terminal-settlement-pending";
      await settlePreparedPublicReleasePublication({ firestore, proof });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof holds.RehearsalPublicationHeldError) {
        await defer(operationId, "rehearsal-hold-pending"); return;
      }
      // A private render/activation or unavailable canonical GET grants no
      // success. Retain the exact original hint and global census debt.
      const refused = error instanceof protocol.PublicReleaseProtocolError ||
        error instanceof Error && error.name === "PublicReleaseProtocolError" &&
        "status" in error && error.status === 409;
      await defer(operationId, refused ? phase.replace(/-pending$/, "-refused") : phase, refused);
    }
  };
  const beforePoll = async ({ signal }: { signal?: AbortSignal }) => {
    signal?.throwIfAborted();
    if (!await adopted()) return;
    // Same durable hint/due predicate as the existing missed-wake owner. A
    // proven successor can settle an original before allocating any task.
    const due = await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/publicationPending`)
      .where("nextAttemptAt", "<=", clock()).limit(1).get();
    for (const row of due.docs) {
      try { if (await supersede(row.id, signal)) return; }
      catch { signal?.throwIfAborted(); }
    }
    const results = await recoverDueOriginalPublicReleaseWork({ ...recovery, signal, limit: 1 });
    for (const result of results) if (result.status === "rendered") {
      // Discovery just set a future retry. The completed receipt below makes
      // this phase due without inventing a future clock or another claim.
      await completed({ identity: result.execution!.identity, claimDigest: result.execution!.claimDigest,
        manifestDigest: result.execution!.manifestDigest, signal });
    }
  };
  const completed = async ({ identity, claimDigest, manifestDigest, signal }: Completed, explicitRepair = false) => {
    if (identity.kind !== "accepted" || !await adopted()) return;
    const operationId = identity.sourceOperationId, ref = firestore.doc(admission.publicationPendingPath(pair.pairId, operationId));
    const ready = await firestore.runTransaction(async transaction => {
      const [hint, acceptedRow, marker] = await transaction.getAll(ref,
        firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`), firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`));
      if (!hint.exists) return false;
      const accepted = admission.parseAdmission(acceptedRow.data());
      if (accepted.pairDigest !== pairDigest || !same(accepted.pair, protocol.publicReleasePairReference(pair)) ||
          accepted.operationId !== operationId || identity.sourceVersion !== accepted.source.sourceVersion ||
          identity.snapshotDigest !== accepted.source.snapshotDigest || identity.contextSequence !== accepted.changeSequence ||
          hint.data()?.admissionDigest !== protocol.publicReleaseDigest(accepted)) refuse();
      if (!marker.exists) {
        await terminal.assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction, operationId,
          admissionDigest: protocol.publicReleaseDigest(accepted) });
        transaction.delete(ref); return false;
      }
      if (hint.data()?.nextAttemptAt === null && (!explicitRepair ||
          hint.data()?.recoveryFailure !== "activation-quarantined" && !/-refused$/.test(hint.data()?.recoveryFailure ?? ""))) return false;
      const receipt = await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair,
        taskId: protocol.publicReleaseDigest(identity), claimDigest, manifestDigest });
      if (!same(receipt.identity, identity)) refuse();
      if (hint.data()?.recoveryLease?.until > clock()) return false;
      signal?.throwIfAborted();
      transaction.update(ref, { nextAttemptAt: 0, ...(explicitRepair ? {
        continuationFailures: 0, continuationDeferrals: 0, continuationLastFailure: null } : {}) }); return true;
    });
    if (ready) await finish(operationId, signal);
  };
  const retryCompleted = async (input: Completed) => {
    if (input.identity.kind !== "accepted") refuse();
    if (!await adopted()) return;
    const taskId = protocol.publicReleaseDigest(input.identity);
    const receipt = await firestore.runTransaction(transaction => work.assertPublicReleasePairCompletedReceiptInTransaction({
      firestore, transaction, pair, taskId, claimDigest: input.claimDigest, manifestDigest: input.manifestDigest }), { readOnly: true });
    if (!same(receipt.identity, input.identity)) refuse();
    await retryPublicReleasePairActivation({ firestore, store, pair, publication, taskId, signal: input.signal, now: clock });
    await completed(input, true);
  };
  return { publication, beforePoll, completed: input => completed(input), retryCompleted };
}

/** Same additive binding for the private executable and its actual server
 * proof. Disabled mode returns the original executor without touching SDK. */
export function bindOriginalPublicReleaseContinuation({ firestore, pair, executor, continuation }: {
  firestore: Firestore; pair: PublicReleasePair; executor: ReturnType<typeof createPublicReleasePairExecutor>;
  continuation: ReturnType<typeof createOriginalPublicReleaseContinuation>;
}) {
  if (!continuation.beforePoll && !continuation.completed && !continuation.retryCompleted) return executor;
  return { ...executor,
    beforePoll: async (input: { signal?: AbortSignal }) => {
      await executor.beforePoll?.(input); await continuation.beforePoll?.(input);
    },
    stage: async (input: Parameters<typeof executor.stage>[0]) => {
      await executor.stage(input); await continuation.completed?.(input);
    },
    retryQuarantined: async (taskId: string, signal?: AbortSignal) => {
      await executor.retryQuarantined(taskId, signal);
      const receipt = (await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/receipts/${taskId}`).get()).data();
      if (receipt?.identity?.kind === "accepted") await continuation.retryCompleted?.({ identity: receipt.identity,
        claimDigest: receipt.claimDigest, manifestDigest: receipt.manifestDigest, signal });
    } };
}
