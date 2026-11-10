import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseSelector, PublicReleaseChangeHead } from "../../packages/content-core/src/public-release";
import type { PairAdmission } from "../../functions/lib/public-release-admission";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import admission from "../../functions/lib/public-release-admission.js";
import changes from "../../functions/lib/public-release-change-log.js";
import { exact } from "./public-release-pair-reader-contract";

// This is an accepted-work census, not a byte qualification or public-success
// receipt. The operator must additionally run both actual qualification guards.
export const MAX_SWITCH_PENDING_OPERATIONS = 2_000;
const ROOT = "system/publicDeployment", CENSUSES = `${ROOT}/switchWorkCensuses`, PAGES = `${ROOT}/switchWorkCensusPages`;
const hash = protocol.publicReleaseDigest;
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
function refuse(): never { throw new protocol.PublicReleaseProtocolError(); }
type Entry = Readonly<{ admission: PairAdmission; entryDigest: string }>;
type Page = Readonly<{ schemaVersion: 2; kind: "switch-work-census-page"; entries: readonly Entry[] }>;
type Census = Readonly<{ schemaVersion: 2; kind: "switch-work-census"; selectorDigest: string;
  oldPairDigest: string; newPairDigest: string; admissionHead: ReturnType<typeof admission.parseAdmissionHead>;
  cursor: PublicReleaseChangeHead; operationCount: number; pages: readonly string[] }>;
export type PreparedSwitchWorkCensus = Readonly<{ digest: string; operationCount: number }>;
type Data = { firestore: Firestore; selector: PublicReleaseSelector; census: Census; pages: readonly Page[];
  pairs: readonly PublicReleasePair[]; signal?: AbortSignal };
const prepared = new WeakMap<PreparedSwitchWorkCensus, Data>();

/** Snapshot the actual pending collection and its transactionally maintained
 * count/XOR head. Every member must resolve to the original queue, pair and
 * append-only accepted event. Never truncate a large or inconsistent census. */
export async function preparePublicReleaseSwitchWorkCensus({ firestore, oldPair: rawOld, newPair: rawNew, signal }: {
  firestore: Firestore; oldPair: PublicReleasePair; newPair: PublicReleasePair; signal?: AbortSignal;
}): Promise<PreparedSwitchWorkCensus> {
  const oldPair = protocol.parsePublicReleasePair(rawOld), newPair = protocol.parsePublicReleasePair(rawNew);
  for (const pair of [oldPair, newPair]) work.assertPublicReleasePairDatabase(firestore, pair);
  if (oldPair.pairId === newPair.pairId || oldPair.environment !== newPair.environment) refuse();
  const data = await firestore.runTransaction(async transaction => {
    signal?.throwIfAborted();
    const [root, headRow, cursorRow, pending] = await Promise.all([
      transaction.get(firestore.doc(ROOT)), transaction.get(firestore.doc(admission.ADMISSIONS)),
      transaction.get(firestore.doc(changes.PUBLIC_RELEASE_CHANGES_PATH)),
      transaction.get(firestore.collection(`${admission.ADMISSIONS}/pending`).orderBy("__name__").limit(MAX_SWITCH_PENDING_OPERATIONS + 1)),
    ]);
    const selector = protocol.parseStoredPublicReleaseSelector(root.data()), head = admission.parseAdmissionHead(headRow.data());
    const cursor = changes.parsePublicReleaseChangeHead(cursorRow.data());
    if (!same(selector.selectedPair, protocol.publicReleasePairReference(oldPair)) ||
        pending.size > MAX_SWITCH_PENDING_OPERATIONS || pending.size !== head.pendingCount) refuse();
    const pairs = new Map<string, PublicReleasePair>();
    let pendingDigest = "0".repeat(64);
    const entries: Entry[] = [];
    for (const marker of pending.docs) {
      signal?.throwIfAborted();
      exact(marker.data(), ["schemaVersion", "operationId", "admissionDigest"]);
      const accepted = admission.parseAdmission((await transaction.get(firestore.doc(`${admission.ADMISSIONS}/operations/${marker.id}`))).data());
      const digest = hash(accepted);
      if (accepted.operationId !== marker.id || marker.data().schemaVersion !== 2 || marker.data().operationId !== marker.id ||
          marker.data().admissionDigest !== digest || accepted.admissionSequence > head.sequence || accepted.changeSequence > cursor.sequence ||
          accepted.epoch > selector.epoch) refuse();
      let pair = pairs.get(accepted.pair.pairId);
      if (!pair) {
        if (pairs.size >= 8) refuse();
        const base = work.publicReleasePairPath(accepted.pair.pairId);
        const [pairRow, runtime] = await transaction.getAll(firestore.doc(base), firestore.doc(`${base}/controls/runtime`));
        pair = protocol.parsePublicReleasePair(pairRow.data()); work.assertPublicReleasePairDatabase(firestore, pair);
        if (pair.environment !== oldPair.environment || !same(runtime.data(), { schemaVersion: 2, pairId: pair.pairId, status: "retained" })) refuse();
        pairs.set(pair.pairId, pair);
      }
      await admission.assertRetainedPairAdmissionInTransaction({ firestore, transaction, pair, scope: { kind: "accepted",
        sourceOperationId: accepted.operationId, sourceVersion: accepted.source.sourceVersion,
        snapshotDigest: accepted.source.snapshotDigest, contextSequence: accepted.changeSequence } });
      const entry = changes.parsePublicReleaseChange((await transaction.get(firestore.doc(
        `${changes.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(accepted.changeSequence).padStart(16, "0")}`))).data());
      entries.push(Object.freeze({ admission: accepted, entryDigest: entry.entryDigest }));
      pendingDigest = admission.togglePendingDigest(pendingDigest, digest);
    }
    if (pendingDigest !== head.pendingDigest) refuse();
    const pages: Page[] = [];
    for (let offset = 0; offset < entries.length; offset += 100) pages.push(Object.freeze({ schemaVersion: 2,
      kind: "switch-work-census-page", entries: Object.freeze(entries.slice(offset, offset + 100)) }));
    const census: Census = Object.freeze({ schemaVersion: 2, kind: "switch-work-census", selectorDigest: hash(selector),
      oldPairDigest: hash(oldPair), newPairDigest: hash(newPair), admissionHead: head, cursor,
      operationCount: entries.length, pages: Object.freeze(pages.map(hash)) });
    return { firestore, selector, census, pages, pairs: [...pairs.values()], signal };
  }, { readOnly: true });
  // Create-only private facts. If acceptance or settlement raced the outside
  // snapshot, refuse rather than publishing a partial inventory under a new head.
  await firestore.runTransaction(async transaction => {
    await assertCurrent({ firestore, transaction, data, retainedRoot: false });
    const refs = [firestore.doc(`${CENSUSES}/${hash(data.census)}`), ...data.pages.map(page => firestore.doc(`${PAGES}/${hash(page)}`))];
    const values = [data.census, ...data.pages], rows = await transaction.getAll(...refs);
    rows.forEach((row, index) => { if (row.exists && !same(row.data(), values[index])) refuse(); });
    signal?.throwIfAborted();
    rows.forEach((row, index) => { if (!row.exists) transaction.create(row.ref, values[index]); });
  });
  const handle = Object.freeze({ digest: hash(data.census), operationCount: data.census.operationCount });
  prepared.set(handle, data); return handle;
}

