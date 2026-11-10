import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseChangeHead } from "../../packages/content-core/src/public-release";
import type { SwitchAttempt, SwitchGuardInput, SwitchQualification, SwitchReceipt } from "../../functions/lib/public-release-switch";
import type { ReplayWitness } from "../../functions/lib/public-release-pair-replay";
import type { QualificationTransactionReadTracker } from "./public-release-pair-qualification-source";
import type { PairViewStore } from "./public-release-pair-view-storage";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import switches from "../../functions/lib/public-release-switch.js";
import admission from "../../functions/lib/public-release-admission.js";
import { parseReaderSeals, exact, supportedReaderFeatures, type ReaderSeals } from "./public-release-pair-reader-contract";
import { readQualificationReceiptInTransaction } from "./public-release-pair-qualification-receipt";
import { verifyStoredQualificationEvidence, assertPublicReleasePairQualificationCurrentInTransaction } from "./public-release-pair-qualification";
import { publicReleaseSwitchQualificationReadOwner as readOwner } from "./public-release-switch-qualification";
import { preparePublicReleaseSwitchWorkCensus, assertPreparedPublicReleaseSwitchWorkCensusInTransaction,
  type PreparedSwitchWorkCensus } from "./public-release-switch-work-census";

const hash = protocol.publicReleaseDigest, same = (a: unknown, b: unknown) => hash(a) === hash(b);
function refuse(): never { throw new protocol.PublicReleaseProtocolError(); }
type Qualified = { pair: PublicReleasePair; qualificationId: string; receiptDigest: string;
  evidence: Awaited<ReturnType<typeof verifyStoredQualificationEvidence>> };
export type PreparedGuardedPublicReleaseSwitch = Readonly<{ operationId: string; attemptDigest: string; witnessDigest: string }>;
type Data = { firestore: Firestore; attempt: SwitchAttempt; qualified: readonly Qualified[];
  census: PreparedSwitchWorkCensus; qualifications: readonly SwitchQualification[]; signal: AbortSignal };
const prepared = new WeakMap<PreparedGuardedPublicReleaseSwitch, Data>();

function assertContract(raw: unknown, seals: readonly ReaderSeals[]) {
  const value = exact(raw, ["schemaVersion", "families", "features"]);
  if (value.schemaVersion !== 2 || !Array.isArray(value.families) || !Array.isArray(value.features)) refuse();
  const families = ["posts", "pages", "programs", "events", "settings", "context"];
  if (new Set(value.families).size !== value.families.length || value.families.some(family => !families.includes(family)) ||
      new Set(value.features).size !== value.features.length) refuse();
  for (const seal of seals) {
    const supported = supportedReaderFeatures(seal);
    if (value.features.some(feature => !supported.has(feature)) ||
        value.families.some(family => ["programs", "events"].includes(family) && !seal.capabilities.record.families.includes(family))) refuse();
  }
}

/** Build-only private composition. Inputs name actual stored qualification
 * receipts; neither a caller witness nor a boolean can replace their full
 * byte, replay, source-census, catalog and private-reader evidence. */
