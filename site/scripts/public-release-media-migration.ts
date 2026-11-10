import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairInputReceipt } from "../../functions/lib/public-release-pair-input";
import type { PairViewStore } from "./public-release-pair-view-storage";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import inputs from "../../functions/lib/public-release-pair-input.js";
import coverage from "../../functions/lib/public-release-media-coverage.js";
import { preparePublicReleasePairCodeMediaPin, preparePublicReleasePairMediaPin,
  retainPreparedPublicReleasePairMediaPin } from "./public-release-pair-media-pin";

export const MAX_MEDIA_MIGRATION_INPUTS = 2_000;
type Receipt = Readonly<{ schemaVersion: 2; kind: "pair-media-coverage-migration"; operationId: string;
  pairDigest: string; ledgerId: string; inputCount: number; inventoryDigest: string;
  beforeCoverageDigest: string; afterCoverageDigest: string }>;
export type PreparedMediaMigration = Readonly<{ operationId: string; pairId: string; inputCount: number; inventoryDigest: string }>;
type Data = { firestore: Firestore; pair: PublicReleasePair; before: coverage.PairMediaCoverage;
  after: coverage.PairMediaCoverage; receipt: Receipt; signal: AbortSignal };
const prepared = new WeakMap<PreparedMediaMigration, Data>();
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const operation = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function refuse(): never { throw new protocol.PublicReleaseProtocolError(); }
function receiptPath(pair: PublicReleasePair, operationId: string) {
  if (!operation(operationId)) refuse();
  return `${work.publicReleasePairPath(pair.pairId)}/mediaRetentionMigrations/${operationId}`;
}
function parseReceipt(raw: any, pair: PublicReleasePair): Receipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !==
      "afterCoverageDigest,beforeCoverageDigest,inputCount,inventoryDigest,kind,ledgerId,operationId,pairDigest,schemaVersion" ||
      raw.schemaVersion !== 2 || raw.kind !== "pair-media-coverage-migration" || !operation(raw.operationId) ||
      raw.pairDigest !== protocol.publicReleaseDigest(pair) || !Number.isSafeInteger(raw.inputCount) ||
      raw.inputCount < 1 || raw.inputCount > MAX_MEDIA_MIGRATION_INPUTS ||
      ![raw.ledgerId, raw.inventoryDigest, raw.beforeCoverageDigest, raw.afterCoverageDigest].every(digest)) refuse();
  return Object.freeze({ ...raw });
}

