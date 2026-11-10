import { createRequire } from "node:module";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import bootstrap from "../../functions/lib/public-release-bootstrap.js";
import protocol from "../../functions/lib/public-release-pair.js";
import pointers from "../../functions/lib/public-deployment-pointer.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import fence from "../../functions/lib/public-release-bootstrap-admission.js";
import enrollment from "../../functions/lib/public-release-change-enrollment.js";
import admissions from "../../functions/lib/public-release-admission.js";
import media from "../../functions/lib/public-release-pair-media.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { exact, withinReaderDeadline } from "./public-release-pair-reader-contract";
import { prepareMeasuredBootstrapQualification } from "./public-release-bootstrap-read-budget";
import { prepareInitialBootstrapInstalledGuard } from "./public-release-bootstrap-installed-guard";
import { prepareBootstrapIngressProof, assertPreparedBootstrapIngress } from "./public-release-bootstrap-ingress-proof";
import type { PairViewStore } from "./public-release-pair-view-storage";

const require = createRequire(import.meta.url), hash = protocol.publicReleaseDigest, same = (a: unknown, b: unknown) => hash(a) === hash(b);
const ROOT = "system/publicDeployment", RECEIPTS = "system/publicReleaseAdmissions/bootstrapResumes";
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function refuse(): never { throw new Error("Logged bootstrap resume was refused"); }
export type BootstrapResumeAttempt = Readonly<{ schemaVersion: 2; operationId: string;
  bootstrap: ReturnType<typeof bootstrap.parseBootstrapAttempt>; qualifications: ReturnType<typeof bootstrap.parseBootstrapAttempt>["qualifications"] }>;
