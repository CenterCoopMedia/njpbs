import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import bootstrap from "../../functions/lib/public-release-bootstrap.js";
import protocol from "../../functions/lib/public-release-pair.js";
import pointer from "../../functions/lib/public-deployment-pointer.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import fence from "../../functions/lib/public-release-bootstrap-admission.js";
import work from "../../functions/lib/public-release-pair-work.js";
import enrollment from "../../functions/lib/public-release-change-enrollment.js";
import { exact, readBoundedBody, withinReaderDeadline } from "./public-release-pair-reader-contract";
import { BOOTSTRAP_CONTROL_PATHS, BOOTSTRAP_CONTROL_RECEIPTS, parseBootstrapControlsAttempt } from "./public-release-bootstrap-controls";
import type { PairViewStore } from "./public-release-pair-view-storage";

const hash = protocol.publicReleaseDigest, same = (a: unknown, b: unknown) => hash(a) === hash(b);
function refuse(): never { throw new Error("Bootstrap immutable storage read was refused"); }
type Attempt = ReturnType<typeof bootstrap.parseBootstrapAttempt>;
type ObjectRead = Pick<PairViewStore, "get"> & { getWithSignal?(key: string, signal: AbortSignal): ReturnType<PairViewStore["get"]> };

function keyOwner(key: string, attempt: Attempt) {
  if (typeof key !== "string" || !/^[A-Za-z0-9._:/-]+$/.test(key) || key.includes("..") || key.startsWith("/")) refuse();
  for (const pair of [attempt.currentPair, attempt.recoveryPair]) {
    const h = `release-pair-inputs/v2/${pair.pairId}/`, g = `release-pairs/${pair.pairId}/`;
    const r = `release-pair-replay/v2/${hash(pair)}/`, q = `release-pair-qualifications/v1/${hash(pair)}/`;
    if (key.startsWith(h) && /^(objects|manifests)\/[a-f0-9]{64}\.json$/.test(key.slice(h.length)) ||
        key.startsWith(g) && /^[a-f0-9]{64}\/claims\/[a-f0-9]{64}\/(objects\/[a-f0-9]{64}|(?:pages|views)\/[a-f0-9]{64}\.json)$/.test(key.slice(g.length)) ||
        key.startsWith(r) && /^(pages|selections)\/[a-f0-9]{64}\.json$/.test(key.slice(r.length)) ||
        key.startsWith(q) && /^[a-f0-9]{64}\/(pages|roots)\/[a-f0-9]{64}\.json$/.test(key.slice(q.length))) return pair;
  }
  return refuse();
}

