import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { requireBootstrapAdoptionOwner } from "../../site/scripts/bootstrap-public-release-selector";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import measurement from "../../functions/lib/public-release-routing-measurement.js";
import bootstrap from "../../functions/lib/public-release-bootstrap.js";
import protocol from "../../functions/lib/public-release-pair.js";
import deployment from "../../functions/lib/public-deployment.js";
import publicContent from "../../functions/public-content.js";
import pointer from "../../functions/lib/public-deployment-pointer.js";
import work from "../../functions/lib/public-release-pair-work.js";
import coordinator from "../../functions/lib/public-deployment-coordinator.js";
import serving from "../../functions/lib/public-release-serving.js";
import pageServing from "../../functions/lib/no-build-page-serving.js";
import pages from "../../functions/lib/no-build-page-ownership.js";
import pageSource from "../../functions/lib/no-build-page-source.js";
import mediaContract from "../../functions/lib/media-contract.js";
import posts from "../../functions/lib/no-build-post-publication.js";
import postOwners from "../../functions/lib/no-build-post-ownership.js";
import { releasePair, releaseSelector } from "../helpers/private-public-release-pair.js";
import { pageDocument } from "./fixtures/home-decision-3441.js";
import targets from "../../functions/lib/publication-target.js";
const currentPair = releasePair(), recoveryPair = releasePair("b", "b".repeat(40)), pairs = [currentPair, recoveryPair], target = targets.publicationTarget("development");
const cursor = { baselineDigest: "1".repeat(64), sequence: 0, lastDigest: "1".repeat(64) };
let app: ReturnType<typeof initializeApp>, db: Firestore, before: any, attempt: any, proofs: any[], guard: any;
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use only the assigned loopback demo emulator");
  app = initializeApp({ projectId: target.projectId }, "layer4-bootstrap"); db = getFirestore(app);
});
afterAll(async () => { await deleteApp(app); });
beforeEach(async () => {
  await db.recursiveDelete(db.collection("system")); await db.recursiveDelete(db.collection("cmsPages"));
  const selector = releaseSelector();
  before = { schemaVersion: 1, mediaLifecycleReady: true, state: "idle", activeGeneration: selector.activeGeneration,
    activeDeploymentId: selector.activeDeploymentId, activeCommitSha: currentPair.commitSha, lastReservedGeneration: selector.activeGeneration,
    newestEligibleGeneration: selector.activeGeneration, newestEligibleBuildBatchId: selector.newestEligibleBuildBatchId, updatedAt: Timestamp.fromMillis(1_800_000_000_000) };
  const contract = { schemaVersion: 2, families: ["pages", "posts"], features: [] }, contractDigest = protocol.publicReleaseDigest(contract);
  const batch = db.batch(); batch.set(db.doc("system/publicDeployment"), before);
  batch.set(db.doc("system/publicReleaseChanges"), { schemaVersion: 2, ...cursor });
  batch.set(db.doc(`system/publicReleaseAdmissionContracts/entries/${contractDigest}`), contract);
  batch.set(db.doc("system/cmsPublicationRuntime"), { schemaVersion: 1, phase: "ready", commitSha: currentPair.commitSha,
    serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: currentPair.commitSha, serializerId: target.serializerId } });
  proofs = pairs.map((pair, index) => {
    const witness = { schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), codeAssetManifestDigest: pair.codeAssetManifestDigest,
      contentViewDigest: String(index + 2).repeat(64), headCursor: cursor };
    const receipt = { schemaVersion: 2, kind: "private-pair-qualification", qualificationId: `qualified-${index}`,
      pairDigest: protocol.publicReleaseDigest(pair), readerReceiptDigest: pair.readerReceiptDigest,
      codeAssetManifestDigest: pair.codeAssetManifestDigest, witnessDigest: protocol.publicReleaseDigest(witness), contentViewDigest: witness.contentViewDigest };
    const base = work.publicReleasePairPath(pair.pairId), contentHead = { pairId: pair.pairId,
      viewId: receipt.witnessDigest, manifestDigest: witness.contentViewDigest, contextSequence: cursor.sequence };
    batch.set(db.doc(base), pair);
    batch.set(db.doc(`${base}/controls/runtime`), { schemaVersion: 2, pairId: pair.pairId, status: "retained" });
    batch.set(db.doc(`${base}/rollouts/publisher`), { schemaVersion: 2, pairId: pair.pairId, pairDigest: protocol.publicReleaseDigest(pair),
      state: "verified", readbackDigest: "4".repeat(64) });
    batch.set(db.doc(`${base}/heads/current`), { schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), contentHead });
    return { receipt, witness };
  });
  await batch.commit();
  attempt = { schemaVersion: 2, operationId: "bootstrap-one", expectedSourceDigest: protocol.publicReleaseDigest(before), currentPair, recoveryPair,
    admittedContractDigest: contractDigest, qualifications: proofs.map(proof => ({ qualificationId: proof.receipt.qualificationId, receiptDigest: protocol.publicReleaseDigest(proof.receipt) })) };
  // This exercises the installer seam and its actual SDK transaction. The
  // upstream qualifier owns the opaque preparation/capsule/500-read guards;
  // an assembled real qualifier proof is required by the later bootstrap run.
  guard = { begin: vi.fn((transaction: any) => ({ transaction, verify: vi.fn(async () => proofs), finish: vi.fn(() => 20) })) };
});
const run = (dryRun = true, changes = {}) => bootstrap.bootstrapPublicReleaseSelector({ firestore: db, attempt: { ...attempt, ...changes }, dryRun, qualificationGuard: guard, assertInstalledConsumersInTransaction: async () => {}, assertClosedFenceInTransaction: async () => {} });
it("dry-runs the exact before/after without writing or changing either pin", async () => {
  const result = await run(); expect(result.dryRun).toBe(true); expect(result.after.schemaVersion).toBe(2);
  expect(result.before).toEqual(before); expect(result.after.updatedAt).toEqual(before.updatedAt);
  expect(result.after.activeCommitSha).toBe(before.activeCommitSha); expect(result.after.activeGeneration).toBe(before.activeGeneration);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  expect((await db.doc(result.receiptPath).get()).exists).toBe(false);
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()!.phase).toBe("ready");
});
it("atomically installs OLD and one immutable source-bound receipt, then returns an exact no-op", async () => {
  const first = await run(false), again = await run(false);
  expect(first.idempotent).toBe(false); expect(again.idempotent).toBe(true); expect(again.receipt).toEqual(first.receipt);
  const stored = (await db.doc("system/publicDeployment").get()).data()!;
  expect(stored.selectedPair.pairId).toBe(currentPair.pairId); expect(stored.epoch).toBe(1); expect(stored.updatedAt).toEqual(before.updatedAt);
  expect(first.receipt.sourceDigest).toBe(protocol.publicReleaseDigest(before));
  expect((await db.collection("system/publicDeployment/bootstrapSelectors").get()).size).toBe(1);
  expect(pointer.readPublicDeploymentPointer(stored)).toEqual(before);
  const rpc = await serving.readPublicReleaseSelector({ firestore: db, environment: "development" });
  expect(protocol.parsePublicReleaseSelector(rpc.selector).selectedPair.pairId).toBe(currentPair.pairId);
});
it("refuses a mismatched source, unverified provider, unknown root or missing actual guard", async () => {
  await expect(run(false, { expectedSourceDigest: "0".repeat(64) })).rejects.toThrow();
  const base = work.publicReleasePairPath(currentPair.pairId);
  await db.doc(`${base}/rollouts/publisher`).update({ state: "uncertain" }); await expect(run(false)).rejects.toThrow();
  await db.doc(`${base}/rollouts/publisher`).update({ state: "verified" });
  await expect(bootstrap.bootstrapPublicReleaseSelector({ firestore: db, attempt, dryRun: false } as any)).rejects.toThrow();
  await db.doc("system/publicDeployment").set({ schemaVersion: 2, nonsense: true }); await expect(run(false)).rejects.toThrow();
});
it("creates absent initial serving heads only from both late-qualified witnesses in the root CAS",async()=>{
  for(const pair of pairs)await db.doc(`${work.publicReleasePairPath(pair.pairId)}/heads/current`).delete();
  const dry=await run();expect(dry.after.contentHead.viewId).toBe(proofs[0].receipt.witnessDigest);
  expect(dry.headInitializations).toHaveLength(2);expect(dry.headInitializations.every((head:any)=>head.before===null)).toBe(true);
  for(const pair of pairs)expect((await db.doc(`${work.publicReleasePairPath(pair.pairId)}/heads/current`).get()).exists).toBe(false);
  const result=await run(false);expect(result.after.contentHead.viewId).toBe(proofs[0].receipt.witnessDigest);
  for(const [index,pair]of pairs.entries())expect((await db.doc(`${work.publicReleasePairPath(pair.pairId)}/heads/current`).get()).data()).toEqual({
    schemaVersion:2,pairDigest:protocol.publicReleaseDigest(pair),contentHead:{pairId:pair.pairId,viewId:proofs[index].receipt.witnessDigest,
      manifestDigest:proofs[index].witness.contentViewDigest,contextSequence:proofs[index].witness.headCursor.sequence}});
});
it("refuses late-guard failures without leaving a converted root or receipt", async () => {
  guard = { begin: (transaction: any) => ({ transaction, verify: async () => { throw new Error("Qualification is stale"); }, finish() {} }) };
  await expect(run(false)).rejects.toThrow(); expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  expect((await db.collection("system/publicDeployment/bootstrapSelectors").get()).empty).toBe(true);
});
it("has one outcome for concurrent identical installs and refuses a later selector or different attempt", async () => {
  const [first, second] = await Promise.all([run(false), run(false)]);
  expect(first.receipt).toEqual(second.receipt); expect(Number(first.idempotent) + Number(second.idempotent)).toBe(1);
  await expect(run(false, { operationId: "other-bootstrap" })).rejects.toThrow();
  await db.doc("system/publicDeployment").update({ epoch: 2 }); await expect(run(false)).rejects.toThrow();
});
it("keeps real legacy Page authority readable and the real coordinator's activation writer closed", async () => {
  const document = pageDocument(), operationId = "O".repeat(20);
  const state = { schemaVersion: 1, pageId: "contact", operationId, sourceVersion: document.published.sourceVersion,
    path: "/contact/", ownedPaths: ["/contact/"], visible: true, rendererSha: currentPair.commitSha, generation: before.activeGeneration,
    snapshotDigest: pages.digest(document.published), servingEnabled: true, runtime: { owner: "cloudflare", release: currentPair.commitSha } };
  await db.doc("cmsPages/contact").set(document);
  await db.doc(`${pages.PAGE_OWNER_COLLECTION}/contact`).set(state);
  await pages.pageRouteRef(db, "/contact/").set({ schemaVersion: 1, pageId: "contact", path: "/contact/" });
  await db.doc(pages.PAGE_CAPABILITY_PATH).set({ schemaVersion: 1, rendererSha: currentPair.commitSha, servingEnabled: true, generation: before.activeGeneration });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
    families: { pages: { mode: "ids", ids: ["contact"] } }, backgroundBucket: target.backgroundBucket });
  await run(false);
  const served = await pageServing.readNoBuildPageDecision({ firestore: db, path: "/contact/", rendererSha: currentPair.commitSha, target });
  expect(served.kind).toBe("page"); expect(served.published.page.pageId).toBe("contact");
  const unowned = await pageServing.readNoBuildPageDecision({ firestore: db, path: "/give/", rendererSha: currentPair.commitSha, target });
  expect(unowned.kind).toBe("context-page"); expect(unowned.renderContext.pageId).toBe("give");
  const authority = await db.runTransaction(transaction => pageServing.readPageAuthorityInTransaction({ firestore: db, transaction, state,
    rendererSha: currentPair.commitSha, target }), { readOnly: true });
  expect(authority.codeGeneration).toBe(before.activeGeneration); expect(authority.document.published).toEqual(document.published);
  const actualRoot = (await coordinator.publicDeploymentRef(db).get()).data();
  expect(pointer.readPublicDeploymentPointer(actualRoot).activeCommitSha).toBe(currentPair.commitSha);
  expect(deployment.assertPublishedMediaReadiness(actualRoot).activeCommitSha).toBe(currentPair.commitSha);
  expect(() => deployment.assertMediaLifecycleDeploymentFence(actualRoot)).toThrow();
  await expect(coordinator.reservePublicBuildBatch({ firestore: db, buildBatchId: "must-refuse", commitSha: currentPair.commitSha, target })).rejects.toThrow();
  expect((await db.doc("system/publicDeployment/buildBatches/must-refuse").get()).exists).toBe(false);
});

