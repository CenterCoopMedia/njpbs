import protocol from "../../functions/lib/public-release-pair.js";
import bootstrap from "../../functions/lib/public-release-bootstrap.js";
import work from "../../functions/lib/public-release-pair-work.js";
import pointer from "../../functions/lib/public-deployment-pointer.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import fence from "../../functions/lib/public-release-bootstrap-admission.js";
import writer from "../../functions/lib/public-release-writer-fence.js";
import pins from "../../functions/lib/cms-publication-runtime-control.js";
import media from "../../functions/lib/public-release-pair-media.js";
import admission from "../../functions/lib/public-release-admission.js";
import changes from "../../functions/lib/public-release-change-log.js";
import targets from "../../functions/lib/publication-target.js";
import { operatorRefused as refuse } from "./public-release-operator-io.mjs";
const hash = protocol.publicReleaseDigest, same = (a, b) => hash(a) === hash(b);
/** Read-only initial OLD authority, never a qualification or terminal proof.
 * Root, original receipt and both held fences are checked in one transaction. */
export async function readClosedInitialIngressAuthority({ firestore, attempt: raw, signal }) {
  const attempt = bootstrap.parseBootstrapAttempt(raw), pairs = [attempt.currentPair, attempt.recoveryPair];
  work.assertPublicReleasePairDatabase(firestore, pairs[0]); signal?.throwIfAborted();
  const read = firestore.runTransaction(async tx => {
    const paths = ["system/publicDeployment", `system/publicDeployment/bootstrapSelectors/${attempt.operationId}`,
      fence.BOOTSTRAP_ADMISSION_FENCE_PATH, writer.RELEASE_WRITER_FENCE_PATH, `${fence.BOOTSTRAP_ADMISSION_ATTEMPTS}/${attempt.operationId}`,
      "system/cmsPublicationRuntime", "system/publicDeployment/pairMedia/current", "system/billing", "system/publicReleaseChangeLog",
      `${admission.ADMISSIONS}/controls/adoption`, admission.ADMISSIONS, "system/publicReleaseChanges",
      ...pairs.flatMap(pair => [work.publicReleasePairPath(pair.pairId), `${work.publicReleasePairPath(pair.pairId)}/controls/runtime`])];
    const rows = await tx.getAll(...paths.map(path => firestore.doc(path))), values = rows.map(row => row.data() ?? null);
    signal?.throwIfAborted();
    const root = protocol.parseStoredPublicReleaseSelector(values[0]), receipt = values[1], closed = fence.parseBootstrapAdmissionFence(values[2]);
    protocol.exact(receipt, ["schemaVersion", "kind", "operationId", "attemptDigest", "sourceDigest", "selectorDigest", "storedSelectorDigest", "mediaDigest", "selector"]);
    const original = values[4]; protocol.exact(original, ["schemaVersion", "operationId", "environment", "legacyPointerDigest"]);
    if (root.epoch !== 1 || root.switchOperationId !== attempt.operationId || root.contentHead.contextSequence !== 0 ||
        !same(root.selectedPair, protocol.publicReleasePairReference(pairs[0])) || !same(root.recoveryPair, protocol.publicReleasePairReference(pairs[1])) ||
        root.admittedContractDigest !== attempt.admittedContractDigest || root.priorSelectorDigest !== attempt.expectedSourceDigest ||
        receipt.schemaVersion !== 2 || receipt.kind !== "public-release-bootstrap" || receipt.operationId !== attempt.operationId ||
        receipt.attemptDigest !== hash(attempt) || receipt.sourceDigest !== attempt.expectedSourceDigest || receipt.selectorDigest !== hash(root) ||
        receipt.storedSelectorDigest !== hash(values[0]) || !same(receipt.selector, root) ||
        receipt.mediaDigest !== hash(media.parsePairMedia(values[6], root)) || closed.status !== "closed" || closed.operationId !== attempt.operationId ||
        original.schemaVersion !== 2 || original.operationId !== attempt.operationId || original.environment !== pairs[0].environment ||
        original.legacyPointerDigest !== adoption.legacyBootstrapPointerDigest(pointer.readPublicDeploymentPointer(values[0])) ||
        hash(original) !== closed.attemptDigest || !same(writer.parseReleaseWriterFence(values[3]), { schemaVersion: 2, operationId: closed.operationId, attemptDigest: closed.attemptDigest }) ||
        values[7]?.disabled === true) refuse();
    const runtime = pins.parseCmsPublicationRuntimeControl(values[5]), target = targets.publicationTarget(pairs[0].environment);
    if ([runtime, runtime.cloud].some(pin => pin?.phase !== "ready" || pin.commitSha !== pairs[0].commitSha) || runtime.cloud.serializerId !== target.serializerId) refuse();
    const head = changes.parsePublicReleaseChangeHead(values[11]);
    if (head.sequence !== 0 || values[8]?.schemaVersion !== 2 || values[8].enabled !== false || !same(values[8].pair, root.selectedPair) ||
        !same(values[8].head, head) || !same(values[9], { schemaVersion: 2, enabled: false }) || !same(values[10], admission.initialAdmissionHead())) refuse();
    for (const [index, pair] of pairs.entries()) if (!same(protocol.parsePublicReleasePair(values[12 + index * 2]), pair) ||
      !same(values[13 + index * 2], { schemaVersion: 2, pairId: pair.pairId, status: "retained" })) refuse();
    const pending = await tx.get(firestore.collection("cmsPublishQueue").where("status", "in", ["reserved", "pending", "publishing"]).limit(1));
    if (!pending.empty) refuse(); signal?.throwIfAborted();
    values[7] = { disabled: false };
    return { rootDigest: hash(values[0]), selectorDigest: hash(root), bootstrapReceiptDigest: hash(receipt),
      closeAttemptDigest: closed.attemptDigest, authorityDigest: hash(values) };
  });
  if (!signal) return read;
  let abort;
  try { return await Promise.race([read, new Promise((_, reject) => { abort = () => reject(new Error("Initial ingress authority deadline"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); })]); }
  finally { if (abort) signal.removeEventListener("abort", abort); }
}
