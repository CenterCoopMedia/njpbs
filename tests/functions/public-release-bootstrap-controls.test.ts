import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { installedConsumerFixture } from "../helpers/public-release-installed-consumers";
import { sealedPair } from "../helpers/sealed-public-release-pair";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
import { prepareInstalledPublicReleaseConsumers } from "../../site/scripts/public-release-installed-consumer-owner";
import { inspectBootstrapControls, installBootstrapOldControls } from "../../site/scripts/public-release-bootstrap-controls";
import { runBootstrapControlsOperator } from "../../site/scripts/bootstrap-public-release-controls";
import p from "../../functions/lib/public-release-pair.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import enrollment from "../../functions/lib/public-release-change-enrollment.js";
import producer from "../../functions/lib/public-release-producer.js";
import fence from "../../functions/lib/public-release-bootstrap-admission.js";
import work from "../../functions/lib/public-release-pair-work.js";

let app: ReturnType<typeof initializeApp>, db: Firestore, fixture: ReturnType<typeof installedConsumerFixture>;
let attempt: any, closed: any, proof: Awaited<ReturnType<typeof prepareInstalledPublicReleaseConsumers>>;
const { pair, seals } = sealedPair(), operationId = "bootstrap-original";
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs")
    throw new Error("Use only the loopback demo emulator");
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
  app = initializeApp({ projectId: "njpbs-site-dev" }, "bootstrap-controls-sdk"); db = getFirestore(app);
});
afterAll(async () => { if (app) await deleteApp(app); vi.unstubAllEnvs(); });
async function seedControls(singleSerializer?: "cloudflare-publisher" | "cloudflare-dev-publisher") {
  for (const collection of ["system", "cmsDeploymentReceipts", "cmsReaderCompatibilityReceipts", "admin_logs"])
    await db.recursiveDelete(db.collection(collection));
  fixture = installedConsumerFixture();
  const batch = db.batch();
  for (const [path, value] of fixture.data) batch.set(db.doc(path), value);
  batch.set(db.doc("system/cmsPublicationRuntime"), { schemaVersion: 1, phase: "ready", commitSha: pair.commitSha,
    serializerId: singleSerializer ?? "node-compute", ...(singleSerializer ? {} : {
      cloud: { phase: "ready", commitSha: pair.commitSha, serializerId: "cloudflare-dev-publisher" } }) });
  batch.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 1 });
  const base = work.publicReleasePairPath(pair.pairId);
  batch.set(db.doc(base), pair); batch.set(db.doc(`${base}/seals/privateReader`), seals);
  batch.set(db.doc(`${base}/controls/runtime`), { schemaVersion: 2, pairId: pair.pairId, status: "retained" });
  await batch.commit();
  closed = { schemaVersion: 2, operationId, environment: "development", legacyPointerDigest: adoption.legacyBootstrapPointerDigest(fixture.root) };
  await adoption.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: closed });
  await db.doc("system/cmsPublicationRuntime").update(singleSerializer ? { phase: "paused" } : { phase: "paused", "cloud.phase": "paused" });
  const code = publicReleaseBaselineCodeFixture(db, pair.commitSha);
  const observed = await enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db });
  const enrolled = await enrollment.enrollPublicReleaseChangeLog({ firestore: db, dryRun: false, currentCodeRequest: code.request,
    request: { schemaVersion: 1, operationId, logEpoch: "initial-epoch", baselineDigest: "f".repeat(64), expected: observed.expected } });
  const expected = await inspectBootstrapControls({ firestore: db, pair });
  attempt = { schemaVersion: 2, operationId, pair, ...expected, enrollmentReceiptDigest: enrolled.receiptDigest,
    admittedContractDigest: fixture.contractDigest, consumerSourceSha: fixture.options.sourceSha,
    familyAdmission: { schemaVersion: 2, revision: 1, enabled: true, families: { posts: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-artifacts" } };
  proof = await prepareInstalledPublicReleaseConsumers({ ...fixture.options, firestore: db });
}
beforeEach(() => seedControls());
const run = (dryRun = false, changes = {}) => installBootstrapOldControls({ firestore: db, attempt, installed: proof, dryRun, ...changes });
it.each(["cloudflare-publisher", "cloudflare-dev-publisher"] as const)("accepts the enrolled single-runtime %s shape and keeps admission closed", async serializer => {
  await seedControls(serializer);
  expect(Object.hasOwn((await db.doc("system/cmsPublicationRuntime").get()).data()!, "cloud")).toBe(false);
  const result = await run(); expect(result.idempotent).toBe(false);
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual({ schemaVersion: 1, phase: "ready", commitSha: pair.commitSha,
    serializerId: "cloudflare-dev-publisher", cloud: { phase: "ready", commitSha: pair.commitSha, serializerId: "cloudflare-dev-publisher" } });
  expect((await db.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).data()!.status).toBe("closed");
  expect((await db.doc("system/publicReleaseChangeLog").get()).data()!.enabled).toBe(false);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(fixture.root);
});
it("exposes the actual read-only control digest through the named inspect operator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bootstrap-controls-")), file = join(directory, "pair.json");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await writeFile(file, JSON.stringify(pair));
    const before = await inspectBootstrapControls({ firestore: db, pair });
    await runBootstrapControlsOperator(["--inspect", "--pair", file]);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual(before);
    expect(await inspectBootstrapControls({ firestore: db, pair })).toEqual(before);
    expect((await db.collection("system/publicReleaseAdmissions/bootstrapControls").get()).empty).toBe(true);
  } finally { output.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});
