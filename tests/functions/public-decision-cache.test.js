import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { gunzipSync } from "node:zlib";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { DocumentReference, Firestore, Query, Transaction } from "@google-cloud/firestore";
import content from "../../functions/public-content.js";
import cache from "../../functions/lib/public-decision-cache.js";
import context from "../../functions/lib/public-context-revision.js";
import ownership from "../../functions/lib/no-build-page-ownership.js";
import { db } from "../../functions/lib/firebase.js";
import save from "../../functions/save.js";
import lifecycle from "../../functions/lifecycle-transition.js";
import registry from "../../functions/lib/no-build-post-ownership.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import deployment from "../../functions/lib/public-deployment.js";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { schedulePacketFixture } from "./page-schedule-packet-fixture";
import { rendererSha, seedHomeDecisionFixture, seedOwnedHomeDecisionFixture } from "./fixtures/home-decision-3441.js";

// Billing counts one read per looked-up document and per returned query
// document, with a minimum of one read per query. Nested SDK calls count once.
let reads = 0;
const inRead = new AsyncLocalStorage();
function countReads(prototype, method, cost) {
  const original = prototype[method];
  return vi.spyOn(prototype, method).mockImplementation(async function (...args) {
    if (inRead.getStore()) return original.apply(this, args);
    const result = await inRead.run(true, () => original.apply(this, args));
    reads += cost(args, result);
    return result;
  });
}
const querySize = result => Math.max(1, result.size);
beforeAll(() => {
  countReads(Transaction.prototype, "get", (_args, result) => result.docs ? querySize(result) : 1);
  countReads(Transaction.prototype, "getAll", args => args.filter(arg => arg instanceof DocumentReference).length);
  countReads(Firestore.prototype, "getAll", args => args.filter(arg => arg instanceof DocumentReference).length);
  countReads(DocumentReference.prototype, "get", () => 1);
  countReads(Query.prototype, "get", (_args, result) => querySize(result));
});
afterAll(() => vi.restoreAllMocks());

function response() {
  return { headers: {}, statusCode: 200, headersSent: false,
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.text = JSON.stringify(body); this.headersSent = true; return this; },
    send(body) {
      this.text = Buffer.isBuffer(body) && this.headers["content-encoding"] === "gzip"
        ? gunzipSync(body).toString("utf8") : String(body);
      this.headersSent = true; return this;
    } };
}
async function measured(handler, body, headers = {}) {
  const result = response();
  reads = 0;
  await handler({ method: "POST", body, headers }, result);
  return { ...result, reads, body: result.text === undefined ? undefined : JSON.parse(result.text) };
}

