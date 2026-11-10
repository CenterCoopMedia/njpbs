import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import publication from "../../functions/lib/no-build-record-publication.js";
import confirmation from "../../functions/lib/no-build-record-confirmation.js";
import capability from "../../functions/lib/no-build-record-capability.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import deployment from "../../functions/lib/public-deployment.js";
import media from "../../functions/lib/media-contract.js";
import context from "../../functions/lib/public-context-revision.js";
import aggregate from "../../functions/lib/public-context-publication.js";
import background from "../../functions/lib/post-background-outputs.js";
import publicContent from "../../functions/public-content.js";
import targets from "../../functions/lib/publication-target.js";
import { recordDocument, asset } from "../../site/tests/fixtures/published-records/fixtures";
import { createHash } from "node:crypto";

const sha = "a".repeat(40), id = "record-one", op = "A".repeat(20), target = targets.publicationTarget("development");
const runtime = { owner: "cloudflare", release: sha }, config = { valid: true, enabled: true, admissionRevision: 7,
  families: { programs: { mode: "all" }, events: { mode: "all" } } };
const app = initializeApp({ projectId: "njpbs-site-dev" }, "record-confirmation-proof"), db = getFirestore(app);
const headers = { "cf-access-client-id": "fixture-client", "cf-access-client-secret": "fixture-value" };
const oldEnvironment = process.env.CMS_DEPLOYMENT_ENVIRONMENT;
const objects = new Map<string, Buffer>();
const artifacts = { async put(key: string, bytes: Buffer) { if (!objects.has(key)) objects.set(key, Buffer.from(bytes)); },
  async get(key: string) { return objects.get(key) ?? null; } };
const html = (path: string) => `<!doctype html><html><main>Frozen ${path}</main></html>`;
let corruptPath: string | undefined, duringRead: (() => Promise<void>) | undefined, durable = false;
async function accept(kind: "program" | "event" = "program", removed = false) {
  const original = recordDocument(kind, id), previous = (await db.doc(`cmsPosts/${id}`).get()).data();
  const next = removed ? { ...previous, version: 11, status: "draft", publiclyVisible: false } : {
    ...original, version: 10, status: "published", publishAt: "2026-10-23T12:00:00.000Z", published: snapshots.createPublishedSnapshot({ collection: "cmsPosts",
      document: { ...original.published.metadata, version: 10 }, publishedBy: "editor", publishedAt: "2026-10-23T12:00:00.000Z" }) };
  const operationId = removed ? "B".repeat(20) : op;
  return db.runTransaction(async transaction => {
    const work = await publication.prepareNoBuildRecordPublication({ firestore: db, transaction, collection: "cmsPosts", documentId: id,
      nextDocument: next, queueRef: db.doc(`cmsPublishQueue/${operationId}`), actor: { uid: "editor" }, config });
    transaction.set(db.doc(`cmsPosts/${id}`), { ...next, publishBuildPending: true, publishBuildQueueId: operationId }); work.write();
    return work.operation;
  });
}
async function prepare(identity: any, consumers = true) {
  const paths: Record<string, string[]> = { listings: ["/posts/"], authors: ["/authors/example/"], feed: ["/feeds/news.xml"],
    contentApi: ["/api/v1/content.json"], sitemap: ["/sitemap-index.xml"], search: ["/pagefind/pagefind.js", "/search/meaning-index.json"],
    [identity.family]: [...(identity.family === "programs" ? ["/programs/", "/shows/"] : ["/events/"]), ...(identity.visible ? identity.ownedPaths : [])] };
  const owner = background.createPostBackgroundOutputs({ firestore: db, runtime, enabled: true, postIds: [], recoveryOutputs: Object.keys(paths), artifacts,
    readContextInTransaction: (transaction: any) => context.readPublicBackgroundContextInTransaction(transaction, db),
    build: async (task: any) => ({ input: { kind: "public-background", rendererSha: sha, contextDigest: identity.contextDigest, routes: [] },
      files: paths[task.output].map(path => ({ path, bytes: html(path), contentType: "text/html; charset=utf-8" })) }) });
  await owner.recover();
  expect(await aggregate.settlePublicContext({ firestore: db, operationId: identity.operationId, runtime })).toBe(true);
  if (consumers) {
    const consumer = { rendererSha: sha, contextRevision: identity.contextRevision, contextDigest: identity.contextDigest, verifiedAt: Date.now() };
    await db.doc(`cmsPublishQueue/${identity.operationId}`).update({ consumerReceipts: { pages: consumer, home: consumer, posts: consumer } });
  }
}
async function fetchPublic(url: string) {
  const path = new URL(url).pathname;
  const reply: any = { body: null, statusCode: 0, set() { return this; }, status(code: number) { this.statusCode = code; return this; }, json(body: any) { this.body = body; return this; } };
  await publicContent.createCmsGetPublicPageHandler({ firestore: db, backgroundArtifacts: artifacts, log: { error() {}, warn() {} } })({ method: "POST",
    body: { mode: "no-build-post-v1", path, rendererSha: sha } }, reply);
  if (reply.statusCode !== 200 || reply.body.kind !== "background") throw new Error("Fixture origin unavailable");
  const result = new Response(path === corruptPath ? html("wrong frozen alias") : Buffer.from(reply.body.bytes, "base64"), { status: reply.body.status, headers: reply.body.headers });
  if (durable && result.status === 410) {
    const state = (await db.doc(`system/publicDeployment/noBuildRecordOwners/${id}`).get()).data();
    result.headers.set("x-njpbs-durable-withdrawal-operation", state.durableWithdrawal.operationId);
    result.headers.set("x-njpbs-withdrawal-revision", String(state.durableWithdrawal.revision));
  }
  if (duringRead) { const change = duringRead; duringRead = undefined; await change(); }
  return result;
}
const recover = (operationId = op) => confirmation.recoverNoBuildRecordPublication({ firestore: db, operationId, target, headers, artifacts, fetchPublic });
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the local demo Firestore emulator");
  process.env.CMS_DEPLOYMENT_ENVIRONMENT = "development";
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  objects.clear(); corruptPath = undefined; duringRead = undefined; durable = false;
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeCommitSha: sha,
    activeGeneration: 3, lastReservedGeneration: 3, activeDeploymentId: "fixture-release", newestEligibleGeneration: 3, newestEligibleBuildBatchId: "fixture-release" });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 4 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" });
  await db.doc(capability.CAPABILITY_PATH).set({ schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 3, families: ["programs", "events"],
    terminalOwner: { schemaVersion: 1, rendererSha: sha, transport: "public-context-no-build-v1" } });
  const art = { lifecycle: "active", source: "site_seed", url: asset.url, mimeType: asset.mimeType, width: asset.width, height: asset.height, altText: "Public art" };
  await db.doc("media_assets/record-art").set(art); await db.doc("media_assets_public/record-art").set(media.mediaProjection(art));
});
afterAll(async () => { await deleteApp(app); if (oldEnvironment === undefined) delete process.env.CMS_DEPLOYMENT_ENVIRONMENT; else process.env.CMS_DEPLOYMENT_ENVIRONMENT = oldEnvironment; });