export async function prepareGuardedPublicReleaseSwitch({ firestore, store, oldPair: rawOld, newPair: rawNew,
  operationId, oldQualificationId, newQualificationId, signal: callerSignal }: {
  firestore: Firestore; store: PairViewStore; oldPair: PublicReleasePair; newPair: PublicReleasePair;
  operationId: string; oldQualificationId: string; newQualificationId: string; signal?: AbortSignal;
}): Promise<PreparedGuardedPublicReleaseSwitch> {
  const pairs = [protocol.parsePublicReleasePair(rawOld), protocol.parsePublicReleasePair(rawNew)];
  if (pairs[0].pairId === pairs[1].pairId || pairs[0].environment !== pairs[1].environment ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) refuse();
  pairs.forEach(pair => work.assertPublicReleasePairDatabase(firestore, pair));
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(callerSignal ? [callerSignal] : [])]);
  signal.throwIfAborted();
  const initial = await firestore.runTransaction(async transaction => {
    const rows = await transaction.getAll(firestore.doc(switches.ROOT),
      ...switches.REQUIRED_VALIDATORS.map(path => firestore.doc(path)),
      ...pairs.flatMap(pair => [firestore.doc(work.publicReleasePairPath(pair.pairId)),
        firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/seals/privateReader`),
        firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/rollouts/publisher`)]));
    const selector = protocol.parseStoredPublicReleaseSelector(rows[0].data());
    if (!same(selector.selectedPair, protocol.publicReleasePairReference(pairs[0]))) refuse();
    const validators = switches.REQUIRED_VALIDATORS.map((path, index) => {
      if (!rows[index + 1].exists) refuse();
      return { path, digest: hash(rows[index + 1].data()) };
    });
    const offset = 1 + validators.length;
    const seals = pairs.map((pair, index) => {
      const start = offset + 3 * index, rollout = rows[start + 2].data();
      if (!same(protocol.parsePublicReleasePair(rows[start].data()), pair) || rollout?.state !== "verified" ||
          rollout.pairDigest !== hash(pair) || !/^[a-f0-9]{64}$/.test(rollout.readbackDigest)) refuse();
      return { seals: parseReaderSeals(rows[start + 1].data(), pair), readbackDigest: rollout.readbackDigest as string };
    });
    const contract = (await transaction.get(firestore.doc(`${admission.CONTRACTS}/${selector.admittedContractDigest}`))).data();
    if (hash(contract) !== selector.admittedContractDigest) refuse();
    assertContract(contract, seals.map(row => row.seals));
    const receipts = [];
    for (const [index, pair] of pairs.entries()) {
      const stored = await readQualificationReceiptInTransaction({ firestore, transaction, pair,
        qualificationId: index ? newQualificationId : oldQualificationId });
      if (!stored) refuse(); receipts.push(stored);
    }
    return { selector, validators, seals, receipts };
  }, { readOnly: true });
  const qualified: Qualified[] = [], witnesses: ReplayWitness[] = [];
  for (const [index, pair] of pairs.entries()) {
    signal.throwIfAborted();
    const stored = initial.receipts[index], witness = replay.parseReplayWitness((await firestore.doc(
      `${work.publicReleasePairPath(pair.pairId)}/replayWitnesses/${stored.receipt.witnessDigest}`).get()).data(), pair);
    const expanded = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair,
      headCursor: witness.headCursor, witnessDigest: stored.receipt.witnessDigest });
    const evidence = await verifyStoredQualificationEvidence({ firestore, store, pair, receipt: stored.receipt,
      witness, namespaces: expanded.namespaces, signal });
    witnesses.push(witness);
    qualified.push({ pair, qualificationId: stored.receipt.qualificationId, receiptDigest: stored.digest, evidence });
  }
  if (!same(witnesses[0].headCursor, witnesses[1].headCursor) ||
      !same(qualified[0].evidence.source.metadata, qualified[1].evidence.source.metadata)) refuse();
  const census = await preparePublicReleaseSwitchWorkCensus({ firestore, oldPair: pairs[0], newPair: pairs[1], signal });
  const cursor: PublicReleaseChangeHead = { schemaVersion: 2, ...witnesses[0].headCursor };
  const acceptedWorkDigest = initial.validators.find(row => row.path === admission.ADMISSIONS)!.digest;
  const coverage = pairs.map((pair, index) => Object.freeze({ schemaVersion: 2, kind: "pair-switch-coverage",
    pairDigest: hash(pair), qualificationId: initial.receipts[index].receipt.qualificationId,
    qualificationReceiptDigest: initial.receipts[index].digest, replayWitnessDigest: initial.receipts[index].receipt.witnessDigest,
    headView: qualified[index].evidence.source.headView, workCensusDigest: census.digest,
    sourceMetadataDigest: qualified[index].evidence.source.metadata.digest }));
  const qualifications = pairs.map((pair, index) => {
    const capabilities = switches.publicationControlsForReaderSeals(initial.seals[index].seals, pair);
    return switches.parseSwitchQualification({ schemaVersion: 2, pairDigest: hash(pair), contentHead: {
      pairId: pair.pairId, viewId: initial.receipts[index].receipt.witnessDigest,
      manifestDigest: witnesses[index].contentViewDigest, contextSequence: witnesses[index].headCursor.sequence },
    cursor, validatorDigest: hash(initial.validators), capabilities, controlsDigest: hash(capabilities),
    coverageDigest: hash(coverage[index]), acceptedWorkDigest,
    admittedContractDigest: initial.selector.admittedContractDigest, readerReceiptDigest: pair.readerReceiptDigest,
    providerReadbackDigest: initial.seals[index].readbackDigest }, pair);
  });
  const witness = switches.parseSwitchWitness({ schemaVersion: 2, oldPairDigest: hash(pairs[0]), newPairDigest: hash(pairs[1]),
    oldQualificationDigest: hash(qualifications[0]), newQualificationDigest: hash(qualifications[1]), cursor,
    validators: initial.validators, admittedContractDigest: initial.selector.admittedContractDigest, acceptedWorkDigest });
  const attempt = switches.parseSwitchAttempt({ schemaVersion: 2, operationId, oldPair: pairs[0], newPair: pairs[1],
    expectedSelectorDigest: hash(initial.selector), witnessDigest: hash(witness) });
  const data: Data = { firestore, attempt, qualified, census, qualifications, signal };
  await firestore.runTransaction(async transaction => {
    const tracker = readOwner.trackQualificationTransactionReads(transaction);
    await guardQualifications(data, tracker.transaction, tracker);
    const accepted = await assertPreparedPublicReleaseSwitchWorkCensusInTransaction({ firestore, transaction: tracker.transaction, proof: census });
    if (accepted.selectorDigest !== attempt.expectedSelectorDigest || !same(accepted.cursor, witness.cursor) ||
        hash(accepted.admissionHead) !== acceptedWorkDigest) refuse();
    const validators = await tracker.transaction.getAll(...witness.validators.map(row => firestore.doc(row.path)));
    validators.forEach((row, index) => { if (!row.exists || hash(row.data()) !== witness.validators[index].digest) refuse(); });
    const records: { path: string; value: object }[] = [{ path: `${switches.WITNESSES}/${hash(witness)}`, value: witness },
      ...pairs.flatMap((pair, index) => [
        { path: `${work.publicReleasePairPath(pair.pairId)}/switchQualifications/${hash(qualifications[index])}`, value: qualifications[index] },
        { path: `${work.publicReleasePairPath(pair.pairId)}/switchCoverage/${hash(coverage[index])}`, value: coverage[index] },
      ])];
    const rows = await tracker.transaction.getAll(...records.map(record => firestore.doc(record.path)));
    rows.forEach((row, index) => { if (row.exists && !same(row.data(), records[index].value)) refuse(); });
    readOwner.assertQualificationTransactionReadBudget(tracker); signal.throwIfAborted();
    rows.forEach((row, index) => { if (!row.exists) tracker.transaction.create(row.ref, records[index].value); });
  });
  const handle = Object.freeze({ operationId, attemptDigest: hash(attempt), witnessDigest: attempt.witnessDigest });
  prepared.set(handle, data); return handle;
}

