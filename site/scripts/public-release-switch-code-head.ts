import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import type { ReplayViewReference } from "../../functions/lib/public-release-pair-replay";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import views from "../../functions/lib/public-release-pair-view.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import changes from "../../functions/lib/public-release-change-log.js";
import switches from "../../functions/lib/public-release-switch.js";
import mediaCodec from "../../functions/lib/public-release-pair-media.js";
import activation from "../../functions/lib/public-release-content-activation.js";
import codeOwner from "../../functions/lib/public-release-switch-code-recovery.js";
import writer from "../../functions/lib/public-release-writer-fence.js";
import runtime from "../../functions/lib/cms-publication-runtime-control.js";
import targets from "../../functions/lib/publication-target.js";
import { exact } from "./public-release-pair-reader-contract";
import { openStagedPublicReleasePairComposite } from "./public-release-pair-composite-storage";
import { preparePublicReleasePairPublicationSeals, assertPublicReleasePairPublicationSealsCurrentInTransaction,
  trackQualificationTransactionReads, assertQualificationTransactionReadBudget } from "./public-release-pair-publication-seals";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { PairQualificationError } from "./public-release-pair-qualification-authority";
import { PairSourceCensusError } from "./public-release-pair-source-census";

const hash = protocol.publicReleaseDigest, same = (a: unknown, b: unknown) => hash(a) === hash(b);
function refuse(): never { throw new protocol.PublicReleaseProtocolError(); }
export class SwitchCodeHeadPendingError extends Error {
  readonly code = "switch-code-replay-pending";
  readonly retryable = true;
  constructor() { super("The selected pair is waiting for its switch CODE replay"); }
}
type Receipt = Readonly<{ schemaVersion: 2; kind: "pair-switch-code-head"; operationId: string; switchOperationId: string;
  pairDigest: string; sourceView: ReplayViewReference; sourceEventDigest: string; witnessDigest: string;
  headViewDigest: string; sourceMetadataDigest: string; selectorDigestBefore: string; selectorDigestAfter: string;
  selector: PublicReleaseSelector }>;