it.each(["program", "event"] as const)("confirms every %s detail, alias and index against immutable bytes", async kind => {
  const identity = await accept(kind); await prepare(identity);
  expect(await recover()).toEqual({ confirmed: true });
  const queue = (await db.doc(`cmsPublishQueue/${op}`).get()).data();
  expect(publication.recordPublicationReceipt(queue).status).toBe("success");
  expect(queue.recordReceipt.routes.map((route: any) => route.path)).toEqual(expect.arrayContaining(identity.ownedPaths));
  expect(queue.recordReceipt.routes).toHaveLength(identity.ownedPaths.length + (kind === "program" ? 2 : 1));
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ publishBuildPending: false, publishBuildQueueId: null, publicSourceVersion: 10,
    publishBuildSettlement: { recordQueueId: identity.operationId, sourceVersion: 10, status: "success" } });
});
it("keeps staff pending until Page, Home and Post card consumers finish", async () => {
  await prepare(await accept(), false);
  expect(await recover()).toEqual({ confirmed: false });
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.publishBuildPending).toBe(true);
});
it("rejects a changed alias body and never acknowledges a subset", async () => {
  const identity = await accept(); await prepare(identity); corruptPath = identity.ownedPaths[1];
  await expect(recover()).rejects.toThrow("receipt is unavailable");
  expect((await db.doc(`cmsPublishQueue/${op}`).get()).data()?.consumerReceipts.record).toBeUndefined();
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.publishBuildPending).toBe(true);
  corruptPath = undefined; expect(await recover()).toEqual({ confirmed: true });
});
it("requires the exact durable withdrawal before confirming absence and updated indexes", async () => {
  await accept(); const identity = await accept("program", true); await prepare(identity);
  await expect(recover(identity.operationId)).rejects.toThrow("receipt is unavailable");
  durable = true; expect(await recover(identity.operationId)).toEqual({ confirmed: true });
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ publiclyVisible: false, publicSourceVersion: null, publishBuildPending: false });
});
it("refuses source or context changes during public IO", async () => {
  await prepare(await accept());
  duringRead = async () => { await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 6 }); };
  await expect(recover()).rejects.toThrow();
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.publishBuildPending).toBe(true);
  expect((await db.doc(`cmsPublishQueue/${op}`).get()).data()?.consumerReceipts.record).toBeUndefined();
});

