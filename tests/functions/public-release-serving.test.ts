import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import serving from "../../functions/lib/public-release-serving.js";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import pages from "../../functions/lib/no-build-page-ownership.js";
import records from "../../functions/lib/no-build-record-ownership.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import context from "../../functions/lib/public-context-revision.js";
import { releasePair, releaseSelector, pairReference } from "../helpers/private-public-release-pair.js";
import { pageDocument } from "./fixtures/home-decision-3441.js";
import { recordDocument } from "../../site/tests/fixtures/published-records/fixtures";
const pair = releasePair(), other = releasePair("b", "b".repeat(40)), base = work.publicReleasePairPath(pair.pairId), operationId = "O".repeat(20);
let app: ReturnType<typeof initializeApp>, db: Firestore;
const identity = { schemaVersion: 2, pair: pairReference(), kind: "qualification", sourceOperationId: operationId,
  sourceVersion: 7, snapshotDigest: "d".repeat(64), contextSequence: 0, inputManifestDigest: "e".repeat(64) };
const claimDigest = "f".repeat(64), cursor = { baselineDigest: "1".repeat(64), sequence: 0, lastDigest: "1".repeat(64) };
const request = (path = "/contact/", readStartedAt = Date.now()) => ({ firestore: db, environment: "development" as const,
  pair, path, selection: { environment: "development" as const, selector: releaseSelector(), readStartedAt } });
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Use a loopback Firestore emulator");
  app = initializeApp({ projectId: "demo-layer4-serving" }, "layer4-serving"); db = getFirestore(app);
});
afterAll(async () => { await deleteApp(app); });
beforeEach(async () => {
  await db.recursiveDelete(db.collection("system")); await db.recursiveDelete(db.collection("cmsPages")); await db.recursiveDelete(db.collection("cmsPosts"));
  const selector = releaseSelector();
  const batch = db.batch();
  batch.set(db.doc("system/publicDeployment"), selector);
  batch.set(db.doc(base), pair); batch.set(db.doc(`${base}/controls/runtime`), { schemaVersion: 2, pairId: pair.pairId, status: "retained" });
  batch.set(db.doc(`${base}/heads/current`), { schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), contentHead: selector.contentHead });
  batch.set(db.doc("system/publicReleaseChanges"), { schemaVersion: 2, ...cursor });
  batch.set(db.doc(`${base}/views/${selector.contentHead.manifestDigest}`), { schemaVersion: 2, status: "staged", pairDigest: protocol.publicReleaseDigest(pair),
    taskId: protocol.publicReleaseDigest(identity), identity, claimDigest, cursor, manifestDigest: selector.contentHead.manifestDigest,
    manifestBytes: 500, manifestKey: `release-pairs/${pair.pairId}/${protocol.publicReleaseDigest(identity)}/claims/${claimDigest}/views/${selector.contentHead.manifestDigest}.json` });
  batch.set(db.doc(`${base}/renderTargets/${selector.contentHead.manifestDigest}`), { schemaVersion: 1, status: "staged", pairDigest: protocol.publicReleaseDigest(pair),
    identity, taskId: protocol.publicReleaseDigest(identity), claimDigest, viewManifestDigest: selector.contentHead.manifestDigest,
    inputManifestDigest: identity.inputManifestDigest, snapshotDigest: identity.snapshotDigest, cursor, targetCount: 1,
    descriptor: { digest: "2".repeat(64), bytes: 500, key: `release-pairs/${pair.pairId}/${protocol.publicReleaseDigest(identity)}/claims/${claimDigest}/objects/${"2".repeat(64)}` } });
  const document = pageDocument();
  const state = { schemaVersion: 1, pageId: "contact", rendererSha: pair.commitSha, servingEnabled: true, generation: 7,
    operationId, sourceVersion: document.published.sourceVersion, visible: true, path: "/contact/", ownedPaths: ["/contact/", "/former-contact/"],
    snapshotDigest: pages.digest(document.published), runtime: { owner: "cloudflare", release: pair.commitSha } };
  batch.set(db.doc("cmsPages/contact"), document); batch.set(db.doc(`${pages.PAGE_OWNER_COLLECTION}/contact`), state);
  for (const path of state.ownedPaths) batch.set(pages.pageRouteRef(db, path), { schemaVersion: 1, pageId: "contact", path });
  await batch.commit();
});
it("accepts a bounded retained OLD request after a switch while checking current content", async () => {
  const old = releaseSelector(), current = { ...old, epoch: 2, activeCommitSha: other.commitSha, selectedPair: old.recoveryPair,
    recoveryPair: old.selectedPair, switchOperationId: "switch-two", contentHead: { ...old.contentHead, pairId: other.pairId } };
  await db.doc("system/publicDeployment").set(current);
  await db.doc(`system/publicDeployment/switchReceipts/${old.switchOperationId}`).set({ schemaVersion: 2, operationId: old.switchOperationId,
    attemptDigest: "a".repeat(64), selectorDigest: protocol.publicReleaseDigest(old), selector: old });
  const result = await serving.readPublicReleaseDecision(request());
  expect(result.kind).toBe("decision"); if (result.kind !== "decision") return;
  expect(result.epoch).toBe(1); expect(result.route.kind).toBe("serve"); expect(result.pairId).toBe(pair.pairId);
  expect(await serving.readPublicReleaseDecision(request("/contact/", Date.now() - 5001))).toEqual({ kind: "reselect" });
  await db.doc(`${base}/controls/runtime`).update({ status: "retired" });
  await expect(serving.readPublicReleaseDecision(request())).rejects.toThrow();
});
it("refuses absent or forged committed epoch provenance", async () => {
  const selector = releaseSelector(); await db.doc("system/publicDeployment").update({ epoch: 2 });
  await expect(serving.readPublicReleaseDecision(request())).rejects.toThrow();
  await db.doc(`system/publicDeployment/switchReceipts/${selector.switchOperationId}`).set({ schemaVersion: 2, operationId: selector.switchOperationId,
    selectorDigest: "0".repeat(64), selector });
  await expect(serving.readPublicReleaseDecision(request())).rejects.toThrow();
});
it("ignores accepted log suffixes above the activated head and refuses candidate/foreign versions", async () => {
  // The actual activated root, not the accepted log high-water,
  // is the serving commit point. Actual admission/switch transactions are
  // covered separately in public-release-activated-serving.test.ts.
  await db.doc("system/publicReleaseChanges").update({ sequence: 1, lastDigest: "2".repeat(64) });
  const result = await serving.readPublicReleaseDecision(request());
  expect(result.kind).toBe("decision");
  expect(result.contentHead).toEqual(releaseSelector().contentHead);
  await db.doc(`${base}/controls/runtime`).update({ status: "candidate" });
  await expect(serving.readPublicReleaseDecision(request())).rejects.toThrow();
  await expect(serving.readPublicReleaseDecision({ ...request(), pair: other })).rejects.toThrow();
});
it("rechecks current snapshots and keeps aliases and withdrawals authoritative across code epochs", async () => {
  const result = await serving.readPublicReleaseDecision(request("/former-contact/"));
  expect(result.kind === "decision" && result.route.kind).toBe("redirect");
  await db.doc("cmsPages/contact").update({ publiclyVisible: false });
  await db.doc(`${pages.PAGE_OWNER_COLLECTION}/contact`).update({ visible: false });
  const gone = await serving.readPublicReleaseDecision(request()); expect(gone.kind === "decision" && gone.route.kind).toBe("gone");
  await db.doc("cmsPages/contact").update({ "published.sourceVersion": 99 });
  await expect(serving.readPublicReleaseDecision(request())).rejects.toThrow();
});
it("rejects a missing deterministic route claim even when an owner remains", async () => {
  await pages.pageRouteRef(db, "/contact/").delete();
  await expect(serving.readPublicReleaseDecision(request())).rejects.toThrow();
});
it("accepts canonical Unicode artifact paths and refuses private compiled graph paths", async () => {
  const result = await serving.readPublicReleaseDecision(request("/assets/café.svg"));
  expect(result.kind === "decision" && result.path).toBe("/assets/café.svg");
  await expect(serving.readPublicReleaseDecision(request("/_pair-compiled/entry.js"))).rejects.toThrow();
  await expect(serving.readPublicReleaseDecision(request("/assets/cafe\u0301.svg"))).rejects.toThrow();
});
it("uses a bounded indexed route lookup for unknown record slugs", async () => {
  let scanned = false;
  const collection = db.collection.bind(db);
  const original = db.collection;
  db.collection = ((path: string) => {
    const ref = collection(path);
    if (path === records.RECORD_OWNER_COLLECTION) {
      const where = ref.where.bind(ref);
      ref.where = ((field: string, operator: string, value: unknown) => {
        expect(field).toBe("ownedPaths"); expect(operator).toBe("array-contains"); expect(value).toBe("/programs/unknown/");
        scanned = true; return where(field, operator as any, value);
      }) as typeof ref.where;
    }
    return ref;
  }) as typeof db.collection;
  try {
    const result = await serving.readPublicReleaseDecision(request("/programs/unknown/"));
    expect(result.kind === "decision" && result.route.kind).toBe("unowned"); expect(scanned).toBe(true);
  } finally { db.collection = original; }
});
it("reads Post ownership from its original owner without requiring the selected renderer SHA", async () => {
  const snapshot = { sourceVersion: 7, metadata: { type: "post", slug: "example" }, blocks: [] };
  await db.doc("cmsPosts/post-one").set({ version: 8, status: "draft", publiclyVisible: true, published: snapshot });
  await db.doc("system/publicDeployment/noBuildPostOwners/post-one").set({ schemaVersion: 1, postId: "post-one", servingEnabled: true,
    rendererSha: other.commitSha, operationId, sourceVersion: 7, slug: "example", visible: true, ownedSlugs: ["example", "old-example"],
    generation: 7, snapshotDigest: pages.digest(snapshot), runtime: { owner: "cloudflare", release: other.commitSha } });
  const result = await serving.readPublicReleaseDecision(request("/posts/example/"));
  expect(result.kind === "decision" && result.route.kind === "serve" && result.route.family).toBe("post");
  await db.doc("cmsPosts/post-one").update({ "published.metadata.title": "new revision" });
  await expect(serving.readPublicReleaseDecision(request("/posts/example/"))).rejects.toThrow();
});
it.each(["program", "event"] as const)("reads current %s and refuses a changed source", async kind => {
  const snapshot = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document: { ...recordDocument(kind).published.metadata, version: 7, previousSlugs: ["former-record"] },
    publishedAt: "2026-10-10T12:00:00.000Z", publishedBy: "fixture-editor" });
  const family = kind === "program" ? "programs" : "events", id = `${kind}-one`, canonicalPath = `/${family}/${snapshot.metadata.slug}/`;
  const ownedPaths = [canonicalPath, `/${family}/former-record/`, ...(kind === "program" ? [`/shows/${snapshot.metadata.slug}/`, "/shows/former-record/"] : [])];
  const state = { schemaVersion: 1, family, documentId: id, operationId, sourceVersion: 7, snapshotDigest: pages.digest(snapshot), canonicalPath,
    ownedPaths, visible: true, rendererSha: other.commitSha, generation: 7, runtime: { owner: "cloudflare", release: other.commitSha },
    contextRevision: 1, contextDigest: context.publicContextDigest(1), admissionRevision: 1 };
  await db.doc(`cmsPosts/${id}`).set({ version: 7, status: "published", publiclyVisible: true, published: snapshot });
  await db.doc(`${records.RECORD_OWNER_COLLECTION}/${id}`).set(state);
  for (const path of ownedPaths) await records.recordRouteRef(db, path).set({ schemaVersion: 1, family, documentId: id, path });
  const result = await serving.readPublicReleaseDecision(request(canonicalPath));
  expect(result.kind === "decision" && result.route.kind === "serve" && result.route.family).toBe("record");
  for (const path of ownedPaths) {
    const alias = await serving.readPublicReleaseDecision(request(path));
    expect(alias.kind === "decision" && alias.route.kind).toBe("serve");
  }
  await db.doc(`cmsPosts/${id}`).update({ "published.sourceVersion": 8 });
  await expect(serving.readPublicReleaseDecision(request(canonicalPath))).rejects.toThrow();
});
it("preserves the actual legacy Post owner reference in frozen metadata verification", async () => {
  const snapshot = { sourceVersion: 7, metadata: { type: "post", slug: "legacy" }, blocks: [] };
  await db.doc("cmsPosts/post-legacy").set({ version: 8, status: "draft", publiclyVisible: true, published: snapshot });
  await db.doc("system/publicDeployment/noBuildPosts/current").set({ schemaVersion: 1, postId: "post-legacy", servingEnabled: true,
    rendererSha: other.commitSha, operationId, sourceVersion: 7, slug: "legacy", visible: true, ownedSlugs: ["legacy"],
    generation: 7, snapshotDigest: pages.digest(snapshot), runtime: { owner: "cloudflare", release: other.commitSha } });
  const result = await serving.readPublicReleaseDecision(request("/posts/legacy/"));
  expect(result.kind === "decision" && result.route.kind !== "unowned" && result.route.ownerPath).toBe("system/publicDeployment/noBuildPosts/current");
});
it("derives exact snapshot evidence for valid legacy Post owners without a snapshotDigest", async () => {
  const snapshot = { sourceVersion: 7, metadata: { type: "post", slug: "without-digest" }, blocks: [] };
  const document = { version: 8, status: "draft", publiclyVisible: true, published: snapshot };
  await db.doc("cmsPosts/post-old").set(document);
  await db.doc("system/publicDeployment/noBuildPosts/current").set({ schemaVersion: 1, postId: "post-old", servingEnabled: true,
    rendererSha: other.commitSha, operationId, sourceVersion: 7, slug: "without-digest", visible: true, ownedSlugs: ["without-digest"],
    generation: 7, runtime: { owner: "cloudflare", release: other.commitSha } });
  const result = await serving.readPublicReleaseDecision(request("/posts/without-digest/"));
  expect(result.kind).toBe("decision"); if (result.kind !== "decision" || result.route.kind === "unowned") return;
  expect(result.route.snapshotDigest).toBe(pages.digest(snapshot)); expect(result.route.owner.snapshotDigest).toBeUndefined();
  expect(result.route.sourceDigest).toBe(protocol.publicReleaseDigest({ published: snapshot, publiclyVisible: true }));
});

