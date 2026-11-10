import { enrollPublicReleaseLog, publicReleaseEntries } from "../helpers/public-release-producer.js";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import publication from "../../functions/lib/no-build-record-publication.js";
import ownership from "../../functions/lib/no-build-record-ownership.js";
import capability from "../../functions/lib/no-build-record-capability.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import deployment from "../../functions/lib/public-deployment.js";
import media from "../../functions/lib/media-contract.js";
import target from "../../functions/lib/publication-target.js";
import namespace from "../../functions/lib/no-build-record-namespace.js";
import context from "../../functions/lib/public-context-revision.js";
import background from "../../functions/lib/post-background-outputs.js";
import publicContent from "../../functions/public-content.js";
import { recordDocument, asset } from "../../site/tests/fixtures/published-records/fixtures";

const sha = "a".repeat(40), id = "record-one", operationId = "A".repeat(20), transport = "public-context-no-build-v1";
const app = initializeApp({ projectId: "njpbs-site-dev" }, "record-publication-local-proof"), db = getFirestore(app);
const config = { valid: true, enabled: true, admissionRevision: 7,
  families: { programs: { mode: "all" }, events: { mode: "all" } } };
const oldEnvironment = process.env.CMS_DEPLOYMENT_ENVIRONMENT;
function document(kind: "program" | "event" = "program", version = 10, patch = {}, documentId = id) {
  const previous = recordDocument(kind, documentId);
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document: { ...previous.published.metadata,
    version, ...patch }, publishedBy: "editor", publishedAt: "2026-10-23T12:00:00.000Z" });
  return { ...previous, status: "published", version, published, publishAt: published.publishedAt };
}
async function accept(nextDocument: any, options: any = {}) {
  const documentId = options.documentId ?? id;
  return db.runTransaction(async transaction => {
    const result = await publication.prepareNoBuildRecordPublication({ firestore: db, transaction, collection: "cmsPosts", documentId,
      nextDocument, queueRef: db.doc(`cmsPublishQueue/${options.operationId ?? operationId}`), actor: { uid: "editor" }, config, ...options });
    if (!result) return null;
    transaction.set(db.doc(`cmsPosts/${documentId}`), nextDocument);
    transaction.create(db.collection("cmsVersionHistory").doc(), { collection: "cmsPosts", documentId, after: nextDocument });
    result.write();
    if (options.abort) throw new Error("Fixture transaction aborted");
    return result.operation;
  });
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the local demo Firestore emulator");
  process.env.CMS_DEPLOYMENT_ENVIRONMENT = "development";
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeCommitSha: sha,
    activeGeneration: 3, lastReservedGeneration: 3, activeDeploymentId: "fixture-release", newestEligibleGeneration: 3, newestEligibleBuildBatchId: "fixture-release" });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 4 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" });
  await db.doc(capability.CAPABILITY_PATH).set({ schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 3, families: ["programs", "events"],
    terminalOwner: { schemaVersion: 1, rendererSha: sha, transport } });
  const art = { lifecycle: "active", source: "site_seed", url: asset.url, mimeType: asset.mimeType, width: asset.width, height: asset.height, altText: "Public art" };
  await db.doc("media_assets/record-art").set(art); await db.doc("media_assets_public/record-art").set(media.mediaProjection(art));
});
afterAll(async () => { await deleteApp(app); if (oldEnvironment === undefined) delete process.env.CMS_DEPLOYMENT_ENVIRONMENT; else process.env.CMS_DEPLOYMENT_ENVIRONMENT = oldEnvironment; });