it.each(["billing", "runtime"])("recovers a %s-paused removal after resume without a staff retry", async pause => {
  await prepare(await accept()); await recover();
  if (pause === "billing") await db.doc("system/billing").set({ disabled: true });
  else await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  const removed = await accept("program", true);
  const ref = db.doc(`cmsPublishQueue/${removed.operationId}`);
  expect((await ref.get()).data()?.recordRegeneration).toBe("deferred");
  // Paused queue events must not start even Home/card confirmation requests.
  const handler = (await import("../../functions/no-build-post-confirmation.js")).default.createNoBuildPostConfirmationHandler({
    firestore: db, readback: () => ({ target, headers }),
    fetchPublic: async () => { throw new Error("Paused removal must not read public routes"); } });
  await handler({ params: { queueId: ref.id }, data: { after: await ref.get() } });
  await confirmation.recoverNoBuildRecordPublication({ firestore: db, target, headers, artifacts,
    fetchPublic: async () => { throw new Error("Paused removal must not read public routes"); } });
  expect((await ref.get()).data()?.successorOperationId).toBeUndefined();
  await db.doc(`cmsPosts/${id}`).update({ version: 12, title: "Later private draft" });
  await db.doc("system/billing").set({ disabled: false });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "ready" });
  // The existing minute recovery finds a queue that is not the context pointer.
  await confirmation.recoverNoBuildRecordPublication({ firestore: db, target, headers, artifacts, fetchPublic });
  const successorId = (await ref.get()).data()!.successorOperationId;
  const successor = (await db.doc(`cmsPublishQueue/${successorId}`).get()).data()!;
  expect(successor).toMatchObject({ recordRegeneration: "active", recordPublication: { originalOperationId: removed.operationId,
    sourceVersion: 10, generation: removed.generation, snapshotDigest: removed.snapshotDigest, contextRevision: 6 } });
  await prepare(successor.recordPublication); durable = true;
  expect(await recover(successorId)).toEqual({ confirmed: true });
  expect((await db.doc(`cmsPublishQueue/${successorId}`).get()).data()?.recordRegeneration).toBe("complete");
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ version: 12, title: "Later private draft",
    published: { sourceVersion: 10 }, publiclyVisible: false, publishBuildPending: false, publishBuildQueueId: null,
    publishBuildSettlement: { recordQueueId: successorId, status: "success" } });
});


it.each([false, true])("confirms production legacy Program redirects with removed=%s", async removed => {
  const published = await accept();
  const identity = removed ? await accept("program", true) : published;
  await prepare(identity); durable = true;
  const edgeFetch = async (url: string) => {
    const path = new URL(url).pathname;
    return path.startsWith("/shows/") ? new Response(null, { status: 301,
      headers: { location: `${target.origin}${path.replace(/^\/shows\//, "/programs/")}` } }) : fetchPublic(url);
  };
  expect(await confirmation.recoverNoBuildRecordPublication({ firestore: db, operationId: identity.operationId,
    target, headers, artifacts, fetchPublic: edgeFetch })).toEqual({ confirmed: true });
  const queue = (await db.doc(`cmsPublishQueue/${identity.operationId}`).get()).data()!;
  expect(queue.recordReceipt.routes.filter((route: any) => route.path.startsWith("/shows/")))
    .toEqual(expect.arrayContaining([{ path: "/shows/", status: 301, location: "/programs/", legacyRedirect: true }]));
  for (const route of queue.recordReceipt.routes.filter((route: any) => route.legacyRedirect)) {
    expect(queue.recordReceipt.routes).toContainEqual(expect.objectContaining({ path: route.location,
      status: identity.visible || route.path === "/shows/" ? 200 : 410 }));
  }
});
it("refuses changed legacy destinations and record-shaped redirect responses", async () => {
  const identity = await accept(); await prepare(identity);
  for (const redirect of [{ location: `${target.origin}/unrelated/` }, { location: "https://example.org/programs/" },
    { location: `${target.origin}/programs` }, { location: `${target.origin}/programs/`, "x-njpbs-content-source": "record" }]) {
    await expect(confirmation.recoverNoBuildRecordPublication({ firestore: db, operationId: identity.operationId,
      target, headers, artifacts, fetchPublic: async (url: string) => new URL(url).pathname === "/shows/"
        ? new Response(null, { status: 301, headers: redirect }) : fetchPublic(url) })).rejects.toThrow("receipt is unavailable");
  }
  expect((await db.doc(`cmsPublishQueue/${identity.operationId}`).get()).data()?.consumerReceipts.record).toBeUndefined();
});
it("continues the minute sweep after a damaged deferred queue while reporting its error", async () => {
  await prepare(await accept()); await recover();
  await db.doc("system/billing").set({ disabled: true });
  const removed = await accept("program", true);
  const badId = "0".repeat(20);
  await db.doc(`cmsPublishQueue/${badId}`).set({ recordRegeneration: "deferred", recordPublication: { originalOperationId: badId } });
  await db.doc("system/billing").set({ disabled: false });
  await expect(confirmation.recoverNoBuildRecordPublication({ firestore: db, target, headers, artifacts, fetchPublic }))
    .rejects.toBeInstanceOf(AggregateError);
  const ref = db.doc(`cmsPublishQueue/${removed.operationId}`);
  expect((await ref.get()).data()?.successorOperationId).toMatch(/^[a-f0-9]{20}$/);
  expect((await ref.get()).data()?.status).toBe("cancelled");
});

