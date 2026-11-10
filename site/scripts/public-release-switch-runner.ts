import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairViewStore } from "./public-release-pair-view-storage";
import type { PublicReleaseCanonicalIngress } from "./public-release-publication-terminal";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import admission from "../../functions/lib/public-release-admission.js";
import terminal from "../../functions/lib/public-release-terminal.js";
import serving from "../../functions/lib/public-release-serving.js";
import targets from "../../functions/lib/publication-target.js";
import { qualifyPublicReleasePair } from "./public-release-pair-qualification";
import { prepareGuardedPublicReleaseSwitch, applyPreparedGuardedPublicReleaseSwitch,
  readGuardedPublicReleaseSwitchAttempt, readGuardedPublicReleaseSwitchReceipt } from "./public-release-switch-operator";
import { readPublicReleasePairOutput } from "../../workers/src/public-release-view-reader";
import { bytesDigest, canonicalPath, readBoundedBody } from "./public-release-pair-reader-contract";

const hash = protocol.publicReleaseDigest, same = (a: unknown, b: unknown) => hash(a) === hash(b);
function refuse(): never { throw new Error("Public release switch runner refused; read the original operation"); }
type SwitchInput = { firestore: Firestore; from: PublicReleasePair; to: PublicReleasePair; operationId: string };

/** Historical commit and current authority are separate facts. Never turn a
 * missing receipt into permission to retry an uncertain reserved operation. */
export async function readPublicReleaseSwitchOutcome({ firestore, from, to, operationId }: SwitchInput) {
  [from, to].forEach(pair => work.assertPublicReleasePairDatabase(firestore, pair));
  const attempt = await readGuardedPublicReleaseSwitchAttempt({ firestore, operationId });
  const receipt = await readGuardedPublicReleaseSwitchReceipt({ firestore, operationId });
  if (attempt && (!same(attempt.oldPair, from) || !same(attempt.newPair, to))) refuse();
  if (receipt && !attempt) refuse();
  const current = await serving.readPublicReleaseSelector({ firestore, environment: from.environment });
  return { operationId, outcome: receipt ? "committed" as const : "unconfirmed" as const,
    attempt, receipt, currentSelector: current.selector,
    currentlySelected: same(current.selector.selectedPair, protocol.publicReleasePairReference(to)) };
}

/** Both directions use fresh native qualifications at the actual replay head.
 * Installed publishers must already have rendered/replayed current work. This
 * runner creates no source document, admission, scenario, rollout or hold. */
export async function runCurrentPublicReleaseSwitch(input: SwitchInput & { store: PairViewStore;
  qualificationAttemptId: string; credentials: readonly [() => Promise<HeadersInit>, () => Promise<HeadersInit>]; signal?: AbortSignal }) {
  const { firestore, store, from, to, operationId, qualificationAttemptId, credentials, signal } = input;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(qualificationAttemptId)) refuse();
  const prior = await readPublicReleaseSwitchOutcome(input);
  if (prior.attempt || prior.receipt) return { ...prior, recovered: true };
  try {
    const ids: string[] = [];
    for (const [index, pair] of [from, to].entries()) {
      signal?.throwIfAborted();
      const witness = await replay.sealPublicReleasePairReplayWitness({ firestore, pair });
      const qualificationId = `switch-${hash({ operationId, qualificationAttemptId, pair }).slice(0, 48)}`;
      await qualifyPublicReleasePair({ firestore, store, pair, qualificationId,
        witnessDigest: witness.witnessDigest, credentials: credentials[index], signal });
      ids.push(qualificationId);
    }
    const proof = await prepareGuardedPublicReleaseSwitch({ firestore, store, oldPair: from, newPair: to, operationId,
      oldQualificationId: ids[0], newQualificationId: ids[1], signal });
    await applyPreparedGuardedPublicReleaseSwitch({ firestore, proof });
  } catch {
    // The transaction may have committed before its response was lost. Read
    // the original immutable fact; never abandon, swap IDs or repeat apply.
    return { ...await readPublicReleaseSwitchOutcome(input), recovered: true };
  }
  return { ...await readPublicReleaseSwitchOutcome(input), recovered: false };
}

/** Read-only observation of an approved original staff operation. A pending
 * NEW operation can be observed through OLD without changing its owner or
 * settling it. Only the native terminal owner can acknowledge publication. */