it("measures one real isolated dev selector document without touching the shared selector", async () => {
  const measurementId = "00000000-0000-4000-8000-000000000001", selector = releaseSelector();
  await db.doc(`system/publicReleaseRoutingMeasurements/selectors/${measurementId}`).set(selector);
  const get = vi.spyOn(db, "doc");
  const result = await measurement.readPrivateRoutingMeasurementSelector({ firestore: db, measurementId, now: () => 1234 });
  expect(result).toEqual({ environment: "development", selector, readStartedAt: 1234 });
  expect(get.mock.calls.map(([path]) => path)).toEqual([`system/publicReleaseRoutingMeasurements/selectors/${measurementId}`]);
  get.mockRestore();
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  await expect(measurement.readPrivateRoutingMeasurementSelector({ firestore: db, measurementId: "../publicDeployment" })).rejects.toThrow();
  await expect(measurement.readPrivateRoutingMeasurementSelector({ firestore: { projectId: "njpbs-site", doc: () => { throw new Error("Touched production"); } }, measurementId })).rejects.toThrow("mixed publication database");
});
it("preserves an accepted Post withdrawal after the actual bootstrap CAS", async () => {
  const state={schemaVersion:1,postId:"withdrawn",operationId:"P".repeat(20),sourceVersion:2,slug:"withdrawn",ownedSlugs:["withdrawn"],
    visible:false,rendererSha:currentPair.commitSha,servingEnabled:true,generation:before.activeGeneration};
  await db.doc(`${postOwners.OWNER_COLLECTION}/withdrawn`).set(state);
  await db.doc("cmsPosts/withdrawn").set({type:"post",status:"archived",publiclyVisible:false,published:{sourceVersion:2,metadata:{slug:"withdrawn"}}});
  await db.doc("system/publicDeployment/contexts/public").set({schemaVersion:1,revision:1});
  await db.doc(postOwners.CAPABILITY_PATH).set({schemaVersion:2,rendererSha:currentPair.commitSha,servingEnabled:true,generation:before.activeGeneration});
  await run(false);
  const result=await posts.readNoBuildPostDecision({firestore:db,path:"/posts/withdrawn/",rendererSha:currentPair.commitSha});
  expect(result.kind).toBe("gone");expect(result.receipt.operationId).toBe(state.operationId);
  expect((await db.doc("system/publicDeployment").get()).data()?.schemaVersion).toBe(2);
});
it("creates an immutable measurement only from the real accepted dev root and both actual retained pairs", async () => {
  const measurementId="00000000-0000-4000-8000-000000000003";
  await expect(measurement.createPrivateRoutingMeasurementSelector({firestore:db,measurementId,expectedSourceDigest:protocol.publicReleaseDigest(before),dryRun:false})).rejects.toThrow();
  await run(false);const root=(await db.doc("system/publicDeployment").get()).data()!;
  const input={firestore:db,measurementId,expectedSourceDigest:protocol.publicReleaseDigest(root)};
  const dry=await measurement.createPrivateRoutingMeasurementSelector(input);expect(dry.dryRun).toBe(true);
  expect((await db.doc(`system/publicReleaseRoutingMeasurements/selectors/${measurementId}`).get()).exists).toBe(false);
  const first=await measurement.createPrivateRoutingMeasurementSelector({...input,dryRun:false});expect(first.idempotent).toBe(false);
  expect(await measurement.createPrivateRoutingMeasurementSelector({...input,dryRun:false})).toMatchObject({idempotent:true,receipt:first.receipt});
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(root);
  await expect(measurement.createPrivateRoutingMeasurementSelector({...input,expectedSourceDigest:"0".repeat(64),dryRun:false})).rejects.toThrow();
  await db.doc(`${work.publicReleasePairPath(recoveryPair.pairId)}/controls/runtime`).update({status:"retired"});
  await expect(measurement.createPrivateRoutingMeasurementSelector({...input,measurementId:"00000000-0000-4000-8000-000000000004",dryRun:false})).rejects.toThrow();
});

