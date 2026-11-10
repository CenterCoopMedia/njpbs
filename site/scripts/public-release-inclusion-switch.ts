import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import type { PairAdmission } from "../../functions/lib/public-release-admission";
import protocol from "../../functions/lib/public-release-pair.js";
import admission from "../../functions/lib/public-release-admission.js";
import changes from "../../functions/lib/public-release-change-log.js";
import work from "../../functions/lib/public-release-pair-work.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import switches from "../../functions/lib/public-release-switch.js";
import { exact } from "./public-release-pair-reader-contract";
import { readQualificationReceiptInTransaction } from "./public-release-pair-qualification-receipt";
import { MAX_SWITCH_PENDING_OPERATIONS } from "./public-release-switch-work-census";

const hash = protocol.publicReleaseDigest, same = (a: unknown, b: unknown) => hash(a) === hash(b);
const codeSelector = (selector: PublicReleaseSelector) => { const { contentHead: _head, ...code } = selector; return code; };
function refuse(): never { throw new protocol.PublicReleaseProtocolError(); }
export type PairSwitchInclusionAuthority = Readonly<{ switchOperationId: string; switchReceiptDigest: string;
  switchWitnessDigest: string; switchCoverageDigest: string; workCensusDigest: string; originalEntryDigest: string }>;

/** Actual immutable switch lineage and complete sealed pending-work inventory.
 * Called again in terminal settlement's own tracked SDK transaction. A caller
 * cannot replace these reads with a qualified flag or a supplied census. */