async function assertCurrent({ firestore, transaction, data, retainedRoot }: {
  firestore: Firestore; transaction: Transaction; data: Data; retainedRoot: boolean;
}) {
  data.signal?.throwIfAborted();
  const refs = [firestore.doc(ROOT), firestore.doc(admission.ADMISSIONS), firestore.doc(changes.PUBLIC_RELEASE_CHANGES_PATH),
    ...data.pairs.flatMap(pair => [firestore.doc(work.publicReleasePairPath(pair.pairId)),
      firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`)]),
    ...(retainedRoot ? [firestore.doc(`${CENSUSES}/${hash(data.census)}`)] : [])];
  const rows = await transaction.getAll(...refs);
  if (!same(protocol.parseStoredPublicReleaseSelector(rows[0].data()), data.selector) ||
      !same(admission.parseAdmissionHead(rows[1].data()), data.census.admissionHead) ||
      !same(changes.parsePublicReleaseChangeHead(rows[2].data()), data.census.cursor)) refuse();
  data.pairs.forEach((pair, index) => {
    if (!same(protocol.parsePublicReleasePair(rows[3 + 2 * index].data()), pair) ||
        !same(rows[4 + 2 * index].data(), { schemaVersion: 2, pairId: pair.pairId, status: "retained" })) refuse();
  });
  if (retainedRoot && !same(rows.at(-1)!.data(), data.census)) refuse();
  data.signal?.throwIfAborted();
  return data.census;
}

/** Use the switch's actual tracked SDK transaction. The head changes on every
 * acceptance and terminal settlement, so a missed member or newly settled job
 * cannot pass the constant-size late check. This does not grant selection. */
export async function assertPreparedPublicReleaseSwitchWorkCensusInTransaction({ firestore, transaction, proof }: {
  firestore: Firestore; transaction: Transaction; proof: PreparedSwitchWorkCensus;
}) {
  const data = prepared.get(proof); if (!data || data.firestore !== firestore) refuse();
  return assertCurrent({ firestore, transaction, data, retainedRoot: true });
}