it.each(["program", "event"] as const)("recovers %s proof behind a preparation-recovery successor after a failed confirmation", async kind => {
  const identity = await accept(kind); await prepare(identity);
  await db.runTransaction(async transaction => {
    const write = await aggregate.retryPublicContextInTransaction({ firestore: db, transaction,
      operationId: identity.operationId, runtime });
    write();
  });
  const current = (await db.doc(aggregate.CURRENT_PATH).get()).data()!;
  expect(current.operationId).not.toBe(op);
  const successor = (await db.doc(`cmsPublishQueue/${current.operationId}`).get()).data()!;
  expect(successor.preparationRecoveryOfQueueId).toBe(op);
  expect(successor.recordPublication).toBeUndefined();
  await db.doc(`cmsPublishQueue/${current.operationId}/backgroundPreparation/${identity.contextDigest}`).set({
    schemaVersion: 1, status: "verified", runtime, contextDigest: identity.contextDigest,
    preparedDigest: "b".repeat(64), admissionRevision: null,
    reservation: { commitSha: sha, buildBatchId: "fixture-release", generation: 3, cutoffAt: new Date() },
  });
  expect(await aggregate.settlePublicContext({ firestore: db, operationId: current.operationId, runtime })).toBe(true);
  expect((await db.doc(aggregate.CURRENT_PATH).get()).data()?.operationIds).toEqual([current.operationId]);
  expect((await db.doc(`cmsPublishQueue/${op}`).get()).data()?.recordRegeneration).toBeUndefined();
  corruptPath = identity.ownedPaths[0];
  await expect(recover()).rejects.toThrow("receipt is unavailable");
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.publishBuildPending).toBe(true);
  corruptPath = undefined;
  expect(await confirmation.recoverNoBuildRecordPublication({ firestore: db, target, headers, artifacts, fetchPublic }))
    .toEqual({ confirmed: true });
  expect(publication.recordPublicationReceipt((await db.doc(`cmsPublishQueue/${op}`).get()).data()).status).toBe("success");
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ publishBuildPending: false, publishBuildQueueId: null,
    publishBuildSettlement: { recordQueueId: op, sourceVersion: 10, status: "success" } });
});


async function replaceContextPointer(identity: any) {
  await db.doc(`cmsPublishQueue/${identity.operationId}/backgroundPreparation/${identity.contextDigest}`).set({
    schemaVersion: 1, status: "verified", runtime, contextDigest: identity.contextDigest,
    preparedDigest: "b".repeat(64), admissionRevision: null,
    reservation: { commitSha: sha, buildBatchId: "fixture-release", generation: 3, cutoffAt: new Date() },
  });
  const other = "Z".repeat(20);
  await db.runTransaction(async transaction => {
    const work = await aggregate.enqueuePublicContextInTransaction({ firestore: db, transaction,
      operationId: other, runtime, reason: "context", contextRevision: identity.contextRevision });
    work.write();
  });
  expect(await aggregate.settlePublicContext({ firestore: db, operationId: other, runtime })).toBe(true);
  expect((await db.doc(aggregate.CURRENT_PATH).get()).data()?.operationIds).toEqual([other]);
  expect((await db.doc(`cmsPublishQueue/${other}`).get()).data()?.preparationRecoveryOfQueueId).toBeUndefined();
}

it.each(["program", "event"].flatMap(kind => [false, true].map(removed => ({ kind, removed }))))(
  "discovers pending $kind removed=$removed after an unrelated same-context operation replaces the pointer", async ({ kind, removed }) => {
  const published = await accept(kind as "program" | "event");
  const identity = removed ? await accept(kind as "program" | "event", true) : published;
  await prepare(identity);
  if (!removed) corruptPath = identity.ownedPaths[0];
  await expect(recover(identity.operationId)).rejects.toThrow("receipt is unavailable");
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.publishBuildPending).toBe(true);
  corruptPath = undefined; durable = true;
  await replaceContextPointer(identity);
  expect(await confirmation.recoverNoBuildRecordPublication({ firestore: db, target, headers, artifacts, fetchPublic }))
    .toEqual({ confirmed: true });
  const queue = (await db.doc(`cmsPublishQueue/${identity.operationId}`).get()).data()!;
  expect(publication.recordPublicationReceipt(queue).status).toBe("success");
  expect(queue.recordConfirmationPendingAt).toBeUndefined();
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ publishBuildPending: false, publishBuildQueueId: null,
    publishBuildSettlement: { recordQueueId: identity.operationId, sourceVersion: 10, status: "success" } });
});

it.each(["program", "event"] as const)("discovers the accepted %s operation through its record retry without the context pointer", async kind => {
  await accept(kind);
  await db.doc(`cmsPublishQueue/${op}`).update({ status: "failed" });
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 6 });
  const retry = (await import("../../functions/lib/no-build-record-retry.js")).default;
  const result = await retry.existingNoBuildRecordPublication({ firestore: db,
    changes: [{ collection: "cmsPosts", id, sourceVersion: 10 }], retry: true, baseVersion: 10 });
  const successor = (await db.doc(`cmsPublishQueue/${result.queueId}`).get()).data()!;
  expect(result.queueId).not.toBe(op);
  await prepare(successor.recordPublication);
  await replaceContextPointer(successor.recordPublication);
  expect(await confirmation.recoverNoBuildRecordPublication({ firestore: db, target, headers, artifacts, fetchPublic }))
    .toEqual({ confirmed: true });
  expect((await db.doc(`cmsPublishQueue/${op}`).get()).data()?.recordConfirmationPendingAt).toBeUndefined();
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ publishBuildPending: false,
    publishBuildSettlement: { recordQueueId: result.queueId, status: "success" } });
});