export async function assertPublicReleaseSwitchInclusionInTransaction({ firestore, transaction, selector: rawSelector,
  originalPair: rawOriginal, selectedPair: rawSelected, accepted: rawAccepted }: {
  firestore: Firestore; transaction: Transaction; selector: PublicReleaseSelector;
  originalPair: PublicReleasePair; selectedPair: PublicReleasePair; accepted: PairAdmission;
}): Promise<PairSwitchInclusionAuthority> {
  const selector = protocol.parsePublicReleaseSelector(rawSelector), accepted = admission.parseAdmission(rawAccepted);
  const original = protocol.parsePublicReleasePair(rawOriginal), selected = protocol.parsePublicReleasePair(rawSelected);
  for (const pair of [original, selected]) work.assertPublicReleasePairDatabase(firestore, pair);
  if (original.pairId === selected.pairId || original.environment !== selected.environment ||
      !same(protocol.publicReleasePairReference(selected), selector.selectedPair) || !same(protocol.publicReleasePairReference(original), accepted.pair) ||
      accepted.pairDigest !== hash(original)) refuse();
  const [rootRow, attemptRow, receiptRow, witnessRow] = await transaction.getAll(firestore.doc(switches.ROOT),
    firestore.doc(`${switches.ATTEMPTS}/${selector.switchOperationId}`), firestore.doc(`${switches.RECEIPTS}/${selector.switchOperationId}`),
    firestore.doc(`${switches.WITNESSES}/${selector.proofDigest}`));
  const attempt = switches.parseSwitchAttempt(attemptRow.data()), receipt = receiptRow.data()!;
  const committed = protocol.parsePublicReleaseSelector(receipt?.selector), witness = switches.parseSwitchWitness(witnessRow.data());
  if (!same(protocol.parseStoredPublicReleaseSelector(rootRow.data()), selector) || attempt.operationId !== selector.switchOperationId ||
      receipt.schemaVersion !== 2 || receipt.operationId !== attempt.operationId || receipt.attemptDigest !== hash(attempt) ||
      receipt.selectorDigest !== hash(committed) || !same(codeSelector(committed), codeSelector(selector)) ||
      attempt.witnessDigest !== selector.proofDigest || hash(witness) !== selector.proofDigest ||
      witness.newPairDigest !== hash(selected) || !same(attempt.newPair, selected) ||
      !same(protocol.publicReleasePairReference(attempt.oldPair), selector.recoveryPair) ||
      witness.oldPairDigest !== hash(attempt.oldPair) || witness.admittedContractDigest !== selector.admittedContractDigest) refuse();
  const base = work.publicReleasePairPath(selected.pairId);
  const qualification = switches.parseSwitchQualification((await transaction.get(firestore.doc(
    `${base}/switchQualifications/${witness.newQualificationDigest}`))).data(), selected);
  if (hash(qualification) !== witness.newQualificationDigest || qualification.validatorDigest !== hash(witness.validators) ||
      !same(qualification.cursor, witness.cursor) || qualification.acceptedWorkDigest !== witness.acceptedWorkDigest ||
      qualification.admittedContractDigest !== witness.admittedContractDigest) refuse();
  const coverage = exact((await transaction.get(firestore.doc(`${base}/switchCoverage/${qualification.coverageDigest}`))).data(),
    ["schemaVersion", "kind", "pairDigest", "qualificationId", "qualificationReceiptDigest", "replayWitnessDigest", "headView", "workCensusDigest", "sourceMetadataDigest"]);
  if (coverage.schemaVersion !== 2 || coverage.kind !== "pair-switch-coverage" || coverage.pairDigest !== hash(selected) ||
      hash(coverage) !== qualification.coverageDigest || typeof coverage.qualificationId !== "string" ||
      ![coverage.qualificationReceiptDigest, coverage.replayWitnessDigest, coverage.workCensusDigest, coverage.sourceMetadataDigest]
        .every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) refuse();
  const stored = await readQualificationReceiptInTransaction({ firestore, transaction, pair: selected, qualificationId: coverage.qualificationId });
  const headView = replay.parseReplayViewReference(coverage.headView, selected);
  if (!stored || stored.digest !== coverage.qualificationReceiptDigest || stored.receipt.witnessDigest !== coverage.replayWitnessDigest ||
      stored.receipt.sourceCensusDigest !== coverage.sourceMetadataDigest || stored.receipt.headViewDigest !== hash(headView) ||
      qualification.contentHead.viewId !== coverage.replayWitnessDigest ||
      qualification.contentHead.manifestDigest !== stored.receipt.contentViewDigest || headView.identity.contextSequence !== witness.cursor.sequence) refuse();
  const census = exact((await transaction.get(firestore.doc(`${switches.ROOT}/switchWorkCensuses/${coverage.workCensusDigest}`))).data(),
    ["schemaVersion", "kind", "selectorDigest", "oldPairDigest", "newPairDigest", "admissionHead", "cursor", "operationCount", "pages"]);
  const admissionHead = admission.parseAdmissionHead(census.admissionHead), cursor = changes.parsePublicReleaseChangeHead(census.cursor);
  if (hash(census) !== coverage.workCensusDigest || census.schemaVersion !== 2 || census.kind !== "switch-work-census" ||
      census.selectorDigest !== attempt.expectedSelectorDigest || census.oldPairDigest !== witness.oldPairDigest ||
      census.newPairDigest !== witness.newPairDigest || hash(admissionHead) !== witness.acceptedWorkDigest || !same(cursor, witness.cursor) ||
      census.operationCount !== admissionHead.pendingCount || admissionHead.pendingCount < 1 || admissionHead.pendingCount > MAX_SWITCH_PENDING_OPERATIONS ||
      accepted.changeSequence > cursor.sequence || !Array.isArray(census.pages) || census.pages.length !== Math.ceil(admissionHead.pendingCount / 100) ||
      census.pages.some(digest => typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) || new Set(census.pages).size !== census.pages.length) refuse();
  const pages = await transaction.getAll(...census.pages.map(digest => firestore.doc(`${switches.ROOT}/switchWorkCensusPages/${digest}`)));
  let count = 0, pendingDigest = "0".repeat(64), previous = "", originalEntryDigest = "";
  for (const [index, row] of pages.entries()) {
    const page = exact(row.data(), ["schemaVersion", "kind", "entries"]);
    if (hash(page) !== census.pages[index] || page.schemaVersion !== 2 || page.kind !== "switch-work-census-page" ||
        !Array.isArray(page.entries) || page.entries.length < 1 || page.entries.length > 100 || index < pages.length - 1 && page.entries.length !== 100) refuse();
    for (const raw of page.entries) {
      const entry = exact(raw, ["admission", "entryDigest"]), member = admission.parseAdmission(entry.admission);
      if (typeof entry.entryDigest !== "string" || !/^[a-f0-9]{64}$/.test(entry.entryDigest) ||
          previous && member.operationId <= previous || member.admissionSequence > admissionHead.sequence || member.changeSequence > cursor.sequence) refuse();
      previous = member.operationId; count++; pendingDigest = admission.togglePendingDigest(pendingDigest, hash(member));
      if (member.operationId === accepted.operationId) {
        if (!same(member, accepted) || originalEntryDigest) refuse();
        originalEntryDigest = entry.entryDigest;
      }
    }
  }
  if (count !== admissionHead.pendingCount || pendingDigest !== admissionHead.pendingDigest || !originalEntryDigest) refuse();
  await admission.assertRetainedPairAdmissionInTransaction({ firestore, transaction, pair: original, scope: { kind: "accepted",
    sourceOperationId: accepted.operationId, sourceVersion: accepted.source.sourceVersion,
    snapshotDigest: accepted.source.snapshotDigest, contextSequence: accepted.changeSequence } });
  const entry = changes.parsePublicReleaseChange((await transaction.get(firestore.doc(
    `${changes.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(accepted.changeSequence).padStart(16, "0")}`))).data());
  if (entry.entryDigest !== originalEntryDigest) refuse();
  return Object.freeze({ switchOperationId: selector.switchOperationId, switchReceiptDigest: hash(receipt), switchWitnessDigest: hash(witness),
    switchCoverageDigest: qualification.coverageDigest, workCensusDigest: coverage.workCensusDigest as string, originalEntryDigest });
}
