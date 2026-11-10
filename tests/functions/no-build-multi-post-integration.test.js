import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import getContent from "../../functions/get-content.js";
import buildState from "../../functions/lib/publish-build-state.js";
import bulk from "../../functions/bulk-archive.js";
import fallback from "../../functions/lib/transitional-post-withdrawal.js";
import cloudWork from "../../functions/lib/no-build-cloud-work.js";
import { noBuildPostMaintenance } from "../../site/scripts/no-build-post-background";
import "../../functions/lib/firebase.js";
import save from "../../functions/save.js";
import lifecycle from "../../functions/lifecycle-transition.js";
import publication from "../../functions/lib/no-build-post-publication.js";
import registry from "../../functions/lib/no-build-post-ownership.js";
import recovery from "../../functions/lib/no-build-post-recovery.js";
import deployment from "../../functions/lib/public-deployment.js";
import targets from "../../functions/lib/publication-target.js";
import publicContent from "../../functions/public-content.js";
import publisher from "../../functions/publish.js";
import { createNoBuildPostWorker } from "../../workers/src/no-build-post-worker";
import { readPublicContentStatus } from "../../admin/src/lib/public-content-status";
const db = isolatedFirestore("no-build-multi-post-integration.test.js");

const directories = [];
const sha = "a".repeat(40);
const actor = { uid: "editor-fixture", email: "editor@example.test",
  principal: { id: "editor-fixture", grants: [{ role: "editor", sections: ["news"] }] } };
const quiet = { info() {}, warn() {}, error() {} };
const pointer = () => ({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
  activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: sha,
  lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
const document = (id, slug = `${id}-story`) => ({ id, type: "post", title: `${id} title`, status: "approved", section: "news",
  slug, previousSlugs: [], version: 1, createdBy: actor.uid, tags: [], categories: [], credits: [], blocks: [] });
function response() { return { code: 200, headersSent: false, status(code) { this.code = code; return this; }, set() { return this; },
  json(body) { this.body = body; this.headersSent = true; return this; } }; }
async function invoke(handler, body) {
  const result = response();
  await handler({ method: "POST", body, headers: {}, ip: "127.0.0.1" }, result);
  return result;
}
const handler = () => save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor,
  now: () => "2026-10-11T12:00:00.000Z", enablePublishSnapshot: true, log: quiet,
  assertPublishReadyFn: async () => { throw new Error("Full-build dispatch is outside this publication"); } });