it("refuses the initial CAS without the installed-consumer guard or when that real transaction guard fails", async () => {
  await expect(bootstrap.bootstrapPublicReleaseSelector({ firestore: db, attempt, dryRun: false, qualificationGuard: guard } as any)).rejects.toThrow();
  await expect(bootstrap.bootstrapPublicReleaseSelector({ firestore: db, attempt, dryRun: false, qualificationGuard: guard,
    assertClosedFenceInTransaction: async () => {},
    assertInstalledConsumersInTransaction: async ({ transaction }: any) => {
      expect(typeof transaction.get).toBe("function"); throw new Error("Installed consumers are not adopted");
    } })).rejects.toThrow("Installed consumers are not adopted");
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  expect((await db.collection("system/publicDeployment/bootstrapSelectors").get()).empty).toBe(true);
});

it("routes the enabled private M28 bridge only to its isolated development document", async () => {
  const measurementId = "00000000-0000-4000-8000-000000000002", selector = releaseSelector();
  await db.doc(`system/publicReleaseRoutingMeasurements/selectors/${measurementId}`).set(selector);
  const response = () => ({ statusCode: 200, value: null as any, set() { return this; }, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.value = value; return this; } });
  const request = { method: "POST", body: { mode: "release-routing-measurement-v2", measurementId } };
  const handler = (enabled: boolean, environment = "development") => publicContent.createCmsGetPublicPageHandler({ firestore: db,
    routingMeasurementEnabled: enabled, target: { environment }, log: { error() {} } });
  const success = response(); await handler(true)(request, success);
  expect(success.statusCode).toBe(200); expect(success.value.selector).toEqual(selector);
  for (const [enabled, environment] of [[false, "development"], [true, "production"]] as const) {
    const refused = response(); await handler(enabled, environment)(request, refused); expect(refused.statusCode).toBe(503);
  }
  const extra = response(); await handler(true)({ ...request, body: { ...request.body, path: "system/publicDeployment" } }, extra);
  expect(extra.statusCode).toBe(503); expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
});

