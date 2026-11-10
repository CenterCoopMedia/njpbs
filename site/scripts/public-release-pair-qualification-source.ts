import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairInputReceipt } from "../../functions/lib/public-release-pair-input";
import type { ReplayViewReference, ReplayWitness } from "../../functions/lib/public-release-pair-replay";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import { openPublicReleasePairInput } from "./public-release-pair-input-storage";
import { openQualificationInput } from "./public-release-pair-qualification-inputs";
import { PairQualificationError } from "./public-release-pair-qualification-authority";
import { PAIR_SOURCE_METADATA_FILE, preparePublicReleasePairSourceCensus, assertPublicReleasePairSourceCensusInTransaction,
  projectPublicReleasePairSourceCensusDocuments, PairSourceCensusError, type PairSourceMetadata } from "./public-release-pair-source-census";

export const QUALIFICATION_TRANSACTION_READ_LIMIT = 500;
export type QualificationSourceAudit = Readonly<{ mode: "full" | "split"; outsideReadCount: number; validatorCount: number; transactionReadCount: number }>;
declare const sourceBrand: unique symbol;
export type PreparedQualificationSource = Readonly<{ headView: ReplayViewReference; metadata: PairSourceMetadata;
  readCount: number; validatorCount: number }> & { readonly [sourceBrand]: true };
type SourcePurpose = "qualification" | "publication";
const prepared = new WeakMap<object, { pairDigest: string; witnessDigest: string; purpose: SourcePurpose }>();
declare const trackerBrand: unique symbol;
export type QualificationTransactionReadTracker = Readonly<{ transaction: Transaction; readCount(): number }> & { readonly [trackerBrand]: true };
const trackers = new WeakMap<object, { original: Transaction; transaction: Transaction }>();

/** An opaque in-process result of the actual outside census. Deserialized
 * caller hints cannot choose the weaker over-limit guard. A new process must
 * prepare again before attempting its own transaction. No selection is made. */
type SourcePreparation = {
  firestore: Firestore; store: Parameters<typeof openQualificationInput>[0]["store"]; pair: PublicReleasePair; witness: ReplayWitness;
  witnessDigest: string; headView: ReplayViewReference; captured: PairInputReceipt; signal: AbortSignal;
};
export function prepareQualificationSource(options: SourcePreparation): Promise<PreparedQualificationSource> {
  return prepareSource(options, true);
}
/** Ordinary publication checks the sealed source metadata without re-reading
 * the full immutable code/input closure. Its replay owner proves those inputs
 * separately; this result is only a live source seal, never publication proof. */
export function preparePublicReleasePairPublicationSource(options: SourcePreparation): Promise<PreparedQualificationSource> {
  return prepareSource(options, false);
}
async function prepareSource({ firestore, store, pair, witness, witnessDigest, headView: rawHead, captured, signal }: SourcePreparation,
  completeClosure: boolean): Promise<PreparedQualificationSource> {
  const headView = replay.parseReplayViewReference(rawHead, pair);
  if (headView.identity.contextSequence !== witness.headCursor.sequence ||
      protocol.publicReleaseDigest(captured.cursor) !== protocol.publicReleaseDigest(witness.headCursor)) throw new PairQualificationError("source-census-unproven");
  const frozen = completeClosure
    ? await openQualificationInput({ firestore, store, pair, reference: headView, captured, signal })
    : await openPublicReleasePairInput({ firestore, store, pair, identity: headView.identity,
      expectedSource: captured.source, expectedCursor: captured.cursor, signal });
  let expected: PairSourceMetadata;
  try { expected = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await frozen.readFile(PAIR_SOURCE_METADATA_FILE))); }
  catch { throw new PairQualificationError("source-census-unproven"); }
  signal.throwIfAborted();
  const result = await preparePublicReleasePairSourceCensus({ firestore, expected, cursor: witness.headCursor, signal });
  signal.throwIfAborted();
  const value = Object.freeze({ headView, metadata: result.metadata, readCount: result.readCount,
    validatorCount: result.validatorCount }) as PreparedQualificationSource;
  prepared.set(value, { pairDigest: protocol.publicReleaseDigest(pair), witnessDigest,
    purpose: completeClosure ? "qualification" : "publication" });
  return value;
}
export function assertPreparedQualificationSource(pair: PublicReleasePair, witnessDigest: string, value: PreparedQualificationSource,
  sourceCensusDigest: string, headViewDigest: string, purpose: SourcePurpose = "qualification") {
  const original = value && prepared.get(value);
  if (!original || original.pairDigest !== protocol.publicReleaseDigest(pair) || original.witnessDigest !== witnessDigest ||
      original.purpose !== purpose ||
      value.metadata.digest !== sourceCensusDigest || protocol.publicReleaseDigest(value.headView) !== headViewDigest ||
      !Number.isSafeInteger(value.readCount) || value.readCount < 1 || value.validatorCount !== value.metadata.members.length) {
    throw new PairQualificationError("source-census-unproven");
  }
}

