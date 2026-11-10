import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../functions/lib/firebase.js";
import homeOwner from "../../functions/lib/no-build-home-ownership.js";
import background from "../../functions/lib/post-background-outputs.js";
import publication from "../../functions/lib/no-build-post-publication.js";
import registry from "../../functions/lib/no-build-post-ownership.js";
import deployment from "../../functions/lib/public-deployment.js";
import homeCatalog from "../../functions/lib/home-source-catalog.js";
import publishBuildState from "../../functions/lib/publish-build-state.js";

const { HOME_PAGE_OWNER_PATH, HOME_BACKGROUND_PATH, prepareHomePlanInTransaction,
  readHomePageAuthorityInTransaction, prepareHomePostRefreshInTransaction, homePageOwnsPath } = homeOwner;
const rendererSha = "a".repeat(40);
const runtime = { owner: "cloudflare", release: rendererSha };
const operationId = "HOMEpageoperation001";
const legacyTaskPath = "cmsPublishQueue/legacy-post/backgroundOutputs/home";
const operation = (id = operationId) => ({ schemaVersion: 1, pageId: "home", path: "/",
  ownedPaths: ["/", "/_home-sources.json"], sourceVersion: 7, generation: 22,
  rendererSha, visible: true, operationId: id });
const home = () => ({ version: 10, title: "Private Home draft", blocks: [{ id: "private-working-block" }],
  publiclyVisible: true, published: { sourceVersion: 7,
    metadata: { template: "home", homeCompositionVersion: 2 }, blocks: [{ id: "saved-posts", visible: true,
      type: "content_shelf", section: "home-posts", data: { source: "station_posts", title: "Station stories" } }] } });
const post = (sourceVersion = 3, visible = true) => ({ version: 9, title: "Private Post draft",
  publiclyVisible: visible, published: { sourceVersion, metadata: { type: "post", slug: "station-story",
    title: "Published story", previousSlugs: [], credits: [] }, blocks: [] } });

async function legacy(claim: string | null = null, verified = false) {
  await db.doc(legacyTaskPath).set({ schemaVersion: 1, owner: "post-background-v1", output: "home", revision: 2,
    status: verified ? "verified" : "pending", claim, nextAttemptAt: 0 });
  const receipt = { revision: 2, contextDigest: "b".repeat(64), rendererSha,
    manifest: [{ path: "/_home-sources.json", key: `post-background-v1/home/old-claim/${"c".repeat(64)}`,
      digest: "d".repeat(64), size: 1024, contentType: "application/json; charset=utf-8" }],
    homeSourceReceipt: { buildBatchId: "old-home-catalog", commitSha: rendererSha, generation: 21, digest: "e".repeat(64) } };
  await db.doc(HOME_BACKGROUND_PATH).set({ schemaVersion: 1, owner: "post-background-v1", output: "home", revision: 2,
    status: verified ? "verified" : "pending", taskPath: legacyTaskPath,
    ...(verified ? { receipt, contextDigest: receipt.contextDigest, after: { sourceVersion: 3 } } : {}) });
}
async function handoff({ abort = false, id = operationId } = {}) {
  return db.runTransaction(async transaction => {
    const previousOwner = (await transaction.get(db.doc(HOME_PAGE_OWNER_PATH))).data();
    const plan = await prepareHomePlanInTransaction({ firestore: db, transaction, nextDocument: home(), operation: operation(id), runtime });
    transaction.set(db.doc(HOME_PAGE_OWNER_PATH), { ...previousOwner, ...operation(id), runtime, servingEnabled: false });
    plan.write();
    if (abort) throw new Error("Abort the Home publication");
    return plan;
  });
}
async function acceptPost(queueId = "POSTrefreshoperat001", nextDocument = post(), abort = false) {
  return db.runTransaction(async transaction => {
    const publishedHome = (await transaction.get(db.doc("cmsPages/home"))).data()?.published;
    const affectedSections = homeCatalog.homePostPlacements({ blocks: publishedHome?.blocks,
      homeHero: publishedHome?.metadata?.homeHero }, "station-post",
    [nextDocument.published.metadata.slug, ...nextDocument.published.metadata.previousSlugs], nextDocument.published.metadata);
    const write = await prepareHomePostRefreshInTransaction({ firestore: db, transaction,
      postId: "station-post", nextDocument, queueId, affectedSections });
    transaction.set(db.doc("cmsPosts/station-post"), nextDocument);
    write();
    if (abort) throw new Error("Abort the Post publication");
  });
}
const authority = () => db.runTransaction(transaction => readHomePageAuthorityInTransaction({ firestore: db, transaction }), { readOnly: true });

