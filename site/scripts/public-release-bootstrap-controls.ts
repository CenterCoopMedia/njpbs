import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import admission from "../../functions/lib/public-release-admission.js";
import enrollment from "../../functions/lib/public-release-change-enrollment.js";
import runtime from "../../functions/lib/cms-publication-runtime-control.js";
import switches from "../../functions/lib/public-release-switch.js";
import family from "../../functions/lib/no-build-family-admission.js";
import targets from "../../functions/lib/publication-target.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { exact, parseReaderSeals, supportedReaderFeatures } from "./public-release-pair-reader-contract";
import { assertInstalledPublicReleaseConsumersInTransaction, type PreparedInstalledConsumers } from "./public-release-installed-consumer-owner";

const hash = protocol.publicReleaseDigest, require = createRequire(import.meta.url);
export const BOOTSTRAP_CONTROL_RECEIPTS = "system/publicReleaseAdmissions/bootstrapControls";
export const BOOTSTRAP_CONTROL_PATHS = ["system/cmsPublicationRuntime", "system/noBuildPostAdmission",
  ...Object.values(switches.CAPABILITY_PATHS), "system/publicDeployment/noBuildRecordFamilies/current",
  "system/publicReleaseChangeLog", `${admission.ADMISSIONS}/controls/adoption`, admission.ADMISSIONS] as const;
function refuse(): never { throw new Error("Initial public release controls were refused"); }
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export type BootstrapControlsAttempt = Readonly<{ schemaVersion: 2; operationId: string; pair: PublicReleasePair;
  enrollmentReceiptDigest: string; admittedContractDigest: string; consumerSourceSha: string;
  expectedControlsDigest: string; familyAdmission: unknown }>;
export function parseBootstrapControlsAttempt(raw: unknown): BootstrapControlsAttempt {
  const value = exact(structuredClone(raw), ["schemaVersion", "operationId", "pair", "enrollmentReceiptDigest", "admittedContractDigest",
    "consumerSourceSha", "expectedControlsDigest", "familyAdmission"]), pair = protocol.parsePublicReleasePair(value.pair);
  if (value.schemaVersion !== 2 || typeof value.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.operationId) ||
      ![value.enrollmentReceiptDigest, value.admittedContractDigest, value.expectedControlsDigest].every(digest) ||
      typeof value.consumerSourceSha !== "string" || !/^[a-f0-9]{40}$/.test(value.consumerSourceSha)) refuse();
  const selected = family.projectNoBuildFamilyAdmission(value.familyAdmission, {}, targets.publicationTarget(pair.environment));
  if (value.familyAdmission === null || (value.familyAdmission as { schemaVersion?: unknown }).schemaVersion !== 2 ||
      !selected.valid || !selected.enabled || selected.backgroundBucket !== targets.publicationTarget(pair.environment).backgroundBucket) refuse();
  return Object.freeze({ ...value, pair }) as BootstrapControlsAttempt;
}

/** Read-only digest of the exact controls that the reviewed attempt may replace.
 * Admission remains independently closed throughout this preparation. */
export async function inspectBootstrapControls({ firestore, pair }: { firestore: Firestore; pair: PublicReleasePair }) {
  work.assertPublicReleasePairDatabase(firestore, pair);
  return firestore.runTransaction(async transaction => {
    const rows = await transaction.getAll(...BOOTSTRAP_CONTROL_PATHS.map(path => firestore.doc(path)));
    return { expectedControlsDigest: hash(rows.map((row, index) => ({ path: BOOTSTRAP_CONTROL_PATHS[index], value: row.data() ?? null }))) };
  }, { readOnly: true });
}

/** First install only. Makes the already enrolled OLD runtime compatible while
 * keeping BOTH the independent admission fence and shared writer fence closed.
 * No selector conversion, log append, provider operation or producer resume. */
