import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { ReplayViewReference } from "../../functions/lib/public-release-pair-replay";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import log from "../../functions/lib/public-release-change-log.js";
import activation from "../../functions/lib/public-release-content-activation.js";
import inputCodec from "../../functions/lib/public-release-pair-input.js";
import admission from "../../functions/lib/public-release-admission.js";
import terminal from "../../functions/lib/public-release-terminal.js";
import type { ContentActivationTracker } from "../../functions/lib/public-release-content-activation";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import { PairSourceCensusError } from "./public-release-pair-source-census";
import { PairQualificationError } from "./public-release-pair-qualification-authority";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { replayPublicReleasePairToHead } from "./public-release-pair-log-replay";
import { preparePublicReleasePairPublicationSeals, assertPublicReleasePairPublicationSealsCurrentInTransaction,
  trackQualificationTransactionReads, assertQualificationTransactionReadBudget,
  type QualificationTransactionReadTracker } from "./public-release-pair-publication-seals";

function refuse(): never { throw new protocol.PublicReleaseProtocolError(); }
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
export class PublicationActivationError extends Error {
  constructor(readonly code: "content-activation-replay-pending" | "content-activation-predecessor-failed") { super(code); }
}

/** Composes the actual opaque source/seal owner and replay owner. It opens no
 * listener and does not replace the public activation entrypoint.
 * The original caller retains admission, dispatch and canonical settlement.
 */
export async function activatePublicReleasePairPublication({ firestore, store, pair: rawPair, operationId,
  admissionDigest, originalView: rawOriginalView, witnessDigest, signal = new AbortController().signal }: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; operationId: string;
  admissionDigest: string; originalView: ReplayViewReference; witnessDigest: string; signal?: AbortSignal;
}) {
  signal.throwIfAborted();
  const pair = protocol.parsePublicReleasePair(rawPair), originalView = replay.parseReplayViewReference(rawOriginalView, pair);
  work.assertPublicReleasePairDatabase(firestore, pair);
  const base = work.publicReleasePairPath(pair.pairId), receiptPath = activation.activationPath(pair, operationId);
  // A lost response resolves the original immutable result. It cannot rebase
  // its original attempt onto a later head or allocate a replacement owner.
  const original = (await firestore.doc(receiptPath).get()).data();
  if (original) {
    const receipt = activation.parseContentActivationRecord(original, original.attempt);
    if (receipt.admission.operationId !== operationId || receipt.attempt.admissionDigest !== admissionDigest ||
        !same(receipt.attempt.pair, pair) || !same(receipt.attempt.originalView, originalView)) refuse();
    return { idempotent: true, receipt };
  }
  const [selectorRow, headRow] = await firestore.getAll(firestore.doc("system/publicDeployment"), firestore.doc(`${base}/heads/current`));
  const selector = protocol.parsePublicReleaseSelector(selectorRow.data()), head = activation.parseContentHead(headRow.data(), pair);
  const row = (await firestore.doc(`${base}/replayWitnesses/${witnessDigest}`).get()).data();
  const witness = replay.parseReplayWitness(row, pair);
  if (protocol.publicReleaseDigest(witness) !== witnessDigest) refuse();
  const attempt = activation.parseContentActivationAttempt({ schemaVersion: 2, operationId, admissionDigest, pair,
    expectedSelectorDigest: protocol.publicReleaseDigest(selector), expectedHeadDigest: protocol.publicReleaseDigest(head),
    witnessDigest, headCursor: witness.headCursor, originalView });
  try {
    const replayProof = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair,
      headCursor: attempt.headCursor, witnessDigest, selectedViews: [originalView] });
    const prepared = await preparePublicReleasePairPublicationSeals({ firestore, store, pair, witnessDigest, signal });
    if (prepared.pairDigest !== protocol.publicReleaseDigest(pair) || prepared.witnessDigest !== witnessDigest ||
        !same(prepared.headCursor, attempt.headCursor) || prepared.headViewDigest !== protocol.publicReleaseDigest(replayProof.headView)) refuse();
    signal.throwIfAborted();
    const ownedTrackers = new WeakMap<ContentActivationTracker, QualificationTransactionReadTracker>();
    return await activation.activatePublicReleasePairContent({ firestore, attempt, replayProof, publicationReadOwner: {
      trackQualificationTransactionReads(transaction) {
        const tracker = trackQualificationTransactionReads(transaction);
        ownedTrackers.set(tracker, tracker);
        return tracker;
      },
      assertQualificationTransactionReadBudget(tracker) {
        const owned = ownedTrackers.get(tracker); if (!owned) refuse();
        return assertQualificationTransactionReadBudget(owned);
      },
    }, assertOriginalTerminalInTransaction: terminal.assertPairPublicationTerminalReceiptInTransaction,
    async assertPublicationCurrentInTransaction({ transaction, tracker, witness: currentWitness, headView }) {
      signal.throwIfAborted();
      const owned = ownedTrackers.get(tracker);
      if (!owned || !same(currentWitness, witness) || !same(headView, replayProof.headView)) refuse();
      await assertPublicReleasePairPublicationSealsCurrentInTransaction({ firestore, transaction, pair, prepared, readTracker: owned });
      signal.throwIfAborted();
    } });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof activation.ContentActivationConflictError) throw error;
    const sourceRace = error instanceof PairSourceCensusError && error.code === "source-census-mismatch";
    const qualificationRace = error instanceof PairQualificationError && error.code === "stale-qualification";
    if (!(error instanceof protocol.PublicReleaseProtocolError) && !sourceRace && !qualificationRace) throw error;
    // Preparation can refuse before the transaction if a normal writer moved
    // its source snapshot. Distinguish that race from stable invalid evidence.
    const [currentSelector, currentHead, currentLog] = await firestore.getAll(firestore.doc("system/publicDeployment"),
      firestore.doc(`${base}/heads/current`), firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH));
    const head = log.parsePublicReleaseChangeHead(currentLog.data());
    if (protocol.publicReleaseDigest(protocol.parsePublicReleaseSelector(currentSelector.data())) !== attempt.expectedSelectorDigest ||
        protocol.publicReleaseDigest(activation.parseContentHead(currentHead.data(), pair)) !== attempt.expectedHeadDigest ||
        !same({ baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest }, attempt.headCursor))
      throw new activation.ContentActivationConflictError();
    throw error;
  }
}

