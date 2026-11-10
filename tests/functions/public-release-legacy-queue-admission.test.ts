import { beforeEach, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { releaseSelector } from "../helpers/private-public-release-pair.js";
import bootstrap from "../../functions/lib/public-release-bootstrap-admission.js";
import recovery from "../../functions/lib/publication-recovery.js";
import publish from "../../functions/publish.js";
import deployment from "../../functions/lib/public-deployment.js";
import context from "../../functions/lib/public-context-publication.js";
import scheduler from "../../functions/scheduled-publish.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import baseline from "../../functions/lib/cms-publication-baseline.js";
const db = isolatedFirestore("public-release-legacy-queue-admission.test.ts");
const actor = { uid: "retry-editor", email: null, principal: { id: "retry-editor", grants: [{ role: "admin" }] } };
const change = { collection: "cmsPosts", id: "post-one", sourceVersion: 4 };
const failedQueue = "failed-original", fence = { schemaVersion: 2, operationId: "initial-install", attemptDigest: "a".repeat(64),
  status: "closed", resumeReceiptDigest: null };
const original = { type: "post", status: "draft", version: 7, publiclyVisible: true, createdBy: actor.uid,
  published: { sourceVersion: 4, title: "Retained public snapshot" }, title: "Private working title",
  publishBuildPending: true, publishBuildQueueId: failedQueue };
const state = async (path: string) => (await db.doc(path).get()).data();
const retry = () => recovery.reservePublicationRetry({ firestore: db, actor, changes: [change], baseVersion: 7,
  source: null, transport: "serializer" });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    lastReservedGeneration: 1, newestEligibleGeneration: 1, activeCommitSha: "a".repeat(40),
    activeDeploymentId: "current", newestEligibleBuildBatchId: "current", mediaLifecycleReady: true });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: "a".repeat(40), serializerId: "node-compute" });
  await db.doc("cmsPosts/post-one").set(original);
  await db.doc(`cmsPublishQueue/${failedQueue}`).set({ status: "failed", transport: "serializer", changes: [change], error: "retained-original-failure" });
});
it.each(["absent", "open"])("preserves legacy retry acceptance when the bootstrap fence is %s", async mode => {
  if (mode === "open") await db.doc(bootstrap.BOOTSTRAP_ADMISSION_FENCE_PATH).set({ ...fence, status: "open", resumeReceiptDigest: "b".repeat(64) });
  const accepted = await retry();
  expect(accepted).toMatchObject({ reserved: true, existing: false, transport: "serializer" });
  expect(await state(`cmsPublishQueue/${accepted.queueId}`)).toMatchObject({ status: "reserved", changes: [change] });
});
it.each(["absent", "open", "closed"])("serializes fresh baseline reservation with a %s bootstrap fence", async mode => {
  await db.doc("cmsPosts/post-one").delete();
  if (mode !== "absent") await db.doc(bootstrap.BOOTSTRAP_ADMISSION_FENCE_PATH).set(mode === "closed"
    ? fence : { ...fence, status: "open", resumeReceiptDigest: "b".repeat(64) });
  const input = { firestore: db, queueId: "B".repeat(20), commitSha: "c".repeat(40) };
  if (mode === "closed") {
    await expect(baseline.reserveBaselineQueue(input)).rejects.toMatchObject({ code: "public_release_bootstrap_admission_paused" });
    // A static-return request reaches the same guard before creating a queue
    // or preparing its later cutover intent.
    await expect(baseline.reserveBaselineQueue({ ...input, returnPostId: "post-one" })).rejects.toMatchObject({ code: "public_release_bootstrap_admission_paused" });
    expect((await db.doc(`cmsPublishQueue/${input.queueId}`).get()).exists).toBe(false);
    expect((await db.collection("cmsPublishQueue").where("status", "==", "reserved").get()).empty).toBe(true);
  } else {
    await expect(baseline.reserveBaselineQueue(input)).resolves.toEqual({ existing: null });
    expect(await state(`cmsPublishQueue/${input.queueId}`)).toMatchObject({ status: "reserved", transport: "serializer", changes: [] });
  }
  expect((await state(`cmsPublishQueue/${failedQueue}`))?.error).toBe("retained-original-failure");
});
it.each(["closed", "pair"])("refuses a retry with a named error under %s authority without altering failed history", async mode => {
  if (mode === "closed") await db.doc(bootstrap.BOOTSTRAP_ADMISSION_FENCE_PATH).set(fence);
  else await db.doc("system/publicDeployment").set(releaseSelector());
  const before = await state(`cmsPublishQueue/${failedQueue}`);
  await expect(retry()).rejects.toMatchObject({ status: 409, code: mode === "closed"
    ? "public_release_bootstrap_admission_paused" : "public_release_legacy_queue_unavailable" });
  expect(await state(`cmsPublishQueue/${failedQueue}`)).toEqual(before);
  expect(await state("cmsPosts/post-one")).toEqual(original);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  expect((await db.collection("admin_logs").get()).empty).toBe(true);
});
it("refuses the actual staff retry endpoint after the stored operator fence closes", async () => {
  // The close writer lives in its separate operator layer. This is its actual
  // stored SDK boundary, rather than a request hint or a mocked admission check.
  await db.doc(bootstrap.BOOTSTRAP_ADMISSION_FENCE_PATH).set(fence);
  const handler = publish.createCmsPublishHandler({ firestore: db, requirePrincipalFn: async () => actor,
    assertPublishReadyFn: async () => ({ transport: "serializer" }), assertPublishedMediaSafeFn: async () => {},
    fetchImpl: async () => { throw new Error("A closed retry must never dispatch"); }, log: { info() {}, warn() {}, error() {} } });
  const body = { retry: true, baseVersion: 7, changes: [change] };
  const res: any = { statusCode: 200, headersSent: false, set() { return this; }, status(value: number) { this.statusCode = value; return this; },
    json(value: unknown) { this.body = value; this.headersSent = true; return this; } };
  await handler({ method: "POST", headers: {}, body, ip: "127.0.0.1" }, res);
  expect(res.statusCode, JSON.stringify(res.body)).toBe(409);
  expect(res.body.error).toBe("Publishing paused for an update. Please try again shortly.");
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  expect(await state("cmsPosts/post-one")).toEqual(original);
  expect((await state(`cmsPublishQueue/${failedQueue}`))?.error).toBe("retained-original-failure");
});
it.each(["github", "serializer"])("refuses a fresh %s enqueue before any queue, audit or dispatch write", async transport => {
  await db.doc(bootstrap.BOOTSTRAP_ADMISSION_FENCE_PATH).set(fence);
  await expect(publish.enqueuePublishBuild({ actor, changes: [change], readiness: { transport } }, {
    firestore: db, assertPublishedMediaSafeFn: async () => {}, dispatchUrl: "https://example.test/dispatch",
    fetchImpl: async () => { throw new Error("A closed enqueue must not dispatch"); }, log: { info() {}, warn() {}, error() {} },
  })).rejects.toMatchObject({ status: 409, code: "public_release_bootstrap_admission_paused" });
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  expect((await db.collection("admin_logs").get()).empty).toBe(true);
  expect(await state("cmsPosts/post-one")).toEqual(original);
});
it.each(["enqueue", "retry"])("refuses shared public-context %s before reviving or creating a queue", async action => {
  await db.doc(bootstrap.BOOTSTRAP_ADMISSION_FENCE_PATH).set(fence);
  const runtime = { owner: "cloudflare", release: "a".repeat(40) };
  await expect(db.runTransaction(transaction => action === "retry"
    ? context.retryPublicContextInTransaction({ firestore: db, transaction, operationId: "A".repeat(20), runtime })
    : context.enqueuePublicContextInTransaction({ firestore: db, transaction, operationId: "A".repeat(20), runtime,
      reason: "settings", contextRevision: 1 }))).rejects.toMatchObject({ status: 409, code: "public_release_bootstrap_admission_paused" });
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  expect((await db.doc(context.CURRENT_PATH).get()).exists).toBe(false);
});
it.each(["absent", "closed"])("places scheduled legacy source acceptance before queue promotion with a %s fence", async mode => {
  const document = { id: "scheduled-legacy", type: "post", title: "Scheduled legacy story", section: "news",
    slug: "scheduled-legacy-story", previousSlugs: [], date: "2026-10-27", locale: "en", version: 1,
    createdBy: actor.uid, tags: [], categories: [], credits: [], blocks: [] };
  const instant = "2026-10-28T12:00:00.000Z";
  const before = { ...document, status: "scheduled", publishAt: instant, publiclyVisible: false,
    publishBuildPending: false, publishBuildQueueId: null };
  await db.doc("cmsPosts/post-one").delete(); await db.doc(`cmsPosts/${document.id}`).set(before);
  await db.doc("sections/news").set({ label: "News" });
  if (mode === "closed") await db.doc(bootstrap.BOOTSTRAP_ADMISSION_FENCE_PATH).set(fence);
  const run = scheduler.createScheduledPublishRunner({ firestore: db, now: () => instant, log: { info() {}, warn() {}, error() {} },
    reconcileStaleFn: async () => {}, assertPublishReadyFn: async () => ({ transport: "serializer" }),
    assertPublishedMediaSafeFn: async () => {}, enqueuePublishFn: (fields: any) => publish.enqueuePublishBuild(fields,
      { firestore: db, assertPublishedMediaSafeFn: async () => {} }) });
  const result = await run();
  if (mode === "closed") {
    expect(result.publishedCount).toBe(0);
    expect(await state(`cmsPosts/${document.id}`)).toEqual(before);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
    expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
  } else {
    expect(result.publishedCount).toBe(1);
    expect(await state(`cmsPosts/${document.id}`)).toMatchObject({ status: "published", publishBuildPending: true });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
  }
});
it.each(["absent", "open", "closed"])("retries an original frozen scheduled snapshot on the same tick with a %s fence", async mode => {
  const instant = "2026-10-28T12:00:00.000Z";
  const document = { type: "post", title: "Frozen scheduled story", section: "news", slug: "frozen-scheduled-story",
    previousSlugs: [], date: "2026-10-27", locale: "en", version: 4, tags: [], categories: [], credits: [], blocks: [] };
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document, sourceVersion: 4,
    publishedAt: instant, publishedBy: actor.uid });
  const before = { ...document, version: 7, title: "Private working title", status: "published", published,
    publiclyVisible: true, publishBuildPending: true, publishBuildQueueId: null };
  await db.doc("cmsPosts/post-one").set(before);
  await db.doc("sections/news").set({ label: "News" });
  if (mode !== "absent") await db.doc(bootstrap.BOOTSTRAP_ADMISSION_FENCE_PATH).set(mode === "closed"
    ? fence : { ...fence, status: "open", resumeReceiptDigest: "b".repeat(64) });
  const run = scheduler.createScheduledPublishRunner({ firestore: db, now: () => instant,
    log: { info() {}, warn() {}, error() {} }, reconcileStaleFn: async () => {},
    assertPublishReadyFn: async () => ({ transport: "serializer" }), assertPublishedMediaSafeFn: async () => {},
    enqueuePublishFn: (fields: any) => publish.enqueuePublishBuild(fields,
      { firestore: db, assertPublishedMediaSafeFn: async () => {} }) });
  const result = await run();
  expect(result.publishedCount).toBe(0); // This retry never creates another publication snapshot.
  if (mode === "closed") {
    await run(); // Each following tick defers without creating another failed queue.
    expect(await state("cmsPosts/post-one")).toEqual(before);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  } else {
    const after = await state("cmsPosts/post-one");
    expect(after).toMatchObject({ version: 7, title: "Private working title", published, publishBuildPending: true });
    expect(after?.publishBuildQueueId).toEqual(expect.any(String));
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
    expect(await state(`cmsPublishQueue/${after?.publishBuildQueueId}`)).toMatchObject({ status: "pending", changes: [change] });
  }
  expect((await state(`cmsPublishQueue/${failedQueue}`))?.error).toBe("retained-original-failure");
  expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
});
