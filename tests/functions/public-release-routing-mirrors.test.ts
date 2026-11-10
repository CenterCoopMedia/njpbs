import { beforeAll,beforeEach,afterAll,expect,it } from "vitest";
import { initializeApp,deleteApp } from "firebase-admin/app";
import { getFirestore,type Firestore } from "firebase-admin/firestore";
import mirrors from "../../functions/lib/public-release-routing-mirrors.js";
import outbox from "../../functions/lib/public-release-routing-mirror-outbox.js";
import codec from "../../functions/lib/public-release-routing-mirror-codec.js";
import pages from "../../functions/lib/no-build-page-ownership.js";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { releasePair,releaseSelector,pairReference } from "../helpers/private-public-release-pair.js";
import { pageDocument } from "./fixtures/home-decision-3441.js";
import { routingStore } from "../helpers/public-release-routing-store";
import { writePublicReleasePairView } from "../../site/scripts/public-release-pair-view-storage";
import { serveCommittedPairRecovery } from "../../workers/src/public-release-recovery";
import runner from "../../functions/lib/public-release-routing-mirror-runner.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import { replayBaselineFixture } from "../helpers/public-release-pair-replay-baseline";
import { deriveRoutingCodeIndex } from "../../site/scripts/seed-public-release-routing-mirrors";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import originalBytes from "../../functions/lib/public-release-view-read.js";
import postOwners from "../../functions/lib/no-build-post-ownership.js";
import recordOwners from "../../functions/lib/no-build-record-ownership.js";
import recordContract from "../../functions/lib/no-build-record-contract.js";
import context from "../../functions/lib/public-context-revision.js";
import { frozenReplayProgramRead } from "../helpers/public-release-replay-inputs";
import privateStorage from "../../functions/lib/public-release-routing-mirror-store.js";
const pairs=[releasePair(),releasePair("b","b".repeat(40))], operationId="W".repeat(20), at=1_800_000_000_000;
let app:ReturnType<typeof initializeApp>,db:Firestore,store:ReturnType<typeof routingStore>;
beforeAll(()=>{if(!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST??""))throw new Error("Use assigned loopback demo emulator");
  app=initializeApp({projectId:"njpbs-site-dev"},"layer4-mirrors");db=getFirestore(app);});
afterAll(async()=>{await deleteApp(app);});
beforeEach(async()=>{await db.recursiveDelete(db.collection("system"));await db.recursiveDelete(db.collection("cmsPages"));await db.recursiveDelete(db.collection("cmsPosts"));store=routingStore();
  const selector=releaseSelector();const root={schemaVersion:1,state:"idle",mediaLifecycleReady:true,activeGeneration:7,
    activeDeploymentId:selector.activeDeploymentId,activeCommitSha:pairs[0].commitSha,lastReservedGeneration:7,newestEligibleGeneration:7,newestEligibleBuildBatchId:selector.newestEligibleBuildBatchId};
  const batch=db.batch();batch.set(db.doc("system/publicDeployment"),root);
  batch.set(db.doc(context.PUBLIC_CONTEXT_PATH),{schemaVersion:1,revision:1});
  batch.set(db.doc("system/publicReleaseChanges"),{schemaVersion:2,baselineDigest:"1".repeat(64),sequence:1,lastDigest:"2".repeat(64)});
  for(const pair of pairs){const base=work.publicReleasePairPath(pair.pairId);batch.set(db.doc(base),pair);
    batch.set(db.doc(`${base}/controls/runtime`),{schemaVersion:2,pairId:pair.pairId,status:"retained"});
    batch.set(db.doc(`${base}/heads/current`),{schemaVersion:2,pairDigest:protocol.publicReleaseDigest(pair),contentHead:{...selector.contentHead,pairId:pair.pairId}});}
  const document={...pageDocument(),publiclyVisible:false};const state={schemaVersion:1,pageId:"contact",operationId,sourceVersion:document.published.sourceVersion,
    visible:false,path:"/contact/",ownedPaths:["/contact/","/former-contact/"],rendererSha:pairs[0].commitSha,servingEnabled:true,generation:7,
    snapshotDigest:pages.digest(document.published),runtime:{owner:"cloudflare",release:pairs[0].commitSha}};
  batch.set(db.doc("cmsPages/contact"),document);batch.set(db.doc(`${pages.PAGE_OWNER_COLLECTION}/contact`),state);
  for(const path of state.ownedPaths)batch.set(pages.pageRouteRef(db,path),{schemaVersion:1,pageId:"contact",path});await batch.commit();});
