import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairInputReceipt } from "../../functions/lib/public-release-pair-input";
import type { ReplayViewReference } from "../../functions/lib/public-release-pair-replay";
import protocol from "../../functions/lib/public-release-pair.js";
import input from "../../functions/lib/public-release-pair-input.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { PairQualificationError, readPairQualificationAuthority, assertPairQualificationAuthorityCurrent,
  type QualificationAuthority } from "./public-release-pair-qualification-authority";
import { preparePublicReleasePairPublicationSource, assertQualificationSourceInTransaction,
  trackQualificationTransactionReads, assertQualificationTransactionReadBudget,
  type QualificationTransactionReadTracker, type PreparedQualificationSource } from "./public-release-pair-qualification-source";
import type { PairViewStore } from "./public-release-pair-view-storage";

export { trackQualificationTransactionReads, assertQualificationTransactionReadBudget } from "./public-release-pair-qualification-source";
export type { QualificationTransactionReadTracker } from "./public-release-pair-qualification-source";

declare const publicationSealsBrand: unique symbol;
export type PreparedPublicReleasePairPublicationSeals = Readonly<{
  pairDigest: string; witnessDigest: string; headCursor: QualificationAuthority["cursor"];
  headViewDigest: string; sourceCensusDigest: string; sealsDigest: string;
}> & { readonly [publicationSealsBrand]: true };
const preparations = new WeakMap<PreparedPublicReleasePairPublicationSeals, {
  firestore: Firestore; authority: QualificationAuthority; source: PreparedQualificationSource;
  witness: Awaited<ReturnType<typeof replay.openPublicReleasePairReplayWitnessProof>>["witness"]; signal: AbortSignal;
}>();
const refuse = (): never => { throw new PairQualificationError("qualification-validator-unproven"); };

async function originalInput(firestore: Firestore, transaction: Transaction, pair: PublicReleasePair,
  reference: ReplayViewReference): Promise<PairInputReceipt> {
  const { identity } = reference;
  const scope = input.parsePublicReleasePairInputScope({ kind: identity.kind, sourceOperationId: identity.sourceOperationId,
    sourceVersion: identity.sourceVersion, snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence });
  const row = await transaction.get(firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/inputs/${identity.inputManifestDigest}`));
  const captured = input.parsePublicReleasePairInputReceipt(row.data(), pair, scope, identity.inputManifestDigest);
  const staged = await replay.assertStagedReplayViewInTransaction({ firestore, transaction, pair, reference, cursor: captured.cursor });
  if (protocol.publicReleaseDigest(staged.captured) !== protocol.publicReleaseDigest(captured)) refuse();
  return captured;
}

/** Read-only preparation for the ordinary publication adapter. It checks the
 * current source census and installed reader/capability seals. Only H's root
 * and source metadata are opened: no code-pack/body HTTP requalification and
 * no qualification receipt. The adapter must also prove replay and own its CAS. */
export async function preparePublicReleasePairPublicationSeals({ firestore, store, pair: rawPair, witnessDigest, signal }: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; witnessDigest: string; signal: AbortSignal;
}): Promise<PreparedPublicReleasePairPublicationSeals> {
  signal.throwIfAborted();
  const pair = protocol.parsePublicReleasePair(rawPair);
  const authority = await firestore.runTransaction(transaction => readPairQualificationAuthority({ firestore, transaction, pair }), { readOnly: true });
  // The owner expands immutable namespace inventories outside transactions;
  // its bounded capsule guard then binds those exact original descriptors.
  const expanded = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair,
    headCursor: authority.cursor, witnessDigest });
  signal.throwIfAborted();
  const initial = await firestore.runTransaction(async transaction => {
    const proof = await replay.assertReadReplayWitnessProofInTransaction({ firestore, transaction, pair,
      headCursor: authority.cursor, witnessDigest, namespaces: expanded.namespaces, headView: expanded.headView });
    const captured = await originalInput(firestore, transaction, pair, proof.headView);
    return { authority, ...proof, captured };
  }, { readOnly: true });
  signal.throwIfAborted();
  const source = await preparePublicReleasePairPublicationSource({ firestore, store, pair, witnessDigest,
    witness: initial.witness, headView: initial.headView, captured: initial.captured, signal });
  signal.throwIfAborted();
  const prepared = Object.freeze({ pairDigest: protocol.publicReleaseDigest(pair), witnessDigest,
    headCursor: initial.authority.cursor, headViewDigest: protocol.publicReleaseDigest(source.headView),
    sourceCensusDigest: source.metadata.digest, sealsDigest: initial.authority.sealsDigest }) as PreparedPublicReleasePairPublicationSeals;
  preparations.set(prepared, { firestore, authority: initial.authority, source, witness: initial.witness, signal });
  return prepared;
}

/** Run within the adapter's original transaction, after its other reads and
 * before its head CAS. This seal-only guard grants/selects/completes nothing;
 * candidate qualification alone cannot certify an ordinary publication. */
export async function assertPublicReleasePairPublicationSealsCurrentInTransaction({ firestore, transaction, pair: rawPair,
  prepared, readTracker }: { firestore: Firestore; transaction: Transaction; pair: PublicReleasePair;
  prepared: PreparedPublicReleasePairPublicationSeals; readTracker?: QualificationTransactionReadTracker }) {
  const saved = preparations.get(prepared), pair = protocol.parsePublicReleasePair(rawPair);
  if (!saved || saved.firestore !== firestore || prepared.pairDigest !== protocol.publicReleaseDigest(pair)) return refuse();
  saved.signal.throwIfAborted();
  const tracker = trackQualificationTransactionReads(transaction, readTracker);
  const authority = await assertPairQualificationAuthorityCurrent({ firestore, transaction: tracker.transaction, pair,
    expectedDigest: saved.authority.digest, qualifiedAt: saved.authority.capturedAt });
  assertQualificationTransactionReadBudget(tracker);
  const sourceValidation = await assertQualificationSourceInTransaction({ firestore, tracker, pair, witness: saved.witness,
    witnessDigest: prepared.witnessDigest, source: saved.source, sourceCensusDigest: prepared.sourceCensusDigest,
    headViewDigest: prepared.headViewDigest, purpose: "publication" });
  saved.signal.throwIfAborted();
  return { authority, sourceValidation };
}
