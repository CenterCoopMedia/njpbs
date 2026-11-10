import { repositoryFixture } from "../helpers/repository-identity.mjs";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import dev from "../../scripts/lib/dev-publication.cjs";
import deployment from "../../functions/lib/public-deployment.js";
import manifestModule from "../../functions/lib/public-media-manifest.js";
import publicationModule from "../../functions/lib/no-build-post-publication.js";
import reconciliation from "../../functions/lib/publish-reconcile.js";
import { inspectDevPublicationRetry } from "../../site/scripts/cms-dev-publication.mjs";

const project = process.env.GCLOUD_PROJECT ?? "demo-njpbs";
const id = { queueId: "A1b2C3d4E5f6G7h8I9j0", buildBatchId: "cms-A1b2C3d4E5f6G7h8I9j0", commitSha: "a".repeat(40) };
const runtime = { owner: "cloudflare", release: id.commitSha };
const inputDigest = "f".repeat(64);
const versionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const deploymentId = "11111111-2222-4333-8444-555555555555";
let db;
const queueRef = () => db.doc(`cmsPublishQueue/${id.queueId}`);
const batchRef = () => db.doc(`system/publicDeployment/buildBatches/${id.buildBatchId}`);
const pointer = async () => (await db.doc("system/publicDeployment").get()).data();
const activation = () => ({ action: "activate", buildBatchId: id.buildBatchId, deploymentId,
  versionId, commitSha: id.commitSha });

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !project.startsWith("demo-")) {
    throw new Error("This test requires a loopback demo Firestore emulator");
  }
  if (!admin.apps.length) admin.initializeApp({ projectId: project });
  db = isolatedFirestore("dev-publication.test.js");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" }, db);
  await queueRef().set({ status: "pending", transport: "github", environment: "development",
    projectId: "njpbs-site-dev", runtime, triggeredAt: admin.firestore.Timestamp.now(),
    changes: [{ collection: "cmsPages", id: "home", sourceVersion: 7 }] });
  await db.doc("cmsPages/home").set({ status: "published", publishBuildPending: true, publishBuildQueueId: id.queueId,
    published: { sourceVersion: 7 }, title: "A later draft", version: 8 });
});
afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

it.each(["repository_dispatch", "workflow_dispatch"])("%s selects the accepted cloud source with no queue or deployment writes", async eventName => {
  const older = "b".repeat(40);
  await queueRef().update({ runtime: { owner: "cloudflare", release: older } });
  const before = (await queueRef().get()).data();
  expect(await dev.selectDevPublicationSource(db, { eventName, eventSha: id.commitSha, queueId: id.queueId })).toBe(older);
  expect((await queueRef().get()).data()).toEqual(before);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
});

it("push selects its exact main event SHA without inventing a queue", async () => {
  await queueRef().delete();
  expect(await dev.selectDevPublicationSource(db, { eventName: "push", eventSha: id.commitSha, queueId: id.queueId })).toBe(id.commitSha);
  expect((await queueRef().get()).exists).toBe(false);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
});

it.each(["accepted editorial queue", "uncreated code refresh"])("allows fresh retry only for an unreserved %s", async mode => {
  if (mode === "uncreated code refresh") await queueRef().delete();
  const before = (await queueRef().get()).data();
  dev.assertDevPublicationUnreserved(await dev.readDevPublication(db, id));
  expect((await queueRef().get()).data()).toEqual(before);
  expect((await batchRef().get()).exists).toBe(false);
});

it("refuses missing retry input after a real reservation, preserving accepted evidence", async () => {
  await dev.reserveDevPublication(db, id);
  const before = { queue: (await queueRef().get()).data(), batch: (await batchRef().get()).data(), pointer: await pointer() };
  const current = await dev.readDevPublication(db, id);
  expect(() => dev.assertDevPublicationUnreserved(current)).toThrow("owner decision");
  expect({ queue: (await queueRef().get()).data(), batch: (await batchRef().get()).data(), pointer: await pointer() }).toEqual(before);
});

it.each(["input", "candidate"])("refuses retained %s evidence even when other reservation records are missing", key => {
  expect(() => dev.assertDevPublicationUnreserved({ [key]: { buildBatchId: id.buildBatchId } })).toThrow("owner decision");
});