it("keeps the pending marker through failed proof and clears it only with final settlement", async () => {
  const identity = await accept();
  const ref = db.doc(`cmsPublishQueue/${op}`), pending = (await ref.get()).data()!.recordConfirmationPendingAt;
  expect(pending.toMillis()).toBeGreaterThan(0);
  await prepare(identity);
  corruptPath = identity.ownedPaths[0];
  await expect(recover()).rejects.toThrow("receipt is unavailable");
  expect((await ref.get()).data()?.recordConfirmationPendingAt).toEqual(pending);
  corruptPath = undefined;
  await recover();
  expect((await db.collection("cmsPublishQueue").orderBy("recordConfirmationPendingAt").get()).empty).toBe(true);
});

it("replaces the old pending marker atomically when a newer record operation is accepted", async () => {
  await accept();
  expect((await db.doc(`cmsPublishQueue/${op}`).get()).data()?.recordConfirmationPendingAt).toBeDefined();
  const removed = await accept("program", true);
  expect((await db.doc(`cmsPublishQueue/${op}`).get()).data()?.recordConfirmationPendingAt).toBeUndefined();
  const pending = await db.collection("cmsPublishQueue").orderBy("recordConfirmationPendingAt").get();
  expect(pending.docs.map(row => row.id)).toEqual([removed.operationId]);
});

it("rotates a bounded page of damaged pending operations so later records can still settle", async () => {
  const identity = await accept(); await prepare(identity);
  const damaged = Array.from({ length: 10 }, (_, index) => String(index).padStart(20, "0"));
  await Promise.all(damaged.map(operationId => db.doc(`cmsPublishQueue/${operationId}`).set({
    recordConfirmationPendingAt: new Date(0), recordPublication: { originalOperationId: operationId } })));
  const sweep = () => confirmation.recoverNoBuildRecordPublication({ firestore: db, target, headers, artifacts, fetchPublic });
  await expect(sweep()).rejects.toBeInstanceOf(AggregateError);
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.publishBuildPending).toBe(true);
  for (const operationId of damaged) expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()!
    .recordConfirmationPendingAt.toMillis()).toBeGreaterThan(0);
  await expect(sweep()).rejects.toBeInstanceOf(AggregateError);
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.publishBuildPending).toBe(false);
  expect((await db.doc(`cmsPublishQueue/${op}`).get()).data()?.recordConfirmationPendingAt).toBeUndefined();
});


it("does no public proof for a pending-marker-only queue event but still proves a consumer change", async () => {
  const identity = await accept(); await prepare(identity);
  const ref = db.doc(`cmsPublishQueue/${op}`), before = await ref.get();
  await ref.update({ recordConfirmationPendingAt: new Date(Date.now() + 1_000) });
  const after = await ref.get();
  let reads = 0;
  const handler = (await import("../../functions/no-build-post-confirmation.js")).default.createNoBuildPostConfirmationHandler({
    firestore: db, readback: () => ({ target, headers }), artifacts,
    fetchPublic: async (url: string) => { reads += 1; return fetchPublic(url); },
  });
  await handler({ params: { queueId: op }, data: { before, after } });
  expect(reads).toBe(0);
  expect((await ref.get()).data()?.consumerReceipts.record).toBeUndefined();
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.publishBuildPending).toBe(true);
  await ref.update({ "consumerReceipts.pages.verifiedAt": Date.now() + 1_000 });
  await handler({ params: { queueId: op }, data: { before: after, after: await ref.get() } });
  expect(reads).toBeGreaterThan(0);
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.publishBuildPending).toBe(false);
});


it.each(["deferred", "active"])("retires a replaced %s removal through the minute sweep", async phase => {
  await accept();
  await db.doc("system/billing").set({ disabled: true });
  const removed = await accept("program", true);
  await db.doc("system/billing").set({ disabled: false });
  let retiredId = removed.operationId;
  if (phase === "active") {
    const retry = (await import("../../functions/lib/no-build-record-retry.js")).default;
    const resumed = await retry.resumeDeferredRecordPublication({ firestore: db, operationId: removed.operationId });
    retiredId = resumed.queueId;
    await prepare((await db.doc(`cmsPublishQueue/${retiredId}`).get()).data()!.recordPublication);
  }
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  const next = { ...stored, version: 12, status: "published", publiclyVisible: true,
    published: snapshots.createPublishedSnapshot({ collection: "cmsPosts", document: { ...stored.published.metadata, version: 12 },
      publishedBy: "editor", publishedAt: "2026-10-23T12:00:00.000Z" }) };
  const replacementId = "C".repeat(20);
  await db.runTransaction(async transaction => {
    const work = await publication.prepareNoBuildRecordPublication({ firestore: db, transaction, collection: "cmsPosts", documentId: id,
      nextDocument: next, queueRef: db.doc(`cmsPublishQueue/${replacementId}`), actor: { uid: "editor" }, config });
    transaction.set(db.doc(`cmsPosts/${id}`), { ...next, publishBuildPending: true, publishBuildQueueId: replacementId }); work.write();
  });
  expect(await confirmation.recoverNoBuildRecordPublication({ firestore: db, target, headers, artifacts, fetchPublic }))
    .toEqual({ confirmed: false });
  expect((await db.doc(`cmsPublishQueue/${retiredId}`).get()).data()).toMatchObject({ recordRegeneration: "superseded",
    status: phase === "active" ? "success" : "cancelled" });
  expect((await db.collection("cmsPublishQueue").where("recordRegeneration", "==", phase).get()).empty).toBe(true);
  expect((await db.doc(`cmsPublishQueue/${replacementId}`).get()).data()?.recordConfirmationPendingAt).toBeDefined();
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ publishBuildPending: true, publishBuildQueueId: replacementId });
});