// Test the real operator's pre-ADC export gate. A future owner can be present
// without installed readiness: its closed fence alone must still refuse.
it("requires the installed-consumer guard as well as the writer fence before operator ADC",()=>{
  const fence=async()=>{};
  for(const owner of [null,{}, {assertClosedBootstrapFenceInTransaction:fence},
    {assertInstalledPublicReleaseConsumersInTransaction:async()=>{}}]){
    expect(()=>requireBootstrapAdoptionOwner(owner)).toThrow("Private selector bootstrap was refused");
  }
});

it("preserves real uploaded Page media through the original bootstrap and actual source/context readers",async()=>{
 const document=pageDocument();document.published.metadata.heroBackgroundImage="bootstrap-upload";
 const asset={id:"bootstrap-upload",altText:"Bootstrap Page",source:"upload",lifecycle:"active",kind:"image",url:"https://media.njpbs.org/cms-media/bootstrap.webp",mimeType:"image/webp",width:640,height:360};
 await db.doc("cmsPages/contact").set(document);
 await db.doc("media_assets/bootstrap-upload").set(asset);await db.doc("media_assets_public/bootstrap-upload").set(JSON.parse(JSON.stringify(mediaContract.mediaProjection(asset))));
 await db.doc(pages.PAGE_CAPABILITY_PATH).set({schemaVersion:1,rendererSha:currentPair.commitSha,servingEnabled:true,generation:before.activeGeneration});
 await db.doc("system/publicDeployment/contexts/public").set({schemaVersion:1,revision:1});
 await db.doc("system/noBuildPostAdmission").set({schemaVersion:2,revision:1,enabled:true,families:{pages:{mode:"ids",ids:["contact"]}},backgroundBucket:target.backgroundBucket});
 expect((await pageSource.readSelectedNoBuildPageProjection({firestore:db,pageId:"contact",target}))?.page.assets["bootstrap-upload"].url).toBe(asset.url);
 expect((await pageServing.readNoBuildPageDecision({firestore:db,path:"/contact/",rendererSha:currentPair.commitSha,target})).kind).toBe("context-page");
 await run(false);
 const source=await pageSource.readSelectedNoBuildPageProjection({firestore:db,pageId:"contact",target});
 expect(source?.page.assets["bootstrap-upload"].url).toBe(asset.url);
 const served=await pageServing.readNoBuildPageDecision({firestore:db,path:"/contact/",rendererSha:currentPair.commitSha,target});
 expect(served.kind).toBe("context-page");expect(served.renderContext.page.assets["bootstrap-upload"].url).toBe(asset.url);
 await db.doc("system/publicDeployment/pairMedia/current").delete();
 await expect(pageSource.readSelectedNoBuildPageProjection({firestore:db,pageId:"contact",target})).rejects.toThrow();
 await expect(pageServing.readNoBuildPageDecision({firestore:db,path:"/contact/",rendererSha:currentPair.commitSha,target})).rejects.toThrow();
});