it.each([false, true])("refuses missing Actions input without changing real reservations (reserved: %s)", async reserved => {
  if (reserved) await dev.reserveDevPublication(db, id);
  const before = { queue: (await queueRef().get()).data(), batch: (await batchRef().get()).data() };
  const http = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ total_count: 0, artifacts: [] }));
  try {
    const result = inspectDevPublicationRetry(db, { ...repositoryFixture, GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", GITHUB_RUN_ID: "38201254803",
      GITHUB_EVENT_NAME: "repository_dispatch", GITHUB_SHA: "b".repeat(40), QUEUE_ID: id.queueId, GH_TOKEN: "synthetic-test-token" });
    await expect(result).rejects.toThrow("reruns require retained frozen input");
    expect({ queue: (await queueRef().get()).data(), batch: (await batchRef().get()).data() }).toEqual(before);
  } finally { http.mockRestore(); }
});

it("push refuses an existing retry queue that owns another source", async () => {
  await queueRef().update({ runtime: { owner: "cloudflare", release: "b".repeat(40) } });
  const before = (await queueRef().get()).data();
  await expect(dev.selectDevPublicationSource(db, { eventName: "push", eventSha: id.commitSha, queueId: id.queueId })).rejects.toThrow("cloud runtime migration");
  expect((await queueRef().get()).data()).toEqual(before);
});

it("source selection checks fresh queue identity and exact retained artifact identity", async () => {
  const input = { eventName: "workflow_dispatch", queueId: id.queueId, retainedIdentity: id };
  expect(await dev.selectDevPublicationSource(db, input)).toBe(id.commitSha);
  await queueRef().update({ runtime: { owner: "cloudflare", release: "b".repeat(40) } });
  await expect(dev.selectDevPublicationSource(db, input)).rejects.toThrow("Retained dev source differs");
  await expect(dev.selectDevPublicationSource(db, { ...input, retainedIdentity: { ...id, queueId: "Z".repeat(20) } })).rejects.toThrow("Retained dev source differs");
});

it.each(["missing queue", "office runtime", "missing runtime", "legacy journal"])("source selection refuses %s without adopting accepted work", async problem => {
  if (problem === "missing queue") await queueRef().delete();
  if (problem === "office runtime") await queueRef().update({ runtime: { owner: "node-compute", release: id.commitSha } });
  if (problem === "missing runtime") await queueRef().update({ runtime: admin.firestore.FieldValue.delete() });
  if (problem === "legacy journal") await db.doc("system/devPublication").set({ activeGeneration: 1 });
  const before = (await queueRef().get()).data();
  await expect(dev.selectDevPublicationSource(db, { eventName: "repository_dispatch", queueId: id.queueId })).rejects.toThrow();
  expect((await queueRef().get()).data()).toEqual(before);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
});

async function frozen() {
  const artifactBuild = await dev.reserveDevPublication(db, id);
  const reservation = (await batchRef().get()).data();
  await dev.recordDevInputs(db, id, inputDigest);
  const owners = [{ collection: "cmsPages", documentId: "home", sourceVersion: 7, assetIds: [], occurrenceCount: 0 }];
  const families = manifestModule.PUBLIC_MEDIA_MANIFEST_COLLECTIONS.map(collection => ({ collection, complete: true,
    artifacts: collection === "cmsPages" ? [{ documentId: "home", canonicalPath: "/", sourceVersion: 7 }] : [] }));
  const manifest = manifestModule.createPublicMediaManifest({ reservation, owners,
    artifactInventory: families.map(family => ({ collection: family.collection, complete: true,
      documentIds: family.artifacts.map(artifact => artifact.documentId) })) });
  const inventory = { ...artifactBuild, cutoffAt: { seconds: reservation.cutoffAt.seconds, nanoseconds: reservation.cutoffAt.nanoseconds },
    owners, families, mediaManifestDigest: manifest.mediaManifestDigest };
  const publication = { buildBatchId: id.buildBatchId, generation: reservation.generation, commitSha: id.commitSha,
    artifactDigest: "c".repeat(64), mediaManifestDigest: manifest.mediaManifestDigest,
    artifactReceiptDigest: dev.hash(JSON.stringify(inventory)), publicationReceiptDigest: "d".repeat(64),
    artifactFileCount: 12, artifactBytes: 8192 };
  return { inventory, publication, inputDigest, wranglerVersion: "4.134.0",
    version: { workerVersionId: versionId, versionCreatedOn: "2026-10-11T18:00:00.000Z",
      noBuildPost: { schemaVersion: 2, families: ["posts"], rendererSha: id.commitSha, enabled: true, authoritative: true } } };
}
async function prepared() {
  const evidence = await frozen();
  const candidate = await dev.recordDevCandidate(db, id, evidence);
  return { evidence, candidate };
}