async function seedSchedulerOwners() {
  const pageId = `page-${"1".repeat(32)}`, pageOperation = "P".repeat(20), postOperation = "Q".repeat(20);
  const page = { schemaVersion: 1, pageId, operationId: pageOperation, sourceVersion: 7,
    path: "/scheduler-page/", ownedPaths: ["/scheduler-page/"], visible: true, rendererSha: sha, generation: 3,
    snapshotDigest: "b".repeat(64), contextRevision: 5, contextDigest: context.publicContextDigest(5), servingEnabled: true, runtime };
  await db.doc(`system/publicDeployment/noBuildPageOwners/${pageId}`).set(page);
  const { servingEnabled, runtime: pageRuntime, ...pageIdentity } = page;
  await db.doc(`cmsPublishQueue/${pageOperation}`).set({ transport: "page-no-build-v1", noBuildPage: pageIdentity,
    backgroundRuntime: pageRuntime, changes: [{ collection: "cmsPages", id: pageId, sourceVersion: 7 }],
    status: "pending", attempts: 0, claim: null, nextAttemptAt: 0 });
  const post = { schemaVersion: 1, postId: "scheduler-post", operationId: postOperation, sourceVersion: 8,
    slug: "scheduler-post", ownedSlugs: ["scheduler-post"], visible: true, rendererSha: sha, generation: 3,
    snapshotDigest: "c".repeat(64), servingEnabled: true, runtime };
  await db.doc("system/publicDeployment/noBuildPostOwners/scheduler-post").set(post);
  await db.doc(`cmsPublishQueue/${postOperation}`).set({ transport: "post-no-build-v1", noBuildPost: post,
    status: "pending", attempts: 0, claim: null, nextAttemptAt: 0 });
  await db.doc("cmsDatasetRefreshJobs/scheduler-dataset").set({ status: "pending", captures: [], cursor: 0,
    captureDigest: createHash("sha256").update("[]").digest("hex"), lastProcessedAt: 0, expectedOwnerCount: 0,
    expectedUseCount: 0, action: "publish", datasetId: "fixture-dataset", releaseId: "fixture-release", revision: 1,
    approvedDigest: "d".repeat(64) });
  return { pageOperation, postOperation };
}

it.each(["page", "post", "record"])("recovers other owners while %s recovery reaches the scheduler deadline", async slow => {
  await prepare(await accept());
  const { pageOperation, postOperation } = await seedSchedulerOwners();
  const scheduler = (await import("../../functions/no-build-post-confirmation.js")).default;
  const start = Date.now(); let clock = start, slowStarted = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waitAtBoundary = async () => { slowStarted = true; await gate; throw new Error("Slow public response"); };
  const running = scheduler.recoverNoBuildPublications({ firestore: db, now: () => clock,
    config: () => ({ zoneId: "f".repeat(32), token: "fixture-purge-token" }), readback: () => ({ target, headers }), artifacts,
    fetchPurge: async () => slow === "post" ? waitAtBoundary() : Response.json({ success: true }),
    fetchPublic: async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/scheduler-page/") {
        if (slow === "page") return waitAtBoundary();
        throw new Error("Page origin unavailable");
      }
      if (path.includes("scheduler-post")) throw new Error("Post origin unavailable");
      if (slow === "record") return waitAtBoundary();
      return fetchPublic(url);
    } }).then(() => null, (error: Error) => error);
  let error: Error | null;
  try {
    await expect.poll(() => slowStarted, { timeout: 2_000 }).toBe(true);
    if (slow !== "record") {
      await expect.poll(async () => (await db.doc(`cmsPosts/${id}`).get()).data()?.publishBuildPending,
        { timeout: 2_000 }).toBe(false);
    } else {
      for (const operationId of [pageOperation, postOperation]) {
        await expect.poll(async () => (await db.doc(`cmsPublishQueue/${operationId}`).get()).data(), { timeout: 2_000 })
          .toMatchObject({ attempts: 1, claim: null, status: "pending" });
      }
    }
    await expect.poll(async () => (await db.doc("cmsDatasetRefreshJobs/scheduler-dataset").get()).data()?.status,
      { timeout: 2_000 }).toBe("success");
  } finally {
    clock = start + 45_000;
    release();
    error = await running;
  }
  if (slow === "record") expect(error?.message).toBe("Public confirmation recovery is unavailable");
  else expect(error).toBeNull();
});