export function parseBootstrapResumeAttempt(raw: unknown): BootstrapResumeAttempt {
  const value = exact(structuredClone(raw), ["schemaVersion", "operationId", "bootstrap", "qualifications"]);
  if (value.schemaVersion !== 2 || typeof value.operationId !== "string" || !pointers.isPublicDeploymentIdentifier(value.operationId)) refuse();
  const original = bootstrap.parseBootstrapAttempt(value.bootstrap);
  const current = bootstrap.parseBootstrapAttempt({ ...original, qualifications: value.qualifications });
  return Object.freeze({ schemaVersion: 2, operationId: value.operationId, bootstrap: original, qualifications: current.qualifications });
}
function receiptPath(attempt: BootstrapResumeAttempt) { return `${RECEIPTS}/${attempt.operationId}`; }
function originalResumeReceipt(raw: unknown, fenceValue: unknown, attempt: BootstrapResumeAttempt) {
  const receipt = exact(raw, ["schemaVersion", "kind", "operationId", "attempt", "attemptDigest", "closeAttemptDigest", "selectorDigest",
    "bootstrapReceiptDigest", "controlsReceiptDigest", "enrollmentReceiptDigest", "ingress", "readMeasurement", "producer", "adoption"]);
  const opened = fence.parseBootstrapAdmissionFence(fenceValue);
  if (receipt.schemaVersion !== 2 || receipt.kind !== "public-release-bootstrap-resume" || receipt.operationId !== attempt.operationId ||
      receipt.attemptDigest !== hash(attempt) || !same(receipt.attempt, attempt) ||
      ![receipt.closeAttemptDigest, receipt.selectorDigest, receipt.bootstrapReceiptDigest, receipt.controlsReceiptDigest, receipt.enrollmentReceiptDigest].every(digest) ||
      opened.status !== "open" || opened.operationId !== attempt.bootstrap.operationId || opened.attemptDigest !== receipt.closeAttemptDigest ||
      opened.resumeReceiptDigest !== hash(receipt)) refuse();
  return receipt;
}
function paths(attempt: BootstrapResumeAttempt) {
  const id = attempt.bootstrap.operationId, pairs = [attempt.bootstrap.currentPair, attempt.bootstrap.recoveryPair];
  return [ROOT, fence.BOOTSTRAP_ADMISSION_FENCE_PATH, `${ROOT}/releaseWriter/fence`, `${fence.BOOTSTRAP_ADMISSION_ATTEMPTS}/${id}`,
    `${ROOT}/bootstrapSelectors/${id}`, `system/publicReleaseAdmissions/bootstrapControls/${id}`, enrollment.ENROLLMENT_PATH,
    "system/publicReleaseChanges", "system/publicReleaseChangeLog", `${admissions.ADMISSIONS}/controls/adoption`, admissions.ADMISSIONS,
    `${ROOT}/pairMedia/current`, "system/billing", ...pairs.map(pair => `${work.publicReleasePairPath(pair.pairId)}/heads/current`),
    ...pairs.map(pair => work.publicReleasePairPath(pair.pairId)), ...pairs.map(pair => `${work.publicReleasePairPath(pair.pairId)}/controls/runtime`)];
}
async function authority(firestore: Firestore, transaction: Transaction, attempt: BootstrapResumeAttempt) {
  const rows = await transaction.getAll(...paths(attempt).map(path => firestore.doc(path))), values = rows.map(row => row.data() ?? null);
  const original = attempt.bootstrap, pairs = [original.currentPair, original.recoveryPair];
  const selector = protocol.parseStoredPublicReleaseSelector(values[0]), closed = fence.parseBootstrapAdmissionFence(values[1]);
  const closeAttempt = exact(values[3], ["schemaVersion", "operationId", "environment", "legacyPointerDigest"]);
  if (selector.epoch !== 1 || selector.switchOperationId !== original.operationId || selector.contentHead.contextSequence !== 0 ||
      !same(selector.selectedPair, protocol.publicReleasePairReference(pairs[0])) || !same(selector.recoveryPair, protocol.publicReleasePairReference(pairs[1])) ||
      selector.admittedContractDigest !== original.admittedContractDigest || closed.status !== "closed" || closed.operationId !== original.operationId ||
      closeAttempt.schemaVersion !== 2 || closeAttempt.operationId !== original.operationId || closeAttempt.environment !== pairs[0].environment ||
      hash(closeAttempt) !== closed.attemptDigest || closeAttempt.legacyPointerDigest !== adoption.legacyBootstrapPointerDigest(pointers.readPublicDeploymentPointer(values[0])) ||
      !same(values[2], { schemaVersion: 2, operationId: closed.operationId, attemptDigest: closed.attemptDigest }) ||
      (values[12] as { disabled?: unknown } | null)?.disabled === true) refuse();
  const rootReceipt = exact(values[4], ["schemaVersion", "kind", "operationId", "attemptDigest", "sourceDigest", "selectorDigest", "storedSelectorDigest", "mediaDigest", "selector"]);
  const pairMedia = media.parsePairMedia(values[11], selector);
  if (rootReceipt.schemaVersion !== 2 || rootReceipt.kind !== "public-release-bootstrap" || rootReceipt.operationId !== original.operationId ||
      rootReceipt.attemptDigest !== hash(original) || rootReceipt.sourceDigest !== original.expectedSourceDigest || rootReceipt.selectorDigest !== hash(selector) ||
      rootReceipt.storedSelectorDigest !== hash(values[0]) || !same(rootReceipt.selector, selector) || rootReceipt.mediaDigest !== hash(pairMedia)) refuse();
  const enrolled = enrollment.parsePublicReleaseChangeEnrollmentReceipt(values[6]);
  const controls = exact(values[5], ["schemaVersion", "kind", "attempt", "attemptDigest", "enrollmentReceiptDigest", "installed", "before", "after"]);
  if (controls.schemaVersion !== 2 || controls.kind !== "public-release-bootstrap-controls" || controls.enrollmentReceiptDigest !== hash(enrolled) ||
      !same(values[7], enrolled.initialHead) || enrolled.initialHead.sequence !== 0 ||
      !same(values[8], { schemaVersion: 2, enabled: false, pair: selector.selectedPair, head: enrolled.initialHead, logEpoch: enrolled.request.logEpoch }) ||
      !same(values[9], { schemaVersion: 2, enabled: false }) || !same(values[10], admissions.initialAdmissionHead())) refuse();
  for (const [index, pair] of pairs.entries()) {
    const head = exact(values[13 + index], ["schemaVersion", "pairDigest", "contentHead"]);
    const content = exact(head.contentHead, ["pairId", "viewId", "manifestDigest", "contextSequence"]);
    if (head.schemaVersion !== 2 || head.pairDigest !== hash(pair) || content.pairId !== pair.pairId || !digest(content.viewId) ||
        !digest(content.manifestDigest) || content.contextSequence !== 0 || index === 0 && !same(content, selector.contentHead) ||
        !pairMedia.references.some((reference: { pairId: string; manifestDigest: string }) => reference.pairId === pair.pairId && reference.manifestDigest === content.manifestDigest) ||
        !same(protocol.parsePublicReleasePair(values[15 + index]), pair) ||
        !same(values[17 + index], { schemaVersion: 2, pairId: pair.pairId, status: "retained" })) refuse();
  }
  const pending = await transaction.get(firestore.collection("cmsPublishQueue").where("status", "in", ["reserved", "pending", "publishing"]).limit(1));
  if (!pending.empty) refuse();
  // Operational billing counters do not change first-install authority.
  values[12] = { disabled: false };
  return { selector, closed, enrolled, rootReceipt, controls, values, digest: hash(values), producer: values[8] as Record<string, unknown> };
}

