import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { createHomeNewsletterBlock } from "../../packages/content-core/src/home-newsletter-section";
import { createHomeNewsletterSnapshot } from "../../packages/content-core/src/home-service-sources";
import newsletterCopy from "../../site/tests/fixtures/home-sources/newsletter-public-copy.json";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import save from "../../functions/save.js";
import preview from "../../functions/lib/preview-snapshot.js";
import publication from "../../functions/lib/publish-snapshot.js";
import admission from "../../functions/lib/home-source-selection-admission.js";
import deployment from "../../functions/lib/public-deployment.js";
import context from "../../functions/lib/public-context-revision.js";
import homeOwner from "../../functions/lib/no-build-home-ownership.js";
import { readHomeEditorialSourceReceipt, resolveHomeShelf } from "../../packages/content-core/src/home-source-catalog";
import { renderHomeCuratedShelf } from "../../packages/content-core/src/home-curated-render";
import type { ContentShelfBlock } from "../../packages/content-core/src/content-model";
import original from "../../site/tests/fixtures/home-composition-v1.json";
import fixture from "../../site/tests/fixtures/home-v2-selections.json";

const project = process.env.GCLOUD_PROJECT || "demo-njpbs";
const host = process.env.FIRESTORE_EMULATOR_HOST;
const pointer = (generation = 21) => ({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: generation,
  activeCommitSha: "a".repeat(40), activeDeploymentId: "11111111-1111-4111-8111-111111111111", lastReservedGeneration: generation,
  newestEligibleGeneration: generation, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
async function seedPilot(db: ReturnType<typeof getFirestore>, variant: string) {
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 1, revision: 1, enabled: variant !== "paused", postId: "pilot-post", backgroundBucket: "demo-home-background" });
  await db.doc("system/publicDeployment/noBuildPosts/current").set({ schemaVersion: 1, postId: "pilot-post", rendererSha: "a".repeat(40),
    operationId: "a".repeat(20), sourceVersion: 1, visible: true, slug: "pilot-story", ownedSlugs: ["pilot-story"], generation: 21,
    servingEnabled: variant !== "serving-off", ...(variant === "static" ? { mode: "static" } : {}) });
  await db.doc("cmsPosts/pilot-post").set({ status: "published", publiclyVisible: true,
    published: { sourceVersion: 1, metadata: { type: "post", slug: "pilot-story", credits: [] }, blocks: [] } });
}
const canonicalPostBlockId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let db: ReturnType<typeof getFirestore>;
async function request(role: string, blocks: unknown[], baseVersion = 7, metadata: Record<string, unknown> = {}, firestore = db) {
  const response = { code: 0, body: null as any, status(code: number) { this.code = code; return this; }, json(body: unknown) { this.body = body; return this; } };
  await save.createCmsSaveHandler({ firestore, mintId: () => canonicalPostBlockId,
    requirePrincipalFn: () => ({ uid: "catalog-editor", email: "catalog-editor@example.test", principal: { id: "catalog-editor", grants: [{ role }] } }) })
    ({ method: "POST", headers: {}, ip: "203.0.113.10", body: { collection: "cmsPages", id: "home", baseVersion, document: { blocks, ...metadata } } }, response);
  return response;
}
describe("Home selections across the real Firestore save boundary", () => {
  beforeAll(() => {
    if (!host || !project.startsWith("demo-")) throw new Error("A demo-* Firestore emulator is required");
    db = isolatedFirestore("home-source-selection.test.ts");
  });
  beforeEach(async () => {
    expect((await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" }, db)).ok).toBe(true);
    await db.doc("cmsPages/home").set({ ...original, homeCompositionVersion: 2 });
    await db.doc("system/publicDeployment").set(pointer());
    await db.collection(admission.HOME_CATALOGS_COLLECTION).doc(fixture.editorial.receipt.buildBatchId).set(fixture.editorial);
  });
  it("admits one current approved Newsletter and refuses stale, forged, revoked or newly missing selections", async () => {
    const cutoffAt = fixture.editorial.catalog.cutoffAt;
    const approved = { id: "newsletter-one", type: "newsletter", version: 1, status: "approved", title: newsletterCopy.title,
      summary: newsletterCopy.summary, signupUrl: newsletterCopy.signupUrl, body: { type: "doc", content: [] } };
    await db.doc("cmsPosts/newsletter-one").set(approved);
    await db.doc("cmsVersionHistory/newsletter-approval").set({ collection: "cmsPosts", documentId: "newsletter-one", action: "approve", after: approved });
    const catalog = { ...fixture.editorial.catalog, services: { newsletters: createHomeNewsletterSnapshot([{
      id: "newsletter-one", kind: "newsletter", href: null, sourceVersion: 1,
      newsletter: { card: { title: newsletterCopy.title, summary: newsletterCopy.summary, signupUrl: newsletterCopy.signupUrl } },
    }], cutoffAt, cutoffAt) } };
    const source = admission.sealHomeCatalog(catalog, fixture.editorial.receipt);
    await db.collection(admission.HOME_CATALOGS_COLLECTION).doc(source.receipt.buildBatchId).set(source);
    const selected = { ...createHomeNewsletterBlock("newsletter-block"), order: 7, data: {
      newsletterIds: ["newsletter-one"], actionLabel: "Sign up by email", selectionReceipt: source.receipt } };
    const baseline = structuredClone(original.blocks);
    const verify = (value: unknown, previousBlocks: unknown[] = []) => db.runTransaction(transaction => admission.verifyHomeSelections({ firestore: db, transaction, blocks: [value], previousBlocks }));
    await expect(verify(selected)).resolves.toBeUndefined();
    await expect(verify({ ...selected, data: { ...selected.data, selectionReceipt: { ...source.receipt, generation: 20 } } })).rejects.toThrow(/current/);
    await expect(verify({ ...selected, data: { ...selected.data, selectionReceipt: { ...source.receipt, digest: "f".repeat(64) } } })).rejects.toThrow(/receipt/);
    await expect(verify({ ...selected, data: { ...selected.data, newsletterIds: ["missing"] } })).rejects.toThrow(/not published/);
    await db.doc("cmsPosts/newsletter-one").update({ status: "archived", version: 2 });
    await expect(verify(selected)).rejects.toThrow(/approval changed/);
    // Already admitted withdrawn identity stays editable; a copy edit never creates a new selection.
    await expect(verify({ ...selected, data: { ...selected.data, heading: "Home copy edit" } }, [selected])).resolves.toBeUndefined();
    await db.doc("cmsPosts/newsletter-one").set(approved);
    const blankDraft = { ...selected, data: { ...selected.data, actionLabel: "" } };
    const response = await request("editor", [...baseline, blankDraft]);
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    const saved = (await db.doc("cmsPages/home").get()).data()!;
    expect(saved.blocks.at(-1).data).toEqual(blankDraft.data);
    expect(preview.createPreviewSnapshot("home", saved).blocks.at(-1).data).toEqual(blankDraft.data);
  });
  afterAll(async () => { await Promise.all(getApps().map(deleteApp)); });

  it.each(["known", "unknown", "stale-context", "stale-refresh", "missing-row"])("checks Page-transferred Home selection authority (%s)", async variant => {
    const operationId = "HOMEpageoperation001";
    const state = { schemaVersion: 1, pageId: "home", path: "/", ownedPaths: ["/", "/_home-sources.json"], operationId,
      sourceVersion: 7, generation: 23, rendererSha: "b".repeat(40), runtime: { owner: "cloudflare", release: "b".repeat(40) },
      visible: true, homeRefresh: { revision: 3, status: "verified" } };
    await db.doc(homeOwner.HOME_PAGE_OWNER_PATH).set(state);
    await db.doc(homeOwner.HOME_BACKGROUND_PATH).set({ schemaVersion: 1, owner: homeOwner.HOME_PAGE_OWNER,
      pageId: "home", ownerPath: homeOwner.HOME_PAGE_OWNER_PATH, operationId, retainedSource: null });
    await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 9 });
    await db.doc("cmsPages/home").update({ publiclyVisible: true,
      published: { sourceVersion: 7, metadata: { template: "home" }, blocks: [] } });
    const source = admission.sealHomeCatalog(fixture.editorial.catalog, { buildBatchId: operationId,
      generation: 23, commitSha: "a".repeat(40) });
    await db.runTransaction(async transaction => {
      const write = await admission.preparePageHomeCatalogInTransaction({ firestore: db, transaction, state, source,
        rendererSha: "a".repeat(40), contextDigest: context.publicContextDigest(9), homeRefreshRevision: 3 });
      write();
    });
    const blocks = structuredClone(fixture.home.blocks);
    for (const block of blocks) if (block.data.selectionReceipt) block.data.selectionReceipt = source.receipt;
    if (variant === "unknown") blocks[7].data.selectedIds = ["not-a-published-card"];
    if (variant === "stale-context") await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 10 });
    if (variant === "stale-refresh") await db.doc(homeOwner.HOME_PAGE_OWNER_PATH).update({ "homeRefresh.revision": 4 });
    if (variant === "missing-row") await db.collection(admission.HOME_CATALOGS_COLLECTION).doc(operationId).delete();
    const response = await request("editor", blocks);
    expect(response.code, JSON.stringify(response.body)).toBe(variant === "known" ? 200 : 409);
    if (variant === "unknown") expect(response.body.error).toContain("no longer published");
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(variant === "known" ? 1 : 0);
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it("an ordinary Editor admits published IDs, saves their exact order, and reopens identical preview/public selections", async () => {
    const response = await request("editor", structuredClone(fixture.home.blocks));
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(response.body.mintedIds).toEqual({ "saved-home-posts": canonicalPostBlockId });
    const reopened = (await db.doc("cmsPages/home").get()).data()!;
    const expected = fixture.home.blocks.map(block => block.section === "home-posts" ? { ...block, id: canonicalPostBlockId } : block);
    expect(reopened.blocks).toEqual(expected);
    expect(preview.createPreviewSnapshot("home", reopened).blocks).toEqual(expected);
    expect(publication.createPublishedSnapshot({ collection: "cmsPages", document: reopened,
      publishedAt: "2026-10-11T19:00:00.000Z", publishedBy: "fixture-editor" }).blocks).toEqual(expected);
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });
  it("lets Firestore retry an aborted source read instead of exposing an internal 409", async () => {
    let failures = 0;
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === "runTransaction") return (run: (transaction: unknown) => Promise<unknown>) => target.runTransaction(transaction => run(new Proxy(transaction, { get(tx, name) {
        if (name === "get") return (reference: { path: string }) => {
          if (reference.path === "cmsBackgroundOutputs/home" && failures++ === 0) throw Object.assign(new Error("Internal aborted detail must not reach staff"), { code: 10 });
          return tx.get(reference as never);
        };
        const value = Reflect.get(tx, name); return typeof value === "function" ? value.bind(tx) : value;
      } })));
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await request("editor", structuredClone(fixture.home.blocks), 7, {}, wrapped);
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(failures).toBeGreaterThanOrEqual(2);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain("Internal aborted detail");
  });
  it("retains native hero source identity independently of its Home destination override", async () => {
    const homeHero = { mode: "manual", items: [{ itemId: "bound-hero", source: "cms_posts", sourceId: "pilot-post", title: "", summary: "", href: "/support/" }] };
    expect((await request("editor", structuredClone(fixture.home.blocks), 7, { homeHero })).code).toBe(200);
    const reopened = (await db.doc("cmsPages/home").get()).data()!;
    expect(reopened.homeHero).toEqual(homeHero);
    expect(preview.createPreviewSnapshot("home", reopened).homeHero).toEqual(homeHero);
    expect(publication.createPublishedSnapshot({ collection: "cmsPages", document: reopened, publishedAt: "2026-10-11T19:00:00.000Z", publishedBy: "fixture-editor" }).metadata.homeHero).toEqual(homeHero);
  });
  it.each(["forged", "stale", "missing"])("refuses %s admission without a history or content write", async variant => {
    const blocks = structuredClone(fixture.home.blocks);
    const shelf = blocks[7];
    if (variant === "forged") shelf.data.selectionReceipt!.digest = "b".repeat(64);
    if (variant === "stale") shelf.data.selectionReceipt!.generation = 20;
    if (variant === "missing") shelf.data.selectedIds = ["unpublished-post"];
    const response = await request("editor", blocks);
    expect(response.code, JSON.stringify(response.body)).toBe(409);
    expect((await db.doc("cmsPages/home").get()).data()?.blocks).toEqual(original.blocks);
    expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });
  it("keeps admitted missing IDs through an arrangement save and uses the current corrected/withdrawn catalog for both readers", async () => {
    expect((await request("editor", structuredClone(fixture.home.blocks))).code).toBe(200);
    const reopened = (await db.doc("cmsPages/home").get()).data()!;
    const source = readHomeEditorialSourceReceipt(fixture.editorial);
    const pool = source.catalog.sources["home-posts"];
    if (pool.status !== "ready") throw new Error("fixture");
    pool.cards = [{ ...pool.cards[0], title: "Corrected station story", sourceVersion: 41 }];
    const current = admission.sealHomeCatalog(source.catalog, { ...source.receipt, buildBatchId: "cms-HOME6CatalogProof002", generation: 22 });
    await db.doc("system/publicDeployment").set(pointer(22));
    await db.collection(admission.HOME_CATALOGS_COLLECTION).doc(current.receipt.buildBatchId).set(current);
    const changed = reopened.blocks.map((block: any) => block.section === "home-posts" ? { ...block, data: { ...block.data, title: "Station stories" } } : block);
    expect((await request("editor", changed, 8)).code).toBe(200);
    const saved = (await db.doc("cmsPages/home").get()).data()!;
    const previewBlocks = preview.createPreviewSnapshot("home", saved).blocks;
    const publicBlocks = publication.createPublishedSnapshot({ collection: "cmsPages", document: saved,
      publishedAt: "2026-10-11T19:10:00.000Z", publishedBy: "fixture-editor" }).blocks;
    const previewShelf = previewBlocks.find((block: any) => block.section === "home-posts") as ContentShelfBlock;
    const publicShelf = publicBlocks.find((block: any) => block.section === "home-posts") as ContentShelfBlock;
    for (const block of [previewShelf, publicShelf]) {
      expect(block.data.selectedIds).toEqual(["57298ff3b0d0917f9e653f80bada063d", "1208e81a5470be941e3fb392eac674ae"]);
      expect(resolveHomeShelf(block, current.catalog).missingIds).toEqual(["57298ff3b0d0917f9e653f80bada063d"]);
      expect(renderHomeCuratedShelf(block, current.catalog)).toContain("Corrected station story");
      expect(renderHomeCuratedShelf(block, current.catalog)).not.toContain("NJ PBS announces six staff appointments");
    }
    expect(renderHomeCuratedShelf(previewShelf, current.catalog)).toBe(renderHomeCuratedShelf(publicShelf, current.catalog));
  });
  it("denies an ordinary Writer before reading or admitting any new selection", async () => {
    expect((await request("writer", structuredClone(fixture.home.blocks))).code).toBe(403);
    expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
  });
  it.each(["home-featured", "home-more", "home-spotlight", "home-posts"])("refuses new IDs during a %s source error without content/history writes, but retains old IDs", async section => {
    expect((await request("editor", structuredClone(fixture.home.blocks))).code).toBe(200);
    const before = (await db.doc("cmsPages/home").get()).data()!;
    const catalog = structuredClone(fixture.editorial.catalog);
    catalog.sources[section as keyof typeof catalog.sources] = { status: "error" } as never;
    const current = admission.sealHomeCatalog(catalog, { ...fixture.editorial.receipt, buildBatchId: "cms-HOME6SourceError001", generation: 22 });
    await db.doc("system/publicDeployment").set(pointer(22));
    await db.collection(admission.HOME_CATALOGS_COLLECTION).doc(current.receipt.buildBatchId).set(current);
    const changed = before.blocks.map((block: any) => block.section === section ? { ...block, data: { ...block.data,
      selectedIds: ["never-published"], selectionReceipt: current.receipt } } : block);
    expect((await request("editor", changed, 8)).code).toBe(409);
    expect((await db.doc("cmsPages/home").get()).data()?.blocks).toEqual(before.blocks);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
    const retained = before.blocks.map((block: any) => block.section === section ? { ...block, data: { ...block.data,
      selectedIds: [...block.data.selectedIds].reverse(), selectionReceipt: current.receipt } } : block);
    expect((await request("editor", retained, 8)).code).toBe(200);
    expect((await db.doc("cmsPages/home").get()).data()?.blocks).toEqual(retained);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(2);
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });
  it("lets an Editor select the automatic source rule, then re-admit hand-picked IDs", async () => {
    expect((await request("editor", structuredClone(fixture.home.blocks))).code).toBe(200);
    const saved = (await db.doc("cmsPages/home").get()).data()!;
    const automatic = saved.blocks.map((block: any) => {
      if (block.section !== "home-posts") return block;
      const { selectedIds: _ids, selectionReceipt: _receipt, ...data } = block.data;
      return { ...block, data };
    });
    expect((await request("editor", automatic, 8)).code).toBe(200);
    expect((await db.doc("cmsPages/home").get()).data()?.blocks).toEqual(automatic);
    expect((await request("editor", saved.blocks, 9)).code).toBe(200);
    expect((await db.doc("cmsPages/home").get()).data()?.blocks).toEqual(saved.blocks);
  });
  it.each(["current", "pending", "context", "runtime", "prior-receipt"])("admits only the current immutable Home authority: %s", async variant => {
    expect((await request("editor", structuredClone(fixture.home.blocks))).code).toBe(200);
    const before = (await db.doc("cmsPages/home").get()).data()!;
    const current = admission.sealHomeCatalog(fixture.editorial.catalog,
      { buildBatchId: "cms-HOME6FastCatalog001", generation: 22, commitSha: "a".repeat(40) });
    await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 2, withdrawalRevision: 0 });
    // Listings has independent cloud authority; the served Home decision must
    // still select the matching Home catalog through its own policy.
    await db.doc("system/publicDeployment/aggregateContexts/current").set({ schemaVersion: 1,
      operationId: "E".repeat(20), runtime: { owner: "cloudflare", release: "a".repeat(40) },
      contextRevision: 2, contextDigest: context.publicContextDigest(2), servingEstablished: true });
    await seedPilot(db, variant);
    const runtime = { owner: "cloudflare", release: "a".repeat(40) };
    await db.doc("cmsBackgroundOutputs/home").set({ schemaVersion: 1, owner: "post-background-v1", revision: 2,
      status: variant === "pending" ? "pending" : "verified", contextDigest: context.publicContextDigest(2), runtime,
      receipt: { revision: 2, contextDigest: context.publicContextDigest(variant === "context" ? 1 : 2),
        rendererSha: "a".repeat(40), runtime: variant === "runtime" ? { ...runtime, owner: "node-compute" } : runtime,
        homeSourceReceipt: current.receipt } });
    await db.collection(admission.HOME_CATALOGS_COLLECTION).doc(current.receipt.buildBatchId).set(current);
    const next = before.blocks.map((block: any) => block.section === "home-posts" ? { ...block, data: { ...block.data,
      selectedIds: [...block.data.selectedIds].reverse(), selectionReceipt: variant === "prior-receipt" ? block.data.selectionReceipt : current.receipt } } : block);
    const response = await request("editor", next, 8);
    expect(response.code, JSON.stringify(response.body)).toBe(variant === "current" ? 200 : 409);
    expect((await db.doc("cmsPages/home").get()).data()?.blocks).toEqual(variant === "current" ? next : before.blocks);
    if (variant !== "current") expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
  });
  it.each(["pending", "failed", "paused", "serving-off", "static", "renderer", "no-pilot"])("admits only the catalog for the served Home generation: %s", async variant => {
    expect((await request("editor", structuredClone(fixture.home.blocks))).code).toBe(200);
    const before = (await db.doc("cmsPages/home").get()).data()!;
    const fast = admission.sealHomeCatalog(fixture.editorial.catalog, { buildBatchId: "cms-HOME6FastCatalog001", generation: 22, commitSha: "a".repeat(40) });
    await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 2, withdrawalRevision: 0 });
    await db.doc("system/publicDeployment/aggregateContexts/current").set({ schemaVersion: 1,
      operationId: "E".repeat(20), runtime: { owner: "cloudflare", release: "a".repeat(40) },
      contextRevision: 2, contextDigest: context.publicContextDigest(2), servingEstablished: true });
    if (variant !== "no-pilot") await seedPilot(db, variant);
    await db.doc("cmsBackgroundOutputs/home").set({ schemaVersion: 1, owner: "post-background-v1", revision: 2,
      status: ["pending", "failed"].includes(variant) ? variant : "verified", contextDigest: context.publicContextDigest(2),
      receipt: { revision: 2, contextDigest: context.publicContextDigest(2), rendererSha: (variant === "renderer" ? "b" : "a").repeat(40), homeSourceReceipt: fast.receipt } });
    await db.collection(admission.HOME_CATALOGS_COLLECTION).doc(fast.receipt.buildBatchId).set(fast);
    const baseline = before.blocks.map((block: any) => block.section === "home-posts" ? { ...block, data: { ...block.data, selectedIds: [...block.data.selectedIds].reverse() } } : block);
    // Valid pause closes new Post admission while accepted Home stays served.
    const retainedFastHome = variant === "paused";
    expect((await request("editor", baseline, 8)).code).toBe(retainedFastHome ? 409 : 200);
    const fastSelection = baseline.map((block: any) => block.section === "home-posts" ? { ...block, data: { ...block.data, selectedIds: [...block.data.selectedIds].reverse(), selectionReceipt: fast.receipt } } : block);
    expect((await request("editor", fastSelection, retainedFastHome ? 8 : 9)).code).toBe(retainedFastHome ? 200 : 409);
    expect((await db.doc("cmsPages/home").get()).data()?.blocks).toEqual(retainedFastHome ? fastSelection : baseline);
  });

});
