import { beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch } from "../helpers/public-release-switch.js";
import p from "../../functions/lib/public-release-pair.js";
import a from "../../functions/lib/public-release-admission.js";
import media from "../../functions/lib/media-contract.js";
import posts from "../../functions/lib/no-build-post-publication.js";
import pages from "../../functions/lib/no-build-page-publication.js";
import records from "../../functions/lib/no-build-record-publication.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import pageContext from "../../functions/lib/no-build-page-render-context.js";
import postReader from "../../functions/published-post-reader.js";
import recordSource from "../../functions/lib/no-build-record-source.js";
import settings from "../../functions/lib/settings-publication.js";
import contexts from "../../functions/lib/public-context-publication.js";
import revisions from "../../functions/lib/public-context-revision.js";
import deployment from "../../functions/lib/public-deployment.js";
import { chromeSettings } from "../../site/tests/fixtures/shadow-posts/chrome";
import homeFixture from "../../site/tests/fixtures/home-composition-v1.json";
import { recordDocument, asset } from "../../site/tests/fixtures/published-records/fixtures";
const post = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8")).document;
const contract = { schemaVersion: 2, families: ["posts", "pages", "programs", "events", "settings", "context"], features: [] };
let db: ReturnType<typeof isolatedFirestore>, firestore: typeof db;
const operationId = "A".repeat(20), actor = { uid: "pair-editor" };
const state = async (path: string) => (await db.doc(path).get()).data();
beforeAll(() => {
  db = isolatedFirestore("public-release-family-admission.test.ts");
  firestore = new Proxy(db, { get(target, key) { if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await seedSwitch(firestore, { admittedContract: contract });
  await db.doc(`${a.CONTRACTS}/${p.publicReleaseDigest(contract)}`).set(contract);
  await db.doc(`${a.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, enabled: true, revision: 1,
    backgroundBucket: "njpbs-dev-public-artifacts", families: { posts: { mode: "all" }, pages: { mode: "all" }, programs: { mode: "all" }, events: { mode: "all" } } });
});
function pageDocument() {
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { id: "contact", version: 1, title: "Contact", previousSlugs: ["former-contact"], blocks: [] },
    publishedAt: "2026-10-12T12:00:00.000Z", publishedBy: actor.uid });
  return { id: "contact", version: 1, status: "published", publiclyVisible: true, publishAt: published.publishedAt, published };
}
async function accept(kind: string, nextDocument: any, documentId: string, id = operationId) {
  return db.runTransaction(async transaction => {
    const fn = kind === "post" ? posts.preparePairPostPublication : kind === "page" ? pages.preparePairPagePublication : records.preparePairRecordPublication;
    const prepared = await fn({ firestore, transaction, documentId, nextDocument, queueRef: db.doc(`cmsPublishQueue/${id}`), actor,
      target: (await import("../../functions/lib/publication-target.js")).default.publicationTarget("development") });
    if (!prepared.idempotent) { prepared.write(); transaction.set(db.doc(`${kind === "page" ? "cmsPages" : "cmsPosts"}/${documentId}`), nextDocument); }
    return prepared;
  });
}
it("admits a real Post source through the original dependency validator and retains its exact snapshot in the outbox", async () => {
  const document = { ...post, version: post.published.sourceVersion };
  const prepared = await accept("post", document, post.id);
  expect(prepared.transport).toBe(a.TRANSPORT);
  expect(await state(`system/publicDeployment/noBuildPostOwners/${post.id}`)).toMatchObject({ operationId, snapshotDigest: p.publicReleaseDigest(post.published), visible: true });
  expect(await state(`cmsPublishQueue/${operationId}`)).toMatchObject({ transport: a.TRANSPORT, familyPublication: { kind: "post", id: post.id } });
  expect((await accept("post", document, post.id)).idempotent).toBe(true);
});
it("admits a real Page and retains canonical and former route ownership", async () => {
  const document = pageDocument(), prepared = await accept("page", document, "contact");
  expect(prepared.operation.ownedPaths).toContain("/former-contact/");
  expect(await state("system/publicDeployment/noBuildPageOwners/contact")).toMatchObject({ operationId, visible: true });
  expect((await db.collection("system/publicDeployment/noBuildPageRoutes").get()).size).toBeGreaterThan(1);
});
it("admits a real PDF notice Page while preserving document-slot media requirements", async () => {
  const pdf = { lifecycle: "active", source: "upload", url: "https://media.njpbs.org/cms-media/notice.pdf",
    mimeType: "application/pdf", altText: null, width: null, height: null };
  await db.doc("media_assets/pdf-notice").set(pdf);
  await db.doc("media_assets_public/pdf-notice").set(media.mediaProjection(pdf));
  const document = pageDocument();
  document.published.blocks = [{ id: "notices", type: "document_list", order: 0, visible: true,
    data: { documents: [{ itemId: "notice", assetId: "pdf-notice", title: "Meeting notice", addedAt: "2026-10-07T12:00:00.000Z" }] } }];
  expect((await accept("page", document, "contact")).transport).toBe(a.TRANSPORT);
  expect(await state("system/publicDeployment/noBuildPageOwners/contact")).toMatchObject({ operationId, visible: true });
  expect(await state(`cmsPublishQueue/${operationId}`)).toMatchObject({ status: "pending", familyPublication: { kind: "page" } });
});
it("retires a legacy Post predecessor and its reserved Home build without settling pair work", async () => {
  const document = { ...post, version: post.published.sourceVersion };
  await accept("post", document, post.id);
  const legacy = "L".repeat(20), home = "H".repeat(20);
  await db.doc(`system/publicDeployment/noBuildPostOwners/${post.id}`).update({ operationId: legacy });
  await db.doc(`cmsPublishQueue/${legacy}`).set({ transport: "post-no-build-v1", status: "pending", claim: "old-claim", nextAttemptAt: 1,
    homeFullBuild: { sourceOperationId: legacy, queueId: home, status: "reserved" } });
  await db.doc(`cmsPublishQueue/${home}`).set({ transport: "serializer", status: "reserved", homeFullBuild: { sourceOperationId: legacy } });
  const next = { ...document, version: document.version + 1, published: { ...document.published, sourceVersion: document.version + 1 } };
  await accept("post", next, post.id, "B".repeat(20));
  expect(await state(`cmsPublishQueue/${legacy}`)).toMatchObject({ status: "cancelled", claim: null, nextAttemptAt: null, homeFullBuild: { status: "superseded" } });
  expect(await state(`cmsPublishQueue/${home}`)).toMatchObject({ status: "superseded" });
  expect(await state(`cmsPublishQueue/${operationId}`)).toMatchObject({ status: "pending", terminalReceipt: null });
});
it("refuses a retained static Post and leaves its owner and source unchanged", async () => {
  const document = { ...post, version: post.published.sourceVersion };
  await accept("post", document, post.id);
  const ownerRef = db.doc(`system/publicDeployment/noBuildPostOwners/${post.id}`), owner = (await ownerRef.get()).data()!;
  const input = Object.fromEntries(["schemaVersion", "postId", "operationId", "sourceVersion", "visible", "slug", "ownedSlugs", "snapshotDigest", "contextDigest"]
    .map(key => [key, owner[key]]));
  const paths = ["/posts/", `/posts/${owner.slug}/`, "/feeds/news.xml", "/api/v1/content.json", "/pagefind/pagefind.js",
    "/search/meaning-index.json", "/_publication.json", "/_content-status.json", "/sitemap.xml"];
  await ownerRef.update({ mode: "static", servingEnabled: false, staticProof: { ...input, files: paths.map(path => ({ path, bytes: 1, digest: "f".repeat(64) })) } });
  const before = (await ownerRef.get()).data();
  const next = { ...document, version: document.version + 1, published: { ...document.published, sourceVersion: document.version + 1 } };
  await expect(accept("post", next, post.id, "B".repeat(20))).rejects.toThrow("retained static Post");
  expect((await ownerRef.get()).data()).toEqual(before);
  expect(await state(`cmsPosts/${post.id}`)).toEqual(document);
});
it("accepts an owned bootstrap Page withdrawal with paused admission before any pair operation exists", async () => {
  const document = pageDocument();
  await db.doc("cmsPages/contact").set(document);
  await db.doc("system/publicDeployment/noBuildPageOwners/contact").set({ schemaVersion: 1, pageId: "contact", operationId: "L".repeat(20),
    sourceVersion: 1, snapshotDigest: p.publicReleaseDigest(document.published), generation: 7, path: "/contact/", ownedPaths: ["/contact/", "/former-contact/"],
    visible: true, rendererSha: "a".repeat(40), servingEnabled: true, runtime: { owner: "cloudflare", release: "a".repeat(40) } });
  await db.doc(`cmsPublishQueue/${"L".repeat(20)}`).set({ transport: "page-no-build-v1", status: "pending", claim: "legacy-claim", nextAttemptAt: 1,
    noBuildPage: { operationId: "L".repeat(20), pageId: "contact", sourceVersion: 1, snapshotDigest: p.publicReleaseDigest(document.published) },
    backgroundRuntime: { owner: "cloudflare", release: "a".repeat(40) } });
  await db.doc("system/noBuildPostAdmission").update({ enabled: false, families: {} });
  await accept("page", { ...document, version: 2, publiclyVisible: false, status: "draft" }, "contact");
  expect(await state("system/publicDeployment/noBuildPageOwners/contact")).toMatchObject({ visible: false, durableWithdrawal: { operationId } });
  expect(await state(`cmsPublishQueue/${"L".repeat(20)}`)).toMatchObject({ status: "cancelled", claim: null, nextAttemptAt: null });
});
it("withdraws a bootstrap Post retained in the original single-state owner while admission is paused", async () => {
  const document = { ...post, version: post.published.sourceVersion };
  await db.doc(`cmsPosts/${post.id}`).set(document);
  const path = "system/publicDeployment/noBuildPosts/current";
  await db.doc(path).set({ schemaVersion: 1, postId: post.id, operationId: "L".repeat(20), sourceVersion: document.version,
    snapshotDigest: p.publicReleaseDigest(document.published), generation: 7, slug: document.published.metadata.slug,
    ownedSlugs: [document.published.metadata.slug], visible: true, rendererSha: "a".repeat(40), servingEnabled: true,
    runtime: { owner: "cloudflare", release: "a".repeat(40) } });
  await db.doc("system/noBuildPostAdmission").update({ enabled: false, families: {} });
  await accept("post", { ...document, version: document.version + 1, publiclyVisible: false, status: "draft" }, post.id);
  expect(await state(path)).toMatchObject({ visible: false, operationId });
  expect((await db.doc(`system/publicDeployment/noBuildPostOwners/${post.id}`).get()).exists).toBe(false);
});
it.each(["post", "page"])("removes a later-release %s figure seal when republishing a nonfigure snapshot", async kind => {
  const document = kind === "post" ? { ...post, version: post.published.sourceVersion } : pageDocument();
  const id = kind === "post" ? post.id : "contact", owner = `system/publicDeployment/${kind === "post" ? "noBuildPostOwners" : "noBuildPageOwners"}/${id}`;
  await accept(kind, document, id);
  const figures = { figures: [], releases: [] }, sealed = { ...document.published, datasetFigures: figures };
  await db.doc(`${kind === "post" ? "cmsPosts" : "cmsPages"}/${id}`).update({ published: sealed });
  await db.doc(owner).update({ snapshotDigest: p.publicReleaseDigest(sealed), datasetFiguresDigest: p.publicReleaseDigest(figures) });
  const next = { ...document, version: document.version + 1, published: { ...document.published, sourceVersion: document.version + 1 } };
  await accept(kind, next, id, "B".repeat(20));
  expect(await state(owner)).not.toHaveProperty("datasetFiguresDigest");
  expect(await state(owner)).toMatchObject({ snapshotDigest: p.publicReleaseDigest(next.published) });
});
it("refuses an exact stored Home withdrawal before any acceptance or route writes", async () => {
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: homeFixture,
    publishedAt: "2026-10-12T12:00:00.000Z", publishedBy: actor.uid });
  const document = { ...homeFixture, publiclyVisible: true, published };
  await db.doc("cmsPages/home").set(document);
  await expect(accept("page", { ...document, version: document.version + 1, publiclyVisible: false }, "home")).rejects.toThrow("homepage can't be unpublished");
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).empty).toBe(true);
});
it("uses the schema-two media fence for uploaded Post inputs while retaining the strict legacy writer fence", async () => {
  const art = { lifecycle: "active", source: "upload", url: asset.url, mimeType: asset.mimeType, width: asset.width, height: asset.height, altText: "Post art" };
  await db.doc(`media_assets/${asset.id}`).set(art); await db.doc(`media_assets_public/${asset.id}`).set(media.mediaProjection(art));
  const document = { ...post, version: post.published.sourceVersion, published: { ...post.published,
    metadata: { ...post.published.metadata, leadMedia: { kind: "image", data: { assetId: asset.id, alt: "Post art" } } }, blocks: [...post.published.blocks,
    { id: "pair-image", type: "image", order: 10, visible: true, data: { assetId: asset.id, alt: "Post art" } }] } };
  await accept("post", document, post.id);
  const selector = await state("system/publicDeployment");
  const mediaUsage = (await import("../../functions/lib/media-usage.js")).default;
  const prepareUsage = (releaseSelector?: unknown) => db.runTransaction(transaction => mediaUsage.prepareMediaUsageWrite({
    firestore, transaction, collection: "cmsPosts", documentId: post.id, state: "published", sourceVersion: document.version,
    usage: { assetIds: [asset.id], occurrenceCount: 1 }, releaseSelector }));
  await expect(prepareUsage()).rejects.toMatchObject({ code: "media_publication_unavailable" });
  expect(await prepareUsage(selector)).toMatchObject({ document: { assetIds: [asset.id], state: "published" } });
  const options = { firestore, slug: document.published.metadata.slug, now: new Date(document.published.publishedAt) };
  expect(() => deployment.assertMediaLifecycleDeploymentFence(selector)).toThrow();
  expect((await postReader.readPublishedPost({ ...options, releaseSelector: selector })).kind).toBe("published-post");
  const cards = () => db.runTransaction(transaction => postReader.readPublishedHomePostCards({ firestore, transaction,
    slugs: [document.published.metadata.slug], now: options.now, releaseSelector: selector }));
  expect((await cards())[0].kind).toBe("published-post-card");
  const usage = (transaction: any) => mediaUsage.prepareMediaUsageWrite({ firestore, transaction, collection: "cmsPosts",
    documentId: post.id, state: "published", sourceVersion: document.version, usage: { assetIds: [asset.id], occurrenceCount: 1 }, releaseSelector: selector });
  const withFenceError = (transaction: any, error: Error) => new Proxy(transaction, { get(owner, field) {
    if (field === "getAll") return (...refs: any[]) => {
      if (refs.some(ref => ref.path === "system/publicDeployment/pairMedia/current")) throw error;
      return owner.getAll(...refs);
    };
    const value = Reflect.get(owner, field); return typeof value === "function" ? value.bind(owner) : value;
  } });
  for (const code of [9, 14]) {
    const failure = Object.assign(new Error("Emulated media-fence SDK read failure"), { code });
    const attempt = (read: (transaction: any) => Promise<unknown>) => db.runTransaction(transaction =>
      read(withFenceError(transaction, failure)), { maxAttempts: 1 });
    await expect(attempt(transaction => postReader.readPublishedPost({ ...options, transaction, releaseSelector: selector }))).rejects.toBe(failure);
    await expect(attempt(transaction => postReader.readPublishedHomePostCards({ firestore, transaction,
      slugs: [document.published.metadata.slug], now: options.now, releaseSelector: selector }))).rejects.toBe(failure);
    await expect(attempt(usage)).rejects.toBe(failure);
  }
  let attempts = 0;
  const retried = await db.runTransaction(transaction => usage(++attempts === 1
    ? withFenceError(transaction, Object.assign(new Error("Emulated contention"), { code: 10 })) : transaction), { maxAttempts: 2 });
  expect(attempts).toBe(2);
  expect(retried.document.assetIds).toEqual([asset.id]);
  await db.doc("system/publicDeployment/pairMedia/current").update({ epoch: 50 });
  await expect(cards()).rejects.toMatchObject({ readerCode: "reader_media_fence" });
  await expect(prepareUsage(selector)).rejects.toMatchObject({ code: "media_publication_unavailable" });
  await expect(postReader.readPublishedPost({ ...options, releaseSelector: selector })).rejects.toThrow();
});
it("accepts settings and provider context with their own atomic source mutation and original outbox identity", async () => {
  const setting = chromeSettings()[1];
  await db.runTransaction(async transaction => {
    const prepared = await settings.preparePairSettingsPublication({ firestore, transaction, id: setting.id, published: setting.published, actor });
    prepared.write(); transaction.set(db.doc(`cmsSettings/${setting.id}`), setting); revisions.bumpPublicContextRevision(transaction, db);
  });
  const change = { kind: "provider", id: "external", action: "dependency", sourceVersion: 1, snapshot: { revision: "sealed-provider" } };
  await db.runTransaction(async transaction => {
    const prepared = await contexts.preparePairContextPublication({ firestore, transaction, operationId: "C".repeat(20), change });
    prepared.write(); transaction.set(db.doc(revisions.PUBLIC_CONTEXT_PATH), { externalInputs: change.snapshot }, { merge: true });
  });
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).size).toBe(2);
  expect(await state(revisions.PUBLIC_CONTEXT_PATH)).toMatchObject({ revision: 14, externalInputs: change.snapshot });
});
it("keeps the actual pair media fence for implicit Page reads with uploaded joined art", async () => {
  const original = recordDocument("program", "program-one");
  await db.doc("cmsPosts/program-one").set({ ...original, version: original.published.sourceVersion,
    publicSourceVersion: original.published.sourceVersion });
  const art = { lifecycle: "active", source: "upload", url: asset.url, mimeType: asset.mimeType,
    width: asset.width, height: asset.height, altText: "Program art" };
  await db.doc(`media_assets/${asset.id}`).set(art); await db.doc(`media_assets_public/${asset.id}`).set(media.mediaProjection(art));
  const document = pageDocument();
  document.published.blocks = [{ id: "joined-program", type: "record_card", order: 0, visible: true,
    data: { recordKind: "program", recordId: "program-one" } }];
  await db.doc("cmsPages/contact").set(document);
  const read = () => db.runTransaction(transaction => pageContext.assertNoBuildPageContextInTransaction({ firestore, transaction,
    pageId: "contact", rendererSha: "a".repeat(40), now: new Date(document.published.publishedAt) }));
  expect((await read()).assets.map((value: { id: string }) => value.id)).toContain(asset.id);
  await db.doc("system/publicDeployment/pairMedia/current").update({ epoch: 50 });
  await expect(read()).rejects.toThrow();
});
it("omits optional Home newsletter upload art when implicit reads find a changed pair media fence", async () => {
  const approved = { type: "newsletter", status: "approved", version: 2, title: "Public newsletter",
    signupUrl: "https://example.test/signup/", summary: "Public newsletter summary", imageAssetId: asset.id, imageAlt: "Newsletter art" };
  await db.doc("cmsPosts/newsletter-one").set({ ...approved, version: 3, status: "draft" });
  await db.doc("cmsVersionHistory/newsletter-approval").set({ collection: "cmsPosts", documentId: "newsletter-one", action: "approve", after: approved });
  const art = { lifecycle: "active", source: "upload", url: asset.url, mimeType: asset.mimeType,
    width: asset.width, height: asset.height, altText: "Newsletter art" };
  await db.doc(`media_assets/${asset.id}`).set(art); await db.doc(`media_assets_public/${asset.id}`).set(media.mediaProjection(art));
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: homeFixture,
    publishedAt: "2026-10-12T12:00:00.000Z", publishedBy: actor.uid });
  await db.doc("cmsPages/home").set({ ...homeFixture, publiclyVisible: true, published });
  const read = (unavailable = false) => db.runTransaction(transaction => {
    const reader = unavailable ? new Proxy(transaction, { get(owner, field) {
      if (field === "getAll") return (...refs: any[]) => {
        if (refs.some(ref => ref.path === "system/publicDeployment/pairMedia/current"))
          throw Object.assign(new Error("Emulated transient fence read failure"), { code: 14 });
        return owner.getAll(...refs);
      };
      const value = Reflect.get(owner, field); return typeof value === "function" ? value.bind(owner) : value;
    } }) : transaction;
    return pageContext.assertNoBuildPageContextInTransaction({ firestore, transaction: reader,
      pageId: "home", rendererSha: "a".repeat(40), now: new Date(published.publishedAt) });
  });
  expect((await read()).homeNewsletters.assets.map((value: { id: string }) => value.id)).toContain(asset.id);
  expect((await read(true)).homeNewsletters).toEqual({ status: "error" });
  await db.doc("system/publicDeployment/pairMedia/current").update({ epoch: 50 });
  expect((await read()).homeNewsletters.assets).toEqual([]);
});
it("admits a real Program under schema two and validates uploaded art against pair media counters", async () => {
  const original = recordDocument("program", "program-one");
  const document = { ...original, version: original.published.sourceVersion, published: { ...original.published, blocks: [], publishedBy: actor.uid } };
  const art = { ...asset, lifecycle: "active", source: "upload", storage: { provider: "r2", bucket: "njpbs-media", key: "cms-media/record-art/fixture.gif" }, altText: "Program art" };
  await db.doc(`media_assets/${asset.id}`).set(art);
  await db.doc(`media_assets_public/${asset.id}`).set(media.mediaProjection(art));
  const prepared = await accept("record", document, "program-one");
  expect(prepared.transport).toBe(a.TRANSPORT);
  expect(await state("system/publicDeployment/noBuildRecordOwners/program-one")).toMatchObject({ operationId, family: "programs", visible: true });
  // A legacy confirmation queue is retired at the same adoption commit.
  await db.doc("system/publicDeployment/noBuildRecordOwners/program-one").update({ operationId: "L".repeat(20) });
  await db.doc(`cmsPublishQueue/${"L".repeat(20)}`).set({ transport: "public-context-no-build-v1", recordConfirmationPendingAt: new Date() });
  const next = { ...document, version: document.version + 1, published: { ...document.published, sourceVersion: document.version + 1 } };
  await accept("record", next, "program-one", "B".repeat(20));
  expect(await state(`cmsPublishQueue/${"L".repeat(20)}`)).not.toHaveProperty("recordConfirmationPendingAt");
  expect(await state(`cmsPublishQueue/${operationId}`)).toMatchObject({ status: "pending", terminalReceipt: null });
});
it.each(["missing", "future"])("refuses a visible record with %s publishAt when the actual family input omits it", async mode => {
  const original = recordDocument("program", "program-one");
  const document = { ...original, status: "published", version: original.published.sourceVersion,
    published: { ...original.published, blocks: [], publishedBy: actor.uid },
    ...(mode === "future" ? { publishAt: "2027-01-01T12:00:00.000Z" } : {}) };
  const art = { lifecycle: "active", source: "site_seed", url: asset.url, mimeType: asset.mimeType,
    width: asset.width, height: asset.height, altText: "Program art" };
  await db.doc(`media_assets/${asset.id}`).set(art); await db.doc(`media_assets_public/${asset.id}`).set(media.mediaProjection(art));
  await expect(accept("record", document, "program-one")).rejects.toThrow();
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).empty).toBe(true);
  expect((await db.collection("system/publicDeployment/noBuildRecordOwners").get()).empty).toBe(true);
});
it("refuses a changed media epoch or explicit selector and keeps legacy media writes fenced", async () => {
  const selector = await state("system/publicDeployment"), document = pageDocument();
  expect(() => deployment.assertMediaLifecycleDeploymentFence(selector)).toThrow();
  await expect(db.runTransaction(transaction => recordSource.readPendingRecordFamilyInTransaction({ firestore, transaction,
    family: "events", rendererSha: selector!.activeCommitSha, releaseSelector: { ...selector, epoch: 9 } }))).rejects.toThrow();
  await expect(db.runTransaction(transaction => pageContext.assertNoBuildPageContextInTransaction({ firestore, transaction,
    pageId: "contact", nextDocument: document, rendererSha: selector!.activeCommitSha, releaseSelector: { ...selector, epoch: 9 },
    now: new Date(document.published.publishedAt) }))).rejects.toThrow();
  const guard = (await import("../../functions/lib/public-release-media-fence.js")).default;
  await db.doc("system/publicDeployment/pairMedia/current").update({ epoch: 9 });
  await expect(db.runTransaction(transaction => guard.assertPairMediaFenceInTransaction({ firestore, transaction, selector }))).rejects.toThrow();
});