export type PreparedBootstrapResume = Readonly<{ operationId: string; attemptDigest: string; selectorDigest: string; ingressDigest: string }>;
type Data = { firestore: Firestore; attempt: BootstrapResumeAttempt; initial: Awaited<ReturnType<typeof authority>>;
  installed: Awaited<ReturnType<typeof prepareInitialBootstrapInstalledGuard>>;
  qualification: Awaited<ReturnType<typeof prepareMeasuredBootstrapQualification>>["qualificationGuard"];
  measurement: Awaited<ReturnType<typeof prepareMeasuredBootstrapQualification>>["measurement"];
  ingress: Awaited<ReturnType<typeof prepareBootstrapIngressProof>>; signal: AbortSignal };
const prepared = new WeakMap<PreparedBootstrapResume, Data>();

/** Readback is an original-outcome query, not a current readiness claim. It
 * works after a lost response without repeating provider or byte preparation. */
export async function readBootstrapResumeReceipt({ firestore, attempt: raw }: { firestore: Firestore; attempt: BootstrapResumeAttempt }) {
  const attempt = parseBootstrapResumeAttempt(raw); work.assertPublicReleasePairDatabase(firestore, attempt.bootstrap.currentPair);
  return firestore.runTransaction(async transaction => {
    const [row, fenceRow] = await transaction.getAll(firestore.doc(receiptPath(attempt)), firestore.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH));
    if (!row.exists) return null;
    return originalResumeReceipt(row.data(), fenceRow.data(), attempt);
  }, { readOnly: true });
}

/** Only actual owners create the process-local handle. The store and ingress
 * arguments are trusted operator bindings, never serialized readiness input. */
export async function prepareBootstrapLoggedResume({ firestore, attempt: raw, store, request = fetch, evidence, signal: requested }: {
  firestore: Firestore; attempt: BootstrapResumeAttempt; store: PairViewStore; request?: typeof fetch;
  evidence?: Parameters<typeof prepareInitialBootstrapInstalledGuard>[0]["evidence"]; signal?: AbortSignal;
}): Promise<PreparedBootstrapResume> {
  const attempt = parseBootstrapResumeAttempt(raw); work.assertPublicReleasePairDatabase(firestore, attempt.bootstrap.currentPair);
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(requested ? [requested] : [])]);
  signal.throwIfAborted();
  const initial = await withinReaderDeadline(signal, () => firestore.runTransaction(transaction => authority(firestore, transaction, attempt), { readOnly: true }));
  signal.throwIfAborted();
  const current = bootstrap.parseBootstrapAttempt({ ...attempt.bootstrap, qualifications: attempt.qualifications });
  const proof = await prepareBootstrapIngressProof({ firestore, store, pair: attempt.bootstrap.currentPair,
    selector: initial.selector, qualification: attempt.qualifications[0], request, signal });
  signal.throwIfAborted();
  const installed = await withinReaderDeadline(signal, () => prepareInitialBootstrapInstalledGuard({ firestore, attempt: attempt.bootstrap, evidence }));
  signal.throwIfAborted();
  // Keep the original qualification deadline: its measured full-closure read
  // runs last, leaving at least 15s of its shared 30s for final source/CAS reads.
  const { qualificationGuard: qualification, measurement } = await prepareMeasuredBootstrapQualification({ firestore, attempt: current, store, signal });
  signal.throwIfAborted();
  const after = await withinReaderDeadline(signal, () => firestore.runTransaction(transaction => authority(firestore, transaction, attempt), { readOnly: true }));
  signal.throwIfAborted();
  if (after.digest !== initial.digest) refuse();
  const handle = Object.freeze({ operationId: attempt.operationId, attemptDigest: hash(attempt), selectorDigest: hash(initial.selector), ingressDigest: hash(proof) });
  prepared.set(handle, { firestore, attempt, initial, qualification, measurement, installed, ingress: proof, signal });
  return handle;
}

