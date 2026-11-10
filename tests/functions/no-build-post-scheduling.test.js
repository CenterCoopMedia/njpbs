import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../../functions/lib/firebase.js";
import save from "../../functions/save.js";
import scheduler from "../../functions/scheduled-publish.js";
import deployment from "../../functions/lib/public-deployment.js";
import ownership from "../../functions/lib/no-build-post-ownership.js";
import admission from "../../functions/lib/no-build-post-admission.js";
import publication from "../../functions/lib/no-build-post-publication.js";
import lifecycle from "../../functions/lifecycle-transition.js";
import buildState from "../../functions/lib/publish-build-state.js";
import documentSize from "../../functions/lib/document-size.js";
const db = isolatedFirestore("no-build-post-scheduling.test.js");

const sha = "a".repeat(40);
const actor = { uid: "schedule-editor", email: "editor@example.test", principal: { id: "schedule-editor", grants: [{ role: "admin" }] } };
const failures = [];
const quiet = { info() {}, warn() {}, error(message, details) { failures.push({ message, ...details }); } };
const due = "2026-10-12T12:00:00.000Z";
const post = id => ({ id, type: "post", title: `Scheduled ${id}`, status: "draft", section: "news", slug: `${id}-story`, date: "2026-10-11", locale: "en",
  previousSlugs: [], version: 1, createdBy: actor.uid, tags: [], categories: [], credits: [], blocks: [] });
