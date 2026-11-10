import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import type { PairAdmission } from "../../functions/lib/public-release-admission";
import type { PairPublicationTerminalReceipt, CompletedPairPublicationExecution } from "../../functions/lib/public-release-terminal";
import admission from "../../functions/lib/public-release-admission.js";
import protocol from "../../functions/lib/public-release-pair.js";
import terminal from "../../functions/lib/public-release-terminal.js";
import holds, { type RehearsalHoldPlan, type RehearsalHoldOutcome } from "../../functions/lib/public-release-rehearsal-hold.js";
import inclusion from "../../functions/lib/public-release-inclusion.js";
import type { PairPublicationInclusion, PairPublicationInclusionMember, PairPublicationInclusionPage } from "../../functions/lib/public-release-inclusion";
import work from "../../functions/lib/public-release-pair-work.js";
import serving from "../../functions/lib/public-release-serving.js";
import views from "../../functions/lib/public-release-pair-view.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import { isPublicPairRequestPath, readPublicReleasePairOutput } from "../../workers/src/public-release-view-reader";
import { originFor } from "../../packages/content-core/src/public-release-routing";
import { openPublicReleasePairInput } from "./public-release-pair-input-storage";
import { openStagedPublicReleasePairComposite } from "./public-release-pair-composite-storage";
import { preparePublicReleasePairSourceCensus, assertPublicReleasePairSourceCensusInTransaction, type PairSourceMetadata,
  type PairSourceCursor } from "./public-release-pair-source-census";
import { trackQualificationTransactionReads, assertQualificationTransactionReadBudget } from "./public-release-pair-qualification-source";
import { type PairViewStore } from "./public-release-pair-view-storage";
import { assertPublicReleaseSwitchInclusionInTransaction, type PairSwitchInclusionAuthority } from "./public-release-inclusion-switch";

const require = createRequire(import.meta.url), sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const ROOT = "system/publicDeployment", PROOFS = `${admission.ADMISSIONS}/canonicalProofs`, COVERAGE = `${admission.ADMISSIONS}/coverageProofs`;
const codeSelector = (selector: PublicReleaseSelector) => { const { contentHead: _content, ...code } = selector; return code; };
const sourcePath = (source: PairAdmission["source"]) => source.kind === "page" ? `cmsPages/${source.id}`
  : source.kind === "post" || source.kind === "record" ? `cmsPosts/${source.id}` : source.kind === "settings" ? `cmsSettings/${source.id}` : null;
export class PublicReleaseTerminalPendingError extends Error {
  readonly code = "pair-publication-not-proven";
  constructor() { super("The original publication is waiting for current public proof"); this.name = "PublicReleaseTerminalPendingError"; }
}
export class PublicReleaseInclusionCapacityError extends protocol.PublicReleaseProtocolError {
  readonly code = "pair-inclusion-transaction-limit";
  constructor() { super(); this.name = "PublicReleaseInclusionCapacityError"; this.message = "The inclusion proof exceeds the shared transaction read budget"; }
}
/** Advisory early refusal using actual preparer measurements, never a proof
 * or replacement for the final opaque SDK read tracker. */
export function assertPublicReleaseInclusionReadCapacity(sourceReads: number, lineageAndExecutionReads: number, outputCount: number,
  environment: PublicReleasePair["environment"] = "production") {
  if ([sourceReads, lineageAndExecutionReads, outputCount].some(value => !Number.isSafeInteger(value) || value < 1)) refuse();
  if (!["production", "development"].includes(environment)) refuse();
  const holdReads = environment === "development" ? 3 : 0;
  if (sourceReads + lineageAndExecutionReads + 17 + holdReads + Math.ceil(outputCount / inclusion.INCLUSION_PAGE_LIMIT) > 500)
    throw new PublicReleaseInclusionCapacityError();
}
function refuse(): never { throw new PublicReleaseTerminalPendingError(); }
/** Supply the actual private ingress RPC binding. A public fetch response or
 * a request header is never this authority. No default implementation exists. */
export type PublicReleaseCanonicalIngress = { prove(request: Request, expectedBodyDigest: string,
  expected: { status: 200 | 302 | 308 | 410 }): Promise<Response> };
type Options = { firestore: Firestore; store: PairViewStore; ingress: PublicReleaseCanonicalIngress; operationId: string;
  /** The same SDK installation that created firestore owns its transforms. */
  fieldValues: { serverTimestamp(): object };
  now?: () => number; signal?: AbortSignal };
