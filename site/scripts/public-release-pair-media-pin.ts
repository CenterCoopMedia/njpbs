import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairInputReceipt } from "../../functions/lib/public-release-pair-input";
import type { PairViewStore } from "./public-release-pair-view-storage";
import protocol from "../../functions/lib/public-release-pair.js";
import input from "../../functions/lib/public-release-pair-input.js";
import work from "../../functions/lib/public-release-pair-work.js";
import retention from "../../functions/lib/public-release-media-retention.js";
import coverage from "../../functions/lib/public-release-media-coverage.js";
import { openPublicReleasePairInput } from "./public-release-pair-input-storage";
import { openPublicReleasePairSourceDocuments } from "./public-release-pair-source-documents";
import { projectPublicReleasePairSourceCensusDocuments, PAIR_SOURCE_METADATA_FILE } from "./public-release-pair-source-census";
import { readFrozenPublicReleasePairCodePackManifest, type PairCodePackBaselineReceipt } from "./public-release-pair-code-pack-storage";

export type PreparedPairMediaPin = Readonly<{ pairId: string; inputManifestDigest: string; retentionDigest: string }>;
type Data = { firestore: Firestore; pair: PublicReleasePair; receipt: PairInputReceipt;
  pin: retention.PairMediaPin; chunks: retention.PairMediaChunk[]; signal?: AbortSignal; codeBaselineDigest?: string };
const prepared = new WeakMap<PreparedPairMediaPin, Data>();
const same = (left: unknown, right: unknown) => protocol.publicReleaseDigest(left) === protocol.publicReleaseDigest(right);
function refuse(): never { throw new protocol.PublicReleaseProtocolError(); }

/** Read the actual immutable H, including its complete source census. Caller
 * asset lists and serialized proof-shaped objects are never pin authority. */
async function preparePin({ firestore, store, pair: rawPair, receipt: rawReceipt, signal }: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; receipt: PairInputReceipt; signal?: AbortSignal;
}, codeBaseline?: PairCodePackBaselineReceipt): Promise<PreparedPairMediaPin> {
  signal?.throwIfAborted();
  const pair = protocol.parsePublicReleasePair(rawPair);
  work.assertPublicReleasePairDatabase(firestore, pair);
  const receipt = input.parsePublicReleasePairInputReceipt(rawReceipt, pair, rawReceipt.scope, rawReceipt.inputManifestDigest);
  const opened = await openPublicReleasePairInput({ firestore, store, pair,
    identity: { schemaVersion: 2, pair: protocol.publicReleasePairReference(pair), ...receipt.scope, inputManifestDigest: receipt.inputManifestDigest },
    expectedSource: receipt.source, expectedCursor: receipt.cursor, signal });
  if (!same(opened.receipt, receipt)) refuse();
  const { documents, census } = await openPublicReleasePairSourceDocuments(opened.root, opened.readFile);
  const verified = projectPublicReleasePairSourceCensusDocuments(documents);
  if (codeBaseline) {
    if (opened.root.scope.kind !== "qualification" || opened.root.source.kind !== "inventory" ||
        opened.root.scope.sourceOperationId !== `baseline-codepack-${census.baseline.logBaselineDigest}` ||
        !same(opened.root.cursor, census.baseline.receipt.baselineCursor) || census.changes.length) refuse();
  } else {
    const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await opened.readFile(PAIR_SOURCE_METADATA_FILE)));
    if (!same(metadata, verified)) refuse();
  }
  const publicIds = verified.members.filter(member => member.path.startsWith("media_assets_public/")).map(member => member.path.slice("media_assets_public/".length)).sort();
  const privateIds = verified.members.filter(member => member.path.startsWith("media_assets/")).map(member => member.path.slice("media_assets/".length)).sort();
  if (!same(publicIds, privateIds)) refuse();
  const pin = retention.buildPairMediaPin({ pair, receipt, sourceMetadataDigest: verified.digest, assetIds: publicIds });
  const handle = Object.freeze({ pairId: pair.pairId, inputManifestDigest: receipt.inputManifestDigest, retentionDigest: protocol.publicReleaseDigest(pin) });
  prepared.set(handle, { firestore, pair, receipt, pin, chunks: retention.chunksForPin(pin), signal,
    ...(codeBaseline ? { codeBaselineDigest: protocol.publicReleaseDigest(codeBaseline) } : {}) });
  signal?.throwIfAborted();
  return handle;
}

export function preparePublicReleasePairMediaPin(options: Parameters<typeof preparePin>[0]) {
  return preparePin(options);
}

/** CODE H predates source-metadata.json. Its actual SDK baseline owner and
 * frozen source-input manifest bind the complete original source census. */
export async function preparePublicReleasePairCodeMediaPin(options: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; signal?: AbortSignal;
}) {
  const code = await readFrozenPublicReleasePairCodePackManifest(options);
  const raw = (await options.firestore.doc(`${work.publicReleasePairPath(options.pair.pairId)}/inputs/${code.receipt.inputManifestDigest}`).get()).data();
  const receipt = input.parsePublicReleasePairInputReceipt(raw, options.pair, raw?.scope, code.receipt.inputManifestDigest);
  return preparePin({ ...options, receipt }, code.receipt);
}

/** All reads precede the returned create-only write closure. The source owner
 * calls it in the same SDK transaction that marks its original capture ready. */
export async function preparePublicReleasePairMediaPinInTransaction({ firestore, transaction, proof }: {
  firestore: Firestore; transaction: Transaction; proof: PreparedPairMediaPin;
}) {
  const data = prepared.get(proof);
  if (!data || data.firestore !== firestore) refuse();
  const { pair, receipt, pin, chunks, signal } = data;
  signal?.throwIfAborted();
  const owner = await work.assertPublicReleasePairInputOwnerInTransaction({ firestore, transaction, pair,
    scope: receipt.scope, inputManifestDigest: receipt.inputManifestDigest });
  if (!owner.receipt || protocol.publicReleaseDigest(owner.receipt) !== pin.inputReceiptDigest) refuse();
  if (data.codeBaselineDigest && protocol.publicReleaseDigest((await transaction.get(
    firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/codePacks/baseline`))).data()) !== data.codeBaselineDigest) refuse();
  const paths = [retention.pinPath(pair, receipt.inputManifestDigest), ...pin.chunks.map(digest =>
    `${work.publicReleasePairPath(pair.pairId)}/mediaUsage/chunk-${digest}`)];
  const rows = await transaction.getAll(...paths.map(path => firestore.doc(path))), values = [pin, ...chunks];
  rows.forEach((row, index) => {
    if (row.exists && !same(row.data(), values[index])) refuse();
  });
  const writeCoverage = await coverage.preparePairMediaPinCoverageInTransaction({ firestore, transaction, pair, receipt,
    pinDigest: protocol.publicReleaseDigest(pin) });
  signal?.throwIfAborted();
  return { pin, write() {
    signal?.throwIfAborted();
    rows.forEach((row, index) => { if (!row.exists) transaction.create(row.ref, values[index]); });
    writeCoverage();
  } };
}

/** Baseline H has no producer outbox. Its pin still commits before bootstrap
 * can use the returned frozen baseline. Exact repeats never overwrite rows. */
export async function retainPreparedPublicReleasePairMediaPin({ firestore, proof }: { firestore: Firestore; proof: PreparedPairMediaPin }) {
  return firestore.runTransaction(async transaction => {
    const ready = await preparePublicReleasePairMediaPinInTransaction({ firestore, transaction, proof });
    ready.write(); return { retentionDigest: protocol.publicReleaseDigest(ready.pin) };
  });
}