it("resolves retained static Posts from their current published source without rewriting the owner", async () => {
  const ownerPath = "system/publicDeployment/noBuildPostOwners/static-post";
  const original = { sourceVersion: 7, metadata: { type: "post", slug: "before" }, blocks: [] };
  const files = ["/posts/", "/posts/before/", "/feeds/news.xml", "/api/v1/content.json", "/pagefind/pagefind.js",
    "/search/meaning-index.json", "/_publication.json", "/_content-status.json", "/sitemap.xml"].map(path => ({ path, bytes: 1, digest: "a".repeat(64) }));
  const owner = { schemaVersion: 1, postId: "static-post", servingEnabled: true, mode: "static", rendererSha: other.commitSha,
    operationId, sourceVersion: 7, slug: "before", visible: true, ownedSlugs: ["before"], generation: 7,
    snapshotDigest: pages.digest(original), runtime: { owner: "cloudflare", release: other.commitSha },
    staticProof: { schemaVersion: 1, postId: "static-post", operationId, sourceVersion: 7, slug: "before", visible: true,
      ownedSlugs: ["before"], snapshotDigest: pages.digest(original), contextDigest: context.publicContextDigest(1), files } };
  await db.doc(ownerPath).set(owner);
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 2 });
  const published = { sourceVersion: 8, metadata: { type: "post", slug: "after", previousSlugs: ["before"] }, blocks: [], publishedAt: "2026-10-28T00:00:00.000Z" };
  await db.doc("cmsPosts/static-post").set({ version: 8, publiclyVisible: true, published });
  const current = await serving.readPublicReleaseDecision(request("/posts/after/"));
  expect(current.kind).toBe("decision"); if (current.kind !== "decision" || current.route.kind === "unowned") return;
  expect(current.route).toMatchObject({ kind: "serve", sourceVersion: 8, snapshotDigest: pages.digest(published), owner: { sourceVersion: 7, slug: "before", mode: "static" } });
  const alias = await serving.readPublicReleaseDecision(request("/posts/before/"));
  expect(alias.kind === "decision" && alias.route).toMatchObject({ kind: "redirect", canonicalPath: "/posts/after/" });
  await db.doc("cmsPosts/static-post").update({ publiclyVisible: false });
  for (const path of ["/posts/before/", "/posts/after/"]) {
    const gone = await serving.readPublicReleaseDecision(request(path));
    expect(gone.kind === "decision" && gone.route).toMatchObject({ kind: "gone", sourceVersion: 8 });
  }
  expect((await db.doc(ownerPath).get()).data()).toEqual(owner);
});