/** One original SDK transaction opens only the logged schema-two producers.
 * It changes no selector, epoch, pin, capability, media or provider identity. */
export async function resumePreparedBootstrap({ firestore, proof, dryRun = true }: { firestore: Firestore; proof: PreparedBootstrapResume; dryRun?: boolean }) {
  const data = prepared.get(proof);
  if (!data || data.firestore !== firestore || typeof dryRun !== "boolean") refuse();
  const prior = await readBootstrapResumeReceipt({ firestore, attempt: data.attempt });
  if (prior) return { dryRun, idempotent: true, receipt: prior };
  const attempt = data.attempt;
  return firestore.runTransaction(async original => {
    const guard = data.qualification.begin(original), transaction = guard.transaction;
    const saved = await transaction.get(firestore.doc(receiptPath(attempt)));
    if (saved.exists) {
      const fenceRow = await transaction.get(firestore.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH));
      const receipt = originalResumeReceipt(saved.data(), fenceRow.data(), attempt); guard.finish();
      return { dryRun, idempotent: true, receipt };
    }
    data.signal.throwIfAborted();
    const current = await authority(firestore, transaction, attempt);
    if (current.digest !== data.initial.digest) refuse();
    await enrollment.assertReadPublicReleaseChangeEnrollmentInTransaction({ firestore, transaction });
    await data.installed.assertInstalledConsumersInTransaction({ firestore, transaction, environment: attempt.bootstrap.currentPair.environment,
      contractDigest: attempt.bootstrap.admittedContractDigest, before: current.values[0] });
    const qualifications = await guard.verify();
    for (const [index, pair] of [attempt.bootstrap.currentPair, attempt.bootstrap.recoveryPair].entries()) {
      const qualified = qualifications[index], head = current.values[13 + index] as { contentHead: { viewId: string; manifestDigest: string; contextSequence: number } };
      if (!qualified || qualified.receipt.witnessDigest !== head.contentHead.viewId || qualified.witness.contentViewDigest !== head.contentHead.manifestDigest ||
          qualified.witness.headCursor.sequence !== head.contentHead.contextSequence || qualified.receipt.pairDigest !== hash(pair)) refuse();
    }
    const evidence = assertPreparedBootstrapIngress({ firestore, pair: attempt.bootstrap.currentPair, selector: current.selector, proof: data.ingress });
    guard.finish(); data.installed.assertFresh(); data.signal.throwIfAborted();
    const producer = { ...current.producer, enabled: true }, adopted = { schemaVersion: 2, enabled: true };
    const receipt = { schemaVersion: 2, kind: "public-release-bootstrap-resume", operationId: attempt.operationId, attempt, attemptDigest: hash(attempt),
      closeAttemptDigest: current.closed.attemptDigest, selectorDigest: hash(current.selector), bootstrapReceiptDigest: hash(current.rootReceipt), controlsReceiptDigest: hash(current.controls),
      enrollmentReceiptDigest: hash(current.enrolled), ingress: data.ingress, readMeasurement: data.measurement, producer, adoption: adopted };
    if (!dryRun) {
      transaction.set(firestore.doc("system/publicReleaseChangeLog"), producer);
      transaction.set(firestore.doc(`${admissions.ADMISSIONS}/controls/adoption`), adopted);
      transaction.set(firestore.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH), { ...current.closed, status: "open", resumeReceiptDigest: hash(receipt) });
      transaction.delete(firestore.doc(`${ROOT}/releaseWriter/fence`));
      transaction.create(firestore.doc(receiptPath(attempt)), receipt);
      transaction.create(firestore.collection("admin_logs").doc(), require("../../functions/lib/audit.js").adminLogEntry({ actorUid: "system:public-release-bootstrap",
        action: "public-release.bootstrap-resume", target: attempt.operationId, before: { admission: "closed" }, after: { receiptDigest: hash(receipt), admission: "logged" } }));
    }
    return { dryRun, idempotent: false, receipt, evidence };
  }, dryRun ? { readOnly: true } : undefined);
}