async function authority(firestore: Firestore, attempt: Attempt) {
  const operationId = attempt.operationId, pairs = [attempt.currentPair, attempt.recoveryPair];
  const paths = ["system/publicDeployment", fence.BOOTSTRAP_ADMISSION_FENCE_PATH,
    "system/publicDeployment/releaseWriter/fence", `${fence.BOOTSTRAP_ADMISSION_ATTEMPTS}/${operationId}`,
    `system/publicDeployment/bootstrapSelectors/${operationId}`, `${BOOTSTRAP_CONTROL_RECEIPTS}/${operationId}`,
    enrollment.ENROLLMENT_PATH, "system/publicReleaseChanges", "cmsDeploymentReceipts/functions", "cmsReaderCompatibilityReceipts/functions",
    ...BOOTSTRAP_CONTROL_PATHS, ...pairs.flatMap(pair => { const base = work.publicReleasePairPath(pair.pairId);
      return [base, `${base}/controls/runtime`]; }), "system/billing"];
  return firestore.runTransaction(async transaction => {
    const rows = await transaction.getAll(...paths.map(path => firestore.doc(path))), values = rows.map(row => row.data() ?? null);
    const root = values[0], selected = protocol.parseVersionedPublicDeployment(root), closed = fence.parseBootstrapAdmissionFence(values[1]);
    if ((values.at(-1) as { disabled?: unknown } | null)?.disabled === true) refuse();
    // Billing counters are operational; only its admission bit fences reads.
    values[values.length - 1] = { disabled: false };
    const original = exact(values[3], ["schemaVersion", "operationId", "environment", "legacyPointerDigest"]);
    if (closed.status !== "closed" || closed.operationId !== operationId || original.schemaVersion !== 2 || original.operationId !== operationId ||
        original.environment !== pairs[0].environment || hash(original) !== closed.attemptDigest ||
        !same(values[2], { schemaVersion: 2, operationId, attemptDigest: closed.attemptDigest }) ||
        original.legacyPointerDigest !== adoption.legacyBootstrapPointerDigest(pointer.readPublicDeploymentPointer(root))) refuse();
    if (selected.schemaVersion === 1) {
      if (hash(root) !== attempt.expectedSourceDigest || values[4] !== null) refuse();
    } else {
      const receipt = exact(values[4], ["schemaVersion", "kind", "operationId", "attemptDigest", "sourceDigest", "selectorDigest", "storedSelectorDigest", "mediaDigest", "selector"]);
      if (selected.epoch !== 1 || selected.switchOperationId !== operationId || !same(selected.selectedPair, protocol.publicReleasePairReference(pairs[0])) ||
          !same(selected.recoveryPair, protocol.publicReleasePairReference(pairs[1])) || receipt.schemaVersion !== 2 || receipt.kind !== "public-release-bootstrap" ||
          receipt.operationId !== operationId || receipt.attemptDigest !== hash(attempt) || receipt.sourceDigest !== attempt.expectedSourceDigest ||
          receipt.selectorDigest !== hash(selected) || receipt.storedSelectorDigest !== hash(root) || !same(receipt.selector, selected)) refuse();
    }
    const controls = exact(values[5], ["schemaVersion", "kind", "attempt", "attemptDigest", "enrollmentReceiptDigest", "installed", "before", "after"]);
    const controlAttempt = parseBootstrapControlsAttempt(controls.attempt), live = values.slice(10, 10 + BOOTSTRAP_CONTROL_PATHS.length);
    const enrolled = enrollment.parsePublicReleaseChangeEnrollmentReceipt(values[6]);
    const installed = exact(controls.installed, ["environment", "sourceSha", "contractDigest", "sourceDigest", "providerDigest", "deploymentReceiptDigest", "readerReceiptDigest"]);
    if (controls.schemaVersion !== 2 || controls.kind !== "public-release-bootstrap-controls" || controls.attemptDigest !== hash(controlAttempt) ||
        controlAttempt.operationId !== operationId || !same(controlAttempt.pair, pairs[0]) || controlAttempt.admittedContractDigest !== attempt.admittedContractDigest ||
        controls.enrollmentReceiptDigest !== hash(enrolled) || controlAttempt.enrollmentReceiptDigest !== hash(enrolled) ||
        !same(enrolled.initialHead, values[7]) || enrolled.initialHead.sequence !== 0 || !same(controls.after, live) ||
        (live[6] as { enabled?: unknown } | null)?.enabled !== false || !same(live[7], { schemaVersion: 2, enabled: false }) ||
        installed.environment !== pairs[0].environment || installed.sourceSha !== controlAttempt.consumerSourceSha || installed.contractDigest !== attempt.admittedContractDigest ||
        installed.deploymentReceiptDigest !== hash(values[8]) || installed.readerReceiptDigest !== hash(values[9])) refuse();
    for (const [index, pair] of pairs.entries()) {
      const offset = 10 + BOOTSTRAP_CONTROL_PATHS.length + index * 2;
      if (!same(protocol.parsePublicReleasePair(values[offset]), pair) ||
          !same(values[offset + 1], { schemaVersion: 2, pairId: pair.pairId, status: "retained" })) refuse();
    }
    return hash(values);
  }, { readOnly: true });
}

/** In-process only. The initial bootstrap CLI explicitly constructs this
 * default-disabled wrapper over its existing GET path. No HTTP host, resource,
 * environment switch or ordinary observer endpoint is installed or widened. */
export function createBootstrapReadStore({ firestore, attempt: raw, objects, enabled = false, signal: requested }: {
  firestore: Firestore; attempt: Attempt; objects: ObjectRead; enabled?: boolean; signal?: AbortSignal;
}): PairViewStore {
  const attempt = bootstrap.parseBootstrapAttempt(raw);
  work.assertPublicReleasePairDatabase(firestore, attempt.currentPair);
  return {
    async get(key) {
      if (enabled !== true) refuse();
      const pair = keyOwner(key, attempt), digest = /([a-f0-9]{64})(?:\.json)?$/.exec(key)![1];
      const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(requested ? [requested] : [])]);
      signal.throwIfAborted();
      const check = () => withinReaderDeadline(signal, () => authority(firestore, attempt));
      const before = await check();
      signal.throwIfAborted();
      const object = await withinReaderDeadline(signal, async () => {
        const value = await (objects.getWithSignal ? objects.getWithSignal(key, signal) : objects.get(key));
        // A provider without cancellation support may finish after the race.
        // Drop its late body and never start a post-read authority operation.
        if (signal.aborted) { void value?.body.cancel().catch(() => {}); signal.throwIfAborted(); }
        return value;
      });
      if (!object) {
        if (await check() !== before) refuse();
        signal.throwIfAborted(); return null;
      }
      let bytes: Uint8Array, metadata: Record<string, string>;
      try {
        const size = object.size;
        if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024) refuse();
        metadata = { ...object.customMetadata };
        if (Object.keys(metadata).length > 32 || Object.values(metadata).some(value => typeof value !== "string") ||
            metadata.pairdigest !== hash(pair) || metadata.bodydigest !== digest) refuse();
        bytes = await readBoundedBody(object.body, size, signal);
        if (bytes.length !== size || createHash("sha256").update(bytes).digest("hex") !== digest) refuse();
      } finally { await object.body.cancel().catch(() => {}); }
      if (await check() !== before) refuse();
      signal.throwIfAborted();
      return { size: bytes.length, customMetadata: metadata, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    },
    async put() { return refuse(); },
  };
}