async function publish(id, version = 1, changes = {}, owner = handler()) {
  if (Object.keys(changes).length) {
    const edit = await invoke(owner, { collection: "cmsPosts", id, baseVersion: version,
      ...(changes.slug ? { slug: changes.slug } : {}), document: Object.fromEntries(Object.entries(changes).filter(([key]) => key !== "slug")) });
    if (edit.code !== 200) return edit;
    version++;
  }
  return invoke(owner, { collection: "cmsPosts", id, baseVersion: version, publish: true, document: {} });
}
const owner = async postId => (await registry.readNoBuildPostOwner({ firestore: db, postId })).state;
async function decision(path, method = "GET") {
  const result = await invoke(publicContent.createCmsGetPublicPageHandler({ firestore: db, log: quiet }),
    { mode: "no-build-post-v1", path, rendererSha: sha, method });
  if (result.code !== 200) throw new Error("Private Post read was refused");
  return JSON.parse(JSON.stringify(result.body));
}
function worker(target) {
  // Keep the cached copy alive; Node can cancel its sibling when an ignored
  // Response clone is collected during the fresh authority read.
  const cache = new Map();
  return createNoBuildPostWorker({ target, rendererSha: sha, getDecision: decision,
    cache: { async match(request) { return cache.get(request.url)?.clone(); },
      async put(request, response) { cache.set(request.url, response); } },
    render: async content => `<!doctype html><html><body>${content.posts[0].title}</body></html>`,
    fetchAsset: async request => Response.json({ schemaVersion: 1, buildBatchId: "baseline", generation: 1, commitSha: sha,
      ...(new URL(request.url).pathname === "/_content-status.json" ? { collections: ["cmsPages", "cmsPosts"], routes: [
        { path: "/about/", source: "site" }, { path: "/posts/first-story/", source: "cms", sourceVersion: 1 },
      ] } : {}) }),
  });
}
async function snapshot() {
  return { posts: (await db.collection("cmsPosts").get()).docs.map(row => row.data()),
    queues: (await db.collection("cmsPublishQueue").get()).docs.map(row => row.data()),
    history: (await db.collection("cmsVersionHistory").get()).size, audit: (await db.collection("admin_logs").get()).size,
    owners: (await registry.listNoBuildPostOwners({ firestore: db })).map(value => value.state),
    background: (await db.collection("cmsBackgroundOutputs").get()).docs.map(row => row.data()) };
}
// Seed the accepted pre-cutoff contract without making fresh cloud admission
// manufacture legacy work. The retained creator/owner checks remain real.
async function seedRetainedSafety(operationId, { promote = false } = {}) {
  let id;
  await db.runTransaction(async transaction => {
    const ref = db.doc(`cmsPublishQueue/${operationId}`);
    const queue = (await transaction.get(ref)).data();
    const reservation = await fallback.preparePostWithdrawalBuild({ firestore: db, transaction,
      actor, change: queue.changes[0], operationId, runtime: queue.backgroundRuntime,
      homeAffected: queue.homeAffected });
    id = reservation.queueRef.id;
    transaction.create(reservation.queueRef, reservation.queue);
    transaction.create(reservation.auditRef, reservation.audit);
    transaction.update(ref, { homeFullBuild: reservation.receipt });
    transaction.update(db.doc(`cmsPosts/${queue.noBuildPost.postId}`), { publishBuildQueueId: id });
  });
  if (promote) await fallback.enqueuePostWithdrawalBuild({ firestore: db, operationId });
  return id;
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(db.projectId)) {
    throw new Error("Use a local demo Firestore emulator");
  }
});
beforeEach(async () => {
  vi.stubEnv("CMS_PUBLISH_TRANSPORT", "serializer");
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
    families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
  await db.doc("system/publicDeployment").set(pointer());
  await db.doc(registry.CAPABILITY_PATH).set({ schemaVersion: 2, rendererSha: sha, servingEnabled: true, generation: 1 });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "node-compute-publisher",
    cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
  await db.doc("sections/news").set({ label: "News" });
  for (const id of ["first", "second"]) await db.doc(`cmsPosts/${id}`).set(document(id));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("multi-Post admission and retained ownership", () => {
  it.each(["unpublish", "archive"])("retains every cloud Post tombstone without a new safety queue on %s", async action => {
    expect((await publish("first")).code).toBe(200);
    expect((await publish("second")).code).toBe(200);
    expect((await publish("first", 2, { slug: "renamed-first" })).code).toBe(200);
    expect((await decision("/posts/first-story/")).kind).toBe("alias");
    const secondBefore = await owner("second");
    const homeBefore = (await db.doc("cmsPages/home").get()).data();
    const lifecycleActor = action === "archive" ? { ...actor, principal: { id: actor.uid, grants: [{ role: "admin" }] } } : actor;
    const transition = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => lifecycleActor, log: quiet });
    const firstRemoval = await invoke(transition, { collection: "cmsPosts", id: "first", baseVersion: 4, action });
    expect(firstRemoval.code, JSON.stringify(firstRemoval.body)).toBe(200);
    expect(await owner("second")).toEqual(secondBefore);
    const secondRemoval = await invoke(transition, { collection: "cmsPosts", id: "second", baseVersion: 2, action });
    expect(secondRemoval.code, JSON.stringify(secondRemoval.body)).toBe(200);
    for (const [id, result] of [["first", firstRemoval], ["second", secondRemoval]]) {
      const currentOwner = await owner(id);
      const fullQueueId = result.body.publication.homeFullBuildQueueId;
      expect(fullQueueId).toBeNull();
      const queue = (await db.doc(`cmsPublishQueue/${currentOwner.operationId}`).get()).data();
      expect(queue.homeFullBuild).toBeUndefined();
      expect(queue).toMatchObject({ status: "pending", transport: "post-no-build-v1",
        changes: [{ collection: "cmsPosts", id, sourceVersion: currentOwner.sourceVersion, operation: "withdraw" }] });
      expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ publiclyVisible: false,
        publishBuildPending: true, publishBuildQueueId: currentOwner.operationId });
      expect((await db.doc(`cmsPublishQueue/${currentOwner.operationId}/backgroundOutputs/listings`).get()).exists).toBe(true);
      await fallback.warnFirstHomeFailure({ firestore: db, operationId: currentOwner.operationId, preparationFailed: true });
      expect((await db.doc(`cmsPublishQueue/${currentOwner.operationId}`).get()).data().homeFallback).toBeUndefined();
    }
    for (const slug of ["first-story", "renamed-first", "second-story"]) {
      expect((await decision(`/posts/${slug}/`)).kind).toBe("gone");
      expect((await worker().fetch(new Request(`https://njpbs.org/posts/${slug}/`))).status).toBe(410);
    }
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).size).toBe(0);
    expect((await db.doc("cmsPages/home").get()).data()).toEqual(homeBefore);
  });
  it.each(["excluded", "missing", "invalid"])("resumes retained Post safety reservations with %s admission", async mode => {
    expect((await publish("first")).code).toBe(200);
    const originalRef = db.collection("cmsPublishQueue").doc();
    const postRef = db.doc("cmsPosts/first");
    await db.runTransaction(async transaction => {
      const nextDocument = { ...(await transaction.get(postRef)).data(), publiclyVisible: false, version: 3 };
      const prepared = await publication.prepareNoBuildPostPublication({ firestore: db, transaction,
        collection: "cmsPosts", documentId: "first", nextDocument, queueRef: originalRef, actor });
      prepared.write();
      transaction.set(postRef, { ...nextDocument, publishBuildPending: true, publishBuildQueueId: prepared.contentQueueId });
      expect(prepared.homeFullBuildQueueId).toBeNull();
    });
    const queueId = await seedRetainedSafety(originalRef.id);
    expect((await db.doc(`cmsPublishQueue/${queueId}`).get()).data().status).toBe("reserved");
    const admissionRef = db.doc("system/noBuildPostAdmission");
    if (mode === "missing") await admissionRef.delete();
    else if (mode === "invalid") await admissionRef.update({ revision: "invalid" });
    else await admissionRef.update({ revision: 2, enabled: false,
      families: { posts: { mode: "ids", ids: ["second"] } } });
    const wake = await cloudWork.readNoBuildCloudWork({ runtime: { owner: "cloudflare", release: sha },
      read: async path => (await db.doc(path).get()).data() ?? null,
      listOwners: async () => (await db.collection(registry.OWNER_COLLECTION).get()).docs.map(row => row.data()) });
    expect(wake).toEqual({ maintenance: true, reconcile: false });
    const directory = await mkdtemp(path.join(await realpath(tmpdir()), "pr7-maintenance-"));
    directories.push(directory);
    await noBuildPostMaintenance({ firestore: db, commitSha: sha, runtime: { owner: "cloudflare", release: sha },
      stateDirectory: directory, distDirectory: path.join(directory, "dist"), buildEnvironment: {} })();
    expect((await db.doc(`cmsPublishQueue/${queueId}`).get()).data().status).toBe("pending");
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).size).toBe(1);
    expect((await owner("first")).visible).toBe(false);
  });
  it("retries retained Post safety builds until normal writeback clears their pending pointer", async () => {
    expect((await publish("first")).code).toBe(200);
    const removal = await invoke(lifecycle.createCmsTransitionContentHandler({ firestore: db,
      requirePrincipalFn: async () => actor, log: quiet }), { collection: "cmsPosts", id: "first", baseVersion: 2, action: "unpublish" });
    expect(removal.code, JSON.stringify(removal.body)).toBe(200);
    const operationId = removal.body.publication.queueId;
    const failedQueueId = await seedRetainedSafety(operationId, { promote: true });
    await db.doc(`cmsPublishQueue/${operationId}`).update({ status: "success" });
    await buildState.settleBuildQueue(db, { queueId: failedQueueId, status: "failed", queueUpdate: { status: "failed" } });
    const status = getContent.createCmsGetContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const readStatus = () => invoke(status, { collection: "cmsPosts", id: "first", publicationOnly: true });
    const failed = (await readStatus()).body.publication;
    expect(failed).toMatchObject({ queueStatus: "failed", publicUpdatePending: true, withdrawalBuildPending: true });
    expect(failed.homeWarning).toBeUndefined();
    const retry = publisher.createCmsPublishHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const request = { retry: true, baseVersion: 3, changes: [{ collection: "cmsPosts", id: "first", sourceVersion: 2, operation: "withdraw" }] };
    const retried = await Promise.all([invoke(retry, request), invoke(retry, request)]);
    expect(retried.map(result => result.code)).toEqual([200, 200]);
    const queueId = retried[0].body.queueId;
    expect(retried[1].body.queueId).toBe(queueId);
    expect(queueId).not.toBe(failedQueueId);
    await buildState.settleBuildQueue(db, { queueId, status: "success", queueUpdate: { status: "success" } });
    expect((await db.doc("cmsPosts/first").get()).data()).toMatchObject({ publiclyVisible: false,
      publishBuildPending: false, publishBuildQueueId: null });
    expect((await readStatus()).body.publication).toMatchObject({ queueStatus: "pending", publicUpdatePending: true,
      publicBuildQueueId: operationId, withdrawalBuildPending: true });
  });
  it("keeps each cloud Post bulk archive on its own build-free operation", async () => {
    expect((await publish("first")).code).toBe(200);
    expect((await publish("second")).code).toBe(200);
    const adminActor = { uid: "archive-admin", principal: { id: "archive-admin", grants: [{ role: "admin" }] } };
    await db.doc("users/archive-admin").set({ active: true, role: "admin" });
    const result = await invoke(bulk.createCmsBulkArchiveHandler({ firestore: db, requireAdminFn: async () => adminActor, log: quiet }),
      { items: [{ id: "first", baseVersion: 2 }, { id: "second", baseVersion: 2 }] });
    expect(result.code, JSON.stringify(result.body)).toBe(200);
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).empty).toBe(true);
    expect(result.body.outcomes.map(row => row.publication.homeFullBuildQueueId)).toEqual([null, null]);
    for (const row of result.body.outcomes) {
      expect((await db.doc(`cmsPosts/${row.id}`).get()).data().publishBuildQueueId).toBe(row.publication.queueId);
    }
    expect((await owner("first")).visible).toBe(false);
    expect((await owner("second")).visible).toBe(false);
  });
  it.each([{ mode: "all" }, { mode: "ids", ids: ["first"] }])("keeps an unowned Post publishing through the existing serializer while admission is paused: %j", async selector => {
    await db.doc("system/noBuildPostAdmission").update({ enabled: false, families: { posts: selector } });
    const serving = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor,
      now: () => "2026-10-11T12:00:00.000Z", enablePublishSnapshot: true, log: quiet,
      assertPublishReadyFn: fields => publisher.assertPublishReady(fields, { firestore: db,
        getTransport: () => "serializer", log: quiet }) });
    const result = await publish("first", 1, {}, serving);
    expect(result.code, JSON.stringify(result.body)).toBe(200);
    expect(result.body.publication.transport).toBe("serializer");
    expect((await db.doc(`cmsPublishQueue/${result.body.publication.queueId}`).get()).data()).toMatchObject({
      status: "pending", transport: "serializer", changes: [{ collection: "cmsPosts", id: "first", sourceVersion: 2 }] });
    expect((await db.doc("cmsPosts/first").get()).data()).toMatchObject({
      status: "published", publishBuildPending: true, published: { sourceVersion: 2 } });
    expect(await owner("first")).toBeNull();
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("lets an ordinary Editor publish two Posts and supersedes only the addressed predecessor", async () => {
    expect((await publish("first")).code).toBe(200);
    expect((await publish("second")).code).toBe(200);
    const first = await owner("first");
    const second = await owner("second");
    expect(first.operationId).not.toBe(second.operationId);
    expect(first.runtime).toEqual({ owner: "cloudflare", release: sha });
    expect(second.runtime).toEqual(first.runtime);
    expect((await publish("first", 2, { title: "First revision" })).code).toBe(200);
    expect((await db.doc(`cmsPublishQueue/${first.operationId}`).get()).data().status).toBe("cancelled");
    expect((await db.doc(`cmsPublishQueue/${second.operationId}`).get()).data().status).toBe("pending");
    expect((await owner("second"))).toEqual(second);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(4);
    expect((await db.collection("cmsPublishQueue").get()).docs.every(row => row.data().transport === "post-no-build-v1")).toBe(true);
  });
  it("admits a server-minted Post ID without a full-build readiness probe", async () => {
    const saved = await invoke(handler(), { collection: "cmsPosts", section: "news",
      document: { type: "post", title: "A new Post", slug: "a-new-post", credits: [], blocks: [], tags: [], categories: [] } });
    expect(saved.code, JSON.stringify(saved.body)).toBe(200);
    const result = await publish(saved.body.document.id, saved.body.document.version);
    expect(result.code, JSON.stringify(result.body)).toBe(200);
    expect(result.body.publication.transport).toBe("post-no-build-v1");
    expect((await owner(result.body.document.id)).operationId).toBe(result.body.publication.queueId);
  });
  it.each(["missing", "starting", "wrong release", "wrong serializer"])("refuses %s cloud identity without partial acceptance", async mode => {
    const ref = db.doc("system/cmsPublicationRuntime");
    if (mode === "missing") await ref.update({ cloud: null });
    else await ref.update({ cloud: { phase: mode === "starting" ? "starting" : "ready",
      commitSha: mode === "wrong release" ? "b".repeat(40) : sha,
      serializerId: mode === "wrong serializer" ? "cloudflare-dev-publisher" : "cloudflare-publisher" } });
    const before = await snapshot();
    expect((await publish("first")).code).not.toBe(200);
    expect(await snapshot()).toEqual(before);
  });
  it("reads changed admission in a running handler, keeps excluded routes protected and permits withdrawal", async () => {
    const running = handler();
    expect((await publish("first", 1, {}, running)).code).toBe(200);
    expect((await invoke(running, { collection: "cmsPosts", id: "first", baseVersion: 2,
      document: { title: "Private first draft" } })).code).toBe(200);
    await db.doc("system/noBuildPostAdmission").update({ revision: 2, families: { posts: { mode: "ids", ids: ["second"] } } });
    const before = await snapshot();
    expect((await publish("first", 3, {}, running)).code).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect((await publish("second", 1, {}, running)).code).toBe(200);
    expect((await db.doc("cmsPosts/first").get()).data().version).toBe(3);
    const result = await invoke(lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet }),
      { collection: "cmsPosts", id: "first", baseVersion: 3, action: "unpublish" });
    expect(result.code, JSON.stringify(result.body)).toBe(200);
    expect((await decision("/posts/first-story/")).kind).toBe("gone");
    expect((await decision("/posts/second-story/")).kind).toBe("post");
  });
  it("retains a legacy provider while new Posts bind cloud ownership", async () => {
    await db.doc(registry.LEGACY_STATE_PATH).set({ schemaVersion: 1, postId: "first", rendererSha: sha,
      servingEnabled: true, generation: 0, operationId: null, sourceVersion: null, slug: null, visible: false, ownedSlugs: [] });
    expect((await publish("first")).code).toBe(200);
    expect((await owner("first")).runtime.owner).toBe("node-compute");
    expect((await publish("second")).code).toBe(200);
    expect((await owner("second")).runtime.owner).toBe("cloudflare");
  });
  it.each(["missing", "scalar"])("refuses new ownership without a family renderer capability: %s", async mode => {
    const ref = db.doc(registry.CAPABILITY_PATH);
    if (mode === "missing") await ref.delete();
    else await ref.set({ schemaVersion: 1, postId: "second", rendererSha: sha, servingEnabled: true, generation: 1 });
    const before = await snapshot();
    expect((await publish("first")).code).toBe(409);
    expect(await snapshot()).toEqual(before);
  });
  it("keeps a retained alias reserved after withdrawal and refuses ambiguous route ownership", async () => {
    expect((await publish("first")).code).toBe(200);
    expect((await publish("first", 2, { slug: "first-renamed" })).code).toBe(200);
    const withdrawn = await invoke(lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet }),
      { collection: "cmsPosts", id: "first", baseVersion: 4, action: "unpublish" });
    expect(withdrawn.code).toBe(200);
    await db.doc("cmsPosts/second").update({ slug: "first-story" });
    const before = await snapshot();
    const refused = await publish("second");
    expect(refused.code, JSON.stringify(refused.body)).toBe(409);
    expect(await snapshot()).toEqual(before);
    await db.doc("cmsPosts/second").update({ slug: "second-story" });
    expect((await publish("second")).code).toBe(200);
    await db.doc(`${registry.OWNER_COLLECTION}/second`).update({ ownedSlugs: ["second-story", "first-story"] });
    await expect(decision("/posts/first-story/")).rejects.toThrow("Private Post read was refused");
    expect((await worker().fetch(new Request("https://njpbs.org/posts/first-story/"))).status).toBe(503);
  });
  it("refuses a scalar code candidate that cannot preserve two retained Posts", async () => {
    await publish("first"); await publish("second");
    const before = await snapshot();
    await expect(db.runTransaction(transaction => publication.assertNoBuildCandidateInTransaction({ firestore: db, transaction,
      candidate: { commitSha: "b".repeat(40), generation: 2, noBuildPost: { schemaVersion: 1,
        rendererSha: "b".repeat(40), postId: "first", enabled: true, authoritative: true } } }))).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
  });
  it("changes shared renderer capability without rewriting accepted queues, then binds a new operation to active release", async () => {
    expect((await publish("first")).code).toBe(200);
    const retained = await owner("first");
    const ref = db.doc(`cmsPublishQueue/${retained.operationId}`);
    const accepted = (await ref.get()).data();
    const nextSha = "b".repeat(40);
    await db.runTransaction(async transaction => {
      const candidate = { commitSha: nextSha, generation: 2,
        noBuildPost: { schemaVersion: 2, families: ["posts"], rendererSha: nextSha, enabled: true, authoritative: true } };
      const state = await publication.assertNoBuildCandidateInTransaction({ firestore: db, transaction, candidate });
      publication.writeNoBuildCandidateActivation(transaction, db, state, candidate);
      transaction.update(db.doc("system/publicDeployment"), { activeCommitSha: nextSha, activeGeneration: 2,
        lastReservedGeneration: 2, newestEligibleGeneration: 2, newestEligibleBuildBatchId: "next-code" });
      transaction.update(db.doc("system/cmsPublicationRuntime"), { cloud: { phase: "ready", commitSha: nextSha, serializerId: "cloudflare-publisher" } });
    });
    expect(await owner("first")).toEqual(retained);
    expect((await ref.get()).data()).toEqual(accepted);
    const updated = await publish("first", 2, { title: "Active source" });
    expect(updated.code, JSON.stringify(updated.body)).toBe(200);
    const next = await owner("first");
    expect(next.rendererSha).toBe(nextSha);
    expect(next.runtime).toEqual({ owner: "cloudflare", release: nextSha });
    expect((await ref.get()).data().backgroundRuntime).toEqual(accepted.backgroundRuntime);
  });
});