/** Read only existing immutable captures and completed/staged receipts. A
 * missing predecessor remains pending; this adapter never claims or renders.
 */
async function stagedReference(firestore: Firestore, pair: PublicReleasePair, identity: PairTaskIdentity,
  claimDigest: string, manifestDigest: string): Promise<ReplayViewReference | null> {
  const base = work.publicReleasePairPath(pair.pairId);
  const row = (await firestore.doc(`${base}/views/${manifestDigest}`).get()).data();
  if (!row) return null;
  const reference = replay.parseReplayViewReference({ identity, claimDigest, manifestDigest, manifestBytes: row?.manifestBytes }, pair);
  if (row?.status !== "staged" || !same(row.identity, identity) || row.claimDigest !== claimDigest || row.manifestDigest !== manifestDigest) refuse();
  return reference;
}
export async function existingReplayView(firestore: Firestore, pair: PublicReleasePair, operationId: string, sequence: number) {
  const base = work.publicReleasePairPath(pair.pairId);
  for (const kind of ["accepted", "recovery", "qualification"] as const) {
    const binding = (await firestore.doc(`${base}/sourceInputs/${protocol.publicReleaseDigest({ kind, sourceOperationId: operationId })}`).get()).data();
    if (!binding) continue;
    const scope = inputCodec.parsePublicReleasePairInputScope(binding.scope);
    if (binding.schemaVersion !== 2 || binding.pairDigest !== protocol.publicReleaseDigest(pair) || scope.kind !== kind ||
        scope.sourceOperationId !== operationId || scope.contextSequence !== sequence ||
        !/^[a-f0-9]{64}$/.test(binding.inputManifestDigest ?? "")) refuse();
    const identity = { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(pair), ...scope,
      inputManifestDigest: binding.inputManifestDigest };
    const taskId = protocol.publicReleaseDigest(identity);
    const [completed, task, quarantine] = await firestore.getAll(firestore.doc(`${base}/receipts/${taskId}`),
      firestore.doc(`${base}/work/${taskId}`), firestore.doc(`${base}/stagingFailures/${taskId}`));
    // These are stop signals, never publication evidence. A terminal original
    // owner needs explicit repair; repeatedly waking its successors cannot fix it.
    if (quarantine.data()?.status === "quarantined" || task.data()?.status === "failed" && task.data()?.nextAttemptAt === null)
      throw new PublicationActivationError("content-activation-predecessor-failed");
    const row = completed.data();
    if (!row) continue;
    if (Object.keys(row).sort().join(",") !== "claimDigest,identity,manifestDigest,schemaVersion,taskId" ||
        row.schemaVersion !== 2 || row.taskId !== protocol.publicReleaseDigest(identity) || !same(row.identity, identity) ||
        !/^[a-f0-9]{64}$/.test(row.claimDigest ?? "") || !/^[a-f0-9]{64}$/.test(row.manifestDigest ?? "")) refuse();
    return stagedReference(firestore, pair, identity, row.claimDigest, row.manifestDigest);
  }
  const capture = (await firestore.doc(`system/publicReleaseChanges/captures/${operationId}`).get()).data();
  if (!capture || capture.schemaVersion !== 2 || capture.operationId !== operationId || capture.sequence !== sequence) refuse();
  if (capture.status === "failed" || ["accepted", "recovery", "qualification"].some(kind => {
    const key = protocol.publicReleaseDigest({ pair: protocol.publicReleasePairReference(pair), kind });
    return capture.packs?.[key]?.status === "failed";
  })) throw new PublicationActivationError("content-activation-predecessor-failed");
  return null;
}