async function guardQualifications(data: Data, transaction: Transaction, readTracker: QualificationTransactionReadTracker) {
  data.signal.throwIfAborted();
  for (const row of data.qualified) await assertPublicReleasePairQualificationCurrentInTransaction({ firestore: data.firestore,
    transaction, readTracker, pair: row.pair, qualificationId: row.qualificationId, receiptDigest: row.receiptDigest,
    ...row.evidence });
}
function guardedData(firestore: Firestore, proof: PreparedGuardedPublicReleaseSwitch) {
  const data = prepared.get(proof); if (!data || data.firestore !== firestore) refuse(); return data;
}

async function reserveCurrent(data: Data) {
  const { firestore, attempt } = data;
  const receipt = await readGuardedPublicReleaseSwitchReceipt({ firestore, operationId: attempt.operationId });
  if (receipt) {
    if (receipt.attemptDigest !== hash(attempt)) refuse();
    return { reservation: { idempotent: true, attemptDigest: receipt.attemptDigest }, receipt };
  }
  // Known expired/stale preparation must not acquire the global fence. This
  // outside preflight grants no authority: apply rechecks everything in its
  // own single transaction, including a race after this read-only snapshot.
  data.signal.throwIfAborted();
  await switches.assertPublicReleaseSwitchPreflight(switchDependencies(data));
  data.signal.throwIfAborted();
  return { reservation: await switches.reservePublicReleaseSwitch({ firestore, attempt }), receipt: null };
}

/** Optional explicit phase boundary for operator journaling and crash recovery.
 * It uses the same genuine preparation and preflight as the combined apply. */
export async function reservePreparedGuardedPublicReleaseSwitch({ firestore, proof }: {
  firestore: Firestore; proof: PreparedGuardedPublicReleaseSwitch;
}) { return (await reserveCurrent(guardedData(firestore, proof))).reservation; }
/** One persisted attempt, one shared writer fence, and the foundation's single
 * selector/pins/capabilities/media/receipt/audit transaction. Both actual late
 * qualification guards and work census use its ONE opaque 500-read tracker. */
export async function applyPreparedGuardedPublicReleaseSwitch({ firestore, proof }: {
  firestore: Firestore; proof: PreparedGuardedPublicReleaseSwitch;
}) {
  const data = guardedData(firestore, proof);
  const prior = await reserveCurrent(data);
  if (prior.receipt) return { idempotent: true, receipt: prior.receipt };
  return switches.applyPublicReleaseSwitch(switchDependencies(data));
}