/** Count actual SDK document/query results, including empty-query minimums.
 * All operations stay on the caller's original transaction and read snapshot. */
export function trackQualificationTransactionReads(original: Transaction, existing?: QualificationTransactionReadTracker): QualificationTransactionReadTracker {
  if (existing) {
    const registered = trackers.get(existing);
    if (!registered || original !== registered.original && original !== registered.transaction) {
      throw new PairQualificationError("qualification-validator-unproven");
    }
    return existing;
  }
  let count = 0;
  const transaction = new Proxy(original, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if ((key === "get" || key === "getAll") && typeof value === "function") return async (...args: unknown[]) => {
      const result = await value.apply(target, args);
      count += Array.isArray(result) ? result.length : typeof result?.size === "number" ? Math.max(1, result.size) : 1;
      return result;
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const tracker = Object.freeze({ transaction, readCount: () => count }) as QualificationTransactionReadTracker;
  trackers.set(tracker, { original, transaction });
  return tracker;
}
/** A switch shares one tracker across all its reads and both pair guards.
 * Check again after the last read and before any selection writes. */
export function assertQualificationTransactionReadBudget(tracker: QualificationTransactionReadTracker) {
  if (!trackers.has(tracker)) throw new PairQualificationError("qualification-validator-unproven");
  const count = tracker.readCount();
  if (count > QUALIFICATION_TRANSACTION_READ_LIMIT) throw new PairQualificationError("qualification-validator-limit");
  return count;
}
export async function assertQualificationSourceInTransaction({ firestore, tracker, pair, witness, witnessDigest, source,
  sourceCensusDigest, headViewDigest, purpose = "qualification" }: { firestore: Firestore; tracker: ReturnType<typeof trackQualificationTransactionReads>;
  pair: PublicReleasePair; witness: ReplayWitness; witnessDigest: string; source: PreparedQualificationSource;
  sourceCensusDigest: string; headViewDigest: string; purpose?: SourcePurpose }): Promise<QualificationSourceAudit> {
  assertPreparedQualificationSource(pair, witnessDigest, source, sourceCensusDigest, headViewDigest, purpose);
  const remaining = QUALIFICATION_TRANSACTION_READ_LIMIT - assertQualificationTransactionReadBudget(tracker);
  const mode = source.readCount <= remaining ? "full" as const : "split" as const;
  if (mode === "full") await assertPublicReleasePairSourceCensusInTransaction({ firestore, transaction: tracker.transaction,
    expected: source.metadata, cursor: witness.headCursor, maxDocuments: remaining });
  else {
    // Author routes have no separate mutable route-owner collection. Compare
    // their complete current public profile roster using the source owner's
    // semantic projection, including additions and deletions, in this same
    // transaction. Historical aliases/withdrawals come from the closed G proof.
    const rows = await tracker.transaction.get(firestore.collection("cmsAuthorProfilesPublic").limit(remaining + 1));
    assertQualificationTransactionReadBudget(tracker);
    const actual = rows.empty ? [] : projectPublicReleasePairSourceCensusDocuments(
      new Map(rows.docs.map(row => [row.ref.path, row.data()]))).members;
    const expected = source.metadata.members.filter(member => member.path.startsWith("cmsAuthorProfilesPublic/"));
    if (protocol.publicReleaseDigest(actual) !== protocol.publicReleaseDigest(expected)) throw new PairSourceCensusError("source-census-mismatch");
  }
  assertQualificationTransactionReadBudget(tracker);
  // The approved split uses the actual fresh full outside census and the log
  // head/owned-route checks already performed in this same transaction.
  return Object.freeze({ mode, outsideReadCount: source.readCount, validatorCount: source.validatorCount, transactionReadCount: tracker.readCount() });
}
