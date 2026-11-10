import {afterAll,beforeAll,beforeEach,expect,it}from "vitest";
import {initializeApp,deleteApp}from "firebase-admin/app";
import {getFirestore,type Firestore}from "firebase-admin/firestore";
import {readFileSync}from "node:fs";
import {seedSwitch,fixtureGuard,fixtureReadOwner}from "../helpers/public-release-switch.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import switches from "../../functions/lib/public-release-switch.js";
import serving from "../../functions/lib/public-release-serving.js";
import admissions from "../../functions/lib/public-release-admission.js";
import producer from "../../functions/lib/public-release-producer.js";
import target from "../../functions/lib/publication-target.js";
import {routingStore}from "../helpers/public-release-routing-store";
import {writePublicReleasePairView}from "../../site/scripts/public-release-pair-view-storage";
import {createPublicReleaseSlot}from "../../workers/src/public-release-slot";
import {replayBaselineFixture}from "../helpers/public-release-pair-replay-baseline";
import replay from "../../functions/lib/public-release-pair-replay.js";
import log from "../../functions/lib/public-release-change-log.js";
import type {PairViewStore}from "../../site/scripts/public-release-pair-view-storage";
let app:ReturnType<typeof initializeApp>,db:Firestore;
const hash=protocol.publicReleaseDigest;
beforeAll(()=>{if(!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST??""))throw new Error("Use assigned loopback emulator");
 app=initializeApp({projectId:"njpbs-site-dev"},"layer4-activated-serving");db=getFirestore(app);});
afterAll(async()=>{await deleteApp(app);});
beforeEach(async()=>{await db.recursiveDelete(db.collection("system"));await db.recursiveDelete(db.collection("cmsPosts"));await db.recursiveDelete(db.collection("cmsPages"));await db.recursiveDelete(db.collection("cmsPublishQueue"));});
async function stage(pair:any){const store=routingStore(),identity={schemaVersion:2 as const,pair:protocol.publicReleasePairReference(pair),kind:"qualification"as const,
 sourceOperationId:"qualified-original",sourceVersion:7,snapshotDigest:"1".repeat(64),contextSequence:0,inputManifestDigest:"2".repeat(64)},claimDigest="3".repeat(64);
 const cursor={baselineDigest:"1".repeat(64),sequence:0,lastDigest:"1".repeat(64)};
 const view=await writePublicReleasePairView({store,pair,identity,claimDigest,cursor,outputs:(async function*(){yield{path:"/about/",status:200 as const,
  bytes:new TextEncoder().encode("verified activated original"),headers:{"cache-control":"no-store","content-type":"text/html","x-njpbs-renderer-sha":pair.commitSha}};})()});
 const base=work.publicReleasePairPath(pair.pairId),head={pairId:pair.pairId,viewId:"activated-original",manifestDigest:view.manifestDigest,contextSequence:0};
 await db.doc(`${base}/views/${view.manifestDigest}`).set({schemaVersion:2,status:"staged",pairDigest:hash(pair),taskId:hash(identity),identity,claimDigest,cursor,
  manifestDigest:view.manifestDigest,manifestBytes:view.manifestBytes,manifestKey:view.manifestKey});return{store,head,base};}
async function publicResponse(pair:any,store:ReturnType<typeof routingStore>,path="/about/",composedReadersEnabled=false){const selection=await serving.readPublicReleaseSelector({firestore:db,environment:"development"});
 const slot=createPublicReleaseSlot({pair,workerVersionId:pair.publicWorker.versionId,store,getDecision:(selection,path)=>serving.readPublicReleaseDecision({firestore:db,environment:"development",pair,selection,path,composedReadersEnabled})});
 return slot.serve(new Request(`https://dev-public.example.org${path}`),selection);}