function switchDependencies(data: Data) {
  const { firestore } = data;
  return { firestore, attempt: data.attempt, qualificationReadOwner: readOwner,
    async assertQualificationsCurrentInTransaction({ transaction, readTracker, pairs, qualifications }: SwitchGuardInput<QualificationTransactionReadTracker>) {
      if (!same(pairs, data.qualified.map(row => row.pair)) || !same(qualifications, data.qualifications)) refuse();
      await guardQualifications(data, transaction, readTracker);
    }, async assertAcceptedWorkIncludedInTransaction({ transaction, witness }: SwitchGuardInput<QualificationTransactionReadTracker>) {
      const census = await assertPreparedPublicReleaseSwitchWorkCensusInTransaction({ firestore, transaction, proof: data.census });
      if (census.selectorDigest !== data.attempt.expectedSelectorDigest || !same(census.cursor, witness.cursor) ||
          hash(census.admissionHead) !== witness.acceptedWorkDigest) refuse();
    } };
}

/** Explicit cancellation only. An ambiguous response is recovered from the
 * original immutable receipt; it never silently releases or replaces a fence. */
export function abandonPreparedGuardedPublicReleaseSwitch({ firestore, proof }: {
  firestore: Firestore; proof: PreparedGuardedPublicReleaseSwitch;
}) { return switches.abandonPublicReleaseSwitch({ firestore, attempt: guardedData(firestore, proof).attempt }); }

export async function readGuardedPublicReleaseSwitchAttempt({ firestore, operationId }: { firestore: Firestore; operationId: string }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) refuse();
  const row = await firestore.doc(`${switches.ATTEMPTS}/${operationId}`).get();
  if (!row.exists) return null;
  const attempt = switches.parseSwitchAttempt(row.data());
  if (attempt.operationId !== operationId) refuse();
  work.assertPublicReleasePairDatabase(firestore, attempt.oldPair); work.assertPublicReleasePairDatabase(firestore, attempt.newPair);
  return attempt;
}

/** Recover an unapplied attempt after a process crash without recreating an
 * expired qualification handle. The foundation atomically checks the original
 * attempt, exact owned fence and absent receipt. Cancellation is never an
 * automatic response to an ambiguous apply result. */
export async function abandonGuardedPublicReleaseSwitch({ firestore, operationId, expectedAttemptDigest }: {
  firestore: Firestore; operationId: string; expectedAttemptDigest: string;
}) {
  const attempt = await readGuardedPublicReleaseSwitchAttempt({ firestore, operationId });
  if (!attempt || !/^[a-f0-9]{64}$/.test(expectedAttemptDigest) || hash(attempt) !== expectedAttemptDigest) refuse();
  return switches.abandonPublicReleaseSwitch({ firestore, attempt });
}

/** Process-restart/lost-response inspection of the original immutable fact.
 * A newer live selector does not erase this operation's historical receipt. */
export async function readGuardedPublicReleaseSwitchReceipt({ firestore, operationId }: { firestore: Firestore; operationId: string }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) refuse();
  return firestore.runTransaction(async transaction => {
    const [attemptRow, receiptRow] = await transaction.getAll(firestore.doc(`${switches.ATTEMPTS}/${operationId}`),
      firestore.doc(`${switches.RECEIPTS}/${operationId}`));
    if (!receiptRow.exists) return null;
    const attempt = switches.parseSwitchAttempt(attemptRow.data()), raw = exact(receiptRow.data(),
      ["schemaVersion", "operationId", "attemptDigest", "selectorDigest", "selector"]);
    const selector = protocol.parsePublicReleaseSelector(raw.selector);
    work.assertPublicReleasePairDatabase(firestore, attempt.oldPair); work.assertPublicReleasePairDatabase(firestore, attempt.newPair);
    if (attempt.operationId !== operationId || raw.schemaVersion !== 2 || raw.operationId !== operationId ||
        raw.attemptDigest !== hash(attempt) || raw.selectorDigest !== hash(selector) || selector.switchOperationId !== operationId ||
        selector.priorSelectorDigest !== attempt.expectedSelectorDigest || selector.proofDigest !== attempt.witnessDigest ||
        !same(selector.selectedPair, protocol.publicReleasePairReference(attempt.newPair)) ||
        !same(selector.recoveryPair, protocol.publicReleasePairReference(attempt.oldPair))) refuse();
    return Object.freeze({ ...raw, selector }) as SwitchReceipt;
  }, { readOnly: true });
}