it.each(["program", "event"].flatMap(kind => ["success", "cancelled"].map(status => ({ kind, status }))))(
  "repairs a stale $kind marker after $status at an older public context through the minute sweep", async ({ kind, status }) => {
  const identity = await accept(kind as "program" | "event");
  if (status === "success") await prepare(identity);
  const original = db.doc(`cmsPublishQueue/${op}`), currentId = "Z".repeat(20);
  await db.runTransaction(async transaction => {
    const work = await aggregate.enqueuePublicContextInTransaction({ firestore: db, transaction,
      operationId: currentId, runtime, reason: "context", contextRevision: 6 });
    work.write(); transaction.update(db.doc(context.PUBLIC_CONTEXT_PATH), { revision: 6 });
  });
  const currentIdentity = { ...identity, operationId: currentId, contextRevision: 6, contextDigest: context.publicContextDigest(6) };
  await prepare(currentIdentity);
  await db.doc(`cmsPublishQueue/${currentId}/backgroundPreparation/${currentIdentity.contextDigest}`).set({
    schemaVersion: 1, status: "verified", runtime, contextDigest: currentIdentity.contextDigest,
    preparedDigest: "b".repeat(64), admissionRevision: null,
    reservation: { commitSha: sha, buildBatchId: "fixture-release", generation: 3, cutoffAt: new Date() },
  });
  await db.doc(`cmsPosts/${id}`).update({ version: 11, title: "Later private draft" });
  expect((await original.get()).data()?.status).toBe(status);
  const sweep = () => confirmation.recoverNoBuildRecordPublication({ firestore: db, target, headers, artifacts, fetchPublic });
  await sweep();
  const successorId = (await original.get()).data()?.successorOperationId;
  expect(successorId).toMatch(/^[a-f0-9]{20}$/);
  const successor = (await db.doc(`cmsPublishQueue/${successorId}`).get()).data()!;
  expect(successor.recordPublication).toMatchObject({ originalOperationId: op, sourceVersion: 10,
    snapshotDigest: identity.snapshotDigest, generation: identity.generation, contextRevision: 6 });
  expect((await original.get()).data()?.recordConfirmationPendingAt).toBeDefined();
  // The current context already published this snapshot. The successor reuses
  // its immutable output and completes through the normal queue boundary.
  await prepare(successor.recordPublication);
  expect(await sweep()).toEqual({ confirmed: true });
  expect((await original.get()).data()?.status).toBe(status);
  expect((await original.get()).data()?.recordConfirmationPendingAt).toBeUndefined();
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ version: 11, title: "Later private draft",
    published: { sourceVersion: 10 }, publishBuildPending: false, publishBuildQueueId: null, publicSourceVersion: 10,
    publishBuildSettlement: { status: "success", sourceVersion: 10, recordQueueId: successorId } });
});

it.each(["failed", "cancelled"])("does not automatically reopen a %s job for another failure reason", async status => {
  await accept();
  await db.doc(`cmsPublishQueue/${op}`).update({ status, error: "background_preparation_failed", attempts: 4 });
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 6 });
  expect(await confirmation.recoverNoBuildRecordPublication({ firestore: db, target, headers, artifacts,
    fetchPublic: async () => { throw new Error("A terminal failed queue must not start public proof"); } }))
    .toEqual({ confirmed: false });
  expect((await db.doc(`cmsPublishQueue/${op}`).get()).data()).toMatchObject({ status, attempts: 4 });
  expect((await db.doc(`cmsPublishQueue/${op}`).get()).data()?.successorOperationId).toBeUndefined();
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.publishBuildPending).toBe(true);
});

it.each(["success", "cancelled"])("waits for the newer context build before repairing a %s record operation", async status => {
  const identity = await accept();
  if (status === "success") await prepare(identity);
  const currentId = "Z".repeat(20);
  await db.runTransaction(async transaction => {
    const work = await aggregate.enqueuePublicContextInTransaction({ firestore: db, transaction,
      operationId: currentId, runtime, reason: "context", contextRevision: 6 });
    work.write(); transaction.update(db.doc(context.PUBLIC_CONTEXT_PATH), { revision: 6 });
  });
  const preparation = db.doc(`cmsPublishQueue/${currentId}/backgroundPreparation/${context.publicContextDigest(6)}`);
  const building = { schemaVersion: 1, status: "building", attempts: 1, runtime, contextDigest: context.publicContextDigest(6) };
  await preparation.set(building);
  const contextBefore = (await db.doc(aggregate.CURRENT_PATH).get()).data();
  const outputsBefore = (await db.collection("cmsBackgroundOutputs").get()).docs.map(row => row.data());
  expect((await db.doc(`cmsPublishQueue/${op}`).get()).data()?.status).toBe(status);
  expect(await confirmation.recoverNoBuildRecordPublication({ firestore: db, target, headers, artifacts, fetchPublic }))
    .toEqual({ confirmed: false });
  expect((await db.doc(`cmsPublishQueue/${op}`).get()).data()?.successorOperationId).toBeUndefined();
  expect((await db.doc(aggregate.CURRENT_PATH).get()).data()).toEqual(contextBefore);
  expect((await db.collection("cmsBackgroundOutputs").get()).docs.map(row => row.data())).toEqual(outputsBefore);
  expect((await preparation.get()).data()).toEqual(building);
});

