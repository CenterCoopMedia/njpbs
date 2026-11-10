/** Private operator with an explicit invocation boundary.
 * Opens actual H and the replay owner's certified original G. No mutable dist,
 * caller-provided inventory, fabricated witness or qualification boolean. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { applicationDefault,deleteApp,initializeApp } from "firebase-admin/app";
import { getFirestore,type Firestore } from "firebase-admin/firestore";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import log from "../../functions/lib/public-release-change-log.js";
import codec, {type RoutingMirrorStore,type RoutingCodeIndex} from "../../functions/lib/public-release-routing-mirror-codec.js";
import mirrors from "../../functions/lib/public-release-routing-mirrors.js";
import storage from "../../functions/lib/public-release-routing-mirror-store.js";
import targets from "../../functions/lib/publication-target.js";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import { readFrozenPublicReleasePairCodePackManifest } from "./public-release-pair-code-pack-storage";
import { readPublicReleasePairView,type PairViewStore } from "./public-release-pair-view-storage";
const fail=():never=>{throw new codec.RoutingMirrorError();};
function exact(value:any,keys:string[]){if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join("\n")!==[...keys].sort().join("\n"))fail();}
export async function deriveRoutingCodeIndex({firestore,store,pair:rawPair,signal}:{firestore:Firestore;store:RoutingMirrorStore;pair:PublicReleasePair;signal?:AbortSignal}):Promise<RoutingCodeIndex>{
 const pair=protocol.parsePublicReleasePair(rawPair);work.assertPrivatePairResources(pair);work.assertPublicReleasePairDatabase(firestore,pair);
 const replay=await import(new URL("../../functions/lib/public-release-pair-replay.js",import.meta.url).href).then(module=>module.default??module).catch(fail);
 if(typeof replay.openPublicReleasePairReplayWitnessProof!=="function")fail();
 const base=work.publicReleasePairPath(pair.pairId);
 const [row,headRow,controlRow,changesRow]=await firestore.getAll(firestore.doc(base),firestore.doc(`${base}/heads/current`),firestore.doc(`${base}/controls/runtime`),firestore.doc("system/publicReleaseChanges"));
 if(!codec.same(protocol.parsePublicReleasePair(row.data()),pair)||controlRow.data()?.status!=="retained")fail();
 const changes=log.parsePublicReleaseChangeHead(changesRow.data()),head=headRow.data();
 if(!head)fail();
 if(head!.schemaVersion!==2||head!.pairDigest!==protocol.publicReleaseDigest(pair)||head!.contentHead?.pairId!==pair.pairId||head!.contentHead.contextSequence!==changes.sequence)fail();
 const proof=await replay.openPublicReleasePairReplayWitnessProof({firestore,pair,headCursor:{baselineDigest:changes.baselineDigest,sequence:changes.sequence,lastDigest:changes.lastDigest},witnessDigest:head!.contentHead.viewId});
 if(proof.witness.contentViewDigest!==head!.contentHead.manifestDigest)fail();
 // These openers only read. The put type is irrelevant until the verified
 // routing index is conditionally written by the separate collector below.
 const readStore=store as unknown as PairViewStore;
 const pack=await readFrozenPublicReleasePairCodePackManifest({firestore,store:readStore,pair,signal});
 const reference=codec.locator({pairDigest:protocol.publicReleaseDigest(pair),...proof.witness.codePackView},pair);
 if(reference.identity.inputManifestDigest!==pack.receipt.inputManifestDigest)fail();
 const expected=new Map(pack.manifest.members.map(member=>[member.path,member]));let count=0;
 for await(const output of readPublicReleasePairView({store:readStore,pair,...reference,signal})){
  const member=expected.get(output.path);
  if(!member||output.status!==200||output.bytes!==member.size||output.bodyDigest!==member.sha256||output.headers["content-type"]!==member.mime)fail();
  expected.delete(output.path);count++;
 }
 if(expected.size||count!==pack.manifest.members.length)fail();
 return codec.parseCodeIndex({schemaVersion:1,pairDigest:protocol.publicReleaseDigest(pair),codeAssetManifestDigest:pair.codeAssetManifestDigest,view:reference,members:pack.manifest.members},pair);
}
export async function seedRoutingMirrors({firestore,store,pairs,operationId,dryRun=true,signal}:{firestore:Firestore;store:RoutingMirrorStore;
 pairs:PublicReleasePair[];operationId:string;dryRun?:boolean;signal?:AbortSignal}){
 if(!pairs.length||pairs.length>2||pairs.some(pair=>pair.environment!==pairs[0].environment))fail();
 const indexes=[];for(const pair of pairs)indexes.push(await deriveRoutingCodeIndex({firestore,store,pair,signal}));
 // Verify BOTH original packs completely before the first routing write.
 const code=[];for(const [index,pair]of pairs.entries())code.push(await mirrors.seedPublicReleaseRoutingCodeAssets({store,pair,index:indexes[index],dryRun,signal}));
 const result=await mirrors.syncPublicReleaseRoutingMirrors({firestore,store,pairs,operationId,minimumSequence:0,dryRun,signal});
 return{code,result};
}
export async function runRoutingMirrorSeedOperator(args:string[]){
 const apply=args.length===7&&args[6]==="--apply";
 if(args[0]!=="--pairs"||args[2]!=="--account-id"||args[4]!=="--credential-fd"||!(args.length===6||apply)||!/^\d+$/.test(args[5]??"")||Number(args[5])<3||
  apply&&(process.env.FIRESTORE_EMULATOR_HOST||process.env.FIREBASE_AUTH_EMULATOR_HOST))fail();
 const bytes=await readFile(args[1]);if(bytes.length>64*1024)fail();const input=JSON.parse(bytes.toString("utf8"));
 exact(input,["pairs","operationId"]);if(!Array.isArray(input.pairs)||!input.pairs.length||input.pairs.length>2)fail();
 const pairs=input.pairs.map(protocol.parsePublicReleasePair)as PublicReleasePair[];
 let credential:Promise<{accessKeyId:string;secretAccessKey:string}>|undefined;
 const store=storage.createPublicReleaseRoutingMirrorStore({environment:pairs[0].environment,accountId:args[3],credential:()=>credential??=(async()=>{
  const raw=await readFile(`/proc/self/fd/${args[5]}`);if(raw.length>4096)fail();const value=JSON.parse(raw.toString("utf8"));
  exact(value,["accessKeyId","secretAccessKey"]);if(typeof value.accessKeyId!=="string"||typeof value.secretAccessKey!=="string"||!value.accessKeyId||!value.secretAccessKey)fail();return value;
 })()});
 const app=initializeApp({projectId:targets.publicationTarget(pairs[0].environment).projectId,credential:applicationDefault()});
 try{process.stdout.write(`${JSON.stringify(await seedRoutingMirrors({firestore:getFirestore(app),store,pairs,operationId:input.operationId,dryRun:!apply,signal:AbortSignal.timeout(120_000)}),null,2)}\n`);}
 finally{store.close();await deleteApp(app);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){runRoutingMirrorSeedOperator(process.argv.slice(2)).catch(()=>{process.stderr.write("Private routing mirror seed was refused\n");process.exitCode=1;});}