export type PreparedPublicReleaseTerminal = Readonly<{ operationId: string; selectorDigest: string; canonicalProofDigest: string }>;
type Data = { firestore: Firestore; pair: PublicReleasePair; originalPair: PublicReleasePair; admission: PairAdmission;
  execution: CompletedPairPublicationExecution | null; selector: PublicReleaseSelector; metadata: PairSourceMetadata; cursor: PairSourceCursor;
  activationPath: string; activationDigest: string; receipt: PairPublicationTerminalReceipt; canonical: unknown; coverage: unknown;
  inclusion: PairPublicationInclusion | null; inclusionAuthority: PairSwitchInclusionAuthority | null;
  successor?: { admission: PairAdmission; receipt: PairPublicationTerminalReceipt };
  preparedAt: number; now: () => number; serverTimestamp: () => object; signal?: AbortSignal };
const prepared = new WeakMap<PreparedPublicReleaseTerminal, Data>();
function fresh(data: Data) {
  const at = data.now();
  if (!Number.isFinite(at) || at < data.preparedAt || at - data.preparedAt >= 3_000) refuse();
}

async function canonicalBytes(response: Response, signal: AbortSignal) {
  if (Number(response.headers.get("content-length")) > views.BODY_BYTES_LIMIT) refuse();
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let count = 0;
  try { if (reader) for (;;) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
    count += part.value.length; if (count > views.BODY_BYTES_LIMIT) refuse(); chunks.push(part.value); } }
  finally { await reader?.cancel().catch(() => {}); }
  return new Uint8Array(Buffer.concat(chunks));
}
async function selectedInput(options: Options, pair: PublicReleasePair, identity: PairTaskIdentity, signal: AbortSignal) {
  const receipt = (await options.firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/inputs/${identity.inputManifestDigest}`).get()).data();
  return openPublicReleasePairInput({ firestore: options.firestore, store: options.store, pair,
    identity, expectedSource: receipt?.source, expectedCursor: receipt?.cursor, signal });
}

/** Prepare from actual completed original G, selected H, current source census
 * and complete canonical responses. The returned process-local handle cannot
 * be manufactured by serializing a success flag or a receipt-shaped object. */
export async function preparePublicReleasePublicationTerminal(options: Options): Promise<PreparedPublicReleaseTerminal> {
  return prepareCurrentPublication(options, false);
}
async function prepareCurrentPublication(options: Options, settledSuccess: boolean): Promise<PreparedPublicReleaseTerminal> {
  const { firestore, store, operationId } = options, now = options.now ?? (() => performance.now());
  const startedAt = now();
  if (!Number.isFinite(startedAt) || startedAt < 0 || typeof options.fieldValues?.serverTimestamp !== "function" ||
      typeof options.ingress?.prove !== "function" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) refuse();
  const serverTimestamp = options.fieldValues.serverTimestamp.bind(options.fieldValues);
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  const initial = await firestore.runTransaction(async transaction => {
    const [acceptedRow, queueRow, root] = await transaction.getAll(firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`),
      firestore.doc(`cmsPublishQueue/${operationId}`), firestore.doc(ROOT));
    const accepted = admission.parseAdmission(acceptedRow.data()), queue = queueRow.data(); admission.assertQueue(queue, accepted);
    const execution = terminal.parseCompletedPairPublicationExecution(queue?.execution), selector = protocol.parseStoredPublicReleaseSelector(root.data());
    if (accepted.operationId !== operationId || !(settledSuccess ? queue?.status === "success" : ["pending", "publishing"].includes(queue?.status)) ||
        execution.identity.sourceOperationId !== operationId || execution.identity.sourceVersion !== accepted.source.sourceVersion ||
        execution.identity.snapshotDigest !== accepted.source.snapshotDigest || execution.identity.contextSequence !== accepted.changeSequence ||
        execution.pairDigest !== accepted.pairDigest || !same(execution.pair, accepted.pair) || selector.contentHead.contextSequence < accepted.changeSequence) refuse();
    const [originalRow, pairRow, currentSource] = await transaction.getAll(firestore.doc(work.publicReleasePairPath(accepted.pair.pairId)),
      firestore.doc(work.publicReleasePairPath(selector.selectedPair.pairId)), firestore.doc(admission.ownerPath(accepted.source)));
    const originalPair = protocol.parsePublicReleasePair(originalRow.data()), pair = protocol.parsePublicReleasePair(pairRow.data());
    work.assertPublicReleasePairDatabase(firestore, pair); work.assertPublicReleasePairDatabase(firestore, originalPair);
    if (protocol.publicReleaseDigest(originalPair) !== accepted.pairDigest ||
        !same(protocol.publicReleasePairReference(pair), selector.selectedPair) || currentSource.data()?.operationId !== operationId ||
        currentSource.data()?.admissionDigest !== protocol.publicReleaseDigest(accepted)) refuse();
    await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair: originalPair,
      taskId: execution.taskId, claimDigest: execution.claimDigest, manifestDigest: execution.manifestDigest });
    if (settledSuccess) {
      const prior = await terminal.assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction,
        operationId, admissionDigest: protocol.publicReleaseDigest(accepted) });
      if (prior.outcome !== "success") refuse();
    } else {
      const identity = execution.identity;
      await admission.assertRetainedPairAdmissionInTransaction({ firestore, transaction, pair: originalPair, scope: { kind: "accepted",
        sourceOperationId: identity.sourceOperationId, sourceVersion: identity.sourceVersion,
        snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence } });
    }
    return { accepted, execution, selector, pair, originalPair };
  }, { readOnly: true });
  const { accepted, execution, selector, pair, originalPair } = initial;
  // One immutable H may prove many output routes. Reuse only its verified
  // process-local reader inside this preparation; every route still gets an
  // actual current decision/canonical GET and the final source census guard.
  const inputs = new Map<string, ReturnType<typeof selectedInput>>();
  const openInput = (identity: PairTaskIdentity) => {
    const key = protocol.publicReleaseDigest(identity), prior = inputs.get(key);
    if (prior) return prior;
    const opened = selectedInput(options, pair, identity, signal);
    if (inputs.size < 32) inputs.set(key, opened);
    return opened;
  };
  const original = await openStagedPublicReleasePairComposite({ firestore, store, pair: originalPair, identity: execution.identity,
    claimDigest: execution.claimDigest, viewManifestDigest: execution.manifestDigest, signal });
  // Exhaust every original member with bounded independent reads. Reading
  // order grants no authority; each member still hashes its exact own bytes.
  for (let offset = 0; offset < original.manifest.members.length; offset += 4) {
    await Promise.all(original.manifest.members.slice(offset, offset + 4).map(async member => { await original.readMember(member.path); }));
  }
  const witness = replay.parseReplayWitness((await firestore.doc(
    `${work.publicReleasePairPath(pair.pairId)}/replayWitnesses/${selector.contentHead.viewId}`).get()).data(), pair);
  if (protocol.publicReleaseDigest(witness) !== selector.contentHead.viewId ||
      witness.contentViewDigest !== selector.contentHead.manifestDigest || witness.headCursor.sequence !== selector.contentHead.contextSequence) refuse();
  const selected = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair, headCursor: witness.headCursor,
    witnessDigest: selector.contentHead.viewId, selectedViews: [] });
  const currentInput = await openInput(selected.headView.identity);
  const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await currentInput.readFile("source-metadata.json"))) as PairSourceMetadata;
  // A current re-proof of an already issued successor FACT creates no new
  // SUCCESS for it. Only an unsettled original operation transfers settlement.
  const transferring = !settledSuccess && originalPair.pairId !== pair.pairId;
  const inclusionPreparation = transferring ? await firestore.runTransaction(async originalTransaction => {
    const tracker = trackQualificationTransactionReads(originalTransaction), transaction = tracker.transaction;
    const authority = await assertPublicReleaseSwitchInclusionInTransaction({ firestore, transaction, selector, originalPair, selectedPair: pair, accepted });
    await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair: originalPair,
      taskId: execution.taskId, claimDigest: execution.claimDigest, manifestDigest: execution.manifestDigest });
    return { authority, readCount: tracker.readCount() };
  }, { readOnly: true }) : null;
  const inclusionAuthority = inclusionPreparation?.authority ?? null;
  const originalMembers = new Map(original.manifest.members.map(member => [member.path, member]));
  const inclusionMembers: PairPublicationInclusionMember[] = [];
  const paths = original.manifest.members.filter(member => member.role !== "catalog" && isPublicPairRequestPath(member.path)).map(member => member.path);
  if (!paths.length || paths.length > views.VIEW_OUTPUT_LIMIT) refuse();
  const selectorDigest = protocol.publicReleaseDigest(selector), proofs: unknown[] = [];
  const provePath = async (path: string) => {
    signal.throwIfAborted();
    const selection = await serving.readPublicReleaseSelector({ firestore, environment: pair.environment });
    if (!same(selection.selector, selector)) refuse();
    const decision = await serving.readPublicReleaseDecision({ firestore, environment: pair.environment, pair, selection, path,
      composedReadersEnabled: true });
    if (decision.kind !== "decision") refuse();
    const proofLocator = decision.composition?.proofLocator ?? decision.locator;
    const frozen = await openInput(proofLocator.identity);
    const selected = decision.route.kind === "gone" || decision.route.kind === "redirect" ? null
      : await readPublicReleasePairOutput({ store, pair, locator: decision.locator, path: decision.composition?.artifactPath ?? path });
    const status = decision.route.kind === "gone" ? 410 : decision.route.kind === "redirect" ? 308 : selected?.status;
    const expectedDigest = status === 410 || status === 308 ? sha(new Uint8Array()) : selected?.bodyDigest;
    if (!expectedDigest || !status || ![200, 302, 308, 410].includes(status)) refuse();
    const response = await options.ingress.prove(new Request(`${originFor(pair.environment)}${path}`, { method: "GET", redirect: "manual", signal }),
      expectedDigest, { status });
    const bytes = await canonicalBytes(response, signal), bodyDigest = sha(bytes);
    const headers = { origin: response.headers.get("x-njpbs-publication-origin"), selector: response.headers.get("x-njpbs-selector-sha256"),
      epoch: response.headers.get("x-njpbs-release-epoch"), pair: response.headers.get("x-njpbs-release-pair"),
      head: response.headers.get("x-njpbs-content-head-sha256"), operation: response.headers.get("x-njpbs-publication-operation"),
      version: response.headers.get("x-njpbs-source-version"), snapshot: response.headers.get("x-njpbs-snapshot-sha256"),
      renderer: response.headers.get("x-njpbs-renderer-sha"), body: response.headers.get("x-njpbs-html-sha256") };
    const source = decision.route.kind === "unowned" ? frozen.root.scope : decision.route;
    const sourceOperationId = "sourceOperationId" in source ? source.sourceOperationId : source.operationId;
    if (response.status !== status || bodyDigest !== expectedDigest || headers.body !== bodyDigest ||
        headers.origin !== (pair.environment === "production" ? "njpbs-production" : "template-dev-public") ||
        headers.selector !== selectorDigest || headers.epoch !== String(selector.epoch) || headers.pair !== pair.pairId ||
        headers.head !== selector.contentHead.manifestDigest || headers.renderer !== pair.commitSha ||
        headers.operation !== sourceOperationId || headers.version !== String(source.sourceVersion) || headers.snapshot !== source.snapshotDigest ||
        [302, 308].includes(status) && response.headers.get("location") !== (decision.route.kind === "redirect" ? decision.route.canonicalPath : selected?.headers.location)) refuse();
    const inclusionMember = transferring ? (() => {
      const member = originalMembers.get(path)!;
      return { path, originalStatus: member.status, originalBodyDigest: member.sha256,
        selectedStatus: status as 200 | 302 | 308 | 410, selectedBodyDigest: bodyDigest,
        selectedOutputLocatorDigest: protocol.publicReleaseDigest(decision.locator), selectedProofLocatorDigest: protocol.publicReleaseDigest(proofLocator) };
    })() : null;
    return { proof: { path, status, bodyDigest, bytes: bytes.length, headers, locator: decision.locator }, inclusionMember };
  };
  // Preserve canonical path order for both proofs and inclusion evidence while
  // retaining main's bounded fresh selector/ingress reads for every route.
  for (let offset = 0; offset < paths.length; offset += 4) {
    const batch = await Promise.all(paths.slice(offset, offset + 4).map(provePath));
    for (const result of batch) {
      proofs.push(result.proof);
      if (result.inclusionMember) inclusionMembers.push(result.inclusionMember);
    }
  }
  const cursorRow = (await firestore.doc("system/publicReleaseChanges").get()).data()!;
  const cursor = { baselineDigest: cursorRow.baselineDigest, sequence: cursorRow.sequence, lastDigest: cursorRow.lastDigest };
  const census = await preparePublicReleasePairSourceCensus({ firestore, expected: metadata, cursor, signal });
  if (!same(protocol.parseStoredPublicReleaseSelector((await firestore.doc(ROOT).get()).data()), selector)) refuse();
  // Advisory early refusal only. The actual tracked final transaction remains
  // authoritative. Reserve its 12 fixed reads, five inclusion-root/fact reads,
  // actual original-execution/lineage reads and every actual output page.
  if (inclusionPreparation) assertPublicReleaseInclusionReadCapacity(census.readCount, inclusionPreparation.readCount, paths.length, originalPair.environment);
  if (!census.transactionEligible) refuse();
  const base = work.publicReleasePairPath(pair.pairId), contentActivationPath = `${base}/publicationActivations/${operationId}`;
  let activationPath = contentActivationPath, activationRow = (await firestore.doc(activationPath).get()).data();
  let activation: PairPublicationTerminalReceipt["activation"];
  if (activationRow) {
    const owner = require("../../functions/lib/public-release-content-activation.js");
    const record = owner.parseContentActivationRecord(activationRow, owner.parseContentActivationAttempt(activationRow.attempt));
    if (record.attempt.operationId !== operationId || record.attempt.admissionDigest !== protocol.publicReleaseDigest(accepted) ||
        !same(record.attempt.pair, pair) || record.contentHead.contextSequence > selector.contentHead.contextSequence) refuse();
    activation = { kind: "pair-publication", operationId, receiptDigest: protocol.publicReleaseDigest(record) };
  } else {
    activationPath = `${ROOT}/switchReceipts/${selector.switchOperationId}`;
    activationRow = (await firestore.doc(activationPath).get()).data();
    const committed = protocol.parsePublicReleaseSelector(activationRow?.selector);
    if (activationRow?.schemaVersion !== 2 || activationRow.operationId !== selector.switchOperationId ||
        activationRow.selectorDigest !== protocol.publicReleaseDigest(committed) || !same(codeSelector(committed), codeSelector(selector))) refuse();
    activation = { kind: "pair-switch", operationId: selector.switchOperationId, receiptDigest: protocol.publicReleaseDigest(activationRow) };
  }
  const canonical = { schemaVersion: 2, operationId, selectorDigest, proofs }, baseCoverage = { schemaVersion: 2, operationId,
    admissionDigest: protocol.publicReleaseDigest(accepted), originalExecution: execution, originalComposite: original.proof,
    selectedPairDigest: protocol.publicReleaseDigest(pair), selectedHeadView: selected.headView, metadataDigest: metadata.digest, cursor };
  if (Buffer.byteLength(JSON.stringify(canonical)) > 750_000) refuse();
  let inclusionProof: PairPublicationInclusion | null = null;
  const inclusionPages: PairPublicationInclusionPage[] = [];
  if (inclusionAuthority) {
    for (let offset = 0; offset < inclusionMembers.length; offset += inclusion.INCLUSION_PAGE_LIMIT) {
      inclusionPages.push(inclusion.parsePairPublicationInclusionPage({ schemaVersion: 2, kind: "pair-publication-inclusion-page",
        operationId, originalPairDigest: accepted.pairDigest, selectedPairDigest: protocol.publicReleaseDigest(pair),
        index: inclusionPages.length, members: inclusionMembers.slice(offset, offset + inclusion.INCLUSION_PAGE_LIMIT) }));
    }
    inclusionProof = inclusion.parsePairPublicationInclusion({ schemaVersion: 2, kind: "pair-publication-inclusion", operationId,
      admissionDigest: protocol.publicReleaseDigest(accepted), originalPair: accepted.pair, selectedPair: selector.selectedPair,
      originalPairDigest: accepted.pairDigest, selectedPairDigest: protocol.publicReleaseDigest(pair),
      originalRendererDigest: originalPair.rendererDigest, selectedRendererDigest: pair.rendererDigest,
      originalExecutionDigest: protocol.publicReleaseDigest(execution), originalCompositeProofDigest: protocol.publicReleaseDigest(original.proof),
      sourceVersion: accepted.source.sourceVersion, snapshotDigest: accepted.source.snapshotDigest, contextSequence: accepted.changeSequence,
      selectorDigest, selectedHeadViewDigest: protocol.publicReleaseDigest(selected.headView), selectedSourceMetadataDigest: metadata.digest,
      ...inclusionAuthority, canonicalProofDigest: protocol.publicReleaseDigest(canonical),
      outputs: { count: inclusionMembers.length, pages: inclusionPages.map(protocol.publicReleaseDigest) } });
  }
  const coverage = inclusionProof ? { ...baseCoverage, inclusionProofDigest: protocol.publicReleaseDigest(inclusionProof) } : baseCoverage;
  const receipt = terminal.parsePairPublicationTerminalReceipt({ schemaVersion: 2, kind: "pair-publication-terminal", operationId,
    admissionDigest: protocol.publicReleaseDigest(accepted), outcome: "success", selector, selectorDigest, originalExecution: execution,
    activation, coverageDigest: protocol.publicReleaseDigest(coverage), canonicalProofDigest: protocol.publicReleaseDigest(canonical), supersededBy: null });
  if (inclusionProof) {
    const root = inclusionProof;
    // Private evidence precedes the FACT. These create-only records alone
    // never clear the original queue or claim public publication success.
    await firestore.runTransaction(async originalTransaction => {
      const tracker = trackQualificationTransactionReads(originalTransaction), transaction = tracker.transaction;
      const authority = await assertPublicReleaseSwitchInclusionInTransaction({ firestore, transaction,
        selector, originalPair, selectedPair: pair, accepted });
      if (!same(authority, inclusionAuthority)) refuse();
      const [owner, billing] = await transaction.getAll(firestore.doc(admission.ownerPath(accepted.source)), firestore.doc("system/billing"));
      if (owner.data()?.operationId !== operationId || owner.data()?.admissionDigest !== protocol.publicReleaseDigest(accepted) || billing.data()?.disabled === true) refuse();
      await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair: originalPair,
        taskId: execution.taskId, claimDigest: execution.claimDigest, manifestDigest: execution.manifestDigest });
      await assertPublicReleasePairSourceCensusInTransaction({ firestore, transaction, expected: metadata, cursor, signal });
      const facts: { path: string; value: object }[] = [
        { path: `${inclusion.INCLUSION_PROOFS}/${protocol.publicReleaseDigest(root)}`, value: root },
        ...inclusionPages.map(page => ({ path: `${inclusion.INCLUSION_PAGES}/${protocol.publicReleaseDigest(page)}`, value: page })),
        { path: `${PROOFS}/${receipt.canonicalProofDigest}`, value: canonical },
        { path: `${COVERAGE}/${receipt.coverageDigest}`, value: coverage },
      ];
      const rows = await transaction.getAll(...facts.map(fact => firestore.doc(fact.path)));
      rows.forEach((row, index) => { if (row.exists && !same(row.data(), facts[index].value)) refuse(); });
      assertQualificationTransactionReadBudget(tracker); signal.throwIfAborted();
      rows.forEach((row, index) => { if (!row.exists) transaction.create(row.ref, facts[index].value); });
    });
  }
  const handle = Object.freeze({ operationId, selectorDigest, canonicalProofDigest: receipt.canonicalProofDigest });
  const preparedAt = now();
  if (!Number.isFinite(preparedAt) || preparedAt < startedAt) refuse();
  prepared.set(handle, { firestore, pair, originalPair, admission: accepted, execution, selector, metadata, cursor, activationPath,
    activationDigest: protocol.publicReleaseDigest(activationRow), receipt, canonical, coverage, inclusion: inclusionProof,
    inclusionAuthority, preparedAt, now, serverTimestamp, signal: options.signal });
  return handle;
}

