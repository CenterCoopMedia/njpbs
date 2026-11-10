import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import deployment from "../../functions/lib/public-deployment.js";
import work from "../../functions/lib/public-release-pair-work.js";
import log from "../../functions/lib/public-release-change-log.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import protocol from "../../functions/lib/public-release-pair.js";
import producer from "../../functions/lib/public-release-producer.js";
import { captureOwnedPublicReleasePairInput, derivePublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { parsePublicReleasePairRenderPlan } from "../../site/scripts/public-release-pair-render-plan";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
const pair = releasePair();
const source = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8"));
const sourceId = source.document.id, operationId = "accepted-source";
let db: ReturnType<typeof isolatedFirestore>;
const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
const store: PairViewStore = {
  async put(key, bytes, options) {
    if (!objects.has(key)) objects.set(key, { bytes: new Uint8Array(bytes), metadata: { ...options.customMetadata } });
  },
  async get(key) {
    const object = objects.get(key);
    return object ? { size: object.bytes.byteLength, customMetadata: object.metadata,
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(object.bytes)); controller.close(); } }) } : null;
  },
};
const options = () => ({ firestore: db, pair, sourceOperationId: operationId, providerStore: store, store });
async function accept(id = operationId, snapshot = source.document.published, extra: any[] = []) {
  return db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId: id,
      changes: [{ kind: "post", id: sourceId, action: "publish", sourceVersion: snapshot.sourceVersion, snapshot }, ...extra] });
    write();
    transaction.set(db.doc(`cmsPosts/${sourceId}`), { ...source.document, version: snapshot.sourceVersion,
      published: snapshot, privateDraft: "Never frozen into a reader input" });
    transaction.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: snapshot.sourceVersion });
  });
}
beforeAll(() => { db = isolatedFirestore("public-release-source-owner.test.ts"); });
beforeEach(async () => {
  objects.clear();
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "fixture-release", activeCommitSha: pair.commitSha, lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture-release" });
  await work.registerPublicReleasePair({ firestore: db, pair });
  const head = log.initialPublicReleaseChangeHead("f".repeat(64));
  await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).set(head);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  const code = publicReleaseBaselineCodeFixture(db, pair.commitSha);
  await baseline.capturePublicReleaseChangeBaseline({ firestore: code.firestore, currentCodeRequest: code.request, logEpoch: "fixture-epoch" });
  await db.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL).set({ schemaVersion: 2, enabled: true, logEpoch: "fixture-epoch", pair: pairReference(pair), head });
});
it("derives the real accepted source, complete reader dependencies, immutable time and log cursor", async () => {
  await accept();
  const one = await derivePublicReleasePairInput(options()), two = await derivePublicReleasePairInput(options());
  expect(two.root).toEqual(one.root);
  const entry = (await db.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/0000000000000001`).get()).data()!;
  expect(one.root.source).toEqual({ kind: "post", id: sourceId });
  expect(one.root.scope).toMatchObject({ sourceOperationId: operationId, sourceVersion: 7, contextSequence: 1,
    snapshotDigest: entry.changes[0].snapshotDigest });
  expect(one.root.cursor).toEqual({ baselineDigest: "f".repeat(64), sequence: 1, lastDigest: entry.entryDigest });
  const read = JSON.parse(new TextDecoder().decode(one.files.get("routes/000000.json")!.bytes));
  expect(read.read).toMatchObject({ kind: "published-post", settings: [], navigationPages: [], authors: [], joinedRecords: [] });
  expect(read.read.document).not.toHaveProperty("privateDraft");
  expect(JSON.stringify(read)).not.toContain("Private working title");
  const plan = JSON.parse(new TextDecoder().decode(one.files.get("render-plan.json")!.bytes));
  expect(parsePublicReleasePairRenderPlan(plan, one.root).routes.map(route => route.path)).toEqual(["/posts/shadow-fixture/"]);
  for (const file of one.root.files) expect(file.digest).toBe(createHash("sha256").update(one.files.get(file.name)!.bytes).digest("hex"));
});
it("commits the original source binding with H's receipt and reopens it after later publication", async () => {
  await accept();
  const captured = await captureOwnedPublicReleasePairInput(options());
  expect(captured.idempotent).toBe(false);
  expect(captured.receipt.scope.snapshotDigest).not.toBe(captured.receipt.inputManifestDigest);
  const snapshot = { ...source.document.published, sourceVersion: 8,
    metadata: { ...source.document.published.metadata, title: "Later accepted content" } };
  await accept("later-source", snapshot);
  const replay = await captureOwnedPublicReleasePairInput(options());
  expect(replay.idempotent).toBe(true);
  expect(replay.receipt).toEqual(captured.receipt);
  await expect(derivePublicReleasePairInput(options())).rejects.toMatchObject({ code: "input-unavailable" });
});
it("refuses missing immutable evidence and a forged or superseded source before storing a pack", async () => {
  await accept();
  await db.doc(producer.publicReleaseMemberPath(operationId, "post", sourceId)).delete();
  await expect(captureOwnedPublicReleasePairInput(options())).rejects.toThrow();
  expect(objects.size).toBe(0);
  await expect(derivePublicReleasePairInput({ ...options(), sourceOperationId: "not-accepted" })).rejects.toThrow();
});
it("binds every member of a multi-record acceptance and refuses a missing dependency member", async () => {
  const media = { url: "https://media.njpbs.org/cms-media/news/one/hash.png", altText: "Public art", mimeType: "image/png", width: 1, height: 1 };
  await db.doc("media_assets_public/media-one").set(media);
  await accept(operationId, source.document.published, [{ kind: "media", id: "media-one", action: "dependency", sourceVersion: 2, snapshot: media, mediaSource: { source: "site_seed" } }]);
  // Multi-record dependency changes require the complete affected-site roster;
  // missing deployed Page/provider capabilities must refuse, never omit routes.
  await expect(derivePublicReleasePairInput(options())).rejects.toThrow();
  await db.doc(producer.publicReleaseMemberPath(operationId, "media", "media-one")).delete();
  await expect(derivePublicReleasePairInput(options())).rejects.toThrow();
  expect(objects.size).toBe(0);
});

it("captures every published and withdrawn member of one multi-Post transaction", async () => {
  const withdrawn = { ...source.document.published, sourceVersion: 3,
    metadata: { ...source.document.published.metadata, slug: "withdrawn-story" } };
  await db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId,
      changes: [
        { kind: "post", id: sourceId, action: "publish", sourceVersion: 7, snapshot: source.document.published },
        { kind: "post", id: "withdrawn-post", action: "withdraw", sourceVersion: 3, snapshot: withdrawn },
      ] });
    write();
    transaction.set(db.doc(`cmsPosts/${sourceId}`), { ...source.document, version: 7 });
    transaction.set(db.doc("cmsPosts/withdrawn-post"), { id: "withdrawn-post", version: 4, status: "draft", publiclyVisible: false, published: withdrawn });
    transaction.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 2 });
  });
  const frozen = await derivePublicReleasePairInput(options());
  expect(frozen.root.source).toEqual({ kind: "inventory", id: operationId });
  const plan = JSON.parse(new TextDecoder().decode(frozen.files.get("render-plan.json")!.bytes));
  expect(plan.expectedOutputs).toMatchObject([
    { path: "/posts/shadow-fixture/", status: 200 }, { path: "/posts/withdrawn-story/", status: 410 },
  ]);
  const snapshots = JSON.parse(new TextDecoder().decode(frozen.files.get("snapshot.json")!.bytes));
  expect(snapshots.map((member: any) => member.change.id)).toEqual([sourceId, "withdrawn-post"]);
  const withdrawnRoute = plan.routes.find((route: any) => route.path === "/posts/withdrawn-story/");
  expect(JSON.parse(new TextDecoder().decode(frozen.files.get(withdrawnRoute.inputFile)!.bytes)).read).toEqual({ kind: "withdrawn", path: "/posts/withdrawn-story/" });
});

it("derives redirects from retained aliases without changing the canonical Post input", async () => {
  const snapshot = { ...source.document.published,
    metadata: { ...source.document.published.metadata, previousSlugs: ["former-story"] } };
  await accept(operationId, snapshot);
  const frozen = await derivePublicReleasePairInput(options());
  const plan = JSON.parse(new TextDecoder().decode(frozen.files.get("render-plan.json")!.bytes));
  expect(plan.routes).toMatchObject([{ path: "/posts/former-story/", renderer: "redirect" },
    { path: "/posts/shadow-fixture/", renderer: "post" }]);
  const alias = JSON.parse(new TextDecoder().decode(frozen.files.get(plan.routes[0].inputFile)!.bytes));
  expect(alias.read).toEqual({ kind: "redirect", path: "/posts/former-story/", location: "/posts/shadow-fixture/" });
  expect(plan.expectedOutputs[0].status).toBe(308);
});

it("keeps the legacy operation identity available above the enrolled evidence bound", async () => {
  await db.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL).delete();
  const snapshot = { body: "x".repeat(850_000) };
  const id = producer.publicReleaseProducerOperation("post", sourceId, 1, snapshot);
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  await expect(db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction,
      operationId: id, changes: [{ kind: "post", id: sourceId, action: "publish", sourceVersion: 1, snapshot }] });
    write();
  })).resolves.toBeUndefined();
});

it.each(["page", "record"] as const)("derives the full deployed %s reader input with its original revision seal", async kind => {
  const { default: snapshots } = await import("../../functions/lib/publish-snapshot.js");
  const id = kind === "page" ? "contact" : "program-one", acceptedOperation = `accepted-${kind}`;
  const collection = kind === "page" ? "cmsPages" : "cmsPosts";
  const published = snapshots.createPublishedSnapshot({ collection, document: { id, version: 1,
    ...(kind === "record" ? { type: "program", slug: id, previousSlugs: ["former-program"], locale: "en", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Public program synopsis" }] }] } } : {}),
    title: "Public source", blocks: [] }, publishedAt: "2026-10-01T12:00:00.000Z", publishedBy: "editor" });
  await db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction,
      operationId: acceptedOperation, contextRevision: 7,
      changes: [{ kind, id, action: "publish", sourceVersion: 1, snapshot: published }] });
    write();
    transaction.set(db.doc(`${collection}/${id}`), { id, version: 1, status: "published", publiclyVisible: true,
      publishAt: published.publishedAt, published });
    transaction.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 7 });
  });
  const firestore = new Proxy(db, { get(target, key) {
    if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const frozen = await derivePublicReleasePairInput({ ...options(), firestore, sourceOperationId: acceptedOperation });
  const plan = JSON.parse(new TextDecoder().decode(frozen.files.get("render-plan.json")!.bytes));
  expect(plan.routes.length).toBe(kind === "page" ? 1 : 6);
  if (kind === "record") expect(plan.expectedOutputs.map((output: any) => ({ path: output.path, status: output.status }))).toEqual([
    { path: "/programs/", status: 200 }, { path: "/programs/former-program/", status: 200 }, { path: "/programs/program-one/", status: 200 },
    { path: "/shows/", status: 200 }, { path: "/shows/former-program/", status: 200 }, { path: "/shows/program-one/", status: 200 },
  ]);
  const envelope = JSON.parse(new TextDecoder().decode(frozen.files.get(plan.routes[0].inputFile)!.bytes));
  expect(envelope.read.kind).toBe(kind === "page" ? "published-page" : "published-record-family");
  expect(envelope.read.sourceSeal).toMatchObject({ rendererSha: pair.commitSha, contextRevision: 7 });
  expect(frozen.root.cursor.sequence).toBe(1);
});

it("does not capture unrelated Schedule inputs for a Post or Contact acceptance", async () => {
  // An unrelated published Schedule exists without a capability or packet. Its
  // RPC must not be contacted by these routes' complete dependency inventories.
  await db.doc("cmsPages/schedule").set({ published: { metadata: { slug: "schedule" } } });
  let requests = 0;
  const currentCodeRequest = async () => { requests++; throw new Error("Unrelated Schedule RPC unavailable"); };
  await accept();
  await expect(derivePublicReleasePairInput({ ...options(), currentCodeRequest })).resolves.toHaveProperty("root");
  const { default: snapshots } = await import("../../functions/lib/publish-snapshot.js");
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { id: "contact", version: 1,
    title: "Public Contact", blocks: [] }, publishedAt: "2026-10-01T12:00:00.000Z", publishedBy: "editor" });
  await db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId: "contact-acceptance", contextRevision: 8,
      changes: [{ kind: "page", id: "contact", action: "publish", sourceVersion: 1, snapshot: published }] });
    write(); transaction.set(db.doc("cmsPages/contact"), { version: 1, status: "published", publiclyVisible: true, publishAt: published.publishedAt, published });
    transaction.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 8 });
  });
  const firestore = developmentDb();
  await expect(derivePublicReleasePairInput({ ...options(), firestore, sourceOperationId: "contact-acceptance", currentCodeRequest })).resolves.toHaveProperty("root");
  expect(requests).toBe(0);
});
const developmentDb = () => new Proxy(db, { get(target, key) {
  if (key === "projectId") return "njpbs-site-dev";
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
} });
async function ownedHome(homeHero?: unknown) {
  const { default: snapshots } = await import("../../functions/lib/publish-snapshot.js");
  const { createHomeSourceSnapshot } = await import("../../site/src/lib/home-sources");
  const { readHomeEditorialSourceReceipt } = await import("../../packages/content-core/src/home-source-catalog");
  const fixture = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/home-v2-selections.json", import.meta.url), "utf8"));
  const media = JSON.parse(readFileSync(new URL("../../site/src/data/launch-media-manager.json", import.meta.url), "utf8"));
  const spotlight = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/home-sources/spotlight-feed.json", import.meta.url), "utf8"));
  const sources = { ...createHomeSourceSnapshot(media, spotlight, fixture.editorial.receipt), editorial: readHomeEditorialSourceReceipt(fixture.editorial) };
  const bytes = Buffer.from(JSON.stringify(sources)), digest = createHash("sha256").update(bytes).digest("hex");
  const key = `post-background-v1/home/retained-claim/${digest}`;
  objects.set(key, { bytes, metadata: {} });
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { ...JSON.parse(readFileSync(new URL("../../site/tests/fixtures/home-composition-v1.json", import.meta.url), "utf8")), version: 1,
    ...(homeHero ? { homeHero } : {}) }, publishedAt: "2026-10-01T12:00:00.000Z", publishedBy: "editor" });
  const owner = { schemaVersion: 1, pageId: "home", path: "/", ownedPaths: ["/", "/_home-sources.json"], operationId: "H".repeat(20),
    sourceVersion: 1, generation: 1, rendererSha: pair.commitSha, runtime: { owner: "cloudflare", release: pair.commitSha }, visible: true };
  await db.doc("cmsPages/home").set({ id: "home", version: 1, status: "published", publiclyVisible: true, publishAt: published.publishedAt, published });
  await db.doc("system/publicDeployment/noBuildPageOwners/home").set(owner);
  await db.doc("cmsBackgroundOutputs/home").set({ schemaVersion: 1, owner: "page-no-build-v1", pageId: "home",
    ownerPath: "system/publicDeployment/noBuildPageOwners/home", operationId: owner.operationId, retainedSource: {
      file: { path: "/_home-sources.json", key, digest, size: bytes.length, contentType: "application/json; charset=utf-8" },
      publication: sources.publication, catalogDigest: sources.editorial.receipt.digest } });
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
    families: { pages: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-artifacts" });
  return { owner, published };
}
it.each(["publish", "withdraw", "expired"])("refreshes frozen paired Home bytes for a pinned Page %s without publishing Home", async action => {
  await ownedHome({ mode: "tag", source: "cms_posts", value: "home", pins: [action === "expired"
    ? { source: "cms_posts", sourceId: "old-story", endsAt: "2026-10-01T12:00:00.000Z" }
    : { source: "cms_pages", sourceId: "contact" }] });
  const { default: snapshots } = await import("../../functions/lib/publish-snapshot.js");
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { title: "Published Contact", version: 1, blocks: [] },
    publishedAt: "2026-10-01T12:00:00.000Z", publishedBy: "PRIVATE actor" });
  const operationId = "pinned-page-change";
  await db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId, contextRevision: 2,
      changes: [{ kind: "page", id: "contact", action: action === "withdraw" ? "withdraw" : "publish", sourceVersion: 1, snapshot: published }] });
    write();
    transaction.set(db.doc("cmsPages/contact"), { version: 2, status: "draft", publiclyVisible: action !== "withdraw", published,
      title: "PRIVATE later draft" });
    transaction.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 2 });
  });
  const frozen = await derivePublicReleasePairInput({ ...options(), firestore: developmentDb(), sourceOperationId: operationId, resourceRequest: noRemoteImages });
  const plan = JSON.parse(new TextDecoder().decode(frozen.files.get("render-plan.json")!.bytes));
  expect(plan.expectedOutputs.map((output: any) => ({ path: output.path, status: output.status }))).toEqual([
    { path: "/", status: 200 }, { path: "/_home-sources.json", status: 200 }, { path: "/contact/", status: action === "withdraw" ? 410 : 200 },
  ]);
  const authority = JSON.parse(new TextDecoder().decode(frozen.files.get("authority.json")!.bytes));
  expect(authority.members).toEqual([{ change: authority.entry.changes[0],
    paths: ["/", "/_home-sources.json", "/contact/"], withdrawnPaths: action === "withdraw" ? ["/contact/"] : [] }]);
  const route = plan.routes.find((route: any) => route.path === "/");
  const envelope = JSON.parse(new TextDecoder().decode(frozen.files.get(route.inputFile)!.bytes));
  expect(envelope.read.page.sourceVersion).toBe(1);
  if (action === "publish") {
    expect(envelope.read.homeHeroPages).toHaveLength(1);
    expect(envelope.read.homeHeroPages[0].title).toBe("Published Contact");
  } else expect(envelope.read).not.toHaveProperty("homeHeroPages");
  expect(JSON.stringify(envelope)).not.toContain("PRIVATE");
});
it("preserves Home HTML and the refreshed JSON catalog as distinct owned outputs", async () => {
  const { published } = await ownedHome();
  await db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId: "H".repeat(20),
      changes: [{ kind: "page", id: "home", action: "publish", sourceVersion: 1, snapshot: published }] }); write();
    transaction.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 2 });
  });
  const result = await derivePublicReleasePairInput({ ...options(), firestore: developmentDb(), sourceOperationId: "H".repeat(20), resourceRequest: noRemoteImages });
  assertHomePlan(result);
});
const noRemoteImages = async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } });
it.each([false, true])("does not fetch unrelated Home CODE for a Post with another Home refresh %s", async anotherRefresh => {
  await ownedHome();
  await db.doc("cmsBackgroundOutputs/home").delete();
  if (anotherRefresh) await db.doc("system/publicDeployment/noBuildPageOwners/home").update({ homeRefresh: { sourceOperationId: "unrelated-publication" } });
  await accept();
  let requests = 0;
  const result = await derivePublicReleasePairInput({ ...options(), firestore: developmentDb(), resourceRequest: noRemoteImages,
    currentCodeRequest: async () => { requests++; throw new Error("Unrelated CODE transport must not run"); } });
  const plan = JSON.parse(new TextDecoder().decode(result.files.get("render-plan.json")!.bytes));
  expect(plan.expectedOutputs).toEqual([{ path: "/posts/shadow-fixture/", status: 200, contentType: "text/html; charset=utf-8" }]);
  expect(requests).toBe(0);
});
function assertHomePlan(result: Awaited<ReturnType<typeof derivePublicReleasePairInput>>) {
  const plan = JSON.parse(new TextDecoder().decode(result.files.get("render-plan.json")!.bytes));
  expect(plan.expectedOutputs).toContainEqual({ path: "/", status: 200, contentType: "text/html; charset=utf-8" });
  expect(plan.expectedOutputs).toContainEqual({ path: "/_home-sources.json", status: 200, contentType: "application/json; charset=utf-8" });
  const route = plan.routes.find((route: any) => route.path === "/_home-sources.json");
  expect(route.renderer).toBe("json");
  const envelope = JSON.parse(new TextDecoder().decode(result.files.get(route.inputFile)!.bytes));
  expect(envelope.read.editorial.catalog.sources["home-posts"].cards).toHaveLength(0);
  expect(envelope.read.publication.commitSha).toBe(pair.commitSha);
  expect(envelope.homeSourcesFile).toMatch(/^home\//);
}
it.each([true, false])("includes dependent Home outputs for Post visibility %s, without a shelf placement", async visible => {
  const { owner } = await ownedHome();
  const snapshot = source.document.published;
  await db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId,
      changes: [{ kind: "post", id: sourceId, action: visible ? "publish" : "withdraw", sourceVersion: snapshot.sourceVersion, snapshot }] });
    write();
    transaction.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 2 });
    transaction.set(db.doc(`cmsPosts/${sourceId}`), { ...source.document, version: snapshot.sourceVersion, publiclyVisible: visible, publishAt: snapshot.publishedAt, status: visible ? "published" : "draft" });
    transaction.set(db.doc("system/publicDeployment/noBuildPageOwners/home"), { ...owner, homeRefresh: {
      schemaVersion: 1, revision: 1, sourceOperationId: operationId, status: "pending", taskPath: `cmsPublishQueue/${operationId}/homePageRefresh/home` } });
    transaction.set(db.doc(`cmsPublishQueue/${operationId}/homePageRefresh/home`), { schemaVersion: 1, owner: "page-no-build-v1", pageId: "home", revision: 1,
      input: { sourceOperationId: operationId, homeOperationId: owner.operationId, homeSourceVersion: owner.sourceVersion,
        postId: sourceId, sourceVersion: snapshot.sourceVersion, visible } });
  });
  const result = await derivePublicReleasePairInput({ ...options(), firestore: developmentDb(), resourceRequest: noRemoteImages });
  const plan = JSON.parse(new TextDecoder().decode(result.files.get("render-plan.json")!.bytes));
  expect(plan.expectedOutputs).toEqual(expect.arrayContaining([
    { path: "/", status: 200, contentType: "text/html; charset=utf-8" },
    { path: "/_home-sources.json", status: 200, contentType: "application/json; charset=utf-8" },
    { path: "/posts/shadow-fixture/", status: visible ? 200 : 410, contentType: "text/html; charset=utf-8" },
  ]));
  const route = plan.routes.find((route: any) => route.path === "/_home-sources.json");
  const envelope = JSON.parse(new TextDecoder().decode(result.files.get(route.inputFile)!.bytes));
  expect(envelope.read.editorial.catalog.sources["home-posts"].cards).toHaveLength(visible ? 1 : 0);
  if (!visible) {
    await db.doc(`cmsPublishQueue/${operationId}/homePageRefresh/home`).delete();
    await expect(derivePublicReleasePairInput({ ...options(), firestore: developmentDb() })).rejects.toThrow();
  }
});

it("captures one Post by its accepted identity without scanning unrelated content or owners", async () => {
  await accept();
  const scans: string[] = [];
  const firestore = new Proxy(db, { get(target, key) {
    if (key === "collection") return (name: string) => {
      const collection = target.collection(name);
      return new Proxy(collection, { get(query, key) {
        if (key === "limit") return () => { scans.push(name); throw new Error("Unscoped collection scan"); };
        const value = Reflect.get(query, key); return typeof value === "function" ? value.bind(query) : value;
      } });
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const captured = await derivePublicReleasePairInput({ ...options(), firestore });
  expect(captured.root.source).toEqual({ kind: "post", id: sourceId });
  expect(scans).toEqual([]);
});

it("derives original reader provenance from the accepted registered pair for a different target", async () => {
  const targetPair = { ...releasePair("b", "b".repeat(40)), readerContractDigest: "c".repeat(64), readerReceiptDigest: "d".repeat(64) };
  await work.registerPublicReleasePair({ firestore: db, pair: targetPair });
  await accept();
  const frozen = await derivePublicReleasePairInput({ ...options(), pair: targetPair });
  const provenance = JSON.parse(new TextDecoder().decode(frozen.files.get("reader-provenance.json")!.bytes));
  expect(provenance).toEqual({ schemaVersion: 1, pair, rendererSha: pair.commitSha,
    readerContractDigest: pair.readerContractDigest, readerReceiptDigest: pair.readerReceiptDigest });
  expect(frozen.root.pairDigest).toBe(protocol.publicReleaseDigest(targetPair));
  const plan = JSON.parse(new TextDecoder().decode(frozen.files.get("render-plan.json")!.bytes));
  const sealed = frozen.root.files.find(file => file.name === "reader-provenance.json")!;
  for (const route of plan.routes) expect(route.dependencies).toContainEqual({ name: "reader-provenance.json", digest: sealed.digest });
});
it("refuses missing or changed original reader registration instead of using the target pair", async () => {
  const targetPair = releasePair("b", "b".repeat(40));
  await work.registerPublicReleasePair({ firestore: db, pair: targetPair });
  await accept();
  await db.doc(work.publicReleasePairPath(pair.pairId)).delete();
  await expect(derivePublicReleasePairInput({ ...options(), pair: targetPair })).rejects.toThrow();
  await db.doc(work.publicReleasePairPath(pair.pairId)).set({ ...pair, publicWorker: { ...pair.publicWorker, versionId: targetPair.publicWorker.versionId } });
  await expect(derivePublicReleasePairInput({ ...options(), pair: targetPair })).rejects.toThrow();
});
it("captures the same provenance file through H and reopens its original bytes", async () => {
  const targetPair = releasePair("b", "b".repeat(40));
  await work.registerPublicReleasePair({ firestore: db, pair: targetPair });
  await accept();
  const captured = await captureOwnedPublicReleasePairInput({ ...options(), pair: targetPair });
  const provenanceFile = captured.root.files.find(file => file.name === "reader-provenance.json")!;
  expect(provenanceFile).toBeDefined();
  const first = objects.get(provenanceFile.objectKey)!.bytes;
  await db.doc(work.publicReleasePairPath(pair.pairId)).delete();
  const reopened = await captureOwnedPublicReleasePairInput({ ...options(), pair: targetPair });
  expect(reopened.idempotent).toBe(true);
  expect(objects.get(provenanceFile.objectKey)!.bytes).toEqual(first);
  expect(reopened.receipt).toEqual(captured.receipt);
});

let activatedScheduleBoundary: Awaited<ReturnType<typeof backgroundStorageFixture>> | undefined;
afterAll(async () => { await activatedScheduleBoundary?.close(); });
it.each(["b", "a"])("binds exact activated reader incarnation for commit %s while preserving the old entry owner", async sourceCommit => {
  const { schedulePacketFixture } = await import("./page-schedule-packet-fixture");
  const activatedPair = releasePair("b", sourceCommit.repeat(40)), targetPair = releasePair("c", "c".repeat(40));
  await work.registerPublicReleasePair({ firestore: db, pair: activatedPair });
  await work.registerPublicReleasePair({ firestore: db, pair: targetPair });
  await ownedHome();
  const firestore = developmentDb();
  activatedScheduleBoundary ??= await backgroundStorageFixture("njpbs-dev-public-artifacts");
  const packet = await schedulePacketFixture({ firestore, rendererSha: activatedPair.commitSha, generation: 2, boundary: activatedScheduleBoundary });
  try {
    await db.doc("system/publicDeployment/noBuildPages/capability").update({ dataHubReportingVersion: 1 });
    const before = (await db.doc("system/publicDeployment").get()).data()!;
    const buildBatchId = packet.reference.publication.buildBatchId;
    const { default: coordinator } = await import("../../functions/lib/public-deployment-coordinator.js");
    await coordinator.publicWorkerCandidateRef(db, buildBatchId).set(packet.reference.publication);
    await db.doc(`cmsPreviewPublicContexts/${buildBatchId}`).set(packet.reference.manifest);
    await db.doc("system/publicDeployment").set({ ...before, state: "deploying", lastReservedGeneration: 2,
      newestEligibleGeneration: 2, newestEligibleBuildBatchId: buildBatchId,
      leaseToken: "55555555-5555-4555-8555-555555555555", leaseAcquiredAt: new Date(),
      candidateGeneration: 2, candidateBuildBatchId: buildBatchId, candidateCommitSha: activatedPair.commitSha,
      predecessorGeneration: 1, predecessorDeploymentId: before.activeDeploymentId, predecessorCommitSha: before.activeCommitSha });
    await db.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL).update({ activation: { buildBatchId, pair: pairReference(activatedPair) } });
    const sourceOperationId = "accepted-code-handover";
    await db.runTransaction(async transaction => {
      const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId: sourceOperationId,
        activation: { buildBatchId, commitSha: activatedPair.commitSha }, changes: [{ kind: "provider", id: "public-code",
          action: "dependency", sourceVersion: 2, snapshot: { commitSha: activatedPair.commitSha, generation: 2, deploymentId: "activated-code" } }] });
      write(); transaction.set(db.doc("system/publicDeployment"), { ...before, activeGeneration: 2, activeDeploymentId: "activated-code",
        activeCommitSha: activatedPair.commitSha, lastReservedGeneration: 2, newestEligibleGeneration: 2, newestEligibleBuildBatchId: buildBatchId });
      transaction.update(db.doc("system/publicDeployment/contexts/public"), { revision: 2 });
    });
    const providerStore: PairViewStore = { put: async () => { throw new Error("Read only"); }, async get(key) {
      const bytes = packet.boundary.objects.get(key);
      return bytes ? { size: bytes.length, body: new Response(new Uint8Array(bytes)).body! } : store.get(key);
    } };
    const captured = await derivePublicReleasePairInput({ ...options(), firestore, pair: targetPair, sourceOperationId, providerStore,
      currentCodeRequest: packet.request, resourceRequest: noRemoteImages });
    const provenance = JSON.parse(new TextDecoder().decode(captured.files.get("reader-provenance.json")!.bytes));
    expect(provenance).toEqual({ schemaVersion: 1, pair: activatedPair, rendererSha: activatedPair.commitSha,
      readerContractDigest: activatedPair.readerContractDigest, readerReceiptDigest: activatedPair.readerReceiptDigest });
    const authority = JSON.parse(new TextDecoder().decode(captured.files.get("authority.json")!.bytes));
    expect(authority.entry.pair).toEqual(pairReference(pair));
    const plan = JSON.parse(new TextDecoder().decode(captured.files.get("render-plan.json")!.bytes));
    const home = plan.routes.find((route: any) => route.path === "/");
    const read = JSON.parse(new TextDecoder().decode(captured.files.get(home.inputFile)!.bytes));
    expect(read.read.sourceSeal.rendererSha).toBe(activatedPair.commitSha);
    await db.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL).update({ head: log.initialPublicReleaseChangeHead("f".repeat(64)) });
    await expect(derivePublicReleasePairInput({ ...options(), firestore, pair: targetPair, sourceOperationId, providerStore,
      currentCodeRequest: packet.request })).rejects.toThrow();
  } finally { await packet.close(); }
});