it.each(["selected", "baseline-proof", "absent-owned", "absent-unowned", "drift", "wrong-claim", "disabled"])("runs the composed decision transaction boundary: %s", async scenario => {
  const original = releaseSelector().contentHead, contentHead = { ...original, viewId: "d".repeat(64), manifestDigest: "c".repeat(64) };
  await db.doc(`${base}/heads/current`).update({ contentHead });
  // The real selected activation writes root AND own head atomically.
  await db.doc("system/publicDeployment").update({ contentHead });
  const originalRow = (await db.doc(`${base}/views/${original.manifestDigest}`).get()).data()!;
  const locator = { pairDigest: originalRow.pairDigest, identity: originalRow.identity, claimDigest: originalRow.claimDigest,
    manifestDigest: originalRow.manifestDigest, manifestBytes: originalRow.manifestBytes };
  let physical = locator;
  if (scenario === "baseline-proof") {
    physical = { ...locator, manifestDigest: "8".repeat(64) };
    await db.doc(`${base}/views/${physical.manifestDigest}`).set({ ...originalRow, manifestDigest: physical.manifestDigest,
      manifestKey: originalRow.manifestKey.replace(original.manifestDigest, physical.manifestDigest) });
  }
  const composed = { locator: scenario === "wrong-claim" ? { ...physical, claimDigest: "0".repeat(64) } : physical,
    artifactPath: scenario === "baseline-proof" ? "/contact/index.html" : "/contact/", expectedBodyDigest: "a".repeat(64),
    absent: scenario.startsWith("absent"), witnessDigest: contentHead.viewId, proofLocator: scenario === "baseline-proof" ? locator : null };
  let preparedCalls = 0, selectionCalls = 0;
  const options = { ...request(), composedReadersEnabled: scenario !== "disabled",
    prepareComposedRead: async () => { preparedCalls++; return { contentHead: scenario === "drift" ? { ...contentHead, contextSequence: 1 } : contentHead,
      changes: { schemaVersion: 2, ...cursor }, readWitness: () => { throw new Error("typed witness guard is supplied to selection owner"); } }; },
    readComposedArtifact: async (input: any) => { selectionCalls++; expect(typeof input.readWitness).toBe("function"); return composed; },
    ...(scenario === "absent-unowned" ? { readRoute: async () => ({ kind: "unowned" }) } : {}) };
  if (["disabled", "wrong-claim"].includes(scenario)) {
    await expect(serving.readPublicReleaseDecision(options)).rejects.toThrow();
    if (scenario === "disabled") { expect(preparedCalls).toBe(0); expect(selectionCalls).toBe(0); }
    return;
  }
  const result = await serving.readPublicReleaseDecision(options);
  if (["drift", "absent-owned"].includes(scenario)) { expect(result).toEqual({ kind: "reselect" }); return; }
  expect(result.kind).toBe("decision"); if (result.kind !== "decision") return;
  expect(result.locator).toEqual(physical); expect(result.contentHead).toEqual(contentHead);
  expect(result.composition?.absent).toBe(scenario === "absent-unowned");
  if (scenario === "baseline-proof") { expect(result.composition?.proofLocator).toEqual(locator); expect(result.targetProof).not.toBeNull(); }
});