/** A newer same-source success never changes the meaning of the original
 * operation. Re-prove that successor's current canonical result, then issue
 * an explicit supersession, retaining a real original execution or null. */
export async function preparePublicReleasePublicationSupersession(options: Options & { successorOperationId: string }): Promise<PreparedPublicReleaseTerminal> {
  const { firestore, operationId, successorOperationId } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId) || operationId === successorOperationId) refuse();
  const original = await firestore.runTransaction(async transaction => {
    const [acceptedRow, queueRow] = await transaction.getAll(firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`),
      firestore.doc(`cmsPublishQueue/${operationId}`));
    const accepted = admission.parseAdmission(acceptedRow.data()), queue = queueRow.data(); admission.assertQueue(queue, accepted);
    if (accepted.operationId !== operationId || !["pending", "publishing", "failed"].includes(queue?.status)) refuse();
    const pair = protocol.parsePublicReleasePair((await transaction.get(firestore.doc(work.publicReleasePairPath(accepted.pair.pairId)))).data());
    work.assertPublicReleasePairDatabase(firestore, pair);
    await admission.assertRetainedPairAdmissionInTransaction({ firestore, transaction, pair, scope: { kind: "accepted",
      sourceOperationId: operationId, sourceVersion: accepted.source.sourceVersion,
      snapshotDigest: accepted.source.snapshotDigest, contextSequence: accepted.changeSequence } });
    const execution = queue?.execution === null ? null : terminal.parseCompletedPairPublicationExecution(queue?.execution);
    if (execution) {
      if (!same(execution.pair, accepted.pair) || execution.pairDigest !== accepted.pairDigest ||
          execution.identity.sourceOperationId !== operationId || execution.identity.sourceVersion !== accepted.source.sourceVersion ||
          execution.identity.snapshotDigest !== accepted.source.snapshotDigest || execution.identity.contextSequence !== accepted.changeSequence) refuse();
      await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair,
        taskId: execution.taskId, claimDigest: execution.claimDigest, manifestDigest: execution.manifestDigest });
    }
    return { accepted, pair, execution };
  }, { readOnly: true });
  const successorHandle = await prepareCurrentPublication({ ...options, operationId: successorOperationId }, true);
  const data = prepared.get(successorHandle)!;
  const successorReceipt = await firestore.runTransaction(transaction => terminal.assertPairPublicationTerminalReceiptInTransaction({
    firestore, transaction, operationId: successorOperationId, admissionDigest: protocol.publicReleaseDigest(data.admission) }), { readOnly: true });
  const a = original.accepted, b = data.admission;
  if (successorReceipt.outcome !== "success" || b.admissionSequence <= a.admissionSequence || b.source.kind !== a.source.kind ||
      b.source.id !== a.source.id || b.source.family !== a.source.family || b.source.sourceVersion < a.source.sourceVersion) refuse();
  const supersededBy = { operationId: successorOperationId, admissionDigest: protocol.publicReleaseDigest(b),
    terminalReceiptDigest: protocol.publicReleaseDigest(successorReceipt) };
  const canonical = { schemaVersion: 2, operationId, supersededBy, currentSuccessorProof: data.canonical };
  const coverage = { schemaVersion: 2, operationId, admissionDigest: protocol.publicReleaseDigest(a), originalExecution: original.execution,
    supersededBy, currentSuccessorCoverage: data.coverage };
  if ([canonical, coverage].some(value => Buffer.byteLength(JSON.stringify(value)) > 750_000)) refuse();
  const receipt = terminal.parsePairPublicationTerminalReceipt({ ...data.receipt, operationId, admissionDigest: protocol.publicReleaseDigest(a),
    outcome: "superseded", originalExecution: original.execution, supersededBy,
    canonicalProofDigest: protocol.publicReleaseDigest(canonical), coverageDigest: protocol.publicReleaseDigest(coverage) });
  const handle = Object.freeze({ operationId, selectorDigest: receipt.selectorDigest, canonicalProofDigest: receipt.canonicalProofDigest });
  fresh(data);
  prepared.set(handle, { ...data, originalPair: original.pair, admission: a, execution: original.execution,
    inclusion: null, inclusionAuthority: null,
    successor: { admission: b, receipt: successorReceipt }, receipt, canonical, coverage });
  return handle;
}

/** One private settlement transaction. Global pending count/XOR, immutable
 * proof/receipt, queue, exact original source marker and audit commit together. */
export async function settlePreparedPublicReleasePublication(input: { firestore: Firestore; proof: PreparedPublicReleaseTerminal }) {
  const result = await commitPreparedPublicReleasePublication(input);
  if (!("receipt" in result)) refuse();
  return result;
}

/** Release is storage authority for this one original only. Canonical bytes,
 * current census, G and inclusion run through the actual terminal guards below;
 * this branch creates no terminal receipt or successful publication. */
export async function releasePreparedPublicReleaseRehearsalHold(input: { firestore: Firestore; proof: PreparedPublicReleaseTerminal;
  plan: RehearsalHoldPlan; holdDigest: string; actionId: string; enabled?: boolean }) {
  if (input.enabled !== true) refuse();
  const plan = holds.parsePlan(input.plan), data = prepared.get(input.proof);
  if (!data || data.firestore !== input.firestore || !data.inclusion || !data.inclusionAuthority || data.successor || !data.execution ||
      plan.operationId !== data.admission.operationId || !same(plan.pair, data.originalPair) || !same(plan.targetPair, data.pair) ||
      data.selector.epoch !== plan.expectedEpoch + 1 || input.actionId !== plan.releaseActionId) refuse();
  const result = await commitPreparedPublicReleasePublication(input, { plan, holdDigest: input.holdDigest, actionId: input.actionId });
  if (!("outcome" in result)) refuse();
  return result;
}
async function commitPreparedPublicReleasePublication({ firestore, proof }: { firestore: Firestore; proof: PreparedPublicReleaseTerminal },
  release?: { plan: RehearsalHoldPlan; holdDigest: string; actionId: string }) {
  const data = prepared.get(proof); if (!data || data.firestore !== firestore) refuse();
  return firestore.runTransaction(async originalTransaction => {
    const tracker = trackQualificationTransactionReads(originalTransaction), transaction = tracker.transaction;
    const operationId = data.admission.operationId, receiptRef = firestore.doc(`${terminal.TERMINAL_RECEIPTS}/${operationId}`);
    const prior = await transaction.get(receiptRef);
    if (prior.exists && release) refuse();
    if (prior.exists) return { idempotent: true, receipt: await terminal.assertPairPublicationTerminalReceiptInTransaction({
      firestore, transaction, operationId, admissionDigest: data.receipt.admissionDigest }) };
    const held = await holds.stateInTransaction({ firestore, transaction, pair: data.originalPair, accepted: data.admission });
    if (release) {
      if (!held || !same(held.intent.plan, release.plan) || protocol.publicReleaseDigest(held.intent) !== release.holdDigest ||
          held.outcome && held.outcome.outcome !== "released") refuse();
      // Original immutable readback survives later source movement and expiry.
      if (held.outcome) return { idempotent: true, outcome: held.outcome };
      if (held.status !== "held") refuse();
    } else if (held?.status === "held") throw new holds.RehearsalPublicationHeldError();
    data.signal?.throwIfAborted();
    fresh(data);
    const [accepted, queue, marker, censusRow, root, sourceOwner, activation, billing] = await transaction.getAll(
      firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`), firestore.doc(`cmsPublishQueue/${operationId}`),
      firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`), firestore.doc(admission.ADMISSIONS), firestore.doc(ROOT),
      firestore.doc(admission.ownerPath(data.admission.source)), firestore.doc(data.activationPath), firestore.doc("system/billing"));
    const currentAdmission = admission.parseAdmission(accepted.data()), currentQueue = queue.data()!, census = admission.parseAdmissionHead(censusRow.data());
    admission.assertQueue(currentQueue, currentAdmission);
    const publicAdmission = data.successor?.admission ?? data.admission;
    if (!same(currentAdmission, data.admission) || !same(currentQueue.execution, data.execution) ||
        !(data.successor ? ["pending", "publishing", "failed"] : ["pending", "publishing"]).includes(currentQueue.status) ||
        marker.data()?.schemaVersion !== 2 || marker.data()?.operationId !== operationId || marker.data()?.admissionDigest !== data.receipt.admissionDigest ||
        !same(protocol.parseStoredPublicReleaseSelector(root.data()), data.selector) || sourceOwner.data()?.operationId !== publicAdmission.operationId ||
        sourceOwner.data()?.admissionDigest !== protocol.publicReleaseDigest(publicAdmission) || protocol.publicReleaseDigest(activation.data()) !== data.activationDigest ||
        billing.data()?.disabled === true || census.pendingCount < 1) refuse();
    if (data.execution) await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair: data.originalPair,
      taskId: data.execution.taskId, claimDigest: data.execution.claimDigest, manifestDigest: data.execution.manifestDigest });
    if (data.successor) {
      const successor = await terminal.assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction,
        operationId: data.successor.admission.operationId, admissionDigest: protocol.publicReleaseDigest(data.successor.admission) });
      if (successor.outcome !== "success" || !same(successor, data.successor.receipt)) refuse();
    }
    const path = sourcePath(data.admission.source), source = path ? await transaction.get(firestore.doc(path)) : null;
    await assertPublicReleasePairSourceCensusInTransaction({ firestore, transaction, expected: data.metadata, cursor: data.cursor, signal: data.signal });
    if (data.inclusion) {
      const authority = await assertPublicReleaseSwitchInclusionInTransaction({ firestore, transaction, selector: data.selector,
        originalPair: data.originalPair, selectedPair: data.pair, accepted: currentAdmission });
      if (!same(authority, data.inclusionAuthority)) refuse();
      const verified = await inclusion.assertPairPublicationInclusionInTransaction({ firestore, transaction,
        accepted: currentAdmission, receipt: data.receipt });
      if (!same(verified.proof, data.inclusion)) refuse();
    }
    const [canonicalRow, coverageRow] = await transaction.getAll(firestore.doc(`${PROOFS}/${data.receipt.canonicalProofDigest}`),
      firestore.doc(`${COVERAGE}/${data.receipt.coverageDigest}`));
    if (canonicalRow.exists && !same(canonicalRow.data(), data.canonical) || coverageRow.exists && !same(coverageRow.data(), data.coverage)) refuse();
    if (release) {
      const outcome: RehearsalHoldOutcome = holds.parseOutcome({ schemaVersion: 2, kind: "rehearsal-hold-outcome",
        holdDigest: release.holdDigest, bindingDigest: protocol.publicReleaseDigest(held!.binding), outcome: "released",
        actionId: release.actionId, observedAt: held!.observedAt, evidence: { epoch: data.selector.epoch,
          selectedPair: data.selector.selectedPair, selectorDigest: protocol.publicReleaseDigest(data.selector),
          executionDigest: protocol.publicReleaseDigest(data.execution), inclusion: data.inclusionAuthority,
          canonicalProofDigest: data.receipt.canonicalProofDigest, coverageDigest: data.receipt.coverageDigest } }, held!.intent, held!.binding);
      assertQualificationTransactionReadBudget(tracker);
      data.signal?.throwIfAborted(); fresh(data);
      transaction.create(firestore.doc(`${holds.path(operationId)}/receipts/outcome`), outcome);
      return { idempotent: false, outcome };
    }
    assertQualificationTransactionReadBudget(tracker);
    const nextCensus = admission.parseAdmissionHead({ ...census, pendingCount: census.pendingCount - 1,
      pendingDigest: admission.togglePendingDigest(census.pendingDigest, data.receipt.admissionDigest) });
    data.signal?.throwIfAborted();
    fresh(data);
    if (!canonicalRow.exists) transaction.create(canonicalRow.ref, data.canonical as object);
    if (!coverageRow.exists) transaction.create(coverageRow.ref, data.coverage as object);
    transaction.create(receiptRef, data.receipt);
    transaction.update(queue.ref, { status: data.receipt.outcome, terminalReceipt: protocol.publicReleaseDigest(data.receipt),
      completedAt: data.serverTimestamp(), error: null });
    transaction.delete(marker.ref); transaction.delete(firestore.doc(admission.publicationPendingPath(data.admission.pair.pairId, operationId)));
    transaction.set(censusRow.ref, nextCensus);
    if (source?.data()?.publishBuildQueueId === operationId) transaction.update(source.ref, { publishBuildPending: false, publishBuildQueueId: null,
      ...(data.successor ? {} : { publicSourceVersion: data.admission.source.action === "withdraw" ? null : data.admission.source.sourceVersion }),
      publishBuildSettlement: { status: data.receipt.outcome, sourceVersion: data.admission.source.sourceVersion,
        operation: data.admission.source.action === "withdraw" ? "withdraw" : "publish", queueId: operationId,
        pairTerminalReceiptDigest: protocol.publicReleaseDigest(data.receipt) } });
    const audit = require("../../functions/lib/audit.js").adminLogEntry({
      actorUid: "system:public-release-terminal", action: "public-release.publication-settle", source: "public-release-terminal", target: queue.ref.path,
      before: { status: currentQueue.status }, after: { status: data.receipt.outcome, terminalReceipt: protocol.publicReleaseDigest(data.receipt) } });
    // Keep the canonical audit shape and server time using this client's SDK.
    transaction.create(firestore.collection("admin_logs").doc(), { ...audit, timestamp: data.serverTimestamp() });
    return { idempotent: false, receipt: data.receipt };
  });
}
