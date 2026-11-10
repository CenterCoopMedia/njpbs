import {expect,it}from "vitest";
import {releasePair,releaseSelector,pairReference}from "./helpers/private-public-release-pair.js";
import {routingStore}from "./helpers/public-release-routing-store";
import {writePublicReleasePairView}from "../site/scripts/public-release-pair-view-storage";
import {serveCommittedPairRecovery,servePreviousVerifiedPairRecovery}from "../workers/src/public-release-recovery";
import codec from "../functions/lib/public-release-routing-mirror-codec.js";
import protocol from "../functions/lib/public-release-pair.js";
import {ROOT_RECEIPT_PATH}from "../packages/content-core/src/public-release-routing";
const at=1_800_000_000_000,pairs=[releasePair(),releasePair("b","b".repeat(40))];
async function fixture(){
 const store=routingStore();
 for(const pair of pairs){const identity={schemaVersion:2 as const,pair:pairReference(pair),kind:"qualification"as const,sourceOperationId:"retained-head",sourceVersion:7,
  snapshotDigest:"1".repeat(64),contextSequence:2,inputManifestDigest:"2".repeat(64)},claimDigest="3".repeat(64);
  const view=await writePublicReleasePairView({store,pair,identity,claimDigest,cursor:{baselineDigest:"4".repeat(64),sequence:2,lastDigest:"5".repeat(64)},outputs:(async function*(){
   yield{path:"/contact/",status:200 as const,bytes:new TextEncoder().encode(`verified ${pair.pairId}`),headers:{"cache-control":"no-store","content-type":"text/html","x-njpbs-renderer-sha":pair.commitSha}};})()});
  const output=await import("../functions/lib/public-release-view-read.js").then(module=>module.readPublicReleasePairOutput({store,pair,locator:{pairDigest:protocol.publicReleaseDigest(pair),identity,claimDigest,manifestDigest:view.manifestDigest,manifestBytes:view.manifestBytes},path:"/contact/"}));
  if(!output)throw new Error("Missing genuine G");
  await codec.writeJson(store,`${codec.prefix(pair)}lifecycle-v1.json`,{schemaVersion:1,pairDigest:protocol.publicReleaseDigest(pair),status:"retained",validUntil:at+300_000},null);
  await codec.writeJson(store,`${codec.prefix(pair)}namespace-v1.json`,{schemaVersion:2,pairDigest:protocol.publicReleaseDigest(pair),sourceDigest:"6".repeat(64),revision:5,validUntil:at+300_000,
   routes:[{path:"/contact/",state:"fallback",canonicalPath:"/contact/",body:{locator:{pairDigest:protocol.publicReleaseDigest(pair),identity,claimDigest,manifestDigest:view.manifestDigest,manifestBytes:view.manifestBytes},
    artifactPath:"/contact/",bodyDigest:output.bodyDigest,bytes:output.bytes,mime:"text/html",source:null,verifiedSequence:2,validUntil:at+300_000}}]},null);
 }
 const selector=releaseSelector();selector.contentHead.contextSequence=3;
 return{store,selection:{environment:"development"as const,selector,readStartedAt:at},request:new Request("https://dev-public.example.org/contact/"),now:()=>at,pairs};
}
it("serves a genuine previous verified head as pending when current editorial activation is ahead",async()=>{
 const input=await fixture();expect(await serveCommittedPairRecovery(input)).toBeNull();
 const response=await servePreviousVerifiedPairRecovery(input);expect(response?.status).toBe(200);expect(await response?.text()).toContain(pairs[0].pairId);
 expect(response?.headers.get("publication-refresh")).toBe("pending");expect(response?.headers.has("x-njpbs-renderer-sha")).toBe(false);
});
it("tries only the actual retained OLD side if the selected pair has no available fallback",async()=>{
 const input=await fixture(),key=`${codec.prefix(pairs[0])}namespace-v1.json`,prior=await codec.existingJson(input.store,key);
 await codec.writeJson(input.store,key,{...prior!.value,routes:prior!.value.routes.map((route:any)=>({...route,body:null}))},prior);
 const response=await servePreviousVerifiedPairRecovery(input);expect(response?.status).toBe(200);expect(await response?.text()).toContain(pairs[1].pairId);
 expect(response?.headers.get("publication-refresh")).toBe("pending");
 const lifecycle=await codec.existingJson(input.store,`${codec.prefix(pairs[1])}lifecycle-v1.json`);
 await codec.writeJson(input.store,`${codec.prefix(pairs[1])}lifecycle-v1.json`,{...lifecycle!.value,status:"retired"},lifecycle);
 expect(await servePreviousVerifiedPairRecovery(input)).toBeNull();
});
it("never tries OLD after selected authority refuses or changes during the OLD byte read",async()=>{
 const input=await fixture(),key=`${codec.prefix(pairs[0])}namespace-v1.json`,prior=await codec.existingJson(input.store,key);
 const body=[...input.store.objects.entries()].find(([path])=>path.startsWith(`release-pairs/${pairs[0].pairId}/`)&&path.includes("/objects/"))![1],original=body.bytes;
 body.bytes=new TextEncoder().encode("corrupt");expect(await servePreviousVerifiedPairRecovery(input)).toBeNull();body.bytes=original;
 input.store.objects.delete(key);expect(await servePreviousVerifiedPairRecovery(input)).toBeNull();
 await codec.writeJson(input.store,key,{...prior!.value,routes:prior!.value.routes.map((route:any)=>({...route,body:null}))},null);
 const get=input.store.get;let changed=false;
 input.store.get=async(path:string)=>{if(!changed&&path.startsWith(`release-pairs/${pairs[1].pairId}/`)&&path.includes("/objects/")){
  changed=true;const current=await codec.existingJson({get,put:input.store.put},key);
  await codec.writeJson(input.store,key,{...current!.value,routes:[{path:"/contact/",state:"gone",canonicalPath:"/contact/",body:null}]},current);
 }return get(path);};
 expect(await servePreviousVerifiedPairRecovery(input)).toBeNull();expect(changed).toBe(true);
 expect((await servePreviousVerifiedPairRecovery(input))?.status).toBe(410);
});
it("never lets a previous verified body override current tombstones, expired leases or the root receipt",async()=>{
 const input=await fixture();const key=`${codec.prefix(pairs[0])}namespace-v1.json`,prior=await codec.existingJson(input.store,key);
 await codec.writeJson(input.store,key,{...prior!.value,routes:[{path:"/contact/",state:"gone",canonicalPath:"/contact/",body:null}]},prior);
 expect((await servePreviousVerifiedPairRecovery(input))?.status).toBe(410);
 expect(await servePreviousVerifiedPairRecovery({...input,request:new Request(`https://dev-public.example.org${ROOT_RECEIPT_PATH}`)})).toBeNull();
 expect(await servePreviousVerifiedPairRecovery({...input,now:()=>at+300_001})).toBeNull();
});

it.each(["gone","redirect"])("never replaces the selected live fallback with OLD's %s route",async state=>{
 const input=await fixture(),selectedKey=`${codec.prefix(pairs[0])}namespace-v1.json`,oldKey=`${codec.prefix(pairs[1])}namespace-v1.json`;
 const selected=await codec.existingJson(input.store,selectedKey),old=await codec.existingJson(input.store,oldKey);
 await codec.writeJson(input.store,selectedKey,{...selected!.value,routes:selected!.value.routes.map((route:any)=>({...route,body:null}))},selected);
 await codec.writeJson(input.store,oldKey,{...old!.value,routes:[{path:"/contact/",state,canonicalPath:state==="redirect"?"/about/":"/contact/",body:null}]},old);
 expect(await servePreviousVerifiedPairRecovery(input)).toBeNull();
});