it.each(["program", "event"] as const)("accepts a %s snapshot, routes and context in one transaction", async kind => {
  const next = document(kind), family = kind === "program" ? "programs" : "events";
  const operation = await accept(next);
  expect(operation).toMatchObject({ sourceVersion: 10, family, visible: true, contextRevision: 5, generation: 4 });
  const owner = await ownership.readNoBuildRecordOwner({ firestore: db, documentId: id });
  ownership.assertRecordOwnerSnapshot(owner.state, next);
  for (const path of operation.ownedPaths) expect((await ownership.recordRouteRef(db, path).get()).data()).toMatchObject({ documentId: id, path, family });
  const queue = (await db.doc(`cmsPublishQueue/${operationId}`).get()).data();
  expect(queue).toMatchObject({ transport, status: "pending", changes: [], recordPublication: operation });
  expect(publication.recordPublicationReceipt(queue).missingConsumers).toContain(family);
  expect((await db.doc(namespace.NAMESPACE_PATH).get()).data()?.families).toEqual([family]);
  expect((await db.doc(`cmsBackgroundOutputs/${family}`).get()).data()).toMatchObject({ lastGood: null, previousAssets: null });
});
it("rolls back content, history, route claims and namespace on an aborted acceptance", async () => {
  await expect(accept(document(), { abort: true })).rejects.toThrow("aborted");
  expect((await db.doc(`cmsPosts/${id}`).get()).exists).toBe(false);
  expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
  expect((await db.doc(namespace.NAMESPACE_PATH).get()).exists).toBe(false);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).exists).toBe(false);
});
it("keeps the refusal without a complete terminal and rejects paused or unselected new publication", async () => {
  await db.doc(capability.CAPABILITY_PATH).update({ terminalOwner: null });
  await expect(accept(document())).rejects.toThrow();
  await db.doc(capability.CAPABILITY_PATH).set({ schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 3, families: ["programs", "events"] });
  await expect(accept(document())).rejects.toThrow("confirmation and recovery");
  expect(await accept(document(), { config: { ...config, families: {} } })).toBeNull();
  await expect(accept(document(), { config: { ...config, enabled: false } })).rejects.toThrow("paused");
});
it("keeps every accepted alias through rename and refuses a dropped retained path", async () => {
  const first = await accept(document());
  const next = document("program", 11, { slug: "new-name", previousSlugs: ["current-record-one", "earlier-record-one"] });
  const renamed = await accept(next, { operationId: "B".repeat(20) });
  expect(renamed.ownedPaths).toEqual(expect.arrayContaining(first.ownedPaths));
  await expect(accept(document("program", 12, { slug: "third-name", previousSlugs: [] }), { operationId: "C".repeat(20) })).rejects.toThrow("keep every accepted public route");
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.published.sourceVersion).toBe(11);
});
it("withdraws a retained public snapshot after private edits and never drops its durable marker on republish", async () => {
  await accept(document());
  const current = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  await db.doc(`cmsPosts/${id}`).update({ version: 11, title: "Private later title", status: "draft" });
  const removed = await accept({ ...current, title: "Private later title", version: 12, status: "draft", publiclyVisible: false },
    { operationId: "B".repeat(20), config: { ...config, enabled: false, families: {} } });
  expect(removed).toMatchObject({ sourceVersion: 10, visible: false, generation: 5 });
  const withdrawn = (await ownership.readNoBuildRecordOwner({ firestore: db, documentId: id })).state;
  expect(withdrawn.durableWithdrawal).toMatchObject({ operationId: "B".repeat(20), sourceVersion: 10, revision: 5, ownedPaths: removed.ownedPaths });
  await accept(document("program", 13), { operationId: "C".repeat(20) });
  const renewed = (await ownership.readNoBuildRecordOwner({ firestore: db, documentId: id })).state;
  expect(renewed).toMatchObject({ generation: 6, visible: true, durableWithdrawal: withdrawn.durableWithdrawal });
  await expect(publication.readRecordPublication({ firestore: db, operationId: "B".repeat(20) })).rejects.toMatchObject({ code: "record_publication_replaced" });
});
it("does not treat aggregate success as proof of detail, alias or card visibility", async () => {
  await accept(document());
  const ref = db.doc(`cmsPublishQueue/${operationId}`), queue = (await ref.get()).data()!;
  const consumer = { rendererSha: sha, contextRevision: 5, contextDigest: queue.publicContext.contextDigest, verifiedAt: Date.now() };
  await ref.update({ status: "success", aggregateReceipt: { runtime: queue.runtime, contextRevision: 5,
    contextDigest: consumer.contextDigest, outputs: Object.fromEntries([...namespace.CONTEXT_OUTPUTS, "programs"].map(name => [name, consumer])) } });
  const accepted = await publication.readRecordPublication({ firestore: db, operationId });
  expect(accepted.publication).toMatchObject({ status: "pending", missingConsumers: ["pages", "home", "posts", "record"] });
  await db.doc(`cmsPosts/${id}`).update({ title: "Private draft", version: 20, status: "draft" });
  expect((await publication.readRecordPublication({ firestore: db, operationId })).publication.status).toBe("pending");
});