it("dry-runs and then readies compatible OLD controls without reopening either fence or accepting a producer", async () => {
  const preview = await run(true);
  expect(preview.after[0]).toMatchObject({ phase: "ready", serializerId: "cloudflare-dev-publisher", cloud: { phase: "ready" } });
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()!.phase).toBe("paused");
  expect((await db.doc(preview.receiptPath).get()).exists).toBe(false);
  const result = await run(); expect(result.idempotent).toBe(false);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(fixture.root);
  expect((await db.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).data()!.status).toBe("closed");
  expect((await db.doc("system/publicReleaseChangeLog").get()).data()!.enabled).toBe(false);
  expect((await db.doc("system/publicReleaseAdmissions/controls/adoption").get()).data()!.enabled).toBe(false);
  await expect(db.runTransaction(transaction => producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction,
    operationId: "would-be-accepted", changes: [{ kind: "provider", id: "dependency", action: "dependency", sourceVersion: 1, snapshot: {} }] })))
    .rejects.toMatchObject({ code: "public_release_bootstrap_admission_paused" });
  await expect(adoption.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt: closed })).rejects.toThrow();
  const repeated = await run(); expect(repeated.idempotent).toBe(true); expect(repeated.receipt).toEqual(result.receipt);
  expect(repeated.before).toEqual(result.before); expect(repeated.after).toEqual(result.after);
  expect((await db.collection("admin_logs").get()).size).toBe(2);
});
it.each(["pins", "enrollment", "root", "receipt", "fence", "adoption", "contract"])("refuses %s drift without any control write", async fault => {
  if (fault === "pins") await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "ready" });
  if (fault === "enrollment") await db.doc(enrollment.ENROLLMENT_PATH).delete();
  if (fault === "root") await db.doc("system/publicDeployment").update({ activeDeploymentId: "changed" });
  if (fault === "receipt") await db.doc("cmsDeploymentReceipts/functions").update({ state: "in_progress" });
  if (fault === "fence") await db.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH).update({ operationId: "foreign" });
  if (fault === "adoption") await db.doc("system/publicReleaseAdmissions/controls/adoption").set({ schemaVersion: 2, enabled: false });
  if (fault === "contract") attempt = { ...attempt, familyAdmission: { ...attempt.familyAdmission, families: { pages: { mode: "all" } } } };
  await expect(run()).rejects.toThrow();
  expect((await db.collection("system/publicReleaseAdmissions/bootstrapControls").get()).empty).toBe(true);
  expect((await db.doc("system/publicReleaseChangeLog").get()).exists).toBe(false);
});
it("recovers the original receipt after a lost reply and refuses a changed attempt or repaired controls", async () => {
  const original = db.runTransaction.bind(db);
  const ambiguous = new Proxy(db, { get(target, key) {
    if (key === "runTransaction") return async (...args: any[]) => { await (original as any)(...args); throw new Error("Lost reply"); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const prepared = await prepareInstalledPublicReleaseConsumers({ ...fixture.options, firestore: ambiguous });
  await expect(run(false, { firestore: ambiguous, installed: prepared })).rejects.toThrow("Lost reply");
  const repeated = await run(); expect(repeated.idempotent).toBe(true);
  await expect(run(false, { attempt: { ...attempt, consumerSourceSha: "c".repeat(40) } })).rejects.toThrow();
  await expect(run(false, { attempt: { ...attempt, expectedControlsDigest: "0".repeat(64) } })).rejects.toThrow();
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  await expect(run()).rejects.toThrow();
});