it("creates only the exact qualified initial media record in the same root CAS and refuses later corruption",async()=>{
 const path="system/publicDeployment/pairMedia/current",dry=await run();
 expect(dry.mediaInitialization).toEqual({path,before:null,after:{schemaVersion:2,epoch:1,activeGeneration:before.activeGeneration,
  lastReservedGeneration:before.lastReservedGeneration,newestEligibleGeneration:before.newestEligibleGeneration,
  references:pairs.map((pair,index)=>({pairId:pair.pairId,manifestDigest:proofs[index].witness.contentViewDigest})).sort((a,b)=>a.pairId.localeCompare(b.pairId))}});
 expect((await db.doc(path).get()).exists).toBe(false);
 const expected=dry.mediaInitialization!.after;
 await db.doc(path).set({...expected,references:expected.references.map((ref:any,index:number)=>index===0?{...ref,manifestDigest:"f".repeat(64)}:ref)});
 await expect(run(false)).rejects.toThrow();expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
 await db.doc(path).set(expected);const updateTime=(await db.doc(path).get()).updateTime;
 const applied=await run(false);expect(applied.mediaInitialization).toBeNull();expect((await db.doc(path).get()).updateTime).toEqual(updateTime);
 await db.doc(path).update({references:expected.references.map((ref:any,index:number)=>index===0?{...ref,manifestDigest:"f".repeat(64)}:ref)});
 await expect(run(false)).rejects.toThrow();
});