it("retries only the current accepted source and resets exhausted work without a second history event", async () => {
  const retry = await import("../../functions/lib/no-build-record-retry.js");
  await accept(document());
  const ref = db.doc(`cmsPublishQueue/${operationId}`), changes = [{ collection: "cmsPosts", id, sourceVersion: 10 }];
  await ref.update({ status: "failed" });
  const failed = await retry.default.existingNoBuildRecordPublication({ firestore: db, changes });
  expect(failed).toMatchObject({ status: "failed", missingConsumers: expect.arrayContaining(["record"]), warning: expect.stringContaining("Retry") });
  await ref.collection("backgroundOutputs").doc("programs").update({ status: "failed", attempts: 4 });
  await expect(retry.default.existingNoBuildRecordPublication({ firestore: db, changes, retry: true, baseVersion: 9 })).rejects.toThrow("Reload");
  const result = await retry.default.existingNoBuildRecordPublication({ firestore: db, changes, retry: true, baseVersion: 10 });
  expect(result).toMatchObject({ queueId: operationId, dispatched: false, status: "pending" });
  expect((await ref.collection("backgroundOutputs").doc("programs").get()).data()).toMatchObject({ status: "pending", attempts: 0 });
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.version).toBe(10);
  await expect(retry.default.existingNoBuildRecordPublication({ firestore: db, changes: [{ ...changes[0], sourceVersion: 9 }], retry: true, baseVersion: 10 })).rejects.toThrow("existing publication");
});
it("creates one successor for a newer context and renderer while retaining the original record operation", async () => {
  const retry = await import("../../functions/lib/no-build-record-retry.js");
  await accept(document());
  const ref = db.doc(`cmsPublishQueue/${operationId}`), original = (await ref.get()).data();
  await ref.update({ status: "failed" });
  const nextSha = "b".repeat(40);
  await db.doc("system/publicDeployment").update({ activeCommitSha: nextSha });
  await db.doc("system/cmsPublicationRuntime").update({ commitSha: nextSha });
  await db.doc(capability.CAPABILITY_PATH).update({ rendererSha: nextSha, "terminalOwner.rendererSha": nextSha });
  await db.doc("system/publicDeployment/contexts/public").update({ revision: 6 });
  await db.doc(`cmsPosts/${id}`).update({ version: 11, title: "Private later draft", status: "draft" });
  const changes = [{ collection: "cmsPosts", id, sourceVersion: 10 }];
  const result = await retry.default.existingNoBuildRecordPublication({ firestore: db, changes, retry: true, baseVersion: 11 });
  expect(result.queueId).not.toBe(operationId);
  const successor = (await db.doc(`cmsPublishQueue/${result.queueId}`).get()).data();
  expect(successor.recordPublication).toMatchObject({ originalOperationId: operationId, sourceVersion: 10, rendererSha: nextSha,
    contextRevision: 6, snapshotDigest: original.recordPublication.snapshotDigest, generation: original.recordPublication.generation });
  expect((await ref.get()).data().recordPublication).toEqual(original.recordPublication);
  expect((await ownership.readNoBuildRecordOwner({ firestore: db, documentId: id })).state.operationId).toBe(operationId);
  const again = await retry.default.existingNoBuildRecordPublication({ firestore: db, changes, retry: true, baseVersion: 11 });
  expect(again.queueId).toBe(result.queueId);
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
  expect((await publication.readRecordPublication({ firestore: db, operationId })).ref.id).toBe(result.queueId);
});


it("refuses acceptance when the static visibility contract omits the prospective record", async () => {
  const next = document(); Reflect.deleteProperty(next, "publishAt");
  await expect(accept(next)).rejects.toThrow("absent from its public family input");
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).exists).toBe(false);
});