async function preparePostRuntime() {
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 1, activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: rendererSha,
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
  await db.doc(registry.CAPABILITY_PATH).set({ schemaVersion: 2, rendererSha, servingEnabled: true, generation: 1 });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: rendererSha,
    serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: rendererSha, serializerId: "cloudflare-publisher" } });
  await db.doc("cmsPosts/station-post").set(post(2));
}
async function acceptThroughPostOwner(nextDocument = post()) {
  const queueRef = db.collection("cmsPublishQueue").doc();
  await db.runTransaction(async transaction => {
    const prepared = await publication.prepareNoBuildPostPublication({ firestore: db, transaction,
      collection: "cmsPosts", documentId: "station-post", nextDocument, queueRef,
      actor: { uid: "fixture-editor" }, config: { valid: true, enabled: true,
        families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket", admissionRevision: 1 } });
    prepared.write();
    transaction.set(db.doc("cmsPosts/station-post"), nextDocument);
  });
  return queueRef.id;
}

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use a local demo Firestore emulator");
});
beforeEach(async () => {
  vi.stubEnv("CMS_PUBLISH_TRANSPORT", "serializer");
  await Promise.all([db.doc(HOME_PAGE_OWNER_PATH).delete(), db.recursiveDelete(db.collection("cmsBackgroundOutputs")),
    db.recursiveDelete(db.collection(registry.OWNER_COLLECTION)),
    db.recursiveDelete(db.collection("cmsPublishQueue")), db.recursiveDelete(db.collection("cmsPosts")),
    // These legacy publications run without log enrollment. Other SDK specs
    // exercise malformed/enabled controls in the same emulator project.
    db.doc("system/publicReleaseChangeLog").delete(),
    // This fixture owns legacy aggregates. A preceding Page publish can leave
    // their namespace owned by the cloud aggregate publisher.
    db.doc("system/publicDeployment/aggregateContexts/current").delete(),
    db.doc("cmsPages/home").set(home())]);
});
afterAll(async () => { vi.unstubAllEnvs(); await db.terminate(); });

describe("Home Page authority at the Firestore boundary", () => {
  it("leaves legacy Home authority intact until a Page owner is committed", async () => {
    await legacy();
    expect(await authority()).toBeNull();
    await acceptPost();
    expect((await db.doc(legacyTaskPath).get()).data()?.status).toBe("pending");
    expect((await db.doc("cmsPublishQueue/POSTrefreshoperat001/homePageRefresh/home").get()).exists).toBe(false);
  });

  it("atomically retires unclaimed legacy work and reserves both Home routes", async () => {
    await legacy();
    await handoff();
    expect((await db.doc(legacyTaskPath).get()).data()).toMatchObject({ status: "superseded", claim: null, nextAttemptAt: null });
    const owner = await authority();
    expect(owner).toMatchObject({ pageId: "home", operationId, servingEnabled: false });
    for (const path of ["/", "/index.html", "/_home-sources.json"]) expect(homePageOwnsPath(owner, path)).toBe(true);
    expect(homePageOwnsPath(owner, "/posts/")).toBe(false);
    // A former background process cannot reactivate its slot after transfer.
    await background.createPostBackgroundOutputs({ firestore: db, enabled: true, runtime,
      build: async () => { throw new Error("The retired writer must not build"); },
      artifacts: { put: async () => {}, get: async () => new Uint8Array() },
      readContextInTransaction: async () => { throw new Error("The retired writer must not select context"); } }).recover();
    expect((await db.doc(HOME_BACKGROUND_PATH).get()).data()?.owner).toBe("page-no-build-v1");
  });

  it("rolls the marker and legacy settlement back with failed Page acceptance", async () => {
    await legacy();
    await expect(handoff({ abort: true })).rejects.toThrow("Abort");
    expect((await db.doc(HOME_PAGE_OWNER_PATH).get()).exists).toBe(false);
    expect((await db.doc(HOME_BACKGROUND_PATH).get()).data()?.owner).toBe("post-background-v1");
    expect((await db.doc(legacyTaskPath).get()).data()?.status).toBe("pending");
  });

  it("refuses an uncertain legacy claim even when its deadline has passed", async () => {
    await legacy("owned-claim");
    await expect(handoff()).rejects.toMatchObject({ status: 409 });
    expect((await db.doc(legacyTaskPath).get()).data()?.claim).toBe("owned-claim");
    expect((await db.doc(HOME_PAGE_OWNER_PATH).get()).exists).toBe(false);
  });

  it("retains the complete immutable provider file identity through later Home publications", async () => {
    await legacy(null, true);
    const first = await handoff();
    expect(first.retainedSource).toMatchObject({ file: { path: "/_home-sources.json", size: 1024 },
      publication: { buildBatchId: "old-home-catalog", generation: 21 } });
    const second = await handoff({ id: "HOMEpageoperation002" });
    expect(second.retainedSource).toEqual(first.retainedSource);
    expect((await db.doc(legacyTaskPath).get()).data()?.status).toBe("verified");
  });

  it("refuses missing markers, partial route ownership and a non-cloud runtime", async () => {
    await handoff();
    await db.doc(HOME_BACKGROUND_PATH).delete();
    await expect(authority()).rejects.toMatchObject({ status: 409 });
    for (const overrides of [{ ownedPaths: ["/"] }, { runtime: { owner: "node-compute", release: rendererSha } }]) {
      expect(() => homePageOwnsPath({ ...operation(), runtime, ...overrides }, "/")).toThrow();
    }
  });

  it("records a Post-only refresh without changing the saved Home draft", async () => {
    await handoff();
    const savedHome = (await db.doc("cmsPages/home").get()).data();
    await acceptPost();
    const task = (await db.doc("cmsPublishQueue/POSTrefreshoperat001/homePageRefresh/home").get()).data();
    expect(task).toMatchObject({ owner: "page-no-build-v1", revision: 1, status: "pending",
      input: { postId: "station-post", sourceVersion: 3, homeSourceVersion: 7, visible: true },
      affectedSections: [{ blockId: "saved-posts", section: "home-posts", refreshable: true }] });
    expect(JSON.stringify(task)).not.toContain("Private");
    expect((await db.doc("cmsPages/home").get()).data()).toEqual(savedHome);
    expect((await authority()).homeRefresh).toMatchObject({ revision: 1, sourceOperationId: "POSTrefreshoperat001" });
  });

  it("makes duplicate acceptance idempotent and rejects a changed Post revision", async () => {
    await handoff();
    await acceptPost();
    await acceptPost();
    expect((await authority()).homeRefresh.revision).toBe(1);
    await expect(acceptPost("POSTrefreshoperat001", post(4))).rejects.toMatchObject({ status: 409 });
    expect((await authority()).homeRefresh.revision).toBe(1);
  });

  it("invalidates catalog-only changes and withdrawals with monotonically increasing revisions", async () => {
    await handoff();
    await db.doc("cmsPages/home").update({ "published.blocks": [] });
    await acceptPost();
    const secondId = "POSTrefreshoperat002";
    await acceptPost(secondId, post(4, false));
    const task = (await db.doc(`cmsPublishQueue/${secondId}/homePageRefresh/home`).get()).data();
    expect(task).toMatchObject({ revision: 2, input: { visible: false, sourceVersion: 4 }, affectedSections: [] });
    expect((await authority()).homeRefresh).toMatchObject({ revision: 2, sourceOperationId: secondId });
  });

  it("supersedes pending Post refresh on a new Home publication without resetting its revision", async () => {
    await handoff();
    await acceptPost();
    await db.doc("cmsPublishQueue/POSTrefreshoperat001/homePageRefresh/home").update({ claim: "preparing-owned" });
    const nextHomeOperation = "HOMEpageoperation002";
    await handoff({ id: nextHomeOperation });
    expect((await authority()).homeRefresh).toMatchObject({ revision: 1, status: "superseded", supersededBy: nextHomeOperation });
    expect((await db.doc("cmsPublishQueue/POSTrefreshoperat001/homePageRefresh/home").get()).data())
      .toMatchObject({ revision: 1, status: "superseded", supersededBy: nextHomeOperation, claim: "preparing-owned" });
    await acceptPost("POSTrefreshoperat002", post(4));
    expect((await authority()).homeRefresh).toMatchObject({ revision: 2, status: "pending" });
  });

  it("keeps the dirty signal on a duplicate Home operation", async () => {
    await handoff();
    await acceptPost();
    await handoff();
    expect((await authority()).homeRefresh).toMatchObject({ revision: 1, status: "pending" });
    expect((await db.doc("cmsPublishQueue/POSTrefreshoperat001/homePageRefresh/home").get()).data()?.status).toBe("pending");
  });

  it("retains the prior pending signal and task if the new Home publication aborts", async () => {
    await handoff();
    await acceptPost();
    await expect(handoff({ id: "HOMEpageoperation002", abort: true })).rejects.toThrow("Abort");
    expect((await authority()).homeRefresh).toMatchObject({ revision: 1, status: "pending" });
    expect((await db.doc("cmsPublishQueue/POSTrefreshoperat001/homePageRefresh/home").get()).data()?.status).toBe("pending");
  });

  it("rolls back Post mutation and refresh together and rejects a changed published Home", async () => {
    await handoff();
    await expect(acceptPost("POSTrefreshoperat001", post(), true)).rejects.toThrow("Abort");
    expect((await db.doc("cmsPosts/station-post").get()).exists).toBe(false);
    expect((await authority()).homeRefresh).toBeUndefined();
    await db.doc("cmsPages/home").update({ "published.sourceVersion": 8 });
    await expect(acceptPost()).rejects.toMatchObject({ status: 409 });
  });

  it("keeps Post and all six aggregates publishable after the Home route transfer", async () => {
    await handoff();
    await preparePostRuntime();
    const queueId = await acceptThroughPostOwner();
    expect((await db.doc(`cmsPublishQueue/${queueId}`).get()).data()?.transport).toBe("post-no-build-v1");
    expect((await db.doc(`cmsPublishQueue/${queueId}/homePageRefresh/home`).get()).data()?.status).toBe("pending");
    for (const output of ["listings", "authors", "feed", "contentApi", "sitemap", "search"]) {
      expect((await db.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/${output}`).get()).data()?.status, output).toBe("pending");
    }
    expect((await db.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/home`).get()).exists).toBe(false);
    expect((await authority()).homeRefresh.revision).toBe(1);
  });

  it.each(["serializer", "github"])("atomically settles a %s Cloudflare queue with one grouped Home refresh and idempotent completion", async transport => {
    await handoff();
    const queueRef = db.collection("cmsPublishQueue").doc();
    const changes = [
      { collection: "cmsPosts", id: "station-post", sourceVersion: 3 },
      { collection: "cmsPosts", id: "withdrawn-post", sourceVersion: 4, operation: "withdraw" },
    ];
    await queueRef.set({ transport, runtime, status: "publishing", changes });
    await db.doc("cmsPosts/station-post").set({ ...post(), publishBuildPending: true, publishBuildQueueId: queueRef.id });
    await db.doc("cmsPosts/withdrawn-post").set({ ...post(4, false), publishBuildPending: true, publishBuildQueueId: queueRef.id });
    const savedHome = (await db.doc("cmsPages/home").get()).data();
    const complete = () => publishBuildState.settleBuildQueue(db, { queueId: queueRef.id, status: "success",
      queueUpdate: { status: "success" }, returnResult: true });
    expect(await complete()).toEqual({ settled: true, idempotent: false });
    const tasks = await queueRef.collection("homePageRefresh").get();
    expect(tasks.docs.map(task => task.id)).toEqual(["home"]);
    const task = tasks.docs[0].data();
    expect(task).toMatchObject({ revision: 1, status: "pending", input: {
      sourceTransport: transport, sourceOperationId: queueRef.id,
      homeOperationId: operationId, homeSourceVersion: 7, postChanges: [
        { postId: "station-post", sourceVersion: 3, visible: true },
        { postId: "withdrawn-post", sourceVersion: 4, visible: false },
      ],
    } });
    expect((await queueRef.get()).data()?.status).toBe("success");
    expect((await db.doc("cmsPosts/station-post").get()).data())
      .toMatchObject({ publishBuildPending: false, publishBuildQueueId: null, publicSourceVersion: 3 });
    expect((await db.doc("cmsPosts/withdrawn-post").get()).data())
      .toMatchObject({ publishBuildPending: false, publishBuildQueueId: null, publicSourceVersion: null });
    expect((await authority()).homeRefresh.revision).toBe(1);
    expect(await complete()).toEqual({ settled: true, idempotent: true });
    expect((await queueRef.collection("homePageRefresh").get()).size).toBe(1);
    expect((await db.doc(`${queueRef.path}/homePageRefresh/home`).get()).data()).toEqual(task);
    expect((await authority()).homeRefresh.revision).toBe(1);
    expect((await db.doc("cmsPages/home").get()).data()).toEqual(savedHome);
  });

  it("keeps the caller's affected sections when a Post leaves a category hero", async () => {
    await handoff();
    await preparePostRuntime();
    await db.doc("cmsPages/home").update({ "published.blocks": [],
      "published.metadata.homeHero": { mode: "category", source: "cms_posts", value: "inside" } });
    await db.doc("cmsPosts/station-post").update({ "published.metadata.categories": ["inside"] });
    const next = post();
    next.published.metadata = { ...next.published.metadata, categories: ["outside"] } as typeof next.published.metadata;
    const queueId = await acceptThroughPostOwner(next);
    const queue = (await db.doc(`cmsPublishQueue/${queueId}`).get()).data();
    const task = (await db.doc(`cmsPublishQueue/${queueId}/homePageRefresh/home`).get()).data();
    expect(queue.affectedHomeSections).toEqual([{ blockId: "hero", section: "hero", title: "Home hero", refreshable: true }]);
    expect(task.affectedSections).toEqual(queue.affectedHomeSections);
  });

  it("keeps withdrawal aggregate refreshes and the Page Home removal signal atomic", async () => {
    await handoff();
    await preparePostRuntime();
    await acceptThroughPostOwner();
    const queueId = await acceptThroughPostOwner(post(4, false));
    const task = (await db.doc(`cmsPublishQueue/${queueId}/homePageRefresh/home`).get()).data();
    expect(task).toMatchObject({ revision: 2, input: { visible: false, sourceVersion: 4 } });
    for (const output of ["listings", "authors", "feed", "contentApi", "sitemap", "search"]) {
      expect((await db.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/${output}`).get()).data(), output)
        .toMatchObject({ status: "pending", dependencies: { after: { visible: false } } });
    }
    expect((await db.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/_admission`).get()).exists).toBe(false);
    expect((await db.doc(HOME_BACKGROUND_PATH).get()).data()?.owner).toBe("page-no-build-v1");
  });
});