it("keeps an actual pending admission from pausing unaffected activated content",async()=>{
 const contract={schemaVersion:2,families:["posts"],features:[]},fixture=await seedSwitch(db,{admittedContract:contract}),{store,head,base}=await stage(fixture.old);
 await db.doc("system/publicDeployment").update({contentHead:head});await db.doc(`${base}/heads/current`).set({schemaVersion:2,pairDigest:hash(fixture.old),contentHead:head});
 await db.doc(`${admissions.CONTRACTS}/${hash(contract)}`).set(contract);await db.doc(`${admissions.ADMISSIONS}/controls/adoption`).set({schemaVersion:2,enabled:true});
 await db.doc("system/noBuildPostAdmission").update({backgroundBucket:target.publicationTarget("development").backgroundBucket});
 const snapshot=JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json",import.meta.url),"utf8")).document.published;
 const change=producer.publicContentChange("cmsPosts","new-pending",{published:snapshot}),source=admissions.publicationSource({...change,family:"posts"});
 await db.runTransaction(async transaction=>{const prepared=await admissions.preparePairPublicationInTransaction({firestore:db,transaction,operationId:"P".repeat(20),source,change,contextRevision:13});
  prepared.write();transaction.set(db.doc("cmsPosts/new-pending"),{type:"post",status:"published",publiclyVisible:true,published:snapshot});transaction.update(db.doc("system/publicDeployment/contexts/public"),{revision:13});});
 expect((await db.doc("system/publicReleaseChanges").get()).data()?.sequence).toBe(1);expect((await db.doc(`cmsPublishQueue/${"P".repeat(20)}`).get()).data()?.status).toBe("pending");
 const result=await publicResponse(fixture.old,store);expect(result.kind).toBe("response");if(result.kind==="response")expect(await result.response.text()).toBe("verified activated original");
 // A private qualification ahead of activation cannot silently change serving.
 await db.doc(`${base}/heads/current`).update({contentHead:{...head,contextSequence:1,manifestDigest:"f".repeat(64),viewId:"qualified-ahead"}});
 expect((await publicResponse(fixture.old,store)).kind).toBe("response");
});
it("serves immediately after the actual switch appends its original-pair CODE C+1 event",async()=>{
 const fixture=await seedSwitch(db),{store,head}=await stage(fixture.next);
 const qualification={...fixture.qualifications[1],contentHead:head},witness={...fixture.witness,newQualificationDigest:hash(qualification)};
 const attempt={...fixture.attempt,witnessDigest:hash(witness)};
 await db.doc(`${work.publicReleasePairPath(fixture.next.pairId)}/switchQualifications/${hash(qualification)}`).set(qualification);
 await db.doc(`${switches.WITNESSES}/${hash(witness)}`).set(witness);
 await switches.reservePublicReleaseSwitch({firestore:db,attempt});
 await switches.applyPublicReleaseSwitch({firestore:db,attempt,qualificationReadOwner:fixtureReadOwner,assertQualificationsCurrentInTransaction:fixtureGuard,assertAcceptedWorkIncludedInTransaction:fixtureGuard});
 const global=(await db.doc("system/publicReleaseChanges").get()).data()!;expect(global.sequence).toBe(1);
 expect((await db.doc("system/publicDeployment").get()).data()?.contentHead.contextSequence).toBe(0);
 const result=await publicResponse(fixture.next,store);expect(result.kind).toBe("response");if(result.kind==="response")expect(result.response.status).toBe(200);
 await db.doc(`${switches.RECEIPTS}/${attempt.operationId}`).update({attemptDigest:"0".repeat(64)});
 await expect(publicResponse(fixture.next,store)).rejects.toThrow();
});
it("opens the actual certified composed capsule at the activated anchor while the real log accepts a later event",async()=>{
 const store=routingStore(),fixture=await replayBaselineFixture(db,store as unknown as PairViewStore);await fixture.initialize();
 const sealed=await replay.sealPublicReleasePairReplayWitness({firestore:db,pair:fixture.pair});
 const root=protocol.parseStoredPublicReleaseSelector((await db.doc("system/publicDeployment").get()).data());
 const head={pairId:fixture.pair.pairId,viewId:sealed.witnessDigest,manifestDigest:sealed.witness.contentViewDigest,contextSequence:sealed.witness.headCursor.sequence};
 // Private serving arena: this fixture models an already activated root. It
 // does not claim a bootstrap, qualification endpoint or terminal receipt.
 await db.doc("system/publicDeployment").set({...root,selectedPair:protocol.publicReleasePairReference(fixture.pair),recoveryPair:root.selectedPair,
  activeCommitSha:fixture.pair.commitSha,contentHead:head});
 const base=work.publicReleasePairPath(fixture.pair.pairId);
 await db.doc(`${base}/controls/runtime`).update({status:"retained"});
 await db.doc(`${base}/heads/current`).set({schemaVersion:2,pairDigest:hash(fixture.pair),contentHead:head});
 await db.runTransaction(async transaction=>{const prepared=await log.preparePublicReleaseChangeInTransaction({firestore:db,transaction,input:{operationId:"accepted-after-activation",
  pair:protocol.publicReleasePairReference(fixture.pair),contextRevision:5,changes:[{kind:"post",id:"pending-next",action:"publish",sourceVersion:1,snapshotDigest:"7".repeat(64)}]}});prepared.write();});
 const result=await publicResponse(fixture.pair,store,"/posts/story/",true);expect(result.kind).toBe("response");
 if(result.kind==="response")expect(result.response.status).toBe(200);
 expect((await db.doc("system/publicDeployment").get()).data()?.contentHead).toEqual(head);
 expect(sealed.witness.headCursor.sequence).toBe(0);expect((await db.doc("system/publicReleaseChanges").get()).data()?.sequence).toBe(1);
},30_000);