export async function installBootstrapOldControls({ firestore, attempt: raw, installed, dryRun = true }: {
  firestore: Firestore; attempt: BootstrapControlsAttempt; installed: PreparedInstalledConsumers; dryRun?: boolean;
}) {
  const attempt = parseBootstrapControlsAttempt(raw), pair = attempt.pair, target = targets.publicationTarget(pair.environment);
  work.assertPublicReleasePairDatabase(firestore, pair);
  if (typeof dryRun !== "boolean" || installed.sourceSha !== attempt.consumerSourceSha) refuse();
  const attemptDigest = hash(attempt), receiptPath = `${BOOTSTRAP_CONTROL_RECEIPTS}/${attempt.operationId}`;
  return firestore.runTransaction(async transaction => {
    const [saved, root, registered, seal, lifecycle, contractRow, ...controlRows] = await transaction.getAll(
      firestore.doc(receiptPath), firestore.doc("system/publicDeployment"), firestore.doc(work.publicReleasePairPath(pair.pairId)),
      firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/seals/privateReader`),
      firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`),
      firestore.doc(`${admission.CONTRACTS}/${attempt.admittedContractDigest}`),
      ...BOOTSTRAP_CONTROL_PATHS.map(path => firestore.doc(path)));
    const values = controlRows.map(row => row.data() ?? null);
    if (saved.exists) {
      const receipt = exact(saved.data(), ["schemaVersion", "kind", "attempt", "attemptDigest", "enrollmentReceiptDigest", "installed", "before", "after"]);
      if (receipt.schemaVersion !== 2 || receipt.kind !== "public-release-bootstrap-controls" || receipt.attemptDigest !== attemptDigest ||
          !same(receipt.attempt, attempt) || receipt.enrollmentReceiptDigest !== attempt.enrollmentReceiptDigest || !same(receipt.after, values)) refuse();
      await adoption.assertClosedBootstrapFenceInTransaction({ firestore, transaction, environment: pair.environment,
        before: root.data(), operationId: attempt.operationId });
      return { dryRun, idempotent: true, receipt, receiptPath, before: receipt.before, after: receipt.after };
    }
    await adoption.assertClosedBootstrapFenceInTransaction({ firestore, transaction, environment: pair.environment,
      before: root.data(), operationId: attempt.operationId });
    const original = await enrollment.assertReadPublicReleaseChangeEnrollmentInTransaction({ firestore, transaction });
    const pins = runtime.parseCmsPublicationRuntimeControl(values[0]), cloud = runtime.cloudCmsPublicationRuntimeControl(values[0]);
    const paused = original.receipt.request.expected;
    if (!same(original.head, original.receipt.initialHead) || original.receiptDigest !== attempt.enrollmentReceiptDigest ||
        paused.pointerDigest !== hash(root.data()) || paused.liveReleaseSha !== pair.commitSha || paused.runtimeDigest !== hash(pins) ||
        pins.phase !== "paused" || cloud.phase !== "paused" || pins.commitSha !== pair.commitSha || cloud.commitSha !== pair.commitSha ||
        !same(protocol.parsePublicReleasePair(registered.data()), pair) ||
        !same(lifecycle.data(), { schemaVersion: 2, pairId: pair.pairId, status: "retained" }) ||
        hash(values.map((value, index) => ({ path: BOOTSTRAP_CONTROL_PATHS[index], value }))) !== attempt.expectedControlsDigest ||
        values.slice(6).some(value => value !== null)) refuse();
    const seals = parseReaderSeals(seal.data(), pair), capabilities = switches.publicationControlsForReaderSeals(seals, pair);
    const contract = exact(contractRow.data(), ["schemaVersion", "families", "features"]);
    if (contract.schemaVersion !== 2 || hash(contract) !== attempt.admittedContractDigest || !Array.isArray(contract.families) ||
        !Array.isArray(contract.features) || new Set(contract.families).size !== contract.families.length ||
        contract.families.some(value => !["posts", "pages", "programs", "events", "settings", "context"].includes(String(value))) ||
        new Set(contract.features).size !== contract.features.length) refuse();
    const families = contract.families;
    const supported = supportedReaderFeatures(seals);
    const selection = family.projectNoBuildFamilyAdmission(attempt.familyAdmission, {}, target);
    const previousAdmission = family.projectNoBuildFamilyAdmission(values[1], {}, target);
    if (values[1] !== null && !previousAdmission.valid || contract.features.some(feature => !supported.has(String(feature))) ||
        Object.keys(selection.families).some(name => !families.includes(name)) ||
        families.some(name => ["posts", "pages", "programs", "events"].includes(String(name)) &&
          (!Object.hasOwn(selection.families, String(name)) || ["programs", "events"].includes(String(name)) &&
            !seals.capabilities.record.families.includes(name as "programs" | "events"))) ||
        (attempt.familyAdmission as { revision: number }).revision !== (previousAdmission.admissionRevision ?? 0) + 1) refuse();
    const namespace = values[5] === null ? { schemaVersion: 1, families: [] } : exact(values[5], ["schemaVersion", "families"]);
    if (namespace.schemaVersion !== 1 || !Array.isArray(namespace.families) || new Set(namespace.families).size !== namespace.families.length ||
        namespace.families.some(name => !seals.capabilities.record.families.includes(name as "programs" | "events"))) refuse();
    const pending = await transaction.get(firestore.collection("cmsPublishQueue").where("status", "in", ["reserved", "pending", "publishing"]).limit(1));
    if (!pending.empty) refuse();
    const before = values, generation = root.data()!.activeGeneration;
    const ready = { schemaVersion: 1, phase: "ready", commitSha: pair.commitSha, serializerId: target.serializerId,
      cloud: { phase: "ready", commitSha: pair.commitSha, serializerId: target.serializerId } };
    const producer = { schemaVersion: 2, enabled: false, pair: protocol.publicReleasePairReference(pair),
      head: original.receipt.initialHead, logEpoch: original.receipt.request.logEpoch };
    const after = [ready, attempt.familyAdmission, ...Object.values(capabilities).map(value => ({ ...value, generation })),
      namespace, producer, { schemaVersion: 2, enabled: false }, admission.initialAdmissionHead()];
    await assertInstalledPublicReleaseConsumersInTransaction({ firestore, transaction, proof: installed,
      environment: pair.environment, contractDigest: attempt.admittedContractDigest, before: root.data() });
    const receipt = { schemaVersion: 2, kind: "public-release-bootstrap-controls", attempt, attemptDigest,
      enrollmentReceiptDigest: original.receiptDigest, installed, before, after };
    if (!dryRun) {
      BOOTSTRAP_CONTROL_PATHS.forEach((path, index) => transaction.set(firestore.doc(path), after[index]));
      transaction.create(firestore.doc(receiptPath), receipt);
      transaction.create(firestore.collection("admin_logs").doc(), require("../../functions/lib/audit.js").adminLogEntry({
        actorUid: "system:public-release-bootstrap", action: "public-release.bootstrap-controls", target: attempt.operationId,
        before: { controlsDigest: attempt.expectedControlsDigest }, after: { receiptDigest: hash(receipt), admission: "closed" } }));
    }
    return { dryRun, idempotent: false, receipt, receiptPath, before, after };
  }, dryRun ? { readOnly: true } : undefined);
}