it("logs bounded nested confirmation causes without messages, URLs or unknown error fields", async () => {
  await prepare(await accept());
  const scheduler = (await import("../../functions/no-build-post-confirmation.js")).default;
  const entries: any[] = [], privateValue = "fixture-private-error-value";
  const error = new AggregateError([
    Object.assign(new TypeError(`${privateValue} https://example.test/?credential=${privateValue}\n` +
      `    at private (/workspace/lib/${privateValue}.js:1:1)`), { code: "ECONNRESET" }),
    Object.assign(new Error(privateValue), { name: privateValue, code: privateValue }),
  ], privateValue);
  await expect(scheduler.recoverNoBuildPublications({ firestore: db, readback: () => ({ target, headers }), artifacts,
    log: { error(message: string, fields: any) { entries.push({ message, ...fields }); } },
    fetchPublic: async () => { throw error; } })).rejects.toThrow("Public confirmation recovery is unavailable");
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ message: "Public confirmation recovery failed", failures: [
    { owner: "records", causes: [{ name: "TypeError", code: "ECONNRESET" }, { name: "Error" }] },
  ] });
  expect(JSON.stringify(entries)).not.toContain(privateValue);
  expect(JSON.stringify(entries)).not.toContain("https:");
});

it.each(["missing owner", "source version", "operation", "context"])(
  "refuses an unconfirmed joined card with a changed %s", async changed => {
  await prepare(await accept());
  await db.doc(`cmsPosts/${id}`).update({ publicSourceVersion: null });
  const pageContext = (await import("../../functions/lib/no-build-page-render-context.js")).default;
  const read = () => db.runTransaction(async transaction => pageContext.readPageRenderDependenciesInTransaction({
    firestore: db, transaction, pageId: "contact", recordIds: [id], rendererSha: sha, target, now: new Date(),
    pointer: (await transaction.get(db.doc("system/publicDeployment"))).data(),
  }), { readOnly: true });
  expect((await read()).joinedRecords[0].published.sourceVersion).toBe(10);
  const owner = db.doc(`system/publicDeployment/noBuildRecordOwners/${id}`);
  if (changed === "missing owner") await owner.delete();
  if (changed === "source version") await owner.update({ sourceVersion: 9 });
  if (changed === "operation") await owner.update({ operationId: "W".repeat(20) });
  if (changed === "context") await owner.update({ contextRevision: 6, contextDigest: context.publicContextDigest(6) });
  await expect(read()).rejects.toThrow();
});

it("repairs after the cloud owner catches up with a bare public-context revision bump", async () => {
  const identity = await accept(); await prepare(identity);
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 6 });
  const cloudWork = (await import("../../functions/lib/no-build-cloud-work.js")).default;
  // The existing cloud owner watches this revision and has a minute fallback.
  // It creates the missing aggregate before preparing its output.
  expect(await cloudWork.readNoBuildCloudWork({ runtime,
    read: async (path: string) => (await db.doc(path).get()).data() ?? null, listOwners: async () => [],
  })).toMatchObject({ maintenance: true });
  const sweep = () => confirmation.recoverNoBuildRecordPublication({ firestore: db, target, headers, artifacts, fetchPublic });
  expect(await sweep()).toEqual({ confirmed: false });
  expect((await db.doc(`cmsPublishQueue/${op}`).get()).data()?.successorOperationId).toBeUndefined();
  // Complete the same current-context enqueue used by cloud maintenance;
  // no unrelated staff publication or record edit is needed.
  const currentId = "Z".repeat(20), currentIdentity = { ...identity, operationId: currentId,
    contextRevision: 6, contextDigest: context.publicContextDigest(6) };
  await db.runTransaction(async transaction => {
    const work = await aggregate.enqueuePublicContextInTransaction({ firestore: db, transaction,
      operationId: currentId, runtime, reason: "context", contextRevision: 6 });
    work.write();
  });
  await prepare(currentIdentity);
  await db.doc(`cmsPublishQueue/${currentId}/backgroundPreparation/${currentIdentity.contextDigest}`).set({
    schemaVersion: 1, status: "verified", runtime, contextDigest: currentIdentity.contextDigest,
    preparedDigest: "b".repeat(64), admissionRevision: null,
    reservation: { commitSha: sha, buildBatchId: "fixture-release", generation: 3, cutoffAt: new Date() },
  });
  await sweep();
  const successorId = (await db.doc(`cmsPublishQueue/${op}`).get()).data()?.successorOperationId;
  expect(successorId).toMatch(/^[a-f0-9]{20}$/);
  await prepare((await db.doc(`cmsPublishQueue/${successorId}`).get()).data()!.recordPublication);
  expect(await sweep()).toEqual({ confirmed: true });
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ published: { sourceVersion: 10 }, publishBuildPending: false });
});