const sync=(dryRun=false)=>mirrors.syncPublicReleaseRoutingMirrors({firestore:db,store,pairs,operationId,minimumSequence:1,dryRun,now:()=>at});
it("collects real current withdrawals even while pair replay heads lag and durably seeds both tombstone mirrors",async()=>{
  const dry=await sync(true);expect(dry.sequence).toBe(1);expect(store.objects.size).toBe(0);
  const result=await sync();expect(result.pairs).toHaveLength(2);
  for(const pair of pairs){const value=await codec.readJson(store,`${codec.prefix(pair)}namespace-v1.json`);expect(value.revision).toBe(2);
    expect(value.routes.map((row:any)=>[row.path,row.state])).toEqual([["/contact/","gone"],["/former-contact/","gone"]]);
    const response=await serveCommittedPairRecovery({store,pairs,selection:{environment:"development",selector:releaseSelector(),readStartedAt:at},
      request:new Request("https://dev-public.example.org/contact/"),now:()=>at});if(pair===pairs[0])expect(response?.status).toBe(410);}
  expect((await db.doc("system/publicDeployment").get()).data()?.schemaVersion).toBe(1);
});
it("keeps Post canonical/old slugs and every record alias withdrawn on both retained pairs",async()=>{
 const document={type:"post",version:2,status:"archived",publiclyVisible:false,published:{sourceVersion:2,metadata:{type:"post",slug:"story",previousSlugs:["old-story"]},blocks:[]}};
 await db.doc("cmsPosts/story").set(document);
 await db.doc(`${postOwners.OWNER_COLLECTION}/story`).set({schemaVersion:1,postId:"story",operationId:"P".repeat(20),sourceVersion:2,
  slug:"story",ownedSlugs:["old-story","story"],visible:false,servingEnabled:true,generation:7,rendererSha:pairs[0].commitSha,snapshotDigest:pages.digest(document.published)});
 const program={...frozenReplayProgramRead(pairs[0].commitSha).documents[0],status:"archived",publiclyVisible:false};
 Object.assign(program.published,{publishedBy:"original-editor"});
 const plan=recordContract.validateNoBuildRecordSnapshot({family:"programs",documentId:program.id,snapshot:program.published});
 await db.doc(`cmsPosts/${program.id}`).set(program);
 await db.doc(`${recordOwners.RECORD_OWNER_COLLECTION}/${program.id}`).set({schemaVersion:1,family:"programs",documentId:program.id,operationId:"R".repeat(20),
  sourceVersion:program.published.sourceVersion,snapshotDigest:recordContract.recordSnapshotDigest(program.published),canonicalPath:plan.canonicalPath,
  ownedPaths:plan.ownedPaths,visible:false,rendererSha:pairs[0].commitSha,generation:7,runtime:{owner:"cloudflare",release:pairs[0].commitSha},contextRevision:1,contextDigest:context.publicContextDigest(1),admissionRevision:1});
 for(const path of plan.ownedPaths)await recordOwners.recordRouteRef(db,path).set({schemaVersion:1,family:"programs",documentId:program.id,path});
 await sync();for(const pair of pairs){const namespace=await codec.readJson(store,`${codec.prefix(pair)}namespace-v1.json`);
  for(const path of ["/posts/story/","/posts/old-story/",...plan.ownedPaths])expect(namespace.routes.find((row:any)=>row.path===path)?.state).toBe("gone");}
});
it("refuses collection above the shared actual SDK read bound before any routing write",async()=>{
 const batch=db.batch();for(let i=0;i<499;i++)batch.set(pages.pageRouteRef(db,`/claim-${i}/`),{schemaVersion:1,pageId:"contact",path:`/claim-${i}/`});await batch.commit();
 await expect(sync()).rejects.toThrow("authority-budget-exceeded");expect(store.objects.size).toBe(0);
});
it("queues the mirror request in the actual source commit and never creates one for an aborted mutation",async()=>{
  const prepare=(transaction:any)=>outbox.preparePublicReleaseRoutingMirrorOutboxInTransaction({firestore:db,transaction,operationId,minimumSequence:1,
    entryDigest:"e".repeat(64),pairRefs:pairs.map(pairReference),environment:"development",withdrawal:true});
  await expect(db.runTransaction(async tx=>{const write=await prepare(tx);write();tx.update(db.doc("cmsPages/contact"),{title:"uncommitted"});throw new Error("abort");})).rejects.toThrow("abort");
  expect((await db.collection("system/publicReleaseRoutingMirrors/requests").get()).empty).toBe(true);
  const reference=await db.runTransaction(async tx=>{const write=await prepare(tx);tx.update(db.doc("cmsPages/contact"),{title:"committed"});return write();});
  const result=await outbox.drainPublicReleaseRoutingMirrorOutbox({firestore:db,store,requestId:reference.requestId,
    now:()=>at,sync:(input:any)=>mirrors.syncPublicReleaseRoutingMirrors({...input,now:()=>at})});expect(result.state).toBe("done");
  expect((await outbox.drainPublicReleaseRoutingMirrorOutbox({firestore:db,store,requestId:reference.requestId,sync:()=>{throw new Error("repeated effect");},now:()=>at})).state).toBe("done");
});
it("retains a durable retry and reports pending instead of acknowledging a failed withdrawal mirror",async()=>{
  const reference=await db.runTransaction(async transaction=>(await outbox.preparePublicReleaseRoutingMirrorOutboxInTransaction({firestore:db,transaction,
    operationId,minimumSequence:1,entryDigest:"e".repeat(64),pairRefs:pairs.map(pairReference),environment:"development",withdrawal:true}))());
  const result=await outbox.flushPublicReleaseRoutingMirrorWithdrawal({firestore:db,store,requestId:reference.requestId,now:()=>at,
    sync:async()=>{throw new Error("private storage unavailable");},budgetMs:100});expect(result.state).toBe("pending");
  const pending=(await db.doc(`system/publicReleaseRoutingMirrors/jobs/${reference.requestId}`).get()).data();expect(pending?.state).toBe("pending");expect(pending?.attempts).toBe(1);
  expect(await outbox.drainDuePublicReleaseRoutingMirrorOutbox({firestore:db,store,environment:"development",now:()=>at,
    sync:(input:any)=>mirrors.syncPublicReleaseRoutingMirrors({...input,now:()=>at})})).toEqual({results:[],fullBatch:false});
  const due=await outbox.drainDuePublicReleaseRoutingMirrorOutbox({firestore:db,store,environment:"development",now:()=>at+3000,
    sync:(input:any)=>mirrors.syncPublicReleaseRoutingMirrors({...input,now:()=>at+3000})});expect(due.results[0].state).toBe("done");
});
it("fails closed on missing route claims, source drift and lower mirror cursors",async()=>{
  await sync();await pages.pageRouteRef(db,"/contact/").delete();await expect(sync()).rejects.toThrow();
  await pages.pageRouteRef(db,"/contact/").set({schemaVersion:1,pageId:"contact",path:"/contact/"});
  await db.doc("system/publicReleaseChanges").update({sequence:0,lastDigest:"1".repeat(64)});
  await expect(mirrors.syncPublicReleaseRoutingMirrors({firestore:db,store,pairs,operationId,minimumSequence:0,dryRun:false,now:()=>at})).rejects.toThrow();
});
it("expires only its own provisional namespace when withdrawal timeout aborts between pair writes",async()=>{
 const abort=new AbortController(),put=store.put;let changed=false;
 store.put=async(key,bytes,options)=>{const result=await put(key,bytes,options);
  if(key.endsWith("namespace-v1.json")&&!changed){changed=true;await db.doc("cmsPages/contact").update({publiclyVisible:true});
   await db.doc(`${pages.PAGE_OWNER_COLLECTION}/contact`).update({visible:true});await db.doc("system/publicReleaseChanges").update({sequence:2,lastDigest:"6".repeat(64)});abort.abort();}
  return result;};
 await expect(mirrors.syncPublicReleaseRoutingMirrors({firestore:db,store,pairs,operationId,minimumSequence:1,dryRun:false,now:()=>at,signal:abort.signal})).rejects.toThrow();
 const namespace=await codec.readJson(store,`${codec.prefix(pairs[0])}namespace-v1.json`);expect(namespace.validUntil).toBe(1);
});
it("rolls back failed heartbeat extensions to the prior verified deadline instead of revoking recovery",async()=>{
 await mirrors.syncPublicReleaseRoutingMirrors({firestore:db,store,pairs:[pairs[0]],operationId,minimumSequence:1,dryRun:false,now:()=>at});
 const put=store.put;let changed=false;store.put=async(key,bytes,options)=>{const result=await put(key,bytes,options);
  if(key.endsWith("namespace-v1.json")&&!changed){changed=true;await db.doc("system/publicReleaseChanges").update({sequence:2,lastDigest:"6".repeat(64)});}return result;};
 expect((await mirrors.renewPublicReleaseRoutingMirrorLeases({firestore:db,store,pairs:[pairs[0]],now:()=>at+31_000})).state).toBe("pending");
 expect((await codec.readJson(store,`${codec.prefix(pairs[0])}namespace-v1.json`)).validUntil).toBe(at+300_000);
 expect((await codec.readJson(store,`${codec.prefix(pairs[0])}lifecycle-v1.json`)).validUntil).toBe(at+300_000);
});
it("serves a genuinely staged original G in cold recovery and refuses a newer known head",async()=>{
  const pair=pairs[0],cursor={baselineDigest:"1".repeat(64),sequence:1,lastDigest:"2".repeat(64)},claimDigest="3".repeat(64);
  const identity={schemaVersion:2 as const,pair:pairReference(pair),kind:"qualification" as const,sourceOperationId:operationId,sourceVersion:7,
    snapshotDigest:"4".repeat(64),contextSequence:1,inputManifestDigest:"5".repeat(64)};
  const manifest=await writePublicReleasePairView({store,pair,identity,claimDigest,cursor,outputs:(async function*(){yield{path:"/about/",status:200 as const,
    bytes:new TextEncoder().encode("verified original body"),headers:{"cache-control":"no-store","content-type":"text/html","x-njpbs-renderer-sha":pair.commitSha}};})()});
  const base=work.publicReleasePairPath(pair.pairId);await db.doc(`${base}/views/${manifest.manifestDigest}`).set({schemaVersion:2,status:"staged",pairDigest:protocol.publicReleaseDigest(pair),
    taskId:protocol.publicReleaseDigest(identity),identity,claimDigest,cursor,manifestDigest:manifest.manifestDigest,manifestBytes:manifest.manifestBytes,manifestKey:manifest.manifestKey});
  await db.doc(`${base}/heads/current`).update({contentHead:{pairId:pair.pairId,viewId:"current-view",manifestDigest:manifest.manifestDigest,contextSequence:1}});
  await mirrors.syncPublicReleaseRoutingMirrors({firestore:db,store,pairs,operationId,minimumSequence:1,fallbackPaths:["/about/"],dryRun:false,now:()=>at});
  const selection={environment:"development" as const,selector:releaseSelector(),readStartedAt:at};
  const response=await serveCommittedPairRecovery({store,pairs,selection,request:new Request("https://dev-public.example.org/about/"),now:()=>at});
  expect(await response?.text()).toBe("verified original body");expect(response?.headers.get("publication-refresh")).toBe("pending");expect(response?.headers.has("x-njpbs-renderer-sha")).toBe(false);
  await expect(serveCommittedPairRecovery({store,pairs,selection:{...selection,selector:{...selection.selector,contentHead:{...selection.selector.contentHead,contextSequence:2}}},
    request:new Request("https://dev-public.example.org/about/"),now:()=>at})).rejects.toThrow();
  const renewed=await mirrors.renewPublicReleaseRoutingMirrorLeases({firestore:db,store,pairs,now:()=>at+31_000});expect(renewed.state).toBe("pending");
  const fresh=await codec.readJson(store,`${codec.prefix(pair)}namespace-v1.json`);expect(fresh.validUntil).toBe(at+331_000);
  await db.doc("system/publicReleaseChanges").update({sequence:2,lastDigest:"6".repeat(64)});
  expect((await mirrors.renewPublicReleaseRoutingMirrorLeases({firestore:db,store,pairs:[pair],now:()=>at+62_000})).state).toBe("pending");
  const pending=await mirrors.syncPublicReleaseRoutingMirrors({firestore:db,store,pairs:[pair],operationId,minimumSequence:2,fallbackPaths:["/about/"],dryRun:false,now:()=>at+62_000});
  expect(pending.pairs[0].pendingContent).toContain("/about/");
  const lagged=await codec.readJson(store,`${codec.prefix(pair)}namespace-v1.json`);expect(lagged.routes.find((row:any)=>row.path==="/about/").body.validUntil).toBe(at+331_000);
  expect(await serveCommittedPairRecovery({store,pairs,selection,request:new Request("https://dev-public.example.org/about/"),now:()=>at+331_000})).toBeNull();
  await db.doc(`${base}/controls/runtime`).update({status:"retired"});
  await mirrors.syncPublicReleaseRoutingMirrors({firestore:db,store,pairs:[pair],operationId,minimumSequence:2,dryRun:false,now:()=>at+70_000});
  await expect(serveCommittedPairRecovery({store,pairs,selection,request:new Request("https://dev-public.example.org/about/"),now:()=>at+331_000})).rejects.toThrow();
  await db.doc(`${base}/controls/runtime`).update({status:"retained"});
  await expect(mirrors.syncPublicReleaseRoutingMirrors({firestore:db,store,pairs:[pair],operationId,minimumSequence:2,dryRun:false,now:()=>at+71_000})).rejects.toThrow();
});
it("keeps the private collector completely inert while disabled",async()=>{
 const untouched=new Proxy({},{get(){throw new Error("SDK touched");}})as Firestore;
 const collector=runner.createPublicReleaseRoutingMirrorRunner({firestore:untouched,environment:"development",getStore:async()=>{throw new Error("credential touched");}});
 expect(await collector.tick()).toEqual({state:"disabled"});
});
it("derives the immutable asset index from actual captured H, certified replay and every real original G member",async()=>{
 await db.recursiveDelete(db.collection("system"));await db.recursiveDelete(db.collection("cmsPages"));
 const fixture=await replayBaselineFixture(db,store as unknown as PairViewStore);await fixture.initialize();
 const sealed=await replay.sealPublicReleasePairReplayWitness({firestore:db,pair:fixture.pair});
 const base=work.publicReleasePairPath(fixture.pair.pairId);
 await db.doc(`${base}/controls/runtime`).update({status:"retained"});
 await db.doc(`${base}/heads/current`).set({schemaVersion:2,pairDigest:protocol.publicReleaseDigest(fixture.pair),contentHead:{pairId:fixture.pair.pairId,
  viewId:sealed.witnessDigest,manifestDigest:sealed.witness.contentViewDigest,contextSequence:sealed.witness.headCursor.sequence}});
 const send=async(command:any)=>{const value=store.objects.get(command.input.Key);if(!value)throw{$metadata:{httpStatusCode:404}};
  return{ContentLength:value.bytes.length,Metadata:value.metadata,ETag:value.etag,Body:{transformToWebStream:()=>new Blob([new Uint8Array(value.bytes)]).stream()}};};
 const realAdapter=privateStorage.createPublicReleaseRoutingMirrorStore({environment:"development",accountId:"a".repeat(32),client:{send}as any});
 const index=await deriveRoutingCodeIndex({firestore:db,store:realAdapter,pair:fixture.pair});expect(index.members).toEqual(fixture.codePack.manifest.members);
 expect((await mirrors.seedPublicReleaseRoutingCodeAssets({store,pair:fixture.pair,index,dryRun:false})).dryRun).toBe(false);
 await mirrors.syncPublicReleaseRoutingMirrors({firestore:db,store,pairs:[fixture.pair],operationId,minimumSequence:0,dryRun:false,now:()=>at});
 const namespace=await codec.readJson(store,`${codec.prefix(fixture.pair)}namespace-v1.json`);
 const wiki=namespace.routes.find((route:any)=>route.path==="/wiki/");
 expect(wiki?.state).toBe("fallback");expect(wiki?.body).not.toBeNull();
 expect((await originalBytes.readPublicReleasePairOutput({store,pair:fixture.pair,locator:wiki.body.locator,path:wiki.body.artifactPath}))?.bodyDigest).toBe(wiki.body.bodyDigest);
 const corrupted={...index,members:index.members.slice(1)};await expect(mirrors.seedPublicReleaseRoutingCodeAssets({store,pair:fixture.pair,index:corrupted,dryRun:false})).rejects.toThrow();
 const output=await originalBytes.readPublicReleasePairOutput({store,pair:fixture.pair,locator:index.view,path:index.members[0].path});
 const body=output&&store.objects.get(output.objectKey);
 if(!body)throw new Error("Missing genuine G fixture object");body.bytes=new TextEncoder().encode("corrupt");
 await expect(deriveRoutingCodeIndex({firestore:db,store:realAdapter,pair:fixture.pair})).rejects.toThrow();
},30_000);

