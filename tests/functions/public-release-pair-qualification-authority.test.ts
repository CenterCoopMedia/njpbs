import { createRequire } from "node:module";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { Transaction } from "firebase-admin/firestore";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { sealedPair } from "../helpers/sealed-public-release-pair";
import { readerSealPath } from "../../site/scripts/public-release-pair-private-reader";
import { readPairQualificationAuthority, assertPairQualificationAuthorityCurrent } from "../../site/scripts/public-release-pair-qualification-authority";
import work from "../../functions/lib/public-release-pair-work.js";
import legacy from "../../functions/lib/public-deployment.js";
import { recordDocument } from "../../site/tests/fixtures/published-records/fixtures";
const require = createRequire(import.meta.url);
const pages = require("../../functions/lib/no-build-page-ownership.js");
const records = require("../../functions/lib/no-build-record-ownership.js");
const recordContract = require("../../functions/lib/no-build-record-contract.js");
const snapshots = require("../../functions/lib/publish-snapshot.js");
const context = require("../../functions/lib/public-context-revision.js");
const { pair, seals } = sealedPair();
let db: ReturnType<typeof isolatedFirestore>;
beforeAll(() => { db = isolatedFirestore("public-release-pair-qualification-authority.test.ts"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set(legacy.initialPublicDeploymentPointer());
  await work.registerPublicReleasePair({ firestore: db, pair });
  await db.doc(readerSealPath(pair)).create(seals);
  await db.doc("system/publicReleaseChanges").set({ schemaVersion: 2, sequence: 12, baselineDigest: "b".repeat(64), lastDigest: "c".repeat(64) });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 20 });
});
const read = () => db.runTransaction(transaction => readPairQualificationAuthority({ firestore: db, transaction, pair }), { readOnly: true });
async function post(index = 1, visible = true) {
  const postId = `post-${index}`, published = { sourceVersion: 7, publishedAt: "2026-10-10T12:00:00.000Z",
    metadata: { type: "post", slug: `current-${index}`, previousSlugs: [`earlier-${index}`] }, blocks: [] };
  const document = { status: "published", publiclyVisible: visible, published, version: 7 };
  const state = { schemaVersion: 1, postId, rendererSha: pair.commitSha, servingEnabled: true, generation: 3,
    operationId: String(index).padStart(20, "A"), sourceVersion: 7, slug: `current-${index}`, ownedSlugs: [`current-${index}`, `earlier-${index}`],
    visible, snapshotDigest: pages.digest(published) };
  await db.doc(`cmsPosts/${postId}`).set(document);
  await db.doc(`system/publicDeployment/noBuildPostOwners/${postId}`).set(state);
  return { state, document };
}
async function page(visible = true) {
  const published = { sourceVersion: 7, publishedAt: "2026-10-10T12:00:00.000Z", metadata: { type: "page", slug: "contact" }, blocks: [] };
  const document = { status: "published", publiclyVisible: visible, published, version: 7 };
  const state = { schemaVersion: 1, pageId: "contact", rendererSha: pair.commitSha, servingEnabled: true, generation: 3,
    operationId: "A".repeat(20), sourceVersion: 7, path: "/contact/", ownedPaths: ["/contact/", "/contact-us/"], visible,
    snapshotDigest: pages.digest(published), runtime: { owner: "cloudflare", release: pair.commitSha } };
  await db.doc("cmsPages/contact").set(document);
  await db.doc(`${pages.PAGE_OWNER_COLLECTION}/contact`).set(state);
  for (const path of state.ownedPaths) await pages.pageRouteRef(db, path).set({ schemaVersion: 1, pageId: "contact", path });
}
async function record(visible = true) {
  const source = recordDocument("program", "program-one");
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document: { ...source.published.metadata, version: 7 },
    publishedAt: "2026-10-10T12:00:00.000Z", publishedBy: "editor" });
  const plan = recordContract.validateNoBuildRecordSnapshot({ family: "programs", documentId: "program-one", snapshot: published });
  const document = { ...source, version: 7, published, publiclyVisible: visible };
  const state = { schemaVersion: 1, family: "programs", documentId: "program-one", sourceVersion: 7, operationId: "B".repeat(20),
    snapshotDigest: recordContract.recordSnapshotDigest(published), canonicalPath: plan.canonicalPath, ownedPaths: plan.ownedPaths,
    visible, rendererSha: pair.commitSha, generation: 3, runtime: { owner: "cloudflare", release: pair.commitSha },
    contextRevision: 20, contextDigest: context.publicContextDigest(20), admissionRevision: null };
  await db.doc("cmsPosts/program-one").set(document);
  await db.doc(`${records.RECORD_OWNER_COLLECTION}/program-one`).set(state);
  await db.doc("system/publicDeployment/noBuildRecordFamilies/current").set({ schemaVersion: 1, families: ["programs"] });
  for (const path of plan.ownedPaths) await records.recordRouteRef(db, path).set({ schemaVersion: 1, family: "programs", documentId: "program-one", path });
}
it("enumerates all owned canonical routes, aliases, withdrawn paths and registered indexes", async () => {
  await post(); await post(2, false); await page(); await record(false);
  const before = (await db.doc("system/publicDeployment").get()).data(), authority = await read();
  expect(authority.routes.map(route => [route.path, route.status])).toEqual([
    ["/contact-us/", 308], ["/contact/", 200], ["/posts/current-1/", 200], ["/posts/current-2/", 410],
    ["/posts/earlier-1/", 308], ["/posts/earlier-2/", 410], ["/programs/", 200], ["/programs/current-program-one/", 410],
    ["/programs/earlier-program-one/", 410], ["/shows/", 200], ["/shows/current-program-one/", 410], ["/shows/earlier-program-one/", 410] ]);
  expect(authority.routes.find(route => route.path === "/shows/")?.location).toBe(null);
  expect(authority.cursor).toEqual({ baselineDigest: "b".repeat(64), sequence: 12, lastDigest: "c".repeat(64) });
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
});
it("preserves native record HTML at both indexes and every canonical and former-slug alias", async () => {
  await record();
  const authority = await read();
  expect(authority.routes.filter(route => route.kind === "record" || route.kind === "record-index")
    .map(route => [route.path, route.status, route.location])).toEqual([
    ["/programs/", 200, null], ["/programs/current-program-one/", 200, null], ["/programs/earlier-program-one/", 200, null],
    ["/shows/", 200, null], ["/shows/current-program-one/", 200, null], ["/shows/earlier-program-one/", 200, null],
  ]);
});
it("batches 54 fixture source owners into one actual transaction getAll", async () => {
  await Promise.all(Array.from({ length: 54 }, (_, index) => post(index + 1)));
  const sourceBatches: number[] = [];
  const result = await db.runTransaction(transaction => {
    const observed = new Proxy(transaction, { get(target, key) {
      if (key === "getAll") return (...refs: any[]) => {
        const sources = refs.filter(ref => ref.path.startsWith("cmsPosts/") || ref.path.startsWith("cmsPages/"));
        if (sources.length) sourceBatches.push(sources.length);
        return target.getAll(...refs);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } }) as Transaction;
    return readPairQualificationAuthority({ firestore: db, transaction: observed, pair });
  }, { readOnly: true });
  expect(result.routes).toHaveLength(108); expect(sourceBatches).toEqual([54]);
});
it("excludes ordinary draft saves from the watermark and source seal", async () => {
  await post(); const before = await read();
  await db.doc("cmsPosts/post-1").update({ version: 8, title: "Draft only", blocks: [{ type: "draft" }], status: "draft" });
  expect((await read()).digest).toBe(before.digest);
});
it.each(["page-orphan", "page-missing", "record-family", "record-missing", "source-version", "duplicate-owner", "missing-log", "missing-seal"])(
  "refuses %s evidence", async mode => {
    await post(); await page(); await record();
    if (mode === "page-orphan") await pages.pageRouteRef(db, "/orphan/").set({ schemaVersion: 1, pageId: "other", path: "/orphan/" });
    if (mode === "page-missing") await pages.pageRouteRef(db, "/contact-us/").delete();
    if (mode === "record-family") await records.recordRouteRef(db, "/shows/current-program-one/").update({ family: "events" });
    if (mode === "record-missing") await records.recordRouteRef(db, "/shows/current-program-one/").delete();
    if (mode === "source-version") await db.doc("cmsPosts/post-1").update({ "published.sourceVersion": 8 });
    if (mode === "duplicate-owner") await db.doc("system/publicDeployment/noBuildPosts/current").set((await db.doc("system/publicDeployment/noBuildPostOwners/post-1").get()).data()!);
    if (mode === "missing-log") await db.doc("system/publicReleaseChanges").delete();
    if (mode === "missing-seal") await db.doc(readerSealPath(pair)).delete();
    await expect(read()).rejects.toThrow();
  });
it.each(["context", "log", "owner", "seal", "runtime", "enrollment", "retired", "billing"])("rechecks live %s immediately inside a later caller transaction", async mode => {
  await post(); const before = await read();
  if (mode === "context") await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 21 });
  if (mode === "log") await db.doc("system/publicReleaseChanges").update({ sequence: 13, lastDigest: "d".repeat(64) });
  if (mode === "owner") await db.doc("system/publicDeployment/noBuildPostOwners/post-1").update({ generation: 4 });
  if (mode === "seal") await db.doc(readerSealPath(pair)).delete();
  if (mode === "runtime") await db.doc("system/cmsPublicationRuntime").set({ phase: "paused" });
  if (mode === "enrollment") await db.doc("system/publicReleaseChangeLog").set({ enabled: false });
  if (mode === "retired") await db.doc(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`).update({ status: "retired" });
  if (mode === "billing") await db.doc("system/billing").set({ disabled: true });
  await expect(db.runTransaction(transaction => assertPairQualificationAuthorityCurrent({ firestore: db, transaction,
    pair, expectedDigest: before.digest, qualifiedAt: before.capturedAt }))).rejects.toThrow();
});
it("refuses an expired or future-dated qualification without any selection write", async () => {
  await post(); const before = await read();
  for (const qualifiedAt of [before.capturedAt - 60_001, before.capturedAt + 60_000]) {
    await expect(db.runTransaction(transaction => assertPairQualificationAuthorityCurrent({ firestore: db, transaction,
      pair, expectedDigest: before.digest, qualifiedAt }))).rejects.toThrow("stale-qualification");
  }
});

it.each(["post", "page"])("qualifies the exact custom %s target as 302 and restores 200 when disabled", async kind => {
  if (kind === "post") await post(); else await page();
  const sourceRef = db.doc(kind === "post" ? "cmsPosts/post-1" : "cmsPages/contact");
  const ownerRef = db.doc(kind === "post" ? "system/publicDeployment/noBuildPostOwners/post-1" : `${pages.PAGE_OWNER_COLLECTION}/contact`);
  const path = kind === "post" ? "/posts/current-1/" : "/contact/";
  const target = "https://example.test/results?edition=nj#current";
  const source = (await sourceRef.get()).data()!;
  Object.assign(source.published.metadata, { contentLinkMode: "custom", contentLinkUrl: target, contentLinkNewTab: true });
  await sourceRef.set(source);
  await ownerRef.update({ snapshotDigest: pages.digest(source.published) });
  expect((await read()).routes.find(route => route.path === path)).toMatchObject({ status: 302, location: target });
  source.published.metadata.contentLinkMode = "normal";
  await sourceRef.set(source);
  await ownerRef.update({ snapshotDigest: pages.digest(source.published) });
  expect((await read()).routes.find(route => route.path === path)).toMatchObject({ status: 200, location: null });
  expect((await sourceRef.get()).data()!.published.blocks).toEqual(source.published.blocks);
});

it("redirects a linked Home HTML route while retaining its source catalog as 200 JSON", async () => {
  const published = { sourceVersion: 7, publishedAt: "2026-10-10T12:00:00.000Z", blocks: [],
    metadata: { title: "Home", contentLinkMode: "custom", contentLinkUrl: "https://example.test/home", contentLinkNewTab: true } };
  const state = { schemaVersion: 1, pageId: "home", rendererSha: pair.commitSha, servingEnabled: true, generation: 3,
    operationId: "A".repeat(20), sourceVersion: 7, path: "/", ownedPaths: ["/", "/_home-sources.json"], visible: true,
    snapshotDigest: pages.digest(published), runtime: { owner: "cloudflare", release: pair.commitSha } };
  await db.doc("cmsPages/home").set({ status: "published", publiclyVisible: true, published, version: 7 });
  await db.doc(`${pages.PAGE_OWNER_COLLECTION}/home`).set(state);
  for (const path of state.ownedPaths) await pages.pageRouteRef(db, path).set({ schemaVersion: 1, pageId: "home", path });
  const routes = (await read()).routes;
  expect(routes.find(route => route.path === "/")).toMatchObject({ status: 302, location: "https://example.test/home" });
  expect(routes.find(route => route.path === "/_home-sources.json")).toMatchObject({ status: 200, location: null });
});
