import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {initializeApp,deleteApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import pageContext from "../../functions/lib/no-build-page-context-decision.js";
import deployment from "../../functions/lib/public-deployment.js";
import ownership from "../../functions/lib/no-build-page-ownership.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import contract from "../../functions/lib/data-hub-reporting.js";
import preview from "../../functions/lib/data-hub-reporting-preview.js";
import input from "../../functions/lib/data-hub-reporting-input.js";
import {createHash} from "node:crypto";
let app,firestore;
const now=new Date("2026-10-22T12:00:00.000Z"),sha="a".repeat(40);
const mapping={...contract.emptyReportingMapping(),posts:{tags:["wages"],categories:[]}};
const config={...contract.emptyDataHubReporting(),figures:{minimumwage:mapping}};
const post=(id,status="published")=>({id,type:"post",version:2,status,publiclyVisible:status==="published",publishAt:"2026-10-21T12:00:00.000Z",
 title:"PRIVATE working headline",tags:["PRIVATE"],published:{sourceVersion:1,publishedAt:"2026-10-21T12:00:00.000Z",publishedBy:"PRIVATE actor",blocks:[],
 metadata:{type:"post",slug:`wage-${id}`,title:`Published wage ${id}`,date:"2026-10-21",firstPublishedAt:"2026-10-21T12:00:00.000Z",editorialDateSource:"firstPublish",tags:["wages"],categories:[],credits:[{kind:"custom",name:"Published writer"}]}}});
const read=(at=now)=>firestore.runTransaction(transaction=>pageContext.readNoBuildPageContextDecision({firestore,transaction,path:"/data-hub/",rendererSha:sha,now:at}),{readOnly:true});
beforeAll(async()=>{
 if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST??"") || process.env.GCLOUD_PROJECT!=="demo-njpbs") throw new Error("Use local demo Firestore");
 app=initializeApp({projectId:"njpbs-site-dev"},"data-hub-contract");firestore=getFirestore(app);
});
afterAll(async()=>{if(app)await deleteApp(app);});
beforeEach(async()=>{
 await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`,{method:"DELETE"});
 await firestore.doc("system/publicDeployment").set({...deployment.initialPublicDeploymentPointer(),activeCommitSha:sha,activeGeneration:1,activeDeploymentId:"fixture",lastReservedGeneration:1,newestEligibleGeneration:1,newestEligibleBuildBatchId:"fixture"});
 await firestore.doc("system/publicDeployment/contexts/public").set({schemaVersion:1,revision:1});
 await firestore.doc(ownership.PAGE_CAPABILITY_PATH).set({schemaVersion:1,rendererSha:sha,servingEnabled:true,generation:1});
});
it("keeps the Data Hub publication gate closed for committed and CMS frames",async()=>{
 expect(await read()).toEqual({kind:"pass",path:"/data-hub/"});
 const published=snapshots.createPublishedSnapshot({collection:"cmsPages",document:{version:1,title:"Data Hub",slug:"data-hub",dataHubReporting:config,blocks:[]},publishedAt:now.toISOString(),publishedBy:"publisher"});
 await firestore.doc("cmsPages/data-hub").set({version:1,status:"published",publiclyVisible:true,publishAt:now.toISOString(),published});
 expect(await read()).toEqual({kind:"pass",path:"/data-hub/"});
 await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({dataHubReportingVersion:1});
 expect((await read()).kind).toBe("context-page");
});
it("refreshes published Post tags and withdrawals in the same Page context without a build",async()=>{
 const published=snapshots.createPublishedSnapshot({collection:"cmsPages",document:{version:1,title:"Data Hub",slug:"data-hub",dataHubReporting:config,blocks:[]},publishedAt:now.toISOString(),publishedBy:"publisher"});
 await firestore.doc("cmsPages/data-hub").set({version:1,status:"published",publiclyVisible:true,publishAt:now.toISOString(),published});
 await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({dataHubReportingVersion:1});
 await firestore.doc("cmsPosts/one").set(post("one"));await firestore.doc("cmsPosts/draft").set(post("draft","draft"));
 const first=await read();
 expect(first.renderContext.dataHubSources).toMatchObject({cutoffAt:now.toISOString(),posts:[{id:"one",title:"Published wage one",byline:"Published writer",tags:["wages"]}]});
 expect(JSON.stringify(first)).not.toContain("PRIVATE");
 expect(await read(new Date(now.getTime()+1000))).toEqual(first);
 await firestore.doc("cmsPosts/one").update({publiclyVisible:false,status:"draft"});
 expect((await read()).renderContext.dataHubSources.posts).toEqual([]);
});
it("authorizes live preview before any provider work and admits only the saved public Post",async()=>{
 const principal={id:"editor",grants:[{role:"editor"}]};
 await firestore.doc("cmsPosts/one").set(post("one"));await firestore.doc("cmsPosts/draft").set(post("draft","draft"));
 let calls=0;const fetchImpl=async()=>{calls++;return Response.json([]);};
 await expect(preview.readReportingPreview({firestore,principal:{id:"nobody",grants:[]},body:{action:"preview",mapping},fetchImpl,clock:()=>now.getTime()})).rejects.toMatchObject({status:403});
 expect(calls).toBe(0);
 const result=await preview.readReportingPreview({firestore,principal,body:{action:"preview",mapping},fetchImpl,clock:()=>now.getTime()});
 expect(result.stories.map(story=>story.id)).toEqual(["one"]);expect(calls).toBe(0);
});
it("loads optional reporting from the exact retained Spotlight file and rejects changed bytes",async()=>{
 const payload=Buffer.from(JSON.stringify({cards:[],dataHubReporting:{schemaVersion:1,queries:{},pins:{key:"",checkedAt:null,failed:false,stories:[]}}}));
 const operationId="R".repeat(20),digest=createHash("sha256").update(payload).digest("hex");
 const files=Object.fromEntries(["launch-media-manager.json","spotlight-news.json","schedule.json"].map(name=>[name,{key:`post-background-v1/external-inputs/${operationId}/${name}`,digest,size:payload.length}]));
 const inputs={schemaVersion:1,operationId,runtime:{owner:"cloudflare",release:sha},contentDigest:"b".repeat(64),checkedAt:now.getTime(),files};
 expect(await input.readRetainedReporting({inputs,read:async()=>payload})).toMatchObject({schemaVersion:1,queries:{}});
 await expect(input.readRetainedReporting({inputs,read:async()=>Buffer.from("changed")})).rejects.toThrow(/bytes changed/);
 const legacy=Buffer.from('{"cards":[]}');inputs.files["spotlight-news.json"]={...files["spotlight-news.json"],digest:createHash("sha256").update(legacy).digest("hex"),size:legacy.length};
 expect(await input.readRetainedReporting({inputs,read:async()=>legacy})).toBeUndefined();
});