async function retainedInputs(firestore: Firestore, pair: PublicReleasePair, signal: AbortSignal) {
  const result: PairInputReceipt[] = [];
  let previous: QueryDocumentSnapshot | undefined;
  for (;;) {
    signal.throwIfAborted();
    let query = firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/inputs`).orderBy("__name__").limit(100);
    if (previous) query = query.startAfter(previous);
    const rows = await query.get();
    if (result.length + rows.size > MAX_MEDIA_MIGRATION_INPUTS) refuse();
    for (const row of rows.docs) {
      const raw = row.data();
      result.push(inputs.parsePublicReleasePairInputReceipt(raw, pair, raw.scope, row.id));
    }
    if (rows.size < 100) return result;
    previous = rows.docs.at(-1);
  }
}

/** Private one-time preparation. Every old H is opened through its actual
 * source owner and pinned before a complete ledger can be claimed. New H
 * changes the same ledger/revision, so a missed pagination insertion cannot
 * pass the final count and compare-and-set guards. No input is pruned. */
export async function preparePublicReleaseMediaMigration({ firestore, store, pair: rawPair, operationId, signal: requested }: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; operationId: string; signal?: AbortSignal;
}): Promise<PreparedMediaMigration> {
  if (!operation(operationId)) refuse();
  const pair = protocol.parsePublicReleasePair(rawPair), signal = AbortSignal.any([
    AbortSignal.timeout(10 * 60_000), ...(requested ? [requested] : []),
  ]);
  signal.throwIfAborted(); work.assertPublicReleasePairDatabase(firestore, pair);
  await work.readPublicReleasePairWork({ firestore, pair });
  const initial = await coverage.initializePublicReleasePairMediaCoverage({ firestore, pair });
  if (initial.phase !== "needs-migration") refuse();
  const codeProof = await preparePublicReleasePairCodeMediaPin({ firestore, store, pair, signal });
  await retainPreparedPublicReleasePairMediaPin({ firestore, proof: codeProof });
  const retained = await retainedInputs(firestore, pair, signal);
  if (!retained.length || !retained.some(row => row.inputManifestDigest === codeProof.inputManifestDigest)) refuse();
  const inventory: Array<{ inputManifestDigest: string; inputReceiptDigest: string; pinDigest: string }> = [];
  for (const receipt of retained) {
    signal.throwIfAborted();
    const proof = receipt.inputManifestDigest === codeProof.inputManifestDigest ? codeProof
      : await preparePublicReleasePairMediaPin({ firestore, store, pair, receipt, signal });
    await retainPreparedPublicReleasePairMediaPin({ firestore, proof });
    inventory.push({ inputManifestDigest: receipt.inputManifestDigest,
      inputReceiptDigest: protocol.publicReleaseDigest(receipt), pinDigest: proof.retentionDigest });
  }
  const before = coverage.parseCoverage((await firestore.doc(coverage.coveragePath(pair)).get()).data(), pair);
  if (before.ledgerId !== initial.ledgerId || before.phase !== "needs-migration" || before.pendingInputs !== 0 ||
      before.totalInputs !== retained.length || before.pinnedInputs !== retained.length) refuse();
  const after = coverage.parseCoverage({ ...before, phase: "tracking", revision: before.revision + 1 }, pair);
  const inventoryDigest = protocol.publicReleaseDigest(inventory);
  const receipt = parseReceipt({ schemaVersion: 2, kind: "pair-media-coverage-migration", operationId,
    pairDigest: protocol.publicReleaseDigest(pair), ledgerId: before.ledgerId, inputCount: retained.length, inventoryDigest,
    beforeCoverageDigest: protocol.publicReleaseDigest(before), afterCoverageDigest: protocol.publicReleaseDigest(after) }, pair);
  const proof = Object.freeze({ operationId, pairId: pair.pairId, inputCount: retained.length, inventoryDigest });
  prepared.set(proof, { firestore, pair, before, after, receipt, signal });
  signal.throwIfAborted(); return proof;
}

/** One original CAS/receipt. Only this process-local preparation can change
 * needs-migration into tracking; JSON receipts and caller ready flags cannot. */
export async function applyPreparedPublicReleaseMediaMigration({ firestore, proof }: {
  firestore: Firestore; proof: PreparedMediaMigration;
}) {
  const data = prepared.get(proof);
  if (!data || data.firestore !== firestore) refuse();
  const { pair, before, after, receipt, signal } = data;
  signal.throwIfAborted();
  return firestore.runTransaction(async transaction => {
    const savedRef = firestore.doc(receiptPath(pair, receipt.operationId));
    const [saved, row, registered, control, billing] = await transaction.getAll(savedRef,
      firestore.doc(coverage.coveragePath(pair)), firestore.doc(work.publicReleasePairPath(pair.pairId)),
      firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`), firestore.doc("system/billing"));
    if (saved.exists) {
      const original = parseReceipt(saved.data(), pair);
      if (!same(original, receipt)) refuse();
      return { idempotent: true, receipt: original };
    }
    if (!same(protocol.parsePublicReleasePair(registered.data()), pair) || billing.data()?.disabled === true ||
        control.data()?.schemaVersion !== 2 || control.data()?.pairId !== pair.pairId ||
        !["candidate", "retained"].includes(control.data()?.status) ||
        Object.keys(control.data()!).sort().join(",") !== "pairId,schemaVersion,status" ||
        !same(coverage.parseCoverage(row.data(), pair), before)) refuse();
    signal.throwIfAborted();
    transaction.set(row.ref, after); transaction.create(savedRef, receipt);
    return { idempotent: false, receipt };
  });
}

/** Lost-response recovery also works after a process restart, without
 * reconstructing or reapplying a completed migration. */
export async function readPublicReleaseMediaMigrationReceipt({ firestore, pair: rawPair, operationId }: {
  firestore: Firestore; pair: PublicReleasePair; operationId: string;
}) {
  const pair = protocol.parsePublicReleasePair(rawPair); work.assertPublicReleasePairDatabase(firestore, pair);
  const row = await firestore.doc(receiptPath(pair, operationId)).get();
  if (!row.exists) return null;
  const receipt = parseReceipt(row.data(), pair);
  if (receipt.operationId !== operationId) refuse();
  return receipt;
}