describe("public Page decisions", () => {
  let app;
  let firestore;
  let packetFixture;
  let packetBoundary;
  afterEach(async () => { await packetFixture?.close(); packetFixture = undefined; });
  const page = (path = "/") => ({ mode: "no-build-page-v1", path, rendererSha, method: "GET" });
  beforeAll(async () => {
    if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Use the local Firestore emulator");
    app = initializeApp({ projectId: "njpbs-site-dev" }, "public-decision-cache");
    firestore = getFirestore(app);
    packetBoundary = await backgroundStorageFixture("njpbs-dev-public-artifacts");
  });
  beforeEach(async () => {
    packetBoundary.objects.clear();
    packetBoundary.reads.length = 0;
    await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
    await seedHomeDecisionFixture(firestore);
  });
  afterAll(async () => { await packetBoundary?.close(); if (app) await deleteApp(app); });
  const handlers = (options = {}) => ({
    fresh: content.createCmsGetPublicPageHandler({ firestore, log: { error() {} } }),
    cached: content.createCmsGetPublicPageHandler({ firestore, log: { error() {} },
      decisionCache: cache.createPublicDecisionCache(options) }),
  });
  const bump = (write, options) => firestore.runTransaction(async transaction => {
    write?.(transaction);
    context.bumpPublicContextRevision(transaction, firestore, options);
  });

  it.each([["context Home", "/", false], ["context Page", "/contact/", false], ["owned Home", "/", true]])(
    "serves the same %s reply from %s with only the validator reads", async (_name, path, owned) => {
      if (owned) await seedOwnedHomeDecisionFixture(firestore);
      const { fresh, cached } = handlers();
      const before = await measured(fresh, page(path));
      const miss = await measured(cached, page(path));
      const hit = await measured(cached, page(path));
      expect(before.statusCode).toBe(200);
      expect(miss.text).toBe(before.text);
      expect(hit.text).toBe(before.text);
      expect(hit.headers["cache-control"]).toBe("private, no-store");
      const until = Number(miss.headers["x-njpbs-public-decision-valid-until"]);
      expect(until).toBeGreaterThan(Date.now());
      expect(until).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(hit.headers["x-njpbs-public-decision-valid-until"]).toBe(String(until));
      expect(before.headers["x-njpbs-public-decision-valid-until"]).toBeUndefined();
      expect(miss.reads).toBe(before.reads + cache.VALIDATOR_PATHS.length);
      expect(hit.reads).toBe(cache.VALIDATOR_PATHS.length);
    });

  it.each(["/live/", "/schedule/"])("reuses stable %s input while qualifying fresh schedule authority", async path => {
    packetFixture = await schedulePacketFixture({ firestore, rendererSha, generation: 5, boundary: packetBoundary });
    const options = { firestore, log: { error() {} }, currentCodeRequest: packetFixture.request };
    const fresh = content.createCmsGetPublicPageHandler(options);
    const cached = content.createCmsGetPublicPageHandler({ ...options, decisionCache: cache.createPublicDecisionCache() });
    const baseline = await measured(fresh, page(path));
    const miss = await measured(cached, page(path));
    const references = packetFixture.referenceReads();
    const hit = await measured(cached, page(path));
    expect(baseline.statusCode).toBe(200);
    expect(hit.text).toBe(baseline.text);
    expect(miss.text).toBe(baseline.text);
    expect(hit.headers["cache-control"]).toBe("private, no-store");
    expect(hit.headers["x-njpbs-public-decision-valid-until"]).toBeUndefined();
    expect(hit.reads).toBeLessThanOrEqual(21);
    expect(packetFixture.referenceReads()).toBe(references + 2);
  });

  it.each(["/live/", "/schedule/"])("invalidates %s stable input for CODE, context and capability changes", async path => {
    packetFixture = await schedulePacketFixture({ firestore, rendererSha, generation: 5, boundary: packetBoundary });
    const cached = content.createCmsGetPublicPageHandler({ firestore, log: { error() {} },
      currentCodeRequest: packetFixture.request, decisionCache: cache.createPublicDecisionCache() });
    expect((await measured(cached, page(path))).body.kind).toBe("context-page");
    // This private RPC reference changes without a local control-document write.
    packetFixture.reference.publication.artifactDigest = "f".repeat(64);
    const codeChanged = await measured(cached, page(path));
    expect(codeChanged.body.renderContext.schedule.receipt.code.artifactDigest).toBe("f".repeat(64));
    await bump();
    const contextChanged = await measured(cached, page(path));
    expect(contextChanged.body.contextReceipt.contextRevision).toBe(5);
    expect(contextChanged.body.renderContext.schedule.receipt.contextRevision).toBe(5);
    await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({ servingEnabled: false });
    const disabled = await measured(cached, page(path));
    expect(disabled.body.kind).toBe("pass");
    expect(disabled.body.renderContext).toBeUndefined();
  });

  it("shows an owned Live withdrawal before any stored projection or private IO", async () => {
    packetFixture = await schedulePacketFixture({ firestore, rendererSha, generation: 5, boundary: packetBoundary });
    const document = { id: "live", template: "programLanding", section: "watch", version: 1,
      title: "Published Live title", blocks: [], status: "published", publiclyVisible: true,
      publishAt: "2026-10-12T11:00:00.000Z" };
    document.published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document,
      publishedAt: document.publishAt, publishedBy: "fixture-editor" });
    const ownerPath = `${ownership.PAGE_OWNER_COLLECTION}/live`;
    await bump(transaction => {
      transaction.set(firestore.doc("cmsPages/live"), document);
      transaction.set(firestore.doc(ownerPath), { schemaVersion: 1, pageId: "live", rendererSha,
        servingEnabled: true, generation: 5, operationId: "L".repeat(20), sourceVersion: 1,
        visible: true, path: "/live/", ownedPaths: ["/live/"], snapshotDigest: ownership.digest(document.published),
        runtime: { owner: "cloudflare", release: rendererSha } });
      transaction.set(ownership.pageRouteRef(firestore, "/live/"), { schemaVersion: 1, pageId: "live", path: "/live/" });
      transaction.set(firestore.doc("system/noBuildPostAdmission"), { schemaVersion: 2, revision: 1, enabled: true,
        families: { pages: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-artifacts" });
    });
    const cached = content.createCmsGetPublicPageHandler({ firestore, log: { error() {} },
      currentCodeRequest: packetFixture.request, decisionCache: cache.createPublicDecisionCache() });
    expect((await measured(cached, page("/live/"))).body.kind).toBe("page");
    const hit = await measured(cached, page("/live/"));
    expect(hit.body.published.page.title).toBe("Published Live title");
    expect(hit.reads).toBeLessThanOrEqual(21);
    const codeRequests = packetFixture.codeRequests();
    await bump(transaction => {
      transaction.update(firestore.doc("cmsPages/live"), { publiclyVisible: false });
      transaction.update(firestore.doc(ownerPath), { visible: false });
    }, { withdrawal: true });
    const gone = await measured(cached, page("/live/"));
    expect(gone.body.kind).toBe("gone");
    expect(gone.text).not.toContain("Published Live title");
    expect(packetFixture.codeRequests()).toBe(codeRequests);
  });

  it("refuses cached Live input when private CODE qualification fails", async () => {
    packetFixture = await schedulePacketFixture({ firestore, rendererSha, generation: 5, boundary: packetBoundary });
    const cached = content.createCmsGetPublicPageHandler({ firestore, log: { error() {} },
      currentCodeRequest: packetFixture.request, decisionCache: cache.createPublicDecisionCache() });
    expect((await measured(cached, page("/live/"))).body.kind).toBe("context-page");
    packetFixture.refuseCode();
    const refused = await measured(cached, page("/live/"));
    expect(refused.body.kind).toBe("schedule-unavailable");
    expect(refused.text).not.toContain("projectionJson");
  });

  it("shows a publication and a withdrawal on the next request", async () => {
    const { cached } = handlers();
    expect((await measured(cached, page("/contact/"))).body.renderContext.page.title).toBe("Fixture contact");
    await bump(transaction => transaction.update(firestore.doc("cmsPages/contact"), { version: 9,
      "published.sourceVersion": 8, "published.metadata.title": "New published title" }));
    const published = await measured(cached, page("/contact/"));
    expect(published.body.renderContext.page.title).toBe("New published title");
    expect(published.body.contextReceipt.contextRevision).toBe(5);
    await bump(transaction => transaction.update(firestore.doc("cmsPages/contact"), { publiclyVisible: false }), { withdrawal: true });
    const withdrawn = await measured(cached, page("/contact/"));
    expect(withdrawn.body.renderContext.page).toBeNull();
    expect(JSON.stringify(withdrawn.body)).not.toContain("New published title");

    await measured(cached, page("/"));
    await bump(transaction => transaction.update(firestore.doc("cmsPosts/fixture-post-00"), { publiclyVisible: false }), { withdrawal: true });
    const home = await measured(cached, page("/"));
    expect(home.body.renderContext.posts).toHaveLength(19);
    expect(JSON.stringify(home.body)).not.toContain("Fixture Post 0\"");
  });

  it("applies release and operator controls without a context revision", async () => {
    await seedOwnedHomeDecisionFixture(firestore);
    const { cached } = handlers();
    expect((await measured(cached, page())).body.kind).toBe("page");
    await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({ servingEnabled: false });
    await firestore.doc("system/publicDeployment/noBuildPageOwners/home").update({ servingEnabled: false });
    expect((await measured(cached, page())).statusCode).toBe(503);
    await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({ servingEnabled: true });
    await firestore.doc("system/publicDeployment/noBuildPageOwners/home").update({ servingEnabled: true });
    expect((await measured(cached, page())).body.kind).toBe("page");
    // The runtime admission record is the operator pause.
    await firestore.doc("system/noBuildPostAdmission").update({ revision: 8, enabled: false });
    const paused = await measured(cached, page());
    expect(paused.reads).toBeGreaterThan(cache.VALIDATOR_PATHS.length);
  });

  it("rebuilds after the time bound and never caches a release in progress", async () => {
    let now = 0;
    const { fresh, cached } = handlers({ clock: () => now });
    const full = (await measured(fresh, page("/contact/"))).reads;
    await measured(cached, page("/contact/"));
    now = cache.DEFAULT_TTL_MS - 1;
    expect((await measured(cached, page("/contact/"))).reads).toBe(cache.VALIDATOR_PATHS.length);
    now = cache.DEFAULT_TTL_MS;
    expect((await measured(cached, page("/contact/"))).reads).toBe(full + cache.VALIDATOR_PATHS.length);
    await firestore.doc("system/publicDeployment").update({ state: "candidate" });
    await measured(cached, page("/contact/"));
    expect((await measured(cached, page("/contact/"))).reads).toBeGreaterThan(cache.VALIDATOR_PATHS.length);
  });

  it("sends gzip only when the caller accepts it", async () => {
    const { fresh, cached } = handlers();
    const plain = await measured(fresh, page("/"));
    const zipped = await measured(cached, page("/"), { "accept-encoding": "gzip, deflate, br" });
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(zipped.text).toBe(plain.text);
    const hit = await measured(cached, page("/"));
    expect(hit.headers["content-encoding"]).toBeUndefined();
    expect(hit.text).toBe(plain.text);
    expect(cache.acceptsGzip({ headers: { "accept-encoding": "gzip;q=0, br" } })).toBe(false);
  });
});

describe("public Post decisions", () => {
  const sha = "a".repeat(40);
  const actor = { uid: "editor-fixture", email: "editor@example.test",
    principal: { id: "editor-fixture", grants: [{ role: "editor", sections: ["news"] }] } };
  const quiet = { info() {}, warn() {}, error() {} };
  const post = path => ({ mode: "no-build-post-v1", path, rendererSha: sha, method: "GET" });
  async function invoke(handler, body) {
    const result = { code: 200, set() { return this; }, status(code) { this.code = code; return this; },
      json(value) { this.body = value; return this; } };
    await handler({ method: "POST", body, headers: {}, ip: "127.0.0.1" }, result);
    return result;
  }
  const saveHandler = () => save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor,
    now: () => "2026-10-11T12:00:00.000Z", enablePublishSnapshot: true, log: quiet,
    assertPublishReadyFn: async () => { throw new Error("Full-build dispatch is outside this publication"); } });
  beforeEach(async () => {
    vi.stubEnv("CMS_PUBLISH_TRANSPORT", "serializer");
    await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`, { method: "DELETE" });
    await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
      families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
    await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
      activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: sha,
      lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
    await db.doc(registry.CAPABILITY_PATH).set({ schemaVersion: 2, rendererSha: sha, servingEnabled: true, generation: 1 });
    await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "node-compute-publisher",
      cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
    await db.doc("sections/news").set({ label: "News" });
    await db.doc("cmsPosts/first").set({ id: "first", type: "post", title: "First title", status: "approved", section: "news",
      slug: "first-story", previousSlugs: [], version: 1, createdBy: actor.uid, tags: [], categories: [], credits: [], blocks: [] });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("caches a Post detail and shows the next publication and withdrawal at once", async () => {
    expect((await invoke(saveHandler(), { collection: "cmsPosts", id: "first", baseVersion: 1, publish: true, document: {} })).code).toBe(200);
    const fresh = content.createCmsGetPublicPageHandler({ firestore: db, log: quiet });
    const cached = content.createCmsGetPublicPageHandler({ firestore: db, log: quiet, decisionCache: cache.createPublicDecisionCache() });
    const before = await measured(fresh, post("/posts/first-story/"));
    await measured(cached, post("/posts/first-story/"));
    const hit = await measured(cached, post("/posts/first-story/"));
    expect(before.body.kind).toBe("post");
    expect(hit.text).toBe(before.text);
    expect(hit.reads).toBe(cache.VALIDATOR_PATHS.length);

    const edit = await invoke(saveHandler(), { collection: "cmsPosts", id: "first", baseVersion: 2,
      document: { title: "Second published title" } });
    expect(edit.code, JSON.stringify(edit.body)).toBe(200);
    // A draft save is not public and leaves the cached reply in place.
    expect((await measured(cached, post("/posts/first-story/"))).reads).toBe(cache.VALIDATOR_PATHS.length);
    expect((await invoke(saveHandler(), { collection: "cmsPosts", id: "first", baseVersion: 3, publish: true, document: {} })).code).toBe(200);
    const republished = await measured(cached, post("/posts/first-story/"));
    expect(republished.body.receipt.sourceVersion).toBeGreaterThan(before.body.receipt.sourceVersion);
    expect(JSON.stringify(republished.body)).toContain("Second published title");

    const removal = await invoke(lifecycle.createCmsTransitionContentHandler({ firestore: db,
      requirePrincipalFn: async () => actor, log: quiet }), { collection: "cmsPosts", id: "first", baseVersion: 4, action: "unpublish" });
    expect(removal.code, JSON.stringify(removal.body)).toBe(200);
    const gone = await measured(cached, post("/posts/first-story/"));
    expect(gone.body.kind).toBe("gone");
    expect(JSON.stringify(gone.body)).not.toContain("Second published title");
  });

  it("applies the operator pause on the next request", async () => {
    expect((await invoke(saveHandler(), { collection: "cmsPosts", id: "first", baseVersion: 1, publish: true, document: {} })).code).toBe(200);
    const cached = content.createCmsGetPublicPageHandler({ firestore: db, log: quiet, decisionCache: cache.createPublicDecisionCache() });
    expect((await measured(cached, post("/posts/first-story/"))).body.kind).toBe("post");
    await db.doc("system/noBuildPostAdmission").update({ revision: 2, enabled: false });
    expect((await measured(cached, post("/posts/first-story/"))).reads).toBeGreaterThan(cache.VALIDATOR_PATHS.length);
  });
});