const pointer = () => ({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
  activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: sha,
  lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
const offlineBuild = async () => { throw new Error("The full-build transport is offline"); };
function run(deps = {}) {
  return scheduler.createScheduledPublishRunner({ firestore: db, now: () => due, log: quiet,
    assertPublishReadyFn: offlineBuild, assertPublishedMediaSafeFn: offlineBuild,
    enqueuePublishFn: offlineBuild, reconcileStaleFn: async () => {}, ...deps })();
}
async function schedule(id, { baseVersion = 1, scheduleAt = due, nowAt = "2026-10-11T12:00:00.000Z" } = {}, deps = {}) {
  const handler = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor,
    now: () => nowAt, enablePublishSnapshot: true, log: quiet,
    assertPublishReadyFn: offlineBuild, ...deps });
  const response = { code: 200, headersSent: false, status(code) { this.code = code; return this; },
    set() { return this; }, json(body) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", body: { collection: "cmsPosts", id, baseVersion, scheduleAt, document: {} }, headers: {}, ip: "127.0.0.1" }, response);
  return response;
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use a local demo Firestore emulator");
});
beforeEach(async () => {
  failures.length = 0;
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc(admission.ADMISSION_PATH).set({ schemaVersion: 2, revision: 1, enabled: true,
    families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
  await db.doc(ownership.CAPABILITY_PATH).set({ schemaVersion: 2, rendererSha: sha, servingEnabled: true, generation: 1 });
  await db.doc("system/publicDeployment").set(pointer());
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha,
    serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
  await db.doc("sections/news").set({ label: "News" });
  await db.doc("cmsPosts/first").set(post("first"));
});

describe("build-free scheduled Post acceptance", () => {
  const legacyDependencies = () => ({ assertPublishReadyFn: vi.fn(async () => ({ transport: "github" })),
    assertPublishedMediaSafeFn: vi.fn(async () => {}), enqueuePublishFn: vi.fn(async input => ({ queueId: input.queueId })) });
  // A copied legacy Home card is the remaining reason a Post has no build-free
  // path. Every editor Post block type is accepted (#3409).
  const legacyHomeCard = () => db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: {}, blocks: [
    { id: "legacy", visible: true, type: "prose", data: { html: '<a href="/posts/first-story">Copied story</a>' } }] } });
  function reconcilingReadiness(id) {
    let activeTransactions = 0;
    const firestore = new Proxy(db, { get(target, key) {
      if (key === "runTransaction") return callback => target.runTransaction(async transaction => {
        activeTransactions += 1;
        try { return await callback(transaction); }
        finally { activeTransactions -= 1; }
      });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return { firestore, assertPublishReadyFn: vi.fn(async () => {
      expect(activeTransactions, "Readiness reconciliation needs an unlocked content row").toBe(0);
      await db.doc(`cmsPosts/${id}`).update({ title: `Scheduled ${id}` });
      return { transport: "github" };
    }) };
  }

  it("defers malformed serializer controls without unscheduling a fallback or starving cloud work", async () => {
    await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 2, enabled: false });
    const before = { ...post("first"), status: "scheduled", publishAt: due };
    await legacyHomeCard();
    await db.doc("cmsPosts/first").set(before);
    await db.doc("cmsPosts/second").set({ ...post("second"), status: "scheduled", publishAt: due });
    expect((await run()).publishedCount).toBe(1);
    expect((await db.doc("cmsPosts/first").get()).data()).toEqual(before);
    expect((await db.collection("cmsVersionHistory").where("documentId", "==", "first").get()).size).toBe(0);
    expect((await db.doc("cmsPosts/second").get()).data().status).toBe("published");
  });
  it("keeps disabled pending serializer rows out of the cloud scheduler cap", async () => {
    await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
    const batch = db.batch();
    for (let index = 0; index < scheduler.MAX_SCHEDULED_CANDIDATE_READS_PER_RUN; index += 1) {
      const id = `legacy-${index}`;
      batch.set(db.doc(`cmsPosts/${id}`), { ...post(id), status: "published", publishBuildPending: true,
        publishBuildQueueId: null, published: { sourceVersion: 1, publishedAt: due, publishedBy: actor.uid,
          metadata: { type: "post", title: "Retained legacy Post", slug: `${id}-story`, credits: [] }, blocks: [] } });
    }
    await batch.commit();
    await db.doc("cmsPosts/first").update({ status: "scheduled", publishAt: due });
    expect((await run()).publishedCount).toBe(1);
    expect((await db.doc("cmsPosts/legacy-0").get()).data()).toMatchObject({ publishBuildPending: true, publishBuildQueueId: null, version: 1 });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("refuses due serializer fallback without starving a later cloud Post", async () => {
    await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
    await legacyHomeCard();
    await db.doc("cmsPosts/first").update({ status: "scheduled", publishAt: due });
    await db.doc("cmsPosts/second").set({ ...post("second"), status: "scheduled", publishAt: due });
    const outcome = await run();
    expect(outcome.publishedCount).toBe(1);
    expect((await db.doc("cmsPosts/first").get()).data()).toMatchObject({ status: "draft",
      scheduledPublishFailure: { reason: "This Post is copied into a legacy Home card. Change that Home card to a Home source selection, then publish this Post again." } });
    expect((await db.doc("cmsPosts/second").get()).data()).toMatchObject({ status: "published" });
    expect((await db.collection("cmsPublishQueue").get()).docs.map(row => row.data().transport)).toEqual(["post-no-build-v1"]);
  });
  it("moves an unadmitted due Post with a malformed block to draft without stopping the run", async () => {
    // Only "second" is admitted, so "first" takes the legacy branch, where the
    // refusal text is built before block validation and must not throw.
    await db.doc(admission.ADMISSION_PATH).set({ schemaVersion: 2, revision: 1, enabled: true,
      families: { posts: { mode: "ids", ids: ["second"] } }, backgroundBucket: "fixture-bucket" });
    await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
    await db.doc("cmsPosts/first").update({ status: "scheduled", publishAt: due, blocks: [null] });
    await db.doc("cmsPosts/second").set({ ...post("second"), status: "scheduled", publishAt: due });
    const outcome = await run();
    expect(outcome.publishedCount).toBe(1);
    const first = (await db.doc("cmsPosts/first").get()).data();
    expect(first.status).toBe("draft");
    expect(first.scheduledPublishFailure.reason).toContain("The full-site build was retired on October 13, 2026.");
    expect((await db.doc("cmsPosts/second").get()).data()).toMatchObject({ status: "published" });
  });
  it("runs fallback schedule readiness with the content transaction released", async () => {
    await legacyHomeCard();
    const readiness = reconcilingReadiness("first");
    const response = await schedule("first", {}, readiness);
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(readiness.assertPublishReadyFn).toHaveBeenCalledOnce();
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it("runs fallback fire readiness with the content transaction released", async () => {
    await legacyHomeCard();
    await db.doc("cmsPosts/first").update({ status: "scheduled", publishAt: due });
    const readiness = reconcilingReadiness("first");
    expect((await run({ ...legacyDependencies(), ...readiness })).publishedCount).toBe(1);
    expect(readiness.assertPublishReadyFn).toHaveBeenCalledOnce();
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });

  it("fires a due Post behind a full scan of failed fast confirmations", async () => {
    expect((await schedule("first")).code).toBe(200);
    const accepted = await run();
    const queueId = accepted.publications[0].queueId;
    await buildState.settleBuildQueue(db, { queueId, status: "failed", queueUpdate: { status: "failed", error: "Fixture confirmation failure" } });
    const failed = (await db.doc("cmsPosts/first").get()).data();
    const owner = (await ownership.readNoBuildPostOwner({ firestore: db, postId: "first" })).state;
    const batch = db.batch();
    for (let index = 0; index < 200; index += 1) {
      const id = `failed-${String(index).padStart(3, "0")}`;
      const slug = `${id}-story`;
      batch.set(db.doc(`cmsPosts/${id}`), { ...failed, id, slug,
        published: { ...failed.published, metadata: { ...failed.published.metadata, slug } } });
      batch.set(db.doc(`${ownership.OWNER_COLLECTION}/${id}`), { ...owner, postId: id, slug, ownedSlugs: [slug] });
    }
    await batch.commit();
    await db.doc("cmsPosts/later").set({ ...post("later"), status: "scheduled", publishAt: due,
      scheduledPublicationTransport: "post-no-build-v1" });
    expect((await run()).publishedCount, JSON.stringify(failures)).toBe(1);
    expect((await db.doc("cmsPosts/later").get()).data().status).toBe("published");
    expect((await db.doc("cmsPosts/failed-000").get()).data()).toMatchObject({ status: "published",
      publishBuildPending: true, publishBuildQueueId: null });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
  });

  it("preserves bounded history when rescheduling clears a large legacy failure", async () => {
    const before = { ...post("first"), blocks: [
      { id: "divider", type: "divider", order: 0, visible: true, data: {} },
    ], scheduledPublishFailure: { failedAt: "2026-10-10T12:00:00.000Z", failedBy: "system:scheduler", reason: "x".repeat(1010000) } };
    const bytes = documentSize.firestoreDocumentBytes(before, "cmsPosts/first");
    expect(bytes).toBeGreaterThan(documentSize.DOCUMENT_SIZE_BUDGET_BYTES);
    expect(bytes).toBeLessThan(documentSize.MAX_DOCUMENT_BYTES);
    await db.doc("cmsPosts/first").set(before);
    await legacyHomeCard();
    const response = await schedule("first", {}, legacyDependencies());
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    const history = (await db.collection("cmsVersionHistory").get()).docs[0].data();
    expect(history).toMatchObject({ beforeTruncated: true, beforeEstimatedBytes: bytes,
      before: { id: "first", status: "draft", version: 1 }, after: { status: "scheduled" } });
    expect(history.before.blocks).toBeUndefined();
    expect(history.after.scheduledPublicationTransport).toBeUndefined();
    expect(documentSize.firestoreDocumentBytes(history, "cmsVersionHistory/fixture")).toBeLessThan(documentSize.DOCUMENT_SIZE_BUDGET_BYTES);
    const audit = (await db.collection("admin_logs").get()).docs[0].data();
    expect(audit.before).toMatchObject({ beforeTruncated: true, beforeEstimatedBytes: bytes });
  });

  it.each(["unsupported", "paused"])("keeps the existing schedule transport before first fast acceptance when %s", async kind => {
    if (kind === "unsupported") await legacyHomeCard();
    else await db.doc(admission.ADMISSION_PATH).update({ enabled: false, revision: 2 });
    const legacy = legacyDependencies();
    const response = await schedule("first", {}, legacy);
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    const document = (await db.doc("cmsPosts/first").get()).data();
    expect(document.status).toBe("scheduled");
    expect(document.scheduledPublicationTransport).toBeUndefined();
    expect(legacy.assertPublishReadyFn).toHaveBeenCalledOnce();
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
    expect((await db.collection("cmsVersionHistory").get()).docs[0].data().after.scheduledPublicationTransport).toBeUndefined();
    const result = await run(legacy);
    expect(result.publishedCount, JSON.stringify(failures)).toBe(1);
    expect(result.publications).toBeUndefined();
    const queues = await db.collection("cmsPublishQueue").get();
    expect(queues.size).toBe(1);
    expect(queues.docs[0].data().transport).not.toBe("post-no-build-v1");
    expect(legacy.assertPublishedMediaSafeFn).toHaveBeenCalledOnce();
    expect(legacy.enqueuePublishFn).toHaveBeenCalledWith(expect.objectContaining({ queueReserved: true, queueId: result.queueId }));
  });

  it.each(["program", "event"])("keeps %s scheduling outside paused Post admission", async type => {
    await db.doc("cmsPosts/first").set({ ...post("first"), type,
      ...(type === "event" ? { startsAt: "2026-10-14T12:00:00.000Z" } : {}),
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Fixture description." }] }] } });
    await db.doc(admission.ADMISSION_PATH).update({ enabled: false, revision: 2 });
    const legacy = legacyDependencies();
    const response = await schedule("first", {}, legacy);
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    const result = await run(legacy);
    expect(result.publishedCount, JSON.stringify(failures)).toBe(1);
    expect(result.publications).toBeUndefined();
    expect((await db.doc("cmsPosts/first").get()).data().published.metadata.type).toBe(type);
    expect(legacy.enqueuePublishFn).toHaveBeenCalledOnce();
  });

  it.each(["unsupported", "removed admission"])("records a visible failure for an owned schedule with %s", async kind => {
    expect((await schedule("first")).code).toBe(200);
    const first = await run();
    const oldQueue = first.publications[0].queueId;
    await db.doc("cmsPosts/first").update({ status: "draft", version: 4 });
    expect((await schedule("first", { baseVersion: 4, scheduleAt: "2026-10-13T12:00:00.000Z", nowAt: due })).code).toBe(200);
    if (kind === "unsupported") await legacyHomeCard();
    else await db.doc(admission.ADMISSION_PATH).update({ families: { posts: { mode: "ids", ids: ["other"] } }, revision: 2 });
    expect((await run({ now: () => "2026-10-13T12:00:00.000Z" })).publishedCount).toBe(0);
    const document = (await db.doc("cmsPosts/first").get()).data();
    expect(document.status).toBe("draft");
    expect(document.publishAt).toBeUndefined();
    expect(document.scheduledPublicationTransport).toBeUndefined();
    expect(document.scheduledPublishFailure.reason).toContain(kind === "unsupported" ? "legacy Home card" : "no longer admits this owned Post");
    expect((await ownership.readNoBuildPostOwner({ firestore: db, postId: "first" })).state.operationId).toBe(oldQueue);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });

  it("records future fast intent without accepting a public operation or requiring a build", async () => {
    const response = await schedule("first");
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect((await db.doc("cmsPosts/first").get()).data()).toMatchObject({ status: "scheduled", version: 2,
      publishAt: due, scheduledPublicationTransport: "post-no-build-v1" });
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
    expect((await db.collection(ownership.OWNER_COLLECTION).get()).empty).toBe(true);
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(1);
  });

  it("fires two admitted Posts through separate atomic fast queues without a build", async () => {
    for (const id of ["first", "second"]) await db.doc(`cmsPosts/${id}`).set({ ...post(id), status: "scheduled", publishAt: due });
    const result = await run();
    expect(result.publishedCount, JSON.stringify(failures)).toBe(2);
    expect(result.queueId).toBeNull();
    const queues = await db.collection("cmsPublishQueue").get();
    expect(queues.size).toBe(2);
    expect(queues.docs.map(row => row.data().transport)).toEqual(["post-no-build-v1", "post-no-build-v1"]);
    for (const id of ["first", "second"]) {
      const document = (await db.doc(`cmsPosts/${id}`).get()).data();
      const owner = await ownership.readNoBuildPostOwner({ firestore: db, postId: id });
      expect(document).toMatchObject({ status: "published", version: 2, firstPublishedAt: due,
        publishBuildPending: true, publishBuildQueueId: owner.state.operationId });
      expect(owner.state).toMatchObject({ postId: id, sourceVersion: 2, admissionRevision: 1, visible: true });
      expect(result.publications).toContainEqual(expect.objectContaining({ queueId: owner.state.operationId, transport: "post-no-build-v1", id }));
    }
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(2);
    expect((await db.collection("admin_logs").get()).size).toBe(2);
    expect((await db.doc("cmsBackgroundOutputs/listings").get()).data().status).toBe("pending");
    expect((await run()).publishedCount).toBe(0);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
  });

  it("schedules an owned Post without replacing its live operation until fire", async () => {
    expect((await schedule("first")).code).toBe(200);
    const first = await run();
    const oldQueue = first.publications[0].queueId;
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const response = { code: 200, status(code) { this.code = code; return this; }, set() {}, json(body) { this.body = body; return this; } };
    await handler({ method: "POST", headers: {}, body: { collection: "cmsPosts", id: "first", baseVersion: 3, action: "revise" } }, response);
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    const nextDue = "2026-10-13T12:00:00.000Z";
    expect((await schedule("first", { baseVersion: 4, scheduleAt: nextDue, nowAt: due })).code).toBe(200);
    expect((await db.doc("cmsPosts/first").get()).data().published.sourceVersion).toBe(3);
    expect((await ownership.readNoBuildPostOwner({ firestore: db, postId: "first" })).state.operationId).toBe(oldQueue);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
    const second = await run({ now: () => nextDue });
    expect(second.publishedCount).toBe(1);
    expect(second.publications[0].queueId).not.toBe(oldQueue);
    expect((await db.doc("cmsPosts/first").get()).data()).toMatchObject({ version: 6, firstPublishedAt: due,
      published: { sourceVersion: 6, publishedAt: nextDue } });
    expect((await db.doc(`cmsPublishQueue/${oldQueue}`).get()).data().status).toBe("cancelled");
  });

  it("records a visible failure when scheduled dependencies stop supporting the fast path", async () => {
    expect((await schedule("first")).code).toBe(200);
    await legacyHomeCard();
    expect((await run()).publishedCount).toBe(0);
    expect((await db.doc("cmsPosts/first").get()).data()).toMatchObject({ status: "draft",
      scheduledPublishFailure: { reason: "This Post is copied into a legacy Home card. Change that Home card to a Home source selection, then publish this Post again." } });
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it("keeps accepted fast intent when admission changes instead of creating a build", async () => {
    expect((await schedule("first")).code).toBe(200);
    await db.doc(admission.ADMISSION_PATH).update({ families: { posts: { mode: "ids", ids: ["other"] } }, revision: 2 });
    const result = await run();
    expect(result.publishedCount).toBe(0);
    const document = (await db.doc("cmsPosts/first").get()).data();
    expect(document.status).toBe("draft");
    expect(document.scheduledPublishFailure.reason).toContain("scheduled build-free publication");
    expect(document.scheduledPublicationTransport).toBeUndefined();
    expect(document.published).toBeUndefined();
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it.each(["pause", "lease", "cloud"])("keeps the due version during a %s without a build", async kind => {
    expect((await schedule("first")).code).toBe(200);
    const before = (await db.doc("cmsPosts/first").get()).data();
    if (kind === "pause") await db.doc(admission.ADMISSION_PATH).update({ enabled: false, revision: 2 });
    if (kind === "cloud") await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "paused" });
    if (kind === "lease") await db.doc("system/publicDeployment").set({ ...pointer(), state: "deploying",
      leaseToken: "fixture-lease", leaseAcquiredAt: new Date(), lastReservedGeneration: 2,
      newestEligibleGeneration: 2, newestEligibleBuildBatchId: "release", candidateGeneration: 2,
      candidateBuildBatchId: "release", candidateCommitSha: "b".repeat(40), predecessorGeneration: 1,
      predecessorDeploymentId: pointer().activeDeploymentId, predecessorCommitSha: sha });
    expect((await run()).publishedCount).toBe(0);
    expect((await db.doc("cmsPosts/first").get()).data()).toEqual(before);
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
    await db.doc(admission.ADMISSION_PATH).update({ enabled: true, revision: 3 });
    await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "ready" });
    await db.doc("system/publicDeployment").set(pointer());
    expect((await run()).publishedCount).toBe(1);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });

  it("clears transport intent on cancellation and ignores client transport fields", async () => {
    expect((await schedule("first")).code).toBe(200);
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const response = { code: 200, status(code) { this.code = code; return this; }, set() {}, json(body) { this.body = body; return this; } };
    await handler({ method: "POST", headers: {}, body: { collection: "cmsPosts", id: "first", baseVersion: 2, action: "unschedule" } }, response);
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    const document = (await db.doc("cmsPosts/first").get()).data();
    expect(document.status).toBe("draft");
    expect(document.publishAt).toBeUndefined();
    expect(document.scheduledPublicationTransport).toBeUndefined();
    const saveHandler = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    await saveHandler({ method: "POST", headers: {}, body: { collection: "cmsPosts", id: "first", baseVersion: 3,
      document: { scheduledPublicationTransport: "post-no-build-v1" } } }, response);
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect((await db.doc("cmsPosts/first").get()).data().scheduledPublicationTransport).toBeUndefined();
  });

  it("leaves failed fast confirmations with their accepted owner instead of a legacy retry", async () => {
    expect((await schedule("first")).code).toBe(200);
    const result = await run();
    const queueId = result.publications[0].queueId;
    await buildState.settleBuildQueue(db, { queueId, status: "failed", queueUpdate: { status: "failed", error: "Fixture confirmation failure" } });
    const before = (await db.doc("cmsPosts/first").get()).data();
    expect(before.publishBuildPending).toBe(true);
    expect(before.publishBuildQueueId).toBeNull();
    expect((await run()).publishedCount).toBe(0);
    expect((await db.doc("cmsPosts/first").get()).data()).toEqual(before);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
    expect((await db.doc(`cmsPublishQueue/${queueId}`).get()).data().status).toBe("failed");
  });

  it("keeps independent fast publication when a mixed legacy build is unavailable", async () => {
    expect((await schedule("first")).code).toBe(200);
    await db.doc("cmsPages/home").set({ title: "Home", template: "home", blocks: [], status: "scheduled", version: 1, publishAt: due });
    expect((await run()).publishedCount).toBe(1);
    expect((await db.doc("cmsPages/home").get()).data().status).toBe("scheduled");
    const queues = await db.collection("cmsPublishQueue").get();
    expect(queues.size).toBe(1);
    expect(queues.docs[0].data().transport).toBe("post-no-build-v1");
  });

  it("exposes only the fired snapshot and its operation at the public render boundary", async () => {
    expect((await schedule("first")).code).toBe(200);
    const accepted = await run();
    await db.doc("cmsPosts/first").update({ title: "Private unsaved publication", status: "draft", version: 4 });
    expect((await db.doc("cmsPosts/first").get()).data().published.publishedBy).toBe("system:scheduler");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(due));
    let decision;
    try { decision = await publication.readNoBuildPostDecision({ firestore: db, path: "/posts/first-story/", rendererSha: sha }); }
    finally { vi.useRealTimers(); }
    expect(decision.kind).toBe("post");
    expect(decision.receipt).toMatchObject({ operationId: accepted.publications[0].queueId, sourceVersion: 3,
      rendererSha: sha, admissionRevision: 1, slug: "first-story", visible: true });
    expect(decision.published.document.published).toMatchObject({ sourceVersion: 3,
      publishedAt: due, metadata: { title: "Scheduled first", firstPublishedAt: due } });
    expect(JSON.stringify(decision.published)).not.toContain("Private unsaved publication");
  });

});
