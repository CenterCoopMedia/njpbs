import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import "../../functions/lib/firebase.js";
import ownership from "../../functions/lib/no-build-page-ownership.js";
import pageCandidate from "../../functions/lib/no-build-page-candidate.js";
import deployment from "../../functions/lib/public-deployment.js";
import coordinator from "../../functions/lib/public-deployment-coordinator.js";
import candidateStore from "../../functions/lib/public-worker-candidate-store.js";
import candidateModule from "../../functions/lib/public-worker-candidate.js";
const db = isolatedFirestore("no-build-page-ownership-integration.test.js");

const sha = "a".repeat(40);
const successor = "c".repeat(40);
const first = `page-${"1".repeat(32)}`;
const second = `page-${"2".repeat(32)}`;
const operationId = "A".repeat(20);
const snapshot = slug => ({ sourceVersion: 2, metadata: { title: "Owned Page", slug }, blocks: [] });
const document = slug => ({ publiclyVisible: true, published: snapshot(slug) });
const state = (pageId, slug, overrides = {}) => ({ schemaVersion: 1, pageId, rendererSha: sha,
  servingEnabled: true, generation: 2, operationId, sourceVersion: 2, visible: true,
  path: `/${slug}/`, ownedPaths: [`/${slug}/`], snapshotDigest: ownership.digest(snapshot(slug)),
  runtime: { owner: "cloudflare", release: sha }, ...overrides });
async function accept(pageId, slug, overrides = {}) {
  return db.runTransaction(async transaction => {
    const writeRoutes = await ownership.preparePageRouteClaimsInTransaction({ firestore: db, transaction,
      pageId, ownedPaths: overrides.ownedPaths ?? [`/${slug}/`] });
    writeRoutes();
    transaction.set(db.doc(`${ownership.PAGE_OWNER_COLLECTION}/${pageId}`), state(pageId, slug, overrides));
    transaction.set(db.doc(`cmsPages/${pageId}`), document(slug));
  });
}
async function candidateLease(noBuildPage) {
  const buildBatchId = "page-compatible-release";
  const reserved = await coordinator.reservePublicBuildBatch({ firestore: db, buildBatchId, commitSha: successor });
  const batch = reserved.batch;
  const batchRef = db.doc(`system/publicDeployment/buildBatches/${buildBatchId}`);
  await batchRef.update({ status: "ready", readyAt: FieldValue.serverTimestamp() });
  const recordedAt = (await batchRef.get()).data().readyAt;
  const manifest = { buildBatchId, generation: batch.generation, commitSha: successor,
    mediaManifestDigest: "d".repeat(64), ownerCount: 0, chunkCount: 0 };
  await batchRef.collection("manifests").doc("publicMedia").set(manifest);
  await batchRef.collection("manifests").doc("publicMedia").collection("verifications").doc("complete")
    .set({ ...manifest, verifiedAt: recordedAt });
  const input = { schemaVersion: 1, buildBatchId, generation: batch.generation, commitSha: successor,
    workerName: "njpbs-production", workerVersionId: "11111111-1111-4111-8111-111111111111",
    artifactDigest: "d".repeat(64), artifactReceiptDigest: "e".repeat(64), publicationReceiptDigest: "f".repeat(64),
    mediaManifestDigest: "d".repeat(64), artifactFileCount: 1, artifactBytes: 1234, wranglerVersion: "4.123.0",
    versionCreatedOn: "2026-10-12T13:00:00.000Z", ...(noBuildPage ? { noBuildPage } : {}) };
  input.workerVersionTag = candidateModule.publicWorkerCandidateTag(input);
  await candidateStore.recordPublicWorkerCandidate({ firestore: db, candidate: input });
  return coordinator.acquirePublicDeploymentLease({ firestore: db, buildBatchId, commitSha: successor });
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use a local demo Firestore emulator");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 2, activeDeploymentId: "22222222-2222-4222-8222-222222222222",
    activeCommitSha: sha, lastReservedGeneration: 2, newestEligibleGeneration: 2, newestEligibleBuildBatchId: "baseline" });
});
describe("durable Page route and release fences", () => {
  it("serializes two simultaneous first admissions for one custom route", async () => {
    const results = await Promise.allSettled([accept(first, "shared"), accept(second, "shared")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await db.collection(ownership.PAGE_OWNER_COLLECTION).get()).size).toBe(1);
    const route = (await ownership.pageRouteRef(db, "/shared/").get()).data();
    const winningOwner = (await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/${route.pageId}`).get()).data();
    expect(winningOwner.ownedPaths).toEqual(["/shared/"]);
  });
  it("retains old aliases and removal claims independently of selection", async () => {
    await accept(first, "renamed", { visible: false, ownedPaths: ["/renamed/", "/former/"] });
    await expect(accept(second, "former")).rejects.toThrow("owns this public route");
    await expect(accept(first, "renamed", { ownedPaths: ["/renamed/", "/former/"] })).resolves.toBeUndefined();
    expect((await db.collection(ownership.PAGE_ROUTE_COLLECTION).get()).size).toBe(2);
  });
  it("preserves a static Page's published alias before first admission", async () => {
    await db.doc(`cmsPages/${first}`).set({ published: { sourceVersion: 1,
      metadata: { slug: "current", previousSlugs: ["old"] } } });
    await expect(accept(second, "old")).rejects.toThrow("published route");
    expect((await db.collection(ownership.PAGE_OWNER_COLLECTION).get()).empty).toBe(true);
  });
  it("refuses a real code lease that drops Page ownership", async () => {
    await accept(first, "owned");
    await expect(candidateLease()).rejects.toThrow("does not preserve owned");
    expect((await db.doc("system/publicDeployment").get()).data().state).toBe("idle");
  });
  it("rechecks immutable content before candidate activation and advances only capability", async () => {
    await accept(first, "owned", { ownedPaths: ["/owned/", "/old/"] });
    const retained = (await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/${first}`).get()).data();
    const lease = await candidateLease({ schemaVersion: 1, rendererSha: successor, enabled: true, authoritative: true });
    expect(lease.outcome).toBe("acquired");
    await db.runTransaction(async transaction => {
      const checked = await pageCandidate.assertNoBuildPageCandidateInTransaction({ firestore: db, transaction, candidate: lease.candidate });
      pageCandidate.writeNoBuildPageCandidateActivation(transaction, db, checked, lease.candidate);
    });
    expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/${first}`).get()).data()).toEqual(retained);
    expect((await db.doc(ownership.PAGE_CAPABILITY_PATH).get()).data()).toMatchObject({ rendererSha: successor });
    await db.doc(`cmsPages/${first}`).update({ "published.metadata.title": "Changed after lease" });
    await expect(db.runTransaction(transaction => pageCandidate.assertNoBuildPageCandidateInTransaction({
      firestore: db, transaction, candidate: lease.candidate }))).rejects.toThrow();
  });
});