/** Post-G runtime and original-queue recovery use this same callable transport.
 * There is no listener, new acceptance, replacement claim or second queue.
 * Installation must bind the original pending queue's recovery wake as well
 * as the post-stage call; a process crash cannot be repaired by re-rendering.
 */
export async function activateStagedPublicReleasePairPublication({ firestore, store, pair: rawPair, identity,
  claimDigest, manifestDigest, signal }: { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair;
  identity: PairTaskIdentity; claimDigest: string; manifestDigest: string; signal?: AbortSignal }) {
  const pair = protocol.parsePublicReleasePair(rawPair);
  if (identity.kind !== "accepted" && identity.kind !== "recovery") refuse();
  const accepted = admission.parseAdmission((await firestore.doc(`${admission.ADMISSIONS}/operations/${identity.sourceOperationId}`).get()).data());
  const originalView = await stagedReference(firestore, pair, identity, claimDigest, manifestDigest);
  if (!originalView) throw new PublicationActivationError("content-activation-replay-pending");
  const admissionDigest = protocol.publicReleaseDigest(accepted);
  const prior = (await firestore.doc(activation.activationPath(pair, accepted.operationId)).get()).data();
  if (prior) {
    const receipt = activation.parseContentActivationRecord(prior, prior.attempt);
    if (receipt.attempt.admissionDigest !== admissionDigest || !same(receipt.attempt.pair, pair) || !same(receipt.attempt.originalView, originalView)) refuse();
    return { idempotent: true, receipt };
  }
  const replayed = await replayPublicReleasePairToHead({ firestore, store, pair, signal,
    resolveView: async entry => entry.operationId === identity.sourceOperationId ? originalView :
      existingReplayView(firestore, pair, entry.operationId, entry.sequence) });
  if (replayed.status !== "complete") throw new PublicationActivationError("content-activation-replay-pending");
  return activatePublicReleasePairPublication({ firestore, store, pair, operationId: accepted.operationId,
    admissionDigest, originalView, witnessDigest: replayed.witnessDigest, signal });
}