it("a pre-lease build failure preserves the previous site and exact frozen recovery evidence", async () => {
  const previous = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 4, activeDeploymentId: "old-deployment",
    activeCommitSha: "b".repeat(40), lastReservedGeneration: 4, newestEligibleGeneration: 4, newestEligibleBuildBatchId: "old-build" };
  await db.doc("system/publicDeployment").set(previous);
  await frozen();
  expect(await dev.finishDevPublication(db, id)).toBe("unclaimed");
  expect(await pointer()).toMatchObject({ activeGeneration: 4, activeDeploymentId: "old-deployment",
    activeCommitSha: "b".repeat(40), lastReservedGeneration: 5 });
  expect((await batchRef().get()).data().status).toBe("reserved");
  expect((await queueRef().get()).data().status).toBe("pending");
  expect((await db.doc("cmsPages/home").get()).data()).toMatchObject({ title: "A later draft", published: { sourceVersion: 7 }, publishBuildPending: true });
  expect((await db.doc("system/devPublication").get()).exists).toBe(false);
});

it("stages generic media and candidate, then activates the shared renderer and settles only the published revision", async () => {
  const { candidate } = await prepared();
  expect((await batchRef().get()).data()).toMatchObject({ status: "ready", runtime });
  expect((await batchRef().collection("manifests").doc("publicMedia").collection("verifications").doc("complete").get()).exists).toBe(true);
  const acquired = await dev.acquireDevDeploymentLease(db, id);
  expect(acquired).toMatchObject({ outcome: "acquired", idempotent: false, candidate: { workerName: "template-dev-public", runtime } });
  expect(await publicationModule.readNoBuildPostDecision({ firestore: db, path: "/_publication.json", rendererSha: id.commitSha,
    probe: { buildBatchId: id.buildBatchId, versionId } })).toEqual({ kind: "baseline-probe" });
  expect((await dev.settleDevDeploymentOutcome(db, id, acquired.lease, activation())).outcome).toBe("deployed");
  expect(await dev.finishDevPublication(db, id)).toBe("success");
  expect(await pointer()).toMatchObject({ state: "idle", activeGeneration: 1, activeCommitSha: id.commitSha, activeDeploymentId: deploymentId });
  expect((await db.doc("system/publicDeployment/noBuildPosts/capability").get()).data()).toEqual({
    schemaVersion: 2, rendererSha: id.commitSha, servingEnabled: true, generation: 1 });
  expect((await queueRef().get()).data()).toMatchObject({ status: "success", runtime,
    deploymentReceipt: { generation: 1, publicUrl: "https://dev-public.example.org/", versionId } });
  expect((await db.doc("cmsPages/home").get()).data()).toMatchObject({ title: "A later draft", version: 8, publicSourceVersion: 7 });
  expect(await dev.finishDevPublication(db, id)).toBe("success");
  expect((await batchRef().collection("candidates").doc("worker").get()).data()).toEqual(candidate);
  expect((await db.doc("system/devPublication").get()).exists).toBe(false);
});

it("an uncertain activation retains the generic lease and permits no second provider activation", async () => {
  await prepared();
  const first = await dev.acquireDevDeploymentLease(db, id);
  expect(first.idempotent).toBe(false);
  expect(await dev.finishDevPublication(db, id)).toBe("reconciling");
  expect((await pointer()).activeGeneration).toBe(0);
  const retry = await dev.acquireDevDeploymentLease(db, id);
  expect(retry).toMatchObject({ idempotent: true, lease: first.lease });
  expect((await queueRef().get()).data().status).toBe("pending");
  expect((await dev.settleDevDeploymentOutcome(db, id, retry.lease, activation())).outcome).toBe("deployed");
  expect(await dev.finishDevPublication(db, id)).toBe("success");
});