it.each([false,true])("finishes slow real mirror work only while the original lease token is still owned (reclaimed=%s)",async reclaimed=>{
 const reference=await db.runTransaction(async transaction=>(await outbox.preparePublicReleaseRoutingMirrorOutboxInTransaction({firestore:db,transaction,
  operationId,minimumSequence:1,entryDigest:"e".repeat(64),pairRefs:pairs.map(pairReference),environment:"development",withdrawal:true}))());
 let clock=at;
 const result=await outbox.drainPublicReleaseRoutingMirrorOutbox({firestore:db,store,requestId:reference.requestId,now:()=>clock,sync:async(input:any)=>{
  const result=await mirrors.syncPublicReleaseRoutingMirrors({...input,now:()=>clock});clock+=61_000;
  if(reclaimed)await db.doc(`system/publicReleaseRoutingMirrors/jobs/${reference.requestId}`).update({leaseToken:"00000000-0000-4000-8000-000000000001",leaseUntil:clock+60_000});
  return result;
 }});
 expect(result.state).toBe(reclaimed?"pending":"done");
 expect((await db.doc(`system/publicReleaseRoutingMirrors/receipts/${reference.requestId}`).get()).exists).toBe(!reclaimed);
});
it.each([false,true])("reconciles pending positive bodies after outbox completion (withdrawal=%s)",async withdrawal=>{
 await db.doc("system/publicDeployment").set(releaseSelector());
 const reference=await db.runTransaction(async transaction=>(await outbox.preparePublicReleaseRoutingMirrorOutboxInTransaction({firestore:db,transaction,
  operationId,minimumSequence:1,entryDigest:"e".repeat(64),pairRefs:pairs.map(pairReference),environment:"development",withdrawal}))());
 const done=await outbox.drainPublicReleaseRoutingMirrorOutbox({firestore:db,store,requestId:reference.requestId,now:()=>at,
  sync:(input:any)=>mirrors.syncPublicReleaseRoutingMirrors({...input,fallbackPaths:["/about/"],now:()=>at})});expect(done.state).toBe("done");
 const receipt=(await db.doc(`system/publicReleaseRoutingMirrors/receipts/${reference.requestId}`).get()).data();
 expect(receipt?.result.pairs.every((pair:any)=>pair.pendingContent.includes("/about/"))).toBe(true);
 expect((await outbox.drainDuePublicReleaseRoutingMirrorOutbox({firestore:db,store,environment:"development",now:()=>at+31_000,
  sync:()=>{throw new Error("Completed positive mirror job was retried");}})).results).toEqual([]);
 let clock=at+301_000;const collector=runner.createPublicReleaseRoutingMirrorRunner({enabled:true,firestore:db,environment:"development",getStore:async()=>store,now:()=>clock});
 await collector.tick();
 for(const pair of pairs){const namespace=await codec.readJson(store,`${codec.prefix(pair)}namespace-v1.json`);
  expect(namespace.validUntil).toBe(clock+300_000);expect(namespace.routes.find((row:any)=>row.path==="/about/").body).toBeNull();
  expect((await codec.readJson(store,`${codec.prefix(pair)}lifecycle-v1.json`)).validUntil).toBe(clock+300_000);}
 for(const pair of pairs){const identity={schemaVersion:2 as const,pair:pairReference(pair),kind:"qualification"as const,sourceOperationId:operationId,
  sourceVersion:7,snapshotDigest:"4".repeat(64),contextSequence:1,inputManifestDigest:"5".repeat(64)},claimDigest="3".repeat(64),cursor={baselineDigest:"1".repeat(64),sequence:1,lastDigest:"2".repeat(64)};
  const manifest=await writePublicReleasePairView({store,pair,identity,claimDigest,cursor,outputs:(async function*(){yield{path:"/about/",status:200 as const,
   bytes:new TextEncoder().encode(`verified ${pair.pairId}`),headers:{"cache-control":"no-store","content-type":"text/html","x-njpbs-renderer-sha":pair.commitSha}};})()});
  const base=work.publicReleasePairPath(pair.pairId);await db.doc(`${base}/views/${manifest.manifestDigest}`).set({schemaVersion:2,status:"staged",pairDigest:protocol.publicReleaseDigest(pair),
   taskId:protocol.publicReleaseDigest(identity),identity,claimDigest,cursor,manifestDigest:manifest.manifestDigest,manifestBytes:manifest.manifestBytes,manifestKey:manifest.manifestKey});
  await db.doc(`${base}/heads/current`).update({contentHead:{pairId:pair.pairId,viewId:"current-view",manifestDigest:manifest.manifestDigest,contextSequence:1}});
 }
 clock+=31_000;await collector.tick();
 const selection={environment:"development"as const,selector:releaseSelector(),readStartedAt:clock};
 const response=await serveCommittedPairRecovery({store,pairs,selection,request:new Request("https://dev-public.example.org/about/"),now:()=>clock});
 expect(response?.status).toBe(200);expect(await response?.text()).toBe(`verified ${pairs[0].pairId}`);
 expect((await serveCommittedPairRecovery({store,pairs,selection,request:new Request("https://dev-public.example.org/contact/"),now:()=>clock}))?.status).toBe(410);
 expect((await db.doc(`system/publicReleaseRoutingMirrors/jobs/${reference.requestId}`).get()).data()?.state).toBe("done");
});