describe("independent public routes, catalog and confirmation", () => {
  it.each(["paused", "narrowed"])("serves and settles both accepted operations when valid admission is %s", async mode => {
    await publish("first"); await publish("second");
    const accepted = await Promise.all([owner("first"), owner("second")]);
    expect((await invoke(handler(), { collection: "cmsPosts", id: "first", baseVersion: 2,
      document: { title: "Private next revision" } })).code).toBe(200);
    await db.doc("system/noBuildPostAdmission").update({ revision: 2, enabled: mode !== "paused",
      families: { posts: mode === "narrowed" ? { mode: "ids", ids: ["another-post"] } : { mode: "all" } } });
    const before = await snapshot();
    expect((await publish("first", 3)).code).toBe(409);
    expect(await snapshot()).toEqual(before);
    const site = worker();
    const catalog = await decision("/_publication.json");
    expect(catalog.catalog.posts.map(post => post.operationId)).toEqual(accepted.map(state => state.operationId));
    expect((await site.fetch(new Request("https://njpbs.org/_publication.json"))).status).toBe(200);
    for (const state of accepted) {
      const result = await site.fetch(new Request(`https://njpbs.org/posts/${state.slug}/`));
      expect(result.status).toBe(200);
      expect(result.headers.get("x-njpbs-publication-operation")).toBe(state.operationId);
    }
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig: { zoneId: "f".repeat(32), token: "fixture-token" },
      fetchPurge: async () => Response.json({ success: true }), fetchPublic: request => site.fetch(new Request(request)) });
    for (const state of accepted) {
      expect(await owner(state.postId)).toEqual(state);
      expect((await db.doc(`cmsPublishQueue/${state.operationId}`).get()).data()).toMatchObject({
        status: "success", attempts: 1, publicReceipt: { operationId: state.operationId, admissionRevision: 2 } });
      expect((await db.doc(`cmsPosts/${state.postId}`).get()).data()).toMatchObject({
        publishBuildPending: false, publicSourceVersion: state.sourceVersion });
    }
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
  });
  it("overlays both Posts in matching ordinary receipts and preserves the other Post across rename and withdrawal", async () => {
    await publish("first"); await publish("second");
    await db.doc("cmsPosts/second").update({ title: "Private second draft" });
    const site = worker();
    const status = await (await site.fetch(new Request("https://njpbs.org/_content-status.json"))).json();
    const receipt = await (await site.fetch(new Request("https://njpbs.org/_publication.json"))).json();
    const routes = readPublicContentStatus(status, receipt);
    expect(routes.map(route => route.path)).toEqual(["/about/", "/posts/first-story/", "/posts/second-story/"]);
    expect((await decision("/posts/second-story/")).published.document.published.metadata.title).toBe("second title");
    expect((await publish("first", 2, { slug: "first-renamed" })).code).toBe(200);
    expect(await decision("/posts/first-story/")).toMatchObject({ kind: "alias", location: "/posts/first-renamed/" });
    expect((await decision("/posts/second-story/")).kind).toBe("post");
    const result = await invoke(lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet }),
      { collection: "cmsPosts", id: "first", baseVersion: 4, action: "unpublish" });
    expect(result.code).toBe(200);
    const nextStatus = await (await site.fetch(new Request("https://njpbs.org/_content-status.json"))).json();
    expect(nextStatus.routes.map(route => route.path)).toEqual(["/about/", "/posts/second-story/"]);
    for (const path of ["/posts/first-story/", "/posts/first-renamed/"]) expect((await decision(path)).kind).toBe("gone");
  });
  it("settles both exact current queues through minute recovery without selecting one singleton", async () => {
    await publish("first"); await publish("second");
    const site = worker();
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig: { zoneId: "f".repeat(32), token: "fixture-token" },
      fetchPurge: async () => Response.json({ success: true }), fetchPublic: request => site.fetch(new Request(request)) });
    for (const id of ["first", "second"]) {
      const state = await owner(id);
      const queue = (await db.doc(`cmsPublishQueue/${state.operationId}`).get()).data();
      expect(queue.status).toBe("success");
      expect(queue.servingReceipt.operationId).toBe(state.operationId);
      expect(queue.purgeReceipt.acknowledged).toBe(true);
      expect(queue.publicReceipt.operationId).toBe(state.operationId);
      expect((await db.doc(`cmsPosts/${id}`).get()).data().publishBuildPending).toBe(false);
    }
  });
  it("recovers both public proofs at their original due time without another purge or publication", async () => {
    await publish("first"); await publish("second");
    const accepted = await Promise.all([owner("first"), owner("second")]);
    const site = worker();
    let time = 1_000_000;
    let proofAvailable = false;
    let purges = 0;
    let reads = 0;
    const input = { firestore: db, now: () => time,
      purgeConfig: { zoneId: "f".repeat(32), token: "fixture-token" },
      fetchPurge: async () => { purges++; return Response.json({ success: true }); },
      fetchPublic: request => {
        reads++;
        if (!proofAvailable) throw new Error("Synthetic public proof outage");
        return site.fetch(new Request(request));
      } };
    await recovery.recoverNoBuildPostDetail(input);
    for (const state of accepted) {
      const queue = (await db.doc(`cmsPublishQueue/${state.operationId}`).get()).data();
      expect(queue).toMatchObject({ status: "success", attempts: 1,
        postProof: { status: "failed", attempts: 1, claim: null, nextAttemptAt: time + 60_000 } });
      expect(queue.publicReceipt).toBeUndefined();
      expect((await db.doc(`cmsPosts/${state.postId}`).get()).data()).toMatchObject({
        publishBuildPending: false, publicSourceVersion: state.sourceVersion,
        publicPostProof: { operationId: state.operationId, status: "failed", retryPending: true } });
    }
    const beforeDue = await snapshot();
    proofAvailable = true;
    time += 59_999;
    await recovery.recoverNoBuildPostDetail(input);
    expect(await snapshot()).toEqual(beforeDue);
    expect([purges, reads]).toEqual([2, 2]);
    time++;
    await recovery.recoverNoBuildPostDetail(input);
    for (const state of accepted) {
      const queue = (await db.doc(`cmsPublishQueue/${state.operationId}`).get()).data();
      expect(queue).toMatchObject({ status: "success", attempts: 1,
        postProof: { status: "verified", attempts: 2, claim: null, nextAttemptAt: null, error: null } });
      expect(queue.publicReceipt).toMatchObject({ operationId: state.operationId,
        sourceVersion: state.sourceVersion, visible: true,
        htmlDigest: createHash("sha256").update(`<!doctype html><html><body>${state.postId} title</body></html>`).digest("hex") });
      expect(await owner(state.postId)).toEqual(state);
      expect((await db.doc(`cmsPosts/${state.postId}`).get()).data()).toMatchObject({
        publishBuildPending: false, publicSourceVersion: state.sourceVersion,
        publicPostProof: { operationId: state.operationId, status: "verified", retryPending: false } });
    }
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
    time += 10 * 60_000;
    await recovery.recoverNoBuildPostDetail(input);
    expect([purges, reads]).toEqual([2, 4]);
  });
  it("confirms a dev Post through the Access gateway without losing the accepted operation", async () => {
    await publish("first");
    const state = await owner("first");
    const site = worker(targets.publicationTarget("development"));
    const requests = [];
    await recovery.recoverNoBuildPostDetail({ firestore: db, operationId: state.operationId,
      target: targets.publicationTarget("development"),
      headers: { "cf-access-client-id": "fixture-access-id", "cf-access-client-secret": "fixture-access-secret" },
      purgeConfig: { zoneId: "f".repeat(32), token: "fixture-token" },
      fetchPurge: async () => Response.json({ success: true }),
      fetchPublic: async (url, init) => {
        const headers = new Headers(init.headers);
        requests.push({ origin: new URL(url).origin, redirect: init.redirect });
        if (headers.get("cf-access-client-id") !== "fixture-access-id" ||
            headers.get("cf-access-client-secret") !== "fixture-access-secret") {
          return new Response(null, { status: 302 });
        }
        return site.fetch(new Request(url, init));
      } });
    expect(requests).toEqual([{ origin: "https://dev-public.example.org", redirect: "manual" }]);
    expect((await db.doc(`cmsPublishQueue/${state.operationId}`).get()).data()).toMatchObject({
      status: "success", publicReceipt: { operationId: state.operationId } });
    expect((await db.doc("cmsPosts/first").get()).data()).toMatchObject({
      publishBuildPending: false, publicSourceVersion: state.sourceVersion });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("waits for an edge refresh within the same confirmation attempt and never accepts the temporary Assets", async () => {
    await publish("first");
    const state = await owner("first");
    const site = worker();
    let reads = 0;
    await recovery.recoverNoBuildPostDetail({ firestore: db, operationId: state.operationId,
      purgeConfig: { zoneId: "f".repeat(32), token: "fixture-token" },
      fetchPurge: async () => Response.json({ success: true }),
      fetchPublic: async (url, init) => {
        if (++reads === 1) return new Response("Full-build Assets", { headers: {
          "x-njpbs-publication-refresh": "pending", "retry-after": "1" } });
        return site.fetch(new Request(url, init));
      } });
    expect(reads).toBe(2);
    expect((await db.doc(`cmsPublishQueue/${state.operationId}`).get()).data()).toMatchObject({
      status: "success", attempts: 1, publicReceipt: { operationId: state.operationId } });
    expect((await db.doc("cmsPosts/first").get()).data().publishBuildPending).toBe(false);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("ends a recovery pass before its scheduler limit and serves remaining due operations on the next pass", async () => {
    const ids = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
    for (const id of ids) {
      if (!["first", "second"].includes(id)) await db.doc(`cmsPosts/${id}`).set(document(id));
      expect((await publish(id)).code).toBe(200);
    }
    const site = worker();
    let clock = Date.now();
    let reads = 0;
    const input = { firestore: db, now: () => clock, purgeConfig: { zoneId: "f".repeat(32), token: "fixture-token" },
      fetchPurge: async () => Response.json({ success: true }), fetchPublic: async request => {
        const result = await site.fetch(new Request(request));
        if (++reads === 4) clock += 45_001;
        return result;
      } };
    await recovery.recoverNoBuildPostDetail(input);
    const after = (await db.collection("cmsPublishQueue").get()).docs.map(row => row.data());
    expect(after.filter(queue => queue.status === "success")).toHaveLength(4);
    expect(after.filter(queue => queue.status === "pending" && queue.attempts === 0)).toHaveLength(4);
    await recovery.recoverNoBuildPostDetail(input);
    expect((await db.collection("cmsPublishQueue").get()).docs.every(row => row.data().status === "success")).toBe(true);
  });
  it("binds dev readback and Access headers to the explicit target, refusing mixed target values before network", async () => {
    await publish("first");
    const state = await owner("first");
    const html = "<!doctype html><html><body>Dev Post</body></html>";
    const headers = { "cf-access-client-id": "fixture-access-id", "cf-access-client-secret": "fixture-access-secret" };
    const target = targets.publicationTarget("development");
    const requests = [];
    const fetchPublic = async (url, options) => {
      requests.push({ origin: new URL(url).origin, headers: new Headers(options.headers), redirect: options.redirect });
      return new Response(html, { headers: { "cache-control": "no-store", "x-njpbs-content-source": "cms-no-build",
        "x-njpbs-publication-operation": state.operationId, "x-njpbs-source-version": String(state.sourceVersion),
        "x-njpbs-admission-revision": "1", "x-njpbs-renderer-sha": sha,
        "x-njpbs-html-sha256": createHash("sha256").update(html).digest("hex") } });
    };
    const candidate = { commitSha: sha, workerVersionId: "fixture-version", noBuildPost: {
      schemaVersion: 2, families: ["posts"], rendererSha: sha, enabled: true, authoritative: true } };
    await recovery.verifyNoBuildPostPublicRoute({ firestore: db, candidate, target, headers, fetchPublic });
    expect(requests).toHaveLength(1);
    expect(requests[0].origin).toBe("https://dev-public.example.org");
    expect(requests[0].headers.get("cf-access-client-secret")).toBe("fixture-access-secret");
    expect(requests[0].redirect).toBe("manual");
    await expect(recovery.verifyNoBuildPostPublicRoute({ firestore: db, candidate, target: { ...target, origin: "https://njpbs.org" }, headers, fetchPublic })).rejects.toThrow("mixed");
    expect(requests).toHaveLength(1);
  });
});