it("preserves stored Timestamp metadata and authentic bootstrap epoch-one provenance after a later switch", async () => {
  const old = releaseSelector(), current = { ...old, epoch: 2, activeCommitSha: other.commitSha, selectedPair: old.recoveryPair,
    recoveryPair: old.selectedPair, switchOperationId: "switch-two", contentHead: { ...old.contentHead, pairId: other.pairId } };
  await db.doc("system/publicDeployment").set({ ...current, updatedAt: Timestamp.fromMillis(1_800_000_000_000) });
  const receiptPath = `system/publicDeployment/bootstrapSelectors/${old.switchOperationId}`;
  await db.doc(receiptPath).set({ schemaVersion: 2, kind: "public-release-bootstrap", operationId: old.switchOperationId,
    attemptDigest: "a".repeat(64), sourceDigest: old.priorSelectorDigest, storedSelectorDigest: "b".repeat(64),
    selectorDigest: protocol.publicReleaseDigest(old), selector: old });
  const result = await serving.readPublicReleaseDecision(request()); expect(result.kind === "decision" && result.epoch).toBe(1);
  const fresh = await serving.readPublicReleaseSelector({ firestore: db, environment: "development" });
  expect(fresh.selector).toEqual(current); expect("updatedAt" in fresh.selector).toBe(false);
  await db.doc(receiptPath).update({ sourceDigest: "0".repeat(64) });
  await expect(serving.readPublicReleaseDecision(request())).rejects.toThrow();
});