it("requires enabled admission before adopting a static record for withdrawal", async () => {
  const stored = document(); await db.doc(`cmsPosts/${id}`).set(stored);
  const next = { ...stored, version: 11, publiclyVisible: false, status: "draft" };
  await expect(accept(next, { config: { ...config, enabled: false } })).rejects.toThrow("paused");
  expect((await db.doc(namespace.NAMESPACE_PATH).get()).exists).toBe(false);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).exists).toBe(false);
  const removed = await accept(next);
  expect(removed).toMatchObject({ visible: false, sourceVersion: 10 });
  expect((await db.doc(namespace.NAMESPACE_PATH).get()).data().families).toEqual(["programs"]);
});

it("keeps incompatible static withdrawals refused while the full-site build is retired", async () => {
  const stored = document("event"); Reflect.deleteProperty(stored.published.metadata, "previousSlugs");
  await db.doc(`cmsPosts/${id}`).set(stored);
  await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
  await expect(accept({ ...stored, version: 11, publiclyVisible: false, status: "draft" })).rejects.toThrow("retained slugs");
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toEqual(stored);
  expect((await db.doc(namespace.NAMESPACE_PATH).get()).exists).toBe(false);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).exists).toBe(false);
});

async function pausePrerequisite(pause: string) {
  if (pause === "billing") await db.doc("system/billing").set({ disabled: true });
  if (pause === "runtime") await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  if (pause === "capability") await db.doc(capability.CAPABILITY_PATH).update({ servingEnabled: false });
  if (pause === "release") {
    const pointer = (await db.doc("system/publicDeployment").get()).data();
    await db.doc("system/publicDeployment").set({ ...pointer, state: "deploying", lastReservedGeneration: 4,
      newestEligibleGeneration: 4, newestEligibleBuildBatchId: "pending-release", candidateGeneration: 4,
      candidateBuildBatchId: "pending-release", candidateCommitSha: "b".repeat(40), leaseToken: "fixture-lease",
      leaseAcquiredAt: Timestamp.fromMillis(Date.now()), predecessorGeneration: 3,
      predecessorDeploymentId: "fixture-release", predecessorCommitSha: sha });
  }
}
it.each(["release", "billing", "runtime", "capability"])("defers a temporary %s prerequisite refusal", async pause => {
  await pausePrerequisite(pause);
  const failure = await accept(document()).then(() => null, error => error);
  expect(failure).toBeInstanceOf(Error); expect(failure.scheduleDeferred).toBe(true);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).exists).toBe(false);
});
it.each(["release", "billing", "runtime", "capability"])("withdraws an accepted record during a %s pause", async pause => {
  await accept(document());
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  await pausePrerequisite(pause);
  if (pause === "capability") await db.doc(capability.CAPABILITY_PATH).delete();
  const removed = await accept({ ...stored, version: 11, publiclyVisible: false, status: "draft" }, { operationId: "B".repeat(20) });
  expect(removed).toMatchObject({ visible: false, sourceVersion: 10, generation: 5 });
  expect((await ownership.readNoBuildRecordOwner({ firestore: db, documentId: id })).state.durableWithdrawal)
    .toMatchObject({ operationId: "B".repeat(20), sourceVersion: 10, revision: 5 });
  const response: any = { statusCode: 0, body: null, set() { return this; }, status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; } };
  const artifacts = { async get() { throw new Error("Removal must not read artifacts"); }, async put() { throw new Error("Removal must not write artifacts"); } };
  await publicContent.createCmsGetPublicPageHandler({ firestore: db, backgroundArtifacts: artifacts, log: { error() {}, warn() {} } })({ method: "POST",
    body: { mode: "no-build-post-v1", path: removed.canonicalPath, rendererSha: sha } }, response);
  expect(response.statusCode).toBe(200); expect(response.body.status).toBe(410); expect(response.body.bytes).toBe("");
});
it("keeps the active runtime identity fence on accepted removals", async () => {
  await accept(document());
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  await db.doc("system/cmsPublicationRuntime").update({ commitSha: "b".repeat(40), phase: "paused" });
  await expect(accept({ ...stored, version: 11, publiclyVisible: false, status: "draft" }, { operationId: "B".repeat(20) }))
    .rejects.toThrow("active record publication owner changed");
  expect((await ownership.readNoBuildRecordOwner({ firestore: db, documentId: id })).state.visible).toBe(true);
  expect((await db.doc(`cmsPublishQueue/${"B".repeat(20)}`).get()).exists).toBe(false);
});
it.each(["source", "generation"])("does not defer a permanent %s refusal", async invalid => {
  const next = document();
  if (invalid === "source") next.version += 1;
  else await db.doc(capability.CAPABILITY_PATH).update({ generation: Number.MAX_SAFE_INTEGER });
  const failure = await accept(next).then(() => null, error => error);
  expect(failure).toBeInstanceOf(Error); expect(failure.scheduleDeferred).not.toBe(true);
  expect(failure.message).toContain(invalid === "source" ? "accepted record source changed" : "generation is exhausted");
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).exists).toBe(false);
});
it("keeps sibling routes and cached assets while fencing the changed record's source", async () => {
  const first = await accept(document());
  const sibling = await accept(document("program", 10, {}, "record-two"), { documentId: "record-two", operationId: "B".repeat(20) });
  const paths = ["/programs/", "/shows/", ...first.ownedPaths, ...sibling.ownedPaths];
  const objects = new Map<string, Buffer>();
  const artifacts = { async put(key: string, bytes: Buffer) { if (!objects.has(key)) objects.set(key, Buffer.from(bytes)); },
    async get(key: string) { return objects.get(key) ?? null; } };
  let generation = "first";
  const owner = background.createPostBackgroundOutputs({ firestore: db, enabled: true, runtime: { owner: "cloudflare", release: sha },
    postIds: [], recoveryOutputs: ["programs"], artifacts,
    readContextInTransaction: (transaction: any) => context.readPublicBackgroundContextInTransaction(transaction, db),
    build: async (task: any) => ({ input: { kind: "public-background", rendererSha: sha, contextDigest: task.contextDigest, routes: [] },
      files: paths.map(path => ({ path, bytes: `<!doctype html><html><main>${generation} ${path}</main></html>`, contentType: "text/html; charset=utf-8" })),
      assets: [{ path: `/_astro/${generation}.js`, bytes: "public script", contentType: "text/javascript; charset=utf-8" }] }) });
  async function request(path: string) {
    const response: any = { statusCode: 0, body: null, set() { return this; }, status(value: number) { this.statusCode = value; return this; },
      json(body: any) { this.body = body; return this; } };
    await publicContent.createCmsGetPublicPageHandler({ firestore: db, backgroundArtifacts: artifacts, log: { error() {}, warn() {} } })({ method: "POST",
      body: { mode: "no-build-post-v1", path, rendererSha: sha } }, response);
    return response;
  }
  await owner.recover();
  expect((await request(sibling.canonicalPath)).body.status).toBe(200);
  const verified = (await db.doc("cmsBackgroundOutputs/programs").get()).data()!.receipt;
  await accept(document("program", 11), { operationId: "C".repeat(20) });
  expect((await db.doc("cmsBackgroundOutputs/programs").get()).data()?.lastGood.receipt.digest).toBe(verified.digest);
  expect((await request(first.canonicalPath)).statusCode).toBe(503);
  const unchanged = await request(sibling.canonicalPath);
  expect(unchanged.body.status).toBe(200); expect(unchanged.body.headers["x-njpbs-source-version"]).toBe("10");
  expect(Buffer.from(unchanged.body.bytes, "base64").toString()).toContain(`first ${sibling.canonicalPath}`);
  expect((await request("/programs/")).body.status).toBe(200);
  expect((await request("/_astro/first.js")).body.status).toBe(200);
  await db.doc("cmsBackgroundOutputs/programs").update({ status: "failed" });
  expect((await request(sibling.canonicalPath)).body.status).toBe(200);
  generation = "replacement"; await owner.recover();
  const updated = await request(first.canonicalPath);
  expect(updated.body.status).toBe(200); expect(updated.body.headers["x-njpbs-source-version"]).toBe("11");
  expect(Buffer.from(updated.body.bytes, "base64").toString()).toContain(`replacement ${first.canonicalPath}`);
  expect((await request("/_astro/first.js")).body.status).toBe(200);
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  await accept({ ...stored, version: 12, publiclyVisible: false, status: "draft" }, { operationId: "D".repeat(20) });
  expect((await request(first.canonicalPath)).body.status).toBe(410);
  expect((await request(sibling.canonicalPath)).body.status).toBe(200);
});