const receiptPath = (pair: PublicReleasePair, operationId: string) => `${work.publicReleasePairPath(pair.pairId)}/switchCodeActivations/${operationId}`;
function parseReceipt(raw: unknown, pair: PublicReleasePair, sourceView: ReplayViewReference): Receipt {
  const value = exact(raw, ["schemaVersion", "kind", "operationId", "switchOperationId", "pairDigest", "sourceView", "sourceEventDigest",
    "witnessDigest", "headViewDigest", "sourceMetadataDigest", "selectorDigestBefore", "selectorDigestAfter", "selector"]);
  const selector = protocol.parsePublicReleaseSelector(value.selector), source = replay.parseReplayViewReference(value.sourceView, pair);
  if (value.schemaVersion !== 2 || value.kind !== "pair-switch-code-head" || value.operationId !== sourceView.identity.sourceOperationId ||
      value.operationId !== switches.switchChangeOperationId(selector.switchOperationId) || value.switchOperationId !== selector.switchOperationId ||
      value.pairDigest !== hash(pair) || !same(source, sourceView) || !same(selector.selectedPair, protocol.publicReleasePairReference(pair)) ||
      selector.contentHead.contextSequence < sourceView.identity.contextSequence || selector.activeGeneration !== sourceView.identity.sourceVersion ||
      selector.contentHead.viewId !== value.witnessDigest || value.selectorDigestAfter !== hash(selector) ||
      [value.sourceEventDigest, value.witnessDigest, value.headViewDigest, value.sourceMetadataDigest, value.selectorDigestBefore, value.selectorDigestAfter]
        .some(digest => typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) refuse();
  return Object.freeze({ ...value, sourceView: source, selector }) as Receipt;
}

/** Inert post-G adapter for the exact switch CODE operation. This is a head
 * catch-up, never an editorial admission, queue settlement, new code epoch or
 * provider operation. The caller must bind it explicitly after adoption. */
export async function advancePublicReleaseSwitchCodeHead({ firestore, store, pair: rawPair, identity: rawIdentity,
  claimDigest, manifestDigest, signal = AbortSignal.timeout(120_000) }: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity;
  claimDigest: string; manifestDigest: string; signal?: AbortSignal;
}): Promise<{ status: "not-current-code" } | { status: "activated"; idempotent: boolean; receipt: Receipt }> {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = views.parseViewIdentity(rawIdentity, pair);
  work.assertPublicReleasePairDatabase(firestore, pair); signal.throwIfAborted();
  const base = work.publicReleasePairPath(pair.pairId), operationId = identity.sourceOperationId;
  if (identity.kind !== "recovery") return { status: "not-current-code" };
  const [viewRow, prior, selectorRow, headRow, initialLogRow] = await firestore.getAll(firestore.doc(`${base}/views/${manifestDigest}`),
    firestore.doc(receiptPath(pair, operationId)), firestore.doc(switches.ROOT), firestore.doc(`${base}/heads/current`),
    firestore.doc(changes.PUBLIC_RELEASE_CHANGES_PATH));
  const sourceView = replay.parseReplayViewReference({ identity, claimDigest, manifestDigest, manifestBytes: viewRow.data()?.manifestBytes }, pair);
  if (prior.exists) return { status: "activated", idempotent: true, receipt: parseReceipt(prior.data(), pair, sourceView) };
  const selector = protocol.parseStoredPublicReleaseSelector(selectorRow.data());
  if (!same(selector.selectedPair, protocol.publicReleasePairReference(pair)) || operationId !== switches.switchChangeOperationId(selector.switchOperationId))
    return { status: "not-current-code" };
  const initialHead = activation.parseContentHead(headRow.data(), pair), initialLog = changes.parsePublicReleaseChangeHead(initialLogRow.data());
  const scope = { kind: identity.kind, sourceOperationId: operationId, sourceVersion: identity.sourceVersion,
    snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence };
  try {
    const sourceAuthority = await firestore.runTransaction(transaction => codeOwner.assertSwitchCodeRecoveryInTransaction({
      firestore, transaction, pair, scope, inputManifestDigest: identity.inputManifestDigest }), { readOnly: true });
    const source = await openStagedPublicReleasePairComposite({ firestore, store, pair, identity, claimDigest,
      viewManifestDigest: manifestDigest, signal });
    await source.verifyAll();
    let sealed: Awaited<ReturnType<typeof replay.sealPublicReleasePairReplayWitness>>;
    try { sealed = await replay.sealPublicReleasePairReplayWitness({ firestore, pair }); }
    catch (error) {
      if (error instanceof replay.PairReplayError && error.code === "replay-not-caught-up") throw new SwitchCodeHeadPendingError();
      throw error;
    }
    const head = changes.parsePublicReleaseChangeHead((await firestore.doc(changes.PUBLIC_RELEASE_CHANGES_PATH).get()).data());
    const cursor = { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest };
    if (sealed.witness.headCursor.sequence < cursor.sequence) throw new SwitchCodeHeadPendingError();
    if (!same(sealed.witness.headCursor, cursor) || cursor.sequence < identity.contextSequence) refuse();
    const expanded = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair, headCursor: cursor, witnessDigest: sealed.witnessDigest });
    const prepared = await preparePublicReleasePairPublicationSeals({ firestore, store, pair, witnessDigest: sealed.witnessDigest, signal });
    if (prepared.headViewDigest !== hash(expanded.headView)) refuse();
    return await firestore.runTransaction(async originalTransaction => {
      const tracker = trackQualificationTransactionReads(originalTransaction), transaction = tracker.transaction;
      const ref = firestore.doc(receiptPath(pair, operationId));
      const [saved, root, currentHead, registered, control, fence, pinsRow, billing, mediaRow, adoption, switchRow] = await transaction.getAll(ref,
        firestore.doc(switches.ROOT), firestore.doc(`${base}/heads/current`), firestore.doc(base),
        firestore.doc(`${base}/controls/runtime`), firestore.doc(writer.RELEASE_WRITER_FENCE_PATH),
        firestore.doc("system/cmsPublicationRuntime"), firestore.doc("system/billing"), firestore.doc(switches.MEDIA),
        firestore.doc("system/publicReleaseAdmissions/controls/adoption"), firestore.doc(`${switches.RECEIPTS}/${selector.switchOperationId}`));
      if (saved.exists) return { status: "activated" as const, idempotent: true, receipt: parseReceipt(saved.data(), pair, sourceView) };
      signal.throwIfAborted();
      if (fence.exists) { writer.parseReleaseWriterFence(fence.data()); refuse(); }
      const current = protocol.parseStoredPublicReleaseSelector(root.data()), media = mediaCodec.parsePairMedia(mediaRow.data(), current);
      const ownedHead = activation.parseContentHead(currentHead.data(), pair);
      const committed = protocol.parsePublicReleaseSelector(switchRow.data()?.selector);
      const adopted = exact(adoption.data(), ["schemaVersion", "enabled"]);
      const pins = runtime.parseCmsPublicationRuntimeControl(pinsRow.data()), serializer = targets.publicationTarget(pair.environment).serializerId;
      if (!same(current, selector) || !same(ownedHead, initialHead) || !same(protocol.parsePublicReleasePair(registered.data()), pair) ||
          adopted.schemaVersion !== 2 || adopted.enabled !== true || current.epoch !== committed.epoch || current.activeGeneration !== identity.sourceVersion ||
          current.activeCommitSha !== pair.commitSha || current.activeDeploymentId !== pair.publicWorker.versionId ||
          !same(control.data(), { schemaVersion: 2, pairId: pair.pairId, status: "retained" }) || billing.data()?.disabled === true ||
          [pins, pins.cloud].some(pin => pin?.phase !== "ready" || pin.commitSha !== pair.commitSha || pin.serializerId !== serializer) ||
          !same(ownedHead.contentHead, current.contentHead) || current.contentHead.contextSequence > cursor.sequence ||
          media.references.find(reference => reference.pairId === pair.pairId)?.manifestDigest !== current.contentHead.manifestDigest) refuse();
      const authority = await codeOwner.assertSwitchCodeRecoveryInTransaction({ firestore, transaction, pair, scope,
        inputManifestDigest: identity.inputManifestDigest });
      if (!same(authority, sourceAuthority)) refuse();
      await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair, taskId: hash(identity), claimDigest, manifestDigest });
      await replay.assertStagedReplayViewInTransaction({ firestore, transaction, pair, reference: sourceView,
        cursor: { baselineDigest: cursor.baselineDigest, sequence: identity.contextSequence, lastDigest: sourceAuthority.eventDigest } });
      const proof = await replay.assertReadReplayWitnessProofInTransaction({ firestore, transaction, pair, headCursor: cursor,
        witnessDigest: sealed.witnessDigest, namespaces: expanded.namespaces, headView: expanded.headView, selectedViews: [] });
      if (!same(proof.witness, sealed.witness) || !same(proof.headView, expanded.headView)) refuse();
      await assertPublicReleasePairPublicationSealsCurrentInTransaction({ firestore, transaction, pair, prepared, readTracker: tracker });
      const contentHead = { pairId: pair.pairId, viewId: sealed.witnessDigest, manifestDigest: sealed.witness.contentViewDigest, contextSequence: cursor.sequence };
      if (current.contentHead.contextSequence === cursor.sequence && !same(current.contentHead, contentHead)) refuse();
      const next = protocol.parsePublicReleaseSelector({ ...current, contentHead });
      const receipt = parseReceipt({ schemaVersion: 2, kind: "pair-switch-code-head", operationId, switchOperationId: current.switchOperationId,
        pairDigest: hash(pair), sourceView, sourceEventDigest: sourceAuthority.eventDigest, witnessDigest: sealed.witnessDigest,
        headViewDigest: hash(expanded.headView), sourceMetadataDigest: prepared.sourceCensusDigest,
        selectorDigestBefore: hash(current), selectorDigestAfter: hash(next), selector: next }, pair, sourceView);
      assertQualificationTransactionReadBudget(tracker); signal.throwIfAborted();
      if (!same(current.contentHead, contentHead)) {
        transaction.set(root.ref, next);
        transaction.set(currentHead.ref, { schemaVersion: 2, pairDigest: hash(pair), contentHead });
        transaction.set(mediaRow.ref, { ...media, references: media.references.map(reference => reference.pairId === pair.pairId
          ? { ...reference, manifestDigest: contentHead.manifestDigest } : reference) });
      }
      transaction.create(ref, receipt);
      return { status: "activated" as const, idempotent: false, receipt };
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof protocol.PublicReleaseProtocolError || error instanceof replay.PairReplayError ||
        error instanceof PairQualificationError || error instanceof PairSourceCensusError) {
      const [currentRoot, currentHead, currentLog] = await firestore.getAll(firestore.doc(switches.ROOT),
        firestore.doc(`${base}/heads/current`), firestore.doc(changes.PUBLIC_RELEASE_CHANGES_PATH));
      if (!same(protocol.parseStoredPublicReleaseSelector(currentRoot.data()), selector) ||
          !same(activation.parseContentHead(currentHead.data(), pair), initialHead) ||
          !same(changes.parsePublicReleaseChangeHead(currentLog.data()), initialLog)) throw new activation.ContentActivationConflictError();
    }
    throw error;
  }
}
