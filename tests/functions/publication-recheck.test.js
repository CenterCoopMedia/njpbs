import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import endpoint from "../../functions/recheck-publication.js";
import listContent from "../../functions/list-content.js";
import deployment from "../../functions/lib/public-deployment.js";
import context from "../../functions/lib/public-context-revision.js";
import ownership from "../../functions/lib/no-build-page-ownership.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import targets from "../../functions/lib/publication-target.js";
import postOwnership from "../../functions/lib/no-build-post-ownership.js";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";

const queueId = "D".repeat(20), successor = "E".repeat(20), postId = "recheck-post";
const sha = "a".repeat(40), target = targets.publicationTarget("development");
const headers = { "cf-access-client-id": "fixture-id", "cf-access-client-secret": "fixture-secret" };
const actor = { uid: "publisher-fixture", email: "publisher@example.test", emailVerified: true,
  principal: { id: "publisher-fixture", grants: [{ role: "editor", sections: ["news"] }] } };
let app, firestore, state, record;
const queueRef = () => firestore.doc(`cmsPublishQueue/${queueId}`);
const recordRef = () => firestore.doc(`cmsPosts/${postId}`);
const ownerRef = () => firestore.doc(`${postOwnership.OWNER_COLLECTION}/${postId}`);
function response() { return { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } }; }
async function invoke(handler, body, method = "POST") {
  const result = response(); await handler({ method, body, headers: {}, ip: "127.0.0.1" }, result); return result;
}
function publicResponse(proved = state) {
  const body = "<!doctype html><html><body>Published Post fixture</body></html>";
  return new Response(body, { headers: { "cache-control": "no-store", "content-type": "text/html",
    "x-njpbs-content-source": "cms-no-build", "x-njpbs-publication-operation": proved.operationId,
    "x-njpbs-source-version": String(proved.sourceVersion), "x-njpbs-snapshot-sha256": proved.snapshotDigest,
    "x-njpbs-html-sha256": createHash("sha256").update(body).digest("hex"),
    "x-njpbs-admission-revision": "2", "x-njpbs-renderer-sha": sha,
    "x-njpbs-context-sha256": context.publicContextDigest(3) } });
}
function handler(options = {}) {
  return endpoint.createCmsRecheckPublicationHandler({ firestore, requirePrincipalFn: async () => actor,
    readbackFn: () => ({ target, headers }), fetchPublic: async () => publicResponse(), ...options });
}
async function summary() {
  return invoke(listContent.createCmsListContentHandler({ firestore, requirePrincipalFn: async () => ({ ...actor,
    principal: { id: actor.uid, grants: [{ role: "admin" }] } }) }), { view: "publish_activity", includePostProofRecovery: true });
}
async function seedProofFailure() {
  await queueRef().update({ status: "success", postProof: { status: "failed", attempts: 4, nextAttemptAt: null, claim: null } });
  await recordRef().update({ publishBuildPending: false, publishBuildQueueId: null, publicSourceVersion: 6,
    publishBuildSettlement: { status: "success", sourceVersion: 6, operation: "publish" },
    publicPostProof: { operationId: queueId, sourceVersion: 6, status: "failed", retryPending: false } });
}
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") {
    throw new Error("Use a local demo Firestore emulator");
  }
  app = initializeApp({ projectId: target.projectId }, "publication-recheck-emulator"); firestore = getFirestore(app);
});
afterAll(async () => { await firestore.terminate(); await deleteApp(app); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${target.projectId}/databases/(default)/documents`, { method: "DELETE" });
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document: {
    type: "post", title: "Published Post fixture", version: 6, slug: "recheck-story", previousSlugs: [], locale: "en-US", section: "news", date: "2026-10-19", tags: [], credits: [], blocks: [] },
    publishedAt: "2026-10-19T12:00:00.000Z", publishedBy: actor.uid });
  record = { title: "Private newer draft", version: 7, status: "draft", section: "news", publiclyVisible: true,
    published, publishBuildPending: true, publishBuildQueueId: queueId };
  state = { schemaVersion: 1, postId, operationId: queueId, sourceVersion: 6, slug: "recheck-story", ownedSlugs: ["recheck-story"],
    visible: true, rendererSha: sha, servingEnabled: true, generation: 2, snapshotDigest: ownership.digest(published),
    runtime: { owner: "cloudflare", release: sha } };
  const { servingEnabled, runtime, ...operation } = state;
  const batch = firestore.batch();
  batch.set(firestore.doc("system/publicDeployment"), { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 2,
    activeCommitSha: sha, activeDeploymentId: "fixture", lastReservedGeneration: 2, newestEligibleGeneration: 2,
    newestEligibleBuildBatchId: "fixture" });
  batch.set(firestore.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 3 });
  batch.set(firestore.doc("system/noBuildPostAdmission"), { schemaVersion: 2, revision: 2, enabled: true,
    families: { posts: { mode: "ids", ids: [postId] } }, backgroundBucket: target.backgroundBucket });
  batch.set(ownerRef(), state); batch.set(recordRef(), record);
  batch.set(queueRef(), { status: "failed", transport: "post-no-build-v1", noBuildPost: operation, backgroundRuntime: runtime,
    changes: [{ collection: "cmsPosts", id: postId, sourceVersion: 6 }], attempts: 4, nextAttemptAt: null, claim: null });
  await batch.commit();
});

it.each(["failed", "public_unconfirmed", "exhausted proof"])("confirms a Post %s with its existing public proof and one atomic audit", async status => {
  if (status === "exhausted proof") await seedProofFailure(); else await queueRef().update({ status });
  expect(await invoke(handler(), { queueId })).toMatchObject({ code: 200, body: { outcome: "confirmed_late" } });
  expect((await queueRef().get()).data()).toMatchObject({ status: "success", publicReceipt: { operationId: queueId, sourceVersion: 6 },
    postProof: { status: "verified", nextAttemptAt: null } });
  expect((await recordRef().get()).data()).toMatchObject({ title: "Private newer draft", version: 7,
    publishBuildPending: false, publishBuildQueueId: null, publicSourceVersion: 6,
    publicPostProof: { operationId: queueId, sourceVersion: 6, status: "verified", retryPending: false } });
  expect((await firestore.collection("admin_logs").get()).size).toBe(1);
  expect((await summary()).body).toMatchObject({ recoveryCount: 0, postProofRecoveryIds: [] });
});
it("counts only the current exhausted Post proof, and supersedes it only with a live newer proof", async () => {
  await seedProofFailure();
  expect((await summary()).body).toMatchObject({ recoveryCount: 1, postProofRecoveryIds: [queueId] });
  state = { ...state, operationId: successor, sourceVersion: 7, generation: 3 };
  const { servingEnabled, runtime, ...operation } = state;
  await ownerRef().set(state);
  await firestore.doc(`cmsPublishQueue/${successor}`).set({ status: "pending", transport: "post-no-build-v1", noBuildPost: operation });
  await recordRef().update({ publishBuildQueueId: successor, publishBuildPending: true, "published.sourceVersion": 7 });
  const before = (await recordRef().get()).data();
  expect((await summary()).body).toMatchObject({ recoveryCount: 0, postProofRecoveryIds: [] });
  expect(await invoke(handler(), { queueId })).toMatchObject({ code: 200, body: { outcome: "superseded" } });
  expect((await queueRef().get()).data()).toMatchObject({ status: "success", postProof: { status: "superseded" } });
  expect((await recordRef().get()).data()).toEqual(before);
});
it.each(["wrong operation", "wrong digest", "wrong body", "network"])("retains the failed Post and pending marker for %s", async mode => {
  const before = (await recordRef().get()).data();
  const result = await invoke(handler({ fetchPublic: async () => {
    if (mode === "network") throw new Error("Private network diagnostic");
    const reply = publicResponse();
    if (mode === "wrong operation") reply.headers.set("x-njpbs-publication-operation", successor);
    if (mode === "wrong digest") reply.headers.set("x-njpbs-snapshot-sha256", "f".repeat(64));
    return mode === "wrong body" ? new Response("wrong", { headers: reply.headers }) : reply;
  } }), { queueId });
  expect(result).toMatchObject({ code: 200, body: { outcome: "failed" } });
  expect(JSON.stringify(result.body)).not.toContain("Private");
  expect((await queueRef().get()).data().status).toBe("failed");
  expect((await recordRef().get()).data()).toEqual(before);
  expect((await firestore.collection("admin_logs").get()).size).toBe(1);
});
it.each(["pending", "verified", "automatic retry"])("refuses a successful Post with %s proof", async status => {
  await seedProofFailure();
  await queueRef().update(status === "automatic retry" ? { "postProof.nextAttemptAt": 0 } : { "postProof.status": status });
  expect(await invoke(handler(), { queueId })).toMatchObject({ code: 409 });
  expect((await firestore.collection("admin_logs").get()).size).toBe(0);
});
it("names removal when a Post withdrawal is still unconfirmed", async () => {
  state = { ...state, visible: false };
  await ownerRef().update({ visible: false });
  await recordRef().update({ publiclyVisible: false });
  await queueRef().update({ "noBuildPost.visible": false,
    changes: [{ collection: "cmsPosts", id: postId, sourceVersion: 6, operation: "withdraw" }] });
  const before = (await recordRef().get()).data();
  expect(await invoke(handler({ fetchPublic: async () => { throw new Error("Unavailable"); } }), { queueId }))
    .toMatchObject({ code: 200, body: { outcome: "failed",
      message: "The public site could not confirm this removal. Open the record to retry removal." } });
  expect((await queueRef().get()).data().status).toBe("failed");
  expect((await recordRef().get()).data()).toEqual(before);
  expect((await firestore.collection("admin_logs").get()).size).toBe(1);
});
it.each(["serializer", "github", "public-context-no-build-v1"])("refuses %s without rewriting publication state", async transport => {
  await queueRef().update({ transport }); const before = (await queueRef().get()).data();
  expect(await invoke(handler(), { queueId })).toMatchObject({ code: 409 });
  expect((await queueRef().get()).data()).toEqual(before);
});
it("refuses missing authentication, invalid identities, missing queues and non-POST requests", async () => {
  expect(await invoke(endpoint.createCmsRecheckPublicationHandler({ firestore }), { queueId })).toMatchObject({ code: 401 });
  expect(await invoke(handler(), { queueId: "../not-a-queue" })).toMatchObject({ code: 400 });
  expect(await invoke(handler(), { queueId: "F".repeat(20) })).toMatchObject({ code: 404 });
  expect(await invoke(handler(), { queueId }, "GET")).toMatchObject({ code: 405 });
  expect((await firestore.collection("admin_logs").get()).size).toBe(0);
});

it("keeps an exhausted Post proof failed without offering a publication that is already successful", async () => {
  await seedProofFailure();
  const before = (await recordRef().get()).data();
  expect(await invoke(handler({ fetchPublic: async () => { throw new Error("Unavailable"); } }), { queueId }))
    .toMatchObject({ code: 200, body: { outcome: "failed",
      message: "The public check still failed. Try Check again later or contact a Site owner." } });
  expect((await queueRef().get()).data()).toMatchObject({ status: "success", postProof: { status: "failed", attempts: 4, nextAttemptAt: null } });
  expect((await recordRef().get()).data()).toEqual(before);
  expect((await summary()).body.recoveryCount).toBe(1);
});
it("refuses a record marker owned by another operation even if the old Post is still served", async () => {
  await recordRef().update({ publishBuildQueueId: successor });
  const before = (await recordRef().get()).data();
  expect(await invoke(handler(), { queueId })).toMatchObject({ code: 409 });
  expect((await recordRef().get()).data()).toEqual(before);
  expect((await firestore.collection("admin_logs").get()).size).toBe(0);
});

it("excludes more than 100 historical superseded failed proofs from recovery membership", async () => {
  await seedProofFailure();
  await ownerRef().update({ operationId: successor, sourceVersion: 7, generation: 3 });
  await recordRef().update({ "published.sourceVersion": 7, publicSourceVersion: 7,
    "publishBuildSettlement.sourceVersion": 7,
    publicPostProof: { operationId: successor, sourceVersion: 7, status: "verified", retryPending: false } });
  const batch = firestore.batch();
  for (let index = 0; index < 151; index++) {
    const id = `H${String(index).padStart(19, "0")}`;
    batch.set(firestore.doc(`cmsPublishQueue/${id}`), { status: "success", transport: "post-no-build-v1",
      noBuildPost: { postId, operationId: id, sourceVersion: 6 },
      postProof: { status: "failed", attempts: 4, nextAttemptAt: null } });
  }
  await batch.commit();
  expect((await summary()).body).toMatchObject({ recoveryCount: 0, postProofRecoveryIds: [], postProofRecoveryTruncated: false });
});
it("bounds current recovery identities at 100 while retaining the full count", async () => {
  await seedProofFailure();
  const batch = firestore.batch();
  for (let index = 0; index < 101; index++) {
    const id = `J${String(index).padStart(19, "0")}`, post = `proof-post-${index}`;
    batch.set(firestore.doc(`cmsPublishQueue/${id}`), { status: "success", transport: "post-no-build-v1",
      noBuildPost: { postId: post, operationId: id, sourceVersion: 6 },
      postProof: { status: "failed", attempts: 4, nextAttemptAt: null } });
    batch.set(firestore.doc(`${postOwnership.OWNER_COLLECTION}/${post}`), { ...state, postId: post, operationId: id });
    batch.set(firestore.doc(`cmsPosts/${post}`), { ...record, publishBuildPending: false, publishBuildQueueId: null,
      publicSourceVersion: 6, publishBuildSettlement: { status: "success", sourceVersion: 6, operation: "publish" },
      publicPostProof: { operationId: id, sourceVersion: 6, status: "failed", retryPending: false } });
  }
  await batch.commit();
  const result = (await summary()).body;
  expect(result.recoveryCount).toBe(102);
  expect(result.postProofRecoveryIds).toHaveLength(100);
  expect(result.postProofRecoveryTruncated).toBe(true);
});