it.each(["billing", "runtime"])("holds %s-paused removal regeneration and resumes only the accepted source", async pause => {
  const retry = (await import("../../functions/lib/no-build-record-retry.js")).default;
  const identity = await accept(document());
  const objects = new Map<string, Buffer>(), builds: any[] = [];
  const artifacts = { async put(key: string, bytes: Buffer) { if (!objects.has(key)) objects.set(key, Buffer.from(bytes)); },
    async get(key: string) { return objects.get(key) ?? null; } };
  const generator = background.createPostBackgroundOutputs({ firestore: db, enabled: true, runtime: { owner: "cloudflare", release: sha },
    postIds: [], recoveryOutputs: ["programs"], artifacts,
    readContextInTransaction: (transaction: any) => context.readPublicBackgroundContextInTransaction(transaction, db),
    build: async (task: any) => {
      const source = (await db.doc(`cmsPosts/${id}`).get()).data()!;
      builds.push({ sourceVersion: source.published.sourceVersion, visible: source.publiclyVisible !== false });
      return { input: { kind: "public-background", rendererSha: sha, contextDigest: task.contextDigest, routes: [] },
        files: ["/programs/", "/shows/", ...(source.publiclyVisible === false ? [] : identity.ownedPaths)]
          .map(path => ({ path, bytes: `<!doctype html><html><main>${path}</main></html>`, contentType: "text/html; charset=utf-8" })) };
    } });
  await generator.recover(); expect(builds).toEqual([{ sourceVersion: 10, visible: true }]);
  const before = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data();
  const pointer = (await db.doc("system/publicDeployment/aggregateContexts/current").get()).data();
  const state = (await db.doc("cmsBackgroundOutputs/programs").get()).data();
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  await pausePrerequisite(pause);
  const removed = await accept({ ...stored, version: 11, publiclyVisible: false, status: "draft" }, { operationId: "B".repeat(20) });
  const ref = db.doc(`cmsPublishQueue/${removed.operationId}`);
  expect((await ref.get()).data()).toMatchObject({ recordRegeneration: "deferred", transport, status: "pending", changes: [],
    recordPublication: { originalOperationId: removed.operationId, sourceVersion: 10, contextRevision: before!.revision } });
  expect((await ref.collection("backgroundOutputs").get()).empty).toBe(true);
  expect((await ref.collection("backgroundPreparation").get()).empty).toBe(true);
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()).toEqual(before);
  expect((await db.doc("system/publicDeployment/aggregateContexts/current").get()).data()).toEqual(pointer);
  expect((await db.doc("cmsBackgroundOutputs/programs").get()).data()).toEqual(state);
  const withdrawn = (await ownership.readNoBuildRecordOwner({ firestore: db, documentId: id })).state;
  expect(withdrawn.durableWithdrawal).toMatchObject({ operationId: removed.operationId, sourceVersion: 10, revision: removed.generation });
  await generator.recover(); expect(builds).toHaveLength(1);
  expect(await retry.resumeDeferredRecordPublication({ firestore: db, operationId: ref.id })).toMatchObject({ paused: true });
  expect(await retry.existingNoBuildRecordPublication({ firestore: db, changes: [{ collection: "cmsPosts", id, sourceVersion: 10, operation: "withdraw" }],
    retry: true, baseVersion: 11 })).toMatchObject({ queueId: ref.id, status: "pending", warning: expect.stringContaining("will resume") });
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()).toEqual(before);
  // A later private edit must not become the public source during automatic resume.
  await db.doc(`cmsPosts/${id}`).update({ version: 12, title: "Private title", status: "draft" });
  await db.doc("system/billing").set({ disabled: false });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "ready" });
  const results = await Promise.all([1, 2].map(() => retry.resumeDeferredRecordPublication({ firestore: db, operationId: ref.id })));
  const originalQueue = (await ref.get()).data()!;
  expect(originalQueue).toMatchObject({ recordRegeneration: "superseded", status: "cancelled", error: "record_regeneration_superseded" });
  const queueId = originalQueue.successorOperationId;
  expect(results.some(result => result.resumed)).toBe(true);
  const successor = (await db.doc(`cmsPublishQueue/${queueId}`).get()).data()!;
  expect(successor).toMatchObject({ recordRegeneration: "active", recordPublication: { originalOperationId: removed.operationId,
    sourceVersion: 10, generation: removed.generation, snapshotDigest: removed.snapshotDigest, contextRevision: before!.revision + 1 } });
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()!.revision).toBe(before!.revision + 1);
  expect((await ownership.readNoBuildRecordOwner({ firestore: db, documentId: id })).state).toEqual(withdrawn);
  await generator.recover(); expect(builds).toEqual([{ sourceVersion: 10, visible: true }, { sourceVersion: 10, visible: false }]);
  const task = db.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/programs`);
  await task.update({ status: "failed", attempts: 4 });
  await db.doc(`cmsPublishQueue/${queueId}`).update({ status: "failed" });
  expect(await retry.resumeDeferredRecordPublication({ firestore: db, operationId: queueId })).toMatchObject({ paused: false, resumed: false, queueId });
  expect((await task.get()).data()).toMatchObject({ status: "failed", attempts: 4 });
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ version: 12, title: "Private title", publiclyVisible: false,
    published: { sourceVersion: 10 } });
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(2);
});


it("retires a deferred bookkeeping queue when a new record publication replaces its source", async () => {
  const retry = (await import("../../functions/lib/no-build-record-retry.js")).default;
  await accept(document());
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  await pausePrerequisite("billing");
  await accept({ ...stored, version: 11, publiclyVisible: false, status: "draft" }, { operationId: "B".repeat(20) });
  await db.doc("system/billing").set({ disabled: false });
  await accept(document("program", 12), { operationId: "C".repeat(20) });
  expect(await retry.resumeDeferredRecordPublication({ firestore: db, operationId: "B".repeat(20) })).toEqual({ paused: true });
  expect((await db.doc(`cmsPublishQueue/${"B".repeat(20)}`).get()).data()).toMatchObject({
    recordRegeneration: "superseded", status: "cancelled", error: "record_regeneration_superseded" });
  expect((await ownership.readNoBuildRecordOwner({ firestore: db, documentId: id })).state).toMatchObject({ visible: true, sourceVersion: 12 });
});


it.each(["context", "replacement"])("preserves successful regeneration history after a later %s", async change => {
  const retry = (await import("../../functions/lib/no-build-record-retry.js")).default;
  await accept(document());
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  await pausePrerequisite("billing");
  await accept({ ...stored, version: 11, publiclyVisible: false, status: "draft" }, { operationId: "B".repeat(20) });
  await db.doc("system/billing").set({ disabled: false });
  const first = await retry.resumeDeferredRecordPublication({ firestore: db, operationId: "B".repeat(20) });
  const ref = db.doc(`cmsPublishQueue/${first.queueId}`), completedAt = Timestamp.fromMillis(1_700_000_000_000);
  await ref.update({ status: "success", completedAt, error: null });
  if (change === "context") await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 7 });
  else await accept(document("program", 12), { operationId: "C".repeat(20) });
  await retry.resumeDeferredRecordPublication({ firestore: db, operationId: ref.id });
  expect((await ref.get()).data()).toMatchObject({ recordRegeneration: "superseded", status: "success", completedAt, error: null });
});


it("reports all pending consumers when a partially confirmed receipt needs a successor", async () => {
  const retry = (await import("../../functions/lib/no-build-record-retry.js")).default;
  await accept(document());
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  await pausePrerequisite("billing");
  await accept({ ...stored, version: 11, publiclyVisible: false, status: "draft" }, { operationId: "B".repeat(20) });
  await db.doc("system/billing").set({ disabled: false });
  const resumed = await retry.resumeDeferredRecordPublication({ firestore: db, operationId: "B".repeat(20) });
  const ref = db.doc(`cmsPublishQueue/${resumed.queueId}`), queue = (await ref.get()).data()!;
  const consumer = { rendererSha: sha, contextRevision: 6, contextDigest: context.publicContextDigest(6), verifiedAt: Date.now() };
  await ref.update({ status: "success", consumerReceipts: { pages: consumer, home: consumer, posts: consumer },
    aggregateReceipt: { runtime: queue.runtime, contextRevision: 6, contextDigest: consumer.contextDigest,
      outputs: Object.fromEntries([...namespace.CONTEXT_OUTPUTS, "programs"].map(name => [name, consumer])) } });
  expect((await publication.readRecordPublication({ firestore: db, operationId: "B".repeat(20) })).publication.missingConsumers).toEqual(["record"]);
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 7 });
  const result = await retry.existingNoBuildRecordPublication({ firestore: db,
    changes: [{ collection: "cmsPosts", id, sourceVersion: 10, operation: "withdraw" }], retry: true, baseVersion: 11 });
  expect(result.queueId).not.toBe(ref.id);
  expect(result.status).toBe("pending");
  expect(result.missingConsumers).toEqual(["pages", "home", "posts", "record", "listings", "authors", "feed", "contentApi", "sitemap", "search", "programs"]);
});
it("keeps a fully confirmed tracked receipt complete after a later context", async () => {
  const retry = (await import("../../functions/lib/no-build-record-retry.js")).default;
  await accept(document());
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  await pausePrerequisite("billing");
  await accept({ ...stored, version: 11, publiclyVisible: false, status: "draft" }, { operationId: "B".repeat(20) });
  await db.doc("system/billing").set({ disabled: false });
  const resumed = await retry.resumeDeferredRecordPublication({ firestore: db, operationId: "B".repeat(20) });
  const ref = db.doc(`cmsPublishQueue/${resumed.queueId}`), queue = (await ref.get()).data()!;
  const consumer = { rendererSha: sha, contextRevision: 6, contextDigest: context.publicContextDigest(6), verifiedAt: Date.now() };
  await ref.update({ status: "success", consumerReceipts: { pages: consumer, home: consumer, posts: consumer, record: consumer },
    aggregateReceipt: { runtime: queue.runtime, contextRevision: 6, contextDigest: consumer.contextDigest,
      outputs: Object.fromEntries([...namespace.CONTEXT_OUTPUTS, "programs"].map(name => [name, consumer])) } });
  expect((await publication.readRecordPublication({ firestore: db, operationId: "B".repeat(20) })).publication.status).toBe("success");
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 7 });
  const result = await retry.existingNoBuildRecordPublication({ firestore: db,
    changes: [{ collection: "cmsPosts", id, sourceVersion: 10, operation: "withdraw" }], retry: true, baseVersion: 11 });
  expect(result).toMatchObject({ queueId: ref.id, status: "success", missingConsumers: [] });
  expect((await ref.get()).data()?.recordRegeneration).toBe("complete");
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(3);
});

it("change-log: accepts record namespace and immutable source evidence atomically", async () => {
  await enrollPublicReleaseLog(db, sha);
  await accept(document());
  const [entry] = await publicReleaseEntries(db);
  expect(entry.operationId).toBe(operationId);
  expect(entry.changes).toMatchObject([{ kind: "record", id, action: "publish", sourceVersion: 10 }]);
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.published.sourceVersion).toBe(10);
});
it("change-log: abort leaves no record, namespace or event", async () => {
  await enrollPublicReleaseLog(db, sha);
  await expect(accept(document(), { abort: true })).rejects.toThrow("aborted");
  expect(await publicReleaseEntries(db)).toEqual([]);
  expect((await db.doc(`cmsPosts/${id}`).get()).exists).toBe(false);
  expect((await db.doc(namespace.NAMESPACE_PATH).get()).exists).toBe(false);
});