it("conflicting provider evidence cannot activate or settle the queue", async () => {
  await prepared();
  const acquired = await dev.acquireDevDeploymentLease(db, id);
  expect((await dev.settleDevDeploymentOutcome(db, id, acquired.lease,
    { ...activation(), versionId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" })).outcome).toBe("reconciling");
  expect((await pointer()).activeGeneration).toBe(0);
  expect((await queueRef().get()).data().status).toBe("pending");
});

it("admits a timed-out failed queue only after its original deployed outcome and exact alignment", async () => {
  const { evidence } = await prepared();
  const acquired = await dev.acquireDevDeploymentLease(db, id);
  await dev.finishDevPublication(db, id);
  await queueRef().update({ status: "failed", error: reconciliation.STALE_PUBLISH_ERROR });
  const request = { identity: id, generation: 1, workerVersionId: versionId,
    inventory: evidence.inventory, publication: evidence.publication };
  const original = await dev.readDevPublication(db, id);
  expect(dev.prepareTimedOutDevReconciliation({ ...request, ...original })).toEqual(acquired.lease);
  expect(() => dev.assertDevReconcileInputs({ ...request, ...original })).toThrow("exact deployed receipt");
  const outcome = await dev.settleDevDeploymentOutcome(db, id, acquired.lease, activation());
  expect(outcome.outcome).toBe("deployed");
  const deployed = await dev.readDevPublication(db, id);
  expect(deployed.queue.status).toBe("failed");
  expect(() => dev.assertDevReconcileInputs({ ...request, ...deployed, outcome: outcome.receipt })).not.toThrow();
  expect(() => dev.assertDevReconcileInputs({ ...request, ...deployed,
    outcome: { ...outcome.receipt, versionId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" } })).toThrow();
  expect(await dev.finishDevPublication(db, id)).toBe("unclaimed");
  expect((await queueRef().get()).data().status).toBe("failed");
  expect(await dev.finishDevPublication(db, id, { timeoutOutcome: outcome.receipt })).toBe("success");
  expect((await pointer()).activeGeneration).toBe(1);
});

it.each(["another failure", "production project", "production environment", "unclaimed candidate"])(
  "timeout verification refuses %s without modifying the original records", async mode => {
    const { evidence } = await prepared();
    if (mode !== "unclaimed candidate") await dev.acquireDevDeploymentLease(db, id);
    await queueRef().update({ status: "failed", error: reconciliation.STALE_PUBLISH_ERROR });
    const current = await dev.readDevPublication(db, id);
    const request = { identity: id, generation: 1, workerVersionId: versionId, ...current,
      inventory: evidence.inventory, publication: evidence.publication,
      queue: { ...current.queue, ...(mode === "another failure" ? { error: "Different owner failure" } : {}),
        ...(mode === "production project" ? { projectId: "njpbs-site" } : {}),
        ...(mode === "production environment" ? { environment: "production" } : {}) } };
    expect(() => dev.prepareTimedOutDevReconciliation(request)).toThrow();
    expect(await dev.readDevPublication(db, id)).toEqual(current);
  });

it("ordinary fail cleanup cannot settle a failed queue after another owner deployed its batch", async () => {
  await prepared();
  const acquired = await dev.acquireDevDeploymentLease(db, id);
  await dev.settleDevDeploymentOutcome(db, id, acquired.lease, activation());
  await queueRef().update({ status: "failed", error: reconciliation.STALE_PUBLISH_ERROR });
  const before = await dev.readDevPublication(db, id);
  expect(await dev.finishDevPublication(db, id)).toBe("unclaimed");
  expect(await dev.readDevPublication(db, id)).toEqual(before);
});

it.each(["production queue", "missing runtime", "office runtime", "wrong release", "legacy journal"])(
  "refuses %s without reserving a generation", async mode => {
    if (mode === "production queue") await queueRef().update({ projectId: "njpbs-site" });
    if (mode === "missing runtime") await queueRef().update({ runtime: admin.firestore.FieldValue.delete() });
    if (mode === "office runtime") await queueRef().update({ runtime: { ...runtime, owner: "node-compute" } });
    if (mode === "wrong release") await queueRef().update({ runtime: { ...runtime, release: "b".repeat(40) } });
    if (mode === "legacy journal") await db.doc("system/devPublication").set({ status: "idle", oldReceipt: "retained" });
    const before = (await queueRef().get()).data();
    await expect(dev.reserveDevPublication(db, id)).rejects.toThrow();
    expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
    expect((await queueRef().get()).data()).toEqual(before);
  },
);

it("keeps frozen input immutable and refuses mutable CMS rereads", async () => {
  await frozen();
  const before = await dev.readDevPublication(db, id);
  await expect(dev.reserveDevPublication(db, id)).rejects.toThrow(/retained frozen inputs/);
  await dev.recordDevInputs(db, id, inputDigest);
  await expect(dev.recordDevInputs(db, id, "e".repeat(64))).rejects.toThrow(/conflicts/);
  expect((await dev.readDevPublication(db, id)).input).toEqual(before.input);
});

it("retains exactly one generic candidate and refuses a replacement version or digest", async () => {
  const { evidence, candidate } = await prepared();
  expect(await dev.recordDevCandidate(db, id, evidence)).toEqual(candidate);
  await expect(dev.recordDevCandidate(db, id, { ...evidence,
    version: { ...evidence.version, workerVersionId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" } })).rejects.toThrow(/conflicts/);
  await expect(dev.recordDevCandidate(db, id, { ...evidence,
    publication: { ...evidence.publication, artifactDigest: "e".repeat(64) } })).rejects.toThrow(/conflicts/);
  expect((await dev.readDevPublication(db, id)).candidate).toEqual(candidate);
});

it("cannot acquire from an unprepared generic reservation", async () => {
  await frozen();
  await expect(dev.acquireDevDeploymentLease(db, id)).rejects.toThrow("The public deployment build batch is invalid");
  expect(await dev.finishDevPublication(db, id)).toBe("unclaimed");
  expect((await pointer()).activeGeneration).toBe(0);
});

it("cannot acquire a media-ready batch without its recorded generic candidate", async () => {
  await prepared();
  await batchRef().collection("candidates").doc("worker").delete();
  await expect(dev.acquireDevDeploymentLease(db, id)).rejects.toThrow("The prepared public Worker candidate does not exist");
  expect(await dev.finishDevPublication(db, id)).toBe("unclaimed");
  expect((await pointer()).activeGeneration).toBe(0);
});

it("rejects an unknown baseline candidate before the first Post owner exists", async () => {
  await prepared();
  await dev.acquireDevDeploymentLease(db, id);
  for (const probe of [{ buildBatchId: "wrong-build", versionId }, { buildBatchId: id.buildBatchId, versionId: "wrong-version" }]) {
    await expect(publicationModule.readNoBuildPostDecision({ firestore: db, path: "/_publication.json", rendererSha: id.commitSha, probe }))
      .rejects.toMatchObject({ status: 409 });
  }
});

it("pre-lease failure cleanup leaves another operation and reservation untouched", async () => {
  await frozen();
  const before = await pointer();
  expect(await dev.finishDevPublication(db, { ...id, queueId: "B1b2C3d4E5f6G7h8I9j0", buildBatchId: "cms-B1b2C3d4E5f6G7h8I9j0" })).toBe("unclaimed");
  expect(await pointer()).toEqual(before);
});


it("retains the optional record capability in the durable dev candidate and activation", async () => {
  const evidence = await frozen();
  evidence.version.noBuildRecord = { schemaVersion: 1, rendererSha: id.commitSha, enabled: true, authoritative: true, families: ["programs", "events"] };
  const candidate = await dev.recordDevCandidate(db, id, evidence);
  expect(candidate.noBuildRecord).toEqual(evidence.version.noBuildRecord);
  const acquired = await dev.acquireDevDeploymentLease(db, id);
  expect((await dev.settleDevDeploymentOutcome(db, id, acquired.lease, activation())).outcome).toBe("deployed");
  expect((await db.doc("system/publicDeployment/noBuildRecords/capability").get()).data()).toEqual({
    schemaVersion: 1, rendererSha: id.commitSha, servingEnabled: true, families: ["programs", "events"], generation: 1,
    terminalOwner: { schemaVersion: 1, transport: "public-context-no-build-v1", rendererSha: id.commitSha } });
});