export async function observeCurrentPublicReleaseOperation({ firestore, store, ingress, pair, operationId, path,
  sourceVersion, snapshotDigest, status, signal: callerSignal }: { firestore: Firestore; store: PairViewStore;
  ingress: PublicReleaseCanonicalIngress; pair: PublicReleasePair; operationId: string; path: string;
  sourceVersion: number; snapshotDigest: string; status: 200 | 302 | 308 | 410; signal?: AbortSignal }) {
  work.assertPublicReleasePairDatabase(firestore, pair);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId) || !canonicalPath(path) || path.startsWith("/_pair-") ||
      !Number.isSafeInteger(sourceVersion) || sourceVersion < 1 || !protocol.digest(snapshotDigest) || ![200, 302, 308, 410].includes(status)) refuse();
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(callerSignal ? [callerSignal] : [])]);
  const original = await firestore.runTransaction(async transaction => {
    const [acceptedRow, queueRow, receiptRow] = await transaction.getAll(firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`),
      firestore.doc(`cmsPublishQueue/${operationId}`), firestore.doc(`${terminal.TERMINAL_RECEIPTS}/${operationId}`));
    const accepted = admission.parseAdmission(acceptedRow.data()), queue = queueRow.data();
    admission.assertQueue(queue, accepted);
    if (accepted.operationId !== operationId || accepted.source.sourceVersion !== sourceVersion || accepted.source.snapshotDigest !== snapshotDigest) refuse();
    const originalPair = protocol.parsePublicReleasePair((await transaction.get(firestore.doc(work.publicReleasePairPath(accepted.pair.pairId)))).data());
    work.assertPublicReleasePairDatabase(firestore, originalPair);
    if (!same(accepted.pair, protocol.publicReleasePairReference(originalPair)) || accepted.pairDigest !== hash(originalPair)) refuse();
    const execution = queue?.execution ? terminal.parseCompletedPairPublicationExecution(queue.execution) : null;
    if (execution) await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair: originalPair,
      taskId: execution.taskId, claimDigest: execution.claimDigest, manifestDigest: execution.manifestDigest });
    const receipt = receiptRow.exists ? await terminal.assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction,
      operationId, admissionDigest: hash(accepted) }) : null;
    if (receipt ? receipt.outcome !== "success" : !["pending", "publishing"].includes(queue?.status)) refuse();
    return { accepted, receipt, execution, queueStatus: queue!.status };
  }, { readOnly: true });
  const selection = await serving.readPublicReleaseSelector({ firestore, environment: pair.environment });
  if (!same(selection.selector.selectedPair, protocol.publicReleasePairReference(pair)) ||
      selection.selector.contentHead.contextSequence < original.accepted.changeSequence) refuse();
  const decision = await serving.readPublicReleaseDecision({ firestore, environment: pair.environment, pair, selection, path, composedReadersEnabled: true });
  if (decision.kind !== "decision" || decision.route.kind === "unowned" || decision.route.operationId !== operationId ||
      decision.route.sourceVersion !== sourceVersion || decision.route.snapshotDigest !== snapshotDigest) refuse();
  const output = decision.route.kind === "serve" ? await readPublicReleasePairOutput({ store, pair, locator: decision.locator,
    path: decision.composition?.artifactPath ?? path }) : null;
  const expectedStatus = decision.route.kind === "gone" ? 410 : decision.route.kind === "redirect" ? 308 : output?.status;
  if (expectedStatus !== status) refuse();
  const bodyDigest = output?.bodyDigest ?? bytesDigest(new Uint8Array()), target = targets.publicationTarget(pair.environment);
  const response = await ingress.prove(new Request(`${target.origin}${path}`, { method: "GET", redirect: "manual", signal }), bodyDigest, { status });
  try {
    const bytes = await readBoundedBody(response.body ?? new ReadableStream({ start(controller) { controller.close(); } }), 16 * 1024 * 1024, signal);
    const headers = { "x-njpbs-publication-origin": target.workerName, "x-njpbs-selector-sha256": hash(selection.selector),
      "x-njpbs-release-epoch": String(selection.selector.epoch), "x-njpbs-release-pair": pair.pairId,
      "x-njpbs-content-head-sha256": selection.selector.contentHead.manifestDigest, "x-njpbs-renderer-sha": pair.commitSha,
      "x-njpbs-publication-operation": operationId, "x-njpbs-source-version": String(sourceVersion),
      "x-njpbs-snapshot-sha256": snapshotDigest, "x-njpbs-html-sha256": bodyDigest };
    if (response.status !== status || response.redirected || bytesDigest(bytes) !== bodyDigest ||
        Object.entries(headers).some(([key, value]) => response.headers.get(key) !== value) ||
        !["no-store", "private, no-store"].includes(response.headers.get("cache-control") ?? "") ||
        response.headers.get("location") !== (decision.route.kind === "redirect" ? decision.route.canonicalPath : status === 302 ? output?.headers.location : null) ||
        status === 302 && response.headers.get("x-robots-tag") !== "noindex, nofollow") refuse();
    const after = await serving.readPublicReleaseSelector({ firestore, environment: pair.environment });
    if (!same(after.selector, selection.selector) || !same(decision, await serving.readPublicReleaseDecision({
      firestore, environment: pair.environment, pair, selection: after, path, composedReadersEnabled: true }))) refuse();
    signal.throwIfAborted();
    return { operationId, path, sourceVersion, snapshotDigest, status, bodyDigest, bytes: bytes.length,
      admissionDigest: hash(original.accepted), originalPair: original.accepted.pair, queueStatus: original.queueStatus,
      originalExecutionDigest: original.execution ? hash(original.execution) : null,
      terminalReceiptDigest: original.receipt ? hash(original.receipt) : null, selector: selection.selector,
      selectorDigest: hash(selection.selector), locatorDigest: hash(decision.locator) };
  } finally { await response.body?.cancel().catch(() => {}); }
}
